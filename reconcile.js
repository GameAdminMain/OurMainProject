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

// one check: the SQL is in db.js (RECON_CHECKS), here only how bad it is and the title
async function check(db, findings, { code, severity, title, params = [] }) {
  const { count, sample } = await db.runReconciliationCheck(code, params, SAMPLE);
  if (!count) return 0;
  findings.push({ code, severity, title, count, sample });
  return count;
}

async function runReconciliation(db, opts = {}) {
  const findings = [];
  const summary = {};
  const t0 = Date.now();

  // 1. wallets vs ledger
  await check(db, findings, { code: "WALLET_MISMATCH", severity: "critical", title: "Wallet balance differs from the sum of its ledger entries" });
  await check(db, findings, { code: "NEGATIVE_BALANCE", severity: "critical", title: "Wallet with a negative balance" });

  // 2. deposits
  await check(db, findings, { code: "DEPOSIT_LEDGER", severity: "critical", title: "Completed deposit without a matching ledger transaction" });
  await check(db, findings, { code: "DEPOSIT_OLD", severity: "warn", title: "Deposit still pending for more than 2 hours" });

  // 3. withdrawals: the reserved money must be gone (open / paid) or given back (rejected / cancelled / failed)
  await check(db, findings, { code: "WITHDRAWAL_LEDGER", severity: "critical", title: "Withdrawal money not reserved / refunded correctly" });
  await check(db, findings, { code: "WITHDRAWAL_STALE", severity: "warn", title: "Withdrawal waiting too long (pending > 6 h or claimed > 30 min)" });

  // 4. games
  await check(db, findings, { code: "GAME_PAYOUT", severity: "critical", title: "Settled game: payouts do not match the ledger or exceed the prize pool" });
  await check(db, findings, { code: "GAME_STUCK", severity: "warn", title: "Game not settled after 20 minutes" });

  // 5. page crashes
  try {
    const ce = await db.getReconClientErrors(SAMPLE);
    summary.clientErrors24h = ce.n;
    if (ce.n >= 20) findings.push({ code: "CLIENT_ERRORS", severity: "warn", title: "Many page crashes in the last 24 hours", count: ce.n, sample: ce.sample });
  } catch (e) { /* table not installed yet */ }

  // 6. payment provider statement (only when lines were imported); checks the period the statement covers
  try {
    const per = await db.getProviderStatementPeriod();
    summary.providerLines = Number(per.n);
    if (Number(per.n) > 0) {
      const a = per.a, b = per.b;
      summary.providerPeriod = [a, b];
      await check(db, findings, { code: "PROVIDER_DEPOSIT_MISSING", severity: "critical", title: "Deposit credited to a player but NOT in the provider statement (or amount differs)", params: [a, b] });
      await check(db, findings, { code: "PROVIDER_DEPOSIT_UNCREDITED", severity: "warn", title: "Money received by the provider but no completed deposit" });
      await check(db, findings, { code: "PROVIDER_WITHDRAWAL_MISSING", severity: "warn", title: "Withdrawal marked paid but no matching payment in the provider statement", params: [a, b] });
      await check(db, findings, { code: "PROVIDER_PAYMENT_UNKNOWN", severity: "critical", title: "Money paid out according to the provider but no approved withdrawal" });
    }
  } catch (e) { findings.push({ code: "PROVIDER_CHECK_FAILED", severity: "warn", title: "Provider comparison could not run: " + e.message, count: 1, sample: [] }); }

  // numbers for the report
  const nums = await db.getReconciliationTotals();
  Object.assign(summary, Object.fromEntries(Object.entries(nums).map(([k, v]) => [k, Number(v)])));
  summary.ms = Date.now() - t0;

  const critical = findings.filter(f => f.severity === "critical").length;
  const warnings = findings.filter(f => f.severity === "warn").length;
  const result = { ok: critical === 0, critical, warnings, summary, findings };
  if (opts.save !== false) {
    const r = await db.saveReconciliationRun(result.ok, critical, warnings, summary, findings);
    result.id = r.id; result.ran_at = r.ran_at;
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
    ids = await db.getMainAdminTelegramIds();
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
      const lastAt = await db.getLastReconciliationRunAt();
      if (lastAt && Date.now() - new Date(lastAt).getTime() < 20 * 3600 * 1000) return;
      const got = await db.tryReconciliationLock();
      if (!got) return;
      try {
        const res = await runReconciliation(db);
        console.log(`🧾 Reconciliation: ${res.ok ? "OK" : "PROBLEMS"} critical=${res.critical} warnings=${res.warnings} (${res.summary.ms} ms)`);
        if (!res.ok || res.warnings || sendOk) console.log("alert:", JSON.stringify(await sendAlert(db, res, "Nightly reconciliation")));
      } finally { await db.releaseReconciliationLock().catch(() => {}); }
    } catch (e) { console.error("reconciliation failed:", e.message, /reconciliation_runs|relation/.test(e.message) ? "- run safety_dashboard.sql" : ""); }
    finally { busy = false; }
  };
  const t = setInterval(tick, 60 * 1000); t.unref && t.unref();
  console.log(`🧾 Nightly reconciliation scheduled at ${String(hour).padStart(2, "0")}:00 UTC`);
}

module.exports = { runReconciliation, sendAlert, startSchedule, alertText };
