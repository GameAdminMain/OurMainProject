/**
 * bot.js — game Telegram Bot (name/version come from BOT_NAME / BOT_VERSION)
 *
 * Install:
 *   npm install grammy
 *
 * Environment:
 *   BOT_TOKEN=your_telegram_bot_token
 *   GAME_URL=https://game-client-go-three.vercel.app
 *   BOT_NAME=Beteseb Bingo Plus        (optional, shown in messages)
 *   BOT_VERSION=v2             (optional, appended to the name)
 */
const { Bot, webhookCallback, session, InputFile } = require("grammy");

const { I18N, tr, BOT_NAME, BOT_VERSION, BOT_TITLE } = require("../i18n");   // all texts live in i18n.js

// language cache (5 minutes) so the menu does not add a database call every time
const langCache = new Map();
// T(ctx, key, ...args): text of one screen in the language of the user who pressed the button
// phone-number accounts are shown the way people write them (0901011284, not 251901011284); bank accounts stay as they are
function displayAccountNumber(n) {
  const s = String(n || "").trim();
  const digits = s.replace(/[\s\-()]/g, "");
  const m = digits.match(/^(?:\+?251)(\d{9})$/);
  return m ? "0" + m[1] : s;
}

// first name of the account owner (first_name column, else the first word of account_name); "" when unknown
function accountOwnerFirstName(acc) {
  const f = String((acc && acc.first_name) || "").trim() || String((acc && acc.account_name) || "").trim().split(/\s+/)[0] || "";
  return f;
}

// payment method / type names in the user's language (fall back to the other language when one is missing)
function pmName(pm, lang) { return (lang === "am" ? (pm.amharic_name || pm.name) : (pm.name || pm.amharic_name)) || ""; }
function pmTypeName(t, lang) { return (lang === "am" ? (t.amharic_name || t.name) : (t.name || t.amharic_name)) || ""; }

async function T(ctx, key, ...args) { return tr(await getLang(ctx.from.id), key, ...args); }

async function getLang(telegramId) {
  const hit = langCache.get(telegramId);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.l;
  const l = await db.getUserLanguage(telegramId);
  langCache.set(telegramId, { l, t: Date.now() });
  return l;
}
function gameUrl(telegramId, lang) {
  return `${GAME_URL}?tid=${telegramId}` + `&lang=${lang === "en" ? "en" : "am"}`;
}
const db = require("../db");
const {  processDeposit } = require("../deposit");
// ============================================================
// CONFIG
// ============================================================
const BOT_TOKEN =  process.env.BOT_TOKEN;
const GAME_URL = process.env.GAME_URL || "https://game-client-go-three.vercel.app";
// Picture sent with the welcome / home message on /start. It is embedded in welcome_image.js (next to db.js), so nothing
// has to be hosted. Optional: WELCOME_IMAGE_URL = a public https address to use instead. After the first upload Telegram's
// file_id is reused.
const WELCOME_IMAGE_URL = String(process.env.WELCOME_IMAGE_URL || "").trim();
let WELCOME_IMAGE_BUFFER = null;
try { WELCOME_IMAGE_BUFFER = require("../welcome_image"); } catch (e) { console.warn("welcome_image.js not found - /start will be sent without a picture"); }
let welcomeFileId = null;
if (!BOT_TOKEN) 
{
  throw new Error("BOT_TOKEN environment variable is missing");
}
const bot = new Bot(BOT_TOKEN);

// Player names are typed by players. Inside a Markdown message they could break the formatting (or fake bold / links),
// so the special characters are escaped before a name is put into a Markdown text.
function mdEsc(text) {
  return String(text ?? "").replace(/([_*`\[\]])/g, "\\$1");
}

// ============================================================
// MONEY RESTRICTIONS (financial_restrictions.sql)
// Main admin can block a user (or everybody) from deposit / withdraw /
// transfer-from-Main / transfer-from-Play. The database enforces it;
// the checks below only give friendly early messages.
// ============================================================
const FR_FEATURES = {
  d:  { key: "deposit",       en: "Deposit",                   am: "ገቢ (ዲፖዚት)" },
  w:  { key: "withdraw",      en: "Withdraw",                  am: "ወጪ (ዊዝድሮዋል)" },
  tm: { key: "transfer_main", en: "Transfer from Main wallet", am: "ከዋና ሂሳብ ማስተላለፍ" },
  tp: { key: "transfer_play", en: "Transfer from Play wallet", am: "ከመጫወቻ ሂሳብ ማስተላለፍ" }
};
const FR_CODE_BY_KEY = Object.fromEntries(Object.entries(FR_FEATURES).map(([c, f]) => [f.key, c]));
const FR_ACTION_BY_CODE = { d: "deposit", w: "withdraw", tm: "transfer_main", tp: "transfer_play", t: "transfer", a: "all" };

function restrictionText(feature, scope, lang = "am") {
  const f = FR_FEATURES[FR_CODE_BY_KEY[feature]] || { en: feature, am: feature };
  if (lang === "en") {
    return scope === "system"
      ? `⏸ ${f.en} is temporarily unavailable. Please try again later.`
      : `🚫 ${f.en} is restricted on your account. Please contact support.`;
  }
  return scope === "system"
    ? `⏸ ${f.am} ለጊዜው ተዘግቷል። እባክዎ ቆይተው ይሞክሩ።`
    : `🚫 ${f.am} ለእርስዎ አካውንት ተገድቧል። እባክዎ ድጋፍን ያነጋግሩ።`;
}

// returns the message to show if this feature is blocked for this user, otherwise null.
// If the check itself fails we return null: the database still enforces the rule.
async function featureBlockedText(user, feature, lang = "am") {
  try {
    const st = await db.getFinancialStatus(user.id);
    if (st?.system?.[feature]?.enabled === false) return restrictionText(feature, "system", lang);
    if (st?.user?.[feature + "_blocked"] === true) return restrictionText(feature, "user", lang);
  } catch (err) {
    console.error("featureBlockedText error:", err.message);
  }
  return null;
}

async function replyIfFeatureBlocked(ctx, user, feature, lang = "am") {
  const text = await featureBlockedText(user, feature, lang);
  if (!text) return false;
  await respond("reply", ctx, text);
  return true;
}

function frAdminOnly(ctx) {
  return getCurrentAdmin(ctx).then((admin) => (admin && admin.admin_role === "main" ? admin : null));
}

function frUserScreen(status, userId) {
  const t = status.target || {};
  const u = status.user || {};
  const sys = status.system || {};
  const line = (code) => {
    const f = FR_FEATURES[code];
    const userOff = u[f.key + "_blocked"] === true;
    const sysOff = sys[f.key]?.enabled === false;
    return `${userOff ? "🚫" : "✅"} ${f.en}${sysOff ? "  _(paused for everyone)_" : ""}`;
  };
  const text =
    `💳 *Money restrictions*\n\n` +
    `👤 *${mdEsc(t.name || "Unknown")}*\n` +
    `📱 \`${t.phone || "N/A"}\`\n\n` +
    ["d", "w", "tm", "tp"].map(line).join("\n") +
    `\n\n✅ = allowed   🚫 = blocked for this user\n` +
    `Tap a button to switch it. The user gets a Telegram message.`;
  const btn = (code) => ({
    text: `${u[FR_FEATURES[code].key + "_blocked"] === true ? "✅ Allow" : "🚫 Block"} ${FR_FEATURES[code].en}`,
    callback_data: `fr_ut_${userId}_${code}`
  });
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [btn("d"), btn("w")],
        [btn("tm")],
        [btn("tp")],
        [
          { text: "🚫 Block all transfers", callback_data: `fr_ux_${userId}_t_1` },
          { text: "✅ Allow all transfers", callback_data: `fr_ux_${userId}_t_0` }
        ],
        [
          { text: "🚫 Block everything", callback_data: `fr_ux_${userId}_a_1` },
          { text: "✅ Clear all", callback_data: `fr_ux_${userId}_a_0` }
        ],
        [{ text: "👤 Manage Another User", callback_data: "admin_manage_user" }],
        [{ text: "🏠 Home", callback_data: "admin_home" }]
      ]
    }
  };
}

function frSystemScreen(status) {
  const sys = status.system || {};
  const line = (code) => {
    const f = FR_FEATURES[code];
    return `${sys[f.key]?.enabled === false ? "⏸ PAUSED" : "✅ ON"}  ${f.en}`;
  };
  const btn = (code) => ({
    text: `${sys[FR_FEATURES[code].key]?.enabled === false ? "▶️ Resume" : "⏸ Pause"} ${FR_FEATURES[code].en}`,
    callback_data: `fr_st_${code}`
  });
  return {
    text:
      `⚙️ *System money controls*\n\n` +
      ["d", "w", "tm", "tp"].map(line).join("\n") +
      `\n\nPausing a feature stops it for *every* user. Withdrawals already requested stay pending.`,
    reply_markup: {
      inline_keyboard: [
        [btn("d"), btn("w")],
        [btn("tm")],
        [btn("tp")],
        [
          { text: "⏸ Pause all transfers", callback_data: "fr_st_t" },
          { text: "▶️ Resume all transfers", callback_data: "fr_sr_t" }
        ],
        [
          { text: "⏸ Pause everything", callback_data: "fr_st_a" },
          { text: "▶️ Resume everything", callback_data: "fr_sr_a" }
        ],
        [{ text: "📏 Deposit / Withdraw / Transfer rules", callback_data: "admin_rl" }],
        [{ text: "🏠 Home", callback_data: "admin_home" }]
      ]
    }
  };
}

function frChangedLabels(changed) {
  return (changed || []).map((k) => {
    const f = FR_FEATURES[FR_CODE_BY_KEY[k]];
    return f ? f.en : k;
  });
}

async function frNotifyUser(telegramId, changed, blocked) {
  const labels = frChangedLabels(changed);
  if (!telegramId || !labels.length) return;
  const lang = await getLang(telegramId);
  const names = (changed || []).map((k) => {
    const f = FR_FEATURES[FR_CODE_BY_KEY[k]];
    return (lang === "am" ? f?.am : f?.en) || k;
  }).join(lang === "am" ? "፣ " : ", ");
  const text = tr(lang, blocked ? "fr_added" : "fr_removed", names);
  try {
    await respond("send", telegramId, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Restriction notice could not be sent:", err.message);
  }
}

// ============================================================
// STATE
// ============================================================
const pendingPhone = {};   // (not used for registration any more: the contact button needs no state)
const pendingDeposit = {};

const pendingWithdrawal = {};
const pendingAdminWithdrawal  = {};
const pendingAdminAccount = {};
const pendingDelete = {};
const pendingAdminReject = {};
const pendingAdminAccountEdit = {};
const pendingAdminAccountDelete = {};
const pendingAdminUserSearch = new Map();
const pendingAdminRoleSearch = new Map();
const pendingBroadcastRecipient = new Map();
const pendingTransfer = {};
const pendingRemovedAccountSearch = new Map(); // admin telegramId -> expiry (ms)

// ============================================================
// CLEAR USER STATE
// ============================================================
function clearPendingState(telegramId) 
{
  delete pendingPhone[telegramId];
  delete pendingDelete[telegramId];
  delete pendingDeposit[telegramId];  
  delete pendingTransfer[telegramId];
  delete pendingWithdrawal[telegramId];  
  delete pendingAdminReject[telegramId];
  delete pendingAdminAccount[telegramId];
  pendingRemovedAccountSearch.delete(telegramId);
  delete pendingAdminWithdrawal[telegramId];  
  delete pendingAdminAccountEdit[telegramId];
  delete pendingAdminAccountDelete[telegramId];  
 
  pendingAdminUserSearch.delete(telegramId);
  pendingAdminRoleSearch.delete(telegramId);
  pendingBroadcastRecipient.delete(telegramId);  
}

// ============================================================
// BLOCKED USER GUARD
// ============================================================
// Blocked users cannot use bot features.
// /start is allowed through so the user receives the
// blocked-account message from the /start handler.

// ============================================================
// REGISTRATION: a new / unregistered user is asked to share the phone number (contact button) straight away
// ============================================================
function langHint(ctx) { return "am"; }   // Amharic is the default until the user picks a language

function contactKeyboard(lang) {
  return {
    keyboard: [[{ text: tr(lang, "reg_btn_share"), request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

async function askForContact(ctx, again = false) {
  const lang = langHint(ctx);
  return respond("reply", ctx, 
    again ? tr(lang, "reg_again") : tr(lang, "reg_ask", mdEsc(BOT_TITLE)),
    { parse_mode: "Markdown", reply_markup: contactKeyboard(lang) }
  );
}

// the name comes from the Telegram profile, nobody has to type it
function telegramDisplayName(from) {
  const n = String(from?.first_name || "").replace(/\s+/g, " ").trim();
  return (n || "Player").slice(0, 30);
}

// ============================================================
// respond(): THE ONE PLACE every message the bot sends or edits goes through
//   respond("reply",    ctx, text, extra)               answer in the chat of the update           (was ctx.reply)
//   respond("edit",     ctx, text, extra)               edit the message a button was pressed on   (was ctx.editMessageText)
//   respond("send",     chatId, text, extra)            write to any user / admin by Telegram id   (was bot.api.sendMessage)
//   respond("editById", chatId, messageId, text, extra) edit a known message                       (was bot.api.editMessageText)
//   respond("photo",    chatId, photo, extra)           send a picture                             (was bot.api.sendPhoto)
// So the rules below (length limit, broken Markdown, "not modified", logging) exist once, not 360 times.
// ============================================================
const TELEGRAM_TEXT_LIMIT = 4096;
function tgErrorText(e) { return String((e && (e.description || e.message)) || ""); }

async function respond(mode, target, ...args) {
  const isCtx = target !== null && typeof target === "object";
  const textAt = mode === "editById" ? 1 : (mode === "photo" ? -1 : 0);
  if (textAt >= 0 && typeof args[textAt] !== "string") args[textAt] = String(args[textAt] ?? "");
  if (textAt >= 0 && args[textAt].length > TELEGRAM_TEXT_LIMIT) args[textAt] = args[textAt].slice(0, TELEGRAM_TEXT_LIMIT - 1) + "…";

  const run = (a) => {
    switch (mode) {
      case "reply":    return target.reply(...a);
      case "edit":     return target.editMessageText(...a);
      case "send":     return bot.api.sendMessage(target, ...a);
      case "editById": return bot.api.editMessageText(target, ...a);
      case "photo":    return bot.api.sendPhoto(target, ...a);
      default: throw new Error("respond(): unknown mode " + mode);
    }
  };
  const extraAt = mode === "editById" ? 2 : 1;

  try {
    return await run(args);
  } catch (e) {
    const d = tgErrorText(e);

    // 1) text with broken Markdown/HTML (a name with "_" or "*" ...): send it again as plain text rather than lose the message
    if (/can't parse entities/i.test(d) && args[extraAt] && args[extraAt].parse_mode) {
      console.warn("respond(): formatting rejected, sending as plain text:", d);
      const a = args.slice(); const x = { ...a[extraAt] }; delete x.parse_mode; a[extraAt] = x;
      return await run(a);
    }
    // 2) editing to the same text: nothing to do
    if ((mode === "edit" || mode === "editById") && /message is not modified/i.test(d)) return true;
    // 3) the message cannot be edited (a picture, too old, deleted): answer with a new message instead
    if (mode === "edit" && /(message to edit not found|there is no text in the message to edit|message can't be edited|MESSAGE_ID_INVALID)/i.test(d)) {
      return await target.reply(...args);
    }
    throw e;
  }
}

bot.use(session({  initial: () => (
  {
    paymentMethod: null,
    paymentType: null
  })}));

bot.use(async (ctx, next) => {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId)
    {
      return next();
    }
    const text = ctx.message?.text?.trim() || "";
    // Allow /start so blocked users see the blocked message
    if (text.startsWith("/start"))
    {
      return next();
    }
    const user = await db.getUserByTelegramId(telegramId);
    if (user?.is_blocked === true) 
    {
      // Callback buttons
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({
            text: "🚫 Your account is blocked.",
            show_alert: true
          });
        } catch (err) {}
        return;
      }
      // Normal messages / commands
      return respond("reply", ctx, "🚫 Your account has been blocked. Please contact support.");
    }
    // Not registered yet (private chat, a message or a button): ask for the phone number first.
    if (!user && ctx.chat?.type === "private" && (ctx.message || ctx.callbackQuery) && !ctx.message?.contact) {
      const existing = await db.getUserByTelegramIdIncludingInactive(telegramId);   // a paused account is a registered account
      if (!existing) {
        if (ctx.callbackQuery) { try { await ctx.answerCallbackQuery(); } catch (_) {} }
        return askForContact(ctx, true);
      }
    }
    return next();
  } catch (err) 
  {
    console.error("Blocked user guard error:", err);
    // Fail CLOSED: when the account state cannot be checked nobody is let through (a blocked user must not slip past an outage)
    try {
      if (ctx.callbackQuery) { await ctx.answerCallbackQuery({ text: tr(langHint(ctx), "busy_short"), show_alert: true }); return; }
      return respond("reply", ctx, tr(langHint(ctx), "busy"));
    } catch (_) { return; }
  }
});

// ============================================================
// ADMIN GATE (defence in depth)
// ============================================================
// Every button that belongs to the admin area is checked against the database BEFORE its handler runs, so a handler
// that forgets its own check (or a forged / replayed callback_data) can never be used by a normal user.
// The role rules inside each handler (main / withdrawal / broadcast / statistics) still apply on top of this.
const ADMIN_CALLBACK_RE = /^(admin_|approve_withdrawal_|reject_withdrawal_|remove_admin_|set_admin_|broadcast_)/;
bot.use(async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  if (typeof data !== "string" || !ADMIN_CALLBACK_RE.test(data)) return next();
  let admin = null;
  try { admin = ctx.from?.id ? await db.getAdminByTelegramId(ctx.from.id) : null; }
  catch (err) { console.error("Admin gate lookup error:", err); }
  if (!admin) {
    console.warn(`[security] non-admin ${ctx.from?.id} pressed admin button "${data.slice(0, 40)}"`);
    try { await ctx.answerCallbackQuery({ text: "❌ Unauthorized", show_alert: true }); } catch (_) {}
    return;
  }
  return next();
});

// pressing any non-bonus button drops an open form (so a later message isn't swallowed by it)
bot.use(async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  if (typeof data === "string" && !data.startsWith("admin_bn") && !data.startsWith("admin_rl") && ctx.from && bnHint.size) {
    try {
      const sess = await db.getBonusAdminSession(ctx.from.id);
      if (sess) { await db.clearBonusAdminSession(sess.admin_user_id); bnHint.delete(sess.admin_user_id); }
    } catch (_) {}
  }
  return next();
});

async function cleanupExpiredAdminWithdrawalUI(telegramId) 
{
  const state = pendingAdminWithdrawal[telegramId];
  if (!state) 
  {
    return;
  }
  if (!state.claimedWithdrawals || !state.claimedWithdrawals.length) 
  {
    return;
  }
  if (state.claimExpiresAt && Date.now() < state.claimExpiresAt) 
  {
    return;
  }
  /*
   * Local lease expired.
   */
  state.claimedWithdrawals = [];
  state.claimExpiresAt = null;
  if (state.cleanupTimer) 
  {
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
  }
  if (state.claimMessageId) 
  {
    try 
    {
          await bot.api.deleteMessage(telegramId, state.claimMessageId);
    } catch (err) 
    {
      try 
      {
        await respond("editById",  telegramId, state.claimMessageId, "⏱ *Withdrawal claim expired.*\n\n" + "The withdrawals were released for other admins.",
          {
            parse_mode: "Markdown"
          }
        );

      } catch (editError) 
      {
        console.error("Expired withdrawal UI cleanup failed:", editError);
      }
    }
    state.claimMessageId = null;
  }
}

function scheduleWithdrawalClaimCleanup(adminTelegramId) 
{
  const state = pendingAdminWithdrawal[adminTelegramId];
  if (!state) 
  {
    return;
  }
  /*
   * Don't create multiple timers for the same admin.
   */
  if (state.cleanupTimer) 
  {
    clearTimeout(state.cleanupTimer);
  }
  const expiresAt = state.claimExpiresAt;
  if (!expiresAt) 
  {
    return;
  }
  const delay =  Math.max(expiresAt - Date.now(), 1000);
  state.cleanupTimer = setTimeout(async () => {
        try {
          const currentState = pendingAdminWithdrawal[adminTelegramId];
          if (!currentState) {
            return;
          }

          /*
           * Clear the local state.
           */
          currentState.claimedWithdrawals =
            [];

          currentState.claimExpiresAt =
            null;

          currentState.cleanupTimer =
            null;

          /*
           * IMPORTANT:
           *
           * We do NOT modify the database here.
           *
           * The DB lease already expired.
           *
           * Another admin can claim these withdrawals.
           */

          /*
           * Delete the Telegram message.
           */
          if (
            currentState.claimMessageId
          ) {

            try {

              await bot.api.deleteMessage(
                adminTelegramId,
                currentState.claimMessageId
              );

            } catch (telegramError) {

              console.error(
                "Could not delete expired withdrawal message:",
                telegramError
              );

              /*
               * If Telegram won't let us delete it,
               * try editing it instead.
               */
              try {

                await respond("editById", 
                  adminTelegramId,
                  currentState.claimMessageId,
                  "⏱ *Withdrawal claim expired.*\n\n" +
                  "These withdrawals have been released and can be claimed by another admin.",
                  {
                    parse_mode: "Markdown"
                  }
                );

              } catch (editError) {

                console.error(
                  "Could not edit expired withdrawal message:",
                  editError
                );

              }
            }
          }

          currentState.claimMessageId =
            null;

        } catch (err) {

          console.error(
            "Withdrawal claim cleanup error:",
            err
          );

        }

      },
      delay
    );
}
// ============================================================
// BROADCAST SELECTION TEXT
// ============================================================

function getBroadcastSelectionText(
  draft
) {
  return (
    "📢 *Create Broadcast*\n\n" +

    `🖼 Image: ${
      draft.include_image
        ? "✅"
        : "❌"
    }\n` +

    `📝 Text: ${
      draft.include_text
        ? "✅"
        : "❌"
    }\n` +

    `🎮 Play Button: ${
      draft.include_button
        ? "✅"
        : "❌"
    }\n\n` +

    "Select the components you want."
  );
}


// ============================================================
// BROADCAST SELECTION KEYBOARD
// ============================================================

function getBroadcastSelectionKeyboard(
  draft
) {
  return {
    inline_keyboard: [

      [
        {
          text:
            draft.include_image
              ? "✅ 🖼 Image"
              : "🖼 Image",

          callback_data:
            "broadcast_toggle_image"
        },

        {
          text:
            draft.include_text
              ? "✅ 📝 Text"
              : "📝 Text",

          callback_data:
            "broadcast_toggle_text"
        }
      ],

      [
        {
          text:
            draft.include_button
              ? "✅ 🎮 Play Button"
              : "🎮 Play Button",

          callback_data:
            "broadcast_toggle_button"
        }
      ],

      [
        {
          text: "➡️ Continue",
          callback_data:
            "broadcast_continue"
        }
      ],

      [
        {
          text: "❌ Cancel",
          callback_data:
            "broadcast_cancel"
        }
      ]

    ]
  };
}
// ============================================================
// ADMIN AUTHORIZATION
// ============================================================
/**
 * Returns the currently logged-in admin from the database.
 *
 * Admin is determined by:
 *
 * users.is_admin = TRUE
 * users.is_active = TRUE
 * users.is_banned = FALSE
 *
 * There is NO hard-coded ADMIN_ID.
 */
async function getCurrentAdmin(ctx)
{
  if (!ctx || !ctx.from || !ctx.from.id) 
  {
    return null;
  }
  try 
  {
    const admin = await db.getAdminByTelegramId(ctx.from.id);
    return admin || null;
  } 
  catch (err) 
  {
    console.error("Admin lookup error:", err);
    return null;
  }
}

async function getCurrentAdminPermission(ctx, permission) 
{
    const admin = await getCurrentAdmin(ctx);
    if (!admin) 
    {
        try {
              await ctx.answerCallbackQuery({text: "❌ Unauthorized", show_alert: true});
            } 
        catch (err) 
        {          
        }
        return null;
    }
    const role = admin.admin_role;
    const allowed =  role === "main" ||   (role === "broadcast" &&  permission === "broadcast") || (role === "statistics" && permission === "statistics") || (role === "withdrawal" &&    permission === "withdrawals");
    if (!allowed) 
    {
        try {
                await ctx.answerCallbackQuery({text: "❌ You do not have permission for this.", show_alert: true});
            } 
        catch (err) 
        {          
        }
        return null;
    }
    return admin;
}

// ============================================================
// DEPOSIT RECEIPT CHECKS (before any money is credited)
// ============================================================
// approveDeposit() (db.js) already refuses a receipt number that was used before and checks that the money went to one
// of YOUR payment accounts. These extra checks stop old or unrelated receipts from being claimed:
//   * the payment must be "Completed"
//   * it must be recent (DEPOSIT_MAX_AGE_HOURS, default 24)
//   * optional: DEPOSIT_REQUIRE_PAYER_MATCH=1  -> the payer's phone (last 4 digits of the masked number on the receipt)
//     must be the phone the player registered with. Off by default because a relative may pay for the player.
//   * optional: DEPOSIT_MAX_ETB -> refuse a single deposit above this amount (it goes to manual review)
const DEPOSIT_MAX_AGE_HOURS = Number(process.env.DEPOSIT_MAX_AGE_HOURS) || 24;
const DEPOSIT_REQUIRE_PAYER_MATCH = process.env.DEPOSIT_REQUIRE_PAYER_MATCH === "1";
const DEPOSIT_MAX_ETB = Number(process.env.DEPOSIT_MAX_ETB) || 0;

// "15-10-2025 15:26:23" or "2025-10-15 15:26:23" (Ethiopia time, UTC+3) -> epoch ms, or null
function parseReceiptDate(text) {
  const t = String(text || "");
  let y, mo, d, h, mi, se;
  let m = t.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) { [, d, mo, y, h, mi, se] = m.map(Number); }
  else {
    m = t.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    [, y, mo, d, h, mi, se] = m.map(Number);
  }
  const ms = Date.UTC(y, mo - 1, d, h - 3, mi, se || 0);   // Ethiopia = UTC+3
  return Number.isFinite(ms) ? ms : null;
}

// returns null when the receipt may be credited, or a short reason (for the log / main admin).
// A field the receipt page does not show at all is only logged (a layout change at the provider must not stop every
// deposit); a field that is shown and wrong is refused.
function checkReceiptForDeposit(receipt, user) {
  if (!receipt || typeof receipt !== "object") return "no receipt data";
  const status = String(receipt.transactionStatus || "").trim().toLowerCase();
  if (!status) console.warn(`[deposit] receipt ${receipt.receiptNo}: no transactionStatus on the receipt`);
  else if (status !== "completed") return `transaction status is "${receipt.transactionStatus}", not Completed`;

  const when = parseReceiptDate(receipt.paymentDate);
  if (when === null) console.warn(`[deposit] receipt ${receipt.receiptNo}: payment date unreadable: ${JSON.stringify(receipt.paymentDate)}`);
  else {
    const ageH = (Date.now() - when) / 3600000;
    if (ageH > DEPOSIT_MAX_AGE_HOURS) return `receipt is ${Math.round(ageH)} h old (limit ${DEPOSIT_MAX_AGE_HOURS} h)`;
    if (ageH < -1) return "payment date is in the future";
  }

  const amount = Number(String(receipt.settledAmount ?? "").replace(/[^0-9.]/g, ""));
  if (DEPOSIT_MAX_ETB > 0 && amount > DEPOSIT_MAX_ETB) return `amount ${amount} is above DEPOSIT_MAX_ETB ${DEPOSIT_MAX_ETB}`;

  if (DEPOSIT_REQUIRE_PAYER_MATCH) {
    const payer = String(receipt.payerTelebirrNo || "").replace(/\D/g, "").slice(-4);
    const mine = String(user?.phone || "").replace(/\D/g, "").slice(-4);
    if (!payer || !mine || payer !== mine) return "payer phone does not match the player's registered phone";
  }
  return null;
}

// ============================================================
// BROADCAST HELPERS
// ============================================================

// Text for one user: Amharic users get the Amharic text when the admin wrote one, everybody else gets English.
function broadcastTextFor(draft, lang) {
  return (lang === "am" && draft.message_am) ? draft.message_am : draft.message;
}

function getBroadcastKeyboard(
  draft,
  telegramId,
  lang
) {
  if (
    !draft ||
    draft.include_button !== true ||
    !draft.button_title
  ) {
    return undefined;
  }

  return {
    inline_keyboard: [
      [
        {
          text: draft.button_title,
          web_app: {
            url: gameUrl(telegramId, lang)
          }
        }
      ]
    ]
  };
}


// ------------------------------------------------------------
// Determine whether the draft is complete
// ------------------------------------------------------------

function isBroadcastDraftComplete(draft) {
  if (!draft) {
    return false;
  }

  // At least image OR text must exist.
  if (
    draft.include_image !== true &&
    draft.include_text !== true
  ) {
    return false;
  }

  if (
    draft.include_image === true &&
    !draft.image_url
  ) {
    return false;
  }

  if (
    draft.include_text === true &&
    !draft.message
  ) {
    return false;
  }

  if (
    draft.include_button === true &&
    !draft.button_title
  ) {
    return false;
  }

  return true;
}


// ------------------------------------------------------------
// Find the next thing the admin must provide
// ------------------------------------------------------------

function getNextBroadcastStep(draft) {
  if (
    draft.include_image === true &&
    !draft.image_url
  ) {
    return "image";
  }

  if (
    draft.include_text === true &&
    !draft.message
  ) {
    return "text";
  }

  // Amharic version of the text (optional: /skip stores '')
  if (
    draft.include_text === true &&
    draft.message &&
    draft.message_am == null
  ) {
    return "text_am";
  }

  if (
    draft.include_button === true &&
    !draft.button_title
  ) {
    return "button";
  }

  return "complete";
}


// ------------------------------------------------------------
// Ask admin for the next broadcast component
// ------------------------------------------------------------

async function continueBroadcastBuilder(
  ctx,
  adminTelegramId
) {
  const draft =
    await db.getBroadcastDraft(
      adminTelegramId
    );

  if (!draft) {
    return;
  }

  const nextStep =
    getNextBroadcastStep(draft);

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  if (nextStep === "image") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_image"
    );

    return respond("reply", ctx, 
      "🖼 *Send the image*\n\n" +
      "This image will be included in the broadcast.\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // TEXT
  // ----------------------------------------------------------

  if (nextStep === "text") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_message"
    );

    return respond("reply", ctx, 
      "📝 *Send the broadcast message*\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // AMHARIC TEXT (optional)
  // ----------------------------------------------------------

  if (nextStep === "text_am") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_message_am"
    );

    return respond("reply", ctx, 
      "🇪🇹 *Send the Amharic version of the message*\n\n" +
      "Users who chose Amharic will get this text. Everybody else gets the English text.\n\n" +
      "⏭ Send /skip to send English only.\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // BUTTON
  // ----------------------------------------------------------

  if (nextStep === "button") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_button_title"
    );

    return respond("reply", ctx, 
      "🎮 *Send the Play button title*\n\n" +
      "Example:\n" +
      "`🎮 Play Now`\n\n" +
      "You can use any title you want.\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // COMPLETE
  // ----------------------------------------------------------

  if (nextStep === "complete") {
    await showBroadcastPreview(
      ctx,
      adminTelegramId
    );
  }
}


// ------------------------------------------------------------
// SHOW BROADCAST PREVIEW TO ADMIN
// ------------------------------------------------------------

