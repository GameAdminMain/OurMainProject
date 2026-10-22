#!/usr/bin/env node
/**
 * Beteseb Bingo Plus stress test (Node.js)  -  NO command-line arguments: edit the CONFIG block below.
 *
 *   npm install ws
 *   node stress_test.js
 *
 * Every bot signs in as one of YOUR TEST ACCOUNTS, joins a stake room, picks cartela(s) at random from
 * the card numbers cardMin-cardMax that are still free, plays the round (calls BINGO when its card wins) and repeats. Ctrl+C stops it.
 * Use ONLY test accounts you own (cartelas are charged for real). The bot token must be the one the server uses.
 * On top of the players it opens CONFIG.idleConnections extra fake connections that only connect and stay idle:
 * they never sign in, join a room or play (set idleConnections: 0 to turn them off).
 */
// ═══════════════════════════ CONFIG - change everything here ═══════════════════════════
const CONFIG = {
  url: "wss://game-server-go-three-production.up.railway.app", // game server WebSocket address
  botToken: "8731376218:AAHzx_DP2_VlJHqldWAUyf7VTq6CS-sEzr8",              // bot token the server uses (or leave "" and set the BOT_TOKEN environment variable)
  unverified: false,         // true = send only the Telegram ID (server needs ALLOW_UNVERIFIED_AUTH=1; staging only)

  ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], // Telegram IDs of the test accounts
  idsFile: "",               // optional: file with one Telegram ID per line (added to the list above), e.g. "test_ids.txt"

  stake: "random",           // "st10" | "10" | "random"
  cards: 1,                  // cartelas per bot (1-4)
  cardMin: 1,                // each bot picks a RANDOM free card number between cardMin ...
  cardMax: 80,               // ... and cardMax
  think: [0.3, 2.5],         // seconds a bot waits before / between picks [min, max]
  autoBingo: true,           // claim BINGO automatically when the card wins
  rounds: 0,                 // stop after N rounds per bot (0 = forever)
  stagger: 0.2,              // seconds between starting bots
  report: 15,                // seconds between statistics lines
  confirm: false,             // ask to type CHARGE before starting (set false to start immediately)
  idleConnections: 254,      // extra fake connections that only connect and stay idle (never sign in / join / play); 0 = none
  idleStagger: 0.02,         // seconds between opening idle connections
  // NOTE: the server allows MAX_CONN_PER_IP (default 150) sockets per IP and closes a socket that does not sign in
  // within AUTH_TIMEOUT_MS (default 30000). Idle connections reconnect by themselves when closed.
  verbose: false,            // log what each bot does
  logMessages: false,        // DEBUG: print every message sent to / received from the server (use with only 1 bot)
};
// ═══════════════════════════════════════════════════════════════════════════════════════════
"use strict";
const crypto = require("crypto");
const readline = require("readline");
let WebSocket;
try { WebSocket = require("ws"); } catch (e) { console.error("Please install the websocket library first:  npm install ws"); process.exit(1); }

