#!/usr/bin/env node
/**
 * Mesob Bingo load test (Node.js)  -  STAGING ONLY.
 *
 * Two modes (environment variable LOADTEST_MODE):
 *   schedule (default)  long-running Railway service: keeps a daily, timezone-aware number of simulated players in the
 *                       stake 10 and stake 5 rooms (peak about 15:00-21:00, about 5 % of that off-peak) with gradual
 *                       ramps. The stake 5 players are a subset of the stake 10 players (same accounts, both rooms).
 *                       Stake 20 (LOADTEST_FORBIDDEN_STAKES) is never joined.
 *   fixed               the original test: every account in CONFIG.ids plays CONFIG.stake until Ctrl+C / CONFIG.rounds.
 *
 *   npm install ws
 *   STAGING=1 LOADTEST_ALLOWED_HOSTS=<staging host> BOT_TOKEN=<staging bot token> node stress_test.js
 *   LOADTEST_DRY_RUN=1 node stress_test.js      prints the 24-hour target table and exits (connects to nothing)
 *
 * SAFETY - the script refuses to start (exit code 2) unless ALL of these hold, and no setting can switch them off:
 *   - STAGING=1 is set;
 *   - the target host is listed in LOADTEST_ALLOWED_HOSTS and is not a known production host (PROD_HOSTS below);
 *   - a *.railway.internal target is only used from a Railway environment that is not "production";
 *   - the game server answers with deployEnv "staging" (server.js sends it only when DEPLOY_ENV=staging);
 *   - wallet top-ups (LOADTEST_TOPUP=1) only run when the database host is in LOADTEST_DB_ALLOWED_HOSTS and the
 *     database has the staging_marker table (db.js checks it again before every write).
 * The simulated players sign in with the STAGING bot token, so they could not sign in to production anyway.
 * Every account plays for real inside staging (cartelas are charged to the staging wallets).
 */
// ═══════════════════════════ CONFIG - change everything here ═══════════════════════════
const env = (k, d) => (process.env[k] !== undefined && String(process.env[k]).trim() !== "" ? String(process.env[k]).trim() : d);
const envNum = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) ? v : d; };
const CONFIG = {
  mode: env("LOADTEST_MODE", "schedule"),   // "schedule" | "fixed"
  //url: "wss://game-server-go-three-production.up.railway.app",   // PRODUCTION - refused by the safety check
  //url: env("LOADTEST_URL", "ws://game-server.railway.internal:8080"), // STAGING game server WebSocket address
  url: env("LOADTEST_URL", "wss://game-server-go-three-production.up.railway.app"), // STAGING game server WebSocket address
  botToken: process.env.BOT_TOKEN || "",  // read from the BOT_TOKEN environment variable - never write the token in this file
  unverified: false,         // true = send only the Telegram ID (server needs ALLOW_UNVERIFIED_AUTH=1; staging only)

  ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300], // fixed mode: Telegram IDs of the test accounts
  idsFile: env("LOADTEST_IDS_FILE", ""),   // optional: file with one Telegram ID per line (added to the list above), e.g. "test_ids.txt"

  stake: "random",           // fixed mode: "st10" | "10" | "random"
  cards: 1,                  // cartelas per bot (1-4)
  cardMin: 1,                // each bot picks a RANDOM free card number between cardMin ...
  cardMax: 80,               // ... and cardMax (schedule mode uses schedule.cardMax)
  think: [0.3, 2.5],         // seconds a bot waits before / between picks [min, max]
  autoBingo: true,           // claim BINGO automatically when the card wins
  rounds: 0,                 // fixed mode: stop after N rounds per bot (0 = forever)
  stagger: 0.2,              // fixed mode: seconds between starting bots
  report: envNum("LOADTEST_REPORT_SECONDS", 60), // seconds between statistics lines (keep it high on Railway: logs cost)
  confirm: false,            // fixed mode: ask to type CHARGE before starting (set false to start immediately)
  verbose: false,            // log what each bot does
  logMessages: false,        // DEBUG: print every message sent to / received from the server (use with only 1 bot)

  // ── safety (see the header) ──
  allowedHosts: env("LOADTEST_ALLOWED_HOSTS", ""),        // comma-separated staging host names, e.g. "game-server.railway.internal"
  forbiddenStakes: env("LOADTEST_FORBIDDEN_STAKES", "20"), // stake amounts a bot never joins

  // ── schedule mode ──
  schedule: {
    timezone: env("LOADTEST_TZ", env("TZ", "Africa/Addis_Ababa")),
    peakStart: env("LOADTEST_PEAK_START", "15:00"),
    peakEnd: env("LOADTEST_PEAK_END", "21:00"),
    rampMinutes: envNum("LOADTEST_RAMP_MINUTES", 45),     // ramp up after peakStart, ramp down before peakEnd
    offPeakPercent: envNum("LOADTEST_OFFPEAK_PERCENT", 5), // off-peak target = this % of the peak target
    jitterPercent: envNum("LOADTEST_JITTER_PERCENT", 5),   // slow +/- variation around the target
    targets: {                                             // stake amount -> players (off-peak: null = offPeakPercent of peak)
      10: { peak: envNum("LOADTEST_ST10_PEAK", 300), offPeak: process.env.LOADTEST_ST10_OFFPEAK ? envNum("LOADTEST_ST10_OFFPEAK", 0) : null },
      5: { peak: envNum("LOADTEST_ST5_PEAK", 80), offPeak: process.env.LOADTEST_ST5_OFFPEAK ? envNum("LOADTEST_ST5_OFFPEAK", 0) : null },
    },
    idStart: envNum("LOADTEST_ID_START", 1),       // test accounts are idStart, idStart+1, ... (unless idsFile is set)
    poolSize: envNum("LOADTEST_POOL_SIZE", 0),             // 0 = enough for the largest peak target + jitter
    namePrefix: env("LOADTEST_NAME_PREFIX", "LoadTest"),   // account names in the staging database ("LoadTest 900000001")
    cardMax: envNum("LOADTEST_CARD_MAX", 600),             // largest card number a bot may pick (only cards the room offers)
    tickSeconds: envNum("LOADTEST_TICK_SECONDS", 20),      // how often the targets are recomputed
    connectPerSecond: envNum("LOADTEST_CONNECT_PER_SEC", 2), // new connections opened per second (all bots together)
    maxConnecting: envNum("LOADTEST_MAX_CONNECTING", 20),  // sockets allowed between "open" and "signed in" at once
    handshakeTimeout: envNum("LOADTEST_HANDSHAKE_TIMEOUT_SEC", 15),
    maxBackoff: envNum("LOADTEST_MAX_BACKOFF_SEC", 60),    // reconnect back-off cap (seconds)
    drainSeconds: envNum("LOADTEST_DRAIN_MAX_SEC", 600),   // a bot leaving the test finishes its round first, at most this long
    dryRun: env("LOADTEST_DRY_RUN", "") === "1",
    topUp: env("LOADTEST_TOPUP", "1000000f") === "1",              // create the test accounts and refill their STAGING main wallets
    dbAllowedHosts: env("LOADTEST_DB_ALLOWED_HOSTS", ""),  // comma-separated staging database host names
    topUpBelow: envNum("LOADTEST_TOPUP_BELOW", 200),
    topUpTo: envNum("LOADTEST_TOPUP_TO", 2000),
    topUpMinutes: envNum("LOADTEST_TOPUP_MINUTES", 60),
  },
};
// ═══════════════════════════════════════════════════════════════════════════════════════════
"use strict";
const crypto = require("crypto");
const readline = require("readline");
let WebSocket;
try { WebSocket = require("ws"); } catch (e) { console.error("Please install the websocket library first:  npm install ws"); process.exit(1); }