async function showBroadcastPreview(
  ctx,
  adminTelegramId
) {
  const draft =
    await db.getBroadcastDraft(
      adminTelegramId
    );

  if (!draft) {
    return respond("reply", ctx, 
      "❌ Broadcast draft not found."
    );
  }

  if (
    !isBroadcastDraftComplete(draft)
  ) {
    return respond("reply", ctx, 
      "❌ Broadcast information is incomplete."
    );
  }

  const users =
    await db.getAllActiveUsers();

  const replyMarkup =
    getBroadcastKeyboard(
      draft,
      adminTelegramId
    );

  // ----------------------------------------------------------
  // SEND THE ACTUAL PREVIEW TO THE ADMIN
  // ----------------------------------------------------------

  if (
    draft.include_image === true
  ) {
    await respond("photo", 
      adminTelegramId,
      draft.image_url,
      {
        caption:
          draft.include_text === true
            ? draft.message
            : undefined,

        reply_markup:
          replyMarkup
      }
    );
  } else {
    await respond("send", 
      adminTelegramId,
      draft.message,
      {
        reply_markup:
          replyMarkup
      }
    );
  }

  // Amharic preview (only when the admin wrote one)
  if (draft.include_text === true && draft.message_am) {
    const amMarkup = getBroadcastKeyboard(draft, adminTelegramId, "am");
    await respond("send", 
      adminTelegramId,
      "🇪🇹 Amharic version (sent to users who chose Amharic):"
    );
    if (draft.include_image === true) {
      await respond("photo", adminTelegramId, draft.image_url, {
        caption: draft.message_am,
        reply_markup: amMarkup
      });
    } else {
      await respond("send", adminTelegramId, draft.message_am, {
        reply_markup: amMarkup
      });
    }
  }

  // ----------------------------------------------------------
  // CONFIRMATION MESSAGE
  // ----------------------------------------------------------

  await respond("reply", ctx, 
    `📢 *BROADCAST PREVIEW*\n\n` +
    `👥 Recipients: ${users.length}\n\n` +
    `🖼 Image: ${ draft.include_image ? "Yes" : "No"  }\n` +
    `📝 Text: ${  draft.include_text ? "Yes" : "No"  }\n` +
    `🇪🇹 Amharic text: ${ draft.include_text ? (draft.message_am ? "Yes" : "No (everyone gets English)") : "-" }\n` +
    `🎮 Play Button: ${ draft.include_button ? `Yes — "${draft.button_title}"` : "No" }\n\n` +
    `The message above is the exact content that will be broadcast.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ SEND TO ALL",
              callback_data: "broadcast_confirm"
            }
          ],
          [
            {
              text: "👤 SEND TO SPECIFIC PERSON",
              callback_data: "broadcast_specific"
            }
          ],
          [
            {
              text: "❌ CANCEL",
              callback_data:
                "broadcast_cancel"
            }
          ]
        ]
      }
    }
  );

  await db.updateBroadcastStatus(
    adminTelegramId,
    "preview"
  );
}
// ============================================================
// CALLBACK HELPER
// ============================================================
async function answerCallback(ctx, text = undefined) 
{
  try 
  {
    if (text) 
    {
      await ctx.answerCallbackQuery({text });
    } 
    else 
    {
      await ctx.answerCallbackQuery();
    }
  } 
  catch (err) 
  {
    console.log("Callback answer failed:", err.description || err.message);
  }
}

// ============================================================
// PHONE NORMALIZATION
// ============================================================

function normalizeEthiopianPhone(input) {
  let phone = String(input)
    .trim()
    .replace(/[\s\-()]/g, "");

  // 0912345678
  if (/^09\d{8}$/.test(phone)) {
    return "251" + phone.substring(1);
  }

  // 0712345678
  if (/^07\d{8}$/.test(phone)) {
    return "251" + phone.substring(1);
  }

  // 251912345678
  if (/^251[97]\d{8}$/.test(phone)) {
    return phone;
  }

  // +251912345678
  if (/^\+251[97]\d{8}$/.test(phone)) {
    return phone.substring(1);
  }

  return null;
}

// ============================================================
// PAYMENT ACCOUNT NUMBER NORMALIZATION
// ============================================================
//
// IMPORTANT:
// Only Mobile / ሞባይል payment types are normalized.
//
// Bank and other payment types keep the account number
// exactly as entered, except for trimming surrounding spaces.
// ============================================================

function normalizePaymentAccountNumber(accountNumber, paymentTypeName, paymentTypeAmharicName)
{
  const raw = String(accountNumber || "").trim();
  
  if (!raw) 
  {
    return null;
  }
  
  const typeName = String(paymentTypeName || "").trim().toLowerCase();
  const amharicTypeName = String(paymentTypeAmharicName || "").trim();
  const isMobile = typeName === "mobile" || amharicTypeName === "ሞባይል";

  // ----------------------------------------------------------
  // MOBILE ONLY
  // ----------------------------------------------------------

  if (isMobile) 
  {
    return normalizeEthiopianPhone(raw);
  }
  // ----------------------------------------------------------
  // NON-MOBILE
  // ----------------------------------------------------------
  //
  // Do NOT modify bank/account numbers.
  //
  return raw;
}

// ============================================================
// USER BUTTONS (Statistics, Home, Pause account)
// These MUST be registered at the top level. They used to sit inside showHome(), so they only
// existed after showHome had run once in a process (a button did nothing after a cold start).
// ============================================================

  // ============================================================
// USER STATISTICS
// ============================================================

async function showUserStatistics(ctx) {

  const telegramId = ctx.from.id;

  const user =
    await db.getUserByTelegramId(telegramId);

  if (!user) {
    return respond("reply", ctx, 
      await T(ctx, "start_first")
    );
  }

  try {

    const stats =
      await db.getUserStatistics(telegramId);

    if (!stats) {
      return respond("reply", ctx, 
        await T(ctx, "stats_load_fail")
      );
    }

    const message =
      await T(ctx, "stats_text", stats);

      

    await respond("edit", ctx, 
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: await T(ctx, "stats_btn_dep"), callback_data: "us_dep_1" },
              { text: await T(ctx, "stats_btn_wd"), callback_data: "us_wd_1" }
            ],
            [
              { text: await T(ctx, "stats_btn_tr"), callback_data: "us_tr_1" },
              { text: await T(ctx, "stats_btn_bn"), callback_data: "us_bn_1" }
            ],
            [
              {
                text: await T(ctx, "btn_refresh"),
                callback_data: "user_statistics"
              }
            ],
            [
              {
                text: await T(ctx, "btn_home"),
                callback_data: "user_home"
              }
            ]
          ]
        }
      }
    );

  } catch (err) {

    console.error(
      "User statistics error:",
      err
    );

    await respond("reply", ctx, 
      await T(ctx, "stats_fail")
    );
  }
}


// ============================================================
// STATISTICS: money history (deposits / withdrawals / transfers / bonuses)
// 10 rows per page with Previous / Next. Opened from the Statistics screen.
// ============================================================
const HIST_PAGE_SIZE = 10;

function htmlEsc(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function histMoney(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function histIcon(status) {
  switch (String(status || "").toLowerCase()) {
    case "completed": case "approved": return "✅";
    case "pending": case "processing": return "⏳";
    case "rejected": case "failed": case "cancelled": return "❌";
    case "reversed": return "↩️";
    case "active": return "🎁";
    case "expired": case "forfeited": return "⌛";
    default: return "▫️";
  }
}

function histStatus(lang, st) {
  const k = "hist_status_" + String(st || "").toLowerCase();
  return I18N[k] ? tr(lang, k) : String(st || "");
}

function histMethod(r, lang) {
  const name = (lang === "am" ? (r.method_name || r.method_name_en) : (r.method_name_en || r.method_name)) || "—";
  return `${r.method_emoji || "💳"} ${htmlEsc(name)}`;
}

const HIST_KINDS = {
  dep: {
    titleKey: "hist_dep_title",
    emptyKey: "hist_dep_empty",
    load: (tid, p) => db.getUserDepositHistory(tid, p, HIST_PAGE_SIZE),
    row: (r, n, lang) =>
      `<b>${n}.</b> ${histIcon(r.status)} <b>${histMoney(r.amount)} ETB</b> · ${histMethod(r, lang)}\n` +
      `      🧾 <code>${htmlEsc(r.reference || "—")}</code> · ${htmlEsc(r.when_text)}`
  },
  wd: {
    titleKey: "hist_wd_title",
    emptyKey: "hist_wd_empty",
    load: (tid, p) => db.getUserWithdrawalHistory(tid, p, HIST_PAGE_SIZE),
    row: (r, n, lang) =>
      `<b>${n}.</b> ${histIcon(r.status)} <b>${histMoney(r.amount)} ETB</b> · ${histMethod(r, lang)}\n` +
      `      📱 <code>${htmlEsc(r.account_number || "—")}</code> · ${htmlEsc(r.when_text)}` +
      (String(r.status) === "rejected" && r.rejection_reason ? `\n      ↳ ${htmlEsc(r.rejection_reason)}` : "")
  },
  tr: {
    titleKey: "hist_tr_title",
    emptyKey: "hist_tr_empty",
    load: (tid, p) => db.getUserTransferHistory(tid, p, HIST_PAGE_SIZE),
    row: (r, n, lang) =>
      `<b>${n}.</b> ${r.sent ? tr(lang, "hist_sent") : tr(lang, "hist_received")} <b>${histMoney(r.amount)} ETB</b> · ${r.wallet_type === "main" ? tr(lang, "hist_main") : tr(lang, "hist_play")}` +
      (String(r.status) !== "completed" ? ` ${histIcon(r.status)}` : "") + `\n` +
      `      👤 ${htmlEsc(r.other_name || "—")} · 📱 <code>${htmlEsc(r.other_phone || "—")}</code> · ${htmlEsc(r.when_text)}`
  },
  bn: {
    titleKey: "hist_bn_title",
    emptyKey: "hist_bn_empty",
    load: (tid, p) => db.getUserBonusHistory(tid, p, HIST_PAGE_SIZE),
    row: (r, n, lang) =>
      `<b>${n}.</b> ${histIcon(r.status)} <b>${histMoney(r.awarded_amount)} ETB</b> · ${htmlEsc(r.campaign_name || tr(lang, "hist_bonus_word"))}\n` +
      `      ${htmlEsc(histStatus(lang, r.status))} · ${tr(lang, "hist_left")} <b>${histMoney(r.remaining_amount)}</b>` +
      (Number(r.wagering_requirement) > 0
        ? ` · ${tr(lang, "hist_wagered")} ${histMoney(r.wagering_progress)}/${histMoney(r.wagering_requirement)}`
        : "") +
      `\n      🕒 ${htmlEsc(r.when_text)}` + (r.expires_text ? ` → ⏳ ${htmlEsc(r.expires_text)}` : "")
  }
};

async function showHistory(ctx, kind, page) {
  const cfg = HIST_KINDS[kind];
  const telegramId = ctx.from.id;
  const lang = await getLang(telegramId);
  try {
    const h = await cfg.load(telegramId, page);
    const lines = h.rows.map((r, i) => cfg.row(r, (h.page - 1) * h.pageSize + i + 1, lang));

    // bonuses: show progress of running "play N games" promotions on the first page
    let extra = "";
    if (kind === "bn" && h.page === 1) {
      try {
        const u = await db.getUserByTelegramId(telegramId);
        const prog = u ? await db.getGameBonusProgress(u.id) : [];
        const win = { daily: tr(lang, "hist_win_daily"), weekly: tr(lang, "hist_win_weekly"), monthly: tr(lang, "hist_win_monthly") };
        extra = prog.map((p) => {
          const done = Number(p.awards_in_window) >= Number(p.max_awards_per_window);
          return `🎯 ${htmlEsc(p.campaign_name)}: ` + (done
            ? `${tr(lang, "hist_done")} ${win[p.window_type] || ""} ✅`
            : `<b>${p.games_counted}/${p.games_required}</b> ${tr(lang, "hist_games")} ${win[p.window_type] || ""}`);
        }).join("\n");
        if (extra) extra += "\n\n";
      } catch (_) { /* game_bonus.sql not installed yet */ }
    }

    const text =
      `<b>${tr(lang, cfg.titleKey)}</b>` + (h.total ? ` — ${h.total} ${tr(lang, "hist_total")} · ${tr(lang, "hist_page")} ${h.page}/${h.pages}` : "") + `\n\n` +
      extra +
      (lines.length ? lines.join("\n\n") : tr(lang, cfg.emptyKey));

    const nav = [];
    if (h.page > 1) nav.push({ text: tr(lang, "btn_prev"), callback_data: `us_${kind}_${h.page - 1}` });
    if (h.pages > 1) nav.push({ text: `${h.page}/${h.pages}`, callback_data: "us_noop" });
    if (h.page < h.pages) nav.push({ text: tr(lang, "btn_next"), callback_data: `us_${kind}_${h.page + 1}` });

    const keyboard = [];
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: tr(lang, "btn_refresh"), callback_data: `us_${kind}_${h.page}` }]);
    keyboard.push([
      { text: tr(lang, "btn_stats"), callback_data: "user_statistics" },
      { text: tr(lang, "btn_home"), callback_data: "user_home" }
    ]);

    try {
      await respond("edit", ctx, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      if (!/message is not modified/i.test(String(err?.message))) throw err;
    }
  } catch (err) {
    console.error("History error:", kind, err);
    await respond("reply", ctx, tr(lang, "hist_fail"));
  }
}

bot.callbackQuery(/^us_(dep|wd|tr|bn)_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
  const user = await db.getUserByTelegramId(ctx.from.id);
  if (!user) return respond("reply", ctx, await T(ctx, "start_first"));
  await showHistory(ctx, ctx.match[1], Number(ctx.match[2]));
});

bot.callbackQuery("us_noop", async (ctx) => {
  await answerCallback(ctx);
});

// ============================================================
// STATISTICS CALLBACK
// ============================================================

bot.callbackQuery(
  "user_statistics",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    await showUserStatistics(ctx);

  }
);
// ============================================================
// USER HOME BUTTON
// ============================================================

bot.callbackQuery("user_home", async (ctx) => {
  try {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    const user = await db.getUserByTelegramId(ctx.from.id);

    if (!user) {
      return await respond("reply", ctx, 
        await T(ctx, "start_first")
      );
    }

    await showHome(ctx, user);

  } catch (err) {
    console.error("User home button error:", err);

    await respond("reply", ctx, 
      await T(ctx, "home_fail")
    );
  }
});
// ============================================================
// LANGUAGE
// ============================================================
bot.callbackQuery("user_lang", async (ctx) => {
  await answerCallback(ctx);
  try {
    const lang = await getLang(ctx.from.id);
    await respond("edit", ctx, tr(lang, "lang_title"), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: (lang === "am" ? "✅ " : "") + "አማርኛ", callback_data: "user_lang_am" },
            { text: (lang === "en" ? "✅ " : "") + "English", callback_data: "user_lang_en" }
          ],
          [{ text: tr(lang, "btn_home"), callback_data: "user_home" }]
        ]
      }
    });
  } catch (err) {
    console.error("Language screen error:", err);
  }
});

bot.callbackQuery(/^user_lang_(am|en)$/, async (ctx) => {
  const lang = ctx.match[1];
  try {
    const ok = await db.setUserLanguage(ctx.from.id, lang);
    if (!ok) throw new Error("not saved");
    langCache.set(ctx.from.id, { l: lang, t: Date.now() });
    await ctx.answerCallbackQuery({ text: tr(lang, "lang_saved") });
    const user = await db.getUserByTelegramId(ctx.from.id);
    if (user) await showHome(ctx, user);
  } catch (err) {
    console.error("Set language error:", err.message);
    try { await ctx.answerCallbackQuery({ text: tr(await getLang(ctx.from.id), "lang_error"), show_alert: true }); } catch (_) {}
  }
});

  // ============================================================
// DELETE ACCOUNT
// ============================================================

bot.callbackQuery(
  "user_delete",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    const lang = await getLang(ctx.from.id);
    await respond("edit", ctx, 
      tr(lang, "pause_confirm"),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: tr(lang, "yes"),
                callback_data: "user_confirm_delete"
              },
              {
                text: tr(lang, "no"),
                callback_data: "user_cancel_delete"
              }
            ]
          ]
        }
      }
    );

  }
);
  bot.callbackQuery(
  "user_cancel_delete",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
    
  const user = await db.getUserByTelegramId(ctx.from.id);

    if (!user) {
      return respond("edit", ctx, 
        await T(ctx, "not_found")
      );
    }

    await respond("edit", ctx, 
      await T(ctx, "pause_cancelled")
    );

    await showHome(
      ctx,
      user
    );

  }
);
  bot.callbackQuery(
  "user_confirm_delete",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    try {

      const lang = await getLang(ctx.from.id);
      const result =
        await db.deactivateUser(ctx.from.id);


      if (!result) {

        return await respond("edit", ctx, 
          tr(lang, "not_found")
        );

      }

      await respond("edit", ctx, 
        tr(lang, "pause_done"),
        {
          parse_mode: "Markdown"
        }
      );

    } catch (err) {

      console.error(
        "Pause account error:",
        err
      );

      await respond("edit", ctx, 
        tr(await getLang(ctx.from.id).catch(() => null), "pause_fail")
      );

    }

  }
);

// ============================================================
// HOME MENU
// ============================================================

async function showHome(ctx, user, opts = {}) 
{
  const telegramId = ctx.from.id;  
  const lang = await getLang(telegramId);
  const canPlay = user && user.is_active === true && user.is_blocked !== true;
  const keyboard = [];
  if (user && user.is_active === true && user.is_blocked !== true) 
  {
    
     keyboard.push([{ text: tr(lang, "btn_play"), web_app: { url: gameUrl(telegramId, lang) }}]);
  }
  keyboard.push([{ text: tr(lang, "btn_balance"), callback_data: "user_balance"}, { text: tr(lang, "btn_stats"), callback_data: "user_statistics"},],
                [{ text: tr(lang, "btn_deposit"), callback_data: "user_deposit"}, { text: tr(lang, "btn_withdraw"), callback_data: "user_withdraw"}],
                [{ text: tr(lang, "btn_transfer"), callback_data: "user_transfer"}, { text: tr(lang, "btn_language"), callback_data: "user_lang"}],
                [{ text: tr(lang, "btn_support"), callback_data: "user_support"}, { text: tr(lang, "btn_pause"), callback_data: "user_delete"}]);




  // ----------------------------------------------------------
  // ADMIN BUTTONS
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // Admin status comes from users.is_admin.
  // There is NO hard-coded ADMIN_ID.
  //
  // The `user` object comes from the database.
  // We also verify active/non-banned admin status here.
  // ----------------------------------------------------------
let admin = null;

try {
    admin = await getCurrentAdmin(ctx);
} catch (err) {
    console.error(
        "Home admin check error:",
        err
    );
}

// Main admin = everything
if (admin && admin.admin_role === "main") {
      keyboard.push([
        {
            text: "👤 Manage User",
            callback_data: "admin_manage_user"
        },
        {
            text: "⚙️ Money Controls",
            callback_data: "fr_s"
        },
        {
            text: "👑 Manage Admins",
            callback_data: "admin_manage_admins"
          }
    ]);

        keyboard.push([
        {
            text: "⏳ Pending",
            callback_data: "admin_withdrawals"
        },
        {
            text: "📏 Rules",
            callback_data: "admin_rl"
        },
        {
            text: "📢 Broadcast",
            callback_data: "admin_broadcast"
        }
    ]);
    keyboard.push([
      {
        text:
          "💳 Accounts",
    
        callback_data:
          "admin_accounts"
      },
    
      {
        text:
          "📊 Statistics",
    
        callback_data:
          "admin_statistics_menu"
      },

      {
        text:
          "🎁 Bonuses",

        callback_data:
          "admin_bn"
      }
    ]);
    keyboard.push([{ text: "📊 Open dashboard", web_app: { url: `${GAME_URL.replace(/\/+$/, "")}/admin.html` } }]);

}

// Statistics admin = dashboard button only
else if (admin && admin.admin_role === "statistics") {
    keyboard.push([{ text: "📊 Open dashboard", web_app: { url: `${GAME_URL.replace(/\/+$/, "")}/admin.html` } }]);
}

// Broadcast admin = broadcast only
else if (
    admin &&
    admin.admin_role === "broadcast"
) {

    keyboard.push([
        {
            text: "📢 Broadcast",
            callback_data: "admin_broadcast"
        }
    ]);
}

// Withdrawal admin = withdrawal only
else if (
    admin &&
    admin.admin_role === "withdrawal"
) {

    keyboard.push([
        {
            text: "⏳ Pending",
            callback_data: "admin_withdrawals"
        }
    ]);
}

  const homeText = tr(lang, "home_text", user.name);
  const homeExtra = {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  };

  // Home screen: the welcome picture with the same text as its caption.
  // If the picture cannot be sent for any reason the plain text message is sent instead, so the menu never goes missing.
  const welcomeSource = welcomeFileId || WELCOME_IMAGE_URL || (WELCOME_IMAGE_BUFFER ? new InputFile(WELCOME_IMAGE_BUFFER, "welcome.jpg") : null);
  if (opts.photo !== false && welcomeSource) {   // every home screen (the Home button in any menu, /start, language change ...) carries the picture
    try {
      const sent = await ctx.replyWithPhoto(welcomeSource, { caption: homeText, ...homeExtra });
      const ph = sent && sent.photo && sent.photo[sent.photo.length - 1];
      if (ph && ph.file_id) welcomeFileId = ph.file_id;
      return;
    } catch (e) {
      console.warn("welcome picture not sent, sending text only:", tgErrorText(e));
      welcomeFileId = null;
    }
  }

  await respond("reply", ctx, homeText, homeExtra);

}



// ============================================================
// ADMIN ROLE MANAGEMENT
// MAIN ADMIN ONLY
// ============================================================

bot.callbackQuery(
  "admin_manage_admins",
  async (ctx) => {
    try {
      await ctx.answerCallbackQuery();

      const admin =
        await db.getAdminByTelegramId(ctx.from.id);

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        return respond("reply", ctx, 
          "⛔ You are not authorized to manage admins."
        );
      }

      pendingAdminRoleSearch.set(
        ctx.from.id,
        {
          step: "waiting_phone"
        }
      );

      await respond("edit", ctx, 
        `👑 *Manage Admins*\n\n` +
        `Send the user's phone number.\n\n` +
        `Example:\n` +
        `\`0912345678\`\n` +
        `or\n` +
        `\`+251912345678\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "admin_manage_admins_cancel"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Admin role management error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Something went wrong."
      );
    }
  }
);
// ============================================================
// ADMIN MANAGE USER
// ============================================================

// ============================================================
// ADMIN: BONUS MANAGEMENT (bonus_admin.sql) — main admin only
//   list / detail / add (wizard) / edit / activate / deactivate /
//   duplicate / delete / history.
//   All rules are enforced by the database functions; this is only the front door.
//   Wizard state lives in the database (bonus_admin_sessions) because
//   serverless instances don't share memory.
// ============================================================
const bnHint = new Set(); // admins who (probably) have an open session in THIS instance

function bnFmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0";
}

function bnWhen(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-GB", {
      timeZone: "Africa/Addis_Ababa", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
  } catch (_) { return String(ts); }
}

const BN_STATE = {
  live: "🟢 Live", inactive: "⚪ Inactive", scheduled: "🕒 Scheduled", ended: "⛔ Ended"
};
const BN_KIND = { welcome: "Welcome (first deposit)", deposit: "Deposit", reload: "Reload (later deposits)", loyalty: "Loyalty" };

function bnIsGame(c) { return Boolean(c && c.game); }

function bnKindLabel(c) { return bnIsGame(c) ? "Play N games" : (BN_KIND[c.bonus_type] || c.bonus_type); }

function bnReward(c) {
  const cap = c.max_bonus_amount != null ? ` (max ${bnFmt(c.max_bonus_amount)} ETB)` : "";
  if (bnIsGame(c)) return `${bnFmt(c.percentage)}% of the cash stakes in those games${cap}`;
  if (c.percentage != null) return `${bnFmt(c.percentage)}% of the deposit${cap}`;
  if (c.amount != null) return `${bnFmt(c.amount)} ETB fixed`;
  return "—";
}

function bnShort(c) {
  const v = c.percentage != null ? `${bnFmt(c.percentage)}%` : c.amount != null ? `${bnFmt(c.amount)} ETB` : "";
  const icon = { live: "🟢", inactive: "⚪", scheduled: "🕒", ended: "⛔" }[c.state] || "⚪";
  const g = bnIsGame(c) ? "🎮" : "💰";
  return `${icon}${g} ${String(c.name).slice(0, 28)} · ${v}`;
}

function bnDetail(c, note) {
  const s = c.stats || {};
  const lines = [];
  lines.push(`🎁 <b>${htmlEsc(c.name)}</b>`);
  lines.push(`<code>${htmlEsc(c.code)}</code>`);
  lines.push("");
  lines.push(`Status: <b>${BN_STATE[c.state] || c.state}</b>${c.state === "inactive" ? " (nobody gets it)" : ""}`);
  lines.push(`Type: ${htmlEsc(bnKindLabel(c))}`);
  lines.push(`Reward: <b>${htmlEsc(bnReward(c))}</b>`);
  if (bnIsGame(c)) {
    const g = c.game;
    lines.push(`Rule: play <b>${g.games_required}</b> games ${g.window_type}` +
      ` · games need ≥ ${g.min_players} players` +
      (Number(g.min_stake_amount) > 0 ? ` · stake ≥ ${bnFmt(g.min_stake_amount)} ETB` : "") +
      ` · up to ${g.max_awards_per_window}× per ${g.window_type.replace("ly", "").replace("dai", "day")}`);
  } else if (c.min_deposit_amount != null) {
    lines.push(`Minimum deposit: ${bnFmt(c.min_deposit_amount)} ETB`);
  }
  lines.push(`Wagering: ${Number(c.wagering_multiplier) > 0 ? `${bnFmt(c.wagering_multiplier)}× before it can become cash` : "none"}`);
  lines.push(`Valid for: ${c.validity_hours ? `${c.validity_hours} h (${bnFmt(c.validity_hours / 24)} days)` : "no expiry"}`);
  lines.push(`Cash-out: ${c.conversion_type === "none" ? "play-only (can't convert)" : `${bnFmt(c.conversion_percentage)}% of what is left converts`}`);
  lines.push(`Runs: ${bnWhen(c.starts_at)} → ${c.ends_at ? bnWhen(c.ends_at) : "no end"}`);
  lines.push(`Priority ${c.priority} · ${c.stackable ? "stackable" : "not stackable"}`);
  lines.push("");
  lines.push(`📈 Given <b>${s.awards || 0}</b>× to <b>${s.users || 0}</b> players · total <b>${bnFmt(s.total)} ETB</b>` +
    ` · last 7 days ${bnFmt(s.last_7d)} ETB · still open ${s.active || 0}`);
  if (c.state === "inactive" && !(s.awards > 0)) lines.push("\n<i>Draft – press Activate when you are ready.</i>");
  if (bnIsGame(c)) lines.push("<i>Game bonuses count only games played after the bonus was activated.</i>");
  if (note) lines.push("\n" + note);
  return lines.join("\n");
}

function bnDetailKb(c) {
  const on = c.is_active;
  return {
    inline_keyboard: [
      [
        { text: on ? "⏸ Deactivate" : "▶️ Activate", callback_data: `admin_bn_t_${c.id}` },
        { text: "✏️ Edit", callback_data: `admin_bn_e_${c.id}` }
      ],
      [
        { text: "📋 Duplicate", callback_data: `admin_bn_c_${c.id}` },
        { text: "📜 History", callback_data: `admin_bn_h_${c.id}` },
        { text: "🗑 Delete", callback_data: `admin_bn_x_${c.id}` }
      ],
      [{ text: "↩️ All bonuses", callback_data: "admin_bn" }]
    ]
  };
}

// edit or reply, whichever is possible
async function bnShow(ctx, text, kb) {
  const opts = { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery) {
    try { return await respond("edit", ctx, text, opts); }
    catch (err) {
      if (/message is not modified/i.test(err.message || "")) return;
    }
  }
  return respond("reply", ctx, text, opts);
}

async function bnAdmin(ctx) {
  const admin = await frAdminOnly(ctx);
  if (!admin) { try { await respond("reply", ctx, "⛔ You are not authorized."); } catch (_) {} }
  return admin;
}

async function bnFail(ctx, err, back) {
  const kb = back ? { inline_keyboard: [[{ text: "↩️ Back", callback_data: back }]] } : undefined;
  const code = err && err.bonusAdmin;
  let msg;
  if (code === "NOT_INSTALLED") msg = "⚠️ Bonus management is not installed yet. Run bonus_admin.sql in the database first.";
  else if (code && code.startsWith("INVALID:")) msg = "❌ " + code.replace("INVALID: ", "");
  else if (code === "CAMPAIGN_NOT_FOUND") msg = "❌ That bonus no longer exists.";
  else if (code && code.startsWith("HAS_AWARDS:")) {
    msg = `🔒 This bonus has already been given ${code.split(":")[1]} time(s), so it can't be deleted (the history must stay).\nUse <b>Deactivate</b> instead – players who already have it keep it.`;
  } else {
    console.error("bonus admin error:", err);
    msg = "❌ Something went wrong.";
  }
  try { await bnShow(ctx, msg, kb); } catch (_) { try { await respond("reply", ctx, msg, { parse_mode: "HTML" }); } catch (__) {} }
}

// ---------------- list ----------------
const BN_FILTERS = [["all", "All"], ["on", "Active"], ["off", "Off"], ["game", "Games"], ["dep", "Deposit"]];
const BN_FILTER_SQL = { all: "all", on: "active", off: "inactive", game: "game", dep: "deposit" };

