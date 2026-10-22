/**
 * Game server (name/version come from BOT_NAME / BOT_VERSION)
 * Changes:
 *  - Disqualification only notifies the cheater (silent to others)
 *  - Full DB integration
 */

require('dotenv').config();
const crypto=require('crypto');

// ─── LOG FILE ────────────────────────────────────────────────
// Hosting panels (cPanel / Passenger) often do not keep the console output. Everything the server prints, and every
// crash, is also appended to server.log next to this file (kept below ~2 MB: it starts again when it gets bigger).
(function setupFileLog(){
  try{
    const fs=require('fs'), p=require('path').join(__dirname,'server.log');
    try{ if(fs.statSync(p).size>2*1024*1024) fs.renameSync(p,p+'.old'); }catch(e){}
    const write=(lvl,args)=>{
      try{
        const text=args.map(a=>a instanceof Error?(a.stack||a.message):(typeof a==='string'?a:JSON.stringify(a))).join(' ');
        fs.appendFileSync(p,new Date().toISOString()+' '+lvl+' '+text+'\n');
      }catch(e){}
    };
    ['log','warn','error'].forEach(k=>{
      const orig=console[k].bind(console);
      console[k]=(...args)=>{ orig(...args); write(k.toUpperCase(),args); };
    });
    process.on('uncaughtException',e=>{ write('CRASH',[e]); try{ console.error('uncaughtException:',e); }catch(_){} process.exit(1); });
    process.on('unhandledRejection',e=>{ write('UNHANDLED',[e]); });
    write('START',['server process starting, node '+process.version+', pid '+process.pid+', PORT='+(process.env.PORT||'(not set)')]);
  }catch(e){}
})();

// Fair random pick for the number draw: an unbiased integer in [0, n) from the operating system's
// cryptographic random generator (not Math.random, whose internal state can be reconstructed from its output).
function randomIndex(n){
  n=Math.max(1,Math.floor(Number(n)||1));
  if(typeof crypto.randomInt==='function') return crypto.randomInt(n);       // Node 14.10+
  const limit=Math.floor(0x100000000/n)*n;                                   // older Node: rejection sampling, no modulo bias
  let x; do{ x=crypto.randomBytes(4).readUInt32BE(0); }while(x>=limit);
  return x%n;
}

// ─── PROVABLY FAIR DRAW ──────────────────────────────────────
// Every round gets its call order BEFORE card selection: a shuffle of 1..75 (secure random) and a random salt.
// commitment = SHA-256(salt + ':' + order.join(',')) is shown to the players at once; the numbers are called in exactly that
// order; the order and the salt are revealed in 'gameOver' and on the public page /verify?game=<game code>.
function fairnessHash(order,salt){ return crypto.createHash('sha256').update(`${salt}:${order.join(',')}`).digest('hex'); }
function newFairness(){
  const order=Array.from({length:75},(_,i)=>i+1);
  for(let i=order.length-1;i>0;i--){ const j=randomIndex(i+1); [order[i],order[j]]=[order[j],order[i]]; }   // Fisher-Yates
  const salt=crypto.randomBytes(16).toString('hex');
  return {order,salt,commitment:fairnessHash(order,salt)};
}
// messages that carry the commitment (so a player has it before the numbers start)
const COMMIT_TYPES=new Set(['joinedRoom','spectating','countdown','waitingForPlayers','gameStart','yourCard']);

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const bingoDb=require('./db');
console.log('✅ db.js loaded (wallets, stakes, bingo games)');

// ─── TELEGRAM SIGN-IN VERIFICATION (shared with data_server.js, see tg_auth.js) ───
const { BOT_TOKEN, ALLOW_UNVERIFIED_AUTH, verifyInitData, resolveTelegramId } = require('./tg_auth');

const app    = express();
const server = http.createServer(app);
// Abuse limits (item 3): small messages only, a cap of sockets per address, and sockets that never sign in are dropped.
// The per-address cap is generous on purpose: mobile carriers put many real players behind one shared address.
const WS_MAX_PAYLOAD=16*1024;
const MAX_CONN_PER_IP=Number(process.env.MAX_CONN_PER_IP)||150;
const AUTH_TIMEOUT_MS=Number(process.env.AUTH_TIMEOUT_MS)||30000;
const connPerIp=new Map();
function clientIp(req){
  const xff=String(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);
  // the proxy in front of us appends the real address last; earlier entries can be forged by the client
  return xff.length?xff[xff.length-1]:(req.socket.remoteAddress||'?');
}
const wss    = new WebSocket.Server({ server, maxPayload:WS_MAX_PAYLOAD });
const APP_NAME = String(process.env.BOT_NAME || "Mesob Bingo").trim() || "Mesob Bingo";
const APP_VERSION = String(process.env.BOT_VERSION || "").trim();
const APP_TITLE = APP_VERSION ? `${APP_NAME} ${APP_VERSION}` : APP_NAME;
const PORT   = process.env.PORT || 3000;