// ─── Production guard ─────────────────────────────────────────────────────────────────────────
// Hosts that are production. Not configurable on purpose: no setting lets the script point at them.
const PROD_HOSTS = [
  "game-server-go-three-production.up.railway.app",   // production game server
  "fecher-api-three-production.up.railway.app",       // production data server
  "game-client-go-three.vercel.app",                  // production game page
  "game-server-go-three-production.up.railway.app",
];
function refuse(msg) { console.error("REFUSING TO RUN: " + msg); process.exit(2); }
const hostList = s => String(s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
function assertSafeTarget(a) {
  if (process.env.STAGING !== "1") refuse("set STAGING=1. This load test only runs against a separate staging deployment.");
  let u; try { u = new URL(a.url); } catch (e) { refuse("LOADTEST_URL is not a valid URL: " + a.url); }
  if (!/^wss?:$/.test(u.protocol)) refuse("LOADTEST_URL must start with ws:// or wss://");
  const host = u.hostname.toLowerCase();
  if (PROD_HOSTS.includes(host) || /production/.test(host)) refuse(`${host} is a production host.`);
  if (!hostList(a.allowedHosts).includes(host)) refuse(`${host} is not listed in LOADTEST_ALLOWED_HOSTS.`);
  if (host.endsWith(".railway.internal")) {
    // a private Railway name resolves inside the Railway environment this script runs in
    const envName = String(process.env.RAILWAY_ENVIRONMENT_NAME || "").toLowerCase();
    if (!envName || envName === "production") refuse(`${host} is a private Railway address and this service runs in the '${envName || "?"}' environment. Run the load test in the staging environment.`);
  }
}

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

// ─── Schedule: how many players each stake should have right now ─────────────────────────────
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`not a HH:MM time: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
// minutes since local midnight in the schedule's timezone (no DST bookkeeping needed: Intl does it)
function localMinutes(tz, d = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = t => Number((p.find(x => x.type === t) || {}).value || 0);
  return g("hour") * 60 + g("minute") + g("second") / 60;
}
// 0 = off-peak, 1 = full peak. Smooth ramps of rampMin after the window opens and before it closes.
// Works for windows that cross midnight (start > end); start == end means "peak all day".
function peakFactor(nowMin, start, end, rampMin) {
  const len = ((end - start) % 1440 + 1440) % 1440 || 1440;
  const into = ((nowMin - start) % 1440 + 1440) % 1440;
  if (into >= len) return 0;
  const r = Math.max(0.01, Math.min(rampMin, len / 2));
  const x = Math.min(1, into / r, (len - into) / r);
  return x * x * (3 - 2 * x);
}
// slow, smooth variation in [-pct, +pct]; it depends only on the clock, so a restart continues the same curve
function wobble(seed, epochMin, pct) {
  const h = crypto.createHash("sha256").update(String(seed)).digest();
  const p1 = h[0] / 255 * 2 * Math.PI, p2 = h[1] / 255 * 2 * Math.PI;
  return pct / 100 * (0.6 * Math.sin(2 * Math.PI * epochMin / 37 + p1) + 0.4 * Math.sin(2 * Math.PI * epochMin / 13 + p2));
}
function computeTargets(sc, now = new Date()) {
  const f = peakFactor(localMinutes(sc.timezone, now), sc.startMin, sc.endMin, sc.rampMinutes);
  const out = {};
  for (const [amt, t] of Object.entries(sc.targets)) {
    const base = t.offPeak + (t.peak - t.offPeak) * f;
    const v = base > 0 ? Math.round(base * (1 + wobble(amt, now.getTime() / 60000, sc.jitterPercent))) : 0;
    out[amt] = Math.max(0, Math.min(sc.poolSize, v));
  }
  return { f, phase: f >= 0.999 ? "peak" : f <= 0.001 ? "off-peak" : "ramp", targets: out };
}

// ─── Connection gate: limits how fast new sockets are opened (no spikes after a restart / ramp) ─
class ConnectGate {
  constructor(perSecond, maxPending) { this.gap = 1000 / Math.max(0.1, perSecond); this.max = Math.max(1, maxPending); this.next = 0; this.pending = 0; this.queue = []; }
  async enter() {
    while (this.pending >= this.max) await new Promise(r => this.queue.push(r));
    this.pending++;
    const now = Date.now(), at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await sleep(at - now);
  }
  leave() { this.pending = Math.max(0, this.pending - 1); const r = this.queue.shift(); if (r) r(); }
}

// ─── Shared statistics ────────────────────────────────────────────────────────────────────────
class Stats {
  constructor() { this.c = {}; this.errors = {}; this.started = Date.now(); }
  add(k, n = 1) { this.c[k] = (this.c[k] || 0) + n; }
  error(t) { const k = String(t).slice(0, 90); this.errors[k] = (this.errors[k] || 0) + 1; }
  report(bots) {
    const up = Math.floor((Date.now() - this.started) / 1000);
    const states = {};
    bots.forEach(b => { const st = b.seats.size === 1 ? [...b.seats.values()][0].state : b.state; states[st] = (states[st] || 0) + 1; });
    console.log(`\n── stats after ${Math.floor(up / 60)}m${String(up % 60).padStart(2, "0")}s ──`);
    console.log("bots:", JSON.stringify(states));
    console.log(Object.entries(this.c).sort().map(([k, v]) => `${k}=${v}`).join("  ") || "(nothing yet)");
    const errs = Object.entries(this.errors).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (errs.length) { console.log("server messages:"); errs.forEach(([t, n]) => console.log(`   ${String(n).padStart(5)} x ${t}`)); }
  }
}

// ─── One room (stake) a simulated player sits in ──────────────────────────────────────────────
// A bot can sit in several stakes at once (the server lets one account play one room per stake).
class Seat {
  constructor(bot, key) { this.bot = bot; this.key = String(key); this.stakeId = null; this.drain = false; this.joined = false; this.joining = 0; this.pickToken = 0; this.state = "joining"; this.resetRound(); }
  resetRound() {
    this.roomId = null; this.status = "waiting"; this.pool = null;
    this.taken = new Set(); this.mine = {}; this.numbers = {}; this.called = []; this.claimed = false;
    this.maxCards = this.bot.a.cards;
  }
  holds() { return Object.keys(this.mine).length > 0; }
}

// ─── One simulated player ─────────────────────────────────────────────────────────────────────
class Bot {
  constructor(tid, args, stats, opts = {}) {
    this.tid = String(tid); this.a = args; this.stats = stats;
    this.gate = opts.gate || null; this.onUnsafe = opts.onUnsafe || null;
    this.state = "idle"; this.stop = false; this.fatal = false; this.roundsDone = 0;
    this.stakes = []; this.ws = null; this.selWaiter = null; this.selLock = Promise.resolve();
    this.seats = new Map(); this.want = new Set((opts.want || []).map(String));
    this.authed = false; this.draining = 0; this.replaced = false;
  }
  log(...m) { if (this.a.verbose) console.log(`[${this.tid}]`, ...m); }
  send(obj) {
    if (this.a.logMessages) console.log(`[${this.tid}] >>`, JSON.stringify(obj).replace(/"initData":"[^"]*"/, '"initData":"..."').slice(0, 300));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // connection loop: reconnect until stopped, through the connection gate, with capped back-off
  async run() {
    let backoff = 2;
    while (!this.stop && !this.fatal) {
      this.state = "queued";
      let inGate = false;
      if (this.gate) { await this.gate.enter(); inGate = true; }
      this._leaveGate = () => { if (inGate) { inGate = false; this.gate.leave(); } };
      if (this.stop || this.fatal) { this._leaveGate(); break; }
      this.state = "connecting";
      await new Promise(resolve => {
        let ws;
        try { ws = new WebSocket(this.a.url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: this.a.handshakeTimeout * 1000 }); }
        catch (e) { this.stats.add("disconnects"); this.stats.error("connection: " + e.message); return resolve(); }
        this.ws = ws;
        // a new connection starts with no rooms: they are joined again one by one after the sign-in (the server
        // gives back the cartelas this account still holds there)
        ws.on("open", () => { backoff = 2; this.authed = false; this.seats.clear(); });
        ws.on("message", async raw => {
          let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
          if (this.a.logMessages) console.log(`[${this.tid}] <<`, raw.toString().slice(0, 300));
          try { await this.onMessage(m); } catch (e) { this.stats.error("bot: " + e.message); }
          if (this.stop || this.fatal) ws.close();
        });
        ws.on("error", e => { this.stats.add("disconnects"); this.stats.error("connection: " + e.message); });
        ws.on("close", code => {
          if (code === 4004) this.replaced = true;
          this._leaveGate(); this.authed = false; this.cancelAllPicks(); this.ws = null; resolve();
        });
        this._closeNow = () => { try { ws.close(); } catch (e) {} };
      });
      this._leaveGate();
      if (this.stop || this.fatal) break;
      this.state = "reconnecting";
      let wait = backoff + Math.random();
      if (this.replaced) {
        // "opened on another device": another process signs in with the same account. Do not fight over it.
        this.replaced = false; wait = 300 + Math.random() * 60;
        this.stats.error("sessionReplaced: is a second load test running with the same IDs?");
      }
      await this.pause(wait * 1000);
      backoff = Math.min(this.a.maxBackoff, backoff * 2);
    }
    this.state = this.fatal ? "failed" : (this.state === "done" ? "done" : "stopped");
  }
  pause(ms) { return new Promise(r => { const t = setTimeout(r, ms); this._wake = () => { clearTimeout(t); r(); }; }); }
  close() { this.stop = true; this.cancelAllPicks(); if (this._closeNow) this._closeNow(); if (this._wake) this._wake(); }
  cancelAllPicks() { this.seats.forEach(s => s.pickToken++); if (this.selWaiter) this.selWaiter(); }

  // ── which stakes this bot sits in (schedule mode changes it; fixed mode sets it once) ──
  setWant(list) {
    this.want = new Set(list.map(String));
    if (!this.want.size) { if (!this.draining) this.draining = Date.now(); } else this.draining = 0;
    this.seats.forEach(s => { s.drain = !this.want.has(s.key); });
    if (this.authed) this.syncSeats();
    else if (this.draining && !this.holdsAny()) this.close();
  }
  holdsAny() { return [...this.seats.values()].some(s => s.holds()); }
  // a bot that leaves the test finishes the round it paid for, but not forever
  checkDrain() { if (this.draining && !this.stop && Date.now() - this.draining > this.a.drainSeconds * 1000) this.close(); }
  syncSeats() {
    for (const s of [...this.seats.values()]) if (s.drain) this.tryLeave(s);
    for (const key of this.want) {
      const s = this.seats.get(key);
      if (s) { if (!s.joined && Date.now() - s.joining > 15000) this.joinSeat(s); continue; }
      // Join a further stake only while every other room holds cartelas: when an account joins a new stake the
      // server makes it leave its other rooms where it holds none (server.js, case 'joinRoom').
      if ([...this.seats.values()].some(o => !o.holds())) continue;
      const n = new Seat(this, key); this.seats.set(key, n); this.joinSeat(n);
    }
    if (this.draining && !this.seats.size) this.close();
  }
  // leave a room safely: never in the middle of a round this bot has cartelas in (those would stay charged and in play)
  tryLeave(s) {
    if (s.joined && s.holds() && (s.status === "playing" || s.status === "countdown")) return false;
    s.pickToken++;
    if (s.roomId) this.send({ type: "leaveRoom", roomId: s.roomId });
    this.seats.delete(s.key);
    return true;
  }
  seatFor(m) {
    for (const s of this.seats.values()) if (m.roomId && s.roomId === m.roomId) return s;
    for (const s of this.seats.values()) if (m.stakeId && s.stakeId === m.stakeId) return s;
    return null;
  }

  // protocol
  async onMessage(m) {
    const t = m.type;
    if (t === "connected") {
      //if (m.deployEnv !== "staging") {
      //  this.fatal = true; this.state = "failed";
      //  if (this.onUnsafe) this.onUnsafe(`the game server at ${this.a.url} did not identify itself as staging (deployEnv=${JSON.stringify(m.deployEnv)}). Set DEPLOY_ENV=staging on the STAGING game server only.`);
      //  return;
      //}
      this.stakes = m.stakes || []; this.authenticate(); return;
    }
    if (t === "authRetry") { await sleep(Math.max(300, m.retryAfter || 1000)); this.authenticate(); return; }
    if (t === "authFailed") {
      this.fatal = true; this.state = "failed"; this.stats.add("auth_failed"); if (this._leaveGate) this._leaveGate();
      console.log(`[${this.tid}] sign-in refused by the server (${m.reason || "?"}). Is BOT_TOKEN the staging server's token, and does the account exist in the staging database?`);
      return;
    }
    if (t === "authSuccess") {
      this.stats.add("signed_in"); if (this._leaveGate) this._leaveGate(); this.authed = true; this.state = "signed in";
      this.log("signed in, wallets", JSON.stringify(m.wallets)); this.syncSeats(); return;
    }
    if (t === "lobbyUpdate") {
      this.stakes = m.stakes || this.stakes;
      if (this.authed && [...this.seats.values()].some(s => !s.joined && Date.now() - s.joining > 15000)) this.syncSeats();
      return;
    }
    if (t === "sessionReplaced") { this.replaced = true; this.stats.add("session_replaced"); return; }
    if (t === "error") {
      if (this.selWaiter) this.selWaiter();   // a refused pick must not block the picking loop
      this.stats.error(m.message || "error"); return;
    }
    if (t === "cardSelected" && this.selWaiter) this.selWaiter();
    const s = this.seatFor(m);
    if (!s) return;                           // a room this bot does not follow (any more)

    if (t === "joinedRoom") this.onJoined(s, m);
    else if (t === "reconnected") {           // back in a running game after a reconnect
      this.markJoined(s, m); s.status = "playing"; s.state = "playing"; s.called = m.calledNumbers || [];
      this.takeCards(s, m);
    }
    else if (t === "postGameWait") { this.markJoined(s, m); s.status = "finished"; s.state = "between rounds"; }
    else if (t === "backToCardSelection") {
      this.roundsDone++; this.stats.add("rounds_finished");
      if (this.a.rounds && this.roundsDone >= this.a.rounds) { this.stop = true; this.state = "done"; return; }
      if (s.drain) { s.mine = {}; s.status = "waiting"; this.syncSeats(); return; }
      this.newRound(s, m);
    }
    else if (t === "cardPoolUpdate" && this.sameRoom(s, m)) { const pool = m.pool || []; s.pool = new Set(pool.map(c => c.id)); s.taken = new Set(pool.filter(c => c.taken).map(c => c.id)); }
    else if (t === "cardPoolDiff" && this.sameRoom(s, m)) { (m.changes || []).forEach(c => { if (c.taken) s.taken.add(c.id); else s.taken.delete(c.id); }); }
    else if (t === "cardSelected") {
      const slot = Number(m.slot || 1);
      s.mine[slot] = m.cardId; s.numbers[slot] = m.cardNumbers || [];
      this.stats.add("cards_selected");
      this.syncSeats();                       // holding a cartela here: a further stake may be joined now
    }
    else if (t === "countdown") { s.status = "countdown"; s.state = "countdown"; }
    else if (t === "waitingForPlayers") { s.status = "waiting"; s.state = "waiting"; }
    else if (t === "gameStart") { s.status = "playing"; s.pickToken++; this.stats.add("games_started"); }
    else if (t === "yourCard") {
      s.status = "playing"; s.state = "playing";
      this.takeCards(s, m);
      this.stats.add("rounds_played");
    }
    else if (t === "spectating") { s.status = "playing"; s.state = "watching"; this.stats.add("rounds_watched"); }
    else if (t === "numberCalled") { s.status = "playing"; s.called = m.calledNumbers || s.called; this.stats.add("numbers_called"); await this.maybeClaim(s); }
    else if (t === "gameOver") {
      s.status = "finished"; s.state = "between rounds";
      if ((m.winnerTelegramIds || []).map(String).includes(this.tid)) this.stats.add("wins");
      this.stats.add("games_finished");
      if (s.drain) this.syncSeats();          // the round it paid for is over: leave now
    }
    else if (t === "disqualified") { this.stats.add("DISQUALIFIED"); console.log(`[${this.tid}] was disqualified - a BINGO claim was refused (that is a bug to look at)`); }
    else if (t === "claimTooLate") this.stats.add("claims_too_late");
    else if (t === "roomClosed") { s.resetRound(); s.joined = false; if (s.drain) this.seats.delete(s.key); else this.joinSeat(s); }
  }
  sameRoom(s, m) { return !m.roomId || !s.roomId || m.roomId === s.roomId; }

  // actions
  authenticate() {
    const msg = { type: "telegramAuth", telegramId: this.tid };
    if (this.a.botToken) msg.initData = signInitData(this.a.botToken, this.tid);
    this.send(msg);
  }
  allowedStakes() { return this.stakes.filter(s => !this.a.forbidden.has(String(Number(s.amount)))); }
  chooseStake(key) {
    if (!this.stakes.length) return null;
    const want = String(key).toLowerCase();
    if (want === "random") {
      const list = this.allowedStakes();
      if (!this._randomStake || !list.some(s => s.stakeId === this._randomStake)) this._randomStake = list.length ? list[Math.floor(Math.random() * list.length)].stakeId : null;
      return list.find(s => s.stakeId === this._randomStake) || null;
    }
    return this.stakes.find(s => String(s.stakeId).toLowerCase() === want || String(s.amount) === want.replace("st", "")) || null;
  }
  joinSeat(s) {
    s.joining = Date.now();                   // also when it fails: retried after 15 s (lobbyUpdate / next tick)
    const st = this.chooseStake(s.key);
    if (!st) { this.stats.error(`stake '${s.key}' not offered by the server (offered: ${this.stakes.map(x => x.stakeId).join(", ")})`); s.state = "no stake"; return; }
    if (this.a.forbidden.has(String(Number(st.amount)))) { this.stats.error(`never joins stake ${st.amount} (LOADTEST_FORBIDDEN_STAKES)`); this.seats.delete(s.key); return; }
    s.stakeId = st.stakeId;
    s.maxCards = Math.min(this.a.cards, Number(st.maxCards || 4));
    s.state = "joining";
    this.send({ type: "joinRoom", stakeId: s.stakeId, telegramId: this.tid });
  }
  markJoined(s, m) { s.roomId = m.roomId || s.roomId; s.stakeId = m.stakeId || s.stakeId; s.joined = true; s.joining = 0; }
  takeCards(s, m) {
    [[m.cardId, m.cardNumbers], [m.cardId2, m.cardNumbers2], [m.cardId3, m.cardNumbers3], [m.cardId4, m.cardNumbers4]]
      .forEach(([cid, nums], i) => { if (cid) { s.mine[i + 1] = cid; s.numbers[i + 1] = nums || []; } });
  }
  onJoined(s, m) {
    this.markJoined(s, m); s.status = m.status || "waiting";
    this.stats.add("rooms_joined");
    this.takeCards(s, m);
    if (s.drain) { this.syncSeats(); return; }
    if (s.status === "waiting" || s.status === "countdown") { s.state = "selecting"; this.startPicking(s); }
    else if (s.status === "playing") s.state = "watching";
  }
  newRound(s, m) {
    s.roomId = m.roomId || s.roomId; s.status = "waiting"; s.taken = new Set();
    if (Array.isArray(m.pool)) s.pool = new Set(m.pool.map(c => c.id));
    s.mine = {}; s.numbers = {}; s.called = []; s.claimed = false;
    s.state = "selecting"; this.startPicking(s);
  }
  startPicking(s) { s.pickToken++; this.pickCards(s, s.pickToken); }

  // The card to ask for: a random card number between cardMin and cardMax that the room offers and is not taken / refused yet.
  nextLowCard(s, skip) {
    const pool = [];
    for (let c = this.a.cardMin; c <= this.a.cardMax; c++) if ((!s.pool || s.pool.has(c)) && !s.taken.has(c) && !skip.has(c)) pool.push(c);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }
  // one card request at a time per connection (the server's 'error' answer does not say which room it is about)
  async withSelLock(fn) {
    const prev = this.selLock; let release;
    this.selLock = new Promise(r => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }

  async pickCards(s, token) {
    const alive = () => token === s.pickToken && !this.stop && !s.drain && this.seats.get(s.key) === s;
    try {
      await sleep(rand(...this.a.think) * 1000);
      const want = s.maxCards;
      const refused = new Set();                       // cards the server refused (already taken) in this round
      let tries = 0;
      while (alive() && Object.keys(s.mine).length < want && (s.status === "waiting" || s.status === "countdown") && tries < 60) {
        tries++;
        const card = this.nextLowCard(s, refused);
        if (card === null) break;
        let slot = 1; while (s.mine[slot]) slot++;
        const before = Object.keys(s.mine).length;
        await this.withSelLock(() => new Promise(res => {
          if (!alive()) return res();
          const timer = setTimeout(() => done(), 4000);   // wait for the server's answer (cardSelected or error)
          const done = () => { clearTimeout(timer); if (this.selWaiter === done) this.selWaiter = null; res(); };
          this.selWaiter = done;
          this.send({ type: "selectCard", cardId: card, slot, roomId: s.roomId });
        }));
        if (!alive()) return;
        if (Object.keys(s.mine).length === before) { refused.add(card); s.taken.add(card); }   // not accepted: try another card
        await sleep(rand(...this.a.think) * 1000);
      }
      s.state = `selected ${Object.keys(s.mine).length}`;
    } catch (e) { /* cancelled */ }
  }

  async maybeClaim(s) {
    if (s.claimed || !this.a.autoBingo || !Object.keys(s.numbers).length) return;
    const winning = Object.entries(s.numbers).filter(([, nums]) => nums && nums.length && cardWins(nums, s.called));
    if (!winning.length) return;
    s.claimed = true;
    await sleep(rand(100, 1200));                        // inside the 4.8 s claim window
    const msg = { type: "claimBingo", roomId: s.roomId, automatic: true };
    for (let slot = 1; slot <= 4; slot++) {
      const nums = s.numbers[slot], sfx = slot === 1 ? "" : String(slot);
      if (nums && nums.length) { msg["cardId" + sfx] = s.mine[slot]; msg["markedIndices" + sfx] = markedIndices(nums, s.called); }
    }
    this.send(msg);
    this.stats.add("bingo_claims");
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const c = CONFIG, sc = c.schedule;
  const a = { mode: String(c.mode).toLowerCase(), url: c.url, ids: "", idsFile: c.idsFile, botToken: String(c.botToken || "").trim(), unverified: !!c.unverified,
    stake: String(c.stake), cards: Number(c.cards) || 1, cardMin: Math.max(1, Number(c.cardMin) || 1), cardMax: Math.min(600, Number(c.cardMax) || 80), think: [...c.think], autoBingo: !!c.autoBingo,
    rounds: Number(c.rounds) || 0, stagger: Number(c.stagger), report: Math.max(5, Number(c.report) || 60), yes: !c.confirm, verbose: !!c.verbose, logMessages: !!c.logMessages,
    allowedHosts: c.allowedHosts, forbidden: new Set(hostList(c.forbiddenStakes).map(x => String(Number(x.replace("st", ""))))),
    handshakeTimeout: Math.max(3, sc.handshakeTimeout), maxBackoff: Math.max(5, sc.maxBackoff), drainSeconds: Math.max(30, sc.drainSeconds) };
  if (!a.url) { console.error("Set LOADTEST_URL (or CONFIG.url at the top of stress_test.js)"); process.exit(1); }
  if (!["schedule", "fixed"].includes(a.mode)) { console.error(`LOADTEST_MODE must be "schedule" or "fixed", not "${a.mode}"`); process.exit(1); }
  a.cards = Math.max(1, Math.min(4, a.cards));
  if (a.mode === "schedule") a.cardMax = Math.min(600, Number(sc.cardMax) || 600);
  if (a.cardMin > a.cardMax) [a.cardMin, a.cardMax] = [a.cardMax, a.cardMin];
  if (a.think[0] > a.think[1]) a.think.reverse();
  if (a.mode === "schedule") a.schedule = parseSchedule(sc, a);
  return a;
}
function parseSchedule(sc, a) {
  const out = { ...sc, targets: {} };
  try { new Intl.DateTimeFormat("en", { timeZone: sc.timezone }); } catch (e) { console.error(`LOADTEST_TZ "${sc.timezone}" is not a timezone (example: Africa/Addis_Ababa)`); process.exit(1); }
  try { out.startMin = parseHHMM(sc.peakStart); out.endMin = parseHHMM(sc.peakEnd); } catch (e) { console.error("LOADTEST_PEAK_START / LOADTEST_PEAK_END: " + e.message); process.exit(1); }
  for (const [amt, t] of Object.entries(sc.targets)) {
    const peak = Math.max(0, Math.round(t.peak));
    const offPeak = t.offPeak == null ? Math.round(peak * sc.offPeakPercent / 100) : Math.max(0, Math.round(t.offPeak));
    if ((peak || offPeak) && a.forbidden.has(String(Number(amt)))) { console.error(`stake ${amt} is in LOADTEST_FORBIDDEN_STAKES but has a target`); process.exit(1); }
    if (peak || offPeak) out.targets[amt] = { peak, offPeak };
  }
  const largest = Math.max(0, ...Object.values(out.targets).map(t => Math.max(t.peak, t.offPeak)));
  out.poolSize = sc.poolSize > 0 ? Math.round(sc.poolSize) : Math.ceil(largest * (1 + sc.jitterPercent / 100)) + 2;
  out.tickSeconds = Math.max(5, sc.tickSeconds);
  return out;
}
function loadIds(a) {
  let ids = CONFIG.ids.map(x => String(x).trim()).filter(Boolean);
  if (a.idsFile) ids = ids.concat(require("fs").readFileSync(a.idsFile, "utf8").split(/\r?\n/).map(l => l.split("#")[0].trim()).filter(Boolean));
  return cleanIds(ids);
}
function cleanIds(ids) {
  const clean = [], seen = new Set();
  for (const x of ids) {
    if (!/^\d+$/.test(x) || Number(x) <= 0) { console.error("Not a Telegram ID: " + JSON.stringify(x)); process.exit(1); }
    if (!seen.has(x)) { seen.add(x); clean.push(x); }
  }
  return clean;
}
// schedule mode: the ids file if one is given, else idStart, idStart+1, ... (enough for the largest target)
function scheduleIds(a) {
  const sc = a.schedule;
  if (a.idsFile) {
    const ids = cleanIds(require("fs").readFileSync(a.idsFile, "utf8").split(/\r?\n/).map(l => l.split("#")[0].trim()).filter(Boolean));
    if (ids.length < sc.poolSize) console.warn(`only ${ids.length} IDs in ${a.idsFile}: targets are capped at that`);
    sc.poolSize = Math.min(sc.poolSize, ids.length);
    return ids.slice(0, sc.poolSize);
  }
  return Array.from({ length: sc.poolSize }, (_, i) => String(sc.idStart + i));
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans); }));
}
function checkToken(a) {
  if (!a.unverified && !a.botToken) {
    console.error("BOT_TOKEN is not set. The server verifies Telegram's signed login data, so the script needs the bot token the STAGING server uses " +
      "(set the BOT_TOKEN environment variable, e.g. Windows cmd: set BOT_TOKEN=123456:ABC... ). For a staging server with ALLOW_UNVERIFIED_AUTH=1 set CONFIG.unverified = true.");
    process.exit(1);
  }
  if (a.unverified) a.botToken = "";
}