async function bnList(ctx, admin, filter = "all", page = 0) {
  const f = BN_FILTER_SQL[filter] ? filter : "all";
  const r = await db.adminListBonusCampaigns(admin.id, BN_FILTER_SQL[f], page, 6);
  const sm = r.summary || {};
  const pages = Math.max(1, Math.ceil(r.total / r.page_size));
  const text =
    `🎁 <b>Bonuses</b>\n\n` +
    `${sm.active || 0} active of ${sm.campaigns || 0} · given in the last 7 days: <b>${bnFmt(sm.awarded_7d)} ETB</b>` +
    ` · all time: ${bnFmt(sm.awarded_total)} ETB\n\n` +
    (r.rows.length ? `Tap a bonus to manage it.   (page ${r.page + 1}/${pages})` : "No bonuses here yet.");
  const kb = [];
  kb.push(BN_FILTERS.map(([k, label]) => ({
    text: (k === f ? "• " : "") + label, callback_data: `admin_bn_l_${k}_0`
  })));
  for (const c of r.rows) kb.push([{ text: bnShort(c), callback_data: `admin_bn_v_${c.id}` }]);
  if (pages > 1) {
    const nav = [];
    if (r.page > 0) nav.push({ text: "⬅️ Prev", callback_data: `admin_bn_l_${f}_${r.page - 1}` });
    if (r.page < pages - 1) nav.push({ text: "Next ➡️", callback_data: `admin_bn_l_${f}_${r.page + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: "➕ New bonus", callback_data: "admin_bn_n" }]);
  kb.push([{ text: "🏠 Home", callback_data: "admin_home" }]);
  await bnShow(ctx, text, { inline_keyboard: kb });
}

async function bnShowCampaign(ctx, admin, id, note) {
  const c = await db.adminGetBonusCampaign(admin.id, id);
  await bnShow(ctx, bnDetail(c, note), bnDetailKb(c));
}

// ---------------- field definitions (shared by the wizard and by edit) ----------------
function bnNum(o = {}) {
  return (t) => {
    const s = String(t).trim().replace(/,/g, "");
    if (o.nullable && (s === "-" || s.toLowerCase() === "none")) return { value: null };
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: "Send a number, for example 50." };
    const n = Number(s);
    if (o.int && !Number.isInteger(n)) return { error: "Send a whole number." };
    if (o.min != null && n < o.min) return { error: `The minimum is ${o.min}.` };
    if (o.max != null && n > o.max) return { error: `The maximum is ${o.max}.` };
    return { value: n };
  };
}

function bnDate(t) {
  const s = String(t).trim();
  if (s === "-" || s.toLowerCase() === "none") return { value: null };
  let m = /^\+(\d{1,3})d$/i.exec(s);
  if (m) return { value: new Date(Date.now() + Number(m[1]) * 86400000).toISOString() };
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (!m) return { error: "Use 2026-12-31 or 2026-12-31 18:00 (Ethiopia time), or +7d for 7 days from now, or - to clear." };
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${String(m[4] || "0").padStart(2, "0")}:${m[5] || "00"}:00+03:00`);
  if (isNaN(d.getTime())) return { error: "That date is not valid." };
  return { value: d.toISOString() };
}

// key = column to patch; skip = value used by the "Skip" button in the wizard (absent = required)
const BN_F = {
  name: {
    key: "name", prompt: () => "✏️ Send the bonus <b>name</b> (players see it).",
    parse: (t) => { const s = String(t).trim(); return s.length < 2 || s.length > 100 ? { error: "The name must be 2–100 characters." } : { value: s }; }
  },
  mode: {
    choice: [["p", "📊 Percentage"], ["f", "💵 Fixed amount"]],
    prompt: () => "How is the bonus calculated?"
  },
  value: {
    prompt: (a, kind) => kind === "g"
      ? "📊 What <b>percentage of the player's cash stakes</b> in those games is given back as bonus?\n50 = half, 100 = full."
      : a.mode === "f" ? "💵 Send the <b>fixed bonus amount</b> in ETB."
      : "📊 Send the <b>percentage of the deposit</b> given as bonus (e.g. 50).",
    parse: (t, a, kind) => kind !== "g" && a.mode === "f" ? bnNum({ min: 1 })(t) : bnNum({ min: 0.01, max: 100 })(t)
  },
  cap: {
    key: "max_bonus_amount", skip: null,
    prompt: () => "🔝 <b>Maximum bonus</b> per award in ETB? Send a number, or - for no limit.",
    parse: bnNum({ nullable: true, min: 1 })
  },
  mindep: {
    key: "min_deposit_amount", skip: null,
    prompt: () => "⬇️ <b>Minimum deposit</b> to qualify (ETB)? Send a number, or - for none.",
    parse: bnNum({ nullable: true, min: 1 })
  },
  wager: {
    key: "wagering_multiplier", skip: 1,
    prompt: () => "🔁 <b>Wagering</b>: how many times must the bonus be played before it can become cash?\n0 = none, 1 = once (recommended), 3 = three times.",
    parse: bnNum({ min: 0, max: 100 })
  },
  validity: {
    key: "validity_hours", skip: 168,
    prompt: () => "⏳ <b>Validity</b> in hours after it is given (168 = 7 days, 720 = 30 days). Send - for no expiry.",
    parse: bnNum({ nullable: true, int: true, min: 1, max: 8760 })
  },
  games: {
    key: "games_required", skip: 10,
    prompt: () => "🎮 How many <b>games</b> must the player play in the period?",
    parse: bnNum({ int: true, min: 1, max: 1000 })
  },
  window: {
    key: "window_type", skip: "weekly",
    choice: [["daily", "📅 Daily"], ["weekly", "🗓 Weekly"], ["monthly", "📆 Monthly"]],
    prompt: () => "Counting period? (Ethiopia time – a week starts Monday)"
  },
  players: {
    key: "min_players", skip: 5,
    prompt: () => "👥 <b>Minimum players</b> in a game for it to count (at least 2; 5+ recommended – it stops farming in tiny games).",
    parse: bnNum({ int: true, min: 2, max: 1000 })
  },
  maxaw: {
    key: "max_awards_per_window", skip: 1,
    prompt: () => "🏆 How many times can one player win this bonus <b>per period</b>?",
    parse: bnNum({ int: true, min: 1, max: 100 })
  },
  minstake: {
    key: "min_stake_amount", skip: 0,
    prompt: () => "🎟 <b>Minimum game stake</b> (ETB) for a game to count. 0 = any stake.",
    parse: bnNum({ min: 0 })
  },
  starts: {
    key: "starts_at", skip: null,
    prompt: () => "🟢 <b>Start</b> date/time (Ethiopia time).\nExamples: <code>2026-12-31 18:00</code>, <code>+2d</code>, or - to start as soon as activated.",
    parse: bnDate
  },
  ends: {
    key: "ends_at", skip: null,
    prompt: () => "🔴 <b>End</b> date/time (Ethiopia time).\nExamples: <code>2026-12-31 23:59</code>, <code>+30d</code>, or - for no end.",
    parse: bnDate
  },
  priority: {
    key: "priority", skip: 0,
    prompt: () => "🔢 <b>Priority</b> (0–100). Higher wins when several non-stackable bonuses match.",
    parse: bnNum({ int: true, min: 0, max: 100 })
  },
  stack: {
    key: "stackable", skip: false,
    choice: [["1", "✅ Stackable"], ["0", "🚫 Not stackable"]],
    prompt: () => "Can this bonus be combined with other bonuses on the same deposit?"
  },
  conv: {
    choice: [["full", "💱 Convert what's left to cash"], ["none", "🎮 Play-only (never converts)"]],
    prompt: () => "After the wagering is done, what happens to the remaining bonus?"
  }
};

const BN_STEPS_NEW = {
  d: ["name", "mode", "value", "cap", "mindep", "wager", "validity"],
  w: ["name", "mode", "value", "cap", "mindep", "wager", "validity"],
  r: ["name", "mode", "value", "cap", "mindep", "wager", "validity"],
  g: ["name", "value", "cap", "games", "window", "players", "wager", "validity"]
};
const BN_KIND_NAME = { d: "deposit", w: "welcome", r: "reload", g: "games" };
const BN_KIND_TITLE = {
  d: "💰 Deposit bonus", w: "👋 Welcome bonus (first deposit)", r: "🔄 Reload bonus (later deposits)", g: "🎮 Play N games bonus"
};

function bnApplicable(step, a) {
  if (step === "cap") return a.mode !== "f";
  return true;
}

function bnNextStep(steps, current, a) {
  let i = steps.indexOf(current) + 1;
  while (i < steps.length && !bnApplicable(steps[i], a)) i++;
  return i < steps.length ? steps[i] : null;
}

function bnFirstStep(steps, a) {
  let i = 0;
  while (i < steps.length && !bnApplicable(steps[i], a)) i++;
  return steps[i] || null;
}

async function bnSave(adminId, flow, step, data) {
  bnHint.add(adminId);
  await db.setBonusAdminSession(adminId, flow, step, data, 15);
}

async function bnPrompt(ctx, flow, step, data) {
  const def = BN_F[step];
  const kind = data.kind;
  const a = data.a || {};
  const kb = [];
  if (def.choice) {
    kb.push(def.choice.map(([v, label]) => ({ text: label, callback_data: `admin_bn_wc_${step}_${v}` })));
  }
  if (flow === "new" && "skip" in def) {
    const dv = def.skip === null ? "none" : def.skip === false ? "no" : String(def.skip);
    kb.push([{ text: `⏭ Skip (${dv})`, callback_data: `admin_bn_ws_${step}` }]);
  }
  kb.push([{ text: "❌ Cancel", callback_data: "admin_bn_wx" }]);
  const stepNo = flow === "new" ? `<i>Step ${data.steps.indexOf(step) + 1}/${data.steps.length}</i>\n` : "";
  await respond("reply", ctx, `${stepNo}${def.prompt(a, kind)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

function bnPatchFrom(data) {
  const a = data.a || {};
  const p = {};
  for (const step of data.steps) {
    if (!(step in a)) continue;
    const def = BN_F[step];
    if (step === "value") p[data.kind === "g" || a.mode !== "f" ? "percentage" : "amount"] = a.value;
    else if (step === "conv") {
      if (a.conv === "none") p.conversion_type = "none";
      else { p.conversion_type = "percentage"; p.conversion_percentage = 100; }
    } else if (step === "stack") p.stackable = a.stack === "1" || a.stack === true;
    else if (def.key) p[def.key] = a[step];
  }
  return p;
}

function bnSummaryText(data) {
  const a = data.a;
  const g = data.kind === "g";
  const L = [`🆕 <b>${htmlEsc(BN_KIND_TITLE[data.kind])}</b> – please check:`, ""];
  L.push(`Name: <b>${htmlEsc(a.name)}</b>`);
  L.push(`Reward: <b>${g || a.mode !== "f" ? bnFmt(a.value) + "%" + (g ? " of cash stakes" : " of the deposit") : bnFmt(a.value) + " ETB fixed"}</b>` +
    (a.cap != null && a.mode !== "f" ? ` (max ${bnFmt(a.cap)} ETB)` : ""));
  if (g) L.push(`Rule: ${a.games} games ${a.window} · ≥ ${a.players} players per game`);
  else if (a.mindep != null) L.push(`Minimum deposit: ${bnFmt(a.mindep)} ETB`);
  L.push(`Wagering: ${Number(a.wager) > 0 ? bnFmt(a.wager) + "×" : "none"} · valid ${a.validity ? a.validity + " h" : "no expiry"}`);
  L.push("");
  L.push("It will be created <b>inactive</b> – nothing changes for players until you press Activate.");
  return L.join("\n");
}

// one answer (text or button) for the current step; returns nothing
async function bnApplyAnswer(ctx, sess, rawValue, fromButton) {
  const adminId = sess.admin_user_id;
  const data = sess.data;
  const step = sess.step;
  const def = BN_F[step];
  if (step !== "confirm" && !def) { await db.clearBonusAdminSession(adminId); return respond("reply", ctx, "This form expired. Open Bonuses again."); }
  data.a = data.a || {};
  if (step === "confirm") return respond("reply", ctx, "Please press Create or Cancel on the summary above.");

  let value;
  if (def.choice) {
    if (!fromButton) return respond("reply", ctx, "Please tap one of the buttons above.");
    value = rawValue;
  } else {
    const r = def.parse(rawValue, data.a, data.kind);
    if (r.error) return respond("reply", ctx, "❌ " + r.error + "\nTry again, or press Cancel.");
    value = r.value;
  }
  data.a[step] = step === "stack" ? value : value;
  if (step === "mode") data.a.mode = value;

  const next = bnNextStep(data.steps, step, data.a);
  if (next) {
    await bnSave(adminId, sess.flow, next, data);
    return bnPrompt(ctx, sess.flow, next, data);
  }

  // finished
  if (sess.flow === "new") {
    await bnSave(adminId, "new", "confirm", data);
    return respond("reply", ctx, bnSummaryText(data), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Create (inactive draft)", callback_data: "admin_bn_wy" }],
          [{ text: "❌ Cancel", callback_data: "admin_bn_wx" }]
        ]
      }
    });
  }
  // edit
  const patch = bnPatchFrom(data);
  await db.clearBonusAdminSession(adminId);
  bnHint.delete(adminId);
  try {
    const c = await db.adminUpdateBonusCampaign(adminId, data.id, patch);
    const warn = c.state === "live" ? "✅ Saved.\n<i>Bonuses already given keep their old terms; the change applies to new awards.</i>" : "✅ Saved.";
    await respond("reply", ctx, bnDetail(c, warn), { parse_mode: "HTML", reply_markup: bnDetailKb(c) });
  } catch (err) {
    await bnFail(ctx, err, `admin_bn_e_${data.id}`);
  }
}

// text hook – called first from the single message:text handler
async function bnTextHook(ctx, telegramId, text) {
  const sess = await db.getBonusAdminSession(telegramId);
  if (!sess || sess.flow === "rule_edit") return false;      // rule_edit belongs to the rule manager (rlTextHook)
  bnHint.add(sess.admin_user_id);
  if (text.startsWith("/")) {
    await db.clearBonusAdminSession(sess.admin_user_id);
    bnHint.delete(sess.admin_user_id);
    if (/^\/cancel\b/i.test(text)) { await respond("reply", ctx, "❌ Cancelled."); return true; }
    return false; // any other command: drop the form, let the command run
  }
  await bnApplyAnswer(ctx, sess, text, false);
  return true;
}

// ---------------- the single callback router ----------------
bot.callbackQuery(/^admin_bn(?:_.*)?$/, async (ctx) => {
  let admin = null;
  try {
    await ctx.answerCallbackQuery();
    admin = await bnAdmin(ctx);
    if (!admin) return;
    const parts = ctx.callbackQuery.data.split("_").slice(2); // after "admin","bn"
    const act = parts[0] || "";
    const id = /^\d+$/.test(parts[1] || "") ? Number(parts[1]) : null;

    switch (act) {
      case "": {
        await db.clearBonusAdminSession(admin.id); bnHint.delete(admin.id);
        return await bnList(ctx, admin, "all", 0);
      }
      case "l": return await bnList(ctx, admin, parts[1] || "all", Number(parts[2]) || 0);
      case "v": return await bnShowCampaign(ctx, admin, id);

      case "t": { // toggle
        const c = await db.adminGetBonusCampaign(admin.id, id);
        if (c.is_active) {
          const r = await db.adminSetBonusCampaignActive(admin.id, id, false);
          return await bnShow(ctx, bnDetail(r, "⏸ Deactivated. Bonuses players already hold stay as they are."), bnDetailKb(r));
        }
        return await bnShow(ctx,
          `▶️ <b>Go live?</b>\n\n${bnDetail(c)}\n\nPlayers will start receiving this bonus immediately.`,
          { inline_keyboard: [[{ text: "✅ Yes, activate", callback_data: `admin_bn_ty_${id}` }], [{ text: "↩️ Back", callback_data: `admin_bn_v_${id}` }]] });
      }
      case "ty": {
        const r = await db.adminSetBonusCampaignActive(admin.id, id, true);
        return await bnShow(ctx, bnDetail(r, "▶️ Activated."), bnDetailKb(r));
      }

      case "c": { // duplicate
        const r = await db.adminDuplicateBonusCampaign(admin.id, id);
        return await bnShow(ctx, bnDetail(r, "📋 Copy created as an inactive draft."), bnDetailKb(r));
      }

      case "x": { // delete confirm
        const c = await db.adminGetBonusCampaign(admin.id, id);
        if (c.stats && c.stats.awards > 0) {
          return await bnShow(ctx,
            `🔒 <b>${htmlEsc(c.name)}</b> has been given ${c.stats.awards} time(s), so it can't be deleted – the history must stay.\n\nDeactivate it instead.`,
            { inline_keyboard: [[{ text: c.is_active ? "⏸ Deactivate" : "↩️ Back", callback_data: c.is_active ? `admin_bn_t_${id}` : `admin_bn_v_${id}` }]] });
        }
        return await bnShow(ctx,
          `🗑 <b>Delete "${htmlEsc(c.name)}"?</b>\n\nIt was never given to anyone. This cannot be undone.`,
          { inline_keyboard: [[{ text: "🗑 Yes, delete", callback_data: `admin_bn_xy_${id}` }], [{ text: "↩️ Back", callback_data: `admin_bn_v_${id}` }]] });
      }
      case "xy": {
        const r = await db.adminDeleteBonusCampaign(admin.id, id);
        await bnShow(ctx, `🗑 Deleted <b>${htmlEsc(r.name)}</b>.`, { inline_keyboard: [[{ text: "↩️ All bonuses", callback_data: "admin_bn" }]] });
        return;
      }

      case "h": { // history
        const c = await db.adminGetBonusCampaign(admin.id, id);
        const log = await db.adminBonusCampaignLog(admin.id, id, 8);
        const ACT = { create: "created", update: "edited", activate: "activated", deactivate: "deactivated", duplicate: "copied", delete: "deleted" };
        const lines = (log || []).map((l) => {
          const keys = l.patch ? Object.keys(l.patch).join(", ") : "";
          return `• ${bnWhen(l.at)} – ${ACT[l.action] || l.action}${keys ? ` (${htmlEsc(keys)})` : ""} by ${htmlEsc(l.admin)}`;
        });
        return await bnShow(ctx, `📜 <b>${htmlEsc(c.name)}</b> – changes\n\n${lines.join("\n") || "No changes recorded."}`,
          { inline_keyboard: [[{ text: "↩️ Back", callback_data: `admin_bn_v_${id}` }]] });
      }

      case "e": { // edit menu
        const c = await db.adminGetBonusCampaign(admin.id, id);
        const g = bnIsGame(c);
        const b = (t, f) => ({ text: t, callback_data: `admin_bn_ef_${id}_${f}` });
        const rows = [[b("✏️ Name", "name"), b("💰 Reward", "reward")]];
        const row2 = [];
        if (c.percentage != null) row2.push(b("🔝 Max bonus", "cap"));
        if (!g) row2.push(b("⬇️ Min deposit", "mindep"));
        if (row2.length) rows.push(row2);
        if (g) {
          rows.push([b("🎮 Games needed", "games"), b("🗓 Period", "window")]);
          rows.push([b("👥 Min players", "players"), b("🏆 Awards/period", "maxaw")]);
          rows.push([b("🎟 Min stake", "minstake")]);
        }
        rows.push([b("🔁 Wagering", "wager"), b("⏳ Validity", "validity")]);
        rows.push([b("🟢 Start", "starts"), b("🔴 End", "ends")]);
        rows.push([b("💱 Cash-out", "conv"), b("🔢 Priority", "priority")]);
        if (!g) rows.push([b("🔗 Stackable", "stack")]);
        rows.push([{ text: "↩️ Back", callback_data: `admin_bn_v_${id}` }]);
        return await bnShow(ctx, `✏️ <b>Edit "${htmlEsc(c.name)}"</b>\n\nWhat do you want to change?`, { inline_keyboard: rows });
      }
      case "ef": {
        const field = parts[2];
        const c = await db.adminGetBonusCampaign(admin.id, id);
        const g = bnIsGame(c);
        const steps = field === "reward" ? (g ? ["value"] : ["mode", "value"]) : [field];
        if (!steps.every((s) => BN_F[s])) return respond("reply", ctx, "❌ Unknown field.");
        const data = { id, steps, kind: g ? "g" : "d", a: { mode: c.percentage != null ? "p" : "f" } };
        const first = steps[0];
        await bnSave(admin.id, "edit", first, data);
        return await bnPrompt(ctx, "edit", first, data);
      }

      case "n": { // new – choose the template
        await db.clearBonusAdminSession(admin.id); bnHint.delete(admin.id);
        return await bnShow(ctx, "➕ <b>New bonus</b>\n\nWhat kind of bonus?\n<i>It is created inactive – you decide when it goes live.</i>", {
          inline_keyboard: [
            [{ text: BN_KIND_TITLE.w, callback_data: "admin_bn_nt_w" }],
            [{ text: BN_KIND_TITLE.d, callback_data: "admin_bn_nt_d" }],
            [{ text: BN_KIND_TITLE.r, callback_data: "admin_bn_nt_r" }],
            [{ text: BN_KIND_TITLE.g, callback_data: "admin_bn_nt_g" }],
            [{ text: "↩️ Back", callback_data: "admin_bn" }]
          ]
        });
      }
      case "nt": {
        const k = parts[1];
        if (!BN_STEPS_NEW[k]) return;
        const data = { kind: k, steps: BN_STEPS_NEW[k], a: {} };
        const first = bnFirstStep(data.steps, data.a);
        await bnSave(admin.id, "new", first, data);
        await bnShow(ctx, `${htmlEsc(BN_KIND_TITLE[k])}\n\nI will ask a few questions. Send /cancel any time.`, undefined);
        return await bnPrompt(ctx, "new", first, data);
      }

      case "wc": case "ws": { // choice / skip for the current step
        const sess = await db.getBonusAdminSession(ctx.from.id);
        const step = parts[1];
        if (!sess || sess.step !== step) return respond("reply", ctx, "This form expired. Open Bonuses again.");
        const def = BN_F[step];
        if (act === "ws") {
          if (!("skip" in def) || sess.flow !== "new") return;
          return await bnApplyAnswer(ctx, sess, def.skip === null ? "-" : String(def.skip), true);
        }
        return await bnApplyAnswer(ctx, sess, parts.slice(2).join("_"), true);
      }
      case "wy": { // create
        const sess = await db.getBonusAdminSession(ctx.from.id);
        if (!sess || sess.flow !== "new" || sess.step !== "confirm") return respond("reply", ctx, "This form expired. Open Bonuses again.");
        const data = sess.data;
        const a = data.a;
        const payload = { kind: BN_KIND_NAME[data.kind], name: a.name };
        Object.assign(payload, bnPatchFrom(data));
        payload.name = a.name;
        await db.clearBonusAdminSession(admin.id); bnHint.delete(admin.id);
        const c = await db.adminCreateBonusCampaign(admin.id, payload);
        return await bnShow(ctx, bnDetail(c, "✅ Created as an <b>inactive draft</b>. Press Activate to go live."), bnDetailKb(c));
      }
      case "wx": {
        await db.clearBonusAdminSession(admin.id); bnHint.delete(admin.id);
        return await bnShow(ctx, "❌ Cancelled.", { inline_keyboard: [[{ text: "↩️ All bonuses", callback_data: "admin_bn" }]] });
      }
      default: return;
    }
  } catch (err) {
    await bnFail(ctx, err, "admin_bn");
  }
});

// ============================================================
// ADMIN: MONEY RESTRICTIONS (main admin only)
// ============================================================
bot.callbackQuery(/^fr_u_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    const admin = await frAdminOnly(ctx);
    if (!admin) return respond("reply", ctx, "⛔ You are not authorized.");
    const userId = Number(ctx.match[1]);
    const status = await db.getFinancialStatus(userId);
    if (!status?.target) return respond("reply", ctx, "❌ User not found.");
    if (status.target.is_admin) return respond("reply", ctx, "⚠️ Admin accounts cannot be restricted.");
    const v = frUserScreen(status, userId);
    await respond("edit", ctx, v.text, { parse_mode: "Markdown", reply_markup: v.reply_markup });
  } catch (err) {
    console.error("fr_u error:", err);
    await respond("reply", ctx, "❌ Something went wrong.");
  }
});

async function frApplyUser(ctx, userId, action, blocked) {
  const admin = await frAdminOnly(ctx);
  if (!admin) return respond("reply", ctx, "⛔ You are not authorized.");
  const result = await db.setUserFinancialRestriction(admin.id, userId, action, blocked, null);
  const v = frUserScreen(result.status, userId);
  try {
    await respond("edit", ctx, v.text, { parse_mode: "Markdown", reply_markup: v.reply_markup });
  } catch (_) { /* the screen was already identical */ }
  if (result.changed && result.changed.length) {
    await frNotifyUser(result.target_telegram_id, result.changed, blocked);
  }
}

// switch one feature
bot.callbackQuery(/^fr_ut_(\d+)_(d|w|tm|tp)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    const userId = Number(ctx.match[1]);
    const code = ctx.match[2];
    const status = await db.getFinancialStatus(userId);
    const nowBlocked = status?.user?.[FR_FEATURES[code].key + "_blocked"] === true;
    await frApplyUser(ctx, userId, FR_ACTION_BY_CODE[code], !nowBlocked);
  } catch (err) {
    console.error("fr_ut error:", err);
    await respond("reply", ctx, "❌ " + (err.message || "Something went wrong."));
  }
});

// block / allow a group (all transfers, or everything)
bot.callbackQuery(/^fr_ux_(\d+)_(t|a)_(0|1)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    await frApplyUser(ctx, Number(ctx.match[1]), FR_ACTION_BY_CODE[ctx.match[2]], ctx.match[3] === "1");
  } catch (err) {
    console.error("fr_ux error:", err);
    await respond("reply", ctx, "❌ " + (err.message || "Something went wrong."));
  }
});

// ---- system-wide ----
async function showFrSystem(ctx) {
  const status = await db.getFinancialStatus(null);
  const v = frSystemScreen(status);
  try {
    await respond("edit", ctx, v.text, { parse_mode: "Markdown", reply_markup: v.reply_markup });
  } catch (_) { /* the screen was already identical */ }
}

bot.callbackQuery("fr_s", async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    if (!(await frAdminOnly(ctx))) return respond("reply", ctx, "⛔ You are not authorized.");
    await showFrSystem(ctx);
  } catch (err) {
    console.error("fr_s error:", err);
    await respond("reply", ctx, "❌ Something went wrong.");
  }
});

// pausing asks for a confirmation; resuming does not
bot.callbackQuery(/^fr_st_(d|w|tm|tp|t|a)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    const admin = await frAdminOnly(ctx);
    if (!admin) return respond("reply", ctx, "⛔ You are not authorized.");
    const code = ctx.match[1];
    // a single feature that is already paused is simply resumed
    if (FR_FEATURES[code]) {
      const status = await db.getFinancialStatus(null);
      if (status?.system?.[FR_FEATURES[code].key]?.enabled === false) {
        await db.setSystemFinancialFlag(admin.id, FR_ACTION_BY_CODE[code], true, null);
        return showFrSystem(ctx);
      }
    }
    const what = code === "a" ? "ALL money features (deposit, withdraw, transfers)"
      : code === "t" ? "ALL transfers"
      : FR_FEATURES[code].en;
    await respond("edit", ctx, 
      `⚠️ *Pause ${what} for EVERY user?*\n\nNobody will be able to use it until you resume it.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Yes, pause it", callback_data: `fr_sy_${code}` }],
            [{ text: "↩️ Cancel", callback_data: "fr_s" }]
          ]
        }
      }
    );
  } catch (err) {
    console.error("fr_st error:", err);
    await respond("reply", ctx, "❌ Something went wrong.");
  }
});

bot.callbackQuery(/^fr_sy_(d|w|tm|tp|t|a)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    const admin = await frAdminOnly(ctx);
    if (!admin) return respond("reply", ctx, "⛔ You are not authorized.");
    await db.setSystemFinancialFlag(admin.id, FR_ACTION_BY_CODE[ctx.match[1]], false, null);
    await showFrSystem(ctx);
  } catch (err) {
    console.error("fr_sy error:", err);
    await respond("reply", ctx, "❌ " + (err.message || "Something went wrong."));
  }
});

bot.callbackQuery(/^fr_sr_(t|a)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    const admin = await frAdminOnly(ctx);
    if (!admin) return respond("reply", ctx, "⛔ You are not authorized.");
    await db.setSystemFinancialFlag(admin.id, FR_ACTION_BY_CODE[ctx.match[1]], true, null);
    await showFrSystem(ctx);
  } catch (err) {
    console.error("fr_sr error:", err);
    await respond("reply", ctx, "❌ " + (err.message || "Something went wrong."));
  }
});

bot.callbackQuery("admin_manage_user", async (ctx) => {

  try {

    await ctx.answerCallbackQuery();

    const admin =
      await db.getAdminByTelegramId(ctx.from.id);

    // Only main admin can manage users
    if (
      !admin ||
      admin.admin_role !== "main"
    ) {

      return respond("reply", ctx, 
        "⛔ You are not authorized to use this feature."
      );

    }

    pendingAdminUserSearch.set(
      ctx.from.id,
      {
        step: "waiting_phone"
      }
    );

    await respond("edit", ctx, 

      `👤 *Manage User*\n\n` +
      `Send the user's phone number.\n\n` +
      `Example:\n` +
      `\`0912345678\`\n` +
      `or\n` +
      `\`+251912345678\``,

      {
        parse_mode: "Markdown",

        reply_markup: {

          inline_keyboard: [
            [
            {
              text: "🏠 Home",
              callback_data:
                "admin_home"
            }
          ],

            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_manage_user_cancel"
              }
            ]

          ]

        }

      }

    );

  } catch (error) {

    console.error(
      "Admin manage user error:",
      error
    );

    await respond("reply", ctx, 
      "❌ Something went wrong."
    );

  }

});

  
bot.callbackQuery(
  /^admin_block_user_(\d+)$/,
  async (ctx) => {

    try {

      await ctx.answerCallbackQuery();

      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {

        return respond("reply", ctx, 
          "⛔ You are not authorized."
        );

      }

      const userId =
        Number(ctx.match[1]);

      const updatedUser =
        await db.setUserBlocked(
          userId,
          true
        );

      if (!updatedUser) {

        return respond("reply", ctx, 
          "❌ User not found."
        );

      }

      await respond("edit", ctx, 

        `🚫 *User Blocked Successfully*\n\n` +

        `👤 Name: *${mdEsc(updatedUser.name || "Unknown")}*\n` +

        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +

        `The user can no longer access the bot.`,

        {
          parse_mode: "Markdown",

          reply_markup: {

            inline_keyboard: [

              [
                {
                  text: "👤 Manage Another User",
                  callback_data:
                    "admin_manage_user"
                }
              ],

              [
                {
                  text: "❌ Close",
                  callback_data:
                    "admin_manage_user_cancel"
                }
              ]

            ]

          }

        }

      );

    } catch (error) {

      console.error(
        "Block user error:",
        error
      );

      await respond("reply", ctx, 
        "❌ Failed to block user."
      );

    }

  }
);

bot.callbackQuery(
  /^set_admin_(main|statistics|withdrawal|broadcast)_(\d+)$/,
  async (ctx) => {
    try {
      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        return await ctx.answerCallbackQuery({
          text: "❌ Unauthorized",
          show_alert: true
        });
      }

      const role =
        ctx.match[1];

      const userId =
        Number(ctx.match[2]);

      // Never allow changing yourself
      if (
        String(userId) ===
        String(admin.id)
      ) {
        return await ctx.answerCallbackQuery({
          text: "⚠️ You cannot change your own role.",
          show_alert: true
        });
      }

      const updatedUser =
        await db.setUserAdminRole(
          userId,
          role
        );

      if (!updatedUser) {
        return await ctx.answerCallbackQuery({
          text: "❌ User not found.",
          show_alert: true
        });
      }

      await ctx.answerCallbackQuery({
        text: "✅ Admin role updated."
      });

      const roleNames = {
        main: "👑 Main Admin",
        statistics: "📊 Statistics Admin",
        withdrawal: "💸 Withdrawal Admin",
        broadcast: "📢 Broadcast Admin"
      };

      await respond("edit", ctx, 
        `✅ *Admin Role Updated*\n\n` +
        `👤 Name: *${mdEsc(updatedUser.name || "Unknown")}*\n` +
        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +
        `🔐 New Role: *${roleNames[role]}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👑 Manage Another Admin",
                  callback_data:
                    "admin_manage_admins"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Set admin role error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Failed to update admin role."
      );
    }
  }
);
bot.callbackQuery(
  /^remove_admin_(\d+)$/,
  async (ctx) => {
    try {
      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        return await ctx.answerCallbackQuery({
          text: "❌ Unauthorized",
          show_alert: true
        });
      }

      const userId =
        Number(ctx.match[1]);

      if (
        String(userId) ===
        String(admin.id)
      ) {
        return await ctx.answerCallbackQuery({
          text: "⚠️ You cannot remove your own admin rights.",
          show_alert: true
        });
      }

      const updatedUser =
        await db.removeUserAdminRole(
          userId
        );

      if (!updatedUser) {
        return await ctx.answerCallbackQuery({
          text: "❌ User not found.",
          show_alert: true
        });
      }

      await ctx.answerCallbackQuery({
        text: "🚫 Admin rights removed."
      });

      await respond("edit", ctx, 
        `🚫 *Admin Rights Removed*\n\n` +
        `👤 Name: *${mdEsc(updatedUser.name || "Unknown")}*\n` +
        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +
        `The user is now a normal user.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👑 Manage Another Admin",
                  callback_data:
                    "admin_manage_admins"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Remove admin role error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Failed to remove admin rights."
      );
    }
  }
);

bot.callbackQuery(
  "admin_manage_admins_cancel",
  async (ctx) => {
    await ctx.answerCallbackQuery();

    pendingAdminRoleSearch.delete(
      ctx.from.id
    );

    await respond("edit", ctx, 
      "❌ Admin management cancelled."
    );
  }
);

bot.callbackQuery(
  /^admin_unblock_user_(\d+)$/,
  async (ctx) => {

    try {

      await ctx.answerCallbackQuery();

      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {

        return respond("reply", ctx, 
          "⛔ You are not authorized."
        );

      }

      const userId =
        Number(ctx.match[1]);

      const updatedUser =
        await db.setUserBlocked(
          userId,
          false
        );

      if (!updatedUser) {

        return respond("reply", ctx, 
          "❌ User not found."
        );

      }

      await respond("edit", ctx, 

        `✅ *User Unblocked Successfully*\n\n` +

        `👤 Name: *${mdEsc(updatedUser.name || "Unknown")}*\n` +

        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +

        `The user can access the bot again.`,

        {
          parse_mode: "Markdown",

          reply_markup: {

            inline_keyboard: [

              [
                {
                  text: "👤 Manage Another User",
                  callback_data:
                    "admin_manage_user"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ],

              [
                {
                  text: "❌ Close",
                  callback_data:
                    "admin_manage_user_cancel"
                }
              ]

            ]

          }

        }

      );

    } catch (error) {

      console.error(
        "Unblock user error:",
        error
      );

      await respond("reply", ctx, 
        "❌ Failed to unblock user."
      );

    }

  }
);

bot.callbackQuery(
  "admin_manage_user_cancel",
  async (ctx) => {

    try {

      await ctx.answerCallbackQuery();

      pendingAdminUserSearch.delete(
        ctx.from.id
      );

      await respond("edit", ctx, 
        "❌ User management cancelled."
      );

    } catch (error) {

      console.error(
        "Admin manage user cancel error:",
        error
      );

    }

  }
);

// ============================================================
// ADMIN: TOP DEPOSITORS / TOP WITHDRAWERS
// callback: admin_top_<d|w>_<all|30|7>
// ============================================================
const TOP_PERIODS = { all: [null, "All time"], "30": [30, "30 days"], "7": [7, "7 days"] };

bot.callbackQuery(/^admin_top_(d|w)_(all|30|7)$/, async (ctx) => {
  try {
    await answerCallback(ctx);
    const admin = await getCurrentAdminPermission(ctx, "statistics");
    if (!admin) return;
    const kind = ctx.match[1];
    const per = ctx.match[2];
    const [days, perLabel] = TOP_PERIODS[per];
    const rows = kind === "d" ? await db.getTopDepositors(days, 10) : await db.getTopWithdrawers(days, 10);
    const medals = ["🥇", "🥈", "🥉"];
    const title = kind === "d" ? "💎 <b>Top Depositors</b>" : "🏧 <b>Top Withdrawers</b> (approved)";
    const lastLabel = kind === "d" ? "Last deposit" : "Last withdrawal";
    const body = rows.length
      ? rows.map((r, i) =>
          `${medals[i] || `${i + 1}.`} <b>${htmlEsc(r.name || "Unknown")}</b>\n` +
          `    📱 <code>${htmlEsc(r.phone || "N/A")}</code>\n` +
          `    💰 <b>${histMoney(r.total)} ETB</b> · ${r.n} ${kind === "d" ? "deposit" : "withdrawal"}${r.n === 1 ? "" : "s"}\n` +
          `    🕒 ${lastLabel}: ${htmlEsc(r.last_at || "—")}`
        ).join("\n\n")
      : "No data for this period.";
    const tab = (k, label) => ({ text: (k === kind ? "• " : "") + label, callback_data: `admin_top_${k}_${per}` });
    const pbtn = (p) => ({ text: (p === per ? "• " : "") + TOP_PERIODS[p][1], callback_data: `admin_top_${kind}_${p}` });
    await respond("edit", ctx, `${title}\n<i>${perLabel} · times in Ethiopia time</i>\n\n${body}`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [tab("d", "💎 Depositors"), tab("w", "🏧 Withdrawers")],
          [pbtn("all"), pbtn("30"), pbtn("7")],
          [{ text: "⬅️ Statistics", callback_data: "admin_statistics_menu" }, { text: "🏠 Home", callback_data: "admin_home" }]
        ]
      }
    });
  } catch (err) {
    if (/message is not modified/i.test(String(err.message))) return;
    console.error("Top depositors error:", err);
    await respond("reply", ctx, "❌ Could not load the ranking.");
  }
});