// Open https://your-server/health in a browser to see that the server is up (no secrets are shown).
app.get('/health',(req,res)=>{
  // production: only {ok:true}. Details need HEALTH_KEY (set it as a variable, then open /health?key=...).
  if(!process.env.HEALTH_KEY||req.query.key!==process.env.HEALTH_KEY) return res.json({ok:true});
  res.json({ok:true,time:new Date().toISOString(),uptimeSeconds:Math.round(process.uptime()),node:process.version,
    stakesLoaded:STAKES.length,stakeList:STAKES.map(x=>({id:x.id,amount:x.amount,room:x.roomName||x.dbRoomId,showRoomPage:x.showRoomPage})),rooms:Object.keys(rooms).length,players:Object.keys(clients).length,
    botTokenSet:!!BOT_TOKEN,unverifiedAuth:ALLOW_UNVERIFIED_AUTH});
});
// ─── LIVE PLAYERS (admin dashboard "Live players") ───────────────
// Only the data server may call this: it sends the shared secret LIVE_KEY (min 16 characters, set the SAME value on both
// services) and shows the answer to signed-in admins. Without LIVE_KEY the endpoint stays closed. Nothing is stored.
const LIVE_KEY=String(process.env.LIVE_KEY||'');
app.get('/internal/live',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(LIVE_KEY.length<16) return res.status(503).json({error:'LIVE_KEY is not set on the game server (min 16 characters)'});
  const k=Buffer.from(String(req.headers['x-live-key']||'')), want=Buffer.from(LIVE_KEY);
  if(k.length!==want.length||!crypto.timingSafeEqual(k,want)) return res.status(401).json({error:'unauthorized'});
  try{ res.json(liveSnapshot()); }catch(e){ console.error('liveSnapshot:',e.message); res.status(500).json({error:'snapshot failed'}); }
});
function liveSnapshot(){
  const roomName=r=>{ const s=STAKES.find(x=>x.id===r.stakeId); return (s&&s.roomName)||''; };
  const playing=[], inPlay=new Set();
  for(const r of Object.values(rooms)){
    if(r.status!=='playing'&&r.status!=='starting') continue;
    for(const p of r.players){
      if(!p.hasPaid) continue;
      const tid=p.telegramId?String(p.telegramId):'';
      if(tid) inPlay.add(tid);
      playing.push({telegramId:tid,name:p.playerName||'',stake:r.stake,room:roomName(r),cartelas:getPlayerCardCount(p),
        called:r.calledNumbers.length,connected:openSockets(p).length>0,disqualified:!!p.disqualified});
    }
  }
  // everybody with an open, signed-in socket; one row per account (several devices count once)
  const seen=new Map(); let unsigned=0;
  for(const c of Object.values(clients)){
    if(!(c.ws&&c.ws.readyState===WebSocket.OPEN)) continue;
    if(!c.telegramId){ unsigned++; continue; }
    const tid=String(c.telegramId);
    if(seen.has(tid)) continue;
    let where='Lobby', stake=null, room='';
    const r=c.roomId?rooms[c.roomId]:null;
    if(r){
      stake=r.stake; room=roomName(r);
      where=(r.status==='waiting'||r.status==='countdown')?'Choosing cartelas':(r.status==='playing'||r.status==='starting')?'Watching a game':'Viewing the result';
    }
    seen.set(tid,{telegramId:tid,name:c.playerName||'',where,stake,room});
  }
  const onlinePlaying=playing.filter(p=>p.connected&&p.telegramId).length;
  const onlineOnly=[...seen.values()].filter(u=>!inPlay.has(u.telegramId));
  return {at:new Date().toISOString(),
    counts:{online:seen.size+unsigned,signedIn:seen.size,unsigned,playing:playing.length,playingOnline:onlinePlaying,onlineOnly:onlineOnly.length},
    playing:playing.sort((a,b)=>(b.stake-a.stake)||String(a.room).localeCompare(String(b.room))||String(a.name).localeCompare(String(b.name))),
    onlineOnly:onlineOnly.sort((a,b)=>String(a.where).localeCompare(String(b.where))||String(a.name).localeCompare(String(b.name)))};
}
// /verify and /admin live on the web client (Vercel). If someone opens them on this server, send them there
// (set CLIENT_URL=https://your-client.vercel.app on Railway; default below).
const CLIENT_URL=String(process.env.CLIENT_URL||'https://game-client-go-three.vercel.app').replace(/\/+$/,'');
app.get(['/verify','/admin'],(req,res)=>res.redirect(302,CLIENT_URL+req.path+(req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Telegram-Init-Data');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function paidPlayersOf(room){ return room.players.filter(p=>p.hasPaid); }
function livePlayerCount(room){ return paidPlayersOf(room).length; }
function paidPlayerList(room){ return paidPlayersOf(room).map(p=>({playerId:p.playerId,playerName:p.playerName})); }

// ─── DATABASE ─────────────────────────────────────────────────
// db.js is the ONLY way this server reaches the database (it owns the connection and every query):
//   getUserWalletBalances -> main + play + bonus wallets
//   getBingoUserFlags     -> blocked / inactive flags
//   getActiveStakes       -> rooms and stakes (loaded at start, refreshed every 10 min)
//   createBingoGame       -> charges every cartela and creates the game (called when a round starts)
//   endBingoGame          -> pays the winners (called when a round ends)
//   cancelBingoGame       -> closes a game without a winner and refunds it
//   getBingoUserDashboard / getBingoProfileStats -> profile page data


// ─── CONFIG ──────────────────────────────────────────────────
const LOBBY_WAIT_MS    = 30000;
const CALL_INTERVAL_MS = 5000;
// delay before the FIRST number of a round (later numbers use CALL_INTERVAL_MS); env FIRST_CALL_DELAY_MS, 0-60000 ms
const FIRST_CALL_DELAY_MS = (()=>{ const v=Number(process.env.FIRST_CALL_DELAY_MS); return Number.isFinite(v)&&v>=0&&v<=60000?Math.round(v):2000; })();
const CLAIM_WINDOW_MS  = 4800;
const CLAIM_COLLECT_MS = 700; // grace period to gather simultaneous BINGO claims
const TOTAL_CARDS      = 600;   // largest card_count a room may use (your rooms use 600)

// Stakes come ONLY from the database (bingo_stakes / bingo_rooms), see loadStakesFromDb().
const STAKES = [];
// used only when the database gives no valid next_round_seconds
const DEFAULT_NEXT_ROUND_SECONDS = 20;
const STAKES_RETRY_MS = 10000;
let stakesRetryTimer=null;
function retryStakesSoon(){ if(stakesRetryTimer||STAKES.length) return; stakesRetryTimer=setTimeout(()=>{ stakesRetryTimer=null; loadStakesFromDb(); },STAKES_RETRY_MS); }

// Stakes / rooms come from the database (bingo_stakes + bingo_rooms). They are loaded ONCE at
// start-up and refreshed every 10 minutes; the constants above are only the fallback.
// The app names a stake by its amount (st5, st10, st20); the database's own id (S5, S10, ...) is kept in dbStakeId.
const stakeKey=a=>'st'+(Number.isInteger(Number(a))?Number(a):String(a).replace('.','p'));
async function loadStakesFromDb(){
  try{
    const list=await bingoDb.getActiveStakes();
    const seen=new Set(), next=[];
    for(const s of list){
      // a stake can have SEVERAL rooms. The first (lowest id) room keeps the plain id (st10) so existing
      // clients keep working; further rooms get st10r<roomId>. `group` ties the rooms of one stake together.
      const group=stakeKey(s.amount);
      const first=!seen.has(group); seen.add(group);
      next.push({
        id:first?group:group+'r'+s.roomId, group, showRoomPage:s.showRoomPage===true, dbStakeId:s.dbId, dbRoomId:s.roomId, roomName:s.roomName||'', name:s.displayName||s.name,
        amount:s.amount,
        maxPlayers:s.maxPlayers||400,
        cardLimit:Math.max(1,Math.min(TOTAL_CARDS,s.cardCount||TOTAL_CARDS)),
        minPlayers:Math.max(2,s.minPlayers||2),
        maxCards:Math.max(1,Math.min(4,s.maxCardsPerPlayer||4)),
        selectionSeconds:s.selectionSeconds||Math.ceil(LOBBY_WAIT_MS/1000),
        nextRoundSeconds:s.nextRoundSeconds,    // bingo_rooms.next_round_seconds: pause between the end of a game and the next round
        commissionRate:Number.isFinite(s.commissionRate)?s.commissionRate:null    // bingo_commission_rules.commission_rate of the room (percent)
      });
    }
    if(!next.length){ console.warn('⚠️ getActiveStakes returned no active stakes (bingo_stakes + bingo_room_stakes + bingo_rooms must be active)'); retryStakesSoon(); return false; }
    STAKES.splice(0,STAKES.length,...next);
    console.log('✅ Stakes loaded from database:',next.map(x=>`${x.id}=${x.amount} (room ${x.dbRoomId}, ${x.minPlayers}-${x.maxPlayers} players, ${x.maxCards} cards, room page ${x.showRoomPage?'on':'off'})`).join(' | '));
    broadcastLobby();
    return true;
  }catch(e){ console.error('loadStakesFromDb:',e.message); retryStakesSoon(); return false; }
}

loadStakesFromDb(); loadFundingWallets();
setInterval(()=>{ loadStakesFromDb(); loadFundingWallets(); },10*60*1000);
// clean up games left open by an earlier run (restart / crash); young ones are left alone
setTimeout(()=>recoverOrphanedGames({minAgeSec:600,reason:'startup_cleanup'}),20*1000);
setInterval(()=>recoverOrphanedGames({minAgeSec:900,reason:'stale_game'}),10*60*1000);
// unusable bonus money (completed / expired awards) is removed from the Bonus wallet (forfeit_bonus.sql)
let bonusExpiryWarned=false;
async function runBonusExpiry(){
  try{
    const r=await bingoDb.expireBonuses(200);
    if(r&&(r.forfeited_awards>0||r.errors>0)) console.log('Bonus expiry: forfeited',r.forfeited_awards,'award(s),',r.forfeited_total,'total, errors',r.errors);
  }catch(e){
    if(!bonusExpiryWarned){ bonusExpiryWarned=true; console.warn('Bonus expiry skipped:',e.message,'- install forfeit_bonus.sql'); }
  }
}
setTimeout(runBonusExpiry,30*1000);
setInterval(runBonusExpiry,5*60*1000);

// ─── GAME BONUS (game_bonus.sql): % of the cash stakes back as Bonus after N games in a time window ───
// Evaluated right after a game is settled; a sweep every 5 minutes catches anything missed (all idempotent).
// A bonus problem never touches winners' payouts: everything here is best-effort and only logged.
let gameBonusWarned=false;
async function sendTelegramText(chatId,text){
  if(!BOT_TOKEN||!chatId) return;
  try{
    const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(8000)});
    if(!r.ok) console.warn('Telegram sendMessage failed for',chatId,'HTTP',r.status);
  }catch(e){ console.warn('Telegram sendMessage failed for',chatId+':',e.message); }
}
async function announceGameBonuses(awards){
  if(!Array.isArray(awards)||!awards.length) return;
  await forEachLimit(awards,5,async a=>{
    const amt=Number(a.bonus_amount).toFixed(2).replace(/\.00$/,'');
    console.log(`🎁 Game bonus: user ${a.user_id} got ${amt} (${a.campaign_name}, ${a.games} games, base ${a.base_amount})`);
    await sendTelegramText(a.telegram_id,
      `🎁 ቦነስ አግኝተዋል!\n${a.games} ጨዋታዎችን ስለተጫወቱ ${amt} ETB ቦነስ ወደ ቦነስ ሂሳብዎ ተጨምሯል።\n\n`+
      `🎁 Bonus received!\nFor playing ${a.games} games you got ${amt} ETB in your Bonus wallet. (${a.campaign_name})`);
    // a player who is online sees the new Bonus balance at once
    const cl=Object.values(clients).find(c=>String(c.telegramId||'')===String(a.telegram_id));
    if(cl) await pushWallets({telegramId:cl.telegramId,playerId:cl.playerId,ws:cl.ws});
  });
}
function reportGameBonus(res,where){
  if(!res) return;
  if(Array.isArray(res.errors)&&res.errors.length) console.error(`Game bonus (${where}): ${res.errors.length} error(s):`,JSON.stringify(res.errors).slice(0,500));
  announceGameBonuses(res.awards).catch(e=>console.error('announceGameBonuses:',e.message));
}
function gameBonusFailed(e){
  if(!gameBonusWarned){ gameBonusWarned=true; console.warn('Game bonus skipped:',e.message,'- install game_bonus.sql'); }
}
async function runGameBonuses(gameId){
  try{ reportGameBonus(await bingoDb.processGameBonuses(gameId),'game '+gameId); }catch(e){ gameBonusFailed(e); }
}
async function runPendingGameBonuses(){
  try{ reportGameBonus(await bingoDb.processPendingGameBonuses(50),'sweep'); }catch(e){ gameBonusFailed(e); }
}
setTimeout(runPendingGameBonuses,45*1000);
setInterval(runPendingGameBonuses,5*60*1000);

// ─── BLOCKED ACCOUNTS: cut off within seconds ───────────────
// Every BLOCK_CHECK_MS one query tells which connected accounts were blocked / deactivated meanwhile.
//  - rooms that have not started: his cartelas are released (nothing was charged yet) and he leaves the room
//  - running games: he stays in them (his stake is already in the prize pool); if he wins, the prize is paid
//    into his (locked) Main wallet by the database as usual
//  - his connection(s) are closed; sign-in is refused from now on (see telegramAuth)
const BLOCK_CHECK_MS=15*1000;
let blockCheckRunning=false;
async function kickBlockedClients(){
  if(blockCheckRunning||!bingoDb||typeof bingoDb.getAccountRestrictions!=='function') return;
  blockCheckRunning=true;
  try{
    const online=Object.values(clients).filter(c=>c.telegramId&&!c.blocked&&c.ws&&c.ws.readyState===WebSocket.OPEN);
    if(!online.length) return;
    const r=await bingoDb.getAccountRestrictions([...new Set(online.map(c=>String(c.telegramId)))]);
    const bad=new Set(r.blocked), idle=new Set(r.inactive);
    for(const c of online){
      const tid=String(c.telegramId);
      // ── inactive: stays connected as a watcher, loses the cartelas of rooms that have not started ──
      const nowInactive=idle.has(tid);
      if(nowInactive!==(c.inactive===true)){
        c.inactive=nowInactive;
        const u=userCache[tid]; if(u){ u.inactive=nowInactive; u.flagsAt=Date.now(); }
        console.warn(`[account] ${tid} is now ${nowInactive?'inactive (watch only)':'active again'}`);
        send(c.ws,{type:'accountStatus',inactive:nowInactive});
        if(nowInactive){
          for(const room of clientRooms(c)){
            if(room.status!=='waiting'&&room.status!=='countdown') continue;
            const p=playerOf(room,c); if(!p||getPlayerCardCount(p)===0) continue;
            const ids=getPlayerCardIds(p); const slots=[1,2,3,4].map(sl=>[sl,p[getCardField(sl)]]).filter(x=>x[1]);
            releasePlayerCards(room,p);
            slots.forEach(([sl,id])=>sendRoom(room,p.ws,{type:'cardDeselected',cardId:id,slot:sl}));
            broadcastCardPool(room);
          }
        }
        broadcastLobby();
      }
      // ── blocked: cut off ──
      if(!bad.has(tid)) continue;
      console.warn(`[block] ${c.telegramId} was blocked: disconnecting`);
      c.blocked=true;
      const u=userCache[String(c.telegramId)]; if(u){ u.blocked=true; u.flagsAt=Date.now(); }
      for(const room of clientRooms(c)){
        if(room.status==='waiting'||room.status==='countdown'){ await leaveRoom(c,room.roomId).catch(()=>{}); }
      }
      const socks=new Set([c.ws]);
      for(const room of clientRooms(c)){ const p=playerOf(room,c); if(p&&p.ws&&p.ws.sockets) p.ws.sockets.forEach(x=>socks.add(x)); }
      Object.values(clients).forEach(o=>{ if(o!==c&&String(o.telegramId||'')===String(c.telegramId)&&o.ws) socks.add(o.ws); });
      socks.forEach(x=>{ if(x&&x.readyState===1){ try{ x.send(JSON.stringify({type:'authFailed',reason:'blocked'})); }catch(e){} try{ x.close(4003,'blocked'); }catch(e){} } });
    }
    broadcastLobby();
  }catch(e){ console.error('kickBlockedClients:',e.message); }
  finally{ blockCheckRunning=false; }
}
setInterval(kickBlockedClients,BLOCK_CHECK_MS);

// release the seat of players who hold cartelas in a still-waiting room but have been gone for a very long time
setInterval(()=>{
  const now=Date.now();
  Object.values(rooms).forEach(room=>{
    if(room.status!=='waiting') return;
    room.players.slice().forEach(p=>{
      if(!p.absentSince||openSockets(p).length) return;
      if(now-p.absentSince<ABSENT_RELEASE_MS) return;
      console.warn(`player ${p.telegramId} was away for ${Math.round((now-p.absentSince)/60000)} min in waiting room ${room.stakeId}: cartelas released`);
      const ghost={playerId:p.playerId,telegramId:p.telegramId,rooms:new Set([room.roomId]),ws:null,roomId:room.roomId};
      leaveRoom(ghost,room.roomId).catch(()=>{});
    });
  });
},60*1000);

// ─── FIXED CARDS ─────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return((t^t>>>14)>>>0)/4294967296; };
}
function generateFixedCard(idx) {
  const rng=seededRandom(idx*7919), ranges=[[1,15],[16,30],[31,45],[46,60],[61,75]], nums=Array(25).fill(0);
  for(let col=0;col<5;col++){
    const[lo,hi]=ranges[col], pool=Array.from({length:hi-lo+1},(_,i)=>lo+i), picked=[];
    for(let i=0;i<5;i++){const j=Math.floor(rng()*pool.length);picked.push(pool.splice(j,1)[0]);}
    picked.sort((a,b)=>a-b);
    for(let row=0;row<5;row++){const ci=row*5+col; nums[ci]=ci===12?0:picked[row];}
  }
  return nums;
}
const CARD_POOL=[];
for(let i=1;i<=TOTAL_CARDS;i++) CARD_POOL.push({id:i,numbers:generateFixedCard(i)});
const getCard=id=>CARD_POOL.find(c=>c.id===id);
const getCardPoolForRoom=room=>CARD_POOL.slice(0,Math.min(TOTAL_CARDS,Number(room?.cardLimit)||TOTAL_CARDS));

