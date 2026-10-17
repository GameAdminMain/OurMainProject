/**
 * db.js — PostgreSQL database layer for Sisters Bingo
 * Compatible with the current public schema in beteseb-bingo.sql.
 */

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is missing");
}

// Neon (and most hosted Postgres) needs SSL: it is on unless the database is on this machine or DB_SSL=false.
// DB_CONNECT_TIMEOUT_MS: a sleeping Neon database can need 5-20 s to wake up on the first connection.
const DB_URL = process.env.DATABASE_URL;
const DB_IS_LOCAL = /@(localhost|127\.0\.0\.1|\[::1\])[:\/]/.test(DB_URL);
const pool = new Pool({
  connectionString: DB_URL,
  ssl:
    process.env.DB_SSL === "false" || DB_IS_LOCAL
      ? false
      : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 30000),
  keepAlive: true,
});

pool.on("error", (err) => {
  // an idle connection dropped by the network / Neon: the pool discards it and opens a new one on demand
  console.error("PostgreSQL pool: idle connection lost (" + (err && err.code ? err.code : "error") + "): " + (err && err.message));
});

function normalizeEthiopianPhone(phone) {
  if (phone == null) return null;

  let digits = String(phone).replace(/\D/g, "");

  if (!digits) return null;

  if (
    /^09\d{8}$/.test(digits) ||
    /^07\d{8}$/.test(digits)
  ) {
    digits = "251" + digits.slice(1);
  } else if (/^[97]\d{8}$/.test(digits)) {
    digits = "251" + digits;
  }

  return /^251[97]\d{8}$/.test(digits)
    ? digits
    : null;
}

function last9(phone) {
  if (phone == null) return null;

  const digits = String(phone).replace(/\D/g, "");

  return digits.length >= 9
    ? digits.slice(-9)
    : null;
}

function toPositiveInteger(value, field) {
  const n = Number(value);

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${field}`);
  }

  return n;
}

function toPositiveAmount(value, field = "amount") {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${field}`);
  }

  return n;
}

function amountFromReceipt(receipt) {
  const raw = receipt?.settledAmount;

  if (raw === null || raw === undefined) {
    throw new Error("Deposit amount is missing");
  }

  const cleaned =
    String(raw).replace(/[^0-9.]/g, "");

  const amount = Number(cleaned);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error("Invalid deposit amount amount = " + amount);
  }

  return amount;
}

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    console.error(
      "Rollback error:",
      err
    );
  }
}


// ------------------------------------------------------------
// Admin money restrictions (see financial_restrictions.sql)
// The database raises  FEATURE_DISABLED:<feature>:<system|user>  when an action is blocked.
// ------------------------------------------------------------
const FINANCIAL_FEATURES = ["deposit", "withdraw", "transfer_main", "transfer_play"];

function parseFeatureDisabled(err) {
  const m = /FEATURE_DISABLED:(deposit|withdraw|transfer_main|transfer_play):(system|user)/.exec(
    String((err && err.message) || "")
  );
  return m ? { feature: m[1], scope: m[2] } : null;
}

// run inside an open transaction, after the user row is locked
async function assertFinancialAllowed(client, userId, feature) {
  await client.query("SELECT public.assert_financial_allowed($1::integer, $2::varchar)", [userId, feature]);
}

// shared paging for the money-history screens: clamps the page, returns { rows, total, page, pages }
async function historyPage(countSql, rowsSql, params, page, pageSize) {
  const size = Math.max(1, Math.min(50, Number(pageSize) || 10));
  const total = Number((await pool.query(countSql, params)).rows[0]?.n || 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const rows = total
    ? (await pool.query(rowsSql, [...params, size, (p - 1) * size])).rows
    : [];
  return { rows, total, page: p, pages, pageSize: size };
}

module.exports = {

  // read access for the data server (admin dashboard, reconciliation)
  async rawQuery(text, params) { return pool.query(text, params); },
  async saveClientError(e) {
    const cut = (v, n) => String(v == null ? "" : v).slice(0, n);
    await pool.query(
      `INSERT INTO public.client_errors (kind, message, src, line, telegram_id, screen, lang, version, ua, stack)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cut(e.kind, 12), cut(e.message, 300), cut(e.src, 120), Number(e.line) || 0, cut(e.telegramId, 20), cut(e.screen, 24), cut(e.lang, 4), cut(e.version, 20), cut(e.ua, 160), cut(e.stack, 800)]
    );
    await pool.query("DELETE FROM public.client_errors WHERE at < now() - interval '14 days' AND random() < 0.02");
  },

  FINANCIAL_FEATURES,
  parseFeatureDisabled,


async getBingoUserDashboard(userId) {
  const id = toPositiveInteger(
    userId,
    "userId"
  );

  const { rows } = await pool.query(
    `
      SELECT public.get_bingo_user_dashboard(
        $1::integer
      ) AS result
    `,
    [id]
  );

  const result = rows[0]?.result;

  if (!result) {
    throw new Error(
      "Failed to retrieve Bingo user dashboard."
    );
  }

  return result;
},

	/**
 * Get transfer limits and current usage for a user's wallet.
 *
 * @param {number} userId
 * @param {"main"|"play"} walletType
 * @returns {Promise<object>}
 */
async getTransferLimits(userId, walletType) {
    if (!userId) {
        throw new Error("User ID is required");
    }

    if (!["main", "play"].includes(walletType)) {
        throw new Error("Invalid wallet type");
    }

    const { rows } = await pool.query(
        `
        SELECT public.get_transfer_limits($1, $2) AS limits
        `,
        [
            userId,
            walletType
        ]
    );

    if (!rows.length || !rows[0].limits) {
        throw new Error("Unable to load transfer limits");
    }

    return rows[0].limits;
},

async getTransferRecipient(phone) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM find_transfer_recipient($1)
    LIMIT 1
    `,
    [phone]
  );

  return rows[0] || null;
},

async transferWallet(
  senderUserId,
  receiverPhone,
  walletType,
  amount,
  idempotencyKey,
  description = "Telegram wallet transfer"
) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `
      SELECT public.transfer_wallet(
        $1::integer,
        $2::varchar,
        $3::varchar,
        $4::numeric,
        $5::varchar,
        $6::text
      ) AS result
      `,
      [
        senderUserId,
        receiverPhone,
        walletType,
        amount,
        idempotencyKey,
        description
      ]
    ));
  } catch (err) {
    const blockedFeature = parseFeatureDisabled(err);
    if (blockedFeature) err.featureDisabled = blockedFeature;
    throw err;
  }

  return rows[0]?.result || null;
},	
	