// ─── Bingo rules (same as server.js: checkWin) ───────────────────────────────────────────────
const LINES = [
  [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
  [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20], [0, 4, 20, 24],
];
function markedIndices(numbers, called) {
  const cs = new Set(called), out = new Set([12]);              // the centre cell (index 12) is free
  numbers.forEach((n, i) => { if (cs.has(n)) out.add(i); });
  return [...out].sort((a, b) => a - b);
}
function cardWins(numbers, called) {
  const m = new Set(markedIndices(numbers, called));
  return LINES.some(line => line.every(i => m.has(i)));
}

// ─── Telegram initData signing (what Telegram does for a real Web App user) ───────────────────
function signInitData(botToken, userId, firstName = "Test") {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAstress" + userId,
    user: JSON.stringify({ id: Number(userId), first_name: firstName }),
  };
  const check = Object.keys(fields).sort().map(k => k + "=" + fields[k]).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  fields.hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams(fields).toString();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ─── Shared statistics ────────────────────────────────────────────────────────────────────────
class Stats {
  constructor() { this.c = {}; this.errors = {}; this.started = Date.now(); }
  add(k, n = 1) { this.c[k] = (this.c[k] || 0) + n; }
  error(t) { const k = String(t).slice(0, 90); this.errors[k] = (this.errors[k] || 0) + 1; }
  report(bots) {
    const up = Math.floor((Date.now() - this.started) / 1000);
    const states = {};
    bots.forEach(b => { states[b.state] = (states[b.state] || 0) + 1; });
    console.log(`\n── stats after ${Math.floor(up / 60)}m${String(up % 60).padStart(2, "0")}s ──`);
    console.log("bots:", JSON.stringify(states));
    console.log(Object.entries(this.c).sort().map(([k, v]) => `${k}=${v}`).join("  ") || "(nothing yet)");
    const errs = Object.entries(this.errors).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (errs.length) { console.log("server messages:"); errs.forEach(([t, n]) => console.log(`   ${String(n).padStart(5)} x ${t}`)); }
  }
}

// ─── One simulated player ─────────────────────────────────────────────────────────────────────
class Bot {
  constructor(tid, args, stats) {
    this.tid = String(tid); this.a = args; this.stats = stats;
    this.state = "idle"; this.stop = false; this.fatal = false; this.roundsDone = 0;
    this.stakes = []; this.ws = null; this.pickToken = 0; this.selWaiter = null;
    this.resetRound();
  }
  resetRound() {
    this.roomId = null; this.stakeId = null; this.status = "waiting";
    this.taken = new Set(); this.mine = {}; this.numbers = {}; this.called = []; this.claimed = false;
    this.maxCards = this.a.cards;
  }
  log(...m) { if (this.a.verbose) console.log(`[${this.tid}]`, ...m); }
  send(obj) {
    if (this.a.logMessages) console.log(`[${this.tid}] >>`, JSON.stringify(obj).replace(/"initData":"[^"]*"/, '"initData":"..."').slice(0, 300));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // connection loop: reconnect forever
  async run() {
    let backoff = 2;
    while (!this.stop && !this.fatal) {
      this.state = "connecting";
      await new Promise(resolve => {
        let ws;
        try { ws = new WebSocket(this.a.url, { maxPayload: 4 * 1024 * 1024 }); }
        catch (e) { this.stats.add("disconnects"); this.stats.error("connection: " + e.message); return resolve(); }
        this.ws = ws;
        ws.on("open", () => { backoff = 2; this.resetRound(); });
        ws.on("message", async raw => {
          let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
          if (this.a.logMessages) console.log(`[${this.tid}] <<`, raw.toString().slice(0, 300));
          try { await this.onMessage(m); } catch (e) { this.stats.error("bot: " + e.message); }
          if (this.stop || this.fatal) ws.close();
        });
        ws.on("error", e => { this.stats.add("disconnects"); this.stats.error("connection: " + e.message); });
        ws.on("close", () => { this.cancelPick(); this.ws = null; resolve(); });
        this._closeNow = () => { try { ws.close(); } catch (e) {} };
      });
      if (this.stop || this.fatal) break;
      this.state = "reconnecting";
      await sleep((backoff + Math.random()) * 1000);
      backoff = Math.min(30, backoff * 2);
    }
    this.state = this.fatal ? "failed" : (this.state === "done" ? "done" : "stopped");
  }
  close() { this.stop = true; this.cancelPick(); if (this._closeNow) this._closeNow(); }
  cancelPick() { this.pickToken++; if (this.selWaiter) { this.selWaiter(); this.selWaiter = null; } }

  // protocol
  async onMessage(m) {
    const t = m.type;
    if (t === "connected") { this.stakes = m.stakes || []; this.authenticate(); }
    else if (t === "authRetry") { await sleep(Math.max(300, m.retryAfter || 1000)); this.authenticate(); }
    else if (t === "authFailed") {
      this.fatal = true; this.state = "failed"; this.stats.add("auth_failed");
      console.log(`[${this.tid}] sign-in refused by the server. Is BOT_TOKEN the same token the server uses (or is the account missing)?`);
    }
    else if (t === "authSuccess") { this.stats.add("signed_in"); this.log("signed in, wallets", JSON.stringify(m.wallets)); this.joinStake(); }
    else if (t === "lobbyUpdate") { this.stakes = m.stakes || this.stakes; }
    else if (t === "joinedRoom") this.onJoined(m);
    else if (t === "backToCardSelection") {
      this.roundsDone++; this.stats.add("rounds_finished");
      if (this.a.rounds && this.roundsDone >= this.a.rounds) { this.stop = true; this.state = "done"; return; }
      this.newRound(m);
    }
    else if (t === "cardPoolUpdate" && this.sameRoom(m)) { this.taken = new Set((m.pool || []).filter(c => c.taken).map(c => c.id)); }
    else if (t === "cardPoolDiff" && this.sameRoom(m)) { (m.changes || []).forEach(c => { if (c.taken) this.taken.add(c.id); else this.taken.delete(c.id); }); }
    else if (t === "cardSelected") {
      if (this.selWaiter) { this.selWaiter(); this.selWaiter = null; }
      const slot = Number(m.slot || 1);
      this.mine[slot] = m.cardId; this.numbers[slot] = m.cardNumbers || [];
      this.stats.add("cards_selected");
    }
    else if (t === "countdown") this.state = "countdown";
    else if (t === "waitingForPlayers") this.state = "waiting";
    else if (t === "gameStart") { this.status = "playing"; this.cancelPick(); this.stats.add("games_started"); }
    else if (t === "yourCard") {
      this.status = "playing"; this.state = "playing";
      [[m.cardId, m.cardNumbers], [m.cardId2, m.cardNumbers2], [m.cardId3, m.cardNumbers3], [m.cardId4, m.cardNumbers4]]
        .forEach(([cid, nums], i) => { if (cid) { this.mine[i + 1] = cid; this.numbers[i + 1] = nums || []; } });
      this.stats.add("rounds_played");
    }
    else if (t === "spectating") { this.status = "playing"; this.state = "watching"; this.stats.add("rounds_watched"); }
    else if (t === "numberCalled") { this.status = "playing"; this.called = m.calledNumbers || this.called; this.stats.add("numbers_called"); await this.maybeClaim(); }
    else if (t === "gameOver") {
      this.status = "finished"; this.state = "between rounds";
      if ((m.winnerTelegramIds || []).map(String).includes(this.tid)) this.stats.add("wins");
      this.stats.add("games_finished");
    }
    else if (t === "disqualified") { this.stats.add("DISQUALIFIED"); console.log(`[${this.tid}] was disqualified - a BINGO claim was refused (that is a bug to look at)`); }
    else if (t === "claimTooLate") this.stats.add("claims_too_late");
    else if (t === "roomClosed") { this.resetRound(); this.joinStake(); }
    else if (t === "error") {
      if (this.selWaiter) { this.selWaiter(); this.selWaiter = null; }   // a refused pick must not block the picking loop
      this.stats.error(m.message || "error");
    }
  }
  sameRoom(m) { return !m.roomId || !this.roomId || m.roomId === this.roomId; }

  // actions
  authenticate() {
    const msg = { type: "telegramAuth", telegramId: this.tid };
    if (this.a.botToken) msg.initData = signInitData(this.a.botToken, this.tid);
    this.send(msg);
  }
  chooseStake() {
    if (!this.stakes.length) return null;
    const want = String(this.a.stake).toLowerCase();
    if (want === "random") return this.stakes[Math.floor(Math.random() * this.stakes.length)];
    return this.stakes.find(s => String(s.stakeId).toLowerCase() === want || String(s.amount) === want.replace("st", "")) || null;
  }
  async joinStake() {
    let s = this.chooseStake();
    if (!s) {
      this.stats.error(`stake '${this.a.stake}' not offered by the server (offered: ${this.stakes.map(x => x.stakeId).join(", ")})`);
      await sleep(5000);
      s = this.a.stake === "random" ? this.stakes[0] : null;
      if (!s) return;
    }
    this.stakeId = s.stakeId;
    this.maxCards = Math.min(this.a.cards, Number(s.maxCards || 4));
    this.state = "joining";
    this.send({ type: "joinRoom", stakeId: this.stakeId, telegramId: this.tid });
  }
  onJoined(m) {
    this.roomId = m.roomId; this.stakeId = m.stakeId || this.stakeId; this.status = m.status || "waiting";
    this.stats.add("rooms_joined");
    [[m.cardId, m.cardNumbers], [m.cardId2, m.cardNumbers2], [m.cardId3, m.cardNumbers3], [m.cardId4, m.cardNumbers4]]
      .forEach(([cid, nums], i) => { if (cid) { this.mine[i + 1] = cid; this.numbers[i + 1] = nums || []; } });
    if (this.status === "waiting" || this.status === "countdown") { this.state = "selecting"; this.startPicking(); }
    else if (this.status === "playing") this.state = "watching";
  }
  newRound(m) {
    this.roomId = m.roomId || this.roomId; this.status = "waiting"; this.taken = new Set();
    this.mine = {}; this.numbers = {}; this.called = []; this.claimed = false;
    this.state = "selecting"; this.startPicking();
  }
  startPicking() { this.cancelPick(); this.pickCards(this.pickToken); }

  // The card to ask for: a random card number between cardMin and cardMax that is not taken / not refused yet.
  nextLowCard(skip) {
    const pool = [];
    for (let c = this.a.cardMin; c <= this.a.cardMax; c++) if (!this.taken.has(c) && !skip.has(c)) pool.push(c);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  async pickCards(token) {
    const alive = () => token === this.pickToken && !this.stop;
    try {
      await sleep(rand(...this.a.think) * 1000);
      const want = this.maxCards;
      const refused = new Set();                       // cards the server refused (already taken) in this round
      let tries = 0;
      while (alive() && Object.keys(this.mine).length < want && (this.status === "waiting" || this.status === "countdown") && tries < 60) {
        tries++;
        const card = this.nextLowCard(refused);
        if (card === null) break;
        let slot = 1; while (this.mine[slot]) slot++;
        const before = Object.keys(this.mine).length;
        const answered = new Promise(res => { this.selWaiter = res; });
        this.send({ type: "selectCard", cardId: card, slot, roomId: this.roomId });
        await Promise.race([answered, sleep(4000)]);   // wait for the server's answer (cardSelected or error)
        if (!alive()) return;
        if (Object.keys(this.mine).length === before) { refused.add(card); this.taken.add(card); }   // not accepted: try the next lowest card
        await sleep(rand(...this.a.think) * 1000);
      }
      this.state = `selected ${Object.keys(this.mine).length}`;
    } catch (e) { /* cancelled */ }
  }

  async maybeClaim() {
    if (this.claimed || !this.a.autoBingo || !Object.keys(this.numbers).length) return;
    const winning = Object.entries(this.numbers).filter(([, nums]) => nums && nums.length && cardWins(nums, this.called));
    if (!winning.length) return;
    this.claimed = true;
    await sleep(rand(100, 1200));                        // inside the 4.8 s claim window
    const msg = { type: "claimBingo", roomId: this.roomId, automatic: true };
    for (let slot = 1; slot <= 4; slot++) {
      const nums = this.numbers[slot], sfx = slot === 1 ? "" : String(slot);
      if (nums && nums.length) { msg["cardId" + sfx] = this.mine[slot]; msg["markedIndices" + sfx] = markedIndices(nums, this.called); }
    }
    this.send(msg);
    this.stats.add("bingo_claims");
  }
}

// ─── One idle connection: connects and does nothing else ─────────────────────────────────────
class IdleConn {
  constructor(n, args, stats) { this.n = n; this.a = args; this.stats = stats; this.state = "idle"; this.stop = false; this.ws = null; }
  async run() {
    let backoff = 1;
    while (!this.stop) {
      this.state = "idle connecting";
      await new Promise(resolve => {
        let ws, opened = false;
        try { ws = new WebSocket(this.a.url, { maxPayload: 4 * 1024 * 1024 }); }
        catch (e) { this.stats.error("idle connection: " + e.message); return resolve(); }
        this.ws = ws;
        ws.on("open", () => { opened = true; backoff = 1; this.state = "idle connected"; this.stats.add("idle_connected"); });
        ws.on("message", () => {});                       // ignore everything the server sends
        ws.on("error", e => this.stats.error("idle connection: " + e.message));
        ws.on("close", (code, reason) => {
          this.ws = null;
          if (opened && !this.stop) { this.stats.add("idle_closed"); this.stats.error(`idle closed by server: ${code} ${String(reason || "")}`.trim()); }
          resolve();
        });
      });
      if (this.stop) break;
      this.state = "idle reconnecting";
      await sleep((backoff + Math.random()) * 1000);
      backoff = Math.min(30, backoff * 2);
    }
    this.state = "stopped";
  }
  close() { this.stop = true; if (this.ws) { try { this.ws.close(); } catch (e) {} } }
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const c = CONFIG;
  const a = { url: c.url, ids: "", idsFile: c.idsFile, botToken: c.botToken || process.env.BOT_TOKEN || "", unverified: !!c.unverified,
    stake: String(c.stake), cards: Number(c.cards) || 1, cardMin: Math.max(1, Number(c.cardMin) || 1), cardMax: Math.min(600, Number(c.cardMax) || 80), think: [...c.think], autoBingo: !!c.autoBingo,
    rounds: Number(c.rounds) || 0, idle: Math.max(0, Math.floor(Number(c.idleConnections) || 0)), idleStagger: Number(c.idleStagger) || 0, stagger: Number(c.stagger), report: Number(c.report) || 15, yes: !c.confirm, verbose: !!c.verbose, logMessages: !!c.logMessages };
  if (!a.url) { console.error("Set CONFIG.url at the top of stress_test.js"); process.exit(1); }
  a.cards = Math.max(1, Math.min(4, a.cards));
  if (a.cardMin > a.cardMax) [a.cardMin, a.cardMax] = [a.cardMax, a.cardMin];
  if (a.think[0] > a.think[1]) a.think.reverse();
  return a;
}
function loadIds(a) {
  let ids = CONFIG.ids.map(x => String(x).trim()).filter(Boolean);
  if (a.idsFile) ids = ids.concat(require("fs").readFileSync(a.idsFile, "utf8").split(/\r?\n/).map(l => l.split("#")[0].trim()).filter(Boolean));
  const clean = [];
  for (const x of ids) {
    if (!/^\d+$/.test(x) || Number(x) <= 0) { console.error("Not a Telegram ID: " + JSON.stringify(x)); process.exit(1); }
    if (!clean.includes(x)) clean.push(x);
  }
  return clean;
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans); }));
}