// ─── WIN CHECK ───────────────────────────────────────────────
function checkWin(nums, called, marked) {
  const cs=new Set(called), ms=new Set(marked||[]); ms.add(12);
  const hit=i=>i===12||(cs.has(nums[i])&&ms.has(i));
  return [[0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
          [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
          [0,6,12,18,24],[4,8,12,16,20],[0,4,20,24]].some(p=>p.every(i=>hit(i)));
}

// ─── STATE ───────────────────────────────────────────────────
const clients={}, rooms={}, userCache={};

// ─── USER HELPERS ────────────────────────────────────────────
const round2=v=>Math.round((Number(v)||0)*100)/100;
function walletsFromRow(r){
  const n=v=>{const x=Number.parseFloat(v);return Number.isFinite(x)&&x>0?x:0;};
  return {main:n(r.main_balance),play:n(r.play_balance),bonus:n(r.bonus_balance)};
}
// Wallets the stake funding policy may charge, in order (read once from the database; refreshed with the stakes).
// place_stake() only counts these wallets, so a wallet that is not in the list cannot pay for a cartela.
let FUNDING_WALLETS=['main','play','bonus'];
async function loadFundingWallets(){
  if(!bingoDb||typeof bingoDb.getBingoFundingWallets!=='function') return false;
  try{
    const list=(await bingoDb.getBingoFundingWallets()).filter(x=>['main','play','bonus'].includes(x));
    if(!list.length){ console.warn('⚠️ the stake funding policy lists no wallets - keeping the default'); return false; }
    FUNDING_WALLETS=list;
    console.log('✅ Stakes are paid from:',list.join(' -> '));
    return true;
  }catch(e){ console.error('loadFundingWallets:',e.message); return false; }
}
// balance   = main + play   (the amount shown in the header)
// spendable = the wallets the funding policy can charge (fast local check before picking cartelas;
//             the database makes the final call)
function applyWallets(target,w){
  target.wallets={main:round2(w.main),play:round2(w.play),bonus:round2(w.bonus)};
  target.balance=round2(w.main+w.play);
  target.spendable=round2(FUNDING_WALLETS.reduce((t,k)=>t+(Number(w[k])||0),0));
}

async function loadUser(tid,retries=6,delayMs=500) {
  const id=String(tid||'').trim();
  if(!/^\d+$/.test(id) || Number(id)<=0) return null;

  // ── Real wallets (db.js) ──
  {
    for(let attempt=1;attempt<=retries;attempt++){
      try{
        const r=await bingoDb.getUserWalletBalances(id);
        if(!r) return null;                      // genuinely not registered
        const prev=userCache[id]||{};
        const u={
          userId:Number(r.user_id), name:r.name||''
        };
        applyWallets(u,walletsFromRow(r));
        // blocked / inactive flags are looked up once per user, not on every refresh
        if(prev.flagsChecked&&Date.now()-(prev.flagsAt||0)<120000){
          u.flagsChecked=true; u.flagsAt=prev.flagsAt; u.blocked=prev.blocked===true; u.inactive=prev.inactive===true;
        }else{
          try{
            const f=await bingoDb.getBingoUserFlags(id);
            if(f){ u.blocked=f.is_blocked===true; u.inactive=f.is_active===false; }
          }catch(e){ console.error('getBingoUserFlags:',e.message); }
          u.flagsChecked=true; u.flagsAt=Date.now();
        }
        userCache[id]=u;
        return u;
      }catch(e){
        console.error(`loadUser attempt ${attempt}/${retries}:`,e.message);
        if(attempt<retries) await new Promise(r=>setTimeout(r,delayMs*Math.min(attempt,3)));
      }
    }
    return userCache[id]||null;
  }

  return userCache[id]||null;
}

// copy a loaded user onto a live connection
function applyUserToClient(client,u){
  if(!client||!u) return;
  if(u.wallets){ client.wallets=u.wallets; client.spendable=u.spendable; }
  client.balance=Number.isFinite(Number(u.balance))?Number(u.balance):0;
  if(u.userId) client.userId=u.userId;
  client.playerName=u.name||client.playerName;  
}

async function refreshClientBalance(client){
  if(!client?.telegramId) return Number.isFinite(Number(client?.balance));
  try{
    const u=await loadUser(String(client.telegramId),1,0);
    if(!u) return false;
    applyUserToClient(client,u);
    return true;
  }catch(e){
    console.error('refreshClientBalance:',e.message);
    return false;
  }
}

// Reload a player's wallets once and push them to the app (after a round starts / ends).
async function pushWallets(p){
  const tid=String(p?.telegramId||'');
  if(!tid) return;
  const u=await loadUser(tid,1,0);
  if(!u) return;
  const cl=clients[p.playerId];
  if(cl) applyUserToClient(cl,u);
  send(p.ws||cl?.ws,{type:'balanceUpdate',balance:u.balance,wallets:u.wallets});
}
// run an async function over a list with a small concurrency limit (protects the DB pool)
async function forEachLimit(items,limit,fn){
  let i=0;
  const workers=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(i<items.length){ const item=items[i++]; try{ await fn(item); }catch(e){ console.error('forEachLimit:',e.message); } }
  });
  await Promise.all(workers);
}

// ─── ROOM HELPERS ────────────────────────────────────────────
function getOrCreateRoom(sid){
  // One room per stake: a room that is starting, playing or in its post-game pause is reused, never shadowed by a
  // second "waiting" room (the lobby would show that empty room's 1 player instead of the real game's players).
  const all=Object.values(rooms).filter(r=>r.stakeId===sid);
  let r=all.find(r=>r.status==='waiting'||r.status==='countdown')||all[0];
  if(r) return r;
  const s=STAKES.find(s=>s.id===sid), roomId=uuidv4();
  r={roomId,stakeId:sid,stake:s.amount,maxPlayers:s.maxPlayers,cardLimit:s.cardLimit,
     group:s.group||sid,dbStakeId:s.dbStakeId||null,dbRoomId:s.dbRoomId||null,minPlayers:s.minPlayers||2,maxCards:s.maxCards||4,selectionSeconds:s.selectionSeconds||0,commissionRate:Number.isFinite(s.commissionRate)?s.commissionRate:null,
     status:'waiting',players:[],calledNumbers:[],
     availableNumbers:Array.from({length:75},(_,i)=>i+1),callTimer:null,countdownTimer:null,claimEvalTimer:null,
     countdownLeft:Math.ceil((s.selectionSeconds?s.selectionSeconds*1000:LOBBY_WAIT_MS)/1000),claimWindowOpen:false,claimedThisRound:[],resetCountdownTimer:null,resetTimer:null,
     takenCardIds:new Set(),pot:0,grossPot:0,dbGameId:null,dbGameCode:null,participantCards:null,startFailures:0,fair:newFairness()};
  rooms[roomId]=r; return r;
}
// ---- player-facing texts: the server writes them in Amharic; a player whose page is in English (the page sends
// its language with every message) gets the English version, and the English-only text goes to Amharic players. ----
const EN_TEXT=[
  [/^መለያዎ አልተገኘም። እባክዎ በቦቱ ይመዝገቡ።$/,()=>'Your account was not found. Please register in the bot.'],
  [/^በቂ ቀሪ ሂሳብ የለዎትም። ለ(\d+) ካርድ\(ዎች\) (\d+) ብር ያስፈልጋል።$/,(m)=>`Not enough balance. ${m[2]} ETB needed for ${m[1]} cartela(s).`],
  [/^በቂ ቀሪ ሂሳብ የለዎትም። (\d+) ብር ያስፈልጋል።$/,(m)=>`Not enough balance. ${m[1]} ETB needed.`],
  [/^መለያዎ ለጊዜው ተዘግቷል። እባክዎ ድጋፍን ያነጋግሩ።$/,()=>'Your account is temporarily closed. Please contact support.'],
  [/^የቦነስ ሂሳብዎ ላይ ችግር ስላለ በዚህ ዙር መሳተፍ አልተቻለም። እባክዎ ድጋፍን ያነጋግሩ።/,()=>'There is a problem with your bonus balance, so you cannot join this round. Please contact support. (BONUS)'],
  [/^ጨዋታውን ለመጀመር ቢያንስ 2 የተለያዩ ተጫዋቾች ያስፈልጋሉ።/,()=>'At least 2 different players are needed to start the game. (MIN_PLAYERS)'],
  [/^የክፍሉ ማዋቀር አልተጠናቀቀም። እባክዎ አስተዳዳሪን ያነጋግሩ።/,()=>'This room is not fully set up. Please contact the administrator. (SETUP)'],
  [/^ለዚህ ክፍል ያልተጠናቀቀ የቀድሞ ጨዋታ አለ። እባክዎ ትንሽ ቆይተው ይሞክሩ።/,()=>'An earlier game in this room is not finished yet. Please try again shortly. (STUCK_GAME)'],
  [/^የቦነስ ሂሳብ ችግር አለ። እባክዎ አስተዳዳሪን ያነጋግሩ።/,()=>'There is a bonus balance problem. Please contact the administrator. (BONUS)'],
  [/^አንዳንድ ተጫዋቾች በቂ ቀሪ ሂሳብ የላቸውም።/,()=>'Some players do not have enough balance. (BALANCE)'],
  [/^ካርቴላ አልተመረጠም።/,()=>'No cartela was selected. (NO_CARTELAS)'],
  [/^ጨዋታው መጀመር አልተቻለም። እባክዎ እንደገና ይሞክሩ።/,()=>'The game could not start. Please try again. (UNKNOWN)'],
  [/^🚫 የተሳሳተ BINGO ጥያቄ — ከጨዋታው ተሰርዘዋል!$/,()=>'🚫 Invalid BINGO claim — you are disqualified from this round!'],
  [/^የተሳሳተ የውርርድ መጠን።$/,()=>'Invalid stake amount.'],
  [/^ይህ ክፍል ሙሉ ነው። ከፍተኛው ተጫዋቾች: (\d+)$/,(m)=>`This room is full. Maximum players: ${m[1]}`],
  [/^ጨዋታው ቀድሞውኑ ተጀምሯል።$/,()=>'The game has already started.'],
  [/^በዚህ ክፍል እስከ (\d+) ካርቴላ ብቻ መምረጥ ይቻላል።$/,(m)=>`You can pick at most ${m[1]} cartelas in this room.`],
  [/^ይህ ካርቴላ ቀድሞውኑ ተመርጧል!$/,()=>'This cartela is already taken!'],
  [/^ጊዜው አልፏል!$/,()=>'Too late!'],
  [/^ካርቴላ (\d+) አልተቀበለም — በቂ ቀሪ ሂሳብ የለም።$/,(m)=>`Cartela ${m[1]} was not accepted — not enough balance.`],
  [/^በዚህ ክፍል የሚፈቀደው የካርቴላ ብዛት አልፏል።$/,()=>'You have reached the cartela limit for this room.'],
  [/^ካርቴላ (\d+) አልተቀበለም።$/,(m)=>`Cartela ${m[1]} was not accepted.`]
];
const AM_TEXT=[[/^Your account is inactive: you can watch games but cannot play\. Please contact support\.$/,()=>'መለያዎ ንቁ አይደለም፦ ጨዋታዎችን መመልከት ብቻ ይችላሉ። እባክዎ ድጋፍን ያነጋግሩ።']];
function localizeMsg(ws,msg){
  if(!msg||typeof msg.message!=='string'||!['error','disqualified','claimTooLate'].includes(msg.type)) return msg;
  const table=ws&&ws._lang==='en'?EN_TEXT:AM_TEXT;
  for(const [re,fn] of table){ const m=msg.message.match(re); if(m) return {...msg,message:fn(m)}; }
  return msg;
}
const send=(ws,msg)=>{
  if(!ws||ws.readyState!==WebSocket.OPEN) return;
  msg=localizeMsg(ws,msg);
  // every message about a running game carries the game code returned by createBingoGame (shown as "Game ID")
  if(msg&&msg.roomId&&msg.gameId===undefined){ const r=rooms[msg.roomId]; if(r&&r.dbGameCode) msg={...msg,gameId:r.dbGameCode}; }
  if(msg&&msg.roomId&&COMMIT_TYPES.has(msg.type)&&msg.commitment===undefined){ const r=rooms[msg.roomId]; if(r&&r.fair) msg={...msg,commitment:r.fair.commitment}; }
  if(msg&&msg.roomId&&COMMIT_TYPES.has(msg.type)&&msg.commissionRate===undefined){ const r=rooms[msg.roomId]; if(r&&r.commissionRate!=null) msg={...msg,commissionRate:r.commissionRate}; }
  ws.send(JSON.stringify(msg));
};
// A player can be in SEVERAL rooms at once (one per stake: 5 / 10 / 20 = up to 3 games at a time).
// Every room message carries roomId + stakeId so the app can handle each game separately.
const sendRoom=(room,ws,msg)=>send(ws,{roomId:room.roomId,stakeId:room.stakeId,...msg});
// How long a player who lost his connection before the round starts keeps his seat and cartelas.
// (A page "Refresh" closes and re-opens the connection; the player must not lose his picks.)
const DISCONNECT_GRACE_MS = 20000;
// A room still waiting for a second player must not be held forever by a player who left for good:
// his picks are released after this long without any connection (a countdown / round never waits for him).
const ABSENT_RELEASE_MS = 30*60*1000;

// ── One account = one player, on any number of devices ───────────────────────
// A player's `ws` is a small multiplexer that holds every open connection (device) of that account,
// so every message sent to the player reaches all of his devices and they always show the same state.
function makeMux(initial){
  const socks=new Set(initial||[]);
  return {
    sockets:socks,
    get readyState(){ for(const x of socks) if(x&&x.readyState===1) return 1; return 3; },
    send(data){ for(const x of socks){ if(x&&x.readyState===1){ try{ x.send(data); }catch(e){} } } }
  };
}
function attachSocket(p,ws){ p.absentSince=0; if(p.graceTimer){ clearTimeout(p.graceTimer); p.graceTimer=null; } if(!p.ws||!p.ws.sockets) p.ws=makeMux(p.ws?[p.ws]:[]); p.ws.sockets.add(ws); }
function detachSocket(p,ws){ if(p&&p.ws&&p.ws.sockets) p.ws.sockets.delete(ws); }
function openSockets(p){ return (p&&p.ws&&p.ws.sockets)?[...p.ws.sockets].filter(x=>x&&x.readyState===1):[]; }
// the room player that belongs to this connection: same connection id, else same Telegram account
function playerOf(room,client){
  if(!room||!client) return null;
  let p=room.players.find(x=>x.playerId===client.playerId);
  if(!p&&client.telegramId) p=room.players.find(x=>String(x.telegramId||'')===String(client.telegramId));
  return p||null;
}
// everything a device needs to show the player's current cartelas
function selectionPayload(p){
  const num=id=>{const c=id?getCard(id):null;return c?c.numbers:[];};
  return {cardId:p.cardId||null,cardNumbers:num(p.cardId),cardId2:p.cardId2||null,cardNumbers2:num(p.cardId2),
          cardId3:p.cardId3||null,cardNumbers3:num(p.cardId3),cardId4:p.cardId4||null,cardNumbers4:num(p.cardId4)};
}