async getActiveStakes() {
    const { rows } = await pool.query(`
        SELECT
            bs.id AS stake_id,
            bs.name AS stake_name,
            bs.amount,
            bs.is_active,
            bs.display_order,
            bs.display_name,
            bs.show_room_page,

            br.id AS room_id,
            br.name AS room_name,
            br.code AS room_code,
            br.status AS room_status,
            br.min_players,
            br.max_players,
            br.card_count,
            br.max_cards_per_player,
            br.selection_seconds,
            br.next_round_seconds,
            cr.commission_rate

        FROM bingo_stakes bs

        INNER JOIN bingo_room_stakes brs
            ON brs.stake_id = bs.id
            AND brs.status = 'active'

        INNER JOIN bingo_rooms br
            ON br.id = brs.room_id
            AND br.status = 'active'

        LEFT JOIN bingo_commission_rules cr
            ON cr.id = br.commission_rule_id

        WHERE bs.is_active = true

        ORDER BY
            bs.display_order ASC,
            bs.amount ASC,
            br.id ASC
    `);

    return rows.map(row => ({
        id: String(row.stake_id).toLowerCase(),

        dbId: row.stake_id,
        name: row.stake_name,
        displayName: row.display_name,
        amount: Number(row.amount),

        showRoomPage: row.show_room_page === true,
        isActive: row.is_active,
        displayOrder: Number(row.display_order),

        roomId: Number(row.room_id),
        roomName: row.room_name,
        roomCode: row.room_code,

        minPlayers: Number(row.min_players),

        maxPlayers:
            row.max_players === null
                ? null
                : Number(row.max_players),

        cardCount: Number(row.card_count),
        maxCardsPerPlayer: Number(row.max_cards_per_player),
        selectionSeconds: Number(row.selection_seconds),
        nextRoundSeconds: Number(row.next_round_seconds),
        // commission of the room's rule (percent); null when the rule is missing
        commissionRate: row.commission_rate === null || row.commission_rate === undefined ? null : Number(row.commission_rate)
    }));
},

  // ============================================================
  // USER LOOKUPS / REGISTRATION
  // ============================================================

  async getUserByTelegramId(telegramId) {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,      
          is_admin,
          admin_role,
          is_active,
          is_blocked,
          created_at,
          last_seen
        FROM users
        WHERE telegram_id = $1
          AND is_active = TRUE
        LIMIT 1
        `,
        [telegramId]
      );

    return rows[0] || null;
  },



  async getAdminFinancialStatistics() {
  const { rows } = await pool.query(`
    WITH deposit_stats AS (
      SELECT
        d.payment_account_id,
        COUNT(*) AS deposit_count,
        COALESCE(SUM(d.amount), 0) AS deposit_amount
      FROM deposits d
      GROUP BY d.payment_account_id
    ),

    withdrawal_stats AS (
      SELECT
        w.payment_account_id,
        COUNT(*) AS withdrawal_count,
        COALESCE(SUM(w.amount), 0) AS withdrawal_amount
      FROM withdrawals w
      WHERE w.status = 'approved'
        AND w.payment_account_id IS NOT NULL
      GROUP BY w.payment_account_id
    ),

    account_stats AS (
      SELECT
        pa.id AS payment_account_id,
        pa.account_name,
        pa.account_number,
        pa.balance,

        pm.id AS payment_method_id,
        pm.name AS payment_method_name,
        pm.amharic_name AS payment_method_amharic,
        pm.emoji AS payment_method_emoji,

        COALESCE(ds.deposit_count, 0) AS deposit_count,
        COALESCE(ds.deposit_amount, 0) AS deposit_amount,

        COALESCE(ws.withdrawal_count, 0) AS withdrawal_count,
        COALESCE(ws.withdrawal_amount, 0) AS withdrawal_amount

      FROM payment_accounts pa

      JOIN payment_methods pm
        ON pm.id = pa.payment_method_id

      LEFT JOIN deposit_stats ds
        ON ds.payment_account_id = pa.id

      LEFT JOIN withdrawal_stats ws
        ON ws.payment_account_id = pa.id

      WHERE pa.is_removed = FALSE
    )

    SELECT
      payment_account_id,
      account_name,
      account_number,
      balance,

      payment_method_id,
      payment_method_name,
      payment_method_amharic,
      payment_method_emoji,

      deposit_count,
      deposit_amount,

      withdrawal_count,
      withdrawal_amount

    FROM account_stats

    ORDER BY
      payment_method_id ASC,
      payment_account_id ASC
  `);

  const accounts = rows.map((row) => ({
    paymentAccountId:
      Number(row.payment_account_id),

    accountName:
      row.account_name || "Unnamed Account",

    accountNumber:
      row.account_number || "",

    balance:
      Number(row.balance || 0),

    paymentMethodId:
      Number(row.payment_method_id),

    paymentMethodName:
      row.payment_method_name || "Payment Method",

    paymentMethodAmharic:
      row.payment_method_amharic || "",

    paymentMethodEmoji:
      row.payment_method_emoji || "💳",

    depositCount:
      Number(row.deposit_count || 0),

    depositAmount:
      Number(row.deposit_amount || 0),

    withdrawalCount:
      Number(row.withdrawal_count || 0),

    withdrawalAmount:
      Number(row.withdrawal_amount || 0)
  }));

  const totalDepositCount =
    accounts.reduce(
      (sum, account) =>
        sum + account.depositCount,
      0
    );

  const totalDepositAmount =
    accounts.reduce(
      (sum, account) =>
        sum + account.depositAmount,
      0
    );

  const totalWithdrawalCount =
    accounts.reduce(
      (sum, account) =>
        sum + account.withdrawalCount,
      0
    );

  const totalWithdrawalAmount =
    accounts.reduce(
      (sum, account) =>
        sum + account.withdrawalAmount,
      0
    );

  return {
    accounts,

    totalDepositCount,
    totalDepositAmount,

    totalWithdrawalCount,
    totalWithdrawalAmount
  };
},

  async getUserByTelegramIdIncludingInactive(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          is_admin,
          admin_role,
          is_active,
          is_blocked,
          created_at,
          last_seen
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  async getUserByPhone(phone) {

    const normalized =
      normalizeEthiopianPhone(phone);

    const searchLast9 =
      last9(normalized || phone);

    if (!searchLast9) {
      return null;
    }

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,          
          is_active,
          is_admin,
          is_blocked,
          admin_role
        FROM users
        WHERE RIGHT(
          REGEXP_REPLACE(
            phone,
            '[^0-9]',
            '',
            'g'
          ),
          9
        ) = $1
          AND is_active = TRUE          
          AND is_blocked = FALSE
        LIMIT 1
        `,
        [searchLast9]
      );

    return rows[0] || null;
  },

  async getUserByPhoneForAdmin(phone) {

    const searchLast9 =
      last9(phone);

    if (!searchLast9) {
      return null;
    }

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          is_active,
          is_blocked,
          is_admin,
          admin_role          
        FROM users
        WHERE RIGHT(
          REGEXP_REPLACE(
            phone,
            '[^0-9]',
            '',
            'g'
          ),
          9
        ) = $1
          AND is_active = TRUE
        LIMIT 1
        `,
        [searchLast9]
      );

    return rows[0] || null;
  },

  // ============================================================
  // ADMIN > MANAGE USER: money summary and paged money history of ONE user (by users.id)
  // ============================================================

  // counts, totals, bonus received and the current wallets, in ONE query
  async getAdminUserMoneySummary(userId) {
    const { rows } = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM deposits d WHERE d.user_id = u.id AND d.status = 'completed') AS deposit_count,
        (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d WHERE d.user_id = u.id AND d.status = 'completed') AS deposit_total,
        (SELECT COUNT(*) FROM withdrawals w WHERE w.user_id = u.id AND w.status = 'approved') AS withdraw_count,
        (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w WHERE w.user_id = u.id AND w.status = 'approved') AS withdraw_total,
        (SELECT COUNT(*) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('pending', 'processing')) AS withdraw_pending,
        (SELECT COALESCE(SUM(b.awarded_amount), 0) FROM user_bonuses b
           WHERE b.user_id = u.id AND b.status IN ('active', 'completed', 'expired', 'forfeited')) AS bonus_total,
        COALESCE(wb.main_balance, 0) AS main_balance,
        COALESCE(wb.play_balance, 0) AS play_balance,
        COALESCE(wb.bonus_balance, 0) AS bonus_balance
      FROM users u
      LEFT JOIN user_wallet_balances wb ON wb.user_id = u.id
      WHERE u.id = $1
      LIMIT 1
      `,
      [userId]
    );
    if (!rows.length) return null;
    const r = rows[0], n = v => Number(v || 0);
    return {
      depositCount: n(r.deposit_count), depositTotal: n(r.deposit_total),
      withdrawCount: n(r.withdraw_count), withdrawTotal: n(r.withdraw_total), withdrawPending: n(r.withdraw_pending),
      bonusTotal: n(r.bonus_total),
      mainBalance: n(r.main_balance), playBalance: n(r.play_balance), bonusBalance: n(r.bonus_balance)
    };
  },

  // deposits: payment method, reference number, the account the money was sent TO, amount, status, date
  async getAdminUserDeposits(userId, page = 1, pageSize = 5) {
    return historyPage(
      `SELECT COUNT(*) AS n FROM deposits d WHERE d.user_id = $1`,
      `
      SELECT d.id, d.amount, d.reference, d.status,
             d.depositor_account, d.depositor_name,
             pa.account_number AS deposit_account,
             to_char(d.created_at AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS when_text,
             pm.name AS method_name
      FROM deposits d
      LEFT JOIN payment_accounts pa ON pa.id = d.payment_account_id
      LEFT JOIN payment_methods pm ON pm.id = COALESCE(pa.payment_method_id, d.deposit_method_id)
      WHERE d.user_id = $1
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2 OFFSET $3
      `,
      [userId], page, pageSize
    );
  },

  // withdrawals: payment method, the account the money was sent TO, amount, status, date
  async getAdminUserWithdrawals(userId, page = 1, pageSize = 5) {
    return historyPage(
      `SELECT COUNT(*) AS n FROM withdrawals w WHERE w.user_id = $1`,
      `
      SELECT w.id, w.amount, w.account_number, w.status,
             to_char(w.created_at AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS when_text,
             pm.name AS method_name
      FROM withdrawals w
      LEFT JOIN payment_methods pm ON pm.id = w.payment_method_id
      WHERE w.user_id = $1
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT $2 OFFSET $3
      `,
      [userId], page, pageSize
    );
  },

  // one user by users.id, same columns as getUserByPhoneForAdmin (used when an admin screen is re-opened)
  async getUserByIdForAdmin(userId) {
    const { rows } = await pool.query(
      `SELECT id, telegram_id, name, phone, is_active, is_blocked, is_admin, admin_role
       FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  },

async registerUser(telegramId, name, phone) {
  const normalizedPhone = normalizeEthiopianPhone(phone);

  if (!normalizedPhone) {
    throw new Error("Invalid Ethiopian phone number");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const telegramResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [telegramId]
    );

    if (telegramResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        status: "existing_telegram",
        user: telegramResult.rows[0]
      };
    }

    const phoneResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE RIGHT(
        REGEXP_REPLACE(
          phone,
          '[^0-9]',
          '',
          'g'
        ),
        9
      ) = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedPhone.slice(-9)]
    );

    if (phoneResult.rows.length) {
      const existingUser = phoneResult.rows[0];

      // If the existing account is blocked/banned
      if (existingUser.is_blocked) {
        await client.query("ROLLBACK");

        return {
          status: "banned",
          user: existingUser
        };
      }

      const updated = await client.query(
        `
        UPDATE users
        SET
          telegram_id = $1,
          name = $2,
          phone = $3,
          is_active = TRUE,
          last_seen = NOW()
        WHERE id = $4
        RETURNING *
        `,
        [
          telegramId,
          name,
          normalizedPhone,
          existingUser.id
        ]
      );

      await client.query("COMMIT");

      return {
        status: "reconnected",
        user: updated.rows[0]
      };
    }

    const inserted = await client.query(
      `
      INSERT INTO users (
        telegram_id,
        name,
        phone,
        is_active,
        is_admin,
        is_blocked,
        last_seen
      )
      VALUES (
        $1,
        $2,
        $3,
        TRUE,
        FALSE,
        FALSE,
        NOW()
      )
      RETURNING *
      `,
      [
        telegramId,
        name,
        normalizedPhone
      ]
    );

    await client.query("COMMIT");

    return {
      status: "new",
      user: inserted.rows[0]
    };

  } catch (err) {
    await safeRollback(client);

    if (err.code === "23505") {
      return {
        status: "already_exists",
        user: null
      };
    }

    throw err;

  } finally {
    client.release();
  }
},


  async reconnectUserByPhone(
    telegramId,
    name,
    phone
  ) {

    const searchLast9 =
      last9(phone);

    if (!searchLast9) {
      return {
        status: "not_found"
      };
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const { rows } =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE RIGHT(
            REGEXP_REPLACE(
              phone,
              '[^0-9]',
              '',
              'g'
            ),
            9
          ) = $1
          LIMIT 1
          FOR UPDATE
          `,
          [searchLast9]
        );

      if (!rows.length) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "not_found"
        };
      }

      const user =
        rows[0];

      if (
        String(user.telegram_id) ===
        String(telegramId)
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "same_account",
          user
        };
      }

      /*
       * SECURITY:
       * Do not allow an active account to be
       * taken over simply by knowing its phone.
       */
      if (user.is_active) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "account_active",
          user
        };
      }

      const existingTelegram =
        await client.query(
          `
          SELECT id
          FROM users
          WHERE telegram_id = $1
          LIMIT 1
          `,
          [telegramId]
        );

      if (
        existingTelegram.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status:
            "telegram_already_used"
        };
      }

      const updated =
        await client.query(
          `
          UPDATE users
          SET
            telegram_id = $1,
            name = $2,
            is_active = TRUE,
            last_seen = NOW()
          WHERE id = $3
          RETURNING *
          `,
          [
            telegramId,
            name,
            user.id
          ]
        );

      await client.query(
        "COMMIT"
      );

      return {
        status: "reconnected",
        user: updated.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

      throw err;

    } finally {

      client.release();

    }
  },

  async reactivateUserByTelegramId(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET
          is_active = TRUE,
          last_seen = NOW()
        WHERE telegram_id = $1          
        RETURNING *
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  async deactivateUser(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET is_active = FALSE
        WHERE telegram_id = $1
          AND is_admin = FALSE
        RETURNING *
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // ADMIN / USER MANAGEMENT
  // ============================================================

  async getAdminByTelegramId(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          is_admin,
          admin_role,
          is_active,
          is_blocked
        FROM users
        WHERE telegram_id = $1
          AND is_admin = TRUE
          AND is_active = TRUE
          AND is_blocked = FALSE
        LIMIT 1
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  async isAdmin(
    telegramId
  ) {

    const admin =
      await this.getAdminByTelegramId(
        telegramId
      );

    return !!admin;
  },

  async getAllAdmins() {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          is_admin,
          admin_role,
          is_active,
          is_blocked
        FROM users
        WHERE is_admin = TRUE
          AND is_active = TRUE          
          AND is_blocked = FALSE
        ORDER BY id
        `
      );

    return rows;
  },

  async setUserAdminRole(
    userId,
    role
  ) {

    const validRoles = [
      "main",
      "statistics",
      "withdrawal",
      "broadcast"
    ];

    if (
      !validRoles.includes(role)
    ) {
      throw new Error(
        "Invalid admin role"
      );
    }

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET
          is_admin = TRUE,
          admin_role = $1
        WHERE id = $2
          AND is_active = TRUE
          AND is_blocked = FALSE
        RETURNING
          id,
          telegram_id,
          name,
          phone,
          is_admin,
          admin_role,
          is_active,
          is_blocked
        `,
        [
          role,
          userId
        ]
      );

    return rows[0] || null;
  },

  async removeUserAdminRole(
    userId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET
          is_admin = FALSE,
          admin_role = NULL
        WHERE id = $1
        RETURNING
          id,
          telegram_id,
          name,
          phone,
          is_admin,
          admin_role,
          is_active,
          is_blocked
        `,
        [userId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // GAME BONUS (game_bonus.sql): "play N games in a window, get a % of the cash stakes as Bonus"
  // ============================================================

  // evaluate one finished game; returns {awards:[...], errors:[...]} or {skipped:'...'}
  async processGameBonuses(gameId) {
    const { rows } = await pool.query(
      "SELECT public.process_game_bonuses($1::bigint) AS result",
      [gameId]
    );
    return rows[0]?.result || null;
  },

  // catch-up for finished games that were missed (idempotent)
  async processPendingGameBonuses(limit = 50) {
    const { rows } = await pool.query(
      "SELECT public.process_pending_game_bonuses($1::integer) AS result",
      [limit]
    );
    return rows[0]?.result || null;
  },

  // progress of one player (users.id) in every running game-bonus campaign
  async getGameBonusProgress(userId) {
    const { rows } = await pool.query(
      "SELECT public.get_game_bonus_progress($1::integer) AS progress",
      [userId]
    );
    return rows[0]?.progress || [];
  },

  // ============================================================
  // MONEY RESTRICTIONS (main admin only; checked again inside the database)
  // ============================================================

  // userId = users.id, or null for the system-wide switches only
  async getFinancialStatus(userId = null) {
    const { rows } = await pool.query(
      "SELECT public.get_financial_status($1::integer) AS status",
      [userId]
    );
    return rows[0]?.status || null;
  },

  // feature: deposit | withdraw | transfer_main | transfer_play | transfer (both) | all
  async setUserFinancialRestriction(adminUserId, targetUserId, feature, blocked, reason = null) {
    const { rows } = await pool.query(
      "SELECT public.set_user_financial_restriction($1::integer,$2::integer,$3::varchar,$4::boolean,$5::text) AS result",
      [adminUserId, targetUserId, feature, Boolean(blocked), reason]
    );
    return rows[0]?.result || null;
  },

  async setSystemFinancialFlag(adminUserId, feature, enabled, reason = null) {
    const { rows } = await pool.query(
      "SELECT public.set_system_financial_flag($1::integer,$2::varchar,$3::boolean,$4::text) AS result",
      [adminUserId, feature, Boolean(enabled), reason]
    );
    return rows[0]?.result || null;
  },

  // ---------- player language (user_language.sql) ----------
  // returns 'am' | 'en' | null (not chosen, or the column is not installed yet)
  async getUserLanguage(telegramId) {
    try {
      const { rows } = await pool.query("SELECT language FROM users WHERE telegram_id = $1", [telegramId]);
      const l = rows[0]?.language;
      return l === "en" ? "en" : "am";   // Amharic is the default
    } catch (_) {
      return "am";
    }
  },

  async setUserLanguage(telegramId, lang) {
    if (lang !== "am" && lang !== "en") return false;
    const { rowCount } = await pool.query("UPDATE users SET language = $2 WHERE telegram_id = $1", [telegramId, lang]);
    return rowCount > 0;
  },

  // ---------- admin: top depositors / withdrawers ----------
  // days = null -> all time. Deposits: status 'completed'. Withdrawals: status 'approved'.
  async getTopDepositors(days = null, limit = 10) {
    const d = days ? Math.max(1, Math.min(3650, Number(days) || 0)) || null : null;
    const { rows } = await pool.query(
      `
      SELECT u.id, u.name, u.phone, u.telegram_id,
             SUM(x.amount)::numeric(18,2) AS total,
             COUNT(*)::int AS n,
             to_char(MAX(x.created_at) AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon YYYY HH24:MI') AS last_at
      FROM deposits x
      JOIN users u ON u.id = x.user_id
      WHERE x.status = 'completed'
        AND ($1::int IS NULL OR x.created_at >= now() - ($1::int * interval '1 day'))
      GROUP BY u.id, u.name, u.phone, u.telegram_id
      ORDER BY SUM(x.amount) DESC, MAX(x.created_at) DESC
      LIMIT $2
      `,
      [d, Math.max(1, Math.min(25, Number(limit) || 10))]
    );
    return rows;
  },

  async getTopWithdrawers(days = null, limit = 10) {
    const d = days ? Math.max(1, Math.min(3650, Number(days) || 0)) || null : null;
    const { rows } = await pool.query(
      `
      SELECT u.id, u.name, u.phone, u.telegram_id,
             SUM(x.amount)::numeric(18,2) AS total,
             COUNT(*)::int AS n,
             to_char(MAX(COALESCE(x.processed_at AT TIME ZONE 'UTC', x.updated_at)) AT TIME ZONE 'Africa/Addis_Ababa',
                     'DD Mon YYYY HH24:MI') AS last_at
      FROM withdrawals x
      JOIN users u ON u.id = x.user_id
      WHERE x.status = 'approved'
        AND ($1::int IS NULL OR COALESCE(x.processed_at AT TIME ZONE 'UTC', x.updated_at) >= now() - ($1::int * interval '1 day'))
      GROUP BY u.id, u.name, u.phone, u.telegram_id
      ORDER BY SUM(x.amount) DESC, MAX(COALESCE(x.processed_at AT TIME ZONE 'UTC', x.updated_at)) DESC
      LIMIT $2
      `,
      [d, Math.max(1, Math.min(25, Number(limit) || 10))]
    );
    return rows;
  },

  // ---------- admin bonus management (bonus_admin.sql) ----------
  async bonusAdminCall(sql, params) {
    try {
      const { rows } = await pool.query(sql, params);
      return rows[0]?.result ?? null;
    } catch (err) {
      const m = /(INVALID: [^\n]*|HAS_AWARDS:\d+|CAMPAIGN_NOT_FOUND|Only the main admin[^\n]*)/.exec(String(err.message || ""));
      if (m) {
        const e = new Error(m[1]);
        e.bonusAdmin = m[1];
        throw e;
      }
      if (/function public\.admin_\w+.* does not exist|bonus_admin_sessions/.test(String(err.message || ""))) {
        const e = new Error("bonus_admin.sql is not installed");
        e.bonusAdmin = "NOT_INSTALLED";
        throw e;
      }
      throw err;
    }
  },

  adminListBonusCampaigns(adminUserId, filter = "all", page = 0, pageSize = 6) {
    return this.bonusAdminCall(
      "SELECT public.admin_list_bonus_campaigns($1::integer,$2::text,$3::integer,$4::integer) AS result",
      [adminUserId, filter, page, pageSize]
    );
  },
  adminGetBonusCampaign(adminUserId, id) {
    return this.bonusAdminCall("SELECT public.admin_get_bonus_campaign($1::integer,$2::bigint) AS result", [adminUserId, id]);
  },
  adminCreateBonusCampaign(adminUserId, data) {
    return this.bonusAdminCall("SELECT public.admin_create_bonus_campaign($1::integer,$2::jsonb) AS result", [adminUserId, JSON.stringify(data)]);
  },
  adminUpdateBonusCampaign(adminUserId, id, patch) {
    return this.bonusAdminCall("SELECT public.admin_update_bonus_campaign($1::integer,$2::bigint,$3::jsonb) AS result", [adminUserId, id, JSON.stringify(patch)]);
  },
  adminSetBonusCampaignActive(adminUserId, id, active) {
    return this.bonusAdminCall("SELECT public.admin_set_bonus_campaign_active($1::integer,$2::bigint,$3::boolean) AS result", [adminUserId, id, Boolean(active)]);
  },
  adminDeleteBonusCampaign(adminUserId, id) {
    return this.bonusAdminCall("SELECT public.admin_delete_bonus_campaign($1::integer,$2::bigint) AS result", [adminUserId, id]);
  },
  adminDuplicateBonusCampaign(adminUserId, id) {
    return this.bonusAdminCall("SELECT public.admin_duplicate_bonus_campaign($1::integer,$2::bigint) AS result", [adminUserId, id]);
  },
  adminBonusCampaignLog(adminUserId, id, limit = 8) {
    return this.bonusAdminCall("SELECT public.admin_bonus_campaign_log($1::integer,$2::bigint,$3::integer) AS result", [adminUserId, id, limit]);
  },

  // wizard / edit conversation state (survives serverless cold starts)
  async getBonusAdminSession(telegramId) {
    try {
      const { rows } = await pool.query(
        `SELECT s.admin_user_id, s.flow, s.step, s.data
         FROM public.bonus_admin_sessions s
         JOIN public.users u ON u.id = s.admin_user_id
         WHERE u.telegram_id = $1 AND s.expires_at > now()`,
        [telegramId]
      );
      return rows[0] || null;
    } catch (_) {
      return null; // table missing (bonus_admin.sql not installed) – behave as "no session"
    }
  },
  async setBonusAdminSession(adminUserId, flow, step, data = {}, ttlMinutes = 15) {
    await pool.query(
      `INSERT INTO public.bonus_admin_sessions (admin_user_id, flow, step, data, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' minutes')::interval)
       ON CONFLICT (admin_user_id) DO UPDATE
       SET flow = EXCLUDED.flow, step = EXCLUDED.step, data = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [adminUserId, flow, step, JSON.stringify(data), String(ttlMinutes)]
    );
  },
  async clearBonusAdminSession(adminUserId) {
    await pool.query("DELETE FROM public.bonus_admin_sessions WHERE admin_user_id = $1", [adminUserId]).catch(() => {});
  },

  async setUserBlocked(
    userId,
    isBlocked
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET is_blocked = $1
        WHERE id = $2
          AND is_admin = FALSE
        RETURNING
          id,
          telegram_id,
          name,
          phone,
          is_blocked,
          is_active,
          is_admin
        `,
        [
          Boolean(isBlocked),
          userId
        ]
      );

    return rows[0] || null;
  },

  // ============================================================
  // USER STATISTICS
  // ============================================================

  async getUserStatistics(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT

          (
            SELECT COUNT(*)
            FROM deposits d
            WHERE d.user_id = u.id
          ) AS total_deposits,

          (
            SELECT COUNT(*)
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status IN ('pending', 'processing')
          ) AS pending_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'approved'
          ) AS approved_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'rejected'              
          ) AS rejected_withdrawals

        FROM users u

        WHERE u.telegram_id = $1
          AND u.is_active = TRUE

        LIMIT 1
        `,
        [telegramId]
      );

    if (!rows.length) {
      return null;
    }

    const r = rows[0];

    return {
      totalDeposits:
        Number(r.total_deposits || 0),

      pendingWithdrawals:
        Number(
          r.pending_withdrawals || 0
        ),

      approvedWithdrawals:
        Number(
          r.approved_withdrawals || 0
        ),

      rejectedWithdrawals:
        Number(
          r.rejected_withdrawals || 0
        )
    };
  },

  // ============================================================
  // MONEY HISTORY for the user's Statistics screens (10 rows per page)
  // ============================================================

  // deposits: payment method, reference number, amount, status, date (Ethiopia time)
  async getUserDepositHistory(telegramId, page = 1, pageSize = 10) {
    return historyPage(
      `SELECT COUNT(*) AS n FROM deposits d JOIN users u ON u.id = d.user_id WHERE u.telegram_id = $1`,
      `
      SELECT d.id, d.amount, d.reference, d.status,
             to_char(d.created_at AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS when_text,
             pm.amharic_name AS method_name, pm.name AS method_name_en, pm.emoji AS method_emoji
      FROM deposits d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN payment_accounts pa ON pa.id = d.payment_account_id
      LEFT JOIN payment_methods pm ON pm.id = COALESCE(pa.payment_method_id, d.deposit_method_id)
      WHERE u.telegram_id = $1
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2 OFFSET $3
      `,
      [telegramId], page, pageSize
    );
  },

  // withdrawals: payment method, account number, amount, status, date
  async getUserWithdrawalHistory(telegramId, page = 1, pageSize = 10) {
    return historyPage(
      `SELECT COUNT(*) AS n FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE u.telegram_id = $1`,
      `
      SELECT w.id, w.amount, w.account_number, w.status, w.rejection_reason,
             to_char(w.created_at AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS when_text,
             pm.amharic_name AS method_name, pm.name AS method_name_en, pm.emoji AS method_emoji
      FROM withdrawals w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN payment_methods pm ON pm.id = w.payment_method_id
      WHERE u.telegram_id = $1
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT $2 OFFSET $3
      `,
      [telegramId], page, pageSize
    );
  },

  // transfers the user sent or received: the other person's name and phone, amount, wallet, date
  async getUserTransferHistory(telegramId, page = 1, pageSize = 10) {
    return historyPage(
      `SELECT COUNT(*) AS n FROM transfers t JOIN users u ON u.id IN (t.sender_user_id, t.receiver_user_id)
       WHERE u.telegram_id = $1`,
      `
      SELECT t.id, t.amount, t.wallet_type, t.status,
             (t.sender_user_id = u.id) AS sent,
             to_char(t.created_at AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS when_text,
             o.name AS other_name, o.phone AS other_phone
      FROM transfers t
      JOIN users u ON u.id IN (t.sender_user_id, t.receiver_user_id)
      JOIN users o ON o.id = CASE WHEN t.sender_user_id = u.id THEN t.receiver_user_id ELSE t.sender_user_id END
      WHERE u.telegram_id = $1
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $2 OFFSET $3
      `,
      [telegramId], page, pageSize
    );
  },

  // bonuses received: campaign, amount, what is left, wagering progress, expiry, status
  async getUserBonusHistory(telegramId, page = 1, pageSize = 10) {
    return historyPage(
      `SELECT COUNT(*) AS n FROM user_bonuses b JOIN users u ON u.id = b.user_id WHERE u.telegram_id = $1`,
      `
      SELECT b.id, b.status, b.awarded_amount, b.remaining_amount,
             b.wagering_requirement, b.wagering_progress, b.converted_amount,
             to_char(COALESCE(b.awarded_at, b.created_at) AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS when_text,
             to_char(b.expires_at AT TIME ZONE 'Africa/Addis_Ababa', 'DD Mon HH24:MI') AS expires_text,
             c.name AS campaign_name
      FROM user_bonuses b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN bonus_campaigns c ON c.id = b.campaign_id
      WHERE u.telegram_id = $1
      ORDER BY COALESCE(b.awarded_at, b.created_at) DESC, b.id DESC
      LIMIT $2 OFFSET $3
      `,
      [telegramId], page, pageSize
    );
  },

  async getUserFinancialStatistics(
    userId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT

          (
            SELECT COALESCE(
              SUM(d.amount),
              0
            )
            FROM deposits d
            WHERE d.user_id = u.id
          ) AS total_deposit_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'approved'
          ) AS approved_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status IN ('pending', 'processing')
          ) AS pending_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'rejected'
          ) AS rejected_withdrawal_amount

        FROM users u
        WHERE u.id = $1
        LIMIT 1
        `,
        [userId]
      );

    if (!rows.length) {
      return null;
    }

    const r = rows[0];

    return {
      totalDepositAmount:
        Number(
          r.total_deposit_amount || 0
        ),

      approvedWithdrawalAmount:
        Number(
          r.approved_withdrawal_amount || 0
        ),

      pendingWithdrawalAmount:
        Number(
          r.pending_withdrawal_amount || 0
        ),

      rejectedWithdrawalAmount:
        Number(
          r.rejected_withdrawal_amount || 0
        )
    };
  },

 
  async getAdminStatistics() {

    const { rows } =
      await pool.query(
        `
        SELECT

          (
            SELECT COUNT(*)
            FROM withdrawals
            WHERE status IN ('pending', 'processing')            
          ) AS pending_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals
            WHERE status = 'approved'
          ) AS approved_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals
            WHERE status = 'rejected'
          ) AS rejected_withdrawals,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_active = TRUE              
          ) AS active_users,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_active = FALSE
          ) AS inactive_users,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_blocked = TRUE
          ) AS blocked_users,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'main'
          ) AS main_admin,                
                    
          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'statistics'
          ) AS statistics_admin,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'withdrawal'
          ) AS withdrawal_admin,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'broadcast'
          ) AS broadcast_admin
        `
      );

    const r = rows[0];

    return {
      pendingWithdrawals:
        Number(
          r.pending_withdrawals || 0
        ),

      approvedWithdrawals:
        Number(
          r.approved_withdrawals || 0
        ),

      rejectedWithdrawals:
        Number(
          r.rejected_withdrawals || 0
        ),
      
      activeUsers:
        Number(
          r.active_users || 0
        ),

      inactiveUsers:
        Number(
          r.inactive_users || 0
        ),

      blockedUsers:
        Number(
          r.blocked_users || 0
        ),

      mainAdmin:
        Number(
          r.main_admin || 0
        ),

        statisticsAdmin:
        Number(
          r.statistics_admin || 0
        ),
      
        withdrawalAdmin:
        Number(
          r.withdrawal_admin || 0
        ),

        broadcastAdmin:
        Number(
          r.broadcast_admin || 0
        )
      
    };
  },

  // ============================================================
  // WITHDRAWALS
  // ============================================================

async createWithdrawal(
  telegramId,
  paymentMethodId,
  accountNumber,
  amount,
  accountName = null
) {
  const methodId = toPositiveInteger(
    paymentMethodId,
    "paymentMethodId"
  );

  const withdrawalAmount =
    toPositiveAmount(amount);

  if (withdrawalAmount < 10) {
    return {
      success: false,
      message: "Withdrawal amount must be at least 10 ETB."
    };
  }

  const cleanAccount =
    String(accountNumber ?? "")
      .trim()
      .replace(/[\s\-()]/g, "");

  if (!/^\d{1,50}$/.test(cleanAccount)) {
    return {
      success: false,
      message: "Invalid account number."
    };
  }

  // Name of the owner of the account / phone number (shown to the admin who pays it)
  const cleanAccountName =
    accountName == null
      ? null
      : String(accountName).trim().replace(/\s+/g, " ").slice(0, 100);

  if (accountName != null && cleanAccountName.length < 2) {
    return {
      success: false,
      message: "Invalid account name."
    };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * ============================================================
     * 1. Lock and verify the user
     * ============================================================
     *
     * The user row is locked for the entire transaction.
     *
     * We do NOT use users.balance for financial authorization.
     * The wallet reservation function is responsible for checking
     * and reserving the actual available balance.
     */
    const userResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name
      FROM users
      WHERE telegram_id = $1
        AND is_active = TRUE
        AND is_blocked = FALSE
      FOR UPDATE
      `,
      [telegramId]
    );

    if (userResult.rowCount !== 1) {
      throw new Error(
        "Account not found or blocked."
      );
    }

    const user = userResult.rows[0];

    // admin restriction (this user, or withdrawals paused for everyone)
    await assertFinancialAllowed(client, user.id, "withdraw");

    // withdrawal safety (safety_dashboard.sql): daily limits, cooldown after a deposit; large / suspicious requests are flagged for a main admin
    const riskResult = await client.query(
      "SELECT blocked, code, detail, needs_review, flags FROM public.check_withdrawal_risk($1::integer, $2::numeric)",
      [user.id, withdrawalAmount]
    );
    const risk = riskResult.rows[0] || { blocked: false, needs_review: false, flags: [] };
    if (risk.blocked) {
      throw new Error(`WITHDRAW_BLOCKED:${risk.code}:${risk.detail || ""}`);
    }

    /*
     * ============================================================
     * 2. Verify payment method
     * ============================================================
     */
    const methodResult = await client.query(
      `
      SELECT
        id,
        name,
        amharic_name,
        emoji
      FROM payment_methods
      WHERE id = $1
        AND is_active = TRUE
      `,
      [methodId]
    );

    if (methodResult.rowCount !== 1) {
      throw new Error(
        "Payment method not found or inactive."
      );
    }

    const paymentMethod =
      methodResult.rows[0];

    /*
     * ============================================================
     * 3. Create withdrawal request
     * ============================================================
     *
     * The withdrawal starts as pending.
     *
     * The user's money is NOT considered successfully reserved
     * until reserve_withdrawal_from_main() succeeds below.
     *
     * Everything is inside one DB transaction, so if the wallet
     * reservation fails, this INSERT is rolled back as well.
     */
    const withdrawalResult =
      await client.query(
        `
        INSERT INTO withdrawals (
          user_id,
          payment_method_id,
          payment_account_id,
          approved_by_id,
          rejected_by_id,
          account_number,
          account_name,
          amount,
          status,
          rejection_reason,
          claimed_by_id,
          claimed_at,
          processed_at,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          NULL,
          NULL,
          NULL,
          $3,
          $5,
          $4,
          'pending',
          NULL,
          NULL,
          NULL,
          NULL,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          user.id,
          paymentMethod.id,
          cleanAccount,
          withdrawalAmount,
          cleanAccountName
        ]
      );

    if (withdrawalResult.rowCount !== 1) {
      throw new Error(
        "Could not create withdrawal request."
      );
    }

    const withdrawal =
      withdrawalResult.rows[0];

    if (risk.needs_review) {
      await client.query(
        "UPDATE withdrawals SET needs_review = TRUE, risk_flags = $2::text[] WHERE id = $1",
        [withdrawal.id, risk.flags || []]
      );
      withdrawal.needs_review = true;
      withdrawal.risk_flags = risk.flags || [];
    }

    /*
     * ============================================================
     * 4. Reserve money from the user's main wallet
     * ============================================================
     *
     * IMPORTANT:
     *
     * reserve_withdrawal_from_main() should atomically:
     *
     *   - lock the appropriate wallet/balance row
     *   - verify sufficient available funds
     *   - deduct/reserve the withdrawal amount
     *   - create the financial transaction
     *   - return the financial transaction ID
     *
     * It must raise an exception if the reservation cannot be made.
     */
    const reservationResult =
      await client.query(
        `
        SELECT reserve_withdrawal_from_main(
          $1,
          $2,
          $3,
          $4,
          $5
        ) AS transaction_id
        `,
        [
          user.id,
          withdrawalAmount,
          withdrawal.id,
          `withdrawal:reserve:${withdrawal.id}`,
          `Withdrawal request #${withdrawal.id}`
        ]
      );

    const transactionId =
      reservationResult.rows[0]?.transaction_id;

    if (!transactionId) {
      throw new Error(
        "Withdrawal reservation transaction was not created."
      );
    }

    /*
     * ============================================================
     * 5. Verify the ledger transaction
     * ============================================================
     *
     * This is defensive validation.
     *
     * We expect the reservation function to create:
     *
     *   type   = withdrawal
     *   status = completed
     *
     * If that isn't true, the entire transaction is rolled back.
     */
    const financialTransactionResult =
      await client.query(
        `
        SELECT
          id,
          type,
          status
        FROM financial_transactions
        WHERE id = $1
        FOR UPDATE
        `,
        [transactionId]
      );

    if (financialTransactionResult.rowCount !== 1) {
      throw new Error(
        "Withdrawal reservation transaction not found."
      );
    }

    const financialTransaction =
      financialTransactionResult.rows[0];

    if (
      financialTransaction.type !==
      "withdrawal"
    ) {
      throw new Error(
        "Withdrawal reservation has an invalid transaction type."
      );
    }

    if (
      financialTransaction.status !==
      "completed"
    ) {
      throw new Error(
        "Withdrawal reservation transaction is not completed."
      );
    }

    /*
     * ============================================================
     * 6. Connect withdrawal to ledger transaction
     * ============================================================
     */
    const linkResult =
      await client.query(
        `
        UPDATE withdrawals
        SET
          transaction_id = $1,
          updated_at = NOW()
        WHERE id = $2
          AND transaction_id IS NULL
        RETURNING *
        `,
        [
          transactionId,
          withdrawal.id
        ]
      );

    if (linkResult.rowCount !== 1) {
      throw new Error(
        "Could not link withdrawal to financial transaction."
      );
    }

    const finalWithdrawal =
      linkResult.rows[0];

    /*
     * ============================================================
     * 7. Read current wallet balances
     * ============================================================
     *
     * This is only for returning the balances to the caller.
     *
     * Financial authorization/reservation has already happened
     * inside reserve_withdrawal_from_main().
     */
    const balanceResult =
      await client.query(
        `
        SELECT
          main_balance,
          play_balance,
          total_balance
        FROM user_wallet_balances
        WHERE user_id = $1
        `,
        [user.id]
      );

    if (balanceResult.rowCount !== 1) {
      throw new Error(
        "User wallet balance record not found."
      );
    }

    const balances =
      balanceResult.rows[0];

    /*
     * ============================================================
     * 8. Commit
     * ============================================================
     *
     * At this point:
     *
     *   withdrawal       = pending
     *   user's funds     = reserved/deducted
     *   ledger entry     = completed
     *   transaction link = established
     *
     * If COMMIT fails, nothing should be considered successful.
     */
    await client.query("COMMIT");

    /*
     * ============================================================
     * 9. Return result
     * ============================================================
     */
    return {
      success: true,

      withdrawal: {
        ...finalWithdrawal,
        transaction_id: transactionId
      },

      withdrawal_id:
        finalWithdrawal.id,

      user_id:
        user.id,

      telegram_id:
        user.telegram_id,

      user_name:
        user.name,

      amount:
        withdrawalAmount,

      payment_method_id:
        paymentMethod.id,

      payment_method_name:
        paymentMethod.name,

      payment_method_amharic_name:
        paymentMethod.amharic_name,

      payment_method_emoji:
        paymentMethod.emoji,

      account_number:
        cleanAccount,

      account_name:
        cleanAccountName,

      transaction_id:
        transactionId,

      main_balance:
        Number(balances.main_balance),

      play_balance:
        Number(balances.play_balance),

      total_balance:
        Number(balances.total_balance)
    };

  } catch (err) {
    /*
     * Any error anywhere above rolls back:
     *
     *   - withdrawal INSERT
     *   - wallet reservation
     *   - financial transaction
     *   - withdrawal/transaction link
     */
    await safeRollback(client);

    const blockedFeature = parseFeatureDisabled(err);
    const safety = /^WITHDRAW_BLOCKED:([A-Z_]+):(.*)$/.exec(String((err && err.message) || ""));
    if (safety) {
      return {
        success: false,
        code: "WITHDRAW_BLOCKED",
        reason: safety[1],
        detail: safety[2],
        message: "Withdrawal is not possible right now (" + safety[1] + ")."
      };
    }
    if (!blockedFeature) console.error(
      "createWithdrawal error:",
      err
    );

    if (blockedFeature) {
      return {
        success: false,
        code: "FEATURE_DISABLED",
        feature: blockedFeature.feature,
        scope: blockedFeature.scope,
        message:
          blockedFeature.scope === "system"
            ? "የወጪ አገልግሎት ለጊዜው ተዘግቷል። እባክዎ ቆይተው ይሞክሩ።"
            : "የወጪ አገልግሎት ለእርስዎ አካውንት ተገድቧል። እባክዎ ድጋፍን ያነጋግሩ።"
      };
    }
    return {
      success: false,
      message:
        err?.message ||
        "Could not create withdrawal request."
    };

  } finally {
    client.release();
  }
},

  async claimPendingWithdrawals(
  adminTelegramId,
  paymentMethodId = null,
  limit = 10
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 10, 1),
    50
  );

  const methodId = paymentMethodId
    ? toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      )
    : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Verify admin.
     */
    const adminResult = await client.query(
      `
      SELECT id, name, telegram_id, admin_role
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_blocked = FALSE
      LIMIT 1
      `,
      [adminTelegramId]
    );

    if (!adminResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Admin account not found."
      };
    }

    const admin = adminResult.rows[0];

    /*
     * 5-minute lease.
     *
     * Expired processing requests become claimable again.
     */
    const result = await client.query(
      `
              WITH candidates AS (
            SELECT
                w.id
            FROM withdrawals w
            WHERE
                (
                    w.status = 'pending'
                    OR (
                        w.status = 'processing'
                        AND w.claimed_at IS NOT NULL
                        AND w.claimed_at < NOW() - INTERVAL '5 minutes'
                    )
                )
                AND (
                    $1::bigint IS NULL
                    OR w.payment_method_id = $1
                )
                AND (w.needs_review = FALSE OR $4::boolean)   -- flagged requests (large / suspicious) go to a MAIN admin only
            ORDER BY
                w.created_at ASC,
                w.id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        ),
        claimed AS (
            UPDATE withdrawals w
            SET
                status = 'processing',
                claimed_by_id = $3,
                claimed_at = NOW(),
                updated_at = NOW()
            FROM candidates c
            WHERE w.id = c.id
            RETURNING w.*
        )
        SELECT
            c.*,
            u.name
        FROM claimed c
        JOIN users u
            ON u.id = c.user_id
        ORDER BY
            c.created_at ASC,
            c.id ASC
      `,
      [
        methodId,
        safeLimit,
        admin.id,
        admin.admin_role === "main"
      ]
    );

    await client.query("COMMIT");

    return {
      success: true,
      admin_id: admin.id,
      withdrawals: result.rows,
      count: result.rows.length
    };

  } catch (err) {
    await safeRollback(client);

    console.error(
      "claimPendingWithdrawals error:",
      err
    );

    return {
      success: false,
      message: "Could not claim withdrawals."
    };

  } finally {
    client.release();
  }
},
  
