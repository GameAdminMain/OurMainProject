// Runs the Telegram bot (api/bot.js, a webhook handler written for Vercel) as a normal Railway web service.
// Start command: node bot_server.js
// Variables: BOT_TOKEN, DATABASE_URL, WEBHOOK_SECRET, PUBLIC_URL (https://<this-service>.up.railway.app), GAME_URL, optional PORT (Railway sets it)
const http = require("http");
const https = require("https");
const fs = require("fs"), path = require("path");
const handler = require(fs.existsSync(path.join(__dirname, "api", "bot.js")) ? "./api/bot" : "./bot");

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = String(process.env.BOT_TOKEN || "").trim();
const SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const PUBLIC_URL = String(process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "")).replace(/\/+$/, "");
const HOOK_PATH = "/api/bot";

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  // Telegram updates are POSTs; accept them on /api/bot and also on "/" in case the webhook was set to the bare domain
  if (req.method === "POST" && (p === HOOK_PATH || p === "/")) {
    return Promise.resolve(handler(req, res)).catch(e => { console.error("webhook:", e); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  }
  if (p === "/" || p === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  res.writeHead(404); res.end();
});
server.listen(PORT, () => {
  console.log("🤖 Bot server on port " + PORT);
  if (!TOKEN) return console.error("❌ BOT_TOKEN is not set");
  if (!PUBLIC_URL) return console.error("❌ Set PUBLIC_URL (or generate a Railway domain): the webhook cannot be registered without it");
  // register the webhook (with the secret) every start, so it always points at this service
  const body = JSON.stringify({ url: PUBLIC_URL + HOOK_PATH, ...(SECRET ? { secret_token: SECRET } : {}), allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member", "pre_checkout_query", "inline_query"], drop_pending_updates: false });
  const r = https.request({ hostname: "api.telegram.org", path: "/bot" + TOKEN + "/setWebhook", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, resp => {
    let d = ""; resp.on("data", c => d += c); resp.on("end", () => console.log("setWebhook:", d.replace(TOKEN, "***")));
  });
  r.on("error", e => console.error("setWebhook failed:", e.message));
  r.end(body);
});
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