function clientRooms(client){
  if(!client.rooms) client.rooms=new Set();
  return Array.from(client.rooms).map(id=>rooms[id]).filter(Boolean);
}
// the room a message is about: msg.roomId if the client belongs to it, else the room it is viewing
function roomForMsg(client,msg){
  const id=(msg&&msg.roomId&&client.rooms&&client.rooms.has(msg.roomId))?msg.roomId:client.roomId;
  return id?rooms[id]:null;
}
// money already reserved by this client's card picks in OTHER rooms that have not started yet
function reservedElsewhere(client,room){
  return clientRooms(client).reduce((sum,r)=>{
    if(r.roomId===room.roomId||(r.status!=='waiting'&&r.status!=='countdown')) return sum;
    const pl=playerOf(r,client);
    return sum+(pl?Number(r.stake)*getPlayerCardCount(pl):0);
  },0);
}
// re-link every room entry of a Telegram account to this connection (after a reload / reconnect)
function relinkAllRooms(client,ws,tid){
  if(!tid) return;
  if(!client.rooms) client.rooms=new Set();
  Object.values(rooms).forEach(r=>{
    r.players.forEach(pl=>{
      if(String(pl.telegramId||'')!==String(tid)) return;
      attachSocket(pl,ws);                 // this device joins the same player (other devices keep working)
      pl.playerId=client.playerId;         // the newest device is the primary one
      client.rooms.add(r.roomId);
    });
  });
}
const broadcast=(room,msg)=>{const s=JSON.stringify({roomId:room.roomId,stakeId:room.stakeId,gameId:room.dbGameCode||undefined,...(COMMIT_TYPES.has(msg.type)&&room.fair?{commitment:room.fair.commitment}:{}),...(COMMIT_TYPES.has(msg.type)&&room.commissionRate!=null?{commissionRate:room.commissionRate}:{}),...msg});room.players.forEach(p=>{if(p.ws&&p.ws.readyState===WebSocket.OPEN)p.ws.send(s);});};
// Lobby payload: one entry per stake (amount); a stake with several rooms lists them in `rooms`.
function liveRoomOf(sid){
  const all=Object.values(rooms).filter(r=>r.stakeId===sid);
  return all.find(r=>r.status==='waiting'||r.status==='countdown')||all[0]||null;
}
// Players counted in the lobby: before the start = users holding at least one cartela (2-4 cartelas still count once);
// once the round runs = the users taking part in it. Never above the room's max_players.
function roomHeadcount(r,max){
  if(!r) return 0;
  const n=(r.status==='waiting'||r.status==='countdown')?r.players.filter(p=>getPlayerCardCount(p)>0).length:livePlayerCount(r);
  return max>0?Math.min(n,max):n;
}
// everybody connected to the server right now (one person with several tabs / devices counts once)
function onlineCount(){
  const ids=new Set();
  for(const c of Object.values(clients)){ if(c.ws&&c.ws.readyState===WebSocket.OPEN) ids.add(c.telegramId?'t'+c.telegramId:'p'+c.playerId); }
  return ids.size;
}
function buildLobbyStakes(){
  const groups=new Map();
  for(const s of STAKES){ const g=s.group||s.id; if(!groups.has(g)) groups.set(g,[]); groups.get(g).push(s); }
  return [...groups.values()].map(list=>{
    const rs=list.map(s=>{ const r=liveRoomOf(s.id);
      const pc=roomHeadcount(r,s.maxPlayers), st=r?r.status:'waiting';
      return{stakeId:s.id,roomId:s.dbRoomId,name:s.roomName||'',amount:s.amount,maxPlayers:s.maxPlayers,minPlayers:s.minPlayers||2,maxCards:s.maxCards||4,
        playerCount:pc,status:st,countdown:r&&st==='countdown'?r.countdownLeft:0,pot:r?(r.pot||0):0,called:r&&r.calledNumbers?r.calledNumbers.length:0,full:pc>=s.maxPlayers};});
    const f=rs[0], cd=rs.filter(x=>x.status==='countdown');
    return{stakeId:f.stakeId,amount:f.amount,maxPlayers:rs.reduce((a,x)=>a+x.maxPlayers,0),maxCards:f.maxCards,showRoomPage:list[0].showRoomPage===true,
      playerCount:rs.reduce((a,x)=>a+x.playerCount,0),
      status:cd.length?'countdown':(rs.some(x=>x.status==='waiting')?'waiting':f.status),
      countdown:cd.length?Math.min(...cd.map(x=>x.countdown)):0,
      rooms:rs};
  });
}
function broadcastLobby(){
  // Debounced: many joins/leaves happening in quick succession (busy lobby with
  // hundreds of players) will collapse into a single broadcast every 250ms,
  // instead of one full broadcast-to-everyone per event.
  if(broadcastLobby._pending) return;
  broadcastLobby._pending=true;
  setTimeout(()=>{
    broadcastLobby._pending=false;
    const payload=buildLobbyStakes(), online=onlineCount();
    Object.values(clients).forEach(c=>{
      if(!c.ws||c.ws.readyState!==WebSocket.OPEN) return;
      // stakes where this player has a game running (shown as "In game" in the lobby)
      const joined=clientRooms(c).filter(r=>{ const pl=playerOf(r,c); return pl&&(getPlayerCardCount(pl)>0||pl.hasPaid)&&['waiting','countdown','starting','playing'].includes(r.status); }).map(r=>r.stakeId);
      c.ws.send(JSON.stringify({type:'lobbyUpdate',stakes:payload,joined,online}));
    });
  },250);
}
function getPlayerCardIds(p){
  return [p.cardId,p.cardId2,p.cardId3,p.cardId4].filter(Boolean);
}
function getPlayerCardCount(p){ return getPlayerCardIds(p).length; }
function getCardField(slot){ return slot===1?'cardId':slot===2?'cardId2':slot===3?'cardId3':'cardId4'; }
function getNumbersField(slot){ return slot===1?'cardNumbers':slot===2?'cardNumbers2':slot===3?'cardNumbers3':'cardNumbers4'; }

function broadcastCardPool(room){
  // Send only the FULL pool once when needed (e.g. on join); for live picks use broadcastCardDiff instead.
  const base=getCardPoolForRoom(room).map(c=>({id:c.id,taken:room.takenCardIds.has(c.id)}));
  const cardCount=room.players.reduce((sum,p)=>sum+getPlayerCardCount(p),0);
  room.players.forEach(p=>send(p.ws,{roomId:room.roomId,stakeId:room.stakeId,type:'cardPoolUpdate',pool:base.map(c=>({...c,takenByMe:getPlayerCardIds(p).includes(c.id)})),playerCount:cardCount,stakeAmount:room.stake}));
}
// The full pool for ONE connection (a player joining or re-linking). Sending it to everybody here made every
// reconnect cost the whole room a 400-600 card message: after a round all N clients reconnect, i.e. N x N pool messages.
function sendCardPoolTo(room,p,ws){
  const base=getCardPoolForRoom(room).map(c=>({id:c.id,taken:room.takenCardIds.has(c.id)}));
  const mine=new Set(getPlayerCardIds(p));
  const cardCount=room.players.reduce((sum,x)=>sum+getPlayerCardCount(x),0);
  send(ws,{roomId:room.roomId,stakeId:room.stakeId,type:'cardPoolUpdate',pool:base.map(c=>({...c,takenByMe:mine.has(c.id)})),playerCount:cardCount,stakeAmount:room.stake});
}
// Lightweight update: tell everyone in the room only WHICH card(s) changed state,
// instead of re-sending the entire 400-card array on every single pick.
// This is the #1 fix for handling 400 concurrent players smoothly.
function broadcastCardDiff(room, changedCardIds){
  const cardCount=room.players.reduce((sum,p)=>sum+getPlayerCardCount(p),0);
  const changes=changedCardIds.map(id=>({id,taken:room.takenCardIds.has(id)}));
  room.players.forEach(p=>send(p.ws,{
    roomId:room.roomId,stakeId:room.stakeId,
    type:'cardPoolDiff',
    changes:changes.map(c=>({...c,takenByMe:getPlayerCardIds(p).includes(c.id)})),
    playerCount:cardCount,
    stakeAmount:room.stake
  }));
}

// ─── GAME LIFECYCLE ──────────────────────────────────────────
function startCountdown(room){
  room.status='countdown'; room.countdownLeft=Math.ceil((room.selectionSeconds?room.selectionSeconds*1000:LOBBY_WAIT_MS)/1000);
  room.countdownTimer=setInterval(()=>{
    room.countdownLeft--;
    const ready=room.players.filter(p=>getPlayerCardCount(p)>0).length;
    if(ready<(room.minPlayers||2)){clearInterval(room.countdownTimer);room.status='waiting';broadcast(room,{type:'waitingForPlayers'});broadcastLobby();return;}
    broadcast(room,{type:'countdown',seconds:room.countdownLeft});
    if(room.countdownLeft<=0){clearInterval(room.countdownTimer);startGame(room).catch(e=>{ console.error('startGame crashed:',e&&e.stack||e); failStart(room,'internal error: '+(e&&e.message)); });}
  },1000);
}