async getPendingWithdrawals(
  limit = 10,
  paymentMethodId = null
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 10, 1),
    100
  );

  const methodId = paymentMethodId
    ? toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      )
    : null;

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.payment_method_id,
      w.payment_account_id,

      w.account_number,
      w.account_name,
      w.amount,
      w.status,
      w.rejection_reason,

      w.created_at,
      w.updated_at,

      u.telegram_id,
      u.name,
      u.phone,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji

    FROM withdrawals w

    JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    WHERE w.status IN ('pending', 'processing')

      AND (
        $1::bigint IS NULL
        OR w.payment_method_id = $1
      )

    ORDER BY
      w.created_at ASC,
      w.id ASC

    LIMIT $2
    `,
    [
      methodId,
      safeLimit
    ]
  );

  return rows;
},
  async renewWithdrawalClaim(
  withdrawalId,
  adminTelegramId
) {
  const result = await pool.query(
    `
    UPDATE withdrawals w
    SET
      claimed_at = NOW(),
      updated_at = NOW()
    FROM users admin
    WHERE w.id = $1
      AND admin.telegram_id = $2
      AND admin.is_admin = TRUE
      AND admin.is_active = TRUE
      AND w.status = 'processing'
      AND w.claimed_by_id = admin.id
    RETURNING w.*
    `,
    [
      withdrawalId,
      adminTelegramId
    ]
  );

  if (!result.rows.length) {
    return {
      success: false,
      message:
        "Withdrawal is not owned by this admin or no longer processing."
    };
  }

  return {
    success: true,
    withdrawal: result.rows[0]
  };
},
async getWithdrawalHistory(
  telegramId,
  limit = 20,
  offset = 0
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 20, 1),
    100
  );

  const safeOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.amount,
      w.account_number,
      w.account_name,

      w.status,
      w.rejection_reason,

      w.payment_method_id,
      w.payment_account_id,

      w.approved_by_id,
      w.rejected_by_id,

      w.created_at,
      w.updated_at,
      w.processed_at,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji,

      pa.account_number AS payment_account_number,
      pa.account_name AS payment_account_name,

      approved_admin.name AS approved_by_name,
      rejected_admin.name AS rejected_by_name

    FROM withdrawals w

    JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    LEFT JOIN payment_accounts pa
      ON pa.id = w.payment_account_id

    LEFT JOIN users approved_admin
      ON approved_admin.id = w.approved_by_id

    LEFT JOIN users rejected_admin
      ON rejected_admin.id = w.rejected_by_id

    WHERE u.telegram_id = $1

    ORDER BY
      w.created_at DESC,
      w.id DESC

    LIMIT $2
    OFFSET $3
    `,
    [
      telegramId,
      safeLimit,
      safeOffset
    ]
  );

  return rows;
},

  async getAdminWithdrawalHistory(
  adminTelegramId,
  limit = 50,
  offset = 0
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 50, 1),
    100
  );

  const safeOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.account_number,
      w.account_name,
      w.amount,
      w.status,
      w.rejection_reason,

      w.payment_method_id,
      w.payment_account_id,

      w.approved_by_id,
      w.rejected_by_id,

      w.created_at,
      w.processed_at,
      w.updated_at,

      u.telegram_id AS user_telegram_id,
      u.name AS user_name,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji,

      pa.account_number AS payment_account_number,

      approved_admin.name AS approved_by_name,
      rejected_admin.name AS rejected_by_name

    FROM withdrawals w

    JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    LEFT JOIN payment_accounts pa
      ON pa.id = w.payment_account_id

    LEFT JOIN users approved_admin
      ON approved_admin.id = w.approved_by_id

    LEFT JOIN users rejected_admin
      ON rejected_admin.id = w.rejected_by_id

    JOIN users requesting_admin
      ON requesting_admin.telegram_id = $1
      AND requesting_admin.is_admin = TRUE
      AND requesting_admin.is_active = TRUE
      AND requesting_admin.is_blocked = FALSE

    WHERE
      w.approved_by_id = requesting_admin.id
      OR w.rejected_by_id = requesting_admin.id

    ORDER BY
      w.processed_at DESC NULLS LAST,
      w.id DESC

    LIMIT $2
    OFFSET $3
    `,
    [
      adminTelegramId,
      safeLimit,
      safeOffset
    ]
  );

  return rows;
},
  
  async approveWithdrawal(
  withdrawalId,
  adminTelegramId,
  paymentAccountId
) {
  const withdrawalIdNum =
    toPositiveInteger(
      withdrawalId,
      "withdrawalId"
    );

  const accountId =
    toPositiveInteger(
      paymentAccountId,
      "paymentAccountId"
    );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * ============================================================
     * 1. Verify admin
     * ============================================================
     */
    const adminResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name,
        admin_role
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_blocked = FALSE
      LIMIT 1
      `,
      [adminTelegramId]
    );

    if (adminResult.rowCount !== 1) {
      throw new Error(
        "Admin account not found."
      );
    }

    const admin =
      adminResult.rows[0];

    /*
     * ============================================================
     * 2. Lock the withdrawal
     * ============================================================
     *
     * IMPORTANT:
     *
     * We lock ONLY the withdrawal row here.
     *
     * We do not need to lock the user's wallet because the user's
     * withdrawal amount was already reserved when the withdrawal
     * was created.
     */
    const withdrawalResult =
      await client.query(
        `
        SELECT
          w.*,
          u.telegram_id,
          u.name
        FROM withdrawals w
        JOIN users u
          ON u.id = w.user_id
        WHERE w.id = $1
        FOR UPDATE OF w
        `,
        [withdrawalIdNum]
      );

    if (withdrawalResult.rowCount !== 1) {
      throw new Error(
        "Withdrawal request not found."
      );
    }

    const withdrawal =
      withdrawalResult.rows[0];

    /*
     * ============================================================
     * 3. Verify withdrawal state
     * ============================================================
     */
    if (withdrawal.status !== "processing") {
      throw new Error(
        `Withdrawal is not being processed. Current status: ${withdrawal.status}`
      );
    }

    // large / suspicious requests (needs_review) can only be paid by a MAIN admin
    if (withdrawal.needs_review === true && admin.admin_role !== "main") {
      throw new Error(
        "This withdrawal needs a main admin to approve it (" + ((withdrawal.risk_flags || []).join(", ") || "review") + ")."
      );
    }

    /*
     * ============================================================
     * 4. Verify the admin who claimed the withdrawal
     * ============================================================
     */
    if (
      Number(withdrawal.claimed_by_id) !==
      Number(admin.id)
    ) {
      throw new Error(
        "This withdrawal is assigned to another admin."
      );
    }

    /*
     * ============================================================
     * 5. Verify claim lease
     * ============================================================
     */
    const claimedAt =
      withdrawal.claimed_at
        ? new Date(withdrawal.claimed_at)
        : null;

    if (
      !claimedAt ||
      Number.isNaN(claimedAt.getTime())
    ) {
      throw new Error(
        "This withdrawal has an invalid claim timestamp."
      );
    }

    const CLAIM_TIMEOUT_MS =
      5 * 60 * 1000;

    const claimAge =
      Date.now() -
      claimedAt.getTime();

    if (claimAge > CLAIM_TIMEOUT_MS) {
      throw new Error(
        "This withdrawal claim has expired. Please claim it again."
      );
    }

    /*
     * ============================================================
     * 6. Validate withdrawal amount
     * ============================================================
     */
    const amount =
      Number(withdrawal.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error(
        "Invalid withdrawal amount."
      );
    }

    /*
     * ============================================================
     * 7. Make sure the withdrawal has a reservation transaction
     * ============================================================
     *
     * The user's funds should already have been reserved by
     * createWithdrawal().
     *
     * Therefore an approved withdrawal must have a linked
     * financial transaction.
     */
    if (!withdrawal.transaction_id) {
      throw new Error(
        "Withdrawal has no reservation transaction."
      );
    }

    /*
     * ============================================================
     * 8. Verify the reservation transaction
     * ============================================================
     */
    const transactionResult =
      await client.query(
        `
        SELECT
          id,
          type,
          status
        FROM financial_transactions
        WHERE id = $1
        FOR UPDATE
        `,
        [withdrawal.transaction_id]
      );

    if (transactionResult.rowCount !== 1) {
      throw new Error(
        "Withdrawal reservation transaction not found."
      );
    }

    const financialTransaction =
      transactionResult.rows[0];

    if (
      financialTransaction.type !==
      "withdrawal"
    ) {
      throw new Error(
        "Withdrawal has an invalid financial transaction type."
      );
    }

    if (
      financialTransaction.status !==
      "completed"
    ) {
      throw new Error(
        "Withdrawal reservation transaction is not completed."
      );
    }

    /*
     * ============================================================
     * 9. Lock payment account
     * ============================================================
     *
     * This is critical.
     *
     * Multiple admins may be processing different withdrawals
     * using the same payment account.
     *
     * FOR UPDATE prevents two transactions from spending the
     * same payment-account balance concurrently.
     */
    const accountResult =
      await client.query(
        `
        SELECT
          id,
          payment_method_id,
          account_number,
          account_name,
          balance,
          is_active,
          is_removed
        FROM payment_accounts
        WHERE id = $1
        FOR UPDATE
        `,
        [accountId]
      );

    if (accountResult.rowCount !== 1) {
      throw new Error(
        "Payment account not found."
      );
    }

    const account =
      accountResult.rows[0];

    /*
     * ============================================================
     * 10. Validate payment account
     * ============================================================
     */
    if (
      !account.is_active ||
      account.is_removed
    ) {
      throw new Error(
        "Selected payment account is inactive or removed."
      );
    }

    /*
     * The payment account must belong to the same payment method
     * selected by the user.
     */
    if (
      Number(account.payment_method_id) !==
      Number(withdrawal.payment_method_id)
    ) {
      throw new Error(
        "Payment account does not match the withdrawal payment method."
      );
    }

    /*
     * ============================================================
     * 11. Check payment account balance
     * ============================================================
     */
    const accountBalance =
      Number(account.balance);

    if (
      !Number.isFinite(accountBalance) ||
      accountBalance < 0
    ) {
      throw new Error(
        "Payment account has an invalid balance."
      );
    }

    if (accountBalance < amount) {
      throw new Error(
        "Insufficient payment-account balance."
      );
    }

    /*
     * ============================================================
     * 12. Deduct payment account
     * ============================================================
     *
     * The payment account is already locked with FOR UPDATE.
     *
     * We also use RETURNING to obtain the actual resulting balance
     * from PostgreSQL.
     */
    const accountUpdateResult =
      await client.query(
        `
        UPDATE payment_accounts
        SET
          balance = balance - $1,
          updated_at = NOW()
        WHERE id = $2
          AND balance >= $1
        RETURNING
          id,
          balance
        `,
        [
          amount,
          account.id
        ]
      );

    if (accountUpdateResult.rowCount !== 1) {
      throw new Error(
        "Payment account balance could not be updated."
      );
    }

    const updatedAccount =
      accountUpdateResult.rows[0];

    const accountBalanceAfter =
      Number(updatedAccount.balance);

    /*
     * ============================================================
     * 13. Approve withdrawal
     * ============================================================
     *
     * The WHERE conditions provide another layer of protection.
     */
    const updateResult =
      await client.query(
        `
        UPDATE withdrawals
        SET
          payment_account_id = $1,
          approved_by_id = $2,
          rejected_by_id = NULL,
          status = 'approved',
          rejection_reason = NULL,
          claimed_by_id = NULL,
          claimed_at = NULL,
          processed_at = NOW(),
          updated_at = NOW()
        WHERE id = $3
          AND status = 'processing'
          AND claimed_by_id = $2
          AND claimed_at IS NOT NULL
          AND claimed_at >= NOW() - INTERVAL '5 minutes'
        RETURNING *
        `,
        [
          account.id,
          admin.id,
          withdrawalIdNum
        ]
      );

    /*
     * If this fails, throw.
     *
     * Because everything is inside the same DB transaction,
     * the payment-account deduction will also be rolled back.
     */
    if (updateResult.rowCount !== 1) {
      throw new Error(
        "Withdrawal could not be approved. The claim may have expired or changed."
      );
    }

    const approvedWithdrawal =
      updateResult.rows[0];

    /*
     * ============================================================
     * 14. Commit
     * ============================================================
     *
     * At this point:
     *
     *   withdrawal       = approved
     *   payment account  = amount deducted
     *   user funds       = already reserved
     *
     * All three changes are committed together.
     */
    await client.query("COMMIT");

	/*
	 * Read the user's current wallet balance.
	 */
	const balanceResult = await pool.query(
	  `
	  SELECT
	    main_balance,
	    play_balance,
	    total_balance
	  FROM user_wallet_balances
	  WHERE user_id = $1
	  `,
	  [withdrawal.user_id]
	);
	
	if (balanceResult.rowCount !== 1) {
	  throw new Error(
	    "User wallet balance record not found."
	  );
	}
	
	const balances = balanceResult.rows[0];
	
	const mainBalance =
	  Number(balances.main_balance);
	
	const playBalance =
	  Number(balances.play_balance);
	
	const totalBalance =
	  Number(balances.total_balance);

    /*
     * ============================================================
     * 15. Return result
     * ============================================================
     */
    return {
      success: true,

      withdrawal_id:
        approvedWithdrawal.id,

      user_id:
        withdrawal.user_id,

      telegram_id:
        withdrawal.telegram_id,

      user_name:
        withdrawal.name,

      amount,

      account_number:
        withdrawal.account_number,

      account_name:
        withdrawal.account_name,

      payment_method_id:
        withdrawal.payment_method_id,

      payment_account_id:
        account.id,

      payment_account_number:
        account.account_number,

      payment_account_name:
        account.account_name,

      payment_account_balance_before:
        accountBalance,

      payment_account_balance_after:
        accountBalanceAfter,

      transaction_id:
        withdrawal.transaction_id,

      withdrawal:
        approvedWithdrawal,
	  mainBalance:
		mainBalance,  
	  playBalance:
		playBalance,
	  totalBalance:
		totalBalance		
    };

  } catch (err) {
    /*
     * ============================================================
     * ROLLBACK
     * ============================================================
     *
     * This is extremely important.
     *
     * If payment_account.balance was deducted but the withdrawal
     * UPDATE failed, ROLLBACK restores the payment account.
     */
    await safeRollback(client);

    console.error(
      "approveWithdrawal error:",
      err
    );

    return {
      success: false,
      message:
        err?.message ||
        "Withdrawal approval failed."
    };

  } finally {
    client.release();
  }
},