// the original test: all accounts, one stake, until Ctrl+C (or CONFIG.rounds)
async function runFixed(a) {
  const ids = loadIds(a);
  if (!ids.length) { console.error("No Telegram IDs given: fill CONFIG.ids or CONFIG.idsFile"); process.exit(1); }
  if (!a.yes) {
    console.log(`This will sign in as ${ids.length} account(s) on ${a.url} and PLAY FOR REAL: every picked cartela is charged to those accounts' (staging) wallets.`);
    if ((await ask("Type CHARGE to continue: ")).trim() !== "CHARGE") { console.log("Cancelled."); process.exit(1); }
  }
  const stats = new Stats();
  let stopping = false;
  const onUnsafe = msg => { if (stopping) return; stopping = true; bots.forEach(b => b.close()); refuse(msg); };
  const bots = ids.map(id => new Bot(id, a, stats, { want: [a.stake], onUnsafe }));
  const runs = [];
  const finish = async () => {
    if (stopping) return; stopping = true;
    bots.forEach(b => b.close());
    await Promise.race([Promise.allSettled(runs), sleep(3000)]);
    stats.report(bots);
    process.exit(0);
  };
  process.on("SIGINT", finish); process.on("SIGTERM", finish);
  console.log(`Started ${bots.length} bot(s). Each picks ${a.cards} card(s), random free card numbers between ${a.cardMin} and ${a.cardMax}. Press Ctrl+C to stop.`);
  const reporter = setInterval(() => stats.report(bots), a.report * 1000);
  for (const b of bots) { runs.push(b.run()); await sleep(a.stagger * 1000); }
  // with --rounds: stop when everyone is done
  const watch = setInterval(() => {
    if (bots.every(b => ["done", "failed", "stopped"].includes(b.state))) { clearInterval(watch); clearInterval(reporter); finish(); }
  }, 500);
}