// ── Round start with db.js ──────────────────────────────────────
// createBingoGame() validates the room + stake, charges EVERY cartela from the player's wallets
// (play / main / bonus, in the order the funding policy says), creates the game and returns the
// prize pool. It is one database transaction: either the whole game is created or nothing is charged.
function releasePlayerCards(room,p){
  getPlayerCardIds(p).forEach(id=>room.takenCardIds.delete(id));
  p.cardId=null; p.cardId2=null; p.cardId3=null; p.cardId4=null; p.hasPaid=false;
}
async function collectDbEntries(room){
  const entries=[];
  for(const p of room.players){
    if(getPlayerCardCount(p)===0) continue;
    if(!p.userId){
      const u=await loadUser(p.telegramId,2,200);
      p.userId=u?.userId||null;
    }
    if(!p.userId){                                  // not registered: cannot play
      sendRoom(room,p.ws,{type:'error',message:'መለያዎ አልተገኘም። እባክዎ በቦቱ ይመዝገቡ።'});
      releasePlayerCards(room,p);
      continue;
    }
    [1,2,3,4].forEach(slot=>{
      const id=p[getCardField(slot)];
      if(id) entries.push({p,slot,cardId:id,userId:p.userId});
    });
  }
  return entries;
}
// After a failed attempt: find players who cannot afford their cartelas, release their cards.
async function dropUnaffordablePlayers(room){
  let dropped=false;
  await forEachLimit(room.players.filter(p=>getPlayerCardCount(p)>0),10,async p=>{
    const u=await loadUser(p.telegramId,1,0);
    if(!u) return;
    const need=room.stake*getPlayerCardCount(p);
    if(Number(u.spendable)<need){
      releasePlayerCards(room,p);
      sendRoom(room,p.ws,{type:'error',message:`በቂ ቀሪ ሂሳብ የለዎትም። ${need} ብር ያስፈልጋል።`});
      dropped=true;
    }
  });
  if(dropped) broadcastCardPool(room);
  return dropped;
}
// Players the database would refuse (blocked / deactivated account): release their cartelas so they do not
// hold the room's countdown, and tell them why. Run on a failed start, with fresh flags.
async function dropIneligiblePlayers(room){
  let dropped=false;
  await forEachLimit(room.players.filter(p=>getPlayerCardCount(p)>0),10,async p=>{
    let f=null; try{ f=await bingoDb.getBingoUserFlags(String(p.telegramId)); }catch(e){ return; }
    if(!f||!(f.is_blocked===true||f.is_active===false)) return;
    console.warn(`player ${p.telegramId} is ${f.is_blocked===true?'blocked':'inactive'}: removed from the round`);
    const u=userCache[String(p.telegramId)]; if(u){ u.blocked=f.is_blocked===true; u.inactive=f.is_active===false; u.flagsAt=Date.now(); }
    releasePlayerCards(room,p);
    sendRoom(room,p.ws,{type:'error',message:'መለያዎ ለጊዜው ተዘግቷል። እባክዎ ድጋፍን ያነጋግሩ።'});
    dropped=true;
  });
  if(dropped) broadcastCardPool(room);
  return dropped;
}
// Short, friendly reason + code for players.
function startFailureInfo(reason){
  const r=String(reason||'');
  if(/at least \d+ players|players are required|minimum.*players|min.*players/i.test(r))
    return {code:'MIN_PLAYERS',text:'ጨዋታውን ለመጀመር ቢያንስ 2 የተለያዩ ተጫዋቾች ያስፈልጋሉ።'};
  if(/room.*(not found|not active)|stake.*(not active|not exist|not available)|game system|funding policy|commission rule|ids are missing|configuration/i.test(r))
    return {code:'SETUP',text:'የክፍሉ ማዋቀር አልተጠናቀቀም። እባክዎ አስተዳዳሪን ያነጋግሩ።'};
  if(/uq_bingo_games_active_room_stake|active game/i.test(r))
    return {code:'STUCK_GAME',text:'ለዚህ ክፍል ያልተጠናቀቀ የቀድሞ ጨዋታ አለ። እባክዎ ትንሽ ቆይተው ይሞክሩ።'};
  if(/bonus consumption mismatch/i.test(r))
    return {code:'BONUS',text:'የቦነስ ሂሳብ ችግር አለ። እባክዎ አስተዳዳሪን ያነጋግሩ።'};
  if(/insufficient|balance/i.test(r))
    return {code:'BALANCE',text:'አንዳንድ ተጫዋቾች በቂ ቀሪ ሂሳብ የላቸውም።'};
  if(/no cartelas/i.test(r))
    return {code:'NO_CARTELAS',text:'ካርቴላ አልተመረጠም።'};
  return {code:'UNKNOWN',text:'ጨዋታው መጀመር አልተቻለም። እባክዎ እንደገና ይሞክሩ።'};
}
// A player whose Bonus wallet is not covered by active bonus awards would make place_stake() raise
// "Bonus consumption mismatch" and block the round for EVERYONE. Take only those players out.
async function dropBonusMismatchPlayers(room){
  if(typeof bingoDb.getBingoBonusStatus!=='function') return false;
  const players=room.players.filter(p=>getPlayerCardCount(p)>0&&p.userId);
  if(!players.length) return false;
  let rows;
  try{ rows=await bingoDb.getBingoBonusStatus(players.map(p=>p.userId)); }
  catch(e){ console.error('getBingoBonusStatus:',e.message); return false; }
  const bad=new Set(rows.filter(r=>Number(r.bonus_balance)-Number(r.usable)>0.009).map(r=>Number(r.user_id)));
  if(!bad.size) return false;
  for(const p of players){
    if(!bad.has(Number(p.userId))) continue;
    const r=rows.find(x=>Number(x.user_id)===Number(p.userId));
    console.error(`⚠️ user ${p.userId}: Bonus wallet ${r.bonus_balance} is not covered by active bonuses (${r.usable}); removed from the round`);
    releasePlayerCards(room,p);
    sendRoom(room,p.ws,{type:'error',message:'የቦነስ ሂሳብዎ ላይ ችግር ስላለ በዚህ ዙር መሳተፍ አልተቻለም። እባክዎ ድጋፍን ያነጋግሩ። (BONUS)'});
  }
  broadcastCardPool(room);
  return true;
}
function failStart(room,reason){
  console.error(`⚠️ Round could not start (${room.stakeId}): ${reason}`);
  room.status='waiting';
  room.startFailures=(room.startFailures||0)+1;
  room.lastStartError=String(reason||'');
  const info=startFailureInfo(reason);
  room.players.forEach(p=>{
    sendRoom(room,p.ws,{type:'error',message:`${info.text} (${info.code})`});
  });
  broadcast(room,{type:'waitingForPlayers'});
  broadcastCardPool(room);
  broadcastLobby();
  // Try again if enough players still hold cards (at most 3 automatic retries)
  const ready=room.players.filter(p=>getPlayerCardCount(p)>0).length;
  if(ready>=(room.minPlayers||2)&&room.startFailures<3){
    setTimeout(()=>{ if(rooms[room.roomId]&&room.status==='waiting') startCountdown(room); },3000);
  }
  return false;
}
// ── Orphaned games ──────────────────────────────────────────────────────────
// A game is created as "selection" and only end_bingo_game() closes it. If this server restarted in the
// middle of a round, the round is lost from memory but the game stays open in the database, and the unique
// index uq_bingo_games_active_room_stake then refuses every new game for that room + stake.
// Open games that no room of THIS server owns are cancelled with a full refund (cancel_bingo_game).
function ownedGameIds(){
  const ids=new Set();
  Object.values(rooms).forEach(r=>{ if(r.dbGameId) ids.add(Number(r.dbGameId)); });
  return ids;
}
async function recoverOrphanedGames({roomId=null,stakeId=null,minAgeSec=0,reason='orphaned_game'}={}){
  if(!bingoDb||typeof bingoDb.getUnfinishedBingoGames!=='function'||typeof bingoDb.cancelBingoGame!=='function') return 0;
  let games;
  try{ games=await bingoDb.getUnfinishedBingoGames(roomId,stakeId); }
  catch(e){ console.error('getUnfinishedBingoGames:',e.message); return 0; }
  const owned=ownedGameIds();
  let cancelled=0;
  for(const g of games){
    if(owned.has(Number(g.id))) continue;                 // a round of this server is still running it
    if(g.winners>0){ console.warn(`⚠️ Game ${g.game_code} has winners but is still open: finish it with end_bingo_game(), it is not cancelled automatically.`); continue; }
    if(g.age_seconds<minAgeSec) continue;                 // too young: it may belong to another instance during a deploy
    try{
      const r=await bingoDb.cancelBingoGame(g.id,reason);
      console.warn(`🧹 Cancelled unfinished game ${g.game_code} (${g.status}, ${g.age_seconds}s old, ${reason}): refunded ${r&&r.refunded_cards} cartela(s), ${r&&r.refunded_total} ETB`);
      cancelled++;
    }catch(e){
      console.error(`cancel_bingo_game(${g.id}) failed:`,e.message,e.message&&/cancel_bingo_game/.test(e.message)?'- install cancel_bingo_game.sql in the database':'');
    }
  }
  return cancelled;
}

async function startDbGame(room){
  for(let attempt=1;attempt<=3;attempt++){
    const entries=await collectDbEntries(room);
    if(!entries.length) return failStart(room,'no cartelas selected');
    if(new Set(entries.map(e=>e.userId)).size<(room.minPlayers||2)) return failStart(room,'at least '+(room.minPlayers||2)+' players are required');
    if(!room.dbRoomId||!room.dbStakeId) return failStart(room,'room/stake ids are missing (stakes not loaded from the database)');

    let result;
    try{
      result=await bingoDb.createBingoGame(
        room.dbRoomId,
        room.dbStakeId,
        entries.map(e=>({user_id:e.userId,card_id:e.cardId,card_data:{numbers:(getCard(e.cardId)||{}).numbers||[],slot:e.slot}}))
      );
    }catch(e){
      console.error(`createBingoGame failed (attempt ${attempt}):`,e.message);
      if(/is_banned/.test(e.message)) console.error('DATABASE FIX NEEDED: create_bingo_game_from_selections reads users.is_banned but the column does not exist. Run: ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false;');
      // an older game of this room + stake was never closed: cancel it (refunding its players) and try again
      if(/uq_bingo_games_active_room_stake/i.test(e.message) && attempt<3){
        const n=await recoverOrphanedGames({roomId:room.dbRoomId,stakeId:room.dbStakeId,minAgeSec:120,reason:'orphaned_game'});
        if(n>0) continue;
      }
      // retry without the players who cannot pay / whose bonus is inconsistent (up to 2 retries)
      if(attempt<3 && ((await dropBonusMismatchPlayers(room)) || (await dropUnaffordablePlayers(room)) || (await dropIneligiblePlayers(room)))) continue;
      return failStart(room,e.message);
    }

    // Keep exactly the cartelas the database accepted (and charged).
    const accepted=new Set((result.accepted||[]).map(a=>`${a.user_id}:${a.card_id}`));
    for(const e of entries){
      if(accepted.has(`${e.userId}:${e.cardId}`)) continue;
      room.takenCardIds.delete(e.cardId);
      e.p[getCardField(e.slot)]=null;
      const rej=(result.rejected||[]).find(r=>Number(r.user_id)===e.userId&&Number(r.card_id)===e.cardId);
      const why=rej&&rej.reason;
      const text=why==='insufficient_balance'?`ካርቴላ ${e.cardId} አልተቀበለም — በቂ ቀሪ ሂሳብ የለም።`
        :(why==='user_blocked'||why==='user_banned'||why==='user_inactive')?'መለያዎ ለጊዜው ተዘግቷል። እባክዎ ድጋፍን ያነጋግሩ።'
        :why==='max_cards_per_player_reached'?`በዚህ ክፍል የሚፈቀደው የካርቴላ ብዛት አልፏል።`
        :`ካርቴላ ${e.cardId} አልተቀበለም።`;
      console.warn(`cartela ${e.cardId} of user ${e.userId} refused by the database: ${why||'not accepted'}`);
      sendRoom(room,e.p.ws,{type:'error',message:text});
    }
    room.players.forEach(p=>{ p.hasPaid=getPlayerCardCount(p)>0; });

    room.pot=Number(result.prize_pool)||0;          // the prize pool the DATABASE calculated (after commission)
    room.grossPot=Number(result.gross_pot)||0;
    room.dbGameId=Number(result.game_id)||null;
    room.dbGameCode=result.game_code||null;
    room.startFailures=0;
    console.log(`🎮 Game ${room.dbGameCode||room.dbGameId} created (${room.stakeId}): ${result.total_participants} players, ${result.total_cards} cartelas, gross ${result.gross_pot}, prize ${result.prize_pool}`);

    // Everyone's wallets changed: reload them once and push them to the apps.
    forEachLimit(room.players.filter(p=>p.hasPaid),10,pushWallets).catch(()=>{});
    return true;
  }
  return false;
}

async function startGame(room){
  // Lock the room before the first await so no new card reservations can race
  // with the final financial commit. Card selection itself is always memory-only.
  room.status='starting';

  {
    const ok=await startDbGame(room);
    if(!ok) return;
  }

  // store the commitment + order + salt (write-once); a failure never stops the round but is logged loudly
  if(room.fair&&room.dbGameId){
    let saved=false;
    for(let a=1;a<=3&&!saved;a++){
      try{ saved=await bingoDb.saveBingoFairness(room.dbGameId,room.fair.commitment,room.fair.order,room.fair.salt); }
      catch(e){ console.error(`saveBingoFairness failed (attempt ${a}/3) game ${room.dbGameCode}:`,e.message,/fairness|column/i.test(e.message)?'- run fairness.sql':''); await new Promise(r=>setTimeout(r,300*a)); }
    }
    if(!saved) console.error(`⚠️ fairness data of game ${room.dbGameCode} was NOT stored: /verify will not work for it`);
  }
  room.status='playing';
  room.calledNumbers=[]; room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
  room.claimedThisRound=[]; room.claimWindowOpen=false;

  room.players.forEach(p=>{
    if(getPlayerCardCount(p)>0){
      const card=p.cardId?getCard(p.cardId):null;
      const card2=p.cardId2?getCard(p.cardId2):null;
      sendRoom(room,p.ws,{type:'yourCard',
        cardId:p.cardId,cardNumbers:card?card.numbers:[],
        cardId2:p.cardId2||null,cardNumbers2:card2?card2.numbers:[],
        cardId3:p.cardId3||null,cardNumbers3:p.cardId3?getCard(p.cardId3).numbers:[],
        cardId4:p.cardId4||null,cardNumbers4:p.cardId4?getCard(p.cardId4).numbers:[],
        pot:room.pot,playerCount:livePlayerCount(room),spectator:false});
    }else{
      sendRoom(room,p.ws,{type:'spectating',pot:room.pot,playerCount:room.players.filter(p=>p.hasPaid).length,calledNumbers:room.calledNumbers});
    }
  });

  if(room.dbGameId) bingoDb.markBingoGameStarted(room.dbGameId).catch(e=>console.error('markBingoGameStarted:',e.message));   // bingo_games.started_at
  broadcast(room,{type:'gameStart',firstCallMs:FIRST_CALL_DELAY_MS,pot:room.pot,playerCount:livePlayerCount(room),players:paidPlayerList(room)});
  // The round is running: its picks now belong to the game (kept on the players and in participantCards),
  // so the card-selection board of this room is emptied for everybody at once.
  room.takenCardIds=new Set();
  broadcastCardPool(room);
  broadcastLobby(); scheduleNextCall(room);
}

function scheduleNextCall(room){
  const first=!room.calledNumbers||room.calledNumbers.length===0;
  room.callTimer=setTimeout(()=>callNumber(room),first?FIRST_CALL_DELAY_MS:CALL_INTERVAL_MS);
}

