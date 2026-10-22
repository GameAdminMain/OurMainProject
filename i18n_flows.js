// i18n_flows.js - translations (English / Amharic) for the user screens:
// statistics + history, balance, deposit, withdraw, transfer, leaderboard, play, support, restriction notices.
// i18n.js merges this file into its table, so  tr(lang, "key", ...args)  works for these keys too.
// Add a language later by adding a third property (e.g. om: "...") next to en / am.
"use strict";

const FLOWS = {
  // ================= common =================
  start_first: { en: "Please /start to register first.", am: "እባክዎ መጀመሪያ /start ብለው ይመዝገቡ።" },
  btn_refresh: { en: "🔄 Refresh", am: "🔄 አድስ" },
  btn_prev: { en: "◀️ Previous", am: "◀️ ቀዳሚ" },
  btn_next: { en: "Next ▶️", am: "ቀጣይ ▶️" },
  btn_cancel: { en: "❌ Cancel", am: "❌ ሰርዝ" },
  btn_back: { en: "⬅️ Back", am: "⬅️ ተመለስ" },
  btn_confirm: { en: "✅ Confirm", am: "✅ አረጋግጥ" },
  err_generic: { en: "❌ Something went wrong. Please try again.", am: "❌ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።" },
  // ================= sign-up bonus =================
  signup_bonus: {
    en: (amt) => `🎁 *Welcome gift!*\n\nWe added *${Number(amt).toFixed(2)} ETB* to your Bonus wallet. Good luck! 🎱`,
    am: (amt) => `🎁 *የእንኳን ደህና መጡ ስጦታ!*\n\n*${Number(amt).toFixed(2)} ብር* ወደ ቦነስ ሂሳብዎ ተጨምሯል። መልካም ዕድል! 🎱`
  },
  // ================= statistics =================
  stats_load_fail: { en: "❌ Could not load your statistics.", am: "❌ ስታቲስቲክስዎን መጫን አልተቻለም።" },
  stats_fail: { en: "❌ Unable to load statistics right now.", am: "❌ ስታቲስቲክስን አሁን መጫን አልተቻለም።" },
  stats_text: {
    en: (s) => `📊 *YOUR STATISTICS*\n\n💎 Total Deposits: *${s.totalDeposits}*\n\n🏧 *Withdrawals*\n⏳ Pending Approval: *${s.pendingWithdrawals}*\n✅ Approved: *${s.approvedWithdrawals}*\n❌ Rejected: *${s.rejectedWithdrawals}*`,
    am: (s) => `📊 *የእርስዎ ስታቲስቲክስ*\n\n💎 ጠቅላላ ገቢ: *${s.totalDeposits}*\n\n🏧 *ወጪዎች*\n⏳ ማረጋገጫ በመጠባበቅ ላይ: *${s.pendingWithdrawals}*\n✅ የጸደቁ: *${s.approvedWithdrawals}*\n❌ ውድቅ የተደረጉ: *${s.rejectedWithdrawals}*`
  },
  stats_btn_dep: { en: "💎 Deposits", am: "💎 ገቢ" },
  stats_btn_wd: { en: "🏧 Withdrawals", am: "🏧 ወጪ" },
  stats_btn_tr: { en: "💸 Transfers", am: "💸 ዝውውር" },
  stats_btn_bn: { en: "🎁 Bonuses", am: "🎁 ቦነስ" },
  hist_dep_title: { en: "💎 Deposits", am: "💎 ገቢ" },
  hist_wd_title: { en: "🏧 Withdrawals", am: "🏧 ወጪ" },
  hist_tr_title: { en: "💸 Transfers", am: "💸 ዝውውር" },
  hist_bn_title: { en: "🎁 Bonuses", am: "🎁 ቦነስ" },
  hist_dep_empty: { en: "You have no deposits yet.", am: "እስካሁን ምንም ገቢ የለዎትም።" },
  hist_wd_empty: { en: "You have no withdrawals yet.", am: "እስካሁን ምንም ወጪ የለዎትም።" },
  hist_tr_empty: { en: "You have no transfers yet.", am: "እስካሁን ምንም ዝውውር የለዎትም።" },
  hist_bn_empty: { en: "You have no bonuses yet.", am: "እስካሁን ምንም ቦነስ የለዎትም።" },
  hist_sent: { en: "↗️ Sent", am: "↗️ የተላከ" },
  hist_received: { en: "↙️ Received", am: "↙️ የተቀበሉት" },
  hist_main: { en: "💰 Main", am: "💰 ዋና" },
  hist_play: { en: "🎮 Play", am: "🎮 መጫወቻ" },
  hist_bonus_word: { en: "Bonus", am: "ቦነስ" },
  hist_left: { en: "left", am: "ቀሪ" },
  hist_wagered: { en: "wagered", am: "የተጫወቱት" },
  hist_total: { en: "total", am: "ጠቅላላ" },
  hist_page: { en: "page", am: "ገጽ" },
  hist_done: { en: "done", am: "ተጠናቋል" },
  hist_games: { en: "games", am: "ጨዋታዎች" },
  hist_win_daily: { en: "today", am: "ዛሬ" },
  hist_win_weekly: { en: "this week", am: "በዚህ ሳምንት" },
  hist_win_monthly: { en: "this month", am: "በዚህ ወር" },
  hist_fail: { en: "❌ Unable to load this list right now.", am: "❌ ይህን ዝርዝር አሁን መጫን አልተቻለም።" },
  hist_status_completed: { en: "completed", am: "ተጠናቋል" },
  hist_status_approved: { en: "approved", am: "ጸድቋል" },
  hist_status_pending: { en: "pending", am: "በመጠባበቅ ላይ" },
  hist_status_processing: { en: "processing", am: "በሂደት ላይ" },
  hist_status_rejected: { en: "rejected", am: "ውድቅ ተደርጓል" },
  hist_status_failed: { en: "failed", am: "አልተሳካም" },
  hist_status_cancelled: { en: "cancelled", am: "ተሰርዟል" },
  hist_status_reversed: { en: "reversed", am: "ተመልሷል" },
  hist_status_active: { en: "active", am: "ንቁ" },
  hist_status_expired: { en: "expired", am: "ጊዜው አልፏል" },
  hist_status_forfeited: { en: "forfeited", am: "ተሰርዟል" },
  home_fail: { en: "❌ Unable to return to home.", am: "❌ ወደ መነሻ መመለስ አልተቻለም።" },
  // ================= balance =================
  balance_text: {
    en: (w) => `\n💼 <b>Account Info</b><pre>\nName:          ${w.name}\nPhone:         ${w.phone}\nMain wallet:   ${w.main_balance}\nPlay wallet:   ${w.play_balance}\nBonus wallet:  ${w.bonus_balance}\nTotal Balance: ${w.total_balance}</pre>`,
    // Amharic letters are not monospace, so labels cannot be padded with spaces: the amounts (ASCII digits) go first in a fixed-width column and the label follows
    am: (w) => { const a = (v) => String(v).padStart(10, " "); return `\n💼 <b>የአካውንት መረጃ</b><pre>\nስም: ${w.name}\nስልክ: ${w.phone}\n\n${a(w.main_balance)}  ዋና ሂሳብ\n${a(w.play_balance)}  መጫወቻ ሂሳብ\n${a(w.bonus_balance)}  ቦነስ ሂሳብ\n${"─".repeat(10)}\n${a(w.total_balance)}  ጠቅላላ ሂሳብ</pre>`; }
  },
  // ================= withdrawal safety (safety_dashboard.sql) =================
  wd_blocked_daily_limit: {
    en: (left) => `⛔ Daily withdrawal limit reached. You can withdraw up to ${left} ETB more within the next 24 hours.`,
    am: (left) => `⛔ የዕለት የወጪ ገደብ ደርሷል። በቀጣዮቹ 24 ሰዓታት ውስጥ እስከ ${left} ብር ተጨማሪ ማውጣት ይችላሉ።`
  },
  wd_blocked_daily_count: {
    en: (n) => `⛔ You have reached the maximum of ${n} withdrawal requests in 24 hours. Please try again later.`,
    am: (n) => `⛔ በ24 ሰዓት ውስጥ ከሚፈቀደው ከፍተኛ ${n} የወጪ ጥያቄ ደርሰዋል። እባክዎ ቆይተው ይሞክሩ።`
  },
  wd_blocked_cooldown: {
    en: (min) => `⏳ For security, withdrawals are available ${min} minute(s) after a deposit. Please try again then.`,
    am: (min) => `⏳ ለደህንነት ሲባል ገንዘብ ካስገቡ በኋላ ወጪ ማድረግ የሚቻለው ከ${min} ደቂቃ በኋላ ነው። እባክዎ ያኔ ይሞክሩ።`
  },
  wd_blocked_low_play: {
    en: () => `⛔ Please play some games with your deposit before withdrawing.`,
    am: () => `⛔ ወጪ ከማድረግዎ በፊት ያስገቡትን ገንዘብ በጨዋታ ይጠቀሙ።`
  },
  balance_btn_deposit: { en: "💵 Deposit", am: "💵 ገቢ አድርግ" },
  balance_btn_withdraw: { en: "🤑 Withdraw", am: "🤑 ወጪ አድርግ" },
  // ================= deposit =================
  dep_no_methods: { en: "Sorry! No payment method is available right now.", am: "ይቅርታ! ለጊዜው የክፍያ መንገድ አልተዘጋጀም።" },
  dep_intro: {
    en: (count, names) => {
      const list = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
      return `❇️ You can deposit only through the following ${list} payment ${count <= 1 ? "option" : "options"}.\n\n🚫 We do not accept payments sent any other way 🚫\n\n`;
    },
    am: (count, names) => {
      const list = names.length === 1 ? names[0] : names.slice(0, -1).map((n) => "የ" + n).join(", ") + " እና የ" + names[names.length - 1];
      return `❇️ ብር ማስገባት የሚችሉት ቀጥሎ ${count <= 1 ? "በተቀመጠው " : "በተቀመጡት "}${list} ክፍያ ${count <= 1 ? "አማራጭ" : "አማራጮች"} ብቻ ነው።\n\n🚫 ከዚህ ዉጭ የላከ አናስተናግድም 🚫\n\n`;
    }
  },
  pay_method_missing: { en: "❌ Payment method not found.", am: "❌ የክፍያ መንገዱ አልተገኘም።" },
  pay_option_missing: { en: "❌ Payment option not found.", am: "❌ የክፍያ አማራጭ አልተገኘም።" },
  pay_method_fail: { en: "❌ Could not open this payment method.", am: "❌ የክፍያ መንገዱን ማስኬድ አልተቻለም።" },
  pay_coming_soon: { en: "This payment method will start soon.", am: "ይህ የክፍያ መንገድ በቅርቡ ይጀምራል።" },
  dep_limit_line: {
    en: (min, max) => {
      const f = (v) => Number(v).toFixed(2);
      if (min !== null && max !== null) return `between ${f(min)} and ${f(max)} ETB only`;
      if (max !== null) return `up to ${f(max)} ETB only`;
      if (min !== null) return `at least ${f(min)} ETB only`;
      return "any amount";
    },
    am: (min, max) => {
      const f = (v) => Number(v).toFixed(2);
      if (min !== null && max !== null) return `ከ${f(min)} እስከ ${f(max)} ብር ብቻ`;
      if (max !== null) return `እስከ ${f(max)} ብር ድረስ ብቻ`;
      if (min !== null) return `ቢያንስ ${f(min)} ብር ብቻ`;
      return "ማንኛውንም መጠን";
    }
  },
  dep_instructions: {
    en: (limit, pmName, emoji, name, account, owner) =>
      `1. Deposit ${limit} to the ${pmName} account below\n\n${emoji} *${name}:* \`${account}\`${owner ? " (" + owner + ")" : ""}\n\n` +
      `2. Copy the transaction number or the link — or the short text message (SMS) — paste it here and send it.\n\n` +
      `⚠️ When you send the SMS, we want you to know that we neither see nor keep any information other than the transaction number.\n\n` +
      `Send it here 👇👇👇\n\n`,
    am: (limit, pmName, emoji, name, account, owner) =>
      `1. ከታች ባለው የ${pmName} አካውንት ${limit} ያስገቡ\n\n${emoji} *${name}:* \`${account}\`${owner ? " (" + owner + ")" : ""}\n\n` +
      `2. የግብይቱን መለያ ቁጥር ወይም ሊንኩን፣ ካልሆነም አጭር የጽሑፍ መልዕክቱን (SMS) ኮፒ በማድረግ እዚህ ላይ ፔስት አድርገው ያስገቡና ይላኩት።\n\n` +
      `⚠️አጭር የፅሁፍ መልዕክት(SMS) ሲልኩ ከግብይቱ መለያ ቁጥር በስተቀር የምናየውም ሆነ መዝግበን የምንይዘው መረጃ እንደሌለ ከወዲሁ ማሳወቅ እንወዳለን።\n\n` +
      `እዚህ ጋር ይላኩት👇👇👇\n\n`
  },
  dep_cancelled: { en: "Your deposit request was cancelled. ❌", am: "የገቢ ጥያቄዎ ተሰርዟል። ❌" },
  // ================= withdraw: start =================
  wd_low_balance: {
    en: (b) => `❌ Your balance is not enough.\n\n💰 Your balance: ${b} ETB\n\nThe minimum withdrawal is 50 ETB.`,
    am: (b) => `❌ በቂ ቀሪ ሂሳብ የሎትም።\n\n💰 ያለዎት ሂሳብ፦ ${b} ETB\n\nዝቅተኛው የወጪ መጠን 50 ETB ነው።`
  },
  wd_no_methods: { en: "❌ No withdrawal payment method is available right now.", am: "❌ ለጊዜው የወጪ የክፍያ መንገድ አልተዘጋጀም።" },
  wd_choose_method: {
    en: "🏧 *Withdraw money*\n\nPlease choose the payment method you want to receive your money with.",
    am: "🏧 *ብር ማውጣት*\n\nእባክዎ ብርዎን ለመቀበል የሚፈልጉትን የክፍያ መንገድ ይምረጡ።"
  },
  wd_expired: { en: "❌ This withdrawal request has expired. Press /start.", am: "❌ የወጪ ጥያቄው ጊዜው አልፎበታል። /start ይጫኑ።" },
  wd_ask_account: {
    en: (pm) => `🏧 *Withdrawal account*\n\n💳 Payment method: *${pm}*\n\n📱 Enter the account number you want to receive the money with.\n\nExample: \`0912345678\``,
    am: (pm) => `🏧 *የወጪ አካውንት*\n\n💳 የክፍያ መንገድ፦ *${pm}*\n\n📱 ብር የሚቀበሉበትን የአካውንት ቁጥር ያስገቡ።\n\nምሳሌ፦ \`0912345678\``
  },
  wd_cancelled: { en: "❌ Your withdrawal request was cancelled.", am: "❌ የወጪ ጥያቄዎ ተሰርዟል።" },
  wd_approved_user: {
    en: (amount, account, bal) => `✅ *Your withdrawal request was approved!*\n\n💰 Amount: *${amount} ETB*\n\n📱 Account: \`${account}\`\n\n💰 New balance: *${bal} ETB*`,
    am: (amount, account, bal) => `✅ *የወጪ ጥያቄዎ ጸድቋል!*\n\n💰 መጠን፦ *${amount} ETB*\n📱 አካውንት፦ \`${account}\`\n\n💰 አዲሱ ቀሪ ሂሳብ፦ *${bal} ETB*`
  },
  wd_rejected_user: {
    en: (amount, reason) => `❌ *Your withdrawal request was not accepted.*\n\n💰 Amount: *${amount} ETB*\n\n📝 Reason:\n${reason}`,
    am: (amount, reason) => `❌ *የወጪ ጥያቄዎ ተቀባይነት አላገኘም።*\n\n💰 መጠን፦ *${amount} ETB*\n\n📝 ምክንያት፦\n${reason}`
  },
  // ================= deposit: receipt check =================
  dep_received: { en: "✅⏳ We received your payment message. Your payment is being verified. Please wait a moment.", am: "✅⏳ የክፍያ መልዕክትዎ ደርሶናል። ክፍያዎ እየተረጋገጠ ነው። እባክዎ ትንሽ ይጠብቁ።" },
  dep_receipt_missing: { en: "❌ Receipt information was not found.", am: "❌ የደረሰኝ መረጃው አልተገኘም።" },
  dep_receipt_info_missing: { en: "❌ Payment receipt information was not found.", am: "❌ የክፍያ ደረሰኝ መረጃ አልተገኘም።" },
  dep_refused: { en: "❌ Your deposit request failed. The receipt is not valid or not new. Please contact support.", am: "❌ የገቢ ጥያቄዎ አልተሳካም። ደረሰኙ ትክክለኛ ወይም አዲስ አይደለም። እባክዎ ድጋፍን ያነጋግሩ።" },
  dep_success: {
    en: (amount) => `✅ *Your deposit was successful!*\n\n💰 ${amount} was added to your balance.`,
    am: (amount) => `✅ *የገቢ ጥያቄዎ ተሳክቷል!*\n\n💰 ${amount} ወደ ሂሳብዎ ተጨምሯል።`
  },
  dep_failed: { en: "❌ Your deposit request failed.", am: "❌ የገቢ ጥያቄዎ አልተሳካም።" },
  dep_bad_sms: { en: "🚫 The request failed. Please send the correct SMS.", am: "🚫 ጥያቄው አልተሳካም። እባክዎ ትክክለኛውን SMS ይላኩ።" },
  dep_verify_fail: { en: "❌ Could not verify the payment.", am: "❌ ክፍያውን ማረጋገጥ አልተቻለም።" },
  // ================= withdraw: steps =================
  wd_account_invalid: { en: "❌ Please enter a valid account number.", am: "❌ እባክዎ ትክክለኛ የአካውንት ቁጥር ያስገቡ።" },
  wd_account_too_long: { en: "❌ The account number cannot be longer than 30 characters.", am: "❌ የአካውንት ቁጥሩ ከ30 ፊደል/ቁጥር መብለጥ አይችልም።" },
  wd_amount_invalid: { en: "❌ Please enter a valid amount.", am: "❌ እባክዎ ትክክለኛ የብር መጠን ያስገቡ።" },
  wd_amount_min: { en: "❌ The minimum withdrawal is 50 ETB.", am: "❌ ዝቅተኛው የወጪ መጠን 50 ETB ነው።" },
  wd_insufficient: {
    en: (bal, amount) => `❌ Your balance is not enough.\n\n💰 Your balance: ${bal} ETB\n💸 You requested: ${amount} ETB`,
    am: (bal, amount) => `❌ በቂ ቀሪ ሂሳብ የሎትም።\n\n💰 ያለዎት ቀሪ ሂሳብ፦ ${bal} ETB\n💸 የጠየቁት፦ ${amount} ETB`
  },
  wd_received: {
    en: (pm, account, name, amount) => `✅ *We received your withdrawal request!*\n\n💳 Payment method: *${pm}*\n📱 Account: *${account}*\n👤 Account name: *${name}*\n💰 Amount: *${amount} ETB*\n\n⏳ Your request is being reviewed by an admin.`,
    am: (pm, account, name, amount) => `✅ *የወጪ ጥያቄዎ ተቀብለናል!*\n\n💳 የክፍያ መንገድ፦ *${pm}*\n📱 አካውንት፦ *${account}*\n👤 የአካውንት ስም፦ *${name}*\n💰 መጠን፦ *${amount} ETB*\n\n⏳ ጥያቄዎ በአስተዳዳሪ እየተገመገመ ነው።`
  },
  wd_process_fail: { en: "❌ Could not process your withdrawal request.", am: "❌ የወጪ ጥያቄውን ማስኬድ አልተቻለም።" },
  support_text: {
    en: "🆘 Need help?\n\n👇 For any question or feedback 👇\n\n👤 @mesobbingosupport",
    am: "🆘 ድጋፍ ይፈልጋሉ?\n\n👇 ለማንኛውም ጥያቄ ወይም አስተያየት 👇\n\n👤 @mesobbingosupport"
  },
  lb_title: { en: "🏆 *Leaderboard*", am: "🏆 *የደረጃ ሰንጠረዥ*" },
  lb_empty: { en: "No games yet!", am: "እስካሁን ምንም ጨዋታ የለም!" },
  lb_wins: { en: "wins", am: "ድሎች" },
  play_ready: {
    en: (name, bal) => `Ready to play, *${name}*? 🎱\nBalance: *${bal} ETB*`,
    am: (name, bal) => `ለመጫወት ዝግጁ ነዎት፣ *${name}*? 🎱\nቀሪ ሂሳብ: *${bal} ETB*`
  },
  play_open: { en: (t) => `🎮 Open ${t}`, am: (t) => `🎮 ${t} ክፈት` },
  // ================= transfer =================
  tr_wallet: { en: "Wallet", am: "ሂሳብ" },
  tr_wallet_main: { en: "💰 Main Wallet", am: "💰 ዋና ሂሳብ" },
  tr_wallet_play: { en: "🎮 Play Wallet", am: "🎮 መጫወቻ ሂሳብ" },
  tr_btn_continue: { en: "✅ Continue", am: "✅ ቀጥል" },
  tr_btn_confirm: { en: "✅ Confirm Transfer", am: "✅ ዝውውሩን አረጋግጥ" },
  tr_btn_change: { en: "✏️ Change Amount", am: "✏️ መጠኑን ቀይር" },
  tr_received: {
    en: (o) => `💸 *MONEY RECEIVED*\n\nYou received *${o.amount}* in your ${o.walletName}.\n\n👤 From: *${o.senderName || "A user"}*\n📱 Sender phone: *${o.senderPhone || "N/A"}*\n\n💰 Wallet: *${o.walletName}*\n` + (o.transactionId ? `🧾 Transaction ID: \`${o.transactionId}\`\n` : "") + "\nThe money has been added to your wallet successfully.",
    am: (o) => `💸 *ገንዘብ ተቀብለዋል*\n\nበ${o.walletName}ዎ *${o.amount}* ተቀብለዋል።\n\n👤 ከ፦ *${o.senderName || "አንድ ተጠቃሚ"}*\n📱 የላኪ ስልክ፦ *${o.senderPhone || "—"}*\n\n💰 ሂሳብ፦ *${o.walletName}*\n` + (o.transactionId ? `🧾 የግብይት መለያ፦ \`${o.transactionId}\`\n` : "") + "\nገንዘቡ በተሳካ ሁኔታ ወደ ሂሳብዎ ተጨምሯል።"
  },
  tr_not_eligible: { en: "🚫 Your account is not eligible for transfers.", am: "🚫 አካውንትዎ ዝውውር ለማድረግ ብቁ አይደለም።" },
  tr_menu: {
    en: "💸 *TRANSFER MONEY*\n\nChoose the wallet you want to transfer money from.\n\n💰 Main Wallet → another user's Main Wallet\n🎮 Play Wallet → another user's Play Wallet",
    am: "💸 *ገንዘብ ማስተላለፍ*\n\nገንዘብ ለማስተላለፍ የሚፈልጉበትን ሂሳብ ይምረጡ።\n\n💰 ዋና ሂሳብ → ወደ ሌላ ተጠቃሚ ዋና ሂሳብ\n🎮 መጫወቻ ሂሳብ → ወደ ሌላ ተጠቃሚ መጫወቻ ሂሳብ"
  },
  tr_start_fail: { en: "❌ Unable to start the transfer right now. Please try again.", am: "❌ ዝውውሩን አሁን መጀመር አልተቻለም። እባክዎ እንደገና ይሞክሩ።" },
  tr_limits_fail: { en: "❌ Transfer limits could not be loaded.", am: "❌ የዝውውር ገደቦችን መጫን አልተቻለም።" },
  tr_limits_block: {
    en: (bal, min, keep, max) => `💰 Available balance: *${bal}*\n📌 Minimum transfer: *${min}*\n🔒 Minimum balance to keep: *${keep}*\n📊 Maximum you can transfer: *${max}*`,
    am: (bal, min, keep, max) => `💰 ያለዎት ሂሳብ፦ *${bal}*\n📌 ዝቅተኛ ዝውውር፦ *${min}*\n🔒 መቆየት ያለበት ዝቅተኛ ሂሳብ፦ *${keep}*\n📊 ማስተላለፍ የሚችሉት ከፍተኛ መጠን፦ *${max}*`
  },
  tr_not_enough_min: {
    en: "❌ You do not have enough available balance to make the minimum transfer while keeping the required minimum balance.",
    am: "❌ ዝቅተኛውን ዝውውር ለማድረግና መቆየት ያለበትን ዝቅተኛ ሂሳብ ለመጠበቅ በቂ ሂሳብ የለዎትም።"
  },
  tr_limits_now: {
    en: (bal, min, keep, max) => `💰 Available balance: *${bal}*\n📌 Minimum transfer: *${min}*\n🔒 Minimum balance to keep: *${keep}*\n📊 Maximum you can transfer now: *${max}*`,
    am: (bal, min, keep, max) => `💰 ያለዎት ሂሳብ፦ *${bal}*\n📌 ዝቅተኛ ዝውውር፦ *${min}*\n🔒 መቆየት ያለበት ዝቅተኛ ሂሳብ፦ *${keep}*\n📊 አሁን ማስተላለፍ የሚችሉት ከፍተኛ መጠን፦ *${max}*`
  },
  tr_max_per: { en: (v) => `📌 Maximum per transfer: *${v}*`, am: (v) => `📌 ለአንድ ዝውውር ከፍተኛ መጠን፦ *${v}*` },
  tr_daily_count: { en: (v) => `📅 Daily remaining transfers: *${v}*`, am: (v) => `📅 ዛሬ የቀሩ ዝውውሮች፦ *${v}*` },
  tr_daily_amount: { en: (v) => `💵 Daily remaining amount: *${v}*`, am: (v) => `💵 ዛሬ የቀረ መጠን፦ *${v}*` },
  tr_ask_phone: {
    en: "📱 *Enter the recipient's phone number.*\n\nExample: `0912345678`\nor `+251912345678`\n\n❌ Send /cancel to cancel.",
    am: "📱 *የተቀባዩን ስልክ ቁጥር ያስገቡ።*\n\nምሳሌ፦ `0912345678`\nወይም `+251912345678`\n\n❌ ለመሰረዝ /cancel ይላኩ።"
  },
  tr_expired: { en: "⏱ This transfer session has expired. Please start again.", am: "⏱ የዝውውር ክፍለ ጊዜው አልፎበታል። እባክዎ እንደገና ይጀምሩ።" },
  tr_recipient_head: {
    en: (wallet, name, phone) => `💸 *TRANSFER FROM ${wallet}*\n\n👤 Recipient: *${name || "User"}*\n📱 Phone: *${phone}*\n\n`,
    am: (wallet, name, phone) => `💸 *ከ${wallet} ማስተላለፍ*\n\n👤 ተቀባይ፦ *${name || "ተጠቃሚ"}*\n📱 ስልክ፦ *${phone}*\n\n`
  },
  tr_l_available: { en: "Available balance", am: "ያለዎት ሂሳብ" },
  tr_l_min: { en: "Minimum", am: "ዝቅተኛ" },
  tr_ask_amount: {
    en: "💵 *Enter the amount you want to transfer.*\n\nExample: `500`\n\n❌ Send /cancel to cancel.",
    am: "💵 *ማስተላለፍ የሚፈልጉትን መጠን ያስገቡ።*\n\nምሳሌ፦ `500`\n\n❌ ለመሰረዝ /cancel ይላኩ።"
  },
  tr_change_text: {
    en: (rname, rphone, wallet, bal, min, max) => `💵 *ENTER TRANSFER AMOUNT*\n\n👤 Recipient: *${rname}*\n📱 Phone: *${rphone}*\n\n💰 Wallet: *${wallet}*\n💰 Available: *${bal}*\n\n📌 Minimum: *${min}*\n` + (max !== null && max !== undefined ? `📌 Maximum: *${max}*\n` : "") + `\nEnter the amount.\n\n❌ Send /cancel to cancel.`,
    am: (rname, rphone, wallet, bal, min, max) => `💵 *የዝውውር መጠን ያስገቡ*\n\n👤 ተቀባይ፦ *${rname}*\n📱 ስልክ፦ *${rphone}*\n\n💰 ሂሳብ፦ *${wallet}*\n💰 ያለዎት፦ *${bal}*\n\n📌 ዝቅተኛ፦ *${min}*\n` + (max !== null && max !== undefined ? `📌 ከፍተኛ፦ *${max}*\n` : "") + `\nመጠኑን ያስገቡ።\n\n❌ ለመሰረዝ /cancel ይላኩ።`
  },
  tr_limits_fail_retry: { en: "❌ Transfer limits could not be loaded. Please try again.", am: "❌ የዝውውር ገደቦችን መጫን አልተቻለም። እባክዎ እንደገና ይሞክሩ።" },
  tr_cannot_min: { en: "❌ You can no longer make the minimum transfer from this wallet.", am: "❌ ከዚህ ሂሳብ ዝቅተኛውን ዝውውር ማድረግ አይችሉም።" },
  tr_retry_text: {
    en: (rname, rphone, wallet, bal, keep, min, maxNow, max) => `💵 *ENTER TRANSFER AMOUNT*\n\n👤 Recipient: *${rname}*\n📱 Phone: *${rphone}*\n\n💰 Wallet: *${wallet}*\n💰 Available: *${bal}*\n🔒 Minimum balance to keep: *${keep}*\n\n📌 Minimum: *${min}*\n📊 Maximum you can transfer now: *${maxNow}*\n` + (max !== null && max !== undefined ? `📌 Maximum per transfer: *${max}*\n` : "") + `\nEnter the amount.\n\n❌ Send /cancel to cancel.`,
    am: (rname, rphone, wallet, bal, keep, min, maxNow, max) => `💵 *የዝውውር መጠን ያስገቡ*\n\n👤 ተቀባይ፦ *${rname}*\n📱 ስልክ፦ *${rphone}*\n\n💰 ሂሳብ፦ *${wallet}*\n💰 ያለዎት፦ *${bal}*\n🔒 መቆየት ያለበት ዝቅተኛ ሂሳብ፦ *${keep}*\n\n📌 ዝቅተኛ፦ *${min}*\n📊 አሁን ማስተላለፍ የሚችሉት ከፍተኛ መጠን፦ *${maxNow}*\n` + (max !== null && max !== undefined ? `📌 ለአንድ ዝውውር ከፍተኛ፦ *${max}*\n` : "") + `\nመጠኑን ያስገቡ።\n\n❌ ለመሰረዝ /cancel ይላኩ።`
  },
  tr_incomplete: { en: "❌ Transfer information is incomplete. Please start again.", am: "❌ የዝውውር መረጃው ያልተሟላ ነው። እባክዎ እንደገና ይጀምሩ።" },
  tr_processing: { en: "⏳ *Processing transfer...*\n\nPlease wait. Do not send the transfer again.", am: "⏳ *ዝውውሩ በሂደት ላይ ነው...*\n\nእባክዎ ይጠብቁ። ዝውውሩን እንደገና አይላኩ።" },
  tr_success_head: {
    en: (wallet, rname, phone, amount) => `✅ *TRANSFER SUCCESSFUL*\n\n💰 Wallet: *${wallet}*\n👤 Recipient: *${rname}*\n📱 Phone: *${phone}*\n💵 Amount: *${amount}*\n\n`,
    am: (wallet, rname, phone, amount) => `✅ *ዝውውሩ ተሳክቷል*\n\n💰 ሂሳብ፦ *${wallet}*\n👤 ተቀባይ፦ *${rname}*\n📱 ስልክ፦ *${phone}*\n💵 መጠን፦ *${amount}*\n\n`
  },
  tr_new_balance: { en: (v) => `💰 Your new balance: *${v}*\n\n`, am: (v) => `💰 አዲሱ ቀሪ ሂሳብዎ፦ *${v}*\n\n` },
  tr_txid: { en: (v) => `🧾 Transaction ID: \`${v}\`\n`, am: (v) => `🧾 የግብይት መለያ፦ \`${v}\`\n` },
  tr_success_tail: { en: "The money has been transferred successfully.", am: "ገንዘቡ በተሳካ ሁኔታ ተላልፏል።" },
  tr_failed_head: { en: "❌ *TRANSFER FAILED*\n\n", am: "❌ *ዝውውሩ አልተሳካም*\n\n" },
  tr_insufficient: { en: "Your wallet balance is not sufficient for this transfer.", am: "በሂሳብዎ ውስጥ ያለው ገንዘብ ለዚህ ዝውውር በቂ አይደለም።" },
  tr_recipient_gone: { en: "The recipient is no longer available for transfers.", am: "ተቀባዩ ዝውውር መቀበል አይችልም።" },
  tr_self: { en: "You cannot transfer money to yourself.", am: "ለራስዎ ገንዘብ ማስተላለፍ አይችሉም።" },
  tr_generic_fail: { en: "The transfer could not be completed. Please try again.", am: "ዝውውሩን ማጠናቀቅ አልተቻለም። እባክዎ እንደገና ይሞክሩ።" },
  tr_not_deducted: { en: "Your money was not intentionally deducted by the bot.", am: "ቦቱ ሆን ብሎ ከሂሳብዎ ምንም ገንዘብ አልቀነሰም።" },
  tr_btn_retry: { en: "🔄 Try Again", am: "🔄 እንደገና ሞክር" },
  tr_cancelled: { en: "❌ *Transfer cancelled.*\n\nNo money was transferred.", am: "❌ *ዝውውሩ ተሰርዟል።*\n\nምንም ገንዘብ አልተላለፈም።" },
  tr_cancelled_plain: { en: "❌ Transfer cancelled.\n\nNo money was transferred.", am: "❌ ዝውውሩ ተሰርዟል።\n\nምንም ገንዘብ አልተላለፈም።" },
  tr_phone_invalid: {
    en: "❌ Invalid Ethiopian phone number.\n\nPlease enter a valid number such as:\n`0912345678`\nor\n`+251912345678`\n\n❌ Send /cancel to cancel.",
    am: "❌ የኢትዮጵያ ስልክ ቁጥር ትክክል አይደለም።\n\nእባክዎ ትክክለኛ ቁጥር ያስገቡ፤ ለምሳሌ፦\n`0912345678`\nወይም\n`+251912345678`\n\n❌ ለመሰረዝ /cancel ይላኩ።"
  },
  tr_account_gone: { en: "❌ Your account could not be found. Please /start again.", am: "❌ አካውንትዎ አልተገኘም። እባክዎ /start ብለው እንደገና ይጀምሩ።" },
  tr_phone_verify_fail: { en: "❌ Unable to verify that phone number right now. Please try again.", am: "❌ ይህን ስልክ ቁጥር አሁን ማረጋገጥ አልተቻለም። እባክዎ እንደገና ይሞክሩ።" },
  tr_recipient_unknown: { en: "❌ This phone number is not registered or the account is unavailable.\n\nPlease enter another registered user's phone number.", am: "❌ ይህ ስልክ ቁጥር አልተመዘገበም ወይም አካውንቱ አይገኝም።\n\nእባክዎ የሌላ የተመዘገበ ተጠቃሚ ስልክ ቁጥር ያስገቡ።" },
  tr_self_phone: { en: "❌ You cannot transfer money to yourself.\n\nPlease enter another user's phone number.", am: "❌ ለራስዎ ገንዘብ ማስተላለፍ አይችሉም።\n\nእባክዎ የሌላ ተጠቃሚ ስልክ ቁጥር ያስገቡ።" },
  tr_registered_user: { en: "Registered User", am: "የተመዘገበ ተጠቃሚ" },
  tr_recipient_found: {
    en: (name, phone, wallet) => `👤 *RECIPIENT FOUND*\n\nName: *${name}*\nPhone: *${phone}*\n\nWallet: *${wallet}*\n\nPlease confirm that this is the person you want to send money to.`,
    am: (name, phone, wallet) => `👤 *ተቀባይ ተገኝቷል*\n\nስም፦ *${name}*\nስልክ፦ *${phone}*\n\nሂሳብ፦ *${wallet}*\n\nእባክዎ ገንዘብ ሊልኩለት የሚፈልጉት ሰው ይህ መሆኑን ያረጋግጡ።`
  },
  tr_amount_invalid: {
    en: "❌ Invalid amount.\n\nPlease enter a positive amount, for example:\n`500`\n`500.50`\n\n❌ Send /cancel to cancel.",
    am: "❌ መጠኑ ትክክል አይደለም።\n\nእባክዎ ትክክለኛ መጠን ያስገቡ፤ ለምሳሌ፦\n`500`\n`500.50`\n\n❌ ለመሰረዝ /cancel ይላኩ።"
  },
  tr_amount_zero: { en: "❌ Amount must be greater than zero.", am: "❌ መጠኑ ከዜሮ በላይ መሆን አለበት።" },
  tr_verify_fail: { en: "❌ Unable to verify your transfer limits right now. Please try again.", am: "❌ የዝውውር ገደብዎን አሁን ማረጋገጥ አልተቻለም። እባክዎ እንደገና ይሞክሩ።" },
  tr_insufficient_amt: {
    en: (bal, amount) => `❌ Insufficient balance.\n\nAvailable: *${bal}*\nRequested: *${amount}*`,
    am: (bal, amount) => `❌ በቂ ሂሳብ የለዎትም።\n\nያለዎት፦ *${bal}*\nየጠየቁት፦ *${amount}*`
  },
  tr_min_amount: { en: (v) => `❌ The minimum transfer amount is *${v}*.`, am: (v) => `❌ ዝቅተኛው የዝውውር መጠን *${v}* ነው።` },
  tr_max_amount: { en: (v) => `❌ The maximum amount per transfer is *${v}*.`, am: (v) => `❌ ለአንድ ዝውውር ከፍተኛው መጠን *${v}* ነው።` },
  tr_per_daily: { en: "daily", am: "የቀን" },
  tr_per_weekly: { en: "weekly", am: "የሳምንት" },
  tr_per_monthly: { en: "monthly", am: "የወር" },
  tr_per_quarterly: { en: "quarterly", am: "የሩብ ዓመት" },
  tr_per_yearly: { en: "yearly", am: "የዓመት" },
  tr_count_limit: { en: (p) => `❌ You have reached your ${p} transfer count limit.`, am: (p) => `❌ ${p} የዝውውር ብዛት ገደብዎ ላይ ደርሰዋል።` },
  tr_amount_limit: {
    en: (p, rem) => `❌ ${p.charAt(0).toUpperCase() + p.slice(1)} transfer amount limit exceeded.\n\nRemaining in this period: *${rem}*`,
    am: (p, rem) => `❌ ${p} የዝውውር መጠን ገደብ አልፏል።\n\nበዚህ ጊዜ የቀረ፦ *${rem}*`
  },
  tr_confirm_text: {
    en: (rname, rphone, wallet, amount, bal, after) => `💸 *CONFIRM TRANSFER*\n\n👤 Recipient: *${rname}*\n📱 Phone: *${rphone}*\n\n💰 From: *${wallet}*\n💵 Amount: *${amount}*\n\n💰 Current balance: *${bal}*\n💰 Balance after transfer: *${after}*\n\n⚠️ Please verify the recipient and amount before confirming.`,
    am: (rname, rphone, wallet, amount, bal, after) => `💸 *ዝውውሩን ያረጋግጡ*\n\n👤 ተቀባይ፦ *${rname}*\n📱 ስልክ፦ *${rphone}*\n\n💰 ከ፦ *${wallet}*\n💵 መጠን፦ *${amount}*\n\n💰 አሁን ያለዎት ሂሳብ፦ *${bal}*\n💰 ከዝውውር በኋላ ሂሳብ፦ *${after}*\n\n⚠️ ከማረጋገጥዎ በፊት ተቀባዩንና መጠኑን ያረጋግጡ።`
  },
  fr_added: {
    en: (names) => `🚫 *Account restriction added*\nThe following is now restricted on your account: ${names}.\n\nPlease contact support for details.`,
    am: (names) => `🚫 *የአካውንት ገደብ ተጥሏል*\nለእርስዎ አካውንት የሚከተለው አገልግሎት ተገድቧል፦ ${names}\n\nለበለጠ መረጃ ድጋፍን ያነጋግሩ።`
  },
  fr_removed: {
    en: (names) => `✅ *Restriction removed*\nThe following is available again on your account: ${names}.`,
    am: (names) => `✅ *ገደብ ተነስቷል*\nየሚከተለው አገልግሎት ለእርስዎ አካውንት እንደገና ተፈቅዷል፦ ${names}`
  },
  busy: { en: "⚠️ Service is busy. Please try again in a moment.", am: "⚠️ አገልግሎቱ ተጨናንቋል። እባክዎ ትንሽ ቆይተው ይሞክሩ።" },
  busy_short: { en: "⚠️ Please try again in a moment.", am: "⚠️ እባክዎ ትንሽ ቆይተው ይሞክሩ።" }
};

module.exports = { FLOWS };