// LOADTEST_DRY_RUN=1: the targets for the next 24 hours, every 30 minutes (connects to nothing)
function printPlan(a) {
  const sc = a.schedule, amounts = Object.keys(sc.targets);
  console.log(`timezone ${sc.timezone}, peak ${sc.peakStart}-${sc.peakEnd}, ramps ${sc.rampMinutes} min, jitter ±${sc.jitterPercent} %, account pool ${sc.poolSize}`);
  console.log(`never joined: stake ${[...a.forbidden].join(", ") || "(none)"}`);
  const now = Date.now(), start = now - (now % 1800000);
  for (let i = 0; i <= 48; i++) {
    const d = new Date(start + i * 1800000), r = computeTargets(sc, d);
    const lm = localMinutes(sc.timezone, d), hh = String(Math.floor(lm / 60)).padStart(2, "0"), mm = String(Math.floor(lm % 60)).padStart(2, "0");
    console.log(`${hh}:${mm}  ${r.phase.padEnd(8)}  ` + amounts.map(x => `stake ${x}: ${String(r.targets[x]).padStart(4)}`).join("   ") + `   bots: ${Math.max(0, ...Object.values(r.targets))}`);
  }
}

// optional (LOADTEST_TOPUP=1): create the test accounts and refill their STAGING main wallets through db.js
async function setupTopUp(a, ids) {
  const sc = a.schedule;
  let host = "";
  try { host = new URL(process.env.DATABASE_URL || "").hostname.toLowerCase(); } catch (e) {}
  if (!host) refuse("LOADTEST_TOPUP=1 needs DATABASE_URL (the STAGING database).");
  //if (!hostList(sc.dbAllowedHosts).includes(host)) refuse(`database host ${host} is not listed in LOADTEST_DB_ALLOWED_HOSTS.`);
  const db = require("./db");
 // if (!(await db.isStagingDatabase())) refuse(`the database at ${host} has no staging_marker table, so it is not treated as staging.`);
  const added = await db.ensureLoadTestUsers(ids, sc.namePrefix);
  if (added) console.log(`created ${added} test account(s) in the staging database`);
  const refill = async () => {
    try { const n = await db.topUpLoadTestWallets(ids, sc.topUpBelow, sc.topUpTo); if (n) console.log(`refilled ${n} staging wallet(s) to ${sc.topUpTo}`); }
    catch (e) { console.error("wallet top-up failed:", e.message); }
  };
  await refill();
  setInterval(refill, Math.max(5, sc.topUpMinutes) * 60000).unref();
}