function callNumber(room){
  if(room.status!=='playing') return;

  // FIX 1: Evaluate ALL pending claims BEFORE calling next number.
  // This lets multiple simultaneous winners be detected in the same window.
  if(room.claimedThisRound.length>0){evaluateClaims(room);return;}
  room.claimWindowOpen=false; room.claimedThisRound=[];
  if(room.availableNumbers.length===0){endGame(room,[],null,true);return;}
  // the number comes from the order that was committed to before the round (see newFairness)
  let drawn=room.fair&&room.fair.order[room.calledNumbers.length];
  let idx=drawn?room.availableNumbers.indexOf(drawn):-1;
  if(idx<0){ idx=randomIndex(room.availableNumbers.length); drawn=room.availableNumbers[idx]; console.error(`⚠️ fairness order not usable in room ${room.stakeId}: random draw`); }
  room.availableNumbers.splice(idx,1);
  room.calledNumbers.push(drawn);
  broadcast(room,{type:'numberCalled',number:drawn,calledNumbers:room.calledNumbers,callCount:room.calledNumbers.length,claimWindowMs:CLAIM_WINDOW_MS,pot:room.pot,playerCount:livePlayerCount(room),players:paidPlayerList(room)});
  room.claimWindowOpen=true; scheduleNextCall(room);
  autoClaimForAll(room);
}

// The game is fully automatic: every called number is marked on every cartela.
// The server therefore claims BINGO for any winning player itself. This is what lets a
// player run 2-3 games at the same time: a game he is not looking at (or whose screen is
// closed) is still claimed and paid correctly. Duplicate claims from the app are ignored.
function autoClaimForAll(room){
  if(room.status!=='playing') return;
  room.players.forEach(p=>{
    if(p.disqualified||!p.hasPaid||getPlayerCardCount(p)===0) return;
    if(room.claimedThisRound.find(c=>c.playerId===p.playerId)) return;
    const claim={playerId:p.playerId,markedIndices:[],cardId2:null,markedIndices2:[],cardId3:null,markedIndices3:[],cardId4:null,markedIndices4:[]};
    let wins=false;
    [1,2,3,4].forEach(slot=>{
      const id=p[getCardField(slot)]; if(!id) return;
      const card=getCard(id); if(!card) return;
      const marks=[]; card.numbers.forEach((num,i)=>{ if(i===12||room.calledNumbers.includes(num)) marks.push(i); });
      claim['markedIndices'+(slot===1?'':slot)]=marks;
      if(slot>1) claim['cardId'+slot]=id;
      if(checkWin(card.numbers,room.calledNumbers,marks)) wins=true;
    });
    if(wins) room.claimedThisRound.push(claim);
  });
  if(room.claimedThisRound.length){
    if(room.callTimer) clearTimeout(room.callTimer);
    if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);
    room.claimEvalTimer=setTimeout(()=>evaluateClaims(room),CLAIM_COLLECT_MS);
  }
}

function evaluateClaims(room){
  room.claimEvalTimer=null;
  const winners=[], cheaters=[];
  room.claimedThisRound.forEach(claim=>{
    const p=room.players.find(p=>p.playerId===claim.playerId);
    if(!p||p.disqualified||getPlayerCardCount(p)===0) return;
    const wins=[1,2,3,4].map(slot=>{
      const id=p[getCardField(slot)];
      const card=id?getCard(id):null;
      const marks=claim['markedIndices'+(slot===1?'':slot)]||[];
      return {slot,id,win:!!(card&&checkWin(card.numbers,room.calledNumbers,marks)),marks};
    });
    const winning=wins.find(x=>x.win);
    if(winning){
      p._winningCardId=winning.id;
      p._winningMarkedIndices=Array.from(winning.marks);
      winners.push(p);
    }else cheaters.push(p);
  });

  cheaters.forEach(p=>{
    p.disqualified=true;
    sendRoom(room,p.ws,{type:'disqualified',message:'🚫 የተሳሳተ BINGO ጥያቄ — ከጨዋታው ተሰርዘዋል!'});
  });

  room.claimedThisRound=[]; room.claimWindowOpen=false;

  if(winners.length>0) endGame(room,winners,null,false);
  else scheduleNextCall(room);
}

// Pay the winners with db.js. Returns {winAmount, names, tids} or null if the database call failed.
// end_bingo_game(game, winning CARTELA numbers, numbers called in this round) pays every winner from the prize
// pool in one transaction and stores the called numbers with the game.
async function settleDbGame(room,winners){
  if(!room.dbGameId){ console.error('settleDbGame: this round has no database game id'); return null; }
  const ids=[...new Set(winners.map(w=>Number(w._winningCardId||w.cardId)).filter(n=>Number.isInteger(n)&&n>0))];
  const called=(room.calledNumbers||[]).map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=75);   // snapshot at the moment of the win
  if(!ids.length||!called.length){
    console.error(`CRITICAL: cannot settle game ${room.dbGameCode||room.dbGameId}: winning cartelas ${JSON.stringify(ids)}, called numbers ${called.length}`);
    return null;
  }
  let result=null;
  for(let attempt=1;attempt<=3&&!result;attempt++){
    try{ result=await bingoDb.endBingoGame(room.dbGameId,ids,called); }
    catch(e){
      console.error(`endBingoGame failed (attempt ${attempt}/3) game ${room.dbGameCode||room.dbGameId}:`,e.message);
      if(/already completed|already been settled/i.test(e.message)){ result={winner_details:[],already:true}; break; }
      if(attempt<3) await new Promise(r=>setTimeout(r,attempt*1500));
    }
  }
  if(!result){
    console.error(`CRITICAL: winners of game ${room.dbGameCode||room.dbGameId} were NOT paid. Run: SELECT public.end_bingo_game(${room.dbGameId}, ARRAY[${ids.join(',')}]::integer[], ARRAY[${called.join(',')}]::integer[]);`);
    return null;
  }
  const rows=Array.isArray(result.winner_details)?result.winner_details:(Array.isArray(result.winners)?result.winners:[]);
  const names=winners.map(w=>w.playerName);
  const tids=winners.map(w=>String(w.telegramId||'')).filter(Boolean);
  const first=rows.length?Number(rows[0].payout):Math.floor((room.pot||0)/winners.length);
  console.log(`🏆 Game ${room.dbGameCode||room.dbGameId} settled: paid ${result.total_payout??result.total_paid??'?'} to ${rows.length||winners.length} winning cartela(s), ${called.length} numbers called`);
  // the winners' wallets changed: reload once and push
  forEachLimit(winners,10,async w=>{ await pushWallets(w); }).catch(()=>{});
  runGameBonuses(room.dbGameId);   // "play N games" bonus: fire and forget, never blocks the payout
  return {winAmount:first,names,tids};
}

async function endGame(room, winners, customMsg, noWinner){
  if(room.callTimer) clearTimeout(room.callTimer);
  if(room.countdownTimer) clearInterval(room.countdownTimer);
  if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);
  room.status='finished'; room.claimWindowOpen=false;

  let winAmount=0, winnerNames=[], winnerTids=[];

  {
    // ── db.js: endBingoGame() pays every winner from the prize pool in ONE transaction ──
    if(winners&&winners.length>0){
      const paid=await settleDbGame(room,winners);
      if(paid){ winAmount=paid.winAmount; winnerNames=paid.names; winnerTids=paid.tids; }
      else{ winnerNames=winners.map(w=>w.playerName); winnerTids=winners.map(w=>String(w.telegramId||'')).filter(Boolean); winAmount=Math.floor((room.pot||0)/winners.length); }
    }else if(room.dbGameId){
      // nobody won (all numbers called): close the game and give every stake back
      try{
        if(typeof bingoDb.cancelBingoGame!=='function') throw new Error('cancelBingoGame is not available in db.js');
        const r=await bingoDb.cancelBingoGame(room.dbGameId,'no_winner');
        console.warn(`↩️ Game ${room.dbGameCode||room.dbGameId} ended with no winner: refunded ${r&&r.refunded_cards} cartela(s), ${r&&r.refunded_total} ETB`);
        forEachLimit(room.players.filter(p=>p.hasPaid),10,pushWallets).catch(()=>{});
      }catch(e){
        console.error(`⚠️ Game ${room.dbGameCode||room.dbGameId} ended with no winner and could not be cancelled: ${e.message}. The game stays open and blocks this stake: install cancel_bingo_game.sql (adds cancel_bingo_game) and cancelBingoGame in db.js, or cancel it by hand.`);
      }
    }
  }

  const isSplit=winners&&winners.length>1;
  const msg=customMsg||(noWinner?'በዚህ ዙር አሸናፊ የለም':
    isSplit?`🤝 የተከፋፈለ ሽልማት! ${winnerNames.join(' & ')} እያንዳንዳቸው ${winAmount} ETB አሸንፈዋል!`
           :`🏆 ${winnerNames[0]} ${winAmount} ETB አሸንፈዋል!`);

  // Include the winning cartela(s) so both winners and losers see a clear
  // result page with the winning card, just like the reference design.
  const winningCards=(winners||[]).map(w=>{
    const winningId=w._winningCardId||w.cardId||null;
    const card=winningId?getCard(winningId):null;
    return {
      playerName:w.playerName,
      playerId:w.playerId||'',
      cardId:winningId,
      cardNumbers:card?card.numbers:[],
      markedIndices:Array.isArray(w._winningMarkedIndices)?w._winningMarkedIndices:[]
    };
  });

  // Broadcast the result to EVERY connected player in the room. Keep the room/stake
  // identifiers in this message so clients can return to the same stake.
  // The pause before the next round comes from the database (bingo_rooms.next_round_seconds), read with the stakes.
  const stakeCfg=STAKES.find(x=>x.id===room.stakeId);
  const nrs=Number(stakeCfg&&stakeCfg.nextRoundSeconds);
  const RESET_SECONDS=Number.isFinite(nrs)&&nrs>=1?Math.min(300,Math.floor(nrs)):DEFAULT_NEXT_ROUND_SECONDS;
  room.resetAt=Date.now()+RESET_SECONDS*1000;      // a player who reconnects during the pause is told how long is left
  broadcast(room,{
    type:'gameOver',
    roomId:room.roomId,
    stakeId:room.stakeId,
    winners:winnerNames,
    winAmount,
    isSplit,
    message:msg,
    noWinner:!!noWinner,
    winnerPlayerIds:(winners||[]).map(w=>w.playerId).filter(Boolean),
    winningCards,
    calledNumbers:room.calledNumbers,
    fairness:(room.fair&&room.dbGameId)?{commitment:room.fair.commitment,salt:room.fair.salt,order:room.fair.order}:undefined,   // revealed once the game is over
    resetCountdown:RESET_SECONDS
  });

  // Send a real 9 -> 8 -> ... -> 1 countdown. The room remains finished during
  // this period, then is reset to WAITING and the SAME room is reused.
  if(room.resetCountdownTimer) clearInterval(room.resetCountdownTimer);
  let resetSeconds=RESET_SECONDS;
  room.resetCountdownTimer=setInterval(()=>{
    resetSeconds--;
    if(resetSeconds>0){
      broadcast(room,{type:'resetCountdown',roomId:room.roomId,stakeId:room.stakeId,seconds:resetSeconds});
    }
  },1000);

  room.resetTimer=setTimeout(()=>{
    if(room.resetCountdownTimer) clearInterval(room.resetCountdownTimer);
    room.resetCountdownTimer=null;
    if(!rooms[room.roomId]) return;

    room.status='waiting';
    room.calledNumbers=[];
    room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
    room.pot=0;
    room.takenCardIds=new Set();
    room.claimedThisRound=[];
    room.claimWindowOpen=false;
    room.dbGameId=null;
    room.dbGameCode=null;
    room.fair=newFairness();          // a new committed order for the next round
    room.participantCards=null;
    room.grossPot=0;
    room.startFailures=0;
    room.callTimer=null;
    room.claimEvalTimer=null;

    // IMPORTANT: players stay in this room, but their old cards/payment flags are
    // cleared so they can choose fresh cards for the next round.
    room.players.forEach(p=>{
      p.cardId=null;
      p.cardId2=null;
      p.cardId3=null;
      p.cardId4=null;
      p.hasPaid=false;
      p.disqualified=false;
    });

    // Players who had LEFT this game's screen (detached, usually playing another game now)
    // are removed from the finished room instead of being pulled back into it.
    room.players=room.players.filter(p=>{
      if(!p.detached) return true;
      const cl=clients[p.playerId];
      if(cl&&cl.rooms) cl.rooms.delete(room.roomId);
      if(cl&&cl.roomId===room.roomId) cl.roomId=null;
      sendRoom(room,p.ws,{type:'roomClosed'});
      return false;
    });
    if(room.players.length===0){ delete rooms[room.roomId]; broadcastLobby(); return; }

    room.players.forEach(p=>{
      const cl=clients[p.playerId];
      send(p.ws,{
        type:'backToCardSelection',
        roomId:room.roomId,
        stakeId:room.stakeId,
        balance:cl?cl.balance:0,
        wallets:cl?cl.wallets:undefined,
        playerCount:0,
        stakeAmount:room.stake,
        status:'waiting',
        // Include the fresh pool in the reset response so the client can switch
        // to card selection and render the new pool without a page reload.
        pool:getCardPoolForRoom(room).map(c=>({id:c.id,taken:false,takenByMe:false}))
      });
    });

    broadcastCardPool(room);
    broadcastLobby();
    // Do NOT start countdown here. Players must select fresh cards first.
  },RESET_SECONDS*1000);
}