async rejectWithdrawal(
  withdrawalId,
  adminTelegramId,
  reason
) {
  const withdrawalIdNum =
    toPositiveInteger(
      withdrawalId,
      "withdrawalId"
    );

  const cleanReason =
    String(
      reason || "Rejected by admin"
    )
      .trim()
      .slice(0, 100);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * ============================================================
     * 1. Verify admin
     * ============================================================
     */
    const adminResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_blocked = FALSE
      LIMIT 1
      `,
      [adminTelegramId]
    );

    if (adminResult.rowCount !== 1) {
      throw new Error(
        "Admin account not found."
      );
    }

    const admin =
      adminResult.rows[0];

    /*
     * ============================================================
     * 2. Lock the withdrawal
     * ============================================================
     *
     * We lock ONLY the withdrawal row.
     *
     * The user's wallet does not need to be independently locked
     * here because refund_withdrawal() is responsible for the
     * wallet/ledger operation.
     */
    const withdrawalResult =
      await client.query(
        `
        SELECT
          w.*,
          u.telegram_id,
          u.name
        FROM withdrawals w
        JOIN users u
          ON u.id = w.user_id
        WHERE w.id = $1
        FOR UPDATE OF w
        `,
        [withdrawalIdNum]
      );

    if (withdrawalResult.rowCount !== 1) {
      throw new Error(
        "Withdrawal request not found."
      );
    }

    const withdrawal =
      withdrawalResult.rows[0];

    /*
     * ============================================================
     * 3. Verify withdrawal state
     * ============================================================
     *
     * Only a withdrawal currently being processed can be rejected.
     */
    if (withdrawal.status !== "processing") {
      throw new Error(
        `Withdrawal is not being processed. Current status: ${withdrawal.status}`
      );
    }

    /*
     * ============================================================
     * 4. Verify admin owns the claim
     * ============================================================
     */
    if (
      Number(withdrawal.claimed_by_id) !==
      Number(admin.id)
    ) {
      throw new Error(
        "This withdrawal is assigned to another admin."
      );
    }

    /*
     * ============================================================
     * 5. Validate claim timestamp
     * ============================================================
     */
    const claimedAt =
      withdrawal.claimed_at
        ? new Date(withdrawal.claimed_at)
        : null;

    if (
      !claimedAt ||
      Number.isNaN(claimedAt.getTime())
    ) {
      throw new Error(
        "This withdrawal has an invalid claim timestamp."
      );
    }

    const CLAIM_TIMEOUT_MS =
      5 * 60 * 1000;

    const claimAge =
      Date.now() -
      claimedAt.getTime();

    if (claimAge > CLAIM_TIMEOUT_MS) {
      throw new Error(
        "This withdrawal claim has expired. Please claim it again."
      );
    }

    /*
     * ============================================================
     * 6. Validate withdrawal transaction
     * ============================================================
     *
     * createWithdrawal() should have already created and linked
     * the original withdrawal reservation transaction.
     */
    if (!withdrawal.transaction_id) {
      throw new Error(
        "Withdrawal has no financial transaction to refund."
      );
    }

    /*
     * ============================================================
     * 7. Validate original financial transaction
     * ============================================================
     */
    const transactionResult =
      await client.query(
        `
        SELECT
          id,
          type,
          status
        FROM financial_transactions
        WHERE id = $1
        FOR UPDATE
        `,
        [withdrawal.transaction_id]
      );

    if (transactionResult.rowCount !== 1) {
      throw new Error(
        "Original withdrawal transaction not found."
      );
    }

    const originalTransaction =
      transactionResult.rows[0];

    if (
      originalTransaction.type !==
      "withdrawal"
    ) {
      throw new Error(
        "Original transaction is not a withdrawal transaction."
      );
    }

    if (
      originalTransaction.status !==
      "completed"
    ) {
      throw new Error(
        "Original withdrawal transaction is not completed."
      );
    }

    /*
     * ============================================================
     * 8. Refund the withdrawal
     * ============================================================
     *
     * refund_withdrawal() should atomically:
     *
     *   - lock the user's appropriate wallet row
     *   - verify the original withdrawal transaction
     *   - prevent duplicate refunds
     *   - restore the user's wallet balance
     *   - create the refund ledger transaction
     *   - return the refund transaction ID
     *
     * The idempotency key is unique per withdrawal.
     */
    const refundResult =
      await client.query(
        `
        SELECT refund_withdrawal(
          $1,
          $2,
          $3,
          $4,
          $5
        ) AS transaction_id
        `,
        [
          withdrawal.user_id,
          withdrawal.id,
          withdrawal.transaction_id,
          `withdrawal:refund:${withdrawal.id}`,
          `Withdrawal #${withdrawal.id} rejected`
        ]
      );

    const refundTransactionId =
      refundResult.rows[0]?.transaction_id;

    if (!refundTransactionId) {
      throw new Error(
        "Could not create withdrawal refund transaction."
      );
    }

    /*
     * ============================================================
     * 9. Validate refund transaction
     * ============================================================
     */
    const refundTransactionResult =
      await client.query(
        `
        SELECT
          id,
          type,
          status
        FROM financial_transactions
        WHERE id = $1
        FOR UPDATE
        `,
        [refundTransactionId]
      );

    if (refundTransactionResult.rowCount !== 1) {
      throw new Error(
        "Refund transaction was not found."
      );
    }

    const refundTransaction =
      refundTransactionResult.rows[0];

    if (
      refundTransaction.status !==
      "completed"
    ) {
      throw new Error(
        "Refund transaction was not completed."
      );
    }

    /*
     * ============================================================
     * 10. Reject the withdrawal
     * ============================================================
     *
     * The claim is cleared because the withdrawal is no longer
     * being processed.
     *
     * The database also verifies the 5-minute lease here.
     */
    const updateResult =
      await client.query(
        `
        UPDATE withdrawals
        SET
          rejected_by_id = $1,
          approved_by_id = NULL,
          status = 'rejected',
          rejection_reason = $2,
          claimed_by_id = NULL,
          claimed_at = NULL,
          processed_at = NOW(),
          updated_at = NOW()
        WHERE id = $3
          AND status = 'processing'
          AND claimed_by_id = $1
          AND claimed_at IS NOT NULL
          AND claimed_at >= NOW() - INTERVAL '5 minutes'
        RETURNING *
        `,
        [
          admin.id,
          cleanReason,
          withdrawalIdNum
        ]
      );

    if (updateResult.rowCount !== 1) {
      throw new Error(
        "Withdrawal could not be rejected. The claim may have expired or changed."
      );
    }

    const rejectedWithdrawal =
      updateResult.rows[0];

    /*
     * ============================================================
     * 11. Read the user's current wallet balances
     * ============================================================
     *
     * refund_withdrawal() has already restored the user's funds.
     *
     * We now read the resulting balances.
     */
    const walletResult =
      await client.query(
        `
        SELECT
          main_balance,
          play_balance,
          total_balance
        FROM user_wallet_balances
        WHERE user_id = $1
        `,
        [withdrawal.user_id]
      );

    if (walletResult.rowCount !== 1) {
      throw new Error(
        "User wallet balance record not found."
      );
    }

    const walletBalances =
      walletResult.rows[0];

    /*
     * ============================================================
     * 12. Commit
     * ============================================================
     *
     * Everything succeeds or everything rolls back:
     *
     *   - refund
     *   - wallet balance
     *   - refund ledger transaction
     *   - withdrawal rejection
     */
    await client.query("COMMIT");

    /*
     * ============================================================
     * 13. Return result
     * ============================================================
     */
    return {
      success: true,

      withdrawal_id:
        rejectedWithdrawal.id,

      telegram_id:
        withdrawal.telegram_id,

      user_id:
        withdrawal.user_id,

      user_name:
        withdrawal.name,

      amount:
        Number(withdrawal.amount),

      rejection_reason:
        cleanReason,

      /*
       * Original reservation transaction.
       */
      transaction_id:
        withdrawal.transaction_id,

      /*
       * New refund transaction.
       */
      refund_transaction_id:
        refundTransactionId,

      /*
       * Current user wallet balances after refund.
       */
      main_balance:
        Number(
          walletBalances.main_balance || 0
        ),

      play_balance:
        Number(
          walletBalances.play_balance || 0
        ),

      total_balance:
        Number(
          walletBalances.total_balance || 0
        ),

      /*
       * Kept for compatibility with your existing API.
       */
      balance_after:
        Number(
          walletBalances.total_balance || 0
        ),

      withdrawal:
        rejectedWithdrawal
    };

  } catch (err) {
    /*
     * ============================================================
     * ROLLBACK
     * ============================================================
     *
     * If the refund succeeds but anything afterward fails,
     * the refund itself is rolled back too.
     */
    await safeRollback(client);

    console.error(
      "rejectWithdrawal error:",
      err
    );

    return {
      success: false,
      message:
        err?.message ||
        "Withdrawal rejection failed."
    };

  } finally {
    client.release();
  }
},
  
  // ============================================================
