/**
 * ref_lookup.js — admin "🧾 Receipt lookup": everything the deposits table knows about one receipt (reference) number.
 *
 * The 🧾 Receipt lookup button (Home, main admin only) asks for the number. An exact match shows the full details;
 * otherwise up to 8 deposits whose reference contains the text are listed as buttons. Texts follow the admin's language (English / Amharic).
 *
 * Used from api/bot.js:
 *   const refLookup = require("../ref_lookup")({ bot, db, getCurrentAdmin, getLang, respond, answerCallback, clearPendingState, denyAccess });
 *   refLookup.textHook(ctx, telegramId, text)   inside the single message:text handler
 *   refLookup.clear(telegramId)                 inside clearPendingState()
 */

const L = {
  en: {
    title: "🧾 <b>Receipt lookup</b>",
    ask: "🧾 <b>Receipt lookup</b>\n\nSend the receipt (reference) number, for example <code>DJ92KW2GFW</code>.\nYou can also send part of it (at least 4 characters).",
    too_short: "❌ Send at least 4 characters of the receipt number.",
    none: (r) => `🔎 No deposit uses the receipt number <code>${r}</code>.\n\nThe receipt was never used in this bot. Send another number, or go back.`,
    many: (r, n) => `🔎 No exact match for <code>${r}</code>. ${n} deposit(s) contain it. Tap one to see the details:`,
    error: "❌ The lookup failed. Please try again.",
    s_receipt: "Receipt", s_player: "Player", s_payment: "Payment", s_status: "Status & dates",
    reference: "Reference", deposit_id: "Deposit ID", name: "Name", username: "Username", tg_id: "Telegram ID",
    phone: "Phone", user_id: "User ID", player_state: "Account", blocked: "🚫 blocked", paused: "⏸ paused", active: "🟢 active",
    amount: "Amount", method: "Method", to_account: "Paid to", payer: "Payer (receipt)", payer_acc: "Payer account",
    status: "Status", created: "Used / submitted", credited: "Credited", approved_by: "Approved by", auto: "automatic (bot)",
    rejected: "Rejected", rejected_by: "Rejected by", reason: "Reason", updated: "Last change", tx: "Transaction", rule: "Deposit rule",
    history: "Player's deposits", history_v: (n, sum) => `${n} completed · ${sum} ETB total`,
    also_used: "⚠️ This receipt number appears in more than one deposit",
    st: { pending: "⏳ pending", processing: "🔄 processing", completed: "✅ completed", rejected: "❌ rejected", cancelled: "🚫 cancelled", failed: "⚠️ failed", reversed: "↩️ reversed" },
    manual_title: (r) => `📝 <b>Manual deposit request(s) for <code>${r}</code></b>`,
    manual_none_deposit: "No deposit was saved with this number.",
    shown_account: "Account shown", sent_text: "Player sent", handled_by: "Handled by", request_id: "Request",
    btn_again: "🔎 Look up another", btn_home: "🏠 Home"
  },
  am: {
    title: "🧾 <b>የደረሰኝ ፍለጋ</b>",
    ask: "🧾 <b>የደረሰኝ ፍለጋ</b>\n\nየደረሰኙን (reference) ቁጥር ይላኩ፤ ለምሳሌ <code>DJ92KW2GFW</code>።\nከፊሉን ብቻም መላክ ይችላሉ (ቢያንስ 4 ፊደል/ቁጥር)።",
    too_short: "❌ ከደረሰኝ ቁጥሩ ቢያንስ 4 ፊደል/ቁጥር ይላኩ።",
    none: (r) => `🔎 <code>${r}</code> የሚል ደረሰኝ ቁጥር የተጠቀመ ተቀማጭ የለም።\n\nይህ ደረሰኝ በዚህ ቦት ጥቅም ላይ አልዋለም። ሌላ ቁጥር ይላኩ ወይም ይመለሱ።`,
    many: (r, n) => `🔎 ለ <code>${r}</code> ትክክለኛ ተዛማጅ የለም። ${n} ተቀማጭ(ዎች) ይህን ይዘዋል። ዝርዝሩን ለማየት አንዱን ይጫኑ፦`,
    error: "❌ ፍለጋው አልተሳካም። እባክዎ እንደገና ይሞክሩ።",
    s_receipt: "ደረሰኝ", s_player: "ተጫዋች", s_payment: "ክፍያ", s_status: "ሁኔታ እና ቀኖች",
    reference: "ደረሰኝ ቁጥር", deposit_id: "የተቀማጭ መለያ", name: "ስም", username: "ዩዘርኔም", tg_id: "ቴሌግራም መለያ",
    phone: "ስልክ", user_id: "የተጠቃሚ መለያ", player_state: "አካውንት", blocked: "🚫 የታገደ", paused: "⏸ የቆመ", active: "🟢 ንቁ",
    amount: "መጠን", method: "የክፍያ ዘዴ", to_account: "የተከፈለለት", payer: "ከፋይ (ደረሰኝ)", payer_acc: "የከፋይ አካውንት",
    status: "ሁኔታ", created: "ጥቅም ላይ የዋለበት", credited: "ገቢ የተደረገበት", approved_by: "ያጸደቀው", auto: "በራስ-ሰር (ቦት)",
    rejected: "ውድቅ የተደረገበት", rejected_by: "ውድቅ ያደረገው", reason: "ምክንያት", updated: "መጨረሻ የተቀየረበት", tx: "ግብይት", rule: "የተቀማጭ ደንብ",
    history: "የተጫዋቹ ተቀማጮች", history_v: (n, sum) => `${n} የተጠናቀቁ · በድምሩ ${sum} ብር`,
    also_used: "⚠️ ይህ ደረሰኝ ቁጥር ከአንድ በላይ ተቀማጭ ላይ ይገኛል",
    st: { pending: "⏳ በመጠባበቅ ላይ", processing: "🔄 በሂደት ላይ", completed: "✅ ተጠናቋል", rejected: "❌ ውድቅ ተደርጓል", cancelled: "🚫 ተሰርዟል", failed: "⚠️ አልተሳካም", reversed: "↩️ ተመልሷል" },
    manual_title: (r) => `📝 <b>ለ <code>${r}</code> የቀረቡ በእጅ የሚጸድቁ የገቢ ጥያቄዎች</b>`,
    manual_none_deposit: "በዚህ ቁጥር የተመዘገበ ተቀማጭ የለም።",
    shown_account: "የታየው አካውንት", sent_text: "ተጫዋቹ የላከው", handled_by: "የያዘው", request_id: "ጥያቄ",
    btn_again: "🔎 ሌላ ፈልግ", btn_home: "🏠 መነሻ"
  }
};