async function leaveRoom(client,roomId){
  const rid=roomId||client.roomId;
  if(!rid) return;
  if(client.rooms) client.rooms.delete(rid);
  const room=rooms[rid];
  if(!room){ if(client.roomId===rid) client.roomId=null; return; }
  const p=playerOf(room,client);
  if(p){
    // another device of the same account is still in this room: only THIS device leaves,
    // the player and his cartelas stay for the other device(s)
    detachSocket(p,client.ws);
    if(openSockets(p).length){ if(client.roomId===rid) client.roomId=null; return; }
    if(p.cardId) room.takenCardIds.delete(p.cardId);
    getPlayerCardIds(p).forEach(id=>room.takenCardIds.delete(id));

  }
  room.players=room.players.filter(x=>x!==p);
  if(client.roomId===rid) client.roomId=null;
  if(room.players.length===0){
    if(room.callTimer)clearTimeout(room.callTimer);
    if(room.countdownTimer)clearInterval(room.countdownTimer);
    delete rooms[room.roomId];
  }else{
    broadcastCardPool(room);broadcast(room,{type:'playerLeft',playerCount:room.players.length,players:room.players.map(p=>({playerId:p.playerId,playerName:p.playerName}))});
  }
  broadcastLobby();
}

// ─── WEBSOCKET ────────────────────────────────────────────────
wss.on('connection',(ws,req)=>{
  const ip=clientIp(req);
  const open=(connPerIp.get(ip)||0)+1;
  ws.on('error',()=>{});
  if(open>MAX_CONN_PER_IP){ try{ws.terminate();}catch(e){} return; }
  connPerIp.set(ip,open);
  ws._ip=ip;
  const playerId=uuidv4();
  const client={playerId,playerName:'',telegramId:null,balance:0,roomId:null,rooms:new Set(),ws};
  clients[playerId]=client; ws._pid=playerId;
  // a socket that never signs in is closed (it only holds a slot)
  ws._authTimer=setTimeout(()=>{ if(!client.telegramId && !client.blocked){ try{ws.close(4001,'auth timeout');}catch(e){} } },AUTH_TIMEOUT_MS);

  const lobbyStakes=buildLobbyStakes();
  send(ws,{type:'connected',playerId,balance:0,stakes:lobbyStakes,online:onlineCount()});
  broadcastLobby();

  ws.on('message',async raw=>{

    const queueClient=clients[ws._pid];

    queueClient.messageQueue=(queueClient.messageQueue||Promise.resolve()).then(async()=>{


        try{

          const client=clients[ws._pid];

          if(!client) return;


          // ── Rate limiting: max 15 messages/sec per connection ──

          // Protects against spam/DoS and prevents one misbehaving client

          // (buggy or malicious) from hogging CPU when 400 people are connected.

          const now=Date.now();

          if(!client._rl||now-client._rl.windowStart>1000){

            client._rl={windowStart:now,count:0};

          }

          client._rl.count++;

          if(client._rl.count>15){

            return; // silently drop excess messages this second

          }


          const msg=JSON.parse(raw);

          // a blocked / deactivated account has no access to the game system at all
          if(client.blocked && ['joinRoom','reconnect','selectCard','deselectCard','claimBingo','leaveRoom'].includes(msg.type)){
            send(ws,{type:'authFailed',reason:'blocked'});
            return;
          }

          if(msg&&(msg.lang==='en'||msg.lang==='am')) ws._lang=msg.lang;   // the page's language (sent with every message)
          switch(msg.type){

            case 'telegramAuth':{
              const tid=resolveTelegramId(msg.initData,msg.telegramId);
              if(!tid){
                // not signed by Telegram: refuse (no retry loop); the page tells the player to open the game from Telegram
                send(ws,{type:'authFailed',reason:'invalid_init_data'});
                break;
              }
              const user=await loadUser(tid,6,500);
              if(user&&user.blocked){
                // never trust the cached flag for a refusal: ask the database again (an unblocked account gets in at once)
                try{
                  const f=await bingoDb.getBingoUserFlags(tid);
                  if(f){ user.blocked=f.is_blocked===true; user.inactive=f.is_active===false; user.flagsAt=Date.now(); if(userCache[tid]) Object.assign(userCache[tid],{blocked:user.blocked,inactive:user.inactive,flagsAt:user.flagsAt}); }
                }catch(e){ console.error('getBingoUserFlags:',e.message); }
              }
              if(user&&user.blocked){
                client.blocked=true; client.telegramId=null;
                console.warn(`[auth] blocked account refused: ${tid}`);
                send(ws,{type:'authFailed',reason:'blocked'});
                break;
              }
              if(user){
                client.blocked=false;
                client.inactive=user.inactive===true;       // inactive: may look at stakes / rooms / games, cannot play
                client.telegramId=tid;
                applyUserToClient(client,user);
                client.playerName=user.name||client.playerName||'Player';
                relinkAllRooms(client,ws,tid);
                broadcastLobby();            // tell the lobby which stakes this player is already in   // keep receiving every game this account is playing
                send(ws,{type:'authSuccess',playerName:client.playerName,balance:client.balance,wallets:client.wallets,isRegistered:true,inactive:client.inactive===true});
              } else {
                // loadUser() is null both for "not registered" and for "database not reachable".
                // Ask once more to tell them apart: an unregistered player gets a clear screen, not an endless spinner.
                let reg='error';
                try{ reg=(await bingoDb.getUserWalletBalances(tid))?'yes':'no'; }catch(e){ reg='error'; }
                if(reg==='no'){
                  client.telegramId=null;
                  send(ws,{type:'authFailed',reason:'not_registered'});
                }else{
                  // Never convert a failed/late database lookup into a fake zero wallet.
                  send(ws,{type:'authRetry',retryAfter:1000});
                }
              }
              break;
            }

            case 'setName':{

              if(msg.name&&msg.name.trim()){client.playerName=msg.name.trim().substring(0,20);send(ws,{type:'nameSet',playerName:client.playerName});}

              break;

            }

          case 'reconnect':{

      const room=rooms[msg.roomId];

      if(!room){
        send(ws,{type:'reconnectFailed'}); break;
      }

      // After a round finishes the same room is deliberately kept in WAITING state.
      // Allow a page reload/reconnect to return to that room instead of forcing the
      // player back to the lobby.
      if(room.status!=='playing' && room.status!=='waiting' && room.status!=='countdown' && room.status!=='finished'){
        send(ws,{type:'reconnectFailed'}); break;
      }

      // Try by playerId first, fall back to telegramId for page-reload reconnects

      // only the signed-in identity counts; a Telegram ID sent in this message is ignored
      if(!client.telegramId){ send(ws,{type:'authRetry',retryAfter:500}); break; }
      let ep=playerOf(room,client);
      if(!ep){
        const tid=String(client.telegramId);
        ep=room.players.find(p=>String(p.telegramId)===tid);
        if(ep) client.telegramId=tid;       // another device (or a reload) of the same account SHARES this player
      }
      if(ep){
        await refreshClientBalance(client);
        attachSocket(ep,ws); ep.playerId=client.playerId; client.roomId=msg.roomId; ep.detached=false;
        if(ep.detachedSockets) ep.detachedSockets.delete(ws);
        if(!client.rooms) client.rooms=new Set(); client.rooms.add(msg.roomId);
        relinkAllRooms(client,ws,String(client.telegramId||''));

        const card=ep.cardId?getCard(ep.cardId):null;

        const card2=ep.cardId2?getCard(ep.cardId2):null;

        if(room.status==='playing'){
          send(ws,{type:'reconnected',roomId:msg.roomId,stakeId:room.stakeId,

            cardId:ep.cardId,cardNumbers:card?card.numbers:[],

            cardId2:ep.cardId2||null,cardNumbers2:card2?card2.numbers:[],
            cardId3:ep.cardId3||null,cardNumbers3:ep.cardId3?getCard(ep.cardId3).numbers:[],
            cardId4:ep.cardId4||null,cardNumbers4:ep.cardId4?getCard(ep.cardId4).numbers:[],

            calledNumbers:room.calledNumbers,pot:room.pot,playerCount:livePlayerCount(room),balance:client.balance});
        }else if(room.status==='finished'){
          // The round is over and the board is being reset: keep this connection in the room so it receives
          // 'backToCardSelection', and tell the app how long the pause still lasts.
          send(ws,{type:'postGameWait',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,
            seconds:Math.max(0,Math.ceil(((room.resetAt||Date.now())-Date.now())/1000))});
        }else{
          // WAITING/COUNTDOWN room: show fresh card selection state.
          send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,
            balance:client.balance,status:room.status,
            countdownLeft:room.status==='countdown'?room.countdownLeft:0,
            countdown:room.status==='countdown'?room.countdownLeft:0,
            playerCount:room.players.reduce((sum,p)=>getPlayerCardCount(p)+sum,0),
            stakeAmount:room.stake,
            ...selectionPayload(ep)});
          sendCardPoolTo(room,ep,ws);        // only this connection needs the pool
          broadcastLobby();
        }

      } else {

        send(ws,{type:'reconnectFailed'});

      }

      break;

    }

           case 'joinRoom':{

                  let sc=STAKES.find(s=>s.id===msg.stakeId);
                 if(!sc){
                   // an older / differently written name ("s5", "S5", "stake5") still finds the stake with that amount
                   const m=String(msg.stakeId||'').match(/([0-9]+(?:\.[0-9]+)?)/);
                   if(m) sc=STAKES.find(s=>Number(s.amount)===Number(m[1]));
                   if(sc) msg.stakeId=sc.id;
                 }
                 if(!sc) return send(ws,{type:'error',message:'የተሳሳተ የውርርድ መጠን።'});


                 // Joining/navigating to page 2 must never be blocked by a database

                 // availability check. The wallet is validated only when a paid card

                 // is selected. Accept the Telegram ID here so the server can use it

                 // for that later validation even if telegramAuth arrived slightly late.

                 // A player may play several games at once (one room per stake). Rooms where he
                 // has a RUNNING game stay open. Any other room (card selection not started yet,
                 // or just watching) is left, which releases the picked cards as before.
                 for(const r of clientRooms(client)){
                   const pl=playerOf(r,client);
                   const runningGame=pl&&(r.status==='playing'||r.status==='starting')&&(getPlayerCardCount(pl)>0||pl.hasPaid);
                   // the room of the stake being joined is kept: a second device of the same account shares it
                   // picks he made in a room that has not started yet are kept too (he is still in that game)
                    const holdsPicks=pl&&(getPlayerCardCount(pl)>0||pl.hasPaid)&&['waiting','countdown','starting','playing'].includes(r.status);
                    if(!runningGame && !holdsPicks && r.stakeId!==msg.stakeId) await leaveRoom(client,r.roomId);
                 }

              // ── Re-link an existing player before spectator handling. ──
              // A page/app reload creates a new WebSocket/playerId. If this Telegram
              // account already owns cards in the same stake room, it is the SAME
              // player and must never be added as a spectator/new player.
              const reconnectTid=String(client.telegramId||'').trim();
              if(reconnectTid){
                const existingRoom=Object.values(rooms).find(r=>
                  r.stakeId===msg.stakeId &&
                  (r.status==='waiting'||r.status==='countdown'||r.status==='playing') &&
                  r.players.some(p=>String(p.telegramId||'')===reconnectTid)
                );
                if(existingRoom){
                  const ep=existingRoom.players.find(p=>String(p.telegramId||'')===reconnectTid);
                  // second device of the same account: it joins the SAME player and sees the same cartelas
                  attachSocket(ep,ws);
                  ep.playerId=client.playerId;
                  ep.telegramId=reconnectTid;
                  if(ep.detachedSockets) ep.detachedSockets.delete(ws);
                  client.telegramId=reconnectTid;
                  client.roomId=existingRoom.roomId; ep.detached=false;
                  if(!client.rooms) client.rooms=new Set(); client.rooms.add(existingRoom.roomId);
                  relinkAllRooms(client,ws,reconnectTid);
                  await refreshClientBalance(client);
                  const card=ep.cardId?getCard(ep.cardId):null;
                  const card2=ep.cardId2?getCard(ep.cardId2):null;
                  if(existingRoom.status==='playing'){
                    send(ws,{type:'reconnected',roomId:existingRoom.roomId,stakeId:existingRoom.stakeId,
                      cardId:ep.cardId,cardNumbers:card?card.numbers:[],
                      cardId2:ep.cardId2||null,cardNumbers2:card2?card2.numbers:[],
            cardId3:ep.cardId3||null,cardNumbers3:ep.cardId3?getCard(ep.cardId3).numbers:[],
            cardId4:ep.cardId4||null,cardNumbers4:ep.cardId4?getCard(ep.cardId4).numbers:[],
                      calledNumbers:existingRoom.calledNumbers,pot:existingRoom.pot,
                      playerCount:livePlayerCount(existingRoom),balance:client.balance});
                  }else{
                    send(ws,{type:'joinedRoom',roomId:existingRoom.roomId,stakeId:existingRoom.stakeId,
                      balance:client.balance,status:existingRoom.status,
                      countdownLeft:existingRoom.status==='countdown'?existingRoom.countdownLeft:0,
                      countdown:existingRoom.status==='countdown'?existingRoom.countdownLeft:0,
                      playerCount:existingRoom.players.filter(p=>p.hasPaid).length,
                      stakeAmount:existingRoom.stake,
                      ...selectionPayload(ep)});
                    sendCardPoolTo(existingRoom,ep,ws);
                  }
                  broadcastLobby();
                  break;
                }
              }

              // ── If a game for this stake is already in progress, join as a spectator ──

              const liveRoom=Object.values(rooms).find(r=>r.stakeId===msg.stakeId&&(r.status==='playing'||r.status==='starting'));

              if(liveRoom){
                if(liveRoom.players.length>=liveRoom.maxPlayers) return send(ws,{type:'error',message:`ይህ ክፍል ሙሉ ነው። ከፍተኛው ተጫዋቾች: ${liveRoom.maxPlayers}`});
                liveRoom.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,userId:client.userId||userCache[String(client.telegramId)]?.userId||null,ws:makeMux([ws]),cardId:null,cardId2:null,cardId3:null,cardId4:null,hasPaid:false,disqualified:false});

                client.roomId=liveRoom.roomId; client.rooms.add(liveRoom.roomId);

                send(ws,{type:'joinedRoom',roomId:liveRoom.roomId,stakeId:liveRoom.stakeId,balance:client.balance,status:liveRoom.status});

                sendRoom(liveRoom,ws,{type:'spectating',pot:liveRoom.pot,playerCount:liveRoom.players.filter(p=>p.hasPaid).length,calledNumbers:liveRoom.calledNumbers});

                broadcastLobby();

                break;

              }

          

              const room=getOrCreateRoom(msg.stakeId);

              if(room.status==='finished'){
                // between rounds: take the seat now, the board opens when the pause ends
                let ep=room.players.find(x=>x.playerId===client.playerId||(client.telegramId&&String(x.telegramId||'')===String(client.telegramId)));
                if(ep){ attachSocket(ep,ws); ep.playerId=client.playerId; ep.detached=false; }
                else room.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,userId:client.userId||userCache[String(client.telegramId)]?.userId||null,ws:makeMux([ws]),cardId:null,cardId2:null,cardId3:null,cardId4:null,hasPaid:false,disqualified:false});
                client.roomId=room.roomId; client.rooms.add(room.roomId);
                send(ws,{type:'postGameWait',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,
                  seconds:Math.max(0,Math.ceil(((room.resetAt||Date.now())-Date.now())/1000))});
                broadcastLobby();
                break;
              }
              if(room.status!=='waiting'&&room.status!=='countdown') return send(ws,{type:'error',message:'ጨዋታው ቀድሞውኑ ተጀምሯል።'});

              room.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,userId:client.userId||userCache[String(client.telegramId)]?.userId||null,ws:makeMux([ws]),cardId:null,cardId2:null,cardId3:null,cardId4:null,hasPaid:false,disqualified:false});

              client.roomId=room.roomId; client.rooms.add(room.roomId);

              send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,status:room.status,playerCount:room.players.reduce((sum,p)=>sum+getPlayerCardCount(p),0),stakeAmount:room.stake});

              sendCardPoolTo(room,room.players[room.players.length-1],ws); broadcastLobby();

                 const readyPlayers=room.players.filter(p=>getPlayerCardCount(p)>0).length;

              if(readyPlayers>=(room.minPlayers||2)&&room.status==='waiting') startCountdown(room);

              break;

            }

            case 'selectCard':{
              const room=roomForMsg(client,msg);
              if(!room) break;
              // Selecting a card is intentionally memory-only. Never wait for the DB here.
              if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;
              const cardId=parseInt(msg.cardId);
              const slot=Math.max(1,Math.min(4,parseInt(msg.slot)||1));
              if(cardId<1||cardId>room.cardLimit) break;
              if(slot>(room.maxCards||4)) return send(ws,{type:'error',message:`በዚህ ክፍል እስከ ${room.maxCards||4} ካርቴላ ብቻ መምረጥ ይቻላል።`});
              const p=playerOf(room,client);
              if(!p) break;
              if(room.takenCardIds.has(cardId)) return send(ws,{type:'error',message:'ይህ ካርቴላ ቀድሞውኑ ተመርጧል!'});
              if(client.inactive===true) return send(ws,{type:'error',message:'Your account is inactive: you can watch games but cannot play. Please contact support.'});
              { const uu=userCache[String(p.telegramId||client.telegramId||'')]; if(uu&&uu.blocked) return send(ws,{type:'error',message:'መለያዎ ለጊዜው ተዘግቷል። እባክዎ ድጋፍን ያነጋግሩ።'}); }

              const field=getCardField(slot);
              const previous=p[field];
              const changedIds=new Set([cardId]);
              if(previous){
                room.takenCardIds.delete(previous);
                changedIds.add(previous);
              }

              // The player's selected cards are reservations only. No balance change
              // and no database call happens here, so rapid clicks are safe.
              if(!previous){
                const reservedAfter=getPlayerCardCount(p)+1;
                const required=Number(room.stake)*reservedAfter+reservedElsewhere(client,room);
                // Fast local guard only. The authoritative DB balance is checked again
                // once, when the game actually starts.
                let have=Number(client.spendable??client.balance);
                if(have<required){
                  // The wallet may have been topped up since sign-in: reload it once before refusing.
                  await refreshClientBalance(client);
                  have=Number(client.spendable??client.balance);
                  // the room may have changed while we waited
                  if(room.status!=='waiting'&&room.status!=='countdown') break;
                  if(room.takenCardIds.has(cardId)) return send(ws,{type:'error',message:'ይህ ካርቴላ ቀድሞውኑ ተመርጧል!'});
                }
                if(have<required){
                  if(previous) room.takenCardIds.add(previous);
                  return send(ws,{type:'error',message:`በቂ ቀሪ ሂሳብ የለዎትም። ለ${reservedAfter} ካርድ(ዎች) ${required} ብር ያስፈልጋል።`});
                }
              }

              p[field]=cardId;
              room.takenCardIds.add(cardId);
              const card=getCard(cardId);
              sendRoom(room,p.ws,{type:'cardSelected',cardId,cardNumbers:card.numbers,slot});
              broadcastCardDiff(room,Array.from(changedIds)); broadcastLobby();
              const readyCount=room.players.filter(p=>getPlayerCardCount(p)>0).length;
              if(readyCount>=(room.minPlayers||2)&&room.status==='waiting') startCountdown(room);
              break;
            }
            case 'deselectCard':{
              const room=roomForMsg(client,msg);
              if(!room) break;
              if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;
              const p=playerOf(room,client);
              if(!p) break;
              let slot=Math.max(1,Math.min(4,parseInt(msg.slot)||1));
              const wanted=parseInt(msg.cardId);
              if(wanted&&p[getCardField(slot)]!==wanted){                  // the slot sent does not hold this cartela: find the one that does
                const found=[1,2,3,4].find(sl=>p[getCardField(sl)]===wanted);
                if(found) slot=found;
              }
              const field=getCardField(slot);
              const releasedId=p[field];
              if(!releasedId) break;
              // Before the game starts this is only a reservation release.
              // Nothing was charged yet, so there is nothing to refund.
              room.takenCardIds.delete(releasedId);
              p[field]=null;
              if(getPlayerCardCount(p)===0) p.hasPaid=false;
              sendRoom(room,p.ws,{type:'cardDeselected',cardId:releasedId,slot});   // all devices drop it
              broadcastCardDiff(room,[releasedId]); broadcastLobby();
              break;
            }
            case 'claimBingo':{

              const room=roomForMsg(client,msg);
              if(!room) return;

              if(!room||room.status!=='playing') return;

              const p=playerOf(room,client);

              if(!p||p.disqualified||getPlayerCardCount(p)===0) return;

              if(!room.claimWindowOpen) return sendRoom(room,ws,{type:'claimTooLate',message:'ጊዜው አልፏል!'});

              if(!room.claimedThisRound.find(c=>c.playerId===p.playerId))

                room.claimedThisRound.push({

                  playerId:p.playerId,

                  markedIndices:msg.markedIndices||[],

                  cardId2:msg.cardId2||null,

                  markedIndices2:msg.markedIndices2||[],

                  cardId3:msg.cardId3||null,

                  markedIndices3:msg.markedIndices3||[],

                  cardId4:msg.cardId4||null,

                  markedIndices4:msg.markedIndices4||[]

                });

              if(room.callTimer) clearTimeout(room.callTimer);

              if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);

              room.claimEvalTimer=setTimeout(()=>evaluateClaims(room), CLAIM_COLLECT_MS);

              break;

            }

            case 'leaveRoom':

              await leaveRoom(client,msg.roomId); send(ws,{type:'leftRoom',roomId:msg.roomId||null,balance:client.balance}); break;

            // The player left the screen of a running game but is still playing it
            // (usually because he opened another game). Used to clean up after that game ends.
            case 'detachRoom':{
              const room=roomForMsg(client,msg);
              if(!room) break;
              const pl=playerOf(room,client);
              if(pl){
                pl.detachedSockets=(pl.detachedSockets||new Set()).add(ws);
                pl.detached=openSockets(pl).every(x=>pl.detachedSockets.has(x));
              }
              if(client.roomId===room.roomId) client.roomId=null;
              broadcastLobby();
              break;
            }


          }

        }catch(err){console.error('WS:',err);}
  
    }).catch(e=>{

      console.error('WS message queue error:',e);

      send(ws,{type:'error',message:e.message||'Server error.'});

    });
});

  ws.on('close',()=>{
  clearTimeout(ws._authTimer);
  { const n=(connPerIp.get(ws._ip)||1)-1; if(n>0) connPerIp.set(ws._ip,n); else connPerIp.delete(ws._ip); }
    const c=clients[ws._pid];
    if(!c) return;
    let keepClient=false;
    clientRooms(c).forEach(room=>{
      const p=playerOf(room,c);
      if(p) detachSocket(p,ws);
      if(p&&openSockets(p).length) return;                              // another device of this account is still connected
      if((room.status==='playing'||room.status==='starting')&&p){ keepClient=true; }   // running games (and one being created right now) stay alive
      else if(room.status==='finished'&&p){ keepClient=true; p.absentSince=Date.now(); }   // post-game pause: the app may come back (verify link, screen off) before the next round
      else if(p&&(room.status==='waiting'||room.status==='countdown')){
        keepClient=true;
        if(p.graceTimer) clearTimeout(p.graceTimer);
        p.absentSince=Date.now();
        if(getPlayerCardCount(p)>0){
          // He picked cartelas, so he is IN the game until he releases them himself: a screen timeout, the app in the
          // background or a lost connection do not remove him. (A room still waiting for a second player is cleaned
          // up by the absent-player sweep after a long time.)
        }else{
          // no picks: he was only looking at the room, leave after a short grace
          p.graceTimer=setTimeout(()=>{
            p.graceTimer=null;
            if(openSockets(p).length) return;
            leaveRoom(c,room.roomId).catch(()=>{});
            if(!clientRooms(c).length) delete clients[c.playerId];
            broadcastLobby();
          },DISCONNECT_GRACE_MS);
        }
      }
      else leaveRoom(c,room.roomId);
    });
    if(keepClient) return;
    delete clients[ws._pid]; broadcastLobby();
  });
  ws.on('error',()=>{});
});

// NOTE: the profile (/api/user/:tid) and winners (/api/top-winners) endpoints now live in data_server.js,
// a separate service. This server only plays games (WebSocket) and answers /health.

// ─── START ────────────────────────────────────────────────────
server.listen(PORT,()=>{
  console.log(`\n🎱 ${APP_TITLE} on port ${PORT}\n`);
  console.log("🔒 Provably-fair draw: ON (proof is saved when each game starts)");
});
