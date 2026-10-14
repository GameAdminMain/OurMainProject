/**
 * RECONCILIATION - checks that the money records agree, once a night (and on demand from the dashboard).
 *
 * Checks (severity):  critical = money does not add up, warn = something is stuck / needs a look, info = numbers.
 *   WALLET_MISMATCH      wallet balance <> sum of its ledger entries
 *   NEGATIVE_BALANCE     a wallet below zero
 *   DEPOSIT_LEDGER       completed deposit without a matching ledger transaction
 *   WITHDRAWAL_LEDGER    withdrawal whose reserved money does not match (open/paid: -amount; rejected/cancelled/failed: refunded)
 *   GAME_PAYOUT          settled game whose win transactions differ from bingo_winners, or pays more than the prize pool
 *   DEPOSIT_OLD          deposit still pending/processing for hours
 *   WITHDRAWAL_STALE     withdrawal waiting / claimed too long
 *   GAME_STUCK           game not settled after 20 minutes
 *   CLIENT_ERRORS        many page crashes in the last 24 h
 *   PROVIDER_*           (only when statement lines were imported) deposits / withdrawals against the payment provider
 *
 * Used by data_server.js (nightly at RECON_HOUR_UTC, default 0 = 03:00 Ethiopia; "Run now" in the dashboard).
 * Alerts go to Telegram: ALERT_CHAT_IDS (comma separated) or, when empty, every MAIN admin of the bot. Needs BOT_TOKEN.
 */
const https = require("https");

const SAMPLE = 10;

async function q(db, text, params) { return (await db.rawQuery(text, params)).rows; }

async function check(db, findings, { code, severity, title, countSql, sampleSql, params = [] }) {
  const c = Number((await q(db, countSql, params))[0]?.n || 0);
  if (!c) return 0;
  const sample = await q(db, sampleSql + ` LIMIT ${SAMPLE}`, params);
  findings.push({ code, severity, title, count: c, sample });
  return c;
}

