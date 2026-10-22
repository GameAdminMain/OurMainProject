// Vercel serverless function (deploy as api/config.js)
//   GET /api/config        -> JSON { name, version, title, apiBase }
//   GET /api/config?js=1   -> JavaScript: window.MESOB_ENV = {...}   (index.html loads this first)
// Vercel environment variables:
//   API_BASE      game server URL (https:// or wss://); default wss://game-server-go-three-production.up.railway.app
//   DATA_BASE     data server URL (profile + winners); default https://fecher-api-three-production.up.railway.app
//   SUPPORT_URL   optional, https://t.me/... link of the support account (shows a button in the help screen)
//   BOT_NAME      Mesob Bingo
//   BOT_VERSION   v2   (optional)
module.exports = (req, res) => {
  const name = String(process.env.BOT_NAME || "Mesob Bingo").trim() || "Mesob Bingo";
  const version = String(process.env.BOT_VERSION || "").trim();
  // Default game server; wss:// / ws:// values are converted to https:// / http:// because the page uses it for fetch() and derives the WebSocket URL itself.
  const apiBase = String(process.env.API_BASE || "wss://game-server-go-three-production.up.railway.app").trim()
    .replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, "");
  // Data server (profile + winners); default below, override with the DATA_BASE variable.
  const dataBase = String(process.env.DATA_BASE || "https://fecher-api-three-production.up.railway.app").trim()
    .replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, "");
  // optional link for the "Contact support" button in the help screen (e.g. https://t.me/your_support_account)
  const supportUrl = String(process.env.SUPPORT_URL || "").trim();
  const cfg = { name, version, title: version ? `${name} ${version}` : name, apiBase, dataBase, supportUrl };
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  if (String(req.query && req.query.js) === "1") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.status(200).send("window.MESOB_ENV=" + JSON.stringify(cfg) + ";");
  } else {
    res.status(200).json(cfg);
  }
};