async function main() {
  const a = parseArgs();
  const ids = loadIds(a);
  if (!ids.length && !a.idle) { console.error("No Telegram IDs given: fill CONFIG.ids or CONFIG.idsFile (or set CONFIG.idleConnections)"); process.exit(1); }
  if (ids.length && !a.unverified && !a.botToken) {
    console.error("BOT_TOKEN is not set. The server verifies Telegram's signed login data, so the script needs the bot token the server uses " +
      "(CONFIG.botToken or the BOT_TOKEN environment variable). For a staging server with ALLOW_UNVERIFIED_AUTH=1 set CONFIG.unverified = true.");
    process.exit(1);
  }
  if (a.unverified) a.botToken = "";
  if (!a.yes && ids.length) {
    console.log(`This will sign in as ${ids.length} account(s) on ${a.url} and PLAY FOR REAL: every picked cartela is charged to those accounts' wallets.`);
    console.log("Use only test accounts that you own (and preferably a staging database).");
    if ((await ask("Type CHARGE to continue: ")).trim() !== "CHARGE") { console.log("Cancelled."); process.exit(1); }
  }
  const stats = new Stats();
  const bots = ids.map(id => new Bot(id, a, stats));
  const idles = Array.from({ length: a.idle }, (_, i) => new IdleConn(i + 1, a, stats));
  const runs = [];
  let stopping = false;
  const finish = async () => {
    if (stopping) return; stopping = true;
    bots.forEach(b => b.close()); idles.forEach(c => c.close());
    await Promise.race([Promise.allSettled(runs), sleep(3000)]);
    stats.report(bots.concat(idles));
    process.exit(0);
  };
  process.on("SIGINT", finish); process.on("SIGTERM", finish);
  console.log(`Started ${bots.length} bot(s). Each picks ${a.cards} card(s), random free card numbers between ${a.cardMin} and ${a.cardMax}.`);
  if (a.idle) console.log(`Plus ${a.idle} idle connection(s) that only connect and never play.`);
  if (a.idle + bots.length > 150) console.log(`Note: ${a.idle + bots.length} sockets from this machine. The server allows MAX_CONN_PER_IP (default 150) per IP; raise it on the server or the extra ones are refused.`);
  console.log("Press Ctrl+C to stop.");
  const reporter = setInterval(() => stats.report(bots.concat(idles)), a.report * 1000);
  // idle connections open in the background so they do not delay the players
  (async () => { for (const c of idles) { if (stopping) break; runs.push(c.run()); await sleep(a.idleStagger * 1000); } })();
  for (const b of bots) { runs.push(b.run()); await sleep(a.stagger * 1000); }
  // with rounds: stop when every player is done (idle connections are closed then too)
  const watch = setInterval(() => {
    if (bots.length && bots.every(b => ["done", "failed", "stopped"].includes(b.state))) { clearInterval(watch); clearInterval(reporter); finish(); }
  }, 500);
}

if (require.main === module) main();
module.exports = { signInitData, cardWins, markedIndices, Bot, IdleConn, Stats, parseArgs };