async function runReconciliation(db, opts = {}) {
  const findings = [];
  const summary = {};
  const t0 = Date.now();

  // 1. wallets vs ledger
  const walletBase = `
    FROM wallets w
    LEFT JOIN wallet_balances b ON b.wallet_id = w.id
    LEFT JOIN (SELECT wallet_id, SUM(amount) s FROM ledger_entries GROUP BY 1) l ON l.wallet_id = w.id
    WHERE COALESCE(b.balance,0) <> COALESCE(l.s,0)`;
  await check(db, findings, {
    code: "WALLET_MISMATCH", severity: "critical", title: "Wallet balance differs from the sum of its ledger entries",
    countSql: `SELECT COUNT(*) n ${walletBase}`,
    sampleSql: `SELECT w.id wallet_id, w.user_id, w.wallet_type, COALESCE(b.balance,0) balance, COALESCE(l.s,0) ledger, COALESCE(b.balance,0)-COALESCE(l.s,0) diff ${walletBase} ORDER BY ABS(COALESCE(b.balance,0)-COALESCE(l.s,0)) DESC`,
  });
  await check(db, findings, {
    code: "NEGATIVE_BALANCE", severity: "critical", title: "Wallet with a negative balance",
    countSql: `SELECT COUNT(*) n FROM wallet_balances WHERE balance < 0`,
    sampleSql: `SELECT wallet_id, balance FROM wallet_balances WHERE balance < 0`,
  });

  // 2. deposits
  await check(db, findings, {
    code: "DEPOSIT_LEDGER", severity: "critical", title: "Completed deposit without a matching ledger transaction",
    countSql: `SELECT COUNT(*) n FROM deposits d
               LEFT JOIN financial_transactions t ON t.id = d.transaction_id
               LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM ledger_entries GROUP BY 1) l ON l.transaction_id = d.transaction_id
               WHERE d.status = 'completed' AND (t.id IS NULL OR t.type <> 'deposit' OR ABS(COALESCE(l.s,0) - COALESCE(d.amount,0)) > 0.005)`,
    sampleSql: `SELECT d.id, d.user_id, d.reference, d.amount, t.type tx_type, COALESCE(l.s,0) ledger FROM deposits d
               LEFT JOIN financial_transactions t ON t.id = d.transaction_id
               LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM ledger_entries GROUP BY 1) l ON l.transaction_id = d.transaction_id
               WHERE d.status = 'completed' AND (t.id IS NULL OR t.type <> 'deposit' OR ABS(COALESCE(l.s,0) - COALESCE(d.amount,0)) > 0.005) ORDER BY d.id DESC`,
  });
  await check(db, findings, {
    code: "DEPOSIT_OLD", severity: "warn", title: "Deposit still pending for more than 2 hours",
    countSql: `SELECT COUNT(*) n FROM deposits WHERE status IN ('pending','processing') AND created_at < now() - interval '2 hours'`,
    sampleSql: `SELECT id, user_id, amount, reference, status, created_at FROM deposits WHERE status IN ('pending','processing') AND created_at < now() - interval '2 hours' ORDER BY created_at`,
  });

  // 3. withdrawals: the reserved money must be gone (open / paid) or given back (rejected / cancelled / failed)
  const wdBase = `
    FROM withdrawals w
    LEFT JOIN (SELECT transaction_id, SUM(amount) s FROM ledger_entries GROUP BY 1) o ON o.transaction_id = w.transaction_id
    LEFT JOIN (SELECT ft.reversed_transaction_id rid, SUM(le.amount) s FROM financial_transactions ft JOIN ledger_entries le ON le.transaction_id = ft.id
               WHERE ft.type = 'refund' AND ft.reversed_transaction_id IS NOT NULL GROUP BY 1) r ON r.rid = w.transaction_id
    WHERE (w.status IN ('pending','processing','approved') AND (w.transaction_id IS NULL OR ABS(COALESCE(o.s,0) + w.amount) > 0.005 OR COALESCE(r.s,0) <> 0))
       OR (w.status IN ('rejected','cancelled','failed') AND w.transaction_id IS NOT NULL AND ABS(COALESCE(o.s,0) + COALESCE(r.s,0)) > 0.005)`;
  await check(db, findings, {
    code: "WITHDRAWAL_LEDGER", severity: "critical", title: "Withdrawal money not reserved / refunded correctly",
    countSql: `SELECT COUNT(*) n ${wdBase}`,
    sampleSql: `SELECT w.id, w.user_id, w.status, w.amount, COALESCE(o.s,0) reserved, COALESCE(r.s,0) refunded ${wdBase} ORDER BY w.id DESC`,
  });
  await check(db, findings, {
    code: "WITHDRAWAL_STALE", severity: "warn", title: "Withdrawal waiting too long (pending > 6 h or claimed > 30 min)",
    countSql: `SELECT COUNT(*) n FROM withdrawals WHERE (status = 'pending' AND created_at < now() - interval '6 hours') OR (status = 'processing' AND COALESCE(claimed_at, created_at) < now() - interval '30 minutes')`,
    sampleSql: `SELECT id, user_id, amount, status, needs_review, created_at FROM withdrawals WHERE (status = 'pending' AND created_at < now() - interval '6 hours') OR (status = 'processing' AND COALESCE(claimed_at, created_at) < now() - interval '30 minutes') ORDER BY created_at`,
  });

  // 4. games
  const gameBase = `
    FROM bingo_games g
    LEFT JOIN (SELECT game_id, SUM(payout) p FROM bingo_winners GROUP BY 1) bw ON bw.game_id = g.id
    LEFT JOIN (SELECT t.source_id, SUM(le.amount) w FROM financial_transactions t JOIN ledger_entries le ON le.transaction_id = t.id
               WHERE t.type IN ('win','adjustment') AND t.source_type = 'bingo_game' GROUP BY 1) wl ON wl.source_id = g.id::text
    WHERE g.status = 'completed' AND (ABS(COALESCE(bw.p,0) - COALESCE(wl.w,0)) > 0.005 OR COALESCE(bw.p,0) > g.prize_pool + 0.005)`;
  await check(db, findings, {
    code: "GAME_PAYOUT", severity: "critical", title: "Settled game: payouts do not match the ledger or exceed the prize pool",
    countSql: `SELECT COUNT(*) n ${gameBase}`,
    sampleSql: `SELECT g.id, g.game_code, g.prize_pool, COALESCE(bw.p,0) winners_payout, COALESCE(wl.w,0) ledger_wins ${gameBase} ORDER BY g.id DESC`,
  });
  await check(db, findings, {
    code: "GAME_STUCK", severity: "warn", title: "Game not settled after 20 minutes",
    countSql: `SELECT COUNT(*) n FROM bingo_games WHERE status IN ('waiting','selection','playing') AND created_at < now() - interval '20 minutes'`,
    sampleSql: `SELECT id, game_code, status, stake_amount, card_count, created_at FROM bingo_games WHERE status IN ('waiting','selection','playing') AND created_at < now() - interval '20 minutes' ORDER BY created_at`,
  });

  // 5. page crashes
  try {
    const n = Number((await q(db, `SELECT COUNT(*) n FROM client_errors WHERE at > now() - interval '24 hours'`))[0].n);
    summary.clientErrors24h = n;
    if (n >= 20) findings.push({ code: "CLIENT_ERRORS", severity: "warn", title: "Many page crashes in the last 24 hours", count: n,
      sample: await q(db, `SELECT message, COUNT(*) n FROM client_errors WHERE at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT ${SAMPLE}`) });
  } catch (e) { /* table not installed yet */ }

  // 6. payment provider statement (only when lines were imported); checks the period the statement covers
  try {
    const per = (await q(db, `SELECT MIN(occurred_at) a, MAX(occurred_at) b, COUNT(*) n FROM provider_statement_lines`))[0];
    summary.providerLines = Number(per.n);
    if (Number(per.n) > 0) {
      const a = per.a, b = per.b;
      summary.providerPeriod = [a, b];
      await check(db, findings, {
        code: "PROVIDER_DEPOSIT_MISSING", severity: "critical", title: "Deposit credited to a player but NOT in the provider statement (or amount differs)",
        countSql: `SELECT COUNT(*) n FROM deposits d WHERE d.status = 'completed' AND d.created_at BETWEEN $1 AND $2
                   AND NOT EXISTS (SELECT 1 FROM provider_statement_lines p WHERE p.direction = 'in' AND p.reference = d.reference AND ABS(p.amount - d.amount) < 0.005)`,
        sampleSql: `SELECT d.id, d.user_id, d.reference, d.amount, d.created_at FROM deposits d WHERE d.status = 'completed' AND d.created_at BETWEEN $1 AND $2
                   AND NOT EXISTS (SELECT 1 FROM provider_statement_lines p WHERE p.direction = 'in' AND p.reference = d.reference AND ABS(p.amount - d.amount) < 0.005) ORDER BY d.created_at DESC`,
        params: [a, b],
      });
      await check(db, findings, {
        code: "PROVIDER_DEPOSIT_UNCREDITED", severity: "warn", title: "Money received by the provider but no completed deposit",
        countSql: `SELECT COUNT(*) n FROM provider_statement_lines p WHERE p.direction = 'in'
                   AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.status = 'completed' AND d.reference = p.reference AND ABS(p.amount - d.amount) < 0.005)`,
        sampleSql: `SELECT p.provider, p.reference, p.amount, p.counterparty, p.occurred_at FROM provider_statement_lines p WHERE p.direction = 'in'
                   AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.status = 'completed' AND d.reference = p.reference AND ABS(p.amount - d.amount) < 0.005) ORDER BY p.occurred_at DESC`,
      });
      await check(db, findings, {
        code: "PROVIDER_WITHDRAWAL_MISSING", severity: "warn", title: "Withdrawal marked paid but no matching payment in the provider statement",
        countSql: `SELECT COUNT(*) n FROM withdrawals w WHERE w.status = 'approved' AND COALESCE(w.processed_at, w.updated_at) BETWEEN $1 AND $2
                   AND NOT EXISTS (SELECT 1 FROM provider_statement_lines p WHERE p.direction = 'out' AND ABS(p.amount - w.amount) < 0.005
                       AND regexp_replace(COALESCE(p.counterparty,''),'\\D','','g') = regexp_replace(COALESCE(w.account_number,''),'\\D','','g')
                       AND p.occurred_at BETWEEN COALESCE(w.processed_at, w.updated_at) - interval '2 days' AND COALESCE(w.processed_at, w.updated_at) + interval '2 days')`,
        sampleSql: `SELECT w.id, w.user_id, w.amount, w.account_number, COALESCE(w.processed_at, w.updated_at) paid_at FROM withdrawals w WHERE w.status = 'approved' AND COALESCE(w.processed_at, w.updated_at) BETWEEN $1 AND $2
                   AND NOT EXISTS (SELECT 1 FROM provider_statement_lines p WHERE p.direction = 'out' AND ABS(p.amount - w.amount) < 0.005
                       AND regexp_replace(COALESCE(p.counterparty,''),'\\D','','g') = regexp_replace(COALESCE(w.account_number,''),'\\D','','g')
                       AND p.occurred_at BETWEEN COALESCE(w.processed_at, w.updated_at) - interval '2 days' AND COALESCE(w.processed_at, w.updated_at) + interval '2 days') ORDER BY w.id DESC`,
        params: [a, b],
      });
      await check(db, findings, {
        code: "PROVIDER_PAYMENT_UNKNOWN", severity: "critical", title: "Money paid out according to the provider but no approved withdrawal",
        countSql: `SELECT COUNT(*) n FROM provider_statement_lines p WHERE p.direction = 'out'
                   AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.status = 'approved' AND ABS(p.amount - w.amount) < 0.005
                       AND regexp_replace(COALESCE(p.counterparty,''),'\\D','','g') = regexp_replace(COALESCE(w.account_number,''),'\\D','','g')
                       AND p.occurred_at BETWEEN COALESCE(w.processed_at, w.updated_at) - interval '2 days' AND COALESCE(w.processed_at, w.updated_at) + interval '2 days')`,
        sampleSql: `SELECT p.provider, p.reference, p.amount, p.counterparty, p.occurred_at FROM provider_statement_lines p WHERE p.direction = 'out'
                   AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.status = 'approved' AND ABS(p.amount - w.amount) < 0.005
                       AND regexp_replace(COALESCE(p.counterparty,''),'\\D','','g') = regexp_replace(COALESCE(w.account_number,''),'\\D','','g')
                       AND p.occurred_at BETWEEN COALESCE(w.processed_at, w.updated_at) - interval '2 days' AND COALESCE(w.processed_at, w.updated_at) + interval '2 days') ORDER BY p.occurred_at DESC`,
      });
    }
  } catch (e) { findings.push({ code: "PROVIDER_CHECK_FAILED", severity: "warn", title: "Provider comparison could not run: " + e.message, count: 1, sample: [] }); }

  // numbers for the report
  const nums = (await q(db, `
    SELECT
      (SELECT COALESCE(SUM(balance),0) FROM wallet_balances)                                          AS liabilities,
      (SELECT COALESCE(SUM(amount),0) FROM deposits WHERE status = 'completed')                       AS deposits_total,
      (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status = 'approved')                     AS withdrawals_paid,
      (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status IN ('pending','processing'))      AS withdrawals_open,
      (SELECT COALESCE(SUM(commission_amount),0) FROM bingo_games WHERE status = 'completed')         AS commission_total`))[0];
  Object.assign(summary, Object.fromEntries(Object.entries(nums).map(([k, v]) => [k, Number(v)])));
  summary.ms = Date.now() - t0;

  const critical = findings.filter(f => f.severity === "critical").length;
  const warnings = findings.filter(f => f.severity === "warn").length;
  const result = { ok: critical === 0, critical, warnings, summary, findings };
  if (opts.save !== false) {
    const r = await q(db, `INSERT INTO reconciliation_runs (ok, critical, warnings, summary, findings) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id, ran_at`,
      [result.ok, critical, warnings, JSON.stringify(summary), JSON.stringify(findings)]);
    result.id = r[0].id; result.ran_at = r[0].ran_at;
  }
  return result;
}

