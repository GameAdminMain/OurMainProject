/**
 * i18n.js - ALL bot texts in English (en) and Amharic (am).
 *
 *   tr(lang, key, ...args)   lang = 'en' | 'am' | null.  English is the default
 *                            (used when the user has not chosen a language, or a key has no translation).
 *
 * To translate a new screen: add a key below with both `en` and `am`
 * (a function if the text has values:  en: (n) => `Hello ${n}`), then use tr(lang, "key", value) in bot.js.
 * Admin screens are NOT translated on purpose - they stay English.
 *
 * Placed next to db.js (repo root); bot.js loads it with require("../i18n").
 */
// ---- bot identity (set BOT_NAME and BOT_VERSION in the environment) ----
const BOT_NAME = String(process.env.BOT_NAME || "Beteseb Bingo Plus").trim() || "Beteseb Bingo Plus";
const BOT_VERSION = String(process.env.BOT_VERSION || "").trim();
const BOT_TITLE = BOT_VERSION ? `${BOT_NAME} ${BOT_VERSION}` : BOT_NAME;


const I18N = {
  btn_play:      { en: "🎮 Play", am: "🎮 ተጫወት" },
  btn_balance:   { en: "💰 Balance", am: "💰 ቀሪ ሂሳብ" },
  btn_stats:     { en: "📊 Statistics", am: "📊 ስታቲስቲክስ" },
  btn_deposit:   { en: "💎 Deposit", am: "💎 ገቢ አድርግ" },
  btn_withdraw:  { en: "🏧 Withdraw", am: "🏧 ወጪ አድርግ" },
  btn_transfer:  { en: "💸 Transfer", am: "💸 አስተላልፍ" },
  btn_support:   { en: "🆘 Support", am: "🆘 እርዳታ" },
  btn_pause:     { en: "⏸ Pause Account", am: "⏸ አካውንት አቁም" },
  btn_language:  { en: "🌐 Language / ቋንቋ", am: "🌐 ቋንቋ / Language" },
  btn_home:      { en: "🏠 Home", am: "🏠 መነሻ" },
  home_text: {
    en: (name) => `👋 Welcome to ${BOT_TITLE}, *${name}!* 🎱\n\nChoose an option below:`,
    am: (name) => `👋 ወደ ${BOT_TITLE} እንኳን በደህና መጡ፣ *${name}!* 🎱\n\nከታች አንዱን ይምረጡ፦`
  },
  lang_title: {
    en: "🌐 *Choose your language*\n\nThe menu, messages and the game will use it.",
    am: "🌐 *ቋንቋዎን ይምረጡ*\n\nምናሌው፣ መልዕክቶቹ እና ጨዋታው ይህንን ቋንቋ ይጠቀማሉ።"
  },
  lang_saved: { en: "✅ Language: English", am: "✅ ቋንቋ፦ አማርኛ" },
  lang_error: { en: "❌ Could not change the language. Please try again.", am: "❌ ቋንቋውን መቀየር አልተቻለም። እባክዎ እንደገና ይሞክሩ።" },
  pause_confirm: {
    en: "⏸ *Pause your account?*\n\nYour account will be paused. Your balance and your deposit and withdrawal history are kept.\n\nYou will get no more messages from us.\n\nYou can come back any time: send /start and tap *Reactivate*.\n\nAre you sure?",
    am: "⏸ *አካውንትዎን ማቆም ይፈልጋሉ?*\n\nአካውንትዎ ይቆማል (ይቦዝናል)። ቀሪ ሂሳብዎ፣ የገቢ እና የወጪ ታሪክዎ አይሰረዝም።\n\nከአሁን በኋላ ማስታወቂያም ሆነ መረጃ አይደርስዎትም።\n\nበኋላ /start ተጭነው «አካውንቴን መልስ» የሚለውን ቁልፍ በመንካት እንደገና ማንቃት ይችላሉ።\n\nእርግጠኛ ነዎት?"
  },
  yes: { en: "Yes", am: "አዎ" },
  no: { en: "No", am: "አይ" },
  pause_cancelled: { en: "✅ Cancelled – your account stays as it is.", am: "✅ ተሰርዟል፤ አካውንትዎ እንደነበረ ነው።" },
  pause_done: {
    en: "⏸ *Your account is paused.*\n\nYour personal details, balance and transaction history were not deleted.\n\nSend /start to come back.",
    am: "⏸ *አካውንትዎ ቆሟል።*\n\nየግል መረጃዎ፣ ቀሪ ሂሳብዎ እና የግብይት ታሪክዎ አልተሰረዙም።\n\nእንደገና ለመጀመር /start ይጫኑ።"
  },
  pause_fail: { en: "❌ Could not pause your account.\n\nPlease try again.", am: "❌ አካውንትዎን ማቆም አልተቻለም።\n\nእባክዎ እንደገና ይሞክሩ።" },
  not_found: { en: "❌ Account not found.", am: "❌ አካውንትዎ አልተገኘም።" },
  paused_start: {
    en: "⏸ *Your account is paused.*\n\nYour balance and history are safe. Tap the button below to use it again.",
    am: "⏸ *አካውንትዎ ቆሟል።*\n\nቀሪ ሂሳብዎ እና ታሪክዎ እንደተጠበቀ ነው። እንደገና መጠቀም ከፈለጉ ከታች ያለውን ቁልፍ ይንኩ።"
  },
  btn_reactivate: { en: "▶️ Reactivate my account", am: "▶️ አካውንቴን መልስ" },
  reactivated: {
    en: () => `✅ *Welcome back!*\n\nYour ${BOT_TITLE} account is active again. 🎱`,
    am: () => `✅ *እንኳን ደህና መጡ!*\n\nየእርስዎ ${BOT_TITLE} አካውንት እንደገና ንቁ ሆኗል። 🎱`
  },
  // ---- withdraw: name of the account / phone owner ----
  wd_account_ok_ask_name: {
    en: (acc) => `✅ *Account number received.*\n\n📱 Account: *${acc}*\n\n👤 Now enter the *full name of the account (or phone number) owner*, exactly as registered.\n\nExample: \`Abebe Kebede Alemu\``,
    am: (acc) => `✅ *የአካውንት ቁጥር ተቀብለናል።*\n\n📱 አካውንት፦ *${acc}*\n\n👤 አሁን የአካውንቱን (ወይም የስልክ ቁጥሩን) *ባለቤት ሙሉ ስም* በተመዘገበው መሠረት ያስገቡ።\n\nምሳሌ፦ \`አበበ ከበደ አለሙ\``
  },
  wd_name_invalid: {
    en: "❌ Please enter a valid name (letters only, at least 2 characters).",
    am: "❌ እባክዎ ትክክለኛ ስም ያስገቡ (ፊደል ብቻ፣ ቢያንስ 2 ፊደል)።"
  },
  wd_name_too_long: {
    en: "❌ The name cannot be longer than 100 characters.",
    am: "❌ ስሙ ከ100 ፊደል መብለጥ አይችልም።"
  },
  wd_name_ok_ask_amount: {
    en: (name) => `✅ *Name received.*\n\n👤 Name: *${name}*\n\n💰 Now enter the amount you want to withdraw.\n\nExample: \`100\``,
    am: (name) => `✅ *ስሙን ተቀብለናል።*\n\n👤 ስም፦ *${name}*\n\n💰 አሁን ማውጣት የሚፈልጉትን የብር መጠን ያስገቡ።\n\nምሳሌ፦ \`100\``
  },
  wd_name_label: { en: "Account name", am: "የአካውንት ስም" },
  // ---- registration: the first thing a new user is asked for is their phone number (contact button) ----
  reg_ask: {
    en: (title) => `👋 Welcome to *${title}!*\n\nTo create your account, tap the button below to share your phone number.\n\nℹ️ Your Telegram *first name* and the *phone number* you share will be used to register your account on this bot.`,
    am: (title) => `👋 ወደ *${title}* እንኳን በደህና መጡ!\n\nአካውንት ለመክፈት ከታች ያለውን ቁልፍ ተጭነው ስልክ ቁጥርዎን ያጋሩ።\n\nℹ️ አካውንትዎን በዚህ ቦት ላይ ለመመዝገብ የቴሌግራም *የመጀመሪያ ስምዎ* እና የሚያጋሩት *ስልክ ቁጥር* ጥቅም ላይ ይውላሉ።`
  },
  reg_again: {
    en: "📱 Please tap *Share my phone number* below to create your account first.",
    am: "📱 መጀመሪያ አካውንት ለመክፈት ከታች ያለውን *ስልኬን አጋራ* ቁልፍ ይንኩ።"
  },
  reg_btn_share: { en: "📱 Share my phone number", am: "📱 ስልኬን አጋራ" },
  reg_own_only: {
    en: "❌ Please share your own phone number with the button below.",
    am: "❌ እባክዎ የራስዎን ስልክ ቁጥር ከታች ባለው ቁልፍ ያጋሩ።"
  },
  reg_phone_invalid: {
    en: "❌ Only Ethiopian phone numbers can be registered (09…, 07… or +251…).",
    am: "❌ የኢትዮጵያ ስልክ ቁጥር ብቻ መመዝገብ ይቻላል (09…፣ 07… ወይም +251…)።"
  },
  reg_blocked: {
    en: "🚫 This account is blocked. Please contact support.",
    am: "🚫 ይህ አካውንት ታግዷል። እባክዎ ድጋፍን ያነጋግሩ።"
  },
  reg_done: {
    en: (name, phone) => `✅ *Registered successfully!*\n\nName: *${name}*\nPhone: ${phone}\n\nYou're all set! 🎱`,
    am: (name, phone) => `✅ *በተሳካ ሁኔታ ተመዝግበዋል!*\n\nስም፦ *${name}*\nስልክ፦ ${phone}\n\nሁሉም ዝግጁ ነው! 🎱`
  },
  reg_failed: {
    en: "❌ Registration failed. Please send /start and try again.",
    am: "❌ ምዝገባው አልተሳካም። እባክዎ /start ልከው እንደገና ይሞክሩ።"
  }
};

Object.assign(I18N, require("./i18n_flows").FLOWS);   // deposit / withdraw / transfer / statistics ... texts live in i18n_flows.js

function tr(lang, key, ...args) {
  const e = I18N[key];
  if (!e) return key;
  const v = (lang !== "en" && e.am !== undefined) ? e.am : e.en;   // Amharic is the default
  return typeof v === "function" ? v(...args) : v;
}

module.exports = { I18N, tr, BOT_NAME, BOT_VERSION, BOT_TITLE };