// BROADCAST DRAFTS
// ============================================================

async createBroadcastDraft(adminId) {
  await pool.query(
    `
    INSERT INTO broadcast_drafts (
      admin_id,
      image_url,
      message,
      button_title,
      include_image,
      include_text,
      include_button,
      status
    )
    VALUES (
      $1,
      NULL,
      NULL,
      NULL,
      FALSE,
      FALSE,
      FALSE,
      'selecting_content'
    )
    ON CONFLICT (admin_id)
    DO UPDATE SET
      image_url = NULL,
      message = NULL,
      message_am = NULL,
      button_title = NULL,
      include_image = FALSE,
      include_text = FALSE,
      include_button = FALSE,
      status = 'selecting_content',
      created_at = NOW()
    `,
    [adminId]
  );
},

async getBroadcastDraft(adminId) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM broadcast_drafts
    WHERE admin_id = $1
    LIMIT 1
    `,
    [adminId]
  );

  return rows[0] || null;
},

async updateBroadcastOptions(
  adminId,
  includeImage,
  includeText,
  includeButton
) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET
      include_image = $2,
      include_text = $3,
      include_button = $4,
      status = 'building'
    WHERE admin_id = $1
    `,
    [
      adminId,
      Boolean(includeImage),
      Boolean(includeText),
      Boolean(includeButton)
    ]
  );
},

async updateBroadcastImage(adminId, imageUrl) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET image_url = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      imageUrl
    ]
  );
},

async updateBroadcastMessage(adminId, message) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET message = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      message
    ]
  );
},

// Amharic version of the broadcast text. '' = the admin skipped it (those users get the English text).
async updateBroadcastMessageAm(adminId, message) {
  await pool.query(
    `UPDATE broadcast_drafts SET message_am = $2 WHERE admin_id = $1`,
    [adminId, message]
  );
},

async updateBroadcastButtonTitle(adminId, buttonTitle) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET button_title = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      buttonTitle
    ]
  );
},

async updateBroadcastStatus(adminId, status) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET status = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      status
    ]
  );
},

async deleteBroadcastDraft(adminId) {
  await pool.query(
    `
    DELETE FROM broadcast_drafts
    WHERE admin_id = $1
    `,
    [adminId]
  );
},