// ============================================================
// ADMIN STATISTICS MENU
// ============================================================

bot.callbackQuery(
  "admin_statistics_menu",
  async (ctx) => {

    try {

      await answerCallback(ctx);

      const admin =
        await getCurrentAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      await respond("edit", ctx, 
        "📊 *STATISTICS*\n\n" +
        "Choose the type of statistics you want to view:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [

              [
                {
                  text: "📊 General Statistics",
                  callback_data: "admin_statistics"
                }
              ],

              [
                {
                  text: "💰 Financial Statistics",
                  callback_data: "admin_financial_statistics"
                }
              ],

              [
                {
                  text: "👤 User Financial Statistics",
                  callback_data: "admin_user_financial_statistics"
                }
              ],

              [
                {
                  text: "🏆 Top Depositors & Withdrawers",
                  callback_data: "admin_top_d_all"
                }
              ],

              [
                {
                  text: "🏠 Home",
                  callback_data: "admin_home"
                }
              ]

            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin statistics menu error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not open statistics."
      );

    }

  }
);
// ============================================================
// ADMIN FINANCIAL STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_financial_statistics",
  async (ctx) => {
    try {
      await answerCallback(ctx);

      const admin =
        await getCurrentAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      const stats =
        await db.getAdminFinancialStatistics();

      let message =
        "💰 *FINANCIAL STATISTICS*\n\n";

      // ========================================================
      // PAYMENT ACCOUNTS
      // ========================================================

      message +=
        "💳 *PAYMENT ACCOUNTS*\n\n";

      if (
        !stats.accounts ||
        stats.accounts.length === 0
      ) {
        message +=
          "No payment accounts found.\n\n";
      } else {
        stats.accounts.forEach(
          (account, index) => {
            message +=
              `${index + 1}. ` +
              `${account.paymentMethodEmoji} ` +
              `*${account.accountName}*\n`;

            message +=
              `📱 Account: \`${account.accountNumber}\`\n`;

            message +=
              `💳 Method: *${account.paymentMethodName}*\n`;

            message +=
              `💰 Balance: *${account.balance.toFixed(2)} ETB*\n\n`;

            message +=
              `💎 Deposits: *${account.depositCount}*\n`;

            message +=
              `   💰 Amount: *${account.depositAmount.toFixed(2)} ETB*\n`;

            message +=
              `🏧 Withdrawals: *${account.withdrawalCount}*\n`;

            message +=
              `   💰 Amount: *${account.withdrawalAmount.toFixed(2)} ETB*\n\n`;

            message +=
              "────────────────────\n\n";
          }
        );
      }

      // ========================================================
      // OVERALL TOTALS
      // ========================================================

      message +=
        "📊 *OVERALL TOTALS*\n\n";

      message +=
        `💎 Total Deposits: *${stats.totalDepositCount}*\n`;

      message +=
        `💰 Deposit Amount: *${stats.totalDepositAmount.toFixed(2)} ETB*\n\n`;

      message +=
        `🏧 Total Withdrawals: *${stats.totalWithdrawalCount}*\n`;

      message +=
        `💰 Withdrawal Amount: *${stats.totalWithdrawalAmount.toFixed(2)} ETB*`;

      await respond("edit", ctx, 
        message,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Refresh",
                  callback_data:
                    "admin_financial_statistics"
                }
              ],
              [
                {
                  text: "⬅️ Statistics",
                  callback_data:
                    "admin_statistics_menu"
                },
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Admin financial statistics error:",
        err
      );

      try {
        await respond("edit", ctx, 
          "❌ Could not load financial statistics.",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⬅️ Statistics",
                    callback_data:
                      "admin_statistics_menu"
                  },
                  {
                    text: "🏠 Home",
                    callback_data:
                      "admin_home"
                  }
                ]
              ]
            }
          }
        );
      } catch (editError) {
        console.error(
          "Could not display financial statistics error:",
          editError
        );
      }
    }
  }
);
// ============================================================
// ADMIN USER FINANCIAL STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_user_financial_statistics",
  async (ctx) => {

    try {

      await answerCallback(ctx);

      const admin =
        await getCurrentAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      clearPendingState(ctx.from.id);

      pendingAdminRoleSearch.set(
        ctx.from.id,
        {
          step: "financial_statistics_phone"
        }
      );

      await respond("edit", ctx, 
        "👤 *USER FINANCIAL STATISTICS*\n\n" +
        "Please send the user's phone number.\n\n" +
        "Example:\n" +
        "`0912345678`\n" +
        "or\n" +
        "`+251912345678`",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Statistics",
                  callback_data:
                    "admin_statistics_menu"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin user financial statistics search error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Something went wrong."
      );

    }

  }
);
// ============================================================
// ADMIN STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_statistics",
  async (ctx) => {

    try {

      await answerCallback(ctx);

      // ------------------------------------------
      // Verify admin
      // ------------------------------------------

      const admin =
  await getCurrentAdminPermission(
    ctx,
    "statistics"
  );

if (!admin) {
  return;
}


      // ------------------------------------------
      // Get statistics
      // ------------------------------------------

      const stats =
        await db.getAdminStatistics();


      // ------------------------------------------
      // Display statistics
      // ------------------------------------------

      const message =
        `📊 *${mdEsc(BOT_TITLE.toUpperCase())} STATISTICS*\n\n` +

        `💸 *Withdrawals*\n` +
        `⏳ Pending: *${stats.pendingWithdrawals}*\n` +
        `✅ Approved: *${stats.approvedWithdrawals}*\n` +
        `❌ Rejected: *${stats.rejectedWithdrawals}*\n\n` +

        `👥 *Users*\n` +
        `🟢 Active Users: *${stats.activeUsers}*\n` +
        `⚪ Inactive Users: *${stats.inactiveUsers}*\n` +
        `🔴 Blocked Users: *${stats.blockedUsers}*\n\n` +

        `👑 Main Admin: *${stats.mainAdmin}*\n` +
        `📊 Statistics Admin: *${stats.statisticsAdmin}*\n` +
        `💸 Withdrawal Admin: *${stats.withdrawalAdmin}*\n` +
        `📢 Broadcast Admin: *${stats.broadcastAdmin}*`;


      await respond("reply", ctx, 
        message,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Refresh",
                  callback_data: "admin_statistics"
                }
              ],
              [
                {
                   text: "⬅️ Statistics",
                   callback_data:
                   "admin_statistics_menu"
                },
                {
                  text: "🏠 Home",
                  callback_data: "admin_home"
                }
              ]
            ]
          }
        }
      );


    } catch (err) {

      console.error(
        "Admin statistics error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not load statistics."
      );

    }

  }
);
// ============================================================
// ADMIN — PAYMENT ACCOUNT MANAGEMENT
// ============================================================
//
// Flow:
//
// Accounts
//    ├── Add Account
//    │      └── Payment Method
//    │             └── Account Name
//    │                    └── Account Number
//    │                           └── Initial Balance
//    │                                  └── Save
//    │
//    └── Manage Accounts
//           └── Activate / Deactivate
//
// Account-number normalization:
// ONLY Mobile / ሞባይል is normalized.
// ============================================================


// ============================================================
// SHOW PAYMENT ACCOUNTS MENU
// ============================================================

// ============================================================
// SHOW PAYMENT ACCOUNTS MENU
// ============================================================

async function showAdminAccounts(ctx) {
  const admin = await getCurrentAdmin(ctx);

  if (!admin) {
    return;
  }

  try {
    const accounts =
      await db.getAllPaymentAccountsForAdmin();

    let message =
      "💳 *PAYMENT ACCOUNTS*\n\n";

    if (!accounts || accounts.length === 0) {
      message +=
        "No payment accounts have been created yet.\n\n";
    } else {
      accounts.forEach((account, index) => {
        const methodName =
          account.pm_amharic_name ||
          account.pm_name ||
          "Payment Method";

        const typeName =
          account.pt_amharic_name ||
          account.pt_name ||
          "";

        const activeStatus =
          account.is_active
            ? "🟢 Active"
            : "🔴 Inactive";

        const removedStatus =
          account.is_removed
            ? "🗑️ Removed"
            : "✅ Not removed";

        message +=
          `${index + 1}. ${account.pm_emoji || "💳"} *${account.account_name}*\n` +
          `💳 Method: *${methodName}*\n`;

        if (typeName) {
          message +=
            `📂 Type: *${typeName}*\n`;
        }

        message +=
          `📱 Account: \`${account.account_number}\`\n` +
          `💰 Balance: *${account.balance} ETB*\n` +
          `📌 Status: ${activeStatus}\n\n`;
      });
    }

    const keyboard = [];

    // ----------------------------------------------------------
    // ACCOUNT ACTION BUTTONS
    // ----------------------------------------------------------

    if (accounts && accounts.length > 0) {
      for (const account of accounts) {

        // Edit
        keyboard.push([
          {
            text:
              `✏️ Edit ${account.account_name}`,
            callback_data:
              `admin_account_edit_${account.id}`
          }
        ]);

        // Activate / Deactivate
        keyboard.push([
          {
            text:
              account.is_active
                ? `🔴 Deactivate ${account.account_name}`
                : `🟢 Activate ${account.account_name}`,

            callback_data:
              `admin_account_toggle_${account.id}_${account.is_active ? "0" : "1"}`
          }
        ]);

        // Remove (asks for confirmation; removed accounts disappear from this list)
        keyboard.push([
          {
            text: `🗑️ Remove ${account.account_name}`,
            callback_data: `admin_account_rmc_${account.id}`
          }
        ]);
      }
    }

    // ----------------------------------------------------------
    // MAIN BUTTONS
    // ----------------------------------------------------------

    keyboard.push([
      {
        text: "➕ Add Account",
        callback_data: "admin_account_add"
      }
    ]);

    let removedCount = 0;
    try { removedCount = await db.countRemovedPaymentAccounts(); } catch (err) { console.error("countRemovedPaymentAccounts:", err.message); }
    keyboard.push([
      {
        text: removedCount > 0 ? `♻️ Restore a removed account (${removedCount})` : "♻️ Restore a removed account",
        callback_data: "admin_account_rsearch"
      }
    ]);

    keyboard.push([
      {
        text: "🔄 Refresh",
        callback_data: "admin_accounts"
      },
      {
        text: "🏠 Home",
        callback_data: "admin_home"
      }
    ]);

    const options = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: keyboard
      }
    };

    if (ctx.callbackQuery) {
      try {
        await respond("edit", ctx, 
          message,
          options
        );
      } catch (err) {
        await respond("reply", ctx, 
          message,
          options
        );
      }
    } else {
      await respond("reply", ctx, 
        message,
        options
      );
    }

  } catch (err) {
    console.error(
      "Admin accounts screen error:",
      err
    );

    await respond("reply", ctx, 
      "❌ Could not load payment accounts."
    );
  }
}


// ============================================================
// ADMIN ACCOUNTS BUTTON
// ============================================================

bot.callbackQuery(
  "admin_accounts",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    // Do not leave an unfinished account creation flow.
    delete pendingAdminAccount[
      admin.telegram_id
    ];

    await showAdminAccounts(
      ctx
    );

  }
);


// ============================================================
// ADD ACCOUNT — SELECT PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  "admin_account_add",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    try {

      const paymentMethods =
        await db.getPaymentMethods();

      if (
        !paymentMethods ||
        paymentMethods.length === 0
      ) {

        return respond("reply", ctx, 
          "❌ No active payment methods are available."
        );

      }


      const keyboard =
        paymentMethods.map(
          (pm) => [

            {
              text:
                `${pm.emoji || "💳"} ${pm.amharic_name || pm.name}`,

              callback_data:
                `admin_account_method_${pm.id}`
            }

          ]
        );


      keyboard.push([
        {
          text:
            "↩️ Back",

          callback_data:
            "admin_accounts"
        }
      ]);


      await respond("edit", ctx, 
        "➕ *ADD PAYMENT ACCOUNT*\n\n" +
        "First select the *payment method*:",
        {
          parse_mode:
            "Markdown",

          reply_markup: {
            inline_keyboard:
              keyboard
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin add account method error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not load payment methods."
      );

    }

  }
);


// ============================================================
// ADD ACCOUNT — PAYMENT METHOD SELECTED
// ============================================================

bot.callbackQuery(
  /^admin_account_method_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const paymentMethodId =
      Number(
        ctx.match[1]
      );

    try {

      const method =
        await db.getPaymentMethodById(
          paymentMethodId
        );

      if (!method) {

        return respond("reply", ctx, 
          "❌ Payment method not found."
        );

      }


      pendingAdminAccount[
        admin.telegram_id
      ] = {

        step:
          "account_name",

        paymentMethodId:
          paymentMethodId,

        paymentMethod:
          method,

        paymentTypeName:
          method.type_name,

        paymentTypeAmharicName:
          method.am_type_name

      };


      await respond("edit", ctx, 

        "➕ *ADD PAYMENT ACCOUNT*\n\n" +

        `💳 Payment Method: *${method.amharic_name || method.name}*\n` +

        `📂 Payment Type: *${method.am_type_name || method.type_name || "-"}*\n\n` +

        "Please enter the *account name*.\n\n" +

        "Example:\n" +
        `\`${BOT_NAME} Telebirr\``,

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            inline_keyboard: [

              [

                {

                  text:
                    "❌ Cancel",

                  callback_data:
                    "admin_account_cancel"

                }

              ]

            ]

          }

        }

      );

    } catch (err) {

      console.error(
        "Admin account method selection error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not select the payment method."
      );

    }

  }
);


// ============================================================
// ADD ACCOUNT — CANCEL
// ============================================================

bot.callbackQuery(
  "admin_account_cancel",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    delete pendingAdminAccount[
      admin.telegram_id
    ];

    await showAdminAccounts(
      ctx
    );

  }
);


// ============================================================
// TOGGLE ACCOUNT ACTIVE / INACTIVE
// ============================================================

bot.callbackQuery(
  /^admin_account_toggle_(\d+)_(0|1)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Updating account..."
    );

    const accountId =
      Number(ctx.match[1]);

    const isActive =
      ctx.match[2] === "1";

    try {

      const account =
        await db.setPaymentAccountActive(
          accountId,
          isActive
        );

      if (!account) {
        return respond("reply", ctx, 
          "❌ Payment account not found or it is deleted."
        );
      }

      await showAdminAccounts(ctx);

    } catch (err) {

      console.error(
        "Payment account toggle error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not change the account status."
      );
    }
  }
);

// ============================================================
// DELETE / UNDELETE PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_remove_(\d+)_(0|1)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    const accountId =
      Number(ctx.match[1]);

    const shouldRemove =
      ctx.match[2] === "1";

    await answerCallback(
      ctx,
      shouldRemove
        ? "Deleting account..."
        : "Restoring account..."
    );

    try {

      const account =
        await db.setPaymentAccountRemoved(
          accountId,
          shouldRemove
        );

      if (!account) {
        return respond("reply", ctx, 
          "❌ Payment account not found."
        );
      }

      await showAdminAccounts(ctx);

    } catch (err) {

      console.error(
        "Payment account delete/undelete error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not change the deleted status."
      );
    }
  }
);

// ============================================================
// REMOVE (confirm) / RESTORE BY NUMBER SEARCH
// Removed accounts are hidden from the list; the admin finds one by its number
// and restores it (is_removed = false).
// ============================================================
bot.callbackQuery(/^admin_account_rmc_(\d+)$/, async (ctx) => {
  const admin = await getCurrentAdmin(ctx);
  if (!admin) return;
  await answerCallback(ctx);
  const id = Number(ctx.match[1]);
  try {
    const acc = await db.getPaymentAccountByIdForAdmin(id);
    if (!acc) return respond("reply", ctx, "❌ Payment account not found.");
    await respond("edit", ctx, 
      `🗑 <b>Remove this account?</b>\n\n<b>${htmlEsc(acc.account_name)}</b>\n<code>${htmlEsc(acc.account_number)}</code>\n\n` +
      `It will disappear from the list and players will no longer see it. You can bring it back later with <b>Restore a removed account</b> by searching its number.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🗑 Yes, remove", callback_data: `admin_account_remove_${id}_1` }],
            [{ text: "↩️ Cancel", callback_data: "admin_accounts" }]
          ]
        }
      }
    );
  } catch (err) {
    console.error("account remove confirm error:", err);
    await respond("reply", ctx, "❌ Something went wrong.");
  }
});

bot.callbackQuery("admin_account_rsearch", async (ctx) => {
  const admin = await getCurrentAdmin(ctx);
  if (!admin) return;
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
  pendingRemovedAccountSearch.set(ctx.from.id, Date.now() + 10 * 60 * 1000);
  await respond("reply", ctx, 
    "♻️ <b>Restore a removed account</b>\n\nSend the account number (or the last digits, at least 4).",
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "↩️ Back", callback_data: "admin_accounts" }]] } }
  );
});

async function removedAccountSearchHook(ctx, telegramId, text) {
  const exp = pendingRemovedAccountSearch.get(telegramId);
  if (!exp) return false;
  if (Date.now() > exp || text.startsWith("/")) {
    pendingRemovedAccountSearch.delete(telegramId);
    return false;
  }
  const admin = await getCurrentAdmin(ctx);
  if (!admin) { pendingRemovedAccountSearch.delete(telegramId); return false; }
  const back = [{ text: "↩️ Back", callback_data: "admin_accounts" }];
  const rows = await db.searchRemovedPaymentAccounts(text, 5);
  if (rows === null) {
    await respond("reply", ctx, "❌ Send at least 4 digits of the account number.", { reply_markup: { inline_keyboard: [back] } });
    return true;
  }
  if (!rows.length) {
    await respond("reply", ctx, "🔎 No removed account matches that number. Try again, or go back.", { reply_markup: { inline_keyboard: [back] } });
    return true;
  }
  pendingRemovedAccountSearch.delete(telegramId);
  const kb = rows.map((r) => [{
    text: `♻️ Restore ${String(r.account_name).slice(0, 24)} · ${String(r.account_number).slice(-6)}`,
    callback_data: `admin_account_remove_${r.id}_0`
  }]);
  kb.push(back);
  const body = rows.map((r) =>
    `${r.pm_emoji || "💳"} <b>${htmlEsc(r.account_name)}</b>\n` +
    `${htmlEsc(r.pm_amharic_name || r.pm_name || "")}\n` +
    `<code>${htmlEsc(r.account_number)}</code> · ${htmlEsc(r.balance)} ETB · ${r.is_active ? "🟢 active" : "🔴 inactive"}`
  ).join("\n\n");
  await respond("reply", ctx, `🔎 <b>Removed accounts found</b>\n\n${body}\n\nTap one to restore it.`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
  });
  return true;
}

// ============================================================
// EDIT PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_edit_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const accountId =
      Number(ctx.match[1]);

    try {

      const account =
        await db.getPaymentAccountByIdForAdmin(
          accountId
        );

      if (!account) {
        return respond("reply", ctx, 
          "❌ Payment account not found."
        );
      }

      pendingAdminAccountEdit[
        admin.telegram_id
      ] = {
        step: "account_name",
        accountId,

        originalName:
          account.account_name,

        originalAccountNumber:
          account.account_number,

        originalBalance:
          Number(account.balance),

        accountName:
          account.account_name,

        accountNumber:
          account.account_number,

        balance:
          Number(account.balance),

        paymentTypeName:
          account.pt_name,

        paymentTypeAmharicName:
          account.pt_amharic_name
      };

      await respond("edit", ctx, 
        "✏️ *EDIT PAYMENT ACCOUNT*\n\n" +

        `👤 Current name: *${account.account_name}*\n\n` +

        "Enter the new account name.\n" +
        "Or press *Keep Current* to leave it unchanged.",

        {
          parse_mode: "Markdown",

          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Keep Current",
                  callback_data:
                    `admin_account_edit_keep_name_${accountId}`
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "admin_account_edit_cancel"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Edit payment account start error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not load the payment account."
      );
    }
  }
);
// ============================================================
// EDIT ACCOUNT — CANCEL
// ============================================================

bot.callbackQuery(
  "admin_account_edit_cancel",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    delete pendingAdminAccountEdit[
      admin.telegram_id
    ];

    await showAdminAccounts(ctx);
  }
);

// ============================================================
// EDIT ACCOUNT — CONFIRMATION SCREEN
// ============================================================

async function showAdminAccountEditConfirmation(
  ctx,
  pending
) {

  await respond("edit", ctx, 

    "✏️ *CONFIRM ACCOUNT CHANGES*\n\n" +

    `👤 Name:\n*${pending.accountName}*\n\n` +

    `📱 Account Number:\n\`${pending.accountNumber}\`\n\n` +

    `💰 Balance:\n*${pending.balance} ETB*\n\n` +

    "Are these changes correct?",

    {
      parse_mode: "Markdown",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Save Changes",
              callback_data:
                `admin_account_edit_save_${pending.accountId}`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data:
                "admin_account_edit_cancel"
            }
          ]
        ]
      }
    }
  );
}
// ============================================================
// EDIT ACCOUNT — SAVE
// ============================================================

bot.callbackQuery(
  /^admin_account_edit_save_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Saving changes..."
    );

    const accountId =
      Number(ctx.match[1]);

    const pending =
      pendingAdminAccountEdit[
        admin.telegram_id
      ];

    if (!pending) {
      return respond("reply", ctx, 
        "❌ The edit session has expired. Please try again."
      );
    }

    if (
      Number(pending.accountId) !==
      accountId
    ) {
      return respond("reply", ctx, 
        "❌ Invalid edit session."
      );
    }

    try {

      const result =
        await db.updatePaymentAccount(
          accountId,
          pending.accountName,
          pending.accountNumber,
          pending.balance
        );

      if (!result) {
        return respond("reply", ctx, 
          "❌ Payment account not found or could not be updated."
        );
      }

      delete pendingAdminAccountEdit[
        admin.telegram_id
      ];

      await respond("edit", ctx, 
        "✅ *PAYMENT ACCOUNT UPDATED*\n\n" +

        `👤 Name: *${result.account_name}*\n` +
        `📱 Account: \`${result.account_number}\`\n` +
        `💰 Balance: *${result.balance} ETB*\n\n` +

        "The account has been updated successfully.",

        {
          parse_mode: "Markdown",

          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💳 Accounts",
                  callback_data:
                    "admin_accounts"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Update payment account error:",
        err
      );

      await respond("reply", ctx, 
        `❌ ${err.message || "Could not update the payment account."}`
      );
    }
  }
);
// ============================================================
// EDIT ACCOUNT — TEXT INPUT
// ============================================================


bot.callbackQuery("user_reactivate", async (ctx) => {
  await answerCallback(ctx);
  const telegramId = ctx.from.id;
  try {
    const existing = await db.getUserByTelegramIdIncludingInactive(telegramId);
    if (!existing) return respond("reply", ctx, "❌ Account not found. Send /start to register.");
    if (existing.is_blocked === true) return respond("reply", ctx, "🚫 Your account has been blocked. Please contact support.");
    if (existing.is_active !== false) {
      return showHome(ctx, existing);
    }
    const reactivated = await db.reactivateUserByTelegramId(telegramId);
    if (!reactivated) return respond("reply", ctx, "❌ Could not reactivate your account.");
    try {
      await respond("edit", ctx, 
        tr(await getLang(telegramId), "reactivated"),
        { parse_mode: "Markdown" }
      );
    } catch (_) {}
    return await showHome(ctx, reactivated);
  } catch (err) {
    console.error("Reactivate error:", err);
    await respond("reply", ctx, await T(ctx, "err_generic"));
  }
});

// ============================================================
// /START
// ============================================================

bot.command(
  "start",
  async (ctx) => {

    const telegramId =
      ctx.from.id;

    const firstName =
      ctx.from.first_name ||
      "Player";


    clearPendingState(
      telegramId
    );   


    try {

      const existing =  await db.getUserByTelegramIdIncludingInactive(telegramId);

if (existing) {

  // Banned users should remain blocked
  if (existing.is_blocked === true) {

   return respond("reply", ctx, 
    tr(await getLang(telegramId), "reg_blocked")
  );

  }

  // Paused account: the user must tap Reactivate (a bare /start - e.g. Telegram's
  // automatic Start button after un-blocking the bot - must not silently turn messages back on)
  if (existing.is_active === false) {

    const lang = await getLang(telegramId);
    return await respond("reply", ctx, 
      tr(lang, "paused_start"),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: tr(lang, "btn_reactivate"), callback_data: "user_reactivate" }
          ]]
        }
      }
    );
  }

  return await showHome(
    ctx,
    existing,
    { photo: true }
  );
}


      // ------------------------------------------------------
      // New user: straight to the contact button (name comes from the Telegram profile)
      // ------------------------------------------------------
      return await askForContact(ctx);

    } catch (err) {

      console.error(
        "Start error:",
        err
      );

      await respond("reply", ctx, 
        await T(ctx, "err_generic")
      );

    }

  }
);





// ============================================================
// REGISTRATION CONTACT
// ============================================================

bot.on("message:contact", async (ctx) => {
  const telegramId = ctx.from.id;
  const contact = ctx.message.contact;
  const lang = langHint(ctx);

  // only the number the button shares counts: it always carries the sender's own Telegram id
  if (!contact.user_id || contact.user_id !== telegramId) {
    return respond("reply", ctx, tr(lang, "reg_own_only"), { reply_markup: contactKeyboard(lang) });
  }

  try {
    const existing = await db.getUserByTelegramIdIncludingInactive(telegramId);
    if (existing) {                                   // already registered: just show the menu
      if (existing.is_blocked === true) return respond("reply", ctx, tr(lang, "reg_blocked"), { reply_markup: { remove_keyboard: true } });
      if (existing.is_active === false) return respond("reply", ctx, tr(lang, "paused_start"), { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
      return await showHome(ctx, existing);
    }

    const phone = contact.phone_number;
    const result = await db.registerUser(telegramId, telegramDisplayName(ctx.from), phone);

    if (result.status === "banned") {
      return respond("reply", ctx, tr(lang, "reg_blocked"), { reply_markup: { remove_keyboard: true } });
    }

    const user = result.user;
    clearPendingState(telegramId);

        await respond("reply", ctx, 
      tr(lang, "reg_done", mdEsc(user.name), phone),
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
    );

    // sign-up bonus: only for a brand-new account (not for someone who reconnects an old one), sent right away
    if (result.status === "new") {
      const gift = await db.awardSignupBonus(user.id);
      if (gift.awarded) {
        await respond("reply", ctx, tr(lang, "signup_bonus", gift.amount), { parse_mode: "Markdown" });
      }
    }

    await showHome(ctx, user, { photo: true });

  } catch (err) {
    console.error("Registration error:", err);
    if (/Invalid Ethiopian phone number/i.test(err.message || "")) {
      return respond("reply", ctx, tr(lang, "reg_phone_invalid"), { reply_markup: contactKeyboard(lang) });
    }
    return respond("reply", ctx, tr(lang, "reg_failed"));
  }
});



// ============================================================
// BALANCE
// ============================================================

async function showBalance(
  ctx
) {

  const userwallets =
    await db.getUserWalletBalances(
      ctx.from.id
    );
  

  if (!userwallets) {

    return respond("reply", ctx, 
      await T(ctx, "start_first")
    );

  }


 /* await respond("reply", ctx, 

    `Main Wallet: *${userwallets.main_balance} ETB*\n\n` + 
    `Play Wallet: *${userwallets.play_balance} ETB*\n\n` + 
    `Bonus Wallet: *${userwallets.bonus_balance} ETB*\n\n` + 
    `Total Balance: *${userwallets.total_balance} ETB*\n\n`,

    {

      parse_mode:
        "Markdown"

    }

  );*/

  const text = await T(ctx, "balance_text", userwallets);

  await respond("reply", ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: await T(ctx, "balance_btn_deposit"),
            callback_data: "user_deposit"
          },
          {
            text: await T(ctx, "balance_btn_withdraw"),
            callback_data: "user_withdraw"
          }
        ]
      ]
    }
  });

}


bot.command("balance",showBalance);
bot.command("deposit",showDeposit);
bot.command("withdraw",showWithdrawal);
bot.command("transfer",showTransfer);
bot.command("support",showSupport);
bot.command("statistics", async (ctx) => { clearPendingState(ctx.from.id); await showUserStatistics(ctx); });   // same screen as the Statistics button

// /language and /pause: the same screens as the Language and Pause buttons of the home menu, as commands
async function showLanguageCommand(ctx) {
  try {
    const lang = await getLang(ctx.from.id);
    await respond("reply", ctx, tr(lang, "lang_title"), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: (lang === "am" ? "✅ " : "") + "አማርኛ", callback_data: "user_lang_am" },
            { text: (lang === "en" ? "✅ " : "") + "English", callback_data: "user_lang_en" }
          ],
          [{ text: tr(lang, "btn_home"), callback_data: "user_home" }]
        ]
      }
    });
  } catch (err) {
    console.error("/language error:", err);
  }
}
async function showPauseCommand(ctx) {
  try {
    clearPendingState(ctx.from.id);
    const lang = await getLang(ctx.from.id);
    const user = await db.getUserByTelegramId(ctx.from.id);
    if (!user) return await respond("reply", ctx, await T(ctx, "start_first"));
    await respond("reply", ctx, tr(lang, "pause_confirm"), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: tr(lang, "yes"), callback_data: "user_confirm_delete" },
          { text: tr(lang, "no"), callback_data: "user_cancel_delete" }
        ]]
      }
    });
  } catch (err) {
    console.error("/pause error:", err);
  }
}
bot.command("language", showLanguageCommand);
bot.command("pause", showPauseCommand);


bot.hears("balance", showBalance);
bot.hears("💰 Balance", showBalance);
bot.hears("deposit", showDeposit);
bot.hears("deposit", showDeposit);
bot.hears("withdraw", showWithdrawal);
bot.hears("🏧 Withdraw", showWithdrawal);
bot.hears("Transfer", showTransfer);
bot.hears("🏧 Transfer", showTransfer);
bot.hears("support", showSupport);
bot.hears("support", showSupport);
bot.hears("🎮 Play", showPlay);
bot.hears("🎮 Play", showPlay);

bot.callbackQuery(
  "user_balance",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    await showBalance(ctx);
  }
);

// ============================================================
// TRANSFER
// ============================================================

// ============================================================
// TRANSFER HELPERS
// ============================================================

async function notifyTransferReceiver({
  receiverTelegramId,
  senderName,
  senderPhone,
  amount,
  walletType,
  transactionId
}) {
  if (!receiverTelegramId) {
    console.warn(
      "Transfer succeeded but receiver has no Telegram ID:",
      transactionId
    );

    return false;
  }

  const rLang = await getLang(receiverTelegramId);

  const message = tr(rLang, "tr_received", {
    amount: formatTransferAmount(amount),
    walletName: getWalletDisplayName(walletType, rLang),
    senderName, senderPhone, transactionId
  });

  try {

    await respond("send", 
      receiverTelegramId,
      message,
      {
        parse_mode: "Markdown"
      }
    );

    console.log(
      `Transfer notification sent to receiver ${receiverTelegramId}`
    );

    return true;

  } catch (err) {

    /*
     * IMPORTANT:
     *
     * The transfer has already succeeded.
     * Never throw this error back into the
     * transfer transaction and never reverse
     * the wallet transfer because Telegram
     * notification failed.
     */
    console.error(
      "Failed to notify transfer receiver:",
      err
    );

    return false;
  }
}