const ASK_MINUTES = 10;

function esc(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function when(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-GB", {
      timeZone: "Africa/Addis_Ababa", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
  } catch (_) { return String(ts); }
}

function money(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// a receipt number has no spaces; people paste it with spaces or a trailing dot sometimes
function cleanRef(text) {
  return String(text || "").replace(/\s+/g, "").replace(/[.,;:]+$/, "").slice(0, 100);
}

module.exports = function setupRefLookup({ bot, db, getCurrentAdmin, getLang, respond, answerCallback, clearPendingState, denyAccess }) {
  const pendingAsk = new Map();   // admin telegramId -> expiry (ms)

  async function mainAdmin(ctx) {
    const admin = await getCurrentAdmin(ctx);
    return admin && admin.admin_role === "main" ? admin : null;
  }

  async function langOf(ctx) {
    try { return (await getLang(ctx.from.id)) === "am" ? "am" : "en"; } catch (_) { return "en"; }
  }

  function navKb(t) {
    return { inline_keyboard: [[{ text: t.btn_again, callback_data: "admin_rcpt" }, { text: t.btn_home, callback_data: "admin_home" }]] };
  }

  async function telegramUsername(telegramId) {
    if (!telegramId) return null;
    try {
      const chat = await bot.api.getChat(telegramId);
      return chat && chat.username ? "@" + chat.username : null;
    } catch (_) { return null; }
  }

  async function detailText(t, lang, d, sameRefCount) {
    const row = (label, value) => `${label}: ${value}`;
    const pm = (lang === "am" ? (d.pm_amharic_name || d.pm_name) : (d.pm_name || d.pm_amharic_name)) || "—";
    const status = t.st[d.status] || esc(d.status || "—");
    const username = await telegramUsername(d.telegram_id);
    const account = d.user_blocked ? t.blocked : (d.user_active === false ? t.paused : t.active);

    let history = null;
    try {
      const h = await db.getUserCompletedDepositTotals(d.user_id);
      if (h) history = t.history_v(h.n, money(h.total));
    } catch (_) {}

    const lines = [
      t.title,
      "",
      `<b>${t.s_receipt}</b>`,
      row(t.reference, `<code>${esc(d.reference)}</code>`),
      row(t.deposit_id, `#${d.id}`),
      row(t.amount, `<b>${money(d.amount)} ETB</b>`),
      row(t.status, status),
      "",
      `<b>${t.s_player}</b>`,
      row(t.name, `<b>${esc(d.user_name || "—")}</b>`),
      row(t.username, esc(username || "—")),
      row(t.tg_id, d.telegram_id ? `<code>${esc(d.telegram_id)}</code>` : "—"),
      row(t.phone, d.user_phone ? `<code>${esc(d.user_phone)}</code>` : "—"),
      row(t.user_id, `#${esc(d.user_id)}`),
      row(t.player_state, account)
    ];
    if (history) lines.push(row(t.history, history));
    lines.push(
      "",
      `<b>${t.s_payment}</b>`,
      row(t.method, `${d.pm_emoji ? d.pm_emoji + " " : ""}${esc(pm)}`),
      row(t.to_account, `${esc(d.pa_name || "—")}${d.pa_number ? ` · <code>${esc(d.pa_number)}</code>` : ""}`),
      row(t.payer, esc(d.depositor_name || "—")),
      row(t.payer_acc, d.depositor_account ? `<code>${esc(d.depositor_account)}</code>` : "—"),
      "",
      `<b>${t.s_status}</b>`,
      row(t.created, when(d.created_at))
    );
    if (d.approved_at) {
      lines.push(row(t.credited, when(d.approved_at)));
      lines.push(row(t.approved_by, d.approved_by_id ? `${esc(d.approved_by_name || "")} (<code>${esc(d.approved_by_tg || "")}</code>)` : t.auto));
    }
    if (d.rejected_at || d.rejected_by_id || d.rejection_reason) {
      lines.push(row(t.rejected, when(d.rejected_at)));
      if (d.rejected_by_id) lines.push(row(t.rejected_by, `${esc(d.rejected_by_name || "")} (<code>${esc(d.rejected_by_tg || "")}</code>)`));
      if (d.rejection_reason) lines.push(row(t.reason, esc(d.rejection_reason)));
    }
    if (d.transaction_id) lines.push(row(t.tx, `#${esc(d.transaction_id)}${d.tx_status ? ` (${esc(d.tx_status)})` : ""}`));
    if (d.rule_id) lines.push(row(t.rule, esc(d.rule_name || d.rule_code || `#${d.rule_id}`)));
    lines.push(row(t.updated, when(d.updated_at)));
    if (sameRefCount > 1) lines.push("", `${t.also_used} (${sameRefCount})`);
    return lines.join("\n");
  }

  // manual deposit requests (manual_deposit_requests) with this reference
  function manualText(t, ref, rows) {
    const lines = [t.manual_title(esc(ref)), t.manual_none_deposit];
    for (const r of rows) {
      const msg = String(r.message || "").trim();
      lines.push(
        "",
        `<b>${t.request_id} #${r.id}</b> · ${t.st[r.status] || esc(r.status)}`,
        `${t.name}: ${esc(r.user_name || "—")} (<code>${esc(r.telegram_id)}</code>)`,
        `${t.method}: ${esc(r.pm_emoji || "")} ${esc(r.pm_name || "—")}`,
        `${t.shown_account}: <code>${esc(r.shown_account_number || "—")}</code> ${esc(r.shown_account_name || "")}`,
        `${t.created}: ${when(r.created_at)}`
      );
      if (r.amount != null) lines.push(`${t.amount}: ${money(r.amount)}`);
      if (r.handled_by_name) lines.push(`${t.handled_by}: ${esc(r.handled_by_name)} · ${when(r.handled_at)}`);
      if (r.rejection_reason) lines.push(`${t.reason}: ${esc(r.rejection_reason)}`);
      if (msg && msg.toUpperCase() !== String(r.reference).toUpperCase()) lines.push(`${t.sent_text}: ${esc(msg.slice(0, 200))}`);
    }
    return lines.join("\n");
  }

  // sends the result for one search text; returns true when something was found
  async function lookup(ctx, input) {
    const lang = await langOf(ctx);
    const t = L[lang];
    const ref = cleanRef(input);
    if (ref.length < 4) {
      await respond("reply", ctx, t.too_short, { reply_markup: navKb(t) });
      return false;
    }
    try {
      const exact = await db.getReceiptDepositsByReference(ref);
      if (exact.length) {
        // the newest row is shown; more than one row means the receipt was saved twice (should never happen)
        const text = await detailText(t, lang, exact[0], exact.length);
        await respond("reply", ctx, text, { parse_mode: "HTML", reply_markup: navKb(t) });
        return true;
      }
      // deposit approval mode = manual: a request that is waiting or was rejected is not in deposits
      const manual = await db.getManualDepositRequestsByReference(ref, 5);
      if (manual.length) {
        await respond("reply", ctx, manualText(t, ref, manual), { parse_mode: "HTML", reply_markup: navKb(t) });
        return true;
      }
      const part = await db.searchDepositsByReferencePart(ref, 8);
      if (!part.length) {
        await respond("reply", ctx, t.none(esc(ref)), { parse_mode: "HTML", reply_markup: navKb(t) });
        return false;
      }
      const kb = part.map((r) => [{
        text: `${String(r.reference).slice(0, 20)} · ${money(r.amount)} · ${String(r.user_name || "").slice(0, 16)}`,
        callback_data: `admin_rcpt_${r.id}`
      }]);
      kb.push(navKb(t).inline_keyboard[0]);
      await respond("reply", ctx, t.many(esc(ref), part.length), { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      return true;
    } catch (err) {
      console.error("Receipt lookup error:", err);
      await respond("reply", ctx, t.error, { reply_markup: navKb(t) });
      return false;
    }
  }

  async function ask(ctx) {
    clearPendingState(ctx.from.id);
    pendingAsk.set(ctx.from.id, Date.now() + ASK_MINUTES * 60 * 1000);
    const t = L[await langOf(ctx)];
    await respond("reply", ctx, t.ask, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: t.btn_home, callback_data: "admin_home" }]] }
    });
  }

  // 🧾 Receipt lookup button, and the buttons of a partial-match list
  bot.callbackQuery(/^admin_rcpt(?:_(\d+))?$/, async (ctx) => {
    if (!(await mainAdmin(ctx))) {
      await denyAccess(ctx);   // the shared ⛔ pop-up from api/bot.js
      return;
    }
    await answerCallback(ctx);
    const id = ctx.match && ctx.match[1];
    if (!id) return ask(ctx);
    const lang = await langOf(ctx);
    const t = L[lang];
    try {
      const dep = await db.getReceiptDepositById(Number(id));
      if (!dep) return respond("reply", ctx, t.none("#" + esc(id)), { parse_mode: "HTML", reply_markup: navKb(t) });
      const same = await db.countDepositsWithReference(dep.reference || "");
      const text = await detailText(t, lang, dep, same || 1);
      await respond("reply", ctx, text, { parse_mode: "HTML", reply_markup: navKb(t) });
    } catch (err) {
      console.error("Receipt lookup error:", err);
      await respond("reply", ctx, t.error, { reply_markup: navKb(t) });
    }
  });

  // the number typed after the bot asked for it; returns true when the message was handled here
  async function textHook(ctx, telegramId, text) {
    const exp = pendingAsk.get(telegramId);
    if (!exp) return false;
    if (Date.now() > exp || text.startsWith("/")) {
      pendingAsk.delete(telegramId);
      return false;
    }
    if (!(await mainAdmin(ctx))) { pendingAsk.delete(telegramId); await denyAccess(ctx); return true; }
    // found -> done; not found -> keep waiting so the admin can simply send another number
    if (await lookup(ctx, text)) pendingAsk.delete(telegramId);
    else pendingAsk.set(telegramId, Date.now() + ASK_MINUTES * 60 * 1000);
    return true;
  }

  return { textHook, clear: (telegramId) => pendingAsk.delete(telegramId) };
};