// schedule mode: one tick every tickSeconds moves the number of bots toward the targets of this moment
async function runSchedule(a) {
  const sc = a.schedule;
  const ids = scheduleIds(a);
  if (sc.topUp) await setupTopUp(a, ids);
  const stats = new Stats();
  const gate = new ConnectGate(sc.connectPerSecond, sc.maxConnecting);
  const bots = new Map();                     // index in ids -> Bot
  let stopping = false, last = null, lastPhase = "", cpuPrev = process.cpuUsage(), cpuAt = Date.now();
  const shutdown = async (code) => {
    if (stopping) return; stopping = true;
    clearInterval(ticker); clearInterval(reporter);
    bots.forEach(b => b.setWant([]));         // leaves rooms where that is safe (no cartelas in a running round)
    await sleep(1500);
    bots.forEach(b => b.close());
    await sleep(500);
    process.exit(code);
  };
  const onUnsafe = msg => { if (stopping) return; console.error("REFUSING TO RUN: " + msg); shutdown(2); };
  const tick = () => {
    if (stopping) return;
    last = computeTargets(sc);
    if (last.phase !== lastPhase) { console.log(`[schedule] ${lastPhase || "start"} -> ${last.phase} (${JSON.stringify(last.targets)})`); lastPhase = last.phase; }
    const amounts = Object.keys(last.targets).sort((x, y) => sc.targets[y].peak - sc.targets[x].peak);   // biggest stake first (10, then 5)
    for (let i = 0; i < ids.length; i++) {
      // bot i plays every stake whose target is above i: the stake 5 players are the first bots of the stake 10 players
      const want = amounts.filter(x => i < last.targets[x]);
      let b = bots.get(i);
      if (!want.length) { if (b) { b.setWant([]); b.checkDrain(); } continue; }
      if (b && b.stop) continue;              // still closing: started again on a later tick
      if (!b) {
        b = new Bot(ids[i], a, stats, { gate, onUnsafe, want });
        bots.set(i, b);
        const me = b; b.run().catch(e => stats.error("bot: " + e.message)).finally(() => { if (bots.get(i) === me) bots.delete(i); });
      } else b.setWant(want);
    }
  };
  const report = () => {
    if (!last) return;
    const seated = {}, holding = {};
    let signedIn = 0;
    for (const b of bots.values()) {
      if (b.authed) signedIn++;
      for (const s of b.seats.values()) { if (s.joined) seated[s.key] = (seated[s.key] || 0) + 1; if (s.holds()) holding[s.key] = (holding[s.key] || 0) + 1; }
    }
    const cpu = process.cpuUsage(cpuPrev), ms = Date.now() - cpuAt; cpuPrev = process.cpuUsage(); cpuAt = Date.now();
    const cpuPct = ((cpu.user + cpu.system) / 1000 / ms * 100).toFixed(1), rss = Math.round(process.memoryUsage().rss / 1048576);
    const stakes = Object.keys(sc.targets).map(x => `st${x} target=${last.targets[x] || 0} seated=${seated[x] || 0} with-cards=${holding[x] || 0}`).join(" | ");
    const other = Object.keys(seated).filter(x => !(x in sc.targets)).map(x => `st${x} seated=${seated[x]} (UNEXPECTED)`).join(" | ");
    const c = stats.c;
    console.log(`[${new Date().toISOString()}] ${last.phase} | ${stakes}${other ? " | " + other : ""} | bots=${bots.size} signed-in=${signedIn} | rss=${rss}MB cpu=${cpuPct}% | ` +
      `games=${c.games_finished || 0} wins=${c.wins || 0} claims=${c.bingo_claims || 0} disconnects=${c.disconnects || 0} auth_failed=${c.auth_failed || 0} replaced=${c.session_replaced || 0} DISQ=${c.DISQUALIFIED || 0}`);
    const errs = Object.entries(stats.errors).sort((x, y) => y[1] - x[1]).slice(0, 3);
    if (errs.length) console.log("   server messages since last report: " + errs.map(([t, n]) => `${n} x ${t}`).join(" ; "));
    stats.errors = {};
  };
  process.on("SIGINT", () => shutdown(0)); process.on("SIGTERM", () => shutdown(0));
  console.log(`Load test (schedule) on ${a.url}: ${ids.length} test account(s), timezone ${sc.timezone}, peak ${sc.peakStart}-${sc.peakEnd}, ` +
    `targets ${JSON.stringify(sc.targets)}, never stake ${[...a.forbidden].join(",")}. Up to ${sc.connectPerSecond} new connection(s)/s.`);
  tick();
  const ticker = setInterval(tick, sc.tickSeconds * 1000);
  const reporter = setInterval(report, a.report * 1000);
}

async function main() {
  const a = parseArgs();
 // if (a.mode === "schedule" && a.schedule.dryRun) { printPlan(a); return; }
 // assertSafeTarget(a);
  checkToken(a);
  //if (a.mode === "fixed") return runFixed(a);
  return runSchedule(a);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { signInitData, cardWins, markedIndices, Bot, Seat, Stats, parseArgs, peakFactor, computeTargets, localMinutes, assertSafeTarget, PROD_HOSTS };