// ─── alerts (Telegram) ───
function tgSend(token, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
    const req = https.request({ hostname: "api.telegram.org", path: `/bot${token}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 10000 }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false)); req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function alertText(result, label) {
  const ic = (s) => (s === "critical" ? "🔴" : s === "warn" ? "🟠" : "ℹ️");
  const lines = [`${result.ok ? (result.warnings ? "🟠" : "✅") : "🚨"} <b>${esc(label || "Reconciliation")}</b>`,
    `Critical: <b>${result.critical}</b> · Warnings: <b>${result.warnings}</b>`];
  for (const f of result.findings.slice(0, 12)) lines.push(`${ic(f.severity)} ${esc(f.title)} — <b>${f.count}</b>`);
  const s = result.summary;
  lines.push(`\nWallets total ${Number(s.liabilities).toFixed(2)} · deposits ${Number(s.deposits_total).toFixed(2)} · paid out ${Number(s.withdrawals_paid).toFixed(2)} ETB`);
  lines.push("Details: /dashboard in the bot.");
  return lines.join("\n");
}

async function sendAlert(db, result, label) {
  const token = process.env.BOT_TOKEN;
  if (!token) return { sent: 0, reason: "BOT_TOKEN not set" };
  let ids = String(process.env.ALERT_CHAT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length) {
    ids = (await q(db, `SELECT telegram_id FROM users WHERE is_admin = TRUE AND admin_role = 'main' AND is_active = TRUE AND is_blocked = FALSE`)).map((r) => String(r.telegram_id));
  }
  let sent = 0;
  for (const id of ids) if (await tgSend(token, id, alertText(result, label))) sent++;
  return { sent, of: ids.length };
}

// Nightly scheduler: once per day at RECON_HOUR_UTC; the database lock makes sure only one server instance runs it.
function startSchedule(db) {
  const hour = Number.isFinite(Number(process.env.RECON_HOUR_UTC)) && process.env.RECON_HOUR_UTC !== "" ? Number(process.env.RECON_HOUR_UTC) : 0;
  const sendOk = process.env.RECON_SEND_OK === "1";
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const now = new Date();
    if (now.getUTCHours() !== hour) return;
    busy = true;
    try {
      const last = (await q(db, `SELECT ran_at FROM reconciliation_runs ORDER BY ran_at DESC LIMIT 1`))[0];
      if (last && Date.now() - new Date(last.ran_at).getTime() < 20 * 3600 * 1000) return;
      const got = (await q(db, `SELECT pg_try_advisory_lock(7770001) ok`))[0].ok;
      if (!got) return;
      try {
        const res = await runReconciliation(db);
        console.log(`🧾 Reconciliation: ${res.ok ? "OK" : "PROBLEMS"} critical=${res.critical} warnings=${res.warnings} (${res.summary.ms} ms)`);
        if (!res.ok || res.warnings || sendOk) console.log("alert:", JSON.stringify(await sendAlert(db, res, "Nightly reconciliation")));
      } finally { await q(db, `SELECT pg_advisory_unlock(7770001)`).catch(() => {}); }
    } catch (e) { console.error("reconciliation failed:", e.message, /reconciliation_runs|relation/.test(e.message) ? "- run safety_dashboard.sql" : ""); }
    finally { busy = false; }
  };
  const t = setInterval(tick, 60 * 1000); t.unref && t.unref();
  console.log(`🧾 Nightly reconciliation scheduled at ${String(hour).padStart(2, "0")}:00 UTC`);
}

module.exports = { runReconciliation, sendAlert, startSchedule, alertText };