async getAllActiveUsers() {
  const { rows } = await pool.query(
    `
    SELECT telegram_id, language
    FROM users
    WHERE is_active = TRUE
      AND is_blocked = FALSE
    `
  );

  return rows;
},

  // ============================================================
  // PAYMENT TYPES / METHODS / ACCOUNTS
  // ============================================================

  async getPaymentMethodTypes() {

    const { rows } =
      await pool.query(
        `
        SELECT
          pt.id,
          pt.name,
          pt.amharic_name,
          pt.emoji,
          pt.maximum_balance,
          pt."order",
          pt.is_active

        FROM payment_types pt

        WHERE pt.is_active = TRUE

          AND EXISTS (
            SELECT 1
            FROM payment_methods pm
            WHERE pm.type_id = pt.id
              AND pm.is_active = TRUE
          )

        ORDER BY
          pt."order" NULLS LAST,
          pt.id
        `
      );

    return rows;
  },

    async getPaymentMethodTypesById(paymentTypeId) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pt.id,          
          pt.name,
          pt.amharic_name,
          pt.emoji,
          pt.maximum_balance,
          pt."order",
          pt.is_active

        FROM payment_types pt

        WHERE pt.is_active = TRUE
              AND pt.id = $1

          AND EXISTS (
            SELECT 1
            FROM payment_methods pm
            WHERE pm.type_id = pt.id
              AND pm.is_active = TRUE
          )

        ORDER BY
          pt."order" NULLS LAST,
          pt.id
        `,
        [paymentTypeId]
      );

    return rows[0] || null;
  },

  async getPaymentMethods() {

    const { rows } =
      await pool.query(
        `
        SELECT
          pm.id,
          pm.type_id,
          pm.name,
          pm.amharic_name,
          pm.emoji,

          pt.name
            AS type_name,

          pt.amharic_name
            AS am_type_name,

          pt.emoji
            AS type_emoji

        FROM payment_methods pm

        JOIN payment_types pt
          ON pt.id = pm.type_id

        WHERE pm.is_active = TRUE
          AND pt.is_active = TRUE

        ORDER BY
          pm."order",
          pm.id
        `
      );

    return rows;
  },

  async getPaymentMethodById(
    pmId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pm.id,
          pm.type_id,
          pm.name,
          pm.amharic_name,
          pm.emoji,

          pt.name
            AS type_name,

          pt.amharic_name
            AS am_type_name,

          pt.emoji
            AS type_emoji,

          pt.maximum_balance

        FROM payment_methods pm

        JOIN payment_types pt
          ON pt.id = pm.type_id

        WHERE pm.id = $1
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE

        LIMIT 1
        `,
        [pmId]
      );

    return rows[0] || null;
  },

  async getPaymentAccount(
    paymentMethodId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pa.*,

          pm.name
            AS pm_name,

          pm.amharic_name
            AS pm_amharic_name,

          pm.emoji
            AS pm_emoji,

          pt.name
            AS pt_name,

          pt.amharic_name
            AS pt_amharic_name,

          pt.emoji
            AS pt_emoji,

          pt.maximum_balance

        FROM payment_accounts pa

        JOIN payment_methods pm
          ON pm.id =
             pa.payment_method_id

        JOIN payment_types pt
          ON pt.id =
             pm.type_id

        WHERE pa.payment_method_id = $1
          AND pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE
          AND (
            pt.maximum_balance IS NULL
            OR pa.balance <
               pt.maximum_balance
          )

        ORDER BY
          pa.balance ASC,
          pa.id ASC

        LIMIT 1
        `,
        [paymentMethodId]
      );

    return rows[0] || null;
  },

  async getPaymentAccountsByMethod(
    paymentMethodId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pa.id,
          pa.payment_method_id,
          pa.account_number,
          pa.account_name,
          pa.balance,
          pa.is_active,
          pa.is_removed,

          pm.name
            AS pm_name,

          pm.amharic_name
            AS pm_amharic_name,

          pm.emoji
            AS pm_emoji,

          pt.name
            AS pt_name,

          pt.amharic_name
            AS pt_amharic_name,

          pt.emoji
            AS pt_emoji

        FROM payment_accounts pa

        JOIN payment_methods pm
          ON pm.id =
             pa.payment_method_id

        JOIN payment_types pt
          ON pt.id =
             pm.type_id

        WHERE pa.payment_method_id = $1
          AND pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE

        ORDER BY
          pa.account_number ASC,
          pa.id ASC
        `,
        [paymentMethodId]
      );

    return rows;
  },

  async getPaymentAccountById(
    paymentAccountId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pa.id,
          pa.payment_method_id,
          pa.account_number,
          pa.account_name,
          pa.balance,
          pa.is_active,
          pa.is_removed,

          pm.name
            AS pm_name,

          pm.amharic_name
            AS pm_amharic_name,

          pm.emoji
            AS pm_emoji,

          pt.name
            AS pt_name,

          pt.amharic_name
            AS pt_amharic_name,

          pt.emoji
            AS pt_emoji

        FROM payment_accounts pa

        JOIN payment_methods pm
          ON pm.id =
             pa.payment_method_id

        JOIN payment_types pt
          ON pt.id =
             pm.type_id

        WHERE pa.id = $1
          AND pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE

        LIMIT 1
        `,
        [paymentAccountId]
      );

    return rows[0] || null;
  },

  // ============================================================
// GET PAYMENT ACCOUNT BY ID — ADMIN
// Includes inactive and removed accounts.
// ============================================================

async getPaymentAccountByIdForAdmin(
  paymentAccountId
) {

  const id =
    Number(paymentAccountId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return null;
  }

  const { rows } =
    await pool.query(
      `
      SELECT
        pa.id,
        pa.payment_method_id,
        pa.account_number,
        pa.account_name,
        pa.balance,
        pa.is_active,
        pa.is_removed,

        pm.name
          AS pm_name,

        pm.amharic_name
          AS pm_amharic_name,

        pm.emoji
          AS pm_emoji,

        pt.name
          AS pt_name,

        pt.amharic_name
          AS pt_amharic_name,

        pt.emoji
          AS pt_emoji

      FROM payment_accounts pa

      JOIN payment_methods pm
        ON pm.id =
           pa.payment_method_id

      JOIN payment_types pt
        ON pt.id =
           pm.type_id

      WHERE pa.id = $1

      LIMIT 1
      `,
      [id]
    );

  return rows[0] || null;
},
  // ============================================================
// DELETE / UNDELETE PAYMENT ACCOUNT
// Soft delete using is_removed.
// ============================================================

async setPaymentAccountRemoved(
  paymentAccountId,
  isRemoved
) {

  const id =
    Number(paymentAccountId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return null;
  }

  const { rows } =
    await pool.query(
      `
      UPDATE payment_accounts

      SET
        is_removed = $1

      WHERE id = $2

      RETURNING
        id,
        payment_method_id,
        account_number,
        account_name,
        balance,
        is_active,
        is_removed
      `,
      [
        Boolean(isRemoved),
        id
      ]
    );

  return rows[0] || null;
},
  // ============================================================
// UPDATE PAYMENT ACCOUNT
// ============================================================

async updatePaymentAccount(
  paymentAccountId,
  accountName,
  accountNumber,
  balance
) {

  const id =
    Number(paymentAccountId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return null;
  }

  const name =
    String(
      accountName ?? ""
    ).trim();

  const number =
    String(
      accountNumber ?? ""
    ).trim();

  const numericBalance =
    Number(balance);

  if (!name || name.length > 100) {
    throw new Error(
      "Invalid account name."
    );
  }

  if (!number || number.length > 100) {
    throw new Error(
      "Invalid account number."
    );
  }

  if (
    !Number.isFinite(numericBalance) ||
    numericBalance < 0
  ) {
    throw new Error(
      "Invalid account balance."
    );
  }

  const { rows } =
    await pool.query(
      `
      UPDATE payment_accounts

      SET
        account_name = $1,
        account_number = $2,
        balance = $3

      WHERE id = $4

      RETURNING
        id,
        payment_method_id,
        account_number,
        account_name,
        balance,
        is_active,
        is_removed
      `,
      [
        name,
        number,
        numericBalance,
        id
      ]
    );

  return rows[0] || null;
},

  // ============================================================
// PAYMENT ACCOUNTS — ADMIN LIST
// Includes removed accounts so admin can undelete them.
// ============================================================

async getAllPaymentAccountsForAdmin() {

  const { rows } =
    await pool.query(
      `
      SELECT
        pa.id,
        pa.payment_method_id,
        pa.account_number,
        pa.account_name,
        pa.balance,
        pa.is_active,
        pa.is_removed,

        pm.name
          AS pm_name,

        pm.amharic_name
          AS pm_amharic_name,

        pm.emoji
          AS pm_emoji,

        pt.name
          AS pt_name,

        pt.amharic_name
          AS pt_amharic_name,

        pt.emoji
          AS pt_emoji

      FROM payment_accounts pa

      JOIN payment_methods pm
        ON pm.id =
           pa.payment_method_id

      JOIN payment_types pt
        ON pt.id =
           pm.type_id

      WHERE pm.is_active = TRUE
        AND pt.is_active = TRUE
        AND pa.is_removed = FALSE

      ORDER BY
        pm."order" ASC,
        pa.id ASC
      `
    );

  return rows;
},

  // Removed accounts are hidden from the admin list.
  // They can only be found again by searching their number.
  async countRemovedPaymentAccounts() {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM payment_accounts WHERE is_removed = TRUE"
    );
    return rows[0]?.n || 0;
  },

  async searchRemovedPaymentAccounts(numberText, limit = 5) {
    let d = String(numberText || "").replace(/\D/g, "");
    if (d.length < 4) return null; // too short to search safely
    if (d.length > 9) d = d.slice(-9); // phone numbers: ignore 0 / 251 prefix differences
    const { rows } = await pool.query(
      `
      SELECT pa.id, pa.account_number, pa.account_name, pa.balance, pa.is_active,
             pm.name AS pm_name, pm.amharic_name AS pm_amharic_name, pm.emoji AS pm_emoji
      FROM payment_accounts pa
      LEFT JOIN payment_methods pm ON pm.id = pa.payment_method_id
      WHERE pa.is_removed = TRUE
        AND regexp_replace(pa.account_number, '\\D', '', 'g') LIKE '%' || $1 || '%'
      ORDER BY pa.id DESC
      LIMIT $2
      `,
      [d, Math.max(1, Math.min(10, Number(limit) || 5))]
    );
    return rows;
  },

  async setPaymentAccountActive(
    paymentAccountId,
    isActive
  ) {

    const id =
      Number(paymentAccountId);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return null;
    }

    const { rows } =
      await pool.query(
        `
        UPDATE payment_accounts

        SET
          is_active = $1

        WHERE id = $2
          AND is_removed = FALSE

        RETURNING
          id,
          payment_method_id,
          account_number,
          account_name,
          balance,
          is_active,
          is_removed
        `,
        [
          Boolean(isActive),
          id
        ]
      );

    return rows[0] || null;
  },

  async createPaymentAccount(
    paymentMethodId,
    accountName,
    accountNumber,
    initialBalance = 0
  ) {

    const startBalance = Number(initialBalance ?? 0);

    if (!Number.isFinite(startBalance) || startBalance < 0) {
      return { success: false, message: "Invalid initial balance." };
    }

    const methodId =
      toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      );

    const name =
      String(
        accountName ?? ""
      ).trim();

    const number =
      String(
        accountNumber ?? ""
      ).trim();

    if (
      !name ||
      name.length > 100
    ) {

      return {
        success: false,
        message:
          "Invalid account name."
      };
    }

    if (
      !number ||
      number.length > 100
    ) {

      return {
        success: false,
        message:
          "Invalid account number."
      };
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const method =
        await client.query(
          `
          SELECT
            pm.id,
            pt.name
              AS type_name,
            pt.amharic_name
              AS type_amharic_name

          FROM payment_methods pm

          JOIN payment_types pt
            ON pt.id =
               pm.type_id

          WHERE pm.id = $1
            AND pm.is_active = TRUE
            AND pt.is_active = TRUE

          FOR SHARE
          `,
          [methodId]
        );

      if (
        !method.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Payment method not found or inactive."
        };
      }

      const removedDuplicate =
        await client.query(
          `
          SELECT id
          FROM payment_accounts
          WHERE payment_method_id = $1
            AND account_number = $2
            AND is_removed = TRUE
          LIMIT 1
          `,
          [methodId, number]
        );

      if (removedDuplicate.rows.length) {
        await client.query("ROLLBACK");
        return {
          success: false,
          message:
            "A removed account with this number already exists. " +
            "Use 'Restore a removed account' in Payment Accounts to bring it back."
        };
      }

      const duplicate =
        await client.query(
          `
          SELECT id
          FROM payment_accounts
          WHERE payment_method_id = $1
            AND account_number = $2
            AND is_removed = FALSE
          LIMIT 1
          `,
          [
            methodId,
            number
          ]
        );

      if (
        duplicate.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "This payment account already exists."
        };
      }

      const inserted =
        await client.query(
          `
          INSERT INTO payment_accounts (
            payment_method_id,
            account_name,
            account_number,
            balance,
            is_active,
            is_removed
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            TRUE,
            FALSE
          )
          RETURNING id
          `,
          [
            methodId,
            name,
            number,
            startBalance
          ]
        );

      const full =
        await client.query(
          `
          SELECT
            pa.*,
            pm.name AS pm_name,
            pm.amharic_name AS pm_amharic_name,
            pm.emoji AS pm_emoji,
            pt.name AS pt_name,
            pt.amharic_name AS pt_amharic_name,
            pt.emoji AS pt_emoji
          FROM payment_accounts pa
          JOIN payment_methods pm ON pm.id = pa.payment_method_id
          JOIN payment_types pt ON pt.id = pm.type_id
          WHERE pa.id = $1
          `,
          [inserted.rows[0].id]
        );

      await client.query(
        "COMMIT"
      );

      return {
        success: true,
        account:
          full.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

      console.error(
        "createPaymentAccount error:",
        err
      );

      return {
        success: false,
        message:
          err.message ||
          "Could not create payment account."
      };

    } finally {

      client.release();

    }
  },

  // ============================================================
  // DEPOSITS
  // ============================================================

  /*
   * IMPORTANT:
   * Keep this function name because the current bot.js
   * calls approveDeposit().
   */

async approveDeposit(receipt, telegramId) {
    const client = await pool.connect();
	let awardedBonuses = [];

    try {
        // ------------------------------------------------------------
        // 1. Validate request input
        // ------------------------------------------------------------

        const parsedTelegramId = Number(telegramId);
		

        if (
            !Number.isSafeInteger(parsedTelegramId) ||
            parsedTelegramId <= 0
        ) {
            throw new Error("Invalid Telegram user ID.");
        }

        const receiptNo = String(receipt?.receiptNo ?? "").trim();

        if (!receiptNo) {
            throw new Error("Receipt number is required.");
        }

        if (receiptNo.length > 100) {
            throw new Error("Receipt number is too long.");
        }

        const amount = toPositiveAmount(
            amountFromReceipt(receipt)
        );

        if (!amount || amount <= 0) {
            throw new Error("Invalid deposit amount.");
        }

        const creditedAccount = String(
            receipt?.creditedPartyAccountNo ?? ""
        ).replace(/\D/g, "");

        if (creditedAccount.length < 4) {
            throw new Error("Invalid credited account number.");
        }

        const creditedName = String(
            receipt?.creditedPartyName ?? ""
        ).trim();

        if (!creditedName) {
            throw new Error("Credited account name is required.");
        }

        const payerName = String(
            receipt?.payerName ?? ""
        ).trim();

        if (!payerName) {
            throw new Error("Payer name is required.");
        }

        const payerAccount = String(
            receipt?.payerTelebirrNo ?? ""
        ).replace(/\D/g, "");

        if (
            payerAccount.length < 4 ||
            payerAccount.length > 20
        ) {
            throw new Error("Invalid payer account number.");
        }

        const creditedAccountLast4 =
            creditedAccount.slice(-4);

        // ------------------------------------------------------------
        // 2. Begin transaction
        // ------------------------------------------------------------

        await client.query("BEGIN");

        // ------------------------------------------------------------
        // 3. Lock the user
        // ------------------------------------------------------------

        const userResult = await client.query(
            `
            SELECT
                id,
                telegram_id,
                name,
                is_active,
                is_blocked
            FROM users
            WHERE telegram_id = $1
            FOR UPDATE
            `,
            [parsedTelegramId]
        );

        if (userResult.rowCount !== 1) {
            throw new Error("User not found.");
        }

        const user = userResult.rows[0];

        if (!user.is_active) {
            throw new Error("User account is inactive.");
        }

        if (user.is_blocked) {
            throw new Error("User is blocked.");
        }

        // admin restriction (this user, or deposits paused for everyone).
        // Thrown before the receipt is saved, so the receipt number is NOT used up
        // and the user can send it again once the restriction is lifted.
        await assertFinancialAllowed(client, user.id, "deposit");

        // ------------------------------------------------------------
        // 4. Protect against duplicate receipt
        //
        // The UNIQUE index is the final protection.
        // This check simply gives a cleaner error.
        // ------------------------------------------------------------

        const duplicateResult = await client.query(
            `
            SELECT
                id,
                status,
                transaction_id
            FROM deposits
            WHERE reference = $1
            LIMIT 1
            FOR UPDATE
            `,
            [receiptNo]
        );

        if (duplicateResult.rowCount > 0) {
            throw new Error(
                `Receipt ${receiptNo} has already been processed.`
            );
        }

        // ------------------------------------------------------------
        // 5. Find the payment account from the receipt
        // ------------------------------------------------------------

        const paymentAccountResult = await client.query(
            `
            SELECT
                pa.id,
                pa.payment_method_id,
                pa.account_name,
                pa.account_number,
                pa.balance,
                pa.is_active,
                pa.is_removed,

                pm.name AS payment_method_name,
                pm.is_active AS payment_method_active

            FROM payment_accounts pa

            JOIN payment_methods pm
                ON pm.id = pa.payment_method_id

            WHERE pa.is_active = TRUE
              AND pa.is_removed = FALSE
              AND pm.is_active = TRUE
              AND RIGHT(
                    REGEXP_REPLACE(pa.account_number, '\\D', '', 'g'),
                    4
                  ) = $1

            FOR UPDATE OF pa
            `,
            [creditedAccountLast4]
        );

        if (paymentAccountResult.rowCount === 0) {
            throw new Error(
                "No active payment account matches the credited account."
            );
        }

        // ------------------------------------------------------------
        // 6. Match the credited account name
        //
        // There may theoretically be multiple accounts with the
        // same last 4 digits, so the account name must disambiguate.
        // ------------------------------------------------------------

        const normalizedCreditedName =
            creditedName.replace(/\s+/g, " ").trim().toLowerCase();

        const matchingAccounts =
            paymentAccountResult.rows.filter((account) => {
                const normalizedAccountName =
                    String(account.account_name ?? "")
                        .replace(/\s+/g, " ")
                        .trim()
                        .toLowerCase();

                return normalizedAccountName === normalizedCreditedName;
            });

        if (matchingAccounts.length === 0) {
            throw new Error(
                "The credited account name does not match any active payment account."
            );
        }

        if (matchingAccounts.length > 1) {
            throw new Error(
                "Multiple payment accounts match this receipt. Deposit cannot be safely processed."
            );
        }

        const paymentAccount = matchingAccounts[0];

        // ------------------------------------------------------------
        // 7. Ask PostgreSQL for the applicable deposit rule
        //
        // get_active_deposit_rule() checks:
        //   - active status
        //   - start/end dates
        //   - payment method
        //   - payment account
        //   - minimum amount
        //   - maximum amount
        //
        // It also applies the database's priority ordering.
        // ------------------------------------------------------------

        const ruleResult = await client.query(
            `
            SELECT *
            FROM get_active_deposit_rule(
                $1,
                $2,
                $3
            )
            `,
            [
                paymentAccount.payment_method_id,
                paymentAccount.id,
                amount
            ]
        );

        if (ruleResult.rowCount !== 1) {
            throw new Error(
                "No active deposit rule allows this deposit."
            );
        }

        const rule = ruleResult.rows[0];

        if (!rule.id) {
            throw new Error(
                "No valid deposit rule was found for this deposit."
            );
        }

        // ------------------------------------------------------------
        // 8. Save the deposit as pending first
        //
        // rule_id is stored so we know exactly which rule authorized
        // this deposit.
        // ------------------------------------------------------------

        const depositResult = await client.query(
            `
            INSERT INTO deposits (
                user_id,
                payment_account_id,
                deposit_method_id,
                depositor_name,
                depositor_account,
                amount,
                reference,
                rule_id,
                status,
                created_at,
                updated_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                'pending',
                NOW(),
                NOW()
            )
            RETURNING
                id,
                user_id,
                payment_account_id,
                deposit_method_id,
                depositor_name,
                depositor_account,
                amount,
                reference,
                rule_id,
                status,
                created_at
            `,
            [
                user.id,
                paymentAccount.id,
                // This column is the deposit_method_id, while
                // get_active_deposit_rule uses payment_method_id.
                paymentAccount.payment_method_id,
                payerName,
                payerAccount,
                amount,
                receiptNo,
                rule.id
            ]
        );

        if (depositResult.rowCount !== 1) {
            throw new Error("Failed to create deposit record.");
        }

        const deposit = depositResult.rows[0];

        // ------------------------------------------------------------
        // 9. Credit ONLY the Play wallet
        //
        // users.balance is intentionally NOT updated.
        // ------------------------------------------------------------

        const transactionResult = await client.query(
            `
            SELECT credit_deposit_to_wallet(
                $1,
                $2,
                $3,
                $4,
                NULL,
                $5
            ) AS transaction_id
            `,
            [
                user.id,
                amount,
                deposit.id,
                `deposit:credit:${deposit.id}`,
                `Deposit ${receiptNo}`
            ]
        );

        if (transactionResult.rowCount !== 1) {
            throw new Error(
                "Failed to create deposit financial transaction."
            );
        }

        const transactionId =
            transactionResult.rows[0].transaction_id;

        if (!transactionId) {
            throw new Error(
                "Deposit financial transaction was not created."
            );
        }

        // ------------------------------------------------------------
        // 10. Verify the financial transaction
        // ------------------------------------------------------------

        const transactionCheck = await client.query(
            `
            SELECT
                id,
                user_id,
                type,
                status,
                source_type,
                source_id
            FROM financial_transactions
            WHERE id = $1
            FOR UPDATE
            `,
            [transactionId]
        );

        if (transactionCheck.rowCount !== 1) {
            throw new Error(
                "Deposit financial transaction could not be verified."
            );
        }

        const transaction =
            transactionCheck.rows[0];

        if (Number(transaction.user_id) !== Number(user.id)) {
            throw new Error(
                "Deposit transaction user mismatch."
            );
        }

        if (transaction.type !== "deposit") {
            throw new Error(
                "Invalid financial transaction type for deposit."
            );
        }

        if (transaction.status !== "completed") {
            throw new Error(
                "Deposit financial transaction is not completed."
            );
        }

        if (transaction.source_type !== "deposit") {
            throw new Error(
                "Deposit transaction source mismatch."
            );
        }

        if (String(transaction.source_id) !== String(deposit.id)) {
            throw new Error(
                "Deposit transaction source ID mismatch."
            );
        }

        // ------------------------------------------------------------
        // 11. Verify the ledger entry belongs to the PLAY wallet
        // ------------------------------------------------------------

        const ledgerResult = await client.query(
            `
            SELECT
                le.id,
                le.wallet_id,
                le.amount,
                w.wallet_type
            FROM ledger_entries le
            JOIN wallets w
                ON w.id = le.wallet_id
            WHERE le.transaction_id = $1
            FOR UPDATE
            `,
            [transactionId]
        );

        if (ledgerResult.rowCount !== 1) {
            throw new Error(
                "Deposit must create exactly one wallet ledger entry."
            );
        }

        const ledger = ledgerResult.rows[0];

        if (ledger.wallet_type !== "play") {
            throw new Error(
                "Deposit attempted to credit a non-play wallet."
            );
        }

        if (Number(ledger.amount) !== Number(amount)) {
            throw new Error(
                "Deposit ledger amount does not match the receipt amount."
            );
        }

        // ------------------------------------------------------------
        // 12. Increase the payment account balance
        //
        // This is separate from the user's wallet.
        // Both operations remain inside the same DB transaction.
        // ------------------------------------------------------------

        const paymentAccountUpdate = await client.query(
            `
            UPDATE payment_accounts
            SET
                balance = balance + $1
            WHERE id = $2
              AND is_active = TRUE
              AND is_removed = FALSE
            RETURNING
                id,
                balance
            `,
            [
                amount,
                paymentAccount.id
            ]
        );

        if (paymentAccountUpdate.rowCount !== 1) {
            throw new Error(
                "Payment account could not be updated."
            );
        }

        const updatedPaymentAccount =
            paymentAccountUpdate.rows[0];

        // ------------------------------------------------------------
        // 13. Mark deposit completed
        // ------------------------------------------------------------

        const completedDepositResult = await client.query(
            `
            UPDATE deposits
            SET
                transaction_id = $1,
                status = 'completed',
                approved_at = NOW(),
                updated_at = NOW()
            WHERE id = $2
              AND status = 'pending'
            RETURNING
                id,
                status,
                transaction_id,
                rule_id,
                approved_at,
                updated_at
            `,
            [
                transactionId,
                deposit.id
            ]
        );

        if (completedDepositResult.rowCount !== 1) {
            throw new Error(
                "Deposit could not be marked as completed."
            );
        }

		// ------------------------------------------------------------
		// 14. Evaluate and award eligible deposit bonuses
		//
		// IMPORTANT:
		// This happens inside the SAME database transaction as the
		// deposit. If any bonus award fails, the entire deposit is
		// rolled back.
		// ------------------------------------------------------------
		
		const eligibleBonusesResult = await client.query(
		    `
		    SELECT
		        campaign_id,
		        campaign_code,
		        campaign_name,
		        bonus_type,
		        game_system_id,
		        amount,
		        percentage,
		        multiplier,
		        wagering_multiplier,
		        min_deposit_amount,
		        max_bonus_amount,
		        validity_hours,
		        stackable,
		        stack_group,
		        priority
		    FROM public.get_eligible_deposit_bonus_campaigns(
		        $1::integer,
		        $2::integer,
		        $3::numeric
		    )
		    ORDER BY
		        priority DESC,
		        campaign_id ASC
		    `,
		    [
		        user.id,
		        deposit.id,
		        amount
		    ]
		);
		
		for (const campaign of eligibleBonusesResult.rows) {
		
		    const idempotencyKey =
		        `deposit-bonus:${deposit.id}:${campaign.campaign_id}`;
		
		    const bonusResult = await client.query(
		        `
		        SELECT
		            bonus_id,
		            transaction_id
		        FROM public.award_bonus(
		            $1,
		            $2,
		            $3,
		            $4,
		            $5,
		            $6,
		            $7,
		            $8::jsonb
		        )
		        `,
		        [
		            user.id,
		            campaign.campaign_id,
		            amount,
		            "deposit",
		            String(deposit.id),
		            idempotencyKey,
		            `Deposit bonus: ${campaign.campaign_name}`,
		            JSON.stringify({
		                deposit_id: deposit.id,
		                deposit_reference: deposit.reference,
		                deposit_amount: amount,
		                campaign_id: campaign.campaign_id,
		                campaign_code: campaign.campaign_code,
		                campaign_name: campaign.campaign_name,
		                bonus_type: campaign.bonus_type,
		                stackable: campaign.stackable,
		                stack_group: campaign.stack_group,
		                priority: campaign.priority
		            })
		        ]
		    );
		
		    if (bonusResult.rowCount !== 1) {
		        throw new Error(
		            `Failed to award bonus campaign ${campaign.campaign_id}.`
		        );
		    }
		
		    const awardedBonus = bonusResult.rows[0];
		
		    awardedBonuses.push({
		        campaignId: Number(campaign.campaign_id),
		        campaignCode: campaign.campaign_code,
		        campaignName: campaign.campaign_name,
		        bonusType: campaign.bonus_type,
		        bonusId: Number(awardedBonus.bonus_id),
		        transactionId: Number(awardedBonus.transaction_id)
		    });
		}

        // ------------------------------------------------------------
		// 15. Read final wallet balances
		// ------------------------------------------------------------

        const balancesResult = await client.query(
            `
            SELECT
                user_id,
                telegram_id,
                name,
                main_wallet_id,
                main_balance,
                play_wallet_id,
                play_balance,
                total_balance
            FROM user_wallet_balances
            WHERE telegram_id = $1
            `,
            [parsedTelegramId]
        );

        if (balancesResult.rowCount !== 1) {
            throw new Error(
                "Could not verify final wallet balances."
            );
        }

        const balances = balancesResult.rows[0];

		// ------------------------------------------------------------
		// 16. Commit everything atomically
		// ------------------------------------------------------------

        await client.query("COMMIT");

        return {
            success: true,
            message: "Deposit approved successfully.",

            deposit: {
                id: deposit.id,
                reference: deposit.reference,
                amount: Number(deposit.amount),
                status: completedDepositResult.rows[0].status,
                ruleId: completedDepositResult.rows[0].rule_id,
                approvedAt:
                    completedDepositResult.rows[0].approved_at
            },

            transaction: {
                id: transactionId,
                type: transaction.type,
                status: transaction.status
            },

            rule: {
                id: rule.id,
                code: rule.code,
                name: rule.name,
                minimumAmount:
                    rule.minimum_amount !== null
                        ? Number(rule.minimum_amount)
                        : null,
                maximumAmount:
                    rule.maximum_amount !== null
                        ? Number(rule.maximum_amount)
                        : null
            },

            paymentAccount: {
                id: paymentAccount.id,
                paymentMethodId:
                    paymentAccount.payment_method_id,
                paymentMethodName:
                    paymentAccount.payment_method_name,
                balance:
                    Number(updatedPaymentAccount.balance)
            },

            wallet: {
                mainBalance:
                    Number(balances.main_balance),
                playBalance:
                    Number(balances.play_balance),
                totalBalance:
                    Number(balances.total_balance)
            },
			bonuses: {
					    count: awardedBonuses.length,
					    awarded: awardedBonuses
					}
        };
    } catch (error) {
        await safeRollback(client);

        if (error?.code === "23505") {
            if (
                String(error.constraint ?? "")
                    .includes("deposits_reference_unique_idx")
            ) {
                throw new Error(
                    `Receipt ${String(
                        receipt?.receiptNo ?? ""
                    ).trim()} has already been processed.`
                );
            }

            throw error;
        }

        if (!parseFeatureDisabled(error)) console.error("approveDeposit failed:", error);

        throw error;
    } finally {
        client.release();
    }
},

  // ============================================================
  // GAMES
  // ============================================================

    async createBingoGame(
    roomId,
    stakeId,
    selectedCards
  ) {
    const room = toPositiveInteger(
      roomId,
      "roomId"
    );

    if (
      stakeId === null ||
      stakeId === undefined ||
      String(stakeId).trim() === ""
    ) {
      throw new Error("stakeId is required.");
    }

    const stake = String(stakeId).trim();

    if (!Array.isArray(selectedCards)) {
      throw new Error(
        "selectedCards must be an array."
      );
    }

    if (selectedCards.length === 0) {
      throw new Error(
        "At least one selected card is required."
      );
    }

    /*
     * The PostgreSQL function is now responsible for:
     *
     * - validating the room
     * - validating the stake
     * - validating room/stake availability
     * - reading card_count from bingo_rooms
     * - reading max_cards_per_player from bingo_rooms
     * - reading commission_rule_id from bingo_rooms
     * - reading commission_rate from bingo_commission_rules
     * - reading stake amount from bingo_stakes
     * - reading Bingo game-system configuration
     * - generating the game code
     * - generating the internal idempotency key
     * - charging each accepted card
     * - creating participants
     * - creating participant cards
     * - calculating gross pot
     * - calculating commission
     * - calculating prize pool
     *
     * Node.js should NOT duplicate any of that logic.
     */

    const { rows } = await pool.query(
      `
      SELECT public.create_bingo_game_from_selections(
        $1::bigint,
        $2::varchar,
        $3::jsonb
      ) AS result
      `,
      [
        room,
        stake,
        JSON.stringify(selectedCards)
      ]
    );

    const result =
      rows[0]?.result;

    if (!result) {
      throw new Error(
        "Failed to create Bingo game."
      );
    }

    return result;
  },

  async getBingoGameByCode(
  gameCode
) {
  const code =
    String(gameCode || "")
      .trim()
      .toUpperCase();

  if (!code) {
    throw new Error(
      "gameCode is required."
    );
  }

  const { rows } =
    await pool.query(
      `
      SELECT *
      FROM bingo_games
      WHERE game_code = $1
      LIMIT 1
      `,
      [code]
    );

  return rows[0] || null;
},

  /**
   * One cartela of a player in a game (bingo_participant_cards) together with his participant row.
   */
  async getBingoParticipant(
  gameId,
  userId,
  cardId
) {
  const game = toPositiveInteger(gameId, "gameId");
  const user = toPositiveInteger(userId, "userId");
  const card = toPositiveInteger(cardId, "cardId");

  const { rows } =
    await pool.query(
      `
      SELECT
        bp.*,
        pc.id          AS participant_card_id,
        pc.card_id     AS card_id,
        pc.card_data   AS card_data,
        pc.transaction_id AS card_transaction_id,
        pc.is_disqualified AS card_disqualified,
        g.game_code,
        g.status AS game_status
      FROM bingo_participants bp
      JOIN bingo_participant_cards pc
        ON pc.participant_id = bp.id
      JOIN bingo_games g
        ON g.id = bp.game_id
      WHERE bp.game_id = $1
        AND bp.user_id = $2
        AND pc.card_id = $3
      LIMIT 1
      `,
      [game, user, card]
    );

  return rows[0] || null;
},

  /**
   * Every cartela a player has in a game (one row per cartela).
   */
  async getBingoUserParticipants(
  gameId,
  userId
) {
  const game = toPositiveInteger(gameId, "gameId");
  const user = toPositiveInteger(userId, "userId");

  const { rows } =
    await pool.query(
      `
      SELECT
        pc.id              AS id,
        bp.id              AS participant_id,
        bp.game_id,
        bp.user_id,
        pc.card_id,
        pc.card_data,
        pc.transaction_id,
        bp.amount_paid,
        bp.status,
        EXISTS (
          SELECT 1
          FROM bingo_winners w
          WHERE w.game_id = pc.game_id
            AND w.participant_id = pc.participant_id
            AND w.card_id = pc.card_id
        )                  AS is_winner,
        (bp.is_disqualified OR pc.is_disqualified) AS is_disqualified,
        bp.amount_won,
        bp.joined_at
      FROM bingo_participants bp
      JOIN bingo_participant_cards pc
        ON pc.participant_id = bp.id
      WHERE bp.game_id = $1
        AND bp.user_id = $2
      ORDER BY pc.card_id
      `,
      [game, user]
    );

  return rows;
},

  /**
   * Every cartela of the players who are still in a game (active and not disqualified).
   */
  async getActiveBingoParticipants(
  gameId
) {
  const game = toPositiveInteger(gameId, "gameId");

  const { rows } =
    await pool.query(
      `
      SELECT
        pc.id              AS id,
        bp.id              AS participant_id,
        bp.game_id,
        bp.user_id,
        pc.card_id,
        pc.card_data,
        pc.transaction_id,
        bp.amount_paid,
        bp.status,
        bp.is_disqualified,
        bp.amount_won,
        bp.joined_at
      FROM bingo_participants bp
      JOIN bingo_participant_cards pc
        ON pc.participant_id = bp.id
      WHERE bp.game_id = $1
        AND bp.status = 'active'
        AND bp.is_disqualified = FALSE
        AND pc.is_disqualified = FALSE
      ORDER BY pc.id
      `,
      [game]
    );

  return rows;
},

 

     async endBingoGame(
  gameId,
  winnerParticipantCardIds,
  calledNumbers
) {
  const game = toPositiveInteger(
    gameId,
    "gameId"
  );

  if (!Array.isArray(winnerParticipantCardIds)) {
    throw new Error(
      "winnerParticipantCardIds must be an array."
    );
  }

  if (winnerParticipantCardIds.length === 0) {
    throw new Error(
      "At least one winning card is required."
    );
  }

  const winnerIds =
    winnerParticipantCardIds.map((id) =>
      toPositiveInteger(
        id,
        "winnerParticipantCardId"
      )
    );

  if (!Array.isArray(calledNumbers)) {
    throw new Error(
      "calledNumbers must be an array."
    );
  }

  if (calledNumbers.length === 0) {
    throw new Error(
      "At least one called number is required."
    );
  }

  const numbersCalled =
    calledNumbers.map((number) =>
      toPositiveInteger(
        number,
        "calledNumber"
      )
    );

  const { rows } = await pool.query(
    `
    SELECT public.end_bingo_game(
      $1::integer,
      $2::integer[],
      $3::integer[]
    ) AS result
    `,
    [
      game,
      winnerIds,
      numbersCalled
    ]
  );

  return rows[0]?.result || null;
},

  /**
   * The game of a room that is still open (waiting / selection / playing), with its players and their cartelas.
   */
  async getActiveBingoGame(
  roomId
) {
  const { rows } = await pool.query(
    `
    SELECT
      g.*,

      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id',              bp.id,
              'user_id',         bp.user_id,
              'amount_paid',     bp.amount_paid,
              'status',          bp.status,
              'is_disqualified', bp.is_disqualified,
              'amount_won',      bp.amount_won,
              'joined_at',       bp.joined_at,
              'cards', COALESCE(
                (
                  SELECT json_agg(
                    json_build_object(
                      'id',              pc.id,
                      'card_id',         pc.card_id,
                      'card_data',       pc.card_data,
                      'transaction_id',  pc.transaction_id,
                      'is_disqualified', pc.is_disqualified
                    )
                    ORDER BY pc.id
                  )
                  FROM bingo_participant_cards pc
                  WHERE pc.participant_id = bp.id
                ),
                '[]'::json
              )
            )
            ORDER BY bp.id
          )
          FROM bingo_participants bp
          WHERE bp.game_id = g.id
        ),
        '[]'::json
      ) AS participants

    FROM bingo_games g

    WHERE g.room_id = $1
      AND g.status IN (
        'waiting',
        'selection',
        'playing'
      )

    ORDER BY g.created_at DESC

    LIMIT 1
    `,
    [roomId]
  );

  return rows[0] || null;
},



  // ============================================================
  // LEADERBOARD
  // ============================================================

  // Top winners for the in-game "Winners" screen.
  // period: 'today' (Ethiopia calendar day) | '7d' | '30d' | '1y'. Returns up to `limit` rows.
  async getTopWinners(period = "today", limit = 100) {
    const p = { today: "today", "7d": "7", "30d": "30", "1y": "365" }[period] || "today";
    const { rows } = await pool.query(
      `
      WITH bounds AS (
        SELECT CASE WHEN $1 = 'today'
                 THEN date_trunc('day', now() AT TIME ZONE 'Africa/Addis_Ababa') AT TIME ZONE 'Africa/Addis_Ababa'
                 ELSE now() - ($1::int * interval '1 day') END AS since
      )
      SELECT u.telegram_id, u.name,
             SUM(bp.amount_won)::numeric(18,2)        AS total,
             COUNT(DISTINCT bp.game_id)::int          AS wins,
             MAX(bp.amount_won)::numeric(18,2)        AS best
      FROM bingo_participants bp
      JOIN bingo_games g ON g.id = bp.game_id AND g.status = 'completed'
      JOIN users u ON u.id = bp.user_id
      CROSS JOIN bounds b
      WHERE bp.amount_won > 0
        AND bp.is_disqualified = FALSE
        AND u.is_blocked = FALSE
        AND COALESCE(g.ended_at, g.created_at) >= b.since
      GROUP BY u.id, u.telegram_id, u.name
      ORDER BY SUM(bp.amount_won) DESC, COUNT(DISTINCT bp.game_id) DESC, u.id
      LIMIT $2
      `,
      [p, Math.max(1, Math.min(200, Number(limit) || 100))]
    );
    return rows;
  },

  async getLeaderboard(
    limit = 10
  ) {

    const safeLimit =
      Math.min(
        Math.max(
          Number(limit) || 10,
          1
        ),
        100
      );

    // Built from the game tables: total won, games played, games won and win rate per player.
    const { rows } =
      await pool.query(
        `
        SELECT
          u.name,
          COUNT(DISTINCT bp.game_id) FILTER (WHERE bp.amount_won > 0)::int AS total_wins,
          COUNT(DISTINCT bp.game_id)::int                                  AS total_games,
          COALESCE(SUM(bp.amount_won), 0)::numeric                         AS total_winnings,
          COALESCE(
            ROUND(
              100.0
              * COUNT(DISTINCT bp.game_id) FILTER (WHERE bp.amount_won > 0)
              / NULLIF(COUNT(DISTINCT bp.game_id), 0),
              2
            ),
            0
          )::numeric                                                       AS win_rate
        FROM bingo_participants bp
        JOIN bingo_games g
          ON g.id = bp.game_id
         AND g.status = 'completed'
        JOIN users u
          ON u.id = bp.user_id
        WHERE u.is_active = TRUE
          AND u.is_blocked = FALSE
        GROUP BY u.id, u.name
        ORDER BY total_winnings DESC, total_wins DESC, u.id
        LIMIT $1
        `,
        [safeLimit]
      );

    return rows;
  },

	// Deposit limits shown to the user: the most specific ACTIVE row of deposit_rules for this payment account / method
	// (account rule first, then method rule, then a rule for everything). Returns { min, max } - null means "no limit".
	async getDepositLimits(paymentMethodId, paymentAccountId) {
	  try {
	    const { rows } = await pool.query(
	      `
	      SELECT minimum_amount, maximum_amount
	      FROM deposit_rules dr
	      WHERE dr.is_active = TRUE
	        AND (dr.starts_at IS NULL OR dr.starts_at <= NOW())
	        AND (dr.ends_at   IS NULL OR dr.ends_at   >= NOW())
	        AND (dr.payment_method_id  IS NULL OR dr.payment_method_id  = $1)
	        AND (dr.payment_account_id IS NULL OR dr.payment_account_id = $2)
	      ORDER BY
	        CASE WHEN dr.payment_account_id = $2 THEN 0 ELSE 1 END,
	        CASE WHEN dr.payment_method_id  = $1 THEN 0 ELSE 1 END,
	        dr.id DESC
	      LIMIT 1
	      `,
	      [paymentMethodId, paymentAccountId]
	    );
	    const r = rows[0];
	    return {
	      min: r && r.minimum_amount !== null ? Number(r.minimum_amount) : null,
	      max: r && r.maximum_amount !== null ? Number(r.maximum_amount) : null
	    };
	  } catch (err) {
	    console.error("Deposit limits error:", err.message);
	    return { min: null, max: null };
	  }
	},

	// ============================================================
	// RULE MANAGER (admin): deposit_rules, withdrawal_rules, transfer_rules
	// kind: "deposit" | "withdrawal" | "transfer". Only the columns listed here can be written.
	// ============================================================
	ruleKinds: {
	  deposit:    { table: "deposit_rules",    cols: ["name", "payment_method_id", "payment_account_id", "minimum_amount", "maximum_amount", "is_active"] },
	  withdrawal: { table: "withdrawal_rules", cols: ["name", "payment_method_id", "payment_account_id", "minimum_amount", "maximum_amount", "is_active"] },
	  transfer:   { table: "transfer_rules",   cols: ["wallet_type", "period", "minimum_transfer_amount", "maximum_transfer_amount", "maximum_transfer_count",
	                                              "maximum_period_amount", "minimum_remaining_balance", "priority", "description", "is_active"] }
	},

	// turns a database CHECK / FK error into a sentence for the admin
	ruleError(err) {
	  const c = String(err?.constraint || "");
	  const m = String(err?.message || "");
	  if (/amount_range/.test(c)) return "The minimum can not be bigger than the maximum.";
	  if (/positive_(minimum|maximum)|_maximum_check|_period_amount_check/.test(c)) return "Limits must be greater than zero.";
	  if (/minimum_check|remaining_balance_check/.test(c)) return "The value can not be negative.";
	  if (/date_range/.test(c)) return "The end date must be after the start date.";
	  if (err?.code === "23505") return "A rule with this code already exists.";
	  if (err?.code === "22003" || /out of range|numeric field overflow/i.test(m)) return "That number is too large.";
	  return null;
	},

	async listRules(kind) {
	  const k = this.ruleKinds[kind];
	  if (!k) throw new Error("bad rule kind");
	  const sql = kind === "transfer"
	    ? `SELECT * FROM transfer_rules ORDER BY is_active DESC, wallet_type, CASE period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 WHEN 'quarterly' THEN 4 ELSE 5 END, priority DESC, id`
	    : `SELECT r.*, pm.name AS method_name, pa.account_number, pa.account_name
	       FROM ${k.table} r
	       LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
	       LEFT JOIN payment_accounts pa ON pa.id = r.payment_account_id
	       ORDER BY r.is_active DESC, r.id DESC`;
	  const { rows } = await pool.query(sql);
	  return rows;
	},

	async getRule(kind, id) {
	  const k = this.ruleKinds[kind];
	  if (!k) throw new Error("bad rule kind");
	  const sql = kind === "transfer"
	    ? `SELECT * FROM transfer_rules WHERE id = $1`
	    : `SELECT r.*, pm.name AS method_name, pa.account_number, pa.account_name
	       FROM ${k.table} r
	       LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
	       LEFT JOIN payment_accounts pa ON pa.id = r.payment_account_id
	       WHERE r.id = $1`;
	  const { rows } = await pool.query(sql, [id]);
	  return rows[0] || null;
	},

	// creates an INACTIVE draft; the admin fills it in and activates it
	async createRuleDraft(kind, adminUserId, fields = {}) {
	  if (kind === "transfer") {
	    const { rows } = await pool.query(
	      `INSERT INTO transfer_rules (wallet_type, period, minimum_transfer_amount, is_active, description)
	       VALUES ($1, $2, 0, FALSE, $3) RETURNING *`,
	      [fields.wallet_type, fields.period, fields.description || null]
	    );
	    return rows[0];
	  }
	  const k = this.ruleKinds[kind];
	  if (!k) throw new Error("bad rule kind");
	  const code = (kind === "deposit" ? "dep_" : "wd_") + Date.now().toString(36);
	  const { rows } = await pool.query(
	    `INSERT INTO ${k.table} (code, name, is_active, created_by) VALUES ($1, $2, FALSE, $3) RETURNING *`,
	    [code, fields.name || "New rule", adminUserId]
	  );
	  return rows[0];
	},

	async updateRule(kind, id, patch) {
	  const k = this.ruleKinds[kind];
	  if (!k) throw new Error("bad rule kind");
	  const keys = Object.keys(patch).filter((c) => k.cols.includes(c));
	  if (!keys.length) throw new Error("nothing to update");
	  const sets = keys.map((c, i) => `${c} = $${i + 2}`).join(", ");
	  const { rows } = await pool.query(
	    `UPDATE ${k.table} SET ${sets} WHERE id = $1 RETURNING id`,
	    [id, ...keys.map((c) => patch[c])]
	  );
	  return rows.length > 0;
	},

	// removes the rule; when old records still point to it the rule is only switched off ("deactivated")
	async deleteRule(kind, id) {
	  const k = this.ruleKinds[kind];
	  if (!k) throw new Error("bad rule kind");
	  try {
	    const { rowCount } = await pool.query(`DELETE FROM ${k.table} WHERE id = $1`, [id]);
	    return rowCount ? "deleted" : "missing";
	  } catch (err) {
	    if (err.code === "23503") {
	      await pool.query(`UPDATE ${k.table} SET is_active = FALSE WHERE id = $1`, [id]);
	      return "deactivated";
	    }
	    throw err;
	  }
	},

	async getRuleCounts() {
	  const { rows } = await pool.query(
	    `SELECT (SELECT COUNT(*) FROM deposit_rules WHERE is_active)::int AS d,
	            (SELECT COUNT(*) FROM withdrawal_rules WHERE is_active)::int AS w,
	            (SELECT COUNT(*) FROM transfer_rules WHERE is_active)::int AS t`
	  );
	  return rows[0];
	},

	async listPaymentMethodsForRules() {
	  const { rows } = await pool.query(`SELECT id, name, emoji FROM payment_methods WHERE is_active = TRUE ORDER BY id`);
	  return rows;
	},

	async listPaymentAccountsForRules(methodId) {
	  const { rows } = await pool.query(
	    `SELECT id, account_number, account_name FROM payment_accounts
	     WHERE payment_method_id = $1 AND is_removed = FALSE ORDER BY id`, [methodId]);
	  return rows;
	},

	// Sign-up bonus (signup_bonus.sql). Returns { awarded, amount } - never throws, so a bonus problem can not break registration.
	async awardSignupBonus(userId) {
	  try {
	    const { rows } = await pool.query(
	      "SELECT awarded, bonus_amount FROM award_signup_bonus($1::integer)",
	      [userId]
	    );
	    const r = rows[0];
	    return r && r.awarded === true ? { awarded: true, amount: r.bonus_amount } : { awarded: false, amount: 0 };
	  } catch (err) {
	    console.error("Sign-up bonus error:", err.message);
	    return { awarded: false, amount: 0 };
	  }
	},

	async getUserWalletBalances(telegramId) {
    const { rows }  = await pool.query(
        `
        SELECT *
        FROM get_user_wallet_balances($1::bigint)
        `,
        [telegramId]
    );

      return rows[0] || null;
},

  // ============================================================
  // GAME-SERVER HELPERS (read-only) - added for the Node game server
  // ============================================================

  /**
   * Account flags the game server needs (admin / blocked / inactive).
   * Reads only columns that exist in users, so it works with the current schema
   * (getAdminByTelegramId / getUserByTelegramId also read * columns).
   *
   * @param {number|string} telegramId
   * @returns {Promise<{id:number,is_admin:boolean,admin_role:string|null,is_active:boolean,is_blocked:boolean}|null>}
   */
  /**
   * Account restrictions of these Telegram ids, one query for all of them.
   * blocked  = is_blocked  -> no access at all
   * inactive = is_active = false (and not blocked) -> may watch, cannot play
   * @param {Array<string|number>} telegramIds
   * @returns {Promise<{blocked:string[], inactive:string[]}>}
   */
  async getAccountRestrictions(telegramIds) {
    const ids = (telegramIds || []).map(String).filter((x) => /^\d+$/.test(x));
    if (!ids.length) return { blocked: [], inactive: [] };
    const { rows } = await pool.query(
      `
      SELECT telegram_id::text AS telegram_id, is_blocked, is_active
      FROM users
      WHERE telegram_id = ANY($1::bigint[])
        AND (is_blocked = TRUE OR is_active = FALSE)
      `,
      [ids]
    );
    return {
      blocked: rows.filter((r) => r.is_blocked === true).map((r) => r.telegram_id),
      inactive: rows.filter((r) => r.is_blocked !== true && r.is_active === false).map((r) => r.telegram_id),
    };
  },

  /**
   * Which of these Telegram ids belong to a blocked or deactivated account (one query for all of them).
   * @param {Array<string|number>} telegramIds
   * @returns {Promise<string[]>} the blocked / inactive ids, as strings
   */
  async getBlockedTelegramIds(telegramIds) {
    const ids = (telegramIds || []).map(String).filter((x) => /^\d+$/.test(x));
    if (!ids.length) return [];
    const { rows } = await pool.query(
      `
      SELECT telegram_id::text AS telegram_id
      FROM users
      WHERE telegram_id = ANY($1::bigint[])
        AND (is_blocked = TRUE OR is_active = FALSE)
      `,
      [ids]
    );
    return rows.map((r) => r.telegram_id);
  },

  async getBingoUserFlags(telegramId) {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        is_admin,
        admin_role,
        is_active,
        is_blocked
      FROM users
      WHERE telegram_id = $1::bigint
      LIMIT 1
      `,
      [telegramId]
    );

    return rows[0] || null;
  },

  /**
   * Database ids of the cartelas of a game.
   * end_bingo_game() expects THESE ids (bingo_participant_cards.id), not the
   * cartela numbers (1-400), so the game server loads them once after the game
   * is created.
   *
   * @param {number} gameId
   * @returns {Promise<Array<{participant_card_id:number,user_id:number,card_id:number}>>}
   */
  async getBingoGameCardIds(gameId) {
    const game = toPositiveInteger(gameId, "gameId");

    const mapRows = (rows) =>
      rows.map((r) => ({
        participant_card_id: Number(r.participant_card_id),
        user_id: Number(r.user_id),
        card_id: Number(r.card_id),
      }));

    const { rows } = await pool.query(
      `
      SELECT
        pc.id::bigint        AS participant_card_id,
        bp.user_id::integer  AS user_id,
        pc.card_id::integer  AS card_id
      FROM bingo_participant_cards pc
      JOIN bingo_participants bp
        ON bp.id = pc.participant_id
      WHERE pc.game_id = $1
      ORDER BY pc.id
      `,
      [game]
    );

    return mapRows(rows);
  },

  /**
   * Store the numbers drawn in a game, in the order they were called (bingo_games.called_numbers).
   * This is the audit trail needed to settle a dispute ("number X was never called").
   *
   * @param {number} gameId
   * @param {number[]} numbers
   */
  async saveBingoCalledNumbers(gameId, numbers) {
    const game = toPositiveInteger(gameId, "gameId");

    const list = (Array.isArray(numbers) ? numbers : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 75);

    await pool.query(
      `
      UPDATE public.bingo_games
      SET called_numbers = $2::integer[]
      WHERE id = $1::integer
      `,
      [game, list]
    );
  },

  /**
   * Games that were created but never finished (status waiting / selection).
   * While one is open, no new game can be created for the same room + stake.
   *
   * @param {number|null} roomId   optional
   * @param {string|null} stakeId  optional database stake id (e.g. "S5")
   * @returns {Promise<Array<{id:number,game_code:string,room_id:number,stake_id:string,
   *   status:string,age_seconds:number,winners:number}>>}
   */
  async getUnfinishedBingoGames(roomId = null, stakeId = null) {
    const { rows } = await pool.query(
      `
      SELECT
        g.id::integer     AS id,
        g.game_code       AS game_code,
        g.room_id::bigint AS room_id,
        g.stake_id        AS stake_id,
        g.status          AS status,
        EXTRACT(EPOCH FROM (NOW() - g.created_at))::integer AS age_seconds,
        (
          SELECT COUNT(*)
          FROM public.bingo_winners w
          WHERE w.game_id = g.id
        )::integer        AS winners
      FROM public.bingo_games g
      WHERE g.status IN ('waiting', 'selection')
        AND ($1::bigint  IS NULL OR g.room_id  = $1::bigint)
        AND ($2::varchar IS NULL OR g.stake_id = $2::varchar)
      ORDER BY g.created_at
      `,
      [roomId, stakeId]
    );

    return rows.map((r) => ({
      id: Number(r.id),
      game_code: r.game_code,
      room_id: Number(r.room_id),
      stake_id: r.stake_id,
      status: r.status,
      age_seconds: Number(r.age_seconds) || 0,
      winners: Number(r.winners) || 0,
    }));
  },

  /**
   * Store the fairness commitment (SHA-256 of salt + call order), the salt and the call order of a game.
   * Write-once (a database trigger refuses any later change). The order and salt are only shown publicly after the game is over.
   * @returns {Promise<boolean>} true when saved
   */
  async saveBingoFairness(gameId, commitment, order, salt) {
    const game = toPositiveInteger(gameId, "gameId");
    if (!/^[0-9a-f]{64}$/.test(String(commitment))) throw new Error("bad commitment");
    if (!Array.isArray(order) || order.length !== 75) throw new Error("bad order");
    const { rowCount } = await pool.query(
      `UPDATE public.bingo_games
          SET fairness_commitment = $2, fairness_salt = $3, fairness_order = $4::integer[]
        WHERE id = $1::integer AND fairness_commitment IS NULL`,
      [game, String(commitment), String(salt), order.map(Number)]
    );
    return rowCount > 0;
  },

  /** Public data of one game for the /verify page (order + salt only after the game is over). */
  async getBingoFairness(gameCode) {
    const { rows } = await pool.query(
      `SELECT * FROM public.get_bingo_fairness($1::text)`,
      [String(gameCode || "").slice(0, 40)]
    );
    return rows[0] || null;
  },

  /**
   * Record the moment the numbers start being called (bingo_games.started_at).
   * Only started_at is set: the status stays 'selection' until the game is settled, because the unique index
   * uq_bingo_games_active_room_stake and the stuck-game recovery rely on it.
   * @param {number} gameId
   * @returns {Promise<boolean>} true when the time was recorded
   */
  async markBingoGameStarted(gameId) {
    const game = toPositiveInteger(gameId, "gameId");
    const { rowCount } = await pool.query(
      `UPDATE public.bingo_games
          SET started_at = NOW()
        WHERE id = $1::integer
          AND started_at IS NULL
          AND status IN ('waiting', 'selection')`,
      [game]
    );
    return rowCount > 0;
  },

  /**
   * Cancel an unfinished game and refund every player (see cancel_bingo_game.sql).
   *
   * @param {number} gameId
   * @param {string} reason
   * @returns {Promise<object|null>}
   */
  async cancelBingoGame(gameId, reason = "game_cancelled") {
    const game = toPositiveInteger(gameId, "gameId");

    const { rows } = await pool.query(
      `
      SELECT public.cancel_bingo_game(
        $1::integer,
        $2::text
      ) AS result
      `,
      [game, String(reason || "game_cancelled")]
    );

    return rows[0]?.result || null;
  },

  /**
   * Bonus wallet balance vs. the bonus awards that can actually be spent, per user.
   * place_stake() charges the Bonus wallet first and then requires every cent of it to be
   * covered by an ACTIVE, unexpired row in user_bonuses; otherwise it raises
   * "Bonus consumption mismatch" and the whole game cannot be created.
   *
   * @param {number[]} userIds
   * @returns {Promise<Array<{user_id:number,bonus_balance:number,usable:number}>>}
   */
  async getBingoBonusStatus(userIds) {
    const ids = (Array.isArray(userIds) ? userIds : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (ids.length === 0) return [];

    const { rows } = await pool.query(
      `
      SELECT
        u.id AS user_id,
        COALESCE(wb.balance, 0)::numeric AS bonus_balance,
        COALESCE(
          (
            SELECT SUM(ub.remaining_amount)
            FROM public.user_bonuses ub
            WHERE ub.user_id = u.id
              AND ub.status = 'active'
              AND ub.remaining_amount > 0
              AND (ub.expires_at IS NULL OR ub.expires_at >= NOW())
          ),
          0
        )::numeric AS usable
      FROM public.users u
      JOIN public.wallets w
        ON w.user_id = u.id
       AND w.wallet_type = 'bonus'
      LEFT JOIN public.wallet_balances wb
        ON wb.wallet_id = w.id
      WHERE u.id = ANY($1::int[])
      `,
      [ids]
    );

    return rows.map((r) => ({
      user_id: Number(r.user_id),
      bonus_balance: Number(r.bonus_balance) || 0,
      usable: Number(r.usable) || 0,
    }));
  },

  /**
   * The wallets the active stake funding policy may charge, in charging order,
   * e.g. ["bonus", "play", "main"]. place_stake() only counts wallets that are in
   * this list, so the game server uses it to decide whether a player can afford a cartela.
   *
   * @returns {Promise<string[]>}
   */
  /**
   * Takes unusable bonus money (completed / expired awards) out of the Bonus wallet.
   * Needs public.expire_bonuses() from forfeit_bonus.sql.
   * @returns {Promise<{forfeited_awards:number,forfeited_total:number,errors:number}>}
   */
  async expireBonuses(limit = 200) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 200));
    const { rows } = await pool.query("SELECT public.expire_bonuses($1::integer) AS result", [n]);
    return rows[0].result;
  },

  async getBingoFundingWallets() {
    const { rows } = await pool.query(
      `
      SELECT w.wallet_type
      FROM public.stake_funding_policy_wallets w
      WHERE w.is_active = TRUE
        AND w.policy_id = (
          SELECT p.id
          FROM public.get_stake_funding_policy(
            (
              SELECT gs.id
              FROM public.game_systems gs
              WHERE gs.code = 'bingo'
                AND gs.status = 'active'
              LIMIT 1
            )
          ) AS p
        )
      ORDER BY w.funding_order
      `
    );

    return rows.map((r) => String(r.wallet_type));
  },

  /**
   * Profile counters, read straight from the game tables. The profile page uses
   * getBingoUserDashboard() first and falls back to these numbers for anything
   * the dashboard does not return.
   *
   * @param {number} userId
   * @returns {Promise<{games:number,wins:number,earning:number,
   *   by_stake:Array<{stake:number,wins:number,win_amount:number}>}>}
   */
  async getBingoProfileStats(userId) {
    const id = toPositiveInteger(userId, "userId");

    const [played, won, byStake, playedByStake] = await Promise.all([
      pool.query(
        `
        SELECT COUNT(DISTINCT bp.game_id)::int AS games
        FROM bingo_participants bp
        JOIN bingo_games g
          ON g.id = bp.game_id
        WHERE bp.user_id = $1
          AND g.status = 'completed'
        `,
        [id]
      ),

      pool.query(
        `
        SELECT
          COUNT(DISTINCT game_id)::int          AS wins,
          COALESCE(SUM(payout), 0)::numeric     AS earning
        FROM bingo_winners
        WHERE user_id = $1
        `,
        [id]
      ),

      pool.query(
        `
        SELECT
          g.stake_amount::numeric                AS stake,
          COUNT(DISTINCT w.game_id)::int         AS wins,
          COALESCE(SUM(w.payout), 0)::numeric    AS win_amount
        FROM bingo_winners w
        JOIN bingo_games g
          ON g.id = w.game_id
        WHERE w.user_id = $1
        GROUP BY g.stake_amount
        ORDER BY g.stake_amount
        `,
        [id]
      ),

      pool.query(
        `
        SELECT g.stake_amount::numeric AS stake, COUNT(DISTINCT bp.game_id)::int AS played
        FROM bingo_participants bp
        JOIN bingo_games g ON g.id = bp.game_id
        WHERE bp.user_id = $1
          AND g.status <> 'cancelled'
        GROUP BY g.stake_amount
        `,
        [id]
      ),
    ]);

    const playedMap = new Map(playedByStake.rows.map((r) => [Number(r.stake), Number(r.played) || 0]));
    const byStakeMap = new Map(byStake.rows.map((r) => [Number(r.stake), r]));
    for (const st of playedMap.keys()) {
      if (!byStakeMap.has(st)) byStakeMap.set(st, { stake: st, wins: 0, win_amount: 0 });
    }

    return {
      games: Number(played.rows[0]?.games) || 0,
      wins: Number(won.rows[0]?.wins) || 0,
      earning: Number(won.rows[0]?.earning) || 0,
      by_stake: [...byStakeMap.values()]
        .map((r) => ({
          stake: Number(r.stake) || 0,
          wins: Number(r.wins) || 0,
          played: playedMap.get(Number(r.stake)) || 0,
          win_amount: Number(r.win_amount) || 0,
        }))
        .sort((a, b) => a.stake - b.stake),
    };
  },

};