const TRANSFER_SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes

const TRANSFER_STATES = {
  CHOOSE_WALLET: "choose_wallet",
  ENTER_PHONE: "enter_phone",
  CONFIRM_RECIPIENT: "confirm_recipient",
  ENTER_AMOUNT: "enter_amount",
  CONFIRM_TRANSFER: "confirm_transfer"
};

function createTransferState(telegramId, walletType = null) {
  const state = {
    state: walletType
      ? TRANSFER_STATES.ENTER_PHONE
      : TRANSFER_STATES.CHOOSE_WALLET,

    walletType,

    receiverPhone: null,
    receiverUserId: null,
    receiverName: null,
    receiverTelegramId: null,

    amount: null,

    limits: null,

    idempotencyKey: null,

    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSFER_SESSION_TIMEOUT
  };

  pendingTransfer[telegramId] = state;

  return state;
}

function getTransferState(telegramId) {
  const state = pendingTransfer[telegramId];

  if (!state) {
    return null;
  }

  if (
    state.expiresAt &&
    Date.now() > state.expiresAt
  ) {
    delete pendingTransfer[telegramId];
    return null;
  }

  return state;
}

function refreshTransferExpiry(state) {
  if (!state) {
    return;
  }

  state.expiresAt =
    Date.now() + TRANSFER_SESSION_TIMEOUT;
}

function generateTransferIdempotencyKey(
  telegramId,
  walletType
) {
  return [
    "telegram-transfer",
    telegramId,
    walletType,
    Date.now(),
    Math.random()
      .toString(36)
      .substring(2, 10)
  ].join("-");
}

function formatTransferAmount(amount) {
  const n = Number(amount);

  if (!Number.isFinite(n)) {
    return "0.00";
  }

  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function getWalletDisplayName(walletType, lang) {
  if (walletType === "main") {
    return tr(lang, "tr_wallet_main");
  }

  if (walletType === "play") {
    return tr(lang, "tr_wallet_play");
  }

  return tr(lang, "tr_wallet");
}

function getTransferWalletKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "tr_wallet_main"),
          callback_data: "transfer_wallet_main"
        },
        {
          text: tr(lang, "tr_wallet_play"),
          callback_data: "transfer_wallet_play"
        }
      ],
      [
        {
          text: tr(lang, "btn_cancel"),
          callback_data: "transfer_cancel"
        }
      ]
    ]
  };
}

function getTransferRecipientKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "tr_btn_continue"),
          callback_data: "transfer_recipient_confirm"
        },
        {
          text: tr(lang, "btn_cancel"),
          callback_data: "transfer_cancel"
        }
      ]
    ]
  };
}

function getTransferConfirmationKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "tr_btn_confirm"),
          callback_data: "transfer_confirm"
        }
      ],
      [
        {
          text: tr(lang, "tr_btn_change"),
          callback_data: "transfer_change_amount"
        }
      ],
      [
        {
          text: tr(lang, "btn_cancel"),
          callback_data: "transfer_cancel"
        }
      ]
    ]
  };
}

function getTransferCancelKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "btn_home"),
          callback_data: "user_home"
        }
      ]
    ]
  };
}




// ============================================================
// DEPOSIT
// ============================================================

async function showDeposit(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return respond("reply", ctx, 
      await T(ctx, "start_first")
    );

  }


  // admin restriction (this user, or deposits paused for everyone)
  if (await replyIfFeatureBlocked(ctx, user, "deposit", await getLang(ctx.from.id))) return;


  const paymentmethods =
    await db.getPaymentMethods();


  const paymentmethodtypes =
    await db.getPaymentMethodTypes();


  if (
    !paymentmethodtypes ||
    paymentmethodtypes.length === 0 ||
    !paymentmethods ||
    paymentmethods.length === 0
  ) {

    return respond("reply", ctx, 
      await T(ctx, "dep_no_methods")
    );

  }


  const lang = await getLang(ctx.from.id);

  const mes = tr(lang, "dep_intro",
    paymentmethods.length,
    paymentmethodtypes.map(type => pmTypeName(type, lang))
  );


  const buttons =
    paymentmethods.map(
      pm => [

        {

          text:
            `${pm.emoji} ${pmName(pm, lang)}`,

          callback_data:
            `payment_${pm.id}`

        }

      ]
    );


  buttons.push([

    {

      text:
        tr(lang, "btn_cancel"),

      callback_data:
        "user_cancel_deposit"

    }

  ]);


  await respond("reply", ctx, 
    mes,
    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          buttons

      }

    }
  );

}


bot.command(
  "deposit",
  showDeposit
);




bot.callbackQuery("user_deposit", async (ctx) => 
  {
      await answerCallback(ctx);
      clearPendingState(ctx.from.id);
      await showDeposit(ctx);
  });


// ============================================================
// TRANSFER — OPEN
// ============================================================
async function showTransfer(ctx) {
  const telegramId = ctx.from.id;

  try {
    const user =
      await db.getUserByTelegramId(
        telegramId
      );

    if (!user) {
      await respond("reply", ctx, 
        await T(ctx, "start_first")
      );
      return;
    }

    const lang = await getLang(telegramId);

    if (
      user.is_active !== true ||
      user.is_blocked === true
    ) {
      await respond("reply", ctx, 
        tr(lang, "tr_not_eligible")
      );
      return;
    }

    // both wallets restricted (or transfers paused): say so instead of showing the wallet choice
    {
      const mainOff = await featureBlockedText(user, "transfer_main", lang);
      const playOff = await featureBlockedText(user, "transfer_play", lang);
      if (mainOff && playOff) {
        await respond("reply", ctx, mainOff);
        return;
      }
    }

    /*
     * Clear any previous transfer session.
     */
    clearPendingState(
      telegramId
    );

    /*
     * Create a fresh transfer session.
     */
    createTransferState(
      telegramId
    );

    /*
     * Display transfer wallet selection.
     */
    await respond("edit", ctx, 
      tr(lang, "tr_menu"),
      {
        parse_mode: "Markdown",
        reply_markup:
          getTransferWalletKeyboard(lang)
      }
    );

  } catch (err) {

    console.error(
      "Open transfer error:",
      err
    );

    console.error(
      err?.stack
    );

    /*
     * Don't send another message if Telegram
     * already successfully edited the menu.
     */
    try {
      await respond("reply", ctx, 
        await T(ctx, "tr_start_fail")
      );
    } catch (replyError) {
      console.error(
        "Transfer error reply failed:",
        replyError
      );
    }
  }
}



bot.callbackQuery(
  "user_transfer",
  async (ctx) => {
    await answerCallback(ctx);
    await showTransfer(ctx);
  }
);

// ============================================================
// TRANSFER — SELECT WALLET
// ============================================================

async function startTransferWalletSelection(ctx, walletType) {
  const telegramId = ctx.from.id;

  try {
    const user = await db.getUserByTelegramId(telegramId);

    if (!user) {
      await respond("reply", ctx, 
        await T(ctx, "start_first")
      );
      return;
    }

    const lang = await getLang(telegramId);

    if (
      user.is_active !== true ||
      user.is_blocked === true ||
      user.is_banned === true
    ) {
      await respond("reply", ctx, 
        tr(lang, "tr_not_eligible")
      );
      return;
    }

    // admin restriction for sending from this wallet
    if (await replyIfFeatureBlocked(ctx, user, "transfer_" + walletType, lang)) return;

    const limits = await db.getTransferLimits(
      user.id,
      walletType
    );

    if (!limits) {
      await respond("reply", ctx, 
        tr(lang, "tr_limits_fail")
      );
      return;
    }

    // ========================================================
    // Current wallet balance
    // ========================================================

    const balance = Number(
      limits.balance || 0
    );

    // ========================================================
    // Minimum amount allowed for one transfer
    // ========================================================

    const minimum = Number(
      limits.minimum_transfer_amount || 0
    );

    // ========================================================
    // Maximum amount allowed for ONE transfer
    // ========================================================

    const maximum =
      limits.maximum_transfer_amount === null ||
      limits.maximum_transfer_amount === undefined
        ? null
        : Number(
            limits.maximum_transfer_amount
          );

    // ========================================================
    // Minimum balance that MUST remain in sender wallet
    // ========================================================

    const minimumRemaining = Number(
      limits.minimum_remaining_balance || 0
    );

    // ========================================================
    // Maximum user can actually transfer RIGHT NOW
    //
    // This should already be calculated by PostgreSQL.
    // We calculate a fallback here as an extra safety measure.
    // ========================================================

    let maximumTransferable;

    if (
      limits.maximum_transferable_now !== null &&
      limits.maximum_transferable_now !== undefined
    ) {
      maximumTransferable = Number(
        limits.maximum_transferable_now
      );
    } else {

      const balanceAvailableAfterMinimum =
        Math.max(
          balance - minimumRemaining,
          0
        );

      maximumTransferable =
        maximum === null
          ? balanceAvailableAfterMinimum
          : Math.min(
              balanceAvailableAfterMinimum,
              maximum
            );
    }

    maximumTransferable = Math.max(
      Number(maximumTransferable) || 0,
      0
    );

    // ========================================================
    // Check whether the user can make the minimum transfer
    // while keeping the required minimum remaining balance.
    // ========================================================

    if (
      balance < minimum ||
      maximumTransferable < minimum
    ) {
      delete pendingTransfer[telegramId];

      await respond("edit", ctx, 
        `${getWalletDisplayName(walletType, lang)}\n\n` +
        tr(lang, "tr_limits_block", formatTransferAmount(balance), formatTransferAmount(minimum), formatTransferAmount(minimumRemaining), formatTransferAmount(maximumTransferable)) +
        `\n\n` + tr(lang, "tr_not_enough_min"),
        {
          parse_mode: "Markdown",
          reply_markup: getTransferCancelKeyboard(lang)
        }
      );

      return;
    }

    /*
     * Create the transfer session only after all
     * preliminary checks have succeeded.
     */

    const state = createTransferState(
      telegramId,
      walletType
    );

    state.limits = limits;

    // Store the calculated value as well.
    state.limits.maximum_transferable_now =
      maximumTransferable;

    refreshTransferExpiry(state);

    // ========================================================
    // Build transfer information message
    // ========================================================

    let message =
      `${getWalletDisplayName(walletType, lang)}\n\n` +
      tr(lang, "tr_limits_now", formatTransferAmount(balance), formatTransferAmount(minimum), formatTransferAmount(minimumRemaining), formatTransferAmount(maximumTransferable)) + "\n";

    // ========================================================
    // Maximum per-transfer rule
    // ========================================================

    if (maximum !== null) {
      message +=
        tr(lang, "tr_max_per", formatTransferAmount(maximum)) + "\n";
    }

    // ========================================================
    // Daily remaining transfer count
    // ========================================================

    if (
      limits.daily &&
      limits.daily.remaining_count !== null &&
      limits.daily.remaining_count !== undefined
    ) {
      message +=
        "\n" + tr(lang, "tr_daily_count", limits.daily.remaining_count);
    }

    // ========================================================
    // Daily remaining amount
    // ========================================================

    if (
      limits.daily &&
      limits.daily.remaining_amount !== null &&
      limits.daily.remaining_amount !== undefined
    ) {
      message +=
        "\n" + tr(lang, "tr_daily_amount", formatTransferAmount(limits.daily.remaining_amount));
    }

    // ========================================================
    // Ask for recipient phone
    // ========================================================

    message += "\n\n" + tr(lang, "tr_ask_phone");

    /*
     * Update the original menu message.
     */

    await respond("edit", ctx, 
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
                            {
                text: tr(lang, "btn_cancel"),
                callback_data: "transfer_cancel"
              }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error(
      "Transfer wallet selection error:",
      err
    );

    console.error(
      err?.stack
    );

    /*
     * Don't send a second error message if the
     * original callback message was already edited.
     */
  }
}

bot.callbackQuery(
  "transfer_wallet_main",
  async (ctx) => {
    await answerCallback(ctx);

    await startTransferWalletSelection(
      ctx,
      "main"
    );
  }
);


bot.callbackQuery(
  "transfer_wallet_play",
  async (ctx) => {
    await answerCallback(ctx);

    await startTransferWalletSelection(
      ctx,
      "play"
    );
  }
);

// ============================================================
// TRANSFER — CONFIRM RECIPIENT
// ============================================================

bot.callbackQuery(
  "transfer_recipient_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    const state =
      getTransferState(
        telegramId
      );

    if (!state) {
      return respond("reply", ctx, 
        await T(ctx, "tr_expired")
      );
    }

    if (
      state.state !==
      TRANSFER_STATES.CONFIRM_RECIPIENT
    ) {
      return;
    }

    refreshTransferExpiry(state);

    state.state =
      TRANSFER_STATES.ENTER_AMOUNT;

    const limits =
      state.limits;

    const lang = await getLang(telegramId);

    let message =
      tr(lang, "tr_recipient_head", getWalletDisplayName(state.walletType, lang), state.receiverName, state.receiverPhone) +
      `💰 ${tr(lang, "tr_l_available")}: *${formatTransferAmount(limits.balance)}*\n` +
      `📌 ${tr(lang, "tr_l_min")}: *${formatTransferAmount(limits.minimum_transfer_amount)}*\n`;

    if (
      limits.maximum_transfer_amount !== null &&
      limits.maximum_transfer_amount !== undefined
    ) {
      message += tr(lang, "tr_max_per", formatTransferAmount(limits.maximum_transfer_amount)) + "\n";
    }

    message += "\n" + tr(lang, "tr_ask_amount");

    await respond("edit", ctx, 
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: tr(lang, "btn_cancel"),
                callback_data:
                  "transfer_cancel"
              }
            ]
          ]
        }
      }
    );
  }
);

// ============================================================
// TRANSFER — CHANGE AMOUNT
// ============================================================

bot.callbackQuery(
  "transfer_change_amount",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    const state =
      getTransferState(
        telegramId
      );

    if (!state) {
      return respond("reply", ctx, 
        await T(ctx, "tr_expired")
      );
    }

    refreshTransferExpiry(state);

    state.amount = null;
    state.state =
      TRANSFER_STATES.ENTER_AMOUNT;

    const lang = await getLang(telegramId);

    await respond("edit", ctx, 
      tr(lang, "tr_change_text", state.receiverName, state.receiverPhone, getWalletDisplayName(state.walletType, lang), formatTransferAmount(state.limits.balance), formatTransferAmount(state.limits.minimum_transfer_amount),
        (state.limits.maximum_transfer_amount !== null && state.limits.maximum_transfer_amount !== undefined) ? formatTransferAmount(state.limits.maximum_transfer_amount) : null),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: tr(lang, "btn_cancel"),
                callback_data:
                  "transfer_cancel"
              }
            ]
          ]
        }
      }
    );
  }
);

// ============================================================
// TRANSFER — RETRY AMOUNT
// ============================================================

bot.callbackQuery(
  "transfer_retry_amount",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    const state =
      getTransferState(
        telegramId
      );
    const lang = await getLang(telegramId);

    if (!state) {
      return respond("reply", ctx, 
        await T(ctx, "tr_expired")
      );
    }

    try {

      // --------------------------------------------------------
      // Reload current transfer limits from database
      // --------------------------------------------------------

      const user =
        await db.getUserByTelegramId(
          telegramId
        );

      if (!user) {
        clearPendingState(telegramId);

        return respond("reply", ctx, 
          await T(ctx, "start_first")
        );
      }

      if (
        user.is_active !== true ||
        user.is_blocked === true ||
        user.is_banned === true
      ) {
        clearPendingState(telegramId);

        return respond("reply", ctx, 
          tr(lang, "tr_not_eligible")
        );
      }

      const limits =
        await db.getTransferLimits(
          user.id,
          state.walletType
        );

      if (!limits) {
        return respond("reply", ctx, 
          tr(lang, "tr_limits_fail_retry")
        );
      }

      // --------------------------------------------------------
      // Update state with fresh limits
      // --------------------------------------------------------

      state.limits = limits;
      state.amount = null;
      state.idempotencyKey = null;
      state.state =
        TRANSFER_STATES.ENTER_AMOUNT;

      refreshTransferExpiry(state);

      // --------------------------------------------------------
      // Calculate maximum transferable now
      // --------------------------------------------------------

      const balance =
        Number(
          limits.balance || 0
        );

      const minimum =
        Number(
          limits.minimum_transfer_amount || 0
        );

      const minimumRemaining =
        Number(
          limits.minimum_remaining_balance || 0
        );

      const maximum =
        limits.maximum_transfer_amount === null ||
        limits.maximum_transfer_amount === undefined
          ? null
          : Number(
              limits.maximum_transfer_amount
            );

      let maximumTransferable;

      if (
        limits.maximum_transferable_now !== null &&
        limits.maximum_transferable_now !== undefined
      ) {
        maximumTransferable =
          Number(
            limits.maximum_transferable_now
          );
      } else {

        const balanceAvailableAfterMinimum =
          Math.max(
            balance - minimumRemaining,
            0
          );

        maximumTransferable =
          maximum === null
            ? balanceAvailableAfterMinimum
            : Math.min(
                balanceAvailableAfterMinimum,
                maximum
              );
      }

      maximumTransferable =
        Math.max(
          Number(maximumTransferable) || 0,
          0
        );

      state.limits.maximum_transferable_now =
        maximumTransferable;

      // --------------------------------------------------------
      // Make sure minimum transfer is still possible
      // --------------------------------------------------------

      if (
        balance < minimum ||
        maximumTransferable < minimum
      ) {

        return respond("edit", ctx, 
          `${getWalletDisplayName(state.walletType, lang)}\n\n` +
          tr(lang, "tr_limits_block", formatTransferAmount(balance), formatTransferAmount(minimum), formatTransferAmount(minimumRemaining), formatTransferAmount(maximumTransferable)) +
          `\n\n` + tr(lang, "tr_cannot_min"),
          {
            parse_mode: "Markdown",
            reply_markup: getTransferCancelKeyboard(lang)
          }
        );
      }

      // --------------------------------------------------------
      // Show amount entry screen
      // --------------------------------------------------------

      let message =
        tr(lang, "tr_retry_text", state.receiverName, state.receiverPhone, getWalletDisplayName(state.walletType, lang),
          formatTransferAmount(balance), formatTransferAmount(minimumRemaining), formatTransferAmount(minimum), formatTransferAmount(maximumTransferable),
          maximum !== null ? formatTransferAmount(maximum) : null);

      await respond("edit", ctx, 
        message,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: tr(lang, "btn_cancel"),
                  callback_data:
                    "transfer_cancel"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Transfer retry amount error:",
        err
      );

      console.error(
        err?.stack
      );

      try {
        await respond("reply", ctx, 
          "❌ Unable to reload the transfer limits. Please try again."
        );
      } catch (replyError) {
        console.error(
          "Transfer retry error reply failed:",
          replyError
        );
      }
    }
  }
);

// ============================================================
// TRANSFER — FINAL CONFIRMATION
// ============================================================

bot.callbackQuery(
  "transfer_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    const state =
      getTransferState(
        telegramId
      );

    if (!state) {
      return respond("reply", ctx, 
        await T(ctx, "tr_expired")
      );
    }

    if (
      state.state !==
      TRANSFER_STATES.CONFIRM_TRANSFER
    ) {
      return;
    }

    refreshTransferExpiry(state);

    const lang = await getLang(telegramId);

    if (
      !state.receiverPhone ||
      !state.walletType ||
      !state.amount
    ) {
      delete pendingTransfer[
        telegramId
      ];

      return respond("reply", ctx, 
        tr(lang, "tr_incomplete")
      );
    }

    /*
     * Generate idempotency key ONCE.
     *
     * If Telegram sends the callback twice,
     * the database will safely return the same
     * transfer instead of moving money twice.
     */
    if (!state.idempotencyKey) {
      state.idempotencyKey =
        generateTransferIdempotencyKey(
          telegramId,
          state.walletType
        );
    }

    /*
     * Disable the current buttons immediately.
     */
    try {
      await respond("edit", ctx, 
        tr(lang, "tr_processing"),
        {
          parse_mode: "Markdown"
        }
      );
    } catch (err) {
      console.error(
        "Transfer processing UI error:",
        err
      );
    }

    try {

      const user =
        await db.getUserByTelegramId(
          telegramId
        );

      if (!user) {
        throw new Error(
          "Your account could not be found."
        );
      }

      /*
       * Re-check recipient immediately before money moves.
       *
       * The DB function also checks this, so this is
       * only a friendly pre-check.
       */
      const recipient =
        await db.getTransferRecipient(
          state.receiverPhone
        );

      if (!recipient) {
        throw new Error(
          "The recipient is no longer available for transfers."
        );
      }

      if (
        recipient.user_id === user.id
      ) {
        throw new Error(
          "You cannot transfer money to yourself."
        );
      }

      /*
       * FINAL DATABASE OPERATION
       */
      const result =
        await db.transferWallet(
          user.id,
          state.receiverPhone,
          state.walletType,
          state.amount,
          state.idempotencyKey,
          "Telegram wallet transfer"
        );

      if (
        !result ||
        result.success !== true
      ) {
        throw new Error(
          "The transfer could not be completed."
        );
      }
      

      /*
       * Transfer successful.
       */

      const receiverTelegramId =
  result.receiver_telegram_id ||
  state.receiverTelegramId;

await notifyTransferReceiver({
  receiverTelegramId,

  senderName:
    user.name ||
    user.full_name ||
    "",

  senderPhone:
    user.phone ||
    user.phone_number ||
    "",

  amount:
    Number(
      result.amount ||
      state.amount
    ),

  walletType:
    state.walletType,

  transactionId:
    result.transaction_id ||
    null
});
      delete pendingTransfer[
        telegramId
      ];

      const amount =
        Number(
          result.amount ||
          state.amount
        );

      let successMessage =
                tr(lang, "tr_success_head", getWalletDisplayName(state.walletType, lang), result.receiver_name || state.receiverName, state.receiverPhone, formatTransferAmount(amount));

      if (
        result.sender_balance_after !==
        undefined
      ) {
        successMessage +=
          tr(lang, "tr_new_balance", formatTransferAmount(result.sender_balance_after));
      }

      if (
        result.transaction_id
      ) {
        successMessage +=
          tr(lang, "tr_txid", result.transaction_id);
      }

      successMessage +=
        "\n" + tr(lang, "tr_success_tail");

      await respond("reply", ctx, 
        successMessage,
        {
          parse_mode: "Markdown",
                    reply_markup:
            getTransferCancelKeyboard(lang)
        }
      );
    } catch (err) {
      console.error(
        "Wallet transfer execution error:",
        err
      );

      /*
       * Keep state only if this was a recoverable
       * validation/limit problem.
       *
       * The user can cancel or try another amount.
       */
      const message =
        String(
          err?.message || ""
        );

      let friendlyMessage =
        tr(lang, "tr_failed_head");

      if (err?.featureDisabled) {
        friendlyMessage +=
          restrictionText(err.featureDisabled.feature, err.featureDisabled.scope, lang);
      }
      else if (
        /insufficient/i.test(
          message
        )
      ) {
        friendlyMessage +=
          tr(lang, "tr_insufficient");
      }
      else if (
        /minimum/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else if (
        /maximum/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else if (
        /limit/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else if (
        /no longer available/i.test(
          message
        )
      ) {
        friendlyMessage +=
          tr(lang, "tr_recipient_gone");
      }
      else if (
        /yourself/i.test(
          message
        )
      ) {
        friendlyMessage +=
          tr(lang, "tr_self");
      }
      else if (
        /recipient/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else {
        friendlyMessage +=
          tr(lang, "tr_generic_fail");
      }

      friendlyMessage +=
        "\n\n" + tr(lang, "tr_not_deducted");

      await respond("reply", ctx, 
        friendlyMessage,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: tr(lang, "tr_btn_retry"),
                  callback_data:
                    "transfer_retry_amount"
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "transfer_cancel"
                }
              ]
            ]
          }
        }
      );
    }
  }
);

// ============================================================
// TRANSFER — FINAL CONFIRMATION
// ============================================================

bot.callbackQuery(
  "transfer_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    const state =
      getTransferState(
        telegramId
      );

    if (!state) {
      return respond("reply", ctx, 
        await T(ctx, "tr_expired")
      );
    }

    if (
      state.state !==
      TRANSFER_STATES.CONFIRM_TRANSFER
    ) {
      return;
    }

    refreshTransferExpiry(state);

    const lang = await getLang(telegramId);

    if (
      !state.receiverPhone ||
      !state.walletType ||
      !state.amount
    ) {
      delete pendingTransfer[
        telegramId
      ];

      return respond("reply", ctx, 
        tr(lang, "tr_incomplete")
      );
    }

    /*
     * Generate idempotency key ONCE.
     *
     * If Telegram sends the callback twice,
     * the database will safely return the same
     * transfer instead of moving money twice.
     */
    if (!state.idempotencyKey) {
      state.idempotencyKey =
        generateTransferIdempotencyKey(
          telegramId,
          state.walletType
        );
    }

    /*
     * Disable the current buttons immediately.
     */
    try {
      await respond("edit", ctx, 
        tr(lang, "tr_processing"),
        {
          parse_mode: "Markdown"
        }
      );
    } catch (err) {
      console.error(
        "Transfer processing UI error:",
        err
      );
    }

    try {

      const user =
        await db.getUserByTelegramId(
          telegramId
        );

      if (!user) {
        throw new Error(
          "Your account could not be found."
        );
      }

      /*
       * Re-check recipient immediately before money moves.
       *
       * The DB function also checks this, so this is
       * only a friendly pre-check.
       */
      const recipient =
        await db.getTransferRecipient(
          state.receiverPhone
        );

      if (!recipient) {
        throw new Error(
          "The recipient is no longer available for transfers."
        );
      }

      if (
        recipient.user_id === user.id
      ) {
        throw new Error(
          "You cannot transfer money to yourself."
        );
      }

      /*
       * FINAL DATABASE OPERATION
       */
      const result =
        await db.transferWallet(
          user.id,
          state.receiverPhone,
          state.walletType,
          state.amount,
          state.idempotencyKey,
          "Telegram wallet transfer"
        );

      if (
        !result ||
        result.success !== true
      ) {
        throw new Error(
          "The transfer could not be completed."
        );
      }

      /*
       * Transfer successful.
       */
      delete pendingTransfer[
        telegramId
      ];

      const amount =
        Number(
          result.amount ||
          state.amount
        );

      let successMessage =
                tr(lang, "tr_success_head", getWalletDisplayName(state.walletType, lang), result.receiver_name || state.receiverName, state.receiverPhone, formatTransferAmount(amount));

      if (
        result.sender_balance_after !==
        undefined
      ) {
        successMessage +=
          tr(lang, "tr_new_balance", formatTransferAmount(result.sender_balance_after));
      }

      if (
        result.transaction_id
      ) {
        successMessage +=
          tr(lang, "tr_txid", result.transaction_id);
      }

      successMessage +=
        "\n" + tr(lang, "tr_success_tail");

      await respond("reply", ctx, 
        successMessage,
        {
          parse_mode: "Markdown",
                    reply_markup:
            getTransferCancelKeyboard(lang)
        }
      );
    } catch (err) {
      console.error(
        "Wallet transfer execution error:",
        err
      );

      /*
       * Keep state only if this was a recoverable
       * validation/limit problem.
       *
       * The user can cancel or try another amount.
       */
      const message =
        String(
          err?.message || ""
        );

      let friendlyMessage =
        tr(lang, "tr_failed_head");

      if (err?.featureDisabled) {
        friendlyMessage +=
          restrictionText(err.featureDisabled.feature, err.featureDisabled.scope, lang);
      }
      else if (
        /insufficient/i.test(
          message
        )
      ) {
        friendlyMessage +=
          tr(lang, "tr_insufficient");
      }
      else if (
        /minimum/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else if (
        /maximum/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else if (
        /limit/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else if (
        /no longer available/i.test(
          message
        )
      ) {
        friendlyMessage +=
          tr(lang, "tr_recipient_gone");
      }
      else if (
        /yourself/i.test(
          message
        )
      ) {
        friendlyMessage +=
          tr(lang, "tr_self");
      }
      else if (
        /recipient/i.test(
          message
        )
      ) {
        friendlyMessage +=
          message;
      }
      else {
        friendlyMessage +=
          tr(lang, "tr_generic_fail");
      }

      friendlyMessage +=
        "\n\n" + tr(lang, "tr_not_deducted");

      await respond("reply", ctx, 
        friendlyMessage,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: tr(lang, "tr_btn_retry"),
                  callback_data:
                    "transfer_retry_amount"
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "transfer_cancel"
                }
              ]
            ]
          }
        }
      );
    }
  }
);

// ============================================================
// TRANSFER — CANCEL
// ============================================================

bot.callbackQuery(
  "transfer_cancel",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    delete pendingTransfer[
      telegramId
    ];

    const lang = await getLang(telegramId);

    try {

      await respond("edit", ctx, 
        tr(lang, "tr_cancelled"),
        {
          parse_mode: "Markdown",
          reply_markup:
            getTransferCancelKeyboard(lang)
        }
      );

    } catch (err) {

      await respond("reply", ctx, 
        tr(lang, "tr_cancelled"),
        {
          parse_mode: "Markdown",
          reply_markup:
            getTransferCancelKeyboard(lang)
        }
      );
    }
  }
);


// ============================================================
// PAYMENT METHOD
// ============================================================

bot.callbackQuery(/^payment_(\d+)$/, async (ctx) => 
  {
      await answerCallback(ctx);
      const lang = await getLang(ctx.from.id);
      const paymentMethodId = Number(ctx.match[1]);
      try 
      {
        const paymentMethod = await db.getPaymentMethodById(paymentMethodId);
        if (!paymentMethod) 
        {
            return respond("reply", ctx, tr(lang, "pay_method_missing"));
        }
        const paymentType = await db.getPaymentMethodTypesById(paymentMethod.type_id);
        if (!paymentType) 
        {
            return respond("reply", ctx, tr(lang, "pay_option_missing"));
        }
        const paymentaccount = await db.getPaymentAccount(paymentMethod.id);
        const depLimits = paymentaccount ? await db.getDepositLimits(paymentMethod.id, paymentaccount.id) : { min: null, max: null };
        if (paymentaccount)
        {
            pendingDeposit[ctx.from.id] = true;            
            //if (!paymentaccount) 
           // {
           //     return respond("reply", ctx, "❌ የ" + paymentMethod.amharic_Name + " አካውንት አማራጭ አልተገኘም።");
           // }          
            ctx.session.paymentMethod = { id: paymentMethod.id , name: paymentMethod.name, amharicName: paymentMethod.amharic_name};
            ctx.session.paymentType = { id: paymentType.id, name: paymentType.name, amharicName: paymentType.amharic_name};
            await respond("edit", ctx, 
              tr(lang, "dep_instructions", tr(lang, "dep_limit_line", depLimits.min, depLimits.max), pmName(paymentMethod, lang), paymentMethod.emoji, paymentMethod.name, displayAccountNumber(paymentaccount.account_number), accountOwnerFirstName(paymentaccount)),
              {
                  parse_mode: "Markdown"
              });
        setTimeout(async () => 
        {
            try 
            {
                  await ctx.deleteMessage();
            } 
            catch (err) 
            {
                  console.error("Could not delete message:", err);
            }
        }, 60000);
        return;
      }


      await respond("edit", ctx, 
        `${paymentMethod.emoji || "💳"} ` +
        `${pmName(paymentMethod, lang)}\n\n` +
        tr(lang, "pay_coming_soon")
      );

    } 
    catch (err) 
    {
        console.error("Payment method error:", err);
        await respond("reply", ctx, tr(lang, "pay_method_fail"));
    }

  });



// ============================================================
// CANCEL DEPOSIT
// ============================================================

bot.callbackQuery(
  "user_cancel_deposit",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
    try {

      await respond("edit", ctx, 
        await T(ctx, "dep_cancelled")
      );

    } catch {

      await respond("reply", ctx, 
        await T(ctx, "dep_cancelled")
      );

    }

  }
);


// ============================================================
// WITHDRAWAL
// ============================================================

async function showWithdrawal(
  ctx
) {

  const telegramId =
    ctx.from.id;


  const user =
    await db.getUserByTelegramId(
      telegramId
    );


  if (!user) {

    return respond("reply", ctx, 
      await T(ctx, "start_first")
    );

  }


  // admin restriction (this user, or withdrawals paused for everyone)
  if (await replyIfFeatureBlocked(ctx, user, "withdraw", await getLang(ctx.from.id))) return;


  const walletRow = await db.getUserWalletBalances(telegramId);
  const balance =
    Number(walletRow?.main_balance || 0);


  if (
    balance < 50
  ) {

    return respond("reply", ctx, 

      await T(ctx, "wd_low_balance", balance)

    );

  }


  const paymentMethods =
    await db.getPaymentMethods();


  if (
    !paymentMethods ||
    paymentMethods.length === 0
  ) {

    return respond("reply", ctx, 
      await T(ctx, "wd_no_methods")
    );

  }


  pendingWithdrawal[
    telegramId
  ] = {

    step:
      "payment_method"

  };


  const wlang = await getLang(telegramId);

  const buttons =
    paymentMethods.map(
      pm => [

        {

          text:
            `${pm.emoji || "💳"} ${pmName(pm, wlang)}`,

          callback_data:
            `user_withdraw_method_${pm.id}`

        }

      ]
    );


  buttons.push([

    {

      text:
        tr(wlang, "btn_cancel"),

      callback_data:
        "user_cancel_withdrawal"

    }

  ]);


  await respond("reply", ctx, 

    tr(wlang, "wd_choose_method"),

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          buttons

      }

    }

  );

}


bot.command(
  "withdraw",
  showWithdrawal
);




bot.callbackQuery(
  "user_withdraw",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    await showWithdrawal(ctx);
  }
);


// ============================================================
// WITHDRAWAL PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  /^user_withdraw_method_(\d+)$/,
  async (ctx) => {

    await answerCallback(
      ctx
    );


    const telegramId =
      ctx.from.id;


    const methodId =
      Number(
        ctx.match[1]
      );


    const pending =
      pendingWithdrawal[
        telegramId
      ];


    if (!pending) {

      return respond("reply", ctx, 
        await T(ctx, "wd_expired")
      );

    }


    try {

      const paymentMethod =
        await db.getPaymentMethodById(
          methodId
        );


      if (!paymentMethod) {

        return respond("reply", ctx, 
          await T(ctx, "pay_method_missing")
        );

      }
      const paymentType = await db.getPaymentMethodTypesById(paymentMethod.type_id);
        if (!paymentType) 
        {
            return respond("reply", ctx, await T(ctx, "pay_option_missing"));
        }
      const paymentaccount = await db.getPaymentAccount(paymentMethod.id);
      //  if (paymentaccount)
        {
            
             pendingWithdrawal[telegramId] = { step: "account", paymentMethodId: methodId ,paymentMethod};
          //pendingWithdrawal[ctx.from.id] = true;
          
        
        
              await respond("edit", ctx, 
        
                await T(ctx, "wd_ask_account", pmName(paymentMethod, await getLang(telegramId))),
        
                {
        
                  parse_mode:
                    "Markdown"
        
                }
        
              );
          
        }
     // else
        {
     /* await respond("edit", ctx, 
        `${paymentMethod.emoji || "💳"} ` +
        `${paymentMethod.amharic_name}\n\n` +
        `ይህ የክፍያ መንገድ በቅርቡ ይጀምራል။`
      );*/
        }
    } catch (err) {

      console.error(
        "Withdrawal method error:",
        err
      );

      await respond("reply", ctx, 
        await T(ctx, "pay_method_fail")
      );

    }

  }
);

// ============================================================
// CANCEL WITHDRAWAL
// ============================================================

bot.callbackQuery(
  "user_cancel_withdrawal",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    try {

      await respond("edit", ctx, 
        await T(ctx, "wd_cancelled")
      );

    } catch {

      await respond("reply", ctx, 
        await T(ctx, "wd_cancelled")
      );

    }

  }
);


// ============================================================
// ADMIN — PENDING WITHDRAWALS
// PAYMENT METHOD → PAYMENT ACCOUNT → PENDING LIST
// ============================================================

async function showAdminPaymentMethods(ctx) {

  const admin = await getCurrentAdmin(ctx);

  if (!admin) {
    return;
  }

  const paymentMethods =
    await db.getPaymentMethods();

  if (
    !paymentMethods ||
    paymentMethods.length === 0
  ) {

    return respond("reply", ctx, 
      "❌ No active payment methods are available."
    );

  }

  const keyboard =
    paymentMethods.map(pm => [

      {
        text:
          `${pm.emoji || "💳"} ${pm.amharic_name || pm.name}`,

        callback_data:
          `admin_pending_method_${pm.id}`
      }

    ]);

  keyboard.push([

    {
      text:
        "🏠 Home",

      callback_data:
        "admin_home"
    }

  ]);

  await respond("reply", ctx, 

    "👑 *PENDING WITHDRAWALS*\n\n" +

    "First select the payment method you will use to process the withdrawals:",

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          keyboard

      }

    }

  );

}


// ============================================================
// ADMIN PENDING BUTTON
// ============================================================

bot.callbackQuery(
  "admin_withdrawals",
  async (ctx) => {
    await cleanupExpiredAdminWithdrawalUI(ctx.from.id);
    const admin = await getCurrentAdminPermission(
    ctx,
    "withdrawals"
);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    // Clear previous payment account selection
    delete pendingAdminWithdrawal[
      admin.telegram_id
    ];

    try {

      await showAdminPaymentMethods(ctx);

    } catch (err) {

      console.error(
        "Admin payment method selection error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not load payment methods."
      );

    }

  }
);


// ============================================================
// ADMIN — SELECT PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  /^admin_pending_method_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const paymentMethodId =
      Number(ctx.match[1]);

    try {

      const paymentMethod =
        await db.getPaymentMethodById(
          paymentMethodId
        );

      if (!paymentMethod) {

        return respond("reply", ctx, 
          "❌ Payment method not found."
        );

      }

      const accounts =
        await db.getPaymentAccountsByMethod(
          paymentMethodId
        );

      if (
        !accounts ||
        accounts.length === 0
      ) {

        return respond("reply", ctx, 

          "❌ No active payment accounts are available for " +
          `${paymentMethod.amharic_name || paymentMethod.name}.`

        );

      }

      const keyboard =
        accounts.map(account => [

          {
            text:
              `${account.account_number} — ` +
              `${account.balance || ""}`,

            callback_data:
              `admin_pending_account_${account.id}`
          }

        ]);

      keyboard.push([

        {
          text:
            "⬅️ Back",

          callback_data:
            "admin_withdrawals"
        }

      ]);

      await respond("edit", ctx, 

        "👑 *SELECT PAYMENT ACCOUNT*\n\n" +

        `💳 Payment method: *${
          paymentMethod.amharic_name ||
          paymentMethod.name
        }*\n\n` +

        "Select the account that will be used to pay the approved withdrawals:",

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            inline_keyboard:
              keyboard

          }

        }

      );

    } catch (err) {

      console.error(
        "Admin payment account selection error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not load payment accounts."
      );

    }

  }
);


// ============================================================
// ADMIN — SELECT PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_pending_account_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const paymentAccountId =
      Number(ctx.match[1]);

    try {

      const account =
        await db.getPaymentAccountById(
          paymentAccountId
        );

      if (!account) {

        return respond("reply", ctx, 
          "❌ Payment account not found."
        );

      }

      /*
       * Store the selected account for this admin.
       *
       * This remains selected while the admin
       * approves multiple withdrawal requests.
       */

      pendingAdminWithdrawal[
        admin.telegram_id
      ] = {

        paymentMethodId: account.payment_method_id,
        paymentAccountId: account.id,
        paymentAccount: account,
        claimMessageId: null,
        claimedWithdrawals: [],
        claimExpiresAt: null
      };

      await showPendingWithdrawals(
        ctx,
        true
      );

    } catch (err) {

      console.error(
        "Admin payment account selection error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not select the payment account."
      );

    }

  }
);


// ============================================================
// SHOW MAXIMUM 5 PENDING WITHDRAWALS
// ============================================================

async function showPendingWithdrawals(
  ctx,
  editMessage = false,
  claimNew = true
) {
  const admin = await getCurrentAdmin(ctx);

  if (!admin) {
    return;
  }

  const adminState =
    pendingAdminWithdrawal[admin.telegram_id];

  if (!adminState) {
    return showAdminPaymentMethods(ctx);
  }

  try {
    /*
     * ----------------------------------------------------------
     * CLAIM NEW WITHDRAWALS
     * ----------------------------------------------------------
     *
     * This is NOT getPendingWithdrawals().
     *
     * It atomically changes:
     *
     * pending -> processing
     *
     * and assigns the rows to this admin.
     */
    let withdrawals;

if (claimNew) {
  const claimResult =
    await db.claimPendingWithdrawals(
      admin.telegram_id,
      adminState.paymentMethodId,
      1
    );

  if (!claimResult || !claimResult.success) {
    return respond("reply", ctx, 
      `❌ ${
        claimResult?.message ||
        "Could not claim withdrawals."
      }`
    );
  }

  withdrawals =
    claimResult.withdrawals || [];

  adminState.claimedWithdrawals =
    withdrawals;

  adminState.claimExpiresAt =
    Date.now() + (5 * 60 * 1000);

} else {
  // Display withdrawals already claimed by this admin.
  withdrawals =
    adminState.claimedWithdrawals || [];
}

    let message =
      "👑 *WITHDRAWALS ASSIGNED TO YOU*\n\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      `💳 Method: *${
        adminState.paymentAccount.pm_amharic_name ||
        adminState.paymentAccount.pm_name ||
        "Unknown"
      }*\n` +
      `📱 Payment Account: \`${adminState.paymentAccount.account_number}\`\n` +
      `📱 Account Name: \`${adminState.paymentAccount.account_name}\`\n` +
      `💵Account Balance: \`${adminState.paymentAccount.balance} ETB\`\n` +
      `⏱ Claim expires in: *5 minutes*\n` +
      "━━━━━━━━━━━━━━━━━━━━\n\n";

    if (!withdrawals.length) {
      message +=
        "There are no withdrawals available right now.";

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: "🔄 Refresh",
              callback_data:
                "admin_refresh_withdrawals"
            }
          ],
          [
            {
              text: "🏠 Home",
              callback_data:
                "admin_home"
            }
          ]
        ]
      };

      if (editMessage) {
        try {
          await respond("edit", ctx, 
            message,
            {
              parse_mode: "Markdown",
              reply_markup: keyboard
            }
          );
        } catch (err) {
          await respond("reply", ctx, 
            message,
            {
              parse_mode: "Markdown",
              reply_markup: keyboard
            }
          );
        }
      } else {
        await respond("reply", ctx, 
          message,
          {
            parse_mode: "Markdown",
            reply_markup: keyboard
          }
        );
      }

      return;
    }

    /*
     * ----------------------------------------------------------
     * DISPLAY CLAIMED WITHDRAWALS
     * ----------------------------------------------------------
     */
    withdrawals.forEach(
      (withdrawal, index) => {

        message +=
          `*${index + 1}. Withdrawal #${withdrawal.id}*\n` +
          (withdrawal.needs_review ? `⚠️ *REVIEW: ${mdEsc((withdrawal.risk_flags || []).join(", ") || "flagged")}*\n` : "") +
          `👤 User: *${mdEsc(withdrawal.name || "Unknown")}*\n` +
          `💰 Amount: *${withdrawal.amount} ETB*\n` +
          `📱 Account: \`${withdrawal.account_number}\`\n` +
          `👤 Account name: *${mdEsc(withdrawal.account_name || "—")}*\n` + "\n";

      }
    );

    /*
     * Buttons.
     */
    const keyboard = [];

    withdrawals.forEach(
      (withdrawal) => {

        keyboard.push([
          {
            text:
              `✅ #${withdrawal.id}`,
            callback_data:
              `approve_withdrawal_${withdrawal.id}`
          },
          {
            text:
              `❌ #${withdrawal.id}`,
            callback_data:
              `reject_withdrawal_${withdrawal.id}`
          }
        ]);

      }
    );

    keyboard.push([
      {
        text: "🔄 Refresh",
        callback_data:
          "admin_refresh_withdrawals"
      }
    ]);

    keyboard.push([
      {
        text: "🏠 Home",
        callback_data:
          "admin_home"
      }
    ]);

    const options = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: keyboard
      }
    };

    /*
     * ----------------------------------------------------------
     * SEND / EDIT TELEGRAM MESSAGE
     * ----------------------------------------------------------
     */
    let sentMessage;

    if (editMessage) {

      try {

        await respond("edit", ctx, 
          message,
          options
        );

        /*
         * The callback message remains the same Telegram message.
         */
        adminState.claimMessageId =
          ctx.callbackQuery?.message?.message_id;

      } catch (err) {

        sentMessage =
          await respond("reply", ctx, 
            message,
            options
          );

        adminState.claimMessageId =
          sentMessage.message_id;

      }

    } else {

      sentMessage =
        await respond("reply", ctx, 
          message,
          options
        );

      adminState.claimMessageId =
        sentMessage.message_id;
    }

    /*
     * Schedule local cleanup if this server instance remains alive.
     *
     * DATABASE lease is still authoritative.
     */
    scheduleWithdrawalClaimCleanup(
      admin.telegram_id
    );

  } catch (err) {

    console.error(
      "showPendingWithdrawals error:",
      err
    );

    await respond("reply", ctx, 
      "❌ Could not load withdrawals."
    );
  }
}

// ============================================================
// ADMIN — REFRESH PENDING LIST
// ============================================================

bot.callbackQuery("admin_refresh_withdrawals", async (ctx) => {
  try {
    await ctx.answerCallbackQuery();

    const adminTelegramId = ctx.from.id;

    // Get the admin's current withdrawal state
    const adminState =
      pendingAdminWithdrawal[adminTelegramId];

    if (!adminState?.paymentMethodId) {
      await respond("reply", ctx, 
        "❌ Please select a payment method first."
      );
      return;
    }

    // Claim a NEW batch of available withdrawals.
    // This should only claim pending/expired withdrawals.
    const claimResult =
      await db.claimPendingWithdrawals(
        adminTelegramId,
        adminState.paymentMethodId,
        1
      );

    if (!claimResult?.success) {
      await respond("reply", ctx, 
        `❌ ${
          claimResult?.message ||
          "Failed to refresh withdrawals."
        }`
      );
      return;
    }

    const withdrawals =
      claimResult.withdrawals || [];

    // Replace the admin's current displayed claim list
    adminState.claimedWithdrawals = withdrawals;

    // New 5-minute claim lease
    if (withdrawals.length > 0) {
      adminState.claimExpiresAt =
        Date.now() + 5 * 60 * 1000;
    } else {
      adminState.claimExpiresAt = null;
    }

    // Update the existing Telegram message
    if (withdrawals.length === 0) {
      await respond("edit", ctx, 
        "📭 *No pending withdrawals available right now.*\n\n" +
        "Tap 🔄 Refresh to check again.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Refresh",
                  callback_data:
                    "admin_refresh_withdrawals",
                },
              ],
            ],
          },
        }
      );

      return;
    }

    let message =
      "💸 *Pending Withdrawals*\n\n";

    withdrawals.forEach((withdrawal, index) => {
      message +=
        `*${index + 1}. Withdrawal #${withdrawal.id}*\n` +
        `👤 User: *${mdEsc(withdrawal.name || "Unknown")}*\n` +
        `💰 Amount: *${withdrawal.amount} ETB*\n` +
        `📱 Account: \`${withdrawal.account_number}\`\n` +
        `👤 Account name: *${mdEsc(withdrawal.account_name || "—")}*\n` + "\n";
    });

    const buttons = [];

    withdrawals.forEach((withdrawal) => {
      buttons.push([
        {
          text: `✅ Approve #${withdrawal.id}`,
          callback_data:
            `approve_withdrawal_${withdrawal.id}`,
        },
        {
          text: `❌ Reject #${withdrawal.id}`,
          callback_data:
            `reject_withdrawal_${withdrawal.id}`,
        },
      ]);
    });

    buttons.push([
      {
        text: "🔄 Refresh",
        callback_data:
          "admin_refresh_withdrawals",
      },
    ]);

    await respond("edit", ctx, 
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons,
        },
      }
    );

    // Save message ID for expiry cleanup
    adminState.claimMessageId =
      ctx.callbackQuery.message.message_id;

  } catch (error) {
    console.error(
      "admin_refresh_withdrawals error:",
      error
    );

    try {
      await ctx.answerCallbackQuery({
        text: "❌ Failed to refresh withdrawals.",
        show_alert: true,
      });
    } catch (_) {}
  }
});

// ============================================================
// ADMIN PENDING BUTTON
// ============================================================

bot.callbackQuery(
  "admin_withdrawals",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    try {

      const withdrawals =
        await db.getPendingWithdrawals(
          20
        );


      let message =
        "👑 *PENDING WITHDRAWALS*\n\n";


      if (
        !withdrawals ||
        withdrawals.length === 0
      ) {

        message +=
          "There are no pending withdrawals.";

      } else {

        withdrawals.forEach(
          (w, index) => {

            const created =
              w.created_at
                ? new Date(
                    w.created_at
                  ).toLocaleString(
                    "en-GB"
                  )
                : "";


            message +=

              `${index + 1}. 🆔 *#${w.id}*\n` +

              `👤 ${w.name || "Unknown"}\n` +

              `💳 ${w.payment_method_amharic || w.payment_method || "Unknown"}\n` +

              `📱 \`${w.account_number}\`\n` +

              `👤 Account name: ${w.account_name || "—"}\n` +

              `💰 *${w.amount} ETB*\n` +

              `${created ? `📅 ${created}\n` : ""}` +

              "\n";

          }
        );

      }


      const keyboard = [];


      for (
        const w of withdrawals
      ) {

        keyboard.push([

          {

            text:
              `✅ Approve #${w.id}`,

            callback_data:
              `approve_withdrawal_${w.id}`

          },

          {

            text:
              `❌ Reject #${w.id}`,

            callback_data:
              `reject_withdrawal_${w.id}`

          }

        ]);

      }


      keyboard.push([

        {

          text:
            "🔄 Refresh",

          callback_data:
            "admin_withdrawals"

        },

        {

          text:
            "🏠 Home",

          callback_data:
            "admin_home"

        }

      ]);


      await respond("edit", ctx, 

        message,

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            inline_keyboard:
              keyboard

          }

        }

      );

    } catch (err) {

      console.error(
        "Admin withdrawal list error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not load pending withdrawals."
      );

    }

  }
);
// ============================================================
// ADMIN HOME BUTTON
// ============================================================
bot.callbackQuery("admin_home", async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
  const admin = await getCurrentAdmin(ctx);
    if (!admin) 
    {
          return respond("edit", ctx, "❌ Unauthorized.");
    }
    try 
    {
      const user = await db.getUserByTelegramId(admin.telegram_id);
      if (!user) 
      {
        return respond("reply", ctx, "❌ Admin account was not found.");
      }
      await showHome(ctx, user);
    } catch (err) 
    {
      console.error("Admin home error:", err);
    }
  }
);


// ============================================================
// ADMIN APPROVE WITHDRAWAL
// ============================================================

bot.callbackQuery(
  /^approve_withdrawal_(\d+)$/,
  async (ctx) => {
await cleanupExpiredAdminWithdrawalUI(
  ctx.from.id
);
     const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Approving..."
    );

    await cleanupExpiredAdminWithdrawalUI(
      admin.telegram_id
    );

    const withdrawalId =
      Number(ctx.match[1]);

    try {

      const adminState =
        pendingAdminWithdrawal[
          admin.telegram_id
        ];

      if (!adminState) {
        return respond("reply", ctx, 
          "⏱ Your withdrawal claim has expired. Please press Pending again."
        );
      }

      const result =
        await db.approveWithdrawal(
          withdrawalId,
          admin.telegram_id,
          adminState.paymentAccountId
        );

      if (
        !result ||
        !result.success
      ) {

        /*
         * If the lease expired, remove the stale
         * Telegram UI.
         */
        if (
          result?.message?.toLowerCase()
            .includes("expired")
        ) {

          await cleanupExpiredAdminWithdrawalUI(
            admin.telegram_id
          );

        }

        return respond("reply", ctx, 
          `❌ ${
            result?.message ||
            "Withdrawal approval failed."
          }`
        );
      }

      /*
       * Remove this withdrawal from the local
       * claimed list.
       */
     adminState.claimedWithdrawals =
  (adminState.claimedWithdrawals || []).filter(
    w => Number(w.id) !== Number(withdrawalId)
  );

      /*
       * Send approval notification to user.
       *
       * Keep your existing notification code here.
       */

      /*
       * Refresh the admin's remaining claims.
       */


 pendingAdminWithdrawal[admin.telegram_id];
await respond("reply", ctx, 

  "✅ *WITHDRAWAL APPROVED*\n\n" +

  `🆔 #${withdrawalId}\n` +

  `👤 User: *${result.user_name}*\n` +

  `💰 Amount: *${result.amount} ETB*\n` +

  `📱 Recipient: \`${result.withdrawal.account_number}\`\n` +

  `👤 Account name: *${mdEsc(result.withdrawal.account_name || "—")}*\n\n` +

  `💳 Paid from: \`${result.payment_account_number}\`\n` +

  `💰 Account balance after: *${result.payment_account_balance_after} ETB*\n` +

  `👑 Approved by: *${admin.name || admin.telegram_id}*`,

  {
    parse_mode:
      "Markdown"
  }

);
      


      // ------------------------------------------------------
      // Notify user
      // ------------------------------------------------------

      try {

        await respond("send", 

          result.telegram_id,

          tr(await getLang(result.telegram_id), "wd_approved_user", result.amount, result.withdrawal.account_number, result.mainBalance),

          {

            parse_mode:
              "Markdown"

          }

        );

      } catch (notifyError) {

        console.error(
          "Approval notification error:",
          notifyError
        );

      }


      // ------------------------------------------------------
      // Refresh pending list
      // ------------------------------------------------------

      await showPendingWithdrawals(
        ctx,
        true,
        false
      );

    } catch (err) {

      console.error(
        "Approve withdrawal error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Withdrawal approval failed."
      );

    }
  }
);


// ============================================================
// ADMIN REJECT — ASK REASON
// ============================================================

bot.callbackQuery(
  /^reject_withdrawal_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    const telegramId =
      admin.telegram_id;


    const withdrawalId =
      Number(
        ctx.match[1]
      );


    try {

      /*
       * Make sure the withdrawal actually exists
       * and is still pending before asking for a reason.
       */

      const withdrawals =
        await db.getPendingWithdrawals(
          100
        );


      const withdrawal =
        withdrawals.find(
          w =>
            Number(w.id) ===
            withdrawalId
        );


      if (!withdrawal) {

        return respond("reply", ctx, 
          "❌ This withdrawal is no longer pending."
        );

      }


      /*
       * Store rejection state under the
       * CURRENT ADMIN'S Telegram ID.
       *
       * This allows multiple admins to use the
       * bot independently.
       */

      pendingAdminReject[
        telegramId
      ] = {

        withdrawalId,

        withdrawal

      };


      await respond("reply", ctx, 

        "❌ *REJECT WITHDRAWAL*\n\n" +

        `🆔 Withdrawal: *#${withdrawalId}*\n` +

        `👤 User: *${mdEsc(withdrawal.name || "Unknown")}*\n` +

        `💰 Amount: *${withdrawal.amount} ETB*\n` +

        `📱 Account: \`${withdrawal.account_number}\`\n` +

        `👤 Account name: *${mdEsc(withdrawal.account_name || "—")}*\n\n` +

        "📝 Please type the reason for rejection.\n\n" +

        "Example:\n" +

        "`The account number you sent is not correct.`\n\n" +

        "❌ Send /cancel to cancel.",

        {

          parse_mode:
            "Markdown"

        }

      );

    } catch (err) {

      console.error(
        "Reject preparation error:",
        err
      );

      await respond("reply", ctx, 
        "❌ Could not prepare the withdrawal rejection."
      );

    }

  }
);

// ============================================================
// SUPPORT
// ============================================================

async function showSupport(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return respond("reply", ctx, 
      await T(ctx, "start_first")
    );

  }


  await respond("reply", ctx, 

    await T(ctx, "support_text")

  );

}


bot.command(
  "support",
  showSupport
);




bot.callbackQuery(
  "user_support",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    await showSupport(
      ctx
    );

  }
);






// ============================================================
// PLAY
// ============================================================

async function showPlay(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return respond("reply", ctx, 
      await T(ctx, "start_first")
    );

  }


  await respond("reply", ctx, 

    await T(ctx, "play_ready", user.name, (await db.getUserWalletBalances(ctx.from.id))?.total_balance ?? "0.00"),

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard: [

          [

            {

              text:
                await T(ctx, "play_open", BOT_TITLE),

              web_app: {

                url:
                  gameUrl(ctx.from.id, await getLang(ctx.from.id))

              }

            }

          ]

        ]

      }

    }

  );

}


bot.command(
  "play",
  showPlay
);

// ============================================================
// ADMIN BROADCAST
// ============================================================

bot.callbackQuery(
  "admin_broadcast",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    await db.createBroadcastDraft(
      adminTelegramId
    );

    await respond("reply", ctx, 
      "📢 *Create Broadcast*\n\n" +
      "Choose what you want to include.\n\n" +
      "You can choose:\n" +
      "• Image\n" +
      "• Text\n" +
      "• Play button\n\n" +
      "Select at least Image or Text.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🖼 Image",
                callback_data:
                  "broadcast_toggle_image"
              },
              {
                text: "📝 Text",
                callback_data:
                  "broadcast_toggle_text"
              }
            ],
            [
              {
                text: "🎮 Play Button",
                callback_data:
                  "broadcast_toggle_button"
              }
            ],
            [
              {
                text: "➡️ Continue",
                callback_data:
                  "broadcast_continue"
              }
            ],
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "broadcast_cancel"
              }
            ]
          ]
        }
      }
    );
  }
);

// ============================================================
// BROADCAST TOGGLE IMAGE
// ============================================================

bot.callbackQuery(
  "broadcast_toggle_image",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    const newValue =
      draft.include_image !== true;

    await db.updateBroadcastOptions(
      admin.telegram_id,
      newValue,
      draft.include_text === true,
      draft.include_button === true
    );

    const updated =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    await respond("edit", ctx, 
      getBroadcastSelectionText(
        updated
      ),
      {
        parse_mode: "Markdown",
        reply_markup:
          getBroadcastSelectionKeyboard(
            updated
          )
      }
    );
  }
);


// ============================================================
// BROADCAST TOGGLE TEXT
// ============================================================

bot.callbackQuery(
  "broadcast_toggle_text",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    const newValue =
      draft.include_text !== true;

    await db.updateBroadcastOptions(
      admin.telegram_id,
      draft.include_image === true,
      newValue,
      draft.include_button === true
    );

    const updated =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    await respond("edit", ctx, 
      getBroadcastSelectionText(
        updated
      ),
      {
        parse_mode: "Markdown",
        reply_markup:
          getBroadcastSelectionKeyboard(
            updated
          )
      }
    );
  }
);


// ============================================================
// BROADCAST TOGGLE BUTTON
// ============================================================

bot.callbackQuery(
  "broadcast_toggle_button",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    const newValue =
      draft.include_button !== true;

    await db.updateBroadcastOptions(
      admin.telegram_id,
      draft.include_image === true,
      draft.include_text === true,
      newValue
    );

    const updated =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    await respond("edit", ctx, 
      getBroadcastSelectionText(
        updated
      ),
      {
        parse_mode: "Markdown",
        reply_markup:
          getBroadcastSelectionKeyboard(
            updated
          )
      }
    );
  }
);


// ============================================================
// BROADCAST CONTINUE
// ============================================================

bot.callbackQuery(
  "broadcast_continue",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    // At least image or text is required.
    if (
      draft.include_image !== true &&
      draft.include_text !== true
    ) {
      return respond("reply", ctx, 
        "❌ Please select at least 🖼 Image or 📝 Text."
      );
    }

    await respond("edit", ctx, 
      "✅ Content selected.\n\n" +
      "Let's build your broadcast..."
    );

    await continueBroadcastBuilder(
      ctx,
      admin.telegram_id
    );
  }
);

// ============================================================
// BROADCAST IMAGE
// ============================================================

// ============================================================
// BROADCAST IMAGE
// ============================================================

bot.on(
  "message:photo",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    const adminTelegramId =
      admin.telegram_id;

    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );

    if (!draft) {
      return;
    }

    if (
      draft.status !==
      "waiting_image"
    ) {
      return;
    }

    const photo =
      ctx.message.photo[
        ctx.message.photo.length - 1
      ];

    const fileId =
      photo.file_id;

    await db.updateBroadcastImage(
      adminTelegramId,
      fileId
    );

    await respond("reply", ctx, 
      "✅ Image received."
    );

    await continueBroadcastBuilder(
      ctx,
      adminTelegramId
    );
  }
);

// ============================================================
// ALL TEXT INPUT — SINGLE HANDLER
// ============================================================
//
// IMPORTANT:
// There must be ONLY ONE bot.on("message:text") in this file.
//
// Every text-input flow is routed from here according to the
// user's current pending state.
//
// Priority:
//
// 1. Payment account edit
// 2. Payment account creation
// 3. Admin rejection reason
// 4. Admin user search
// 5. Admin role/statistics search
// 6. Registration
// 7. Deposit SMS
// 8. Withdrawal account
// 9. Withdrawal amount
// 10. Broadcast
//
// If no state belongs to the message, next() is called.
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    try {

      const telegramId =
        ctx.from.id;

      const text =
        String(
          ctx.message.text || ""
        ).trim();

      if (await removedAccountSearchHook(ctx, telegramId, text)) return;

      // bonus management form (main admin) – state is in the database
      if (await bnTextHook(ctx, telegramId, text)) return;
      if (await rlTextHook(ctx, telegramId, text)) return;

            // ========================================================
      // TRANSFER FLOW
      // ========================================================

      const transfer =
        getTransferState(
          telegramId
        );

      if (transfer) {
        refreshTransferExpiry(
          transfer
        );

        const lang = await getLang(telegramId);

        // ------------------------------------------------------
        // CANCEL TRANSFER
        // ------------------------------------------------------

        if (
          text.toLowerCase() ===
          "/cancel"
        ) {

          delete pendingTransfer[
            telegramId
          ];

          return respond("reply", ctx, 
            tr(lang, "tr_cancelled_plain")
          );
        }


        // ------------------------------------------------------
        // ENTER RECIPIENT PHONE
        // ------------------------------------------------------

        if (
          transfer.state ===
          TRANSFER_STATES.ENTER_PHONE
        ) {

          const phone =
            normalizeEthiopianPhone(
              text
            );

          if (!phone) {

            return respond("reply", ctx, 
              tr(lang, "tr_phone_invalid"),
              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Prevent sending to ourselves before
           * displaying recipient confirmation.
           */
          const currentUser =
            await db.getUserByTelegramId(
              telegramId
            );

          if (!currentUser) {

            delete pendingTransfer[
              telegramId
            ];

            return respond("reply", ctx, 
              tr(lang, "tr_account_gone")
            );
          }


          /*
           * Find registered recipient.
           */
          let recipient;

          try {

            recipient =
              await db.getTransferRecipient(
                phone
              );

          } catch (err) {

            console.error(
              "Transfer recipient lookup error:",
              err
            );

            return respond("reply", ctx, 
              tr(lang, "tr_phone_verify_fail")
            );
          }


          if (!recipient) {

            return respond("reply", ctx, 
              tr(lang, "tr_recipient_unknown")
            );
          }


          if (
            Number(recipient.user_id) ===
            Number(currentUser.id)
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_self_phone")
            );
          }


          /*
           * Store recipient.
           */
          transfer.receiverPhone =
            phone;

          transfer.receiverUserId =
            recipient.user_id;

          transfer.receiverName =
            recipient.name ||
            tr(lang, "tr_registered_user");

          transfer.receiverTelegramId =
            recipient.telegram_id ||
            null;

          transfer.state =
            TRANSFER_STATES.CONFIRM_RECIPIENT;


          await respond("reply", ctx, 
            tr(lang, "tr_recipient_found", transfer.receiverName, transfer.receiverPhone, getWalletDisplayName(transfer.walletType, lang)),

            {
              parse_mode: "Markdown",
              reply_markup:
                getTransferRecipientKeyboard(lang)
            }
          );

          return;
        }


        // ------------------------------------------------------
        // ENTER AMOUNT
        // ------------------------------------------------------

        if (
          transfer.state ===
          TRANSFER_STATES.ENTER_AMOUNT
        ) {

          /*
           * Only ordinary numeric amounts.
           *
           * Examples:
           * 500
           * 500.50
           * 1,000
           */
          const cleanedAmount =
            text.replace(
              /,/g,
              ""
            );

          if (
            !/^\d+(?:\.\d{1,2})?$/.test(
              cleanedAmount
            )
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_invalid"),
              {
                parse_mode: "Markdown"
              }
            );
          }


          const amount =
            Number(
              cleanedAmount
            );


          if (
            !Number.isFinite(amount) ||
            amount <= 0
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_zero")
            );
          }


          /*
           * Refresh limits immediately before
           * showing confirmation.
           *
           * This catches transfers that may have
           * happened after the wallet-selection step.
           */
          try {

            const user =
              await db.getUserByTelegramId(
                telegramId
              );

            if (!user) {

              delete pendingTransfer[
                telegramId
              ];

              return respond("reply", ctx, 
                tr(lang, "not_found")
              );
            }

            transfer.limits =
              await db.getTransferLimits(
                user.id,
                transfer.walletType
              );

          } catch (err) {

            console.error(
              "Refresh transfer limits error:",
              err
            );

            return respond("reply", ctx, 
              tr(lang, "tr_verify_fail")
            );
          }


          const limits =
            transfer.limits;

          const balance =
            Number(
              limits.balance || 0
            );

          const minimum =
            Number(
              limits.minimum_transfer_amount || 0
            );

          const maximum =
            limits.maximum_transfer_amount === null ||
            limits.maximum_transfer_amount === undefined
              ? null
              : Number(
                  limits.maximum_transfer_amount
                );


          /*
           * Check current balance.
           */
          if (
            amount > balance
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_insufficient_amt", formatTransferAmount(balance), formatTransferAmount(amount)),
              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Minimum.
           */
          if (
            amount < minimum
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_min_amount", formatTransferAmount(minimum)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Maximum per transaction.
           */
          if (
            maximum !== null &&
            amount > maximum
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_max_amount", formatTransferAmount(maximum)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Daily remaining amount.
           */
          if (
            limits.daily &&
            limits.daily.remaining_amount !== null &&
            amount >
              Number(
                limits.daily.remaining_amount
              )
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_limit", tr(lang, "tr_per_daily"), formatTransferAmount(limits.daily.remaining_amount)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Daily remaining count.
           */
          if (
            limits.daily &&
            limits.daily.remaining_count !== null &&
            Number(
              limits.daily.remaining_count
            ) <= 0
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_count_limit", tr(lang, "tr_per_daily"))
            );
          }


          /*
           * Weekly amount.
           */
          if (
            limits.weekly &&
            limits.weekly.remaining_amount !== null &&
            amount >
              Number(
                limits.weekly.remaining_amount
              )
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_limit", tr(lang, "tr_per_weekly"), formatTransferAmount(limits.weekly.remaining_amount)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Weekly count.
           */
          if (
            limits.weekly &&
            limits.weekly.remaining_count !== null &&
            Number(
              limits.weekly.remaining_count
            ) <= 0
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_count_limit", tr(lang, "tr_per_weekly"))
            );
          }


          /*
           * Monthly amount.
           */
          if (
            limits.monthly &&
            limits.monthly.remaining_amount !== null &&
            amount >
              Number(
                limits.monthly.remaining_amount
              )
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_limit", tr(lang, "tr_per_monthly"), formatTransferAmount(limits.monthly.remaining_amount)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Monthly count.
           */
          if (
            limits.monthly &&
            limits.monthly.remaining_count !== null &&
            Number(
              limits.monthly.remaining_count
            ) <= 0
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_count_limit", tr(lang, "tr_per_monthly"))
            );
          }


          /*
           * Quarterly amount.
           */
          if (
            limits.quarterly &&
            limits.quarterly.remaining_amount !== null &&
            amount >
              Number(
                limits.quarterly.remaining_amount
              )
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_limit", tr(lang, "tr_per_quarterly"), formatTransferAmount(limits.quarterly.remaining_amount)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Quarterly count.
           */
          if (
            limits.quarterly &&
            limits.quarterly.remaining_count !== null &&
            Number(
              limits.quarterly.remaining_count
            ) <= 0
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_count_limit", tr(lang, "tr_per_quarterly"))
            );
          }


          /*
           * Yearly amount.
           */
          if (
            limits.yearly &&
            limits.yearly.remaining_amount !== null &&
            amount >
              Number(
                limits.yearly.remaining_amount
              )
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_amount_limit", tr(lang, "tr_per_yearly"), formatTransferAmount(limits.yearly.remaining_amount)),

              {
                parse_mode: "Markdown"
              }
            );
          }


          /*
           * Yearly count.
           */
          if (
            limits.yearly &&
            limits.yearly.remaining_count !== null &&
            Number(
              limits.yearly.remaining_count
            ) <= 0
          ) {

            return respond("reply", ctx, 
              tr(lang, "tr_count_limit", tr(lang, "tr_per_yearly"))
            );
          }


          /*
           * Store amount.
           */
          transfer.amount =
            Math.round(
              amount * 100
            ) / 100;

          transfer.state =
            TRANSFER_STATES.CONFIRM_TRANSFER;

          /*
           * Generate idempotency key only once.
           */
          transfer.idempotencyKey =
            generateTransferIdempotencyKey(
              telegramId,
              transfer.walletType
            );


          /*
           * Confirmation.
           */
          await respond("reply", ctx, 
            tr(lang, "tr_confirm_text", transfer.receiverName, transfer.receiverPhone, getWalletDisplayName(transfer.walletType, lang), formatTransferAmount(transfer.amount), formatTransferAmount(balance), formatTransferAmount(balance - transfer.amount)),

            {
              parse_mode: "Markdown",
              reply_markup:
                getTransferConfirmationKeyboard(lang)
            }
          );

          return;
        }

      }

      // ========================================================
      // COMMANDS
      // ========================================================

      // Do not consume commands inside text-input flows unless
      // that particular flow explicitly supports /cancel.
      //
      // /start, /balance, etc. should continue through the
      // normal command middleware.
      //
      // /cancel is handled below for pending flows.

      // ========================================================
      // 1. PAYMENT ACCOUNT EDIT
      // ========================================================

      const edit =
        pendingAdminAccountEdit[
          telegramId
        ];

      if (edit) {

        const admin =
          await getCurrentAdmin(ctx);

        if (!admin) {

          delete pendingAdminAccountEdit[
            telegramId
          ];

          return respond("reply", ctx, 
            "❌ You are not authorized to edit payment accounts."
          );
        }

        // ------------------------------------------------------
        // CANCEL EDIT
        // ------------------------------------------------------

        if (
          text === "/cancel"
        ) {

          delete pendingAdminAccountEdit[
            telegramId
          ];

          return respond("reply", ctx, 
            "❌ Payment account editing cancelled."
          );
        }

        // ------------------------------------------------------
        // EDIT — ACCOUNT NAME
        // ------------------------------------------------------

        if (
          edit.step ===
          "account_name"
        ) {

          if (!text) {

            return respond("reply", ctx, 
              "❌ Account name cannot be empty."
            );

          }

          if (
            text.length > 100
          ) {

            return respond("reply", ctx, 
              "❌ Account name cannot exceed 100 characters."
            );

          }

          edit.accountName =
            text.substring(
              0,
              100
            );

          edit.step =
            "account_number";

          const isMobile =
            String(
              edit.paymentTypeName || ""
            )
              .trim()
              .toLowerCase() ===
              "mobile" ||

            String(
              edit.paymentTypeAmharicName || ""
            ).trim() === "ሞባይል";

          return respond("reply", ctx, 

            "✏️ *ACCOUNT NAME UPDATED*\n\n" +

            `👤 Name: *${edit.accountName}*\n\n` +

            `📱 Current account number: \`${edit.accountNumber}\`\n\n` +

            (
              isMobile
                ? "Enter the new *mobile account number*."
                : "Enter the new *account number*."
            ),

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "✅ Keep Current",

                      callback_data:
                        `admin_account_edit_keep_number_${edit.accountId}`
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancel",

                      callback_data:
                        "admin_account_edit_cancel"
                    }
                  ]
                ]
              }

            }

          );
        }

        // ------------------------------------------------------
        // EDIT — ACCOUNT NUMBER
        // ------------------------------------------------------

        if (
          edit.step ===
          "account_number"
        ) {

          if (!text) {

            return respond("reply", ctx, 
              "❌ Account number cannot be empty."
            );

          }

          const normalizedAccountNumber =
            normalizePaymentAccountNumber(
              text,
              edit.paymentTypeName,
              edit.paymentTypeAmharicName
            );

          if (
            !normalizedAccountNumber
          ) {

            return respond("reply", ctx, 
              "❌ Invalid account number.\n\n" +
              "Please enter a valid account number."
            );

          }

          if (
            normalizedAccountNumber.length >
            100
          ) {

            return respond("reply", ctx, 
              "❌ Account number cannot exceed 100 characters."
            );

          }

          edit.accountNumber =
            normalizedAccountNumber;

          edit.step =
            "balance";

          return respond("reply", ctx, 

            "✏️ *ACCOUNT NUMBER UPDATED*\n\n" +

            `👤 Name: *${edit.accountName}*\n` +

            `📱 Account: \`${edit.accountNumber}\`\n\n` +

            `💰 Current balance: *${edit.balance} ETB*\n\n` +

            "Enter the new balance in ETB.",

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "✅ Keep Current",

                      callback_data:
                        `admin_account_edit_keep_balance_${edit.accountId}`
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancel",

                      callback_data:
                        "admin_account_edit_cancel"
                    }
                  ]
                ]
              }

            }

          );
        }

        // ------------------------------------------------------
        // EDIT — BALANCE
        // ------------------------------------------------------

        if (
          edit.step ===
          "balance"
        ) {

          const balance =
            Number(
              text.replace(
                /,/g,
                ""
              )
            );

          if (
            !Number.isFinite(balance) ||
            balance < 0
          ) {

            return respond("reply", ctx, 

              "❌ Invalid balance.\n\n" +

              "Please enter a number greater than or equal to 0.\n\n" +

              "Examples:\n" +
              "`0`\n" +
              "`5000`\n" +
              "`12500.50`",

              {
                parse_mode:
                  "Markdown"
              }

            );

          }

          edit.balance =
            balance;

          edit.step =
            "confirm";

          return showAdminAccountEditConfirmation(
            ctx,
            edit
          );
        }

        return;
      }


      // ========================================================
      // 2. ADD PAYMENT ACCOUNT
      // ========================================================

      const account =
        pendingAdminAccount[
          telegramId
        ];

      if (account) {

        const admin =
          await getCurrentAdmin(ctx);

        if (!admin) {

          delete pendingAdminAccount[
            telegramId
          ];

          return respond("reply", ctx, 
            "❌ You are not authorized to create payment accounts."
          );

        }

        // ------------------------------------------------------
        // CANCEL
        // ------------------------------------------------------

        if (
          text === "/cancel"
        ) {

          delete pendingAdminAccount[
            telegramId
          ];

          return respond("reply", ctx, 
            "❌ Payment account creation cancelled."
          );

        }

        // ------------------------------------------------------
        // ACCOUNT NAME
        // ------------------------------------------------------

        if (
          account.step ===
          "account_name"
        ) {

          if (!text) {

            return respond("reply", ctx, 
              "❌ Account name cannot be empty.\n\n" +
              "Please enter the account name:"
            );

          }

          if (
            text.length > 100
          ) {

            return respond("reply", ctx, 
              "❌ Account name is too long.\n\n" +
              "Please enter a name with 100 characters or fewer:"
            );

          }

          account.accountName =
            text.substring(
              0,
              100
            );

          account.step =
            "account_number";

          const isMobile =
            String(
              account.paymentTypeName || ""
            )
              .trim()
              .toLowerCase() ===
              "mobile" ||

            String(
              account.paymentTypeAmharicName || ""
            ).trim() === "ሞባይል";

          if (isMobile) {

            return respond("reply", ctx, 

              "📱 Please enter the *mobile account number*.\n\n" +

              "Examples:\n" +
              "`0912345678`\n" +
              "`+251912345678`\n" +
              "`251912345678`\n\n" +

              "The number will be normalized to `+251...`.",

              {
                parse_mode:
                  "Markdown"
              }

            );

          }

          return respond("reply", ctx, 

            "💳 Please enter the *account number*.\n\n" +
            "The account number will be saved as entered.",

            {
              parse_mode:
                "Markdown"
            }

          );

        }

        // ------------------------------------------------------
        // ACCOUNT NUMBER
        // ------------------------------------------------------

        if (
          account.step ===
          "account_number"
        ) {

          if (!text) {

            return respond("reply", ctx, 
              "❌ Account number cannot be empty.\n\n" +
              "Please enter the account number:"
            );

          }

          const normalizedAccountNumber =
            normalizePaymentAccountNumber(
              text,
              account.paymentTypeName,
              account.paymentTypeAmharicName
            );

          const isMobile =
            String(
              account.paymentTypeName || ""
            )
              .trim()
              .toLowerCase() ===
              "mobile" ||

            String(
              account.paymentTypeAmharicName || ""
            ).trim() === "ሞባይል";

          if (
            isMobile &&
            !normalizedAccountNumber
          ) {

            return respond("reply", ctx, 

              "❌ Invalid Ethiopian mobile number.\n\n" +

              "Please enter a valid number such as:\n" +
              "`0912345678`\n" +
              "`+251912345678`\n" +
              "`251912345678`",

              {
                parse_mode:
                  "Markdown"
              }

            );

          }

          if (
            !normalizedAccountNumber
          ) {

            return respond("reply", ctx, 
              "❌ Invalid account number.\n\n" +
              "Please enter the account number again."
            );

          }

          account.accountNumber =
            normalizedAccountNumber;

          account.step =
            "initial_balance";

          return respond("reply", ctx, 

            "💰 Please enter the *initial balance* in ETB.\n\n" +

            "Example:\n" +
            "`0`\n" +
            "`5000`\n" +
            "`12500.50`",

            {
              parse_mode:
                "Markdown"
            }

          );

        }

        // ------------------------------------------------------
        // INITIAL BALANCE
        // ------------------------------------------------------

        if (
          account.step ===
          "initial_balance"
        ) {

          const initialBalance =
            Number(
              text.replace(
                /,/g,
                ""
              )
            );

          if (
            !Number.isFinite(
              initialBalance
            ) ||
            initialBalance < 0
          ) {

            return respond("reply", ctx, 

              "❌ Invalid balance.\n\n" +

              "Please enter a number greater than or equal to 0.\n\n" +

              "Example:\n" +
              "`0`\n" +
              "`5000`\n" +
              "`12500.50`",

              {
                parse_mode:
                  "Markdown"
              }

            );

          }

          try {

            const result =
              await db.createPaymentAccount(

                account.paymentMethodId,

                account.accountName,

                account.accountNumber,

                initialBalance

              );

            if (
              !result ||
              result.success !== true
            ) {

              return respond("reply", ctx, 
                `❌ ${
                  result?.message ||
                  "Could not create payment account."
                }`
              );

            }

            delete pendingAdminAccount[
              telegramId
            ];

            const createdAccount =
              result.account;

            return respond("reply", ctx, 

              "✅ *PAYMENT ACCOUNT CREATED*\n\n" +

              `💳 Method: *${
                createdAccount.pm_amharic_name ||
                createdAccount.pm_name
              }*\n` +

              `📂 Type: *${
                createdAccount.pt_amharic_name ||
                createdAccount.pt_name ||
                "-"
              }*\n` +

              `👤 Name: *${createdAccount.account_name}*\n` +

              `🧾 First: *${createdAccount.first_name || "-"}* · Middle: *${createdAccount.middle_name || "-"}* · Last: *${createdAccount.last_name || "-"}*\n` +

              `📱 Account: \`${createdAccount.account_number}\`\n` +

              `💰 Initial Balance: *${createdAccount.balance} ETB*\n` +

              "📌 Status: 🟢 *Active*",

              {
                parse_mode:
                  "Markdown",

                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "💳 Accounts",

                        callback_data:
                          "admin_accounts"
                      }
                    ],
                    [
                      {
                        text:
                          "🏠 Home",

                        callback_data:
                          "admin_home"
                      }
                    ]
                  ]
                }
              }

            );

          } catch (err) {

            console.error(
              "Create payment account error:",
              err
            );

            return respond("reply", ctx, 
              "❌ Could not create the payment account.\n\n" +
              "Please try again."
            );

          }

        }

        return;
      }


      // ========================================================
      // 3. ADMIN WITHDRAWAL REJECTION REASON
      // ========================================================

      const reject =
        pendingAdminReject[
          telegramId
        ];

      if (reject) {

        const admin =
          await getCurrentAdmin(ctx);

        if (!admin) {

          delete pendingAdminReject[
            telegramId
          ];

          return respond("reply", ctx, 
            "❌ You are not authorized."
          );

        }

        if (
          text === "/cancel"
        ) {

          delete pendingAdminReject[
            telegramId
          ];

          return respond("reply", ctx, 
            "❌ Withdrawal rejection cancelled."
          );

        }

        if (!text) {

          return respond("reply", ctx, 
            "❌ Please enter a rejection reason."
          );

        }

        if (
          text.length < 2
        ) {

          return respond("reply", ctx, 
            "❌ Please provide a valid rejection reason."
          );

        }

        const withdrawalId =
          reject.withdrawalId;

        const reason =
          text.substring(
            0,
            500
          );

        delete pendingAdminReject[
          telegramId
        ];

        try {

          const result =
            await db.rejectWithdrawal(
              withdrawalId,
              admin.telegram_id,
              reason
            );

          if (
            !result ||
            !result.success
          ) {

            return respond("reply", ctx, 
              `❌ ${
                result?.message ||
                "Withdrawal rejection failed."
              }`
            );

          }

          await respond("reply", ctx, 

            "❌ *WITHDRAWAL REJECTED*\n\n" +

            `🆔 #${withdrawalId}\n` +

            `👤 User: *${
              result.user_name ||
              reject.withdrawal.name ||
              "Unknown"
            }*\n` +

            `💰 Amount: *${
              result.amount ||
              reject.withdrawal.amount
            } ETB*\n\n` +

            `📝 Reason:\n${reason}\n\n` +

            `👑 Rejected by: ${
              admin.name ||
              admin.telegram_id
            }`,

            {
              parse_mode:
                "Markdown"
            }

          );

          try {

            await respond("send", 

              reject.withdrawal.telegram_id,

              tr(await getLang(reject.withdrawal.telegram_id), "wd_rejected_user", result.amount || reject.withdrawal.amount, reason),

              {
                parse_mode:
                  "Markdown"
              }

            );

          } catch (notifyError) {

            console.error(
              "Rejection notification error:",
              notifyError
            );

          }

          return showPendingWithdrawals(
            ctx
          );

        } catch (err) {

          console.error(
            "Withdrawal rejection error:",
            err
          );

          return respond("reply", ctx, 
            "❌ Withdrawal rejection failed."
          );

        }

      }


      // ========================================================
      // 4. ADMIN MANAGE USER
      // ========================================================

      const userSearchState =
        pendingAdminUserSearch.get(
          telegramId
        );

      if (
        userSearchState &&
        userSearchState.step ===
          "waiting_phone"
      ) {

        const admin =
          await db.getAdminByTelegramId(
            telegramId
          );

        if (
          !admin ||
          admin.admin_role !==
            "main"
        ) {

          pendingAdminUserSearch.delete(
            telegramId
          );

          return respond("reply", ctx, 
            "⛔ You are not authorized to manage users."
          );

        }

        const user =
          await db.getUserByPhoneForAdmin(
            text
          );

        if (!user) {

          return respond("reply", ctx, 

            `❌ *User not found*\n\n` +

            `📱 Phone: \`${text}\`\n\n` +

            "Please send another phone number or press Cancel.",

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🏠 Home",

                      callback_data:
                        "admin_home"
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancel",

                      callback_data:
                        "admin_manage_user_cancel"
                    }
                  ]
                ]
              }

            }

          );

        }

        if (
          String(
            user.telegram_id
          ) ===
          String(
            telegramId
          )
        ) {

          return respond("reply", ctx, 
            "⚠️ You cannot block or unblock your own admin account."
          );

        }

        pendingAdminUserSearch.delete(
          telegramId
        );

        const keyboard = [];

        if (
          user.is_blocked
        ) {

          keyboard.push([
            {
              text:
                "✅ Unblock User",

              callback_data:
                `admin_unblock_user_${user.id}`
            }
          ]);

        } else {

          keyboard.push([
            {
              text:
                "🚫 Block User",

              callback_data:
                `admin_block_user_${user.id}`
            }
          ]);

        }

        if (user.is_admin !== true) {
          keyboard.push([
            {
              text:
                "💳 Money Restrictions",
              callback_data:
                `fr_u_${user.id}`
            }
          ]);
        }

        keyboard.push([
          {
            text:
              "👤 Manage Another User",

            callback_data:
              "admin_manage_user"
          }
        ]);

        keyboard.push([
          {
            text:
              "🏠 Home",

            callback_data:
              "admin_home"
          }
        ]);

        keyboard.push([
          {
            text:
              "❌ Close",

            callback_data:
              "admin_manage_user_cancel"
          }
        ]);

        return respond("reply", ctx, 

          `👤 *USER FOUND*\n\n` +

          `👤 Name: *${
            user.name ||
            "Unknown"
          }*\n` +

          `📱 Phone: \`${
            user.phone ||
            "Not available"
          }\`\n` +

          `🔐 Blocked: ${
            user.is_blocked
              ? "🚫 Yes"
              : "✅ No"
          }\n` +

          `📌 Status: ${
            user.is_active
              ? "🟢 Active"
              : "⚪ Inactive"
          }`,

          {
            parse_mode:
              "Markdown",

            reply_markup: {
              inline_keyboard:
                keyboard
            }
          }

        );

      }


      // ========================================================
      // 5. ADMIN ROLE / USER FINANCIAL STATISTICS SEARCH
      // ========================================================

      const roleSearchState =
        pendingAdminRoleSearch.get(
          telegramId
        );

      if (
        roleSearchState
      ) {

        // ------------------------------------------------------
        // MANAGE ADMIN
        // ------------------------------------------------------

        if (
          roleSearchState.step ===
          "waiting_phone"
        ) {

          const admin =
            await db.getAdminByTelegramId(
              telegramId
            );

          if (
            !admin ||
            admin.admin_role !==
              "main"
          ) {

            pendingAdminRoleSearch.delete(
              telegramId
            );

            return respond("reply", ctx, 
              "⛔ You are not authorized to manage admins."
            );

          }

          const user =
            await db.getUserByPhoneForAdmin(
              text
            );

          if (!user) {

            return respond("reply", ctx, 

              `❌ *User not found*\n\n` +

              `📱 Phone: \`${text}\`\n\n` +

              "Please send another phone number or press Cancel.",

              {
                parse_mode:
                  "Markdown",

                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "🏠 Home",

                        callback_data:
                          "admin_home"
                      }
                    ],
                    [
                      {
                        text:
                          "❌ Cancel",

                        callback_data:
                          "admin_manage_admins_cancel"
                      }
                    ]
                  ]
                }
              }

            );

          }

          if (
            String(
              user.telegram_id
            ) ===
            String(
              telegramId
            )
          ) {

            return respond("reply", ctx, 
              "⚠️ You cannot change your own admin role."
            );

          }

          pendingAdminRoleSearch.delete(
            telegramId
          );

          const keyboard = [
            [
              {
                text:
                  "👑 Main Admin",

                callback_data:
                  `set_admin_main_${user.id}`
              }
            ],
            [
              {
                text:
                  "📊 Statistics Admin",

                callback_data:
                  `set_admin_statistics_${user.id}`
              }
            ],
            [
              {
                text:
                  "💸 Withdrawal Admin",

                callback_data:
                  `set_admin_withdrawal_${user.id}`
              }
            ],
            [
              {
                text:
                  "📢 Broadcast Admin",

                callback_data:
                  `set_admin_broadcast_${user.id}`
              }
            ]
          ];

          if (
            user.is_admin ===
            true
          ) {

            keyboard.push([
              {
                text:
                  "🚫 Remove Admin Rights",

                callback_data:
                  `remove_admin_${user.id}`
              }
            ]);

          }

          keyboard.push([
            {
              text:
                "👑 Manage Another Admin",

              callback_data:
                "admin_manage_admins"
            }
          ]);

          keyboard.push([
            {
              text:
                "🏠 Home",

              callback_data:
                "admin_home"
            }
          ]);

          const currentRole =
            user.is_admin
              ? (
                  user.admin_role ===
                    "main"
                    ? "👑 Main Admin"
                    : user.admin_role ===
                      "statistics"
                    ? "📊 Statistics Admin"
                    : user.admin_role ===
                      "withdrawal"
                    ? "💸 Withdrawal Admin"
                    : user.admin_role ===
                      "broadcast"
                    ? "📢 Broadcast Admin"
                    : "Admin"
                )
              : "👤 Normal User";

          return respond("reply", ctx, 

            `👑 *MANAGE ADMIN*\n\n` +

            `👤 Name: *${
              user.name ||
              "Unknown"
            }*\n` +

            `📱 Phone: \`${
              user.phone ||
              text
            }\`\n` +

            `🔐 Current Role: *${currentRole}*\n\n` +

            "Select the new admin role:",

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard:
                  keyboard
              }
            }

          );

        }


        // ------------------------------------------------------
        // USER FINANCIAL STATISTICS
        // ------------------------------------------------------

        if (
          roleSearchState.step ===
          "financial_statistics_phone"
        ) {

          const admin =
            await db.getAdminByTelegramId(
              telegramId
            );

          if (
            !admin ||
            (
              admin.admin_role !==
                "main" &&
              admin.admin_role !==
                "statistics"
            )
          ) {

            pendingAdminRoleSearch.delete(
              telegramId
            );

            return respond("reply", ctx, 
              "⛔ You are not authorized to view statistics."
            );

          }

          const user =
            await db.getUserByPhoneForAdmin(
              text
            );

          if (!user) {

            return respond("reply", ctx, 
              "❌ User not found.\n\n" +
              "Please send a valid registered phone number."
            );

          }

          const stats =
            await db.getUserFinancialStatistics(
              user.id
            );

          pendingAdminRoleSearch.delete(
            telegramId
          );

          const message =

            `👤 *USER FINANCIAL STATISTICS*\n\n` +

            `👤 Name: *${
              user.name ||
              "Unknown"
            }*\n` +

            `📱 Phone: \`${
              user.phone ||
              text
            }\`\n\n` +

            `💎 *Total Deposits*\n` +

            `*${
              stats.totalDepositAmount.toFixed(2)
            } ETB*\n\n` +

            `🏧 *Withdrawals*\n` +

            `⏳ Pending: *${
              stats.pendingWithdrawalAmount.toFixed(2)
            } ETB*\n` +

            `✅ Approved: *${
              stats.approvedWithdrawalAmount.toFixed(2)
            } ETB*\n` +

            `❌ Rejected: *${
              stats.rejectedWithdrawalAmount.toFixed(2)
            } ETB*`;

          return respond("reply", ctx, 

            message,

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "👤 Search Another User",

                      callback_data:
                        "admin_user_financial_statistics"
                    }
                  ],
                  [
                    {
                      text:
                        "⬅️ Statistics",

                      callback_data:
                        "admin_statistics_menu"
                    },
                    {
                      text:
                        "🏠 Home",

                      callback_data:
                        "admin_home"
                    }
                  ]
                ]
              }

            }

          );

        }

      }


      // ========================================================
      // 6. REGISTRATION: handled by the contact button (message:contact) - no name / phone typing any more
      // ========================================================


      // ========================================================
      // 7. DEPOSIT SMS
      // ========================================================

      const deposit =
        pendingDeposit[
          telegramId
        ];

      if (
        deposit
      ) {

        if (
          text.startsWith("/")
        ) {

          return next();

        }

        try {

          const paymentMethod =
            ctx.session.paymentMethod;

          const paymentType =
            ctx.session.paymentType;

          const dLang = await getLang(telegramId);

          await respond("reply", ctx, 
            tr(dLang, "dep_received")
          );
          const result = await processDeposit(
          text,
          paymentMethod.name,
          paymentMethod.amharicName,
          paymentType.name,
          paymentType.amharicName
        );
        
        if (result.timeout) {
          return await respond("reply", ctx, result.errorKey ? tr(dLang, result.errorKey) : result.errorMessage);
          
        }
        
        if (!result.success) {
          return await respond("reply", ctx, tr(dLang, "dep_receipt_missing"));
          
        }


         // const result = await processDeposit( text, paymentMethod.name, paymentMethod.amharicName, paymentType.name, paymentType.amharicName);

          if (result && result.success)
          {

            const receipt =
              result.result.receipt;

            if (!receipt || !receipt.payerName) {

              return respond("reply", ctx, 
                tr(dLang, "dep_receipt_info_missing")
              );

            }

            // extra safety checks (status, age, optional payer match / amount limit) before any money moves
            const depositUser = await db.getUserByTelegramId(telegramId);
            const rejectReason = checkReceiptForDeposit(receipt, depositUser);
            if (rejectReason) {
              console.warn(`[deposit] refused for ${telegramId}, receipt ${receipt.receiptNo}: ${rejectReason}`);
              let refusal = tr(dLang, "dep_refused");
              if (depositUser?.is_admin === true && depositUser?.admin_role === "main") {
                refusal += "\n\n" + rejectReason;
              }
              return respond("reply", ctx, refusal);
            }

            const result2 =
              await db.approveDeposit(
                receipt,
                telegramId
              );

            if (result2.success)
             {
              clearPendingState(
                telegramId
              );

              return respond("reply", ctx, 

                tr(dLang, "dep_success", receipt.settledAmount),

                {
                  parse_mode:
                    "Markdown"
                }

              );

            }
            let mess = tr(dLang, "dep_failed");
            try {
              const chkUser = await db.getUserByTelegramId(telegramId);
              if (chkUser?.is_admin === true && chkUser?.admin_role === "main") {
                mess = mess + "\n\n" + (result2.errorMessage || "");
              }
            } catch (_) {}

            return respond("reply", ctx, 
              mess
            );

          }

          return respond("reply", ctx, 
            tr(dLang, "dep_bad_sms")
          );

        } catch (err) {

          console.error(
            "Deposit processing error:",
            err
          );
          const eLang = await getLang(telegramId);
          const blockedFeature = db.parseFeatureDisabled(err);
          if (blockedFeature) {
            return respond("reply", ctx, restrictionText(blockedFeature.feature, blockedFeature.scope, eLang));
          }
          return respond("reply", ctx, tr(eLang, "dep_verify_fail"));
        }

      }
      // ========================================================
      // 8. WITHDRAWAL — ACCOUNT NUMBER
      // ========================================================

    const withdrawal =  pendingWithdrawal[telegramId];
      
      

      if (
        withdrawal &&
        withdrawal.step ===
          "account"
      ) {

        if (
          text.startsWith("/")
        ) {

          return next();

        }

        const accountNumber =
          text.replace(
            /[\s\-()]/g,
            ""
          );

        if (
          !accountNumber
        ) {

          return respond("reply", ctx, 
            await T(ctx, "wd_account_invalid")
          );

        }

        if (
          accountNumber.length >
          30
        ) {

          return respond("reply", ctx, 
            await T(ctx, "wd_account_too_long")
          );

        }
        

pendingWithdrawal[telegramId] = {
  ...withdrawal,
  step: "name",
  accountNumber
};

        return respond("reply", ctx, 

          tr(await getLang(telegramId).catch(() => null), "wd_account_ok_ask_name", accountNumber),

          {
            parse_mode:
              "Markdown"
          }

        );

      }


      // ========================================================
      // 8b. WITHDRAWAL — NAME OF THE ACCOUNT / PHONE OWNER
      // ========================================================

      if (
        withdrawal &&
        withdrawal.step === "name"
      ) {

        if (text.startsWith("/")) {
          return next();
        }

        const wLang = await getLang(telegramId).catch(() => null);
        const accountName = text.trim().replace(/\s+/g, " ");

        if (accountName.length > 100) {
          return respond("reply", ctx, tr(wLang, "wd_name_too_long"));
        }

        // letters (any language) + space . ' -   - no digits, at least 2 characters
        if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]*$/u.test(accountName) || accountName.length < 2) {
          return respond("reply", ctx, tr(wLang, "wd_name_invalid"));
        }

        pendingWithdrawal[telegramId] = {
          ...withdrawal,
          step: "amount",
          accountName
        };

        return respond("reply", ctx, 
          tr(wLang, "wd_name_ok_ask_amount", mdEsc(accountName)),
          { parse_mode: "Markdown" }
        );

      }


      // ========================================================
      // 9. WITHDRAWAL — AMOUNT
      // ========================================================

      if (
        withdrawal &&
        withdrawal.step ===
          "amount"
      ) {

        if (
          text.startsWith("/")
        ) {

          return next();

        }

        try {

          const amount =
            Number(text);

          if (
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {

            return respond("reply", ctx, 
              await T(ctx, "wd_amount_invalid")
            );

          }

          if (
            amount < 50
          ) {

            return respond("reply", ctx, 
              await T(ctx, "wd_amount_min")
            );

          }

          const user =
            await db.getUserByTelegramId(
              telegramId
            );

          if (!user) {

            clearPendingState(
  ctx.from.id
);

            return respond("reply", ctx, 
              await T(ctx, "not_found")
            );

          }

          const walletRow = await db.getUserWalletBalances(telegramId);
          const userBalance =
            Number(
              walletRow?.main_balance || 0
            );

          if (
            amount >
            userBalance
          ) {

            return respond("reply", ctx, 

              await T(ctx, "wd_insufficient", userBalance, amount)

            );

          }

          const result =
            await db.createWithdrawal(

              telegramId,

              withdrawal.paymentMethodId,

              withdrawal.accountNumber,

              amount,

              withdrawal.accountName

            );

          if (
            !result.success
          ) {

            return respond("reply", ctx, 
              result.code === "FEATURE_DISABLED"
                ? restrictionText(result.feature, result.scope, await getLang(telegramId))
                : result.code === "WITHDRAW_BLOCKED"
                  ? await T(ctx, "wd_blocked_" + String(result.reason || "").toLowerCase(), result.detail)
                  : `❌ ${result.message}`
            );

          }

          delete pendingWithdrawal[telegramId];

          return respond("reply", ctx, 

            await T(ctx, "wd_received", pmName(withdrawal.paymentMethod, await getLang(telegramId)), withdrawal.accountNumber, mdEsc(withdrawal.accountName), amount),

            {
              parse_mode:
                "Markdown"
            }

          );

        } catch (err) {

          console.error(
            "Withdrawal amount error:",
            err
          );

          return respond("reply", ctx, 
            await T(ctx, "wd_process_fail")
          );

        }

      }


      

// ========================================================
// 10. BROADCAST
// ========================================================

const admin =
  await getCurrentAdmin(ctx);

if (admin) {

  const adminTelegramId =
    admin.telegram_id;

  const draft =
    await db.getBroadcastDraft(
      adminTelegramId
    );

  // --------------------------------------------------------
  // BROADCAST CANCEL
  // --------------------------------------------------------

  if (
    text === "/cancel" &&
    draft
  ) {

      pendingBroadcastRecipient.delete(
    adminTelegramId
  );

    await db.deleteBroadcastDraft(
      adminTelegramId
    );

    return respond("reply", ctx, 
      "❌ Broadcast cancelled."
    );
  }

  // --------------------------------------------------------
  // DO NOT INTERCEPT ADMIN REJECTION
  // --------------------------------------------------------

  if (
    pendingAdminReject[
      adminTelegramId
    ]
  ) {
    return next();
  }

  if (draft) {
    // ============================================================
// BROADCAST SPECIFIC RECIPIENT PHONE
// ============================================================

if (
  draft &&
  draft.status ===
    "waiting_broadcast_phone"
) {

  const phone =
    text.trim();

  if (
    phone === "/cancel"
  ) {

    pendingBroadcastRecipient.delete(
      adminTelegramId
    );

    await db.updateBroadcastStatus(
      adminTelegramId,
      "preview"
    );

    return respond("reply", ctx, 
      "❌ Specific-person broadcast cancelled.\n\n" +
      "The broadcast draft is still available."
    );
  }

  const user =
    await db.getUserByPhone(
      phone
    );

  if (!user) {

    return respond("reply", ctx, 
      "❌ *User not found.*\n\n" +
      "Make sure the phone number is registered and the account is active.\n\n" +
      "Example:\n" +
      "`0912345678`\n\n" +
      "or\n" +
      "`+251912345678`",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // SAVE RECIPIENT IN ADMIN STATE
  // ----------------------------------------------------------

  pendingBroadcastRecipient.set(
    adminTelegramId,
    {
      step: "confirm",
      userTelegramId:
        user.telegram_id,
      userId:
        user.id,
      phone:
        user.phone,
      name:
        user.name
    }
  );

  await db.updateBroadcastStatus(
    adminTelegramId,
    "specific_recipient_confirm"
  );

  return respond("reply", ctx, 
    "👤 *Recipient Found*\n\n" +
    `👤 Name: *${mdEsc(user.name || "Unknown")}*\n` +
    `📱 Phone: \`${user.phone || phone}\`\n\n` +
    "Do you want to send the broadcast to this person?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ SEND",
              callback_data:
                "broadcast_specific_confirm"
            }
          ],
          [
            {
              text: "❌ CANCEL",
              callback_data:
                "broadcast_cancel_specific"
            }
          ]
        ]
      }
    }
  );
}

    // ------------------------------------------------------
    // MESSAGE
    // ------------------------------------------------------

    if (
      draft.status ===
      "waiting_message"
    ) {

      await db.updateBroadcastMessage(
        adminTelegramId,
        text
      );

      await respond("reply", ctx, 
        "✅ Message received."
      );

      return continueBroadcastBuilder(
        ctx,
        adminTelegramId
      );
    }


    // ------------------------------------------------------
    // AMHARIC MESSAGE (optional)
    // ------------------------------------------------------

    if (
      draft.status ===
      "waiting_message_am"
    ) {

      const skipped = text.trim().toLowerCase() === "/skip";

      await db.updateBroadcastMessageAm(
        adminTelegramId,
        skipped ? "" : text
      );

      await respond("reply", ctx, 
        skipped
          ? "⏭ Skipped - everyone gets the English text."
          : "✅ Amharic message received."
      );

      return continueBroadcastBuilder(
        ctx,
        adminTelegramId
      );
    }


    // ------------------------------------------------------
    // BUTTON TITLE
    // ------------------------------------------------------

    if (
      draft.status ===
      "waiting_button_title"
    ) {

      const buttonTitle =
        text.trim();

      if (!buttonTitle) {
        return respond("reply", ctx, 
          "❌ Button title cannot be empty."
        );
      }

      if (
        buttonTitle.length > 64
      ) {
        return respond("reply", ctx, 
          "❌ Button title must be 64 characters or fewer."
        );
      }

      await db.updateBroadcastButtonTitle(
        adminTelegramId,
        buttonTitle
      );

      await respond("reply", ctx, 
        "✅ Play button title saved."
      );

      return continueBroadcastBuilder(
        ctx,
        adminTelegramId
      );
    }

  }
}

      // ========================================================
      // NOTHING CLAIMED THIS MESSAGE
      // ========================================================

      return next();

    } catch (err) {

      console.error(
        "Unified message:text handler error:",
        err
      );

      return next();

    }

  }
);


// ============================================================
// BROADCAST CONFIRM
// ============================================================

bot.callbackQuery(
  "broadcast_confirm",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );

    if (!draft) {
      return respond("edit", ctx, 
        "❌ Broadcast draft not found."
      );
    }

    // --------------------------------------------------------
    // SECURITY / VALIDATION
    // --------------------------------------------------------

    if (
      !isBroadcastDraftComplete(
        draft
      )
    ) {
      return respond("edit", ctx, 
        "❌ Broadcast information is incomplete."
      );
    }

    const users =
      await db.getAllActiveUsers();

    await respond("edit", ctx, 
      `📢 Broadcasting...\n\n` +
      `👥 Users: ${users.length}\n\n` +
      `⏳ Please wait...`
    );

    let sent = 0;
    let failed = 0;

    // --------------------------------------------------------
    // SEND TO EVERY USER
    // --------------------------------------------------------

    for (
      const user of users
    ) {

      try {

        const userLang = user.language === "en" ? "en" : "am";
        const userText = broadcastTextFor(draft, userLang);

        const replyMarkup =
          getBroadcastKeyboard(
            draft,
            user.telegram_id,
            userLang
          );

        // ----------------------------------------------------
        // IMAGE BROADCAST
        // ----------------------------------------------------

        if (
          draft.include_image === true
        ) {

          await respond("photo", 
            user.telegram_id,
            draft.image_url,
            {
              caption:
                draft.include_text === true
                  ? userText
                  : undefined,

              reply_markup:
                replyMarkup
            }
          );

        }

        // ----------------------------------------------------
        // TEXT-ONLY BROADCAST
        // ----------------------------------------------------

        else if (
          draft.include_text === true
        ) {

          await respond("send", 
            user.telegram_id,
            userText,
            {
              reply_markup:
                replyMarkup
            }
          );

        }

        sent++;

        // Small delay between users
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              40
            )
        );

      } catch (err) {

        failed++;

        console.error(
          `❌ Failed to send to ${user.telegram_id}:`,
          err.description ||
          err.message
        );
      }
    }

    // --------------------------------------------------------
    // DELETE DRAFT
    // --------------------------------------------------------

    await db.deleteBroadcastDraft(
      adminTelegramId
    );

    // --------------------------------------------------------
    // RESULT
    // --------------------------------------------------------

    await respond("reply", ctx, 
      `📢 *Broadcast completed!*\n\n` +
      `👥 Total: ${users.length}\n` +
      `✅ Sent: ${sent}\n` +
      `❌ Failed: ${failed}`,
      {
        parse_mode: "Markdown"
      }
    );
  }
);



// ============================================================
// BROADCAST TO SPECIFIC PERSON
// ============================================================

bot.callbackQuery(
  "broadcast_specific",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );

    if (!draft) {
      return respond("reply", ctx, 
        "❌ Broadcast draft not found."
      );
    }

    if (!isBroadcastDraftComplete(draft)) {
      return respond("reply", ctx, 
        "❌ Broadcast information is incomplete."
      );
    }

    // Remember that the next text message is a
    // phone number for a specific broadcast recipient.
    pendingBroadcastRecipient.set(
      adminTelegramId,
      {
        step: "waiting_phone"
      }
    );

    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_broadcast_phone"
    );

    await respond("reply", ctx, 
      "👤 *Send to Specific Person*\n\n" +
      "Please send the user's phone number.\n\n" +
      "Example:\n" +
      "`0912345678`\n\n" +
      "or\n" +
      "`+251912345678`\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "broadcast_cancel_specific"
              }
            ]
          ]
        }
      }
    );
  }
);
// ============================================================
// BROADCAST CANCEL
// ============================================================

bot.callbackQuery(
  "broadcast_cancel",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    await db.deleteBroadcastDraft(
      admin.telegram_id
    );


    await respond("edit", ctx, 
      "❌ Broadcast cancelled."
    );

  }
);
// ============================================================
// CONFIRM SPECIFIC RECIPIENT
// ============================================================

bot.callbackQuery(
  "broadcast_specific_confirm",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );

    if (!draft) {
      return respond("edit", ctx, 
        "❌ Broadcast draft not found."
      );
    }

    if (!isBroadcastDraftComplete(draft)) {
      return respond("edit", ctx, 
        "❌ Broadcast information is incomplete."
      );
    }

    const recipient =
      pendingBroadcastRecipient.get(
        adminTelegramId
      );

    if (
      !recipient ||
      !recipient.userTelegramId
    ) {
      return respond("edit", ctx, 
        "❌ Recipient information expired. Please try again."
      );
    }

    const telegramId =
      recipient.userTelegramId;

    try {

      const userLang = (await getLang(telegramId).catch(() => "am")) === "en" ? "en" : "am";
      const userText = broadcastTextFor(draft, userLang);

      const replyMarkup =
        getBroadcastKeyboard(
          draft,
          telegramId,
          userLang
        );

      // ------------------------------------------------------
      // IMAGE
      // ------------------------------------------------------

      if (
        draft.include_image === true
      ) {

        await respond("photo", 
          telegramId,
          draft.image_url,
          {
            caption:
              draft.include_text === true
                ? userText
                : undefined,

            reply_markup:
              replyMarkup
          }
        );

      }

      // ------------------------------------------------------
      // TEXT ONLY
      // ------------------------------------------------------

      else if (
        draft.include_text === true
      ) {

        await respond("send", 
          telegramId,
          userText,
          {
            reply_markup:
              replyMarkup
          }
        );
      }

      pendingBroadcastRecipient.delete(
        adminTelegramId
      );

      await db.deleteBroadcastDraft(
        adminTelegramId
      );

      await respond("edit", ctx, 
        "✅ *Broadcast sent successfully.*\n\n" +
        `👤 Recipient: ${recipient.name || "Unknown"}\n` +
        `📱 Phone: \`${recipient.phone || "Unknown"}\``,
        {
          parse_mode: "Markdown"
        }
      );

    } catch (err) {

      console.error(
        "Specific broadcast error:",
        err
      );

      pendingBroadcastRecipient.delete(
        adminTelegramId
      );

      await respond("edit", ctx, 
        "❌ Failed to send the broadcast to this user.\n\n" +
        "The broadcast draft has NOT been deleted. " +
        "You can try again."
      );
    }
  }
);
// ============================================================
// CANCEL SPECIFIC RECIPIENT
// ============================================================

bot.callbackQuery("broadcast_cancel_specific",async (ctx) => 
  {
    const admin = await getCurrentAdmin(ctx);
    if (!admin) 
    {
      return;
    }
    await answerCallback(ctx);
    const adminTelegramId = admin.telegram_id;
    pendingBroadcastRecipient.delete(adminTelegramId);
    const draft = await db.getBroadcastDraft(adminTelegramId);
    if (draft) 
    {
      await db.updateBroadcastStatus(adminTelegramId, "preview");
    }

    await respond("edit", ctx, 
      "❌ Specific-person sending cancelled.\n\n" +
      "Your broadcast draft is still saved."
    );
  }
);
// ============================================================
// RULE MANAGER (main admin): deposit / withdrawal / transfer rules
//   Home  ->  📏 Rules  (also linked from ⚙️ Money Controls)
//   A new rule is created as an INACTIVE draft; it only starts to apply when the admin presses Activate.
//   Text answers (amounts, names) are kept in bonus_admin_sessions (flow "rule_edit"), so it works on serverless too.
// ============================================================
const RL = {
  d: { kind: "deposit",    title: "💎 Deposit rules",    one: "deposit"    },
  w: { kind: "withdrawal", title: "🏧 Withdrawal rules", one: "withdrawal" },
  t: { kind: "transfer",   title: "💸 Transfer rules",   one: "transfer"   }
};
const RL_PAGE = 6;
const RL_PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"];

// editable fields: code -> { col, label, type, nullable }
const RL_FIELDS = {
  d: { n: { col: "name", label: "Name", short: "Name", type: "text" },
       mn: { col: "minimum_amount", label: "Minimum amount (ETB)", short: "Minimum", type: "money", nullable: true },
       mx: { col: "maximum_amount", label: "Maximum amount (ETB)", short: "Maximum", type: "money", nullable: true } },
  w: { n: { col: "name", label: "Name", short: "Name", type: "text" },
       mn: { col: "minimum_amount", label: "Minimum amount (ETB)", short: "Minimum", type: "money", nullable: true },
       mx: { col: "maximum_amount", label: "Maximum amount (ETB)", short: "Maximum", type: "money", nullable: true } },
  t: { mn: { col: "minimum_transfer_amount", label: "Minimum per transfer (ETB)", short: "Min per transfer", type: "money", zeroOk: true },
       mx: { col: "maximum_transfer_amount", label: "Maximum per transfer (ETB)", short: "Max per transfer", type: "money", nullable: true },
       ct: { col: "maximum_transfer_count", label: "Maximum number of transfers in the period", short: "Max count", type: "int", nullable: true },
       pa: { col: "maximum_period_amount", label: "Maximum total amount in the period (ETB)", short: "Max period total", type: "money", nullable: true },
       rb: { col: "minimum_remaining_balance", label: "Balance that must stay in the wallet (ETB)", short: "Keep balance", type: "money", zeroOk: true },
       pr: { col: "priority", label: "Priority (higher wins)", short: "Priority", type: "int", zeroOk: true },
       ds: { col: "description", label: "Description", short: "Note", type: "text", nullable: true } }
};

function rlMoney(n) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function rlOn(r) { return r.is_active ? "✅" : "⏸"; }
function rlScope(r) {
  if (r.account_number) return `${r.method_name || "method"} · ${displayAccountNumber(r.account_number)}`;
  if (r.payment_account_id) return `account #${r.payment_account_id}`;
  if (r.method_name) return `${r.method_name} (all accounts)`;
  return "All methods";
}
function rlLine(k, r) {
  if (k === "t") {
    return `${rlOn(r)} #${r.id} ${r.wallet_type} · ${r.period} · min ${rlMoney(r.minimum_transfer_amount)} · max ${rlMoney(r.maximum_transfer_amount)}`;
  }
  return `${rlOn(r)} #${r.id} ${htmlEsc(r.name)} · ${htmlEsc(rlScope(r))} · ${rlMoney(r.minimum_amount)} – ${rlMoney(r.maximum_amount)}`;
}
function rlDetail(k, r, note) {
  const L = [];
  if (k === "t") {
    L.push(`<b>💸 Transfer rule #${r.id}</b> ${r.is_active ? "✅ Active" : "⏸ Inactive"}`, "");
    L.push(`Wallet: <b>${r.wallet_type}</b> · Period: <b>${r.period}</b>`);
    L.push(`Minimum per transfer: <b>${rlMoney(r.minimum_transfer_amount)}</b>`);
    L.push(`Maximum per transfer: <b>${rlMoney(r.maximum_transfer_amount)}</b>`);
    L.push(`Maximum number of transfers: <b>${r.maximum_transfer_count ?? "no limit"}</b>`);
    L.push(`Maximum total in the period: <b>${rlMoney(r.maximum_period_amount)}</b>`);
    L.push(`Balance that must stay: <b>${rlMoney(r.minimum_remaining_balance)}</b>`);
    L.push(`Priority: <b>${r.priority}</b>`);
    if (r.description) L.push(`Note: ${htmlEsc(r.description)}`);
  } else {
    L.push(`<b>${RL[k].title.slice(0, 2)} ${RL[k].one[0].toUpperCase() + RL[k].one.slice(1)} rule #${r.id}</b> ${r.is_active ? "✅ Active" : "⏸ Inactive"}`, "");
    L.push(`Name: <b>${htmlEsc(r.name)}</b>`);
    L.push(`Applies to: <b>${htmlEsc(rlScope(r))}</b>`);
    L.push(`Minimum amount: <b>${rlMoney(r.minimum_amount)}</b>`);
    L.push(`Maximum amount: <b>${rlMoney(r.maximum_amount)}</b>`);
    if (r.starts_at || r.ends_at) L.push(`Dates: ${r.starts_at ? new Date(r.starts_at).toISOString().slice(0, 10) : "…"} → ${r.ends_at ? new Date(r.ends_at).toISOString().slice(0, 10) : "…"}`);
  }
  if (note) L.push("", note);
  if (!r.is_active) L.push("", "<i>Inactive: players are not affected until you press Activate.</i>");
  return L.join("\n");
}
function rlDetailKb(k, r) {
  const fields = Object.entries(RL_FIELDS[k]);
  const kb = [];
  for (let i = 0; i < fields.length; i += 2) {
    kb.push(fields.slice(i, i + 2).map(([code, f]) => ({ text: "✏️ " + (f.short || f.label), callback_data: `admin_rl_e_${k}_${r.id}_${code}` })));
  }
  if (k !== "t") kb.push([{ text: "🎯 Change what it applies to", callback_data: `admin_rl_s_${k}_${r.id}` }]);
  kb.push([
    { text: r.is_active ? "⏸ Deactivate" : "▶️ Activate", callback_data: `admin_rl_t_${k}_${r.id}` },
    { text: "🗑 Delete", callback_data: `admin_rl_x_${k}_${r.id}` }
  ]);
  kb.push([{ text: "⬅️ Back to list", callback_data: `admin_rl_l_${k}_0` }, { text: "🏠 Home", callback_data: "admin_home" }]);
  return kb;
}

async function rlShow(ctx, text, kb) {
  try {
    await respond("edit", ctx, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
  } catch (_) {
    await respond("reply", ctx, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
  }
}
async function rlSave(adminId, step, data) {
  bnHint.add(adminId);
  await db.setBonusAdminSession(adminId, "rule_edit", step, data, 15);
}
async function rlClear(adminId) {
  await db.clearBonusAdminSession(adminId);
  bnHint.delete(adminId);
}

async function rlMenu(ctx) {
  const c = await db.getRuleCounts().catch(() => ({ d: 0, w: 0, t: 0 }));
  await rlShow(ctx,
    "📏 <b>Rules</b>\n\nThe limits that apply to deposits, withdrawals and transfers. Players see the deposit limit on the deposit screen.\n\n" +
    `💎 Deposit rules: <b>${c.d}</b> active\n🏧 Withdrawal rules: <b>${c.w}</b> active\n💸 Transfer rules: <b>${c.t}</b> active`,
    [
      [{ text: "💎 Deposit rules", callback_data: "admin_rl_l_d_0" }, { text: "🏧 Withdrawal rules", callback_data: "admin_rl_l_w_0" }],
      [{ text: "💸 Transfer rules", callback_data: "admin_rl_l_t_0" }],
      [{ text: "⚙️ Money Controls", callback_data: "fr_s" }, { text: "🏠 Home", callback_data: "admin_home" }]
    ]);
}

async function rlList(ctx, k, page) {
  const rows = await db.listRules(RL[k].kind);
  const pages = Math.max(1, Math.ceil(rows.length / RL_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(page * RL_PAGE, page * RL_PAGE + RL_PAGE);
  const text = `<b>${RL[k].title}</b> — ${rows.length} total` + (pages > 1 ? ` · page ${page + 1}/${pages}` : "") + "\n\n" +
    (slice.length ? slice.map((r) => rlLine(k, r)).join("\n") : "No rules yet. With no deposit/withdrawal rule there is no limit; press ➕ New rule to add one.");
  const kb = slice.map((r) => [{ text: `${rlOn(r)} #${r.id} — open`, callback_data: `admin_rl_v_${k}_${r.id}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: "◀️ Previous", callback_data: `admin_rl_l_${k}_${page - 1}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `admin_rl_l_${k}_${page + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: "➕ New rule", callback_data: `admin_rl_n_${k}` }]);
  kb.push([{ text: "📏 Rules", callback_data: "admin_rl" }, { text: "🏠 Home", callback_data: "admin_home" }]);
  await rlShow(ctx, text, kb);
}

async function rlOpen(ctx, k, id, note) {
  const r = await db.getRule(RL[k].kind, id);
  if (!r) return rlShow(ctx, "❌ That rule no longer exists.", [[{ text: "⬅️ Back to list", callback_data: `admin_rl_l_${k}_0` }]]);
  await rlShow(ctx, rlDetail(k, r, note), rlDetailKb(k, r));
}

function rlParse(f, raw) {
  const s = String(raw || "").trim();
  if (f.type === "text") {
    if (/^(none|-)$/i.test(s) && f.nullable) return { value: null };
    if (s.length < 2 || s.length > 150) return { error: "Please send 2 to 150 characters." };
    return { value: s };
  }
  if (/^(none|no|-)$/i.test(s)) {
    if (f.nullable) return { value: null };
    if (f.zeroOk) return { value: 0 };
    return { error: "This value can not be removed. Send a number." };
  }
  const n = s.replace(/,/g, "");
  if (f.type === "int") {
    if (!/^\d{1,9}$/.test(n)) return { error: "Send a whole number, for example 5." };
    const v = Number(n);
    if (v === 0 && !f.zeroOk) return { error: "It must be greater than zero (or send none)." };
    return { value: v };
  }
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(n)) return { error: "Send an amount like 500 or 500.50." };
  const v = Number(n);
  if (v === 0 && !f.zeroOk) return { error: "It must be greater than zero (or send none)." };
  return { value: v };
}

async function rlApplyEdit(ctx, adminUserId, k, id, f, value) {
  try {
    await db.updateRule(RL[k].kind, id, { [f.col]: value });
  } catch (err) {
    const msg = db.ruleError(err);
    if (msg) return rlOpen(ctx, k, id, "❌ " + msg);
    throw err;
  }
  console.log(`[rules] admin ${adminUserId} set ${RL[k].kind}_rules#${id}.${f.col} = ${value}`);
  return rlOpen(ctx, k, id, "✅ Saved.");
}

// text hook – called from the single message:text handler
async function rlTextHook(ctx, telegramId, text) {
  const sess = await db.getBonusAdminSession(telegramId);
  if (!sess || sess.flow !== "rule_edit") return false;
  bnHint.add(sess.admin_user_id);
  if (text.startsWith("/")) {
    await rlClear(sess.admin_user_id);
    if (/^\/cancel\b/i.test(text)) { await respond("reply", ctx, "❌ Cancelled."); return true; }
    return false;
  }
  const { k, id, field } = sess.data || {};
  const f = RL_FIELDS[k] && RL_FIELDS[k][field];
  if (!f) { await rlClear(sess.admin_user_id); return false; }
  const r = rlParse(f, text);
  if (r.error) {
    await respond("reply", ctx, "❌ " + r.error + "\nTry again, or press Cancel.");
    return true;
  }
  await rlClear(sess.admin_user_id);
  await rlApplyEdit(ctx, sess.admin_user_id, k, id, f, r.value);
  return true;
}

bot.callbackQuery(/^admin_rl(?:_.*)?$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    const admin = await frAdminOnly(ctx);
    if (!admin) return respond("reply", ctx, "⛔ You are not authorized.");
    const p = ctx.callbackQuery.data.split("_").slice(2);    // after "admin","rl"
    const act = p[0] || "";
    const k = RL[p[1]] ? p[1] : null;
    const id = /^\d+$/.test(p[2] || "") ? Number(p[2]) : null;

    if (act === "") { await rlClear(admin.id); return await rlMenu(ctx); }
    if (act === "l" && k) { await rlClear(admin.id); return await rlList(ctx, k, Number(p[2]) || 0); }
    if (act === "v" && k && id) { await rlClear(admin.id); return await rlOpen(ctx, k, id); }

    if (act === "n" && k) {                       // new rule
      if (k === "t") {
        return await rlShow(ctx, "💸 <b>New transfer rule</b>\n\nWhich wallet is it for?", [
          [{ text: "💰 Main wallet", callback_data: "admin_rl_nw_t_main" }, { text: "🎮 Play wallet", callback_data: "admin_rl_nw_t_play" }],
          [{ text: "❌ Cancel", callback_data: "admin_rl_l_t_0" }]
        ]);
      }
      const r = await db.createRuleDraft(RL[k].kind, admin.id, { name: "New rule" });
      return await rlOpen(ctx, k, r.id, "🆕 Draft created. Set the limits, then press Activate.");
    }
    if (act === "nw" && k === "t") {              // wallet chosen -> choose period
      const w = p[2] === "play" ? "play" : "main";
      const kb = RL_PERIODS.map((x) => [{ text: x[0].toUpperCase() + x.slice(1), callback_data: `admin_rl_np_t_${w}_${x}` }]);
      kb.push([{ text: "❌ Cancel", callback_data: "admin_rl_l_t_0" }]);
      return await rlShow(ctx, `💸 <b>New transfer rule</b> (${w} wallet)\n\nFor which period?`, kb);
    }
    if (act === "np" && k === "t") {              // period chosen -> draft
      const w = p[2] === "play" ? "play" : "main";
      const period = RL_PERIODS.includes(p[3]) ? p[3] : "daily";
      const r = await db.createRuleDraft("transfer", admin.id, { wallet_type: w, period });
      return await rlOpen(ctx, "t", r.id, "🆕 Draft created. Set the limits, then press Activate.");
    }

    if (act === "t" && k && id) {                 // activate / deactivate
      const r = await db.getRule(RL[k].kind, id);
      if (!r) return await rlOpen(ctx, k, id);
      await db.updateRule(RL[k].kind, id, { is_active: !r.is_active });
      console.log(`[rules] admin ${admin.id} ${r.is_active ? "deactivated" : "activated"} ${RL[k].kind}_rules#${id}`);
      return await rlOpen(ctx, k, id, r.is_active ? "⏸ Deactivated." : "✅ Activated – it applies from now on.");
    }

    if (act === "e" && k && id) {                 // edit one field with a typed answer
      const code = p[3];
      const f = RL_FIELDS[k][code];
      if (!f) return await rlOpen(ctx, k, id);
      await rlSave(admin.id, "val", { k, id, field: code });
      const hint = f.type === "text" ? "Send the new text." : f.nullable ? "Send a number, or <b>none</b> for no limit." : f.zeroOk ? "Send a number (0 = none)." : "Send a number.";
      return await rlShow(ctx, `✏️ <b>${htmlEsc(f.label)}</b>\n\n${hint}`, [[{ text: "❌ Cancel", callback_data: `admin_rl_v_${k}_${id}` }]]);
    }

    if (act === "s" && (k === "d" || k === "w") && id) {   // scope: choose method
      const methods = await db.listPaymentMethodsForRules();
      const kb = [[{ text: "🌍 All payment methods", callback_data: `admin_rl_sm_${k}_${id}_0` }]];
      for (const m of methods) kb.push([{ text: `${m.emoji || "💳"} ${m.name}`, callback_data: `admin_rl_sm_${k}_${id}_${m.id}` }]);
      kb.push([{ text: "⬅️ Back", callback_data: `admin_rl_v_${k}_${id}` }]);
      return await rlShow(ctx, "🎯 <b>What does this rule apply to?</b>\n\nChoose a payment method:", kb);
    }
    if (act === "sm" && (k === "d" || k === "w") && id) {  // method chosen
      const mid = Number(p[3]) || 0;
      if (!mid) {
        await db.updateRule(RL[k].kind, id, { payment_method_id: null, payment_account_id: null });
        return await rlOpen(ctx, k, id, "✅ Now applies to all payment methods.");
      }
      const accounts = await db.listPaymentAccountsForRules(mid);
      const kb = [[{ text: "All accounts of this method", callback_data: `admin_rl_sa_${k}_${id}_${mid}_0` }]];
      for (const a of accounts) kb.push([{ text: `${displayAccountNumber(a.account_number)}${a.account_name ? " (" + accountOwnerFirstName(a) + ")" : ""}`, callback_data: `admin_rl_sa_${k}_${id}_${mid}_${a.id}` }]);
      kb.push([{ text: "⬅️ Back", callback_data: `admin_rl_s_${k}_${id}` }]);
      return await rlShow(ctx, "🎯 Choose the account:", kb);
    }
    if (act === "sa" && (k === "d" || k === "w") && id) {  // account chosen
      const mid = Number(p[3]) || 0;
      const aid = Number(p[4]) || 0;
      await db.updateRule(RL[k].kind, id, { payment_method_id: mid || null, payment_account_id: aid || null });
      return await rlOpen(ctx, k, id, "✅ Saved.");
    }

    if (act === "x" && k && id) {                 // delete: ask
      return await rlShow(ctx, `🗑 <b>Delete rule #${id}?</b>\n\nIf old records still use it, it is only switched off instead.`, [
        [{ text: "🗑 Yes, delete", callback_data: `admin_rl_xy_${k}_${id}` }],
        [{ text: "❌ No", callback_data: `admin_rl_v_${k}_${id}` }]
      ]);
    }
    if (act === "xy" && k && id) {
      const res = await db.deleteRule(RL[k].kind, id);
      console.log(`[rules] admin ${admin.id} ${res} ${RL[k].kind}_rules#${id}`);
      if (res === "deactivated") return await rlOpen(ctx, k, id, "🔒 Old records use this rule, so it was only deactivated.");
      return await rlList(ctx, k, 0);
    }

    return await rlMenu(ctx);
  } catch (err) {
    console.error("rule manager error:", err);
    const msg = (db.ruleError && db.ruleError(err)) || "Something went wrong.";
    try { await respond("reply", ctx, "❌ " + msg); } catch (_) {}
  }
});

// ============================================================
// ERROR HANDLER
// ============================================================
bot.catch((err) => {console.error("Telegram bot error:", err.error); });
// ============================================================
// VERCEL WEBHOOK
// ============================================================
// Telegram sends the secret you give to setWebhook(secret_token) in the header X-Telegram-Bot-Api-Secret-Token.
// With WEBHOOK_SECRET set, a request without the right header is answered 401 and never reaches the bot, so nobody
// who only knows the URL can send fake updates (for example "from" an admin).
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
if (!WEBHOOK_SECRET) {
  console.error("❌ WEBHOOK_SECRET is not set: anyone who knows the webhook URL can send fake Telegram updates. " +
    "Set WEBHOOK_SECRET and register the webhook with the same secret_token.");
}
module.exports = webhookCallback(bot, "http", {
  timeoutMilliseconds: 30000,
  onTimeout: "return",
  ...(WEBHOOK_SECRET ? { secretToken: WEBHOOK_SECRET } : {}),
});
