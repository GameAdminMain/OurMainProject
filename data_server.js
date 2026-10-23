/**
 * DATA SERVER - read-only HTTP API (no game logic, no WebSocket).
 *   GET /api/user/:tid        player profile: wallets, totals, per-stake stats
 *   GET /api/top-winners      winners board
 *   GET /api/verify/:gameCode public fairness data of one game (order + salt after the game is over), used by /verify
 *   GET  /api/admin/live  who is online / playing now (asks the game server; env GAME_SERVER_URL + LIVE_KEY)
 *   GET  /api/admin/{overview,queues,errors,recon,settings}, POST /api/admin/{recon/run,settings,statement}  admin dashboard (admin.html)
 *   POST /api/client-error    crashes of the game page (logged only, rate-limited)
 *   GET /health
 * The game server (server.js) only runs games over WebSocket. Both use the same database and the same BOT_TOKEN.
 * Environment: DATABASE_URL (as db.js), BOT_TOKEN, PORT, optional HEALTH_KEY, PROFILE_TTL_MS (default 3000).
 */
require('dotenv').config();
const express=require('express');
const http=require('http');
const bingoDb=require('./db');
const { BOT_TOKEN, ALLOW_UNVERIFIED_AUTH, resolveTelegramId, verifyInitData } = require('./tg_auth');
const crypto=require('crypto');
const { spawn, execFile }=require('child_process');
const reconcile=require('./reconcile');

const PORT=process.env.PORT||3001;
const round2=v=>Math.round((Number(v)||0)*100)/100;
const profileCache=new Map();
const PROFILE_TTL_MS=Number(process.env.PROFILE_TTL_MS)||3000;   // short: balances change when a game ends

// wallets + name of one player (null = not registered)
async function loadUser(tid){
  const id=String(tid||'').trim();
  if(!/^\d+$/.test(id)||Number(id)<=0) return null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const r=await bingoDb.getUserWalletBalances(id);
      if(!r) return null;
      const n=v=>{const x=Number.parseFloat(v);return Number.isFinite(x)&&x>0?x:0;};
      return {userId:Number(r.user_id),name:r.name||'',wallets:{main:n(r.main_balance),play:n(r.play_balance),bonus:n(r.bonus_balance)}};
    }catch(e){
      console.error(`loadUser attempt ${attempt}/3:`,e.message);
      if(attempt<3) await new Promise(r=>setTimeout(r,300*attempt));
    }
  }
  return null;
}

const app=express();
const server=http.createServer(app);
app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin',origin||'*');
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With, X-Telegram-Init-Data');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/health',(req,res)=>{
  if(!process.env.HEALTH_KEY||req.query.key!==process.env.HEALTH_KEY) return res.json({ok:true});
  res.json({ok:true,service:'data',time:new Date().toISOString(),uptimeSeconds:Math.round(process.uptime()),node:process.version,botTokenSet:!!BOT_TOKEN,unverifiedAuth:ALLOW_UNVERIFIED_AUTH});
});


// ─── CLIENT ERRORS ────────────────────────────────────────────
// The game page reports its own crashes here (index.html: window 'error' / 'unhandledrejection').
// Only written to the log (Railway logs: search "[client-error]"); nothing is stored. Rate-limited per IP.
function db_saveClientError(b){ bingoDb.saveClientError({...b,line:Number(b.line)||0}).catch(e=>{ if(!/client_errors|relation/.test(e.message)) console.error('saveClientError:',e.message); }); }
const clientErrHits=new Map();   // ip -> { t, n }
app.post('/api/client-error',(req,res)=>{
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',').pop().trim();   // last entry = added by the proxy, a client cannot fake it
  const now=Date.now(); let h=clientErrHits.get(ip);
  if(!h||now-h.t>60000){ h={t:now,n:0}; clientErrHits.set(ip,h); }
  if(++h.n>10) return res.sendStatus(429);
  if(clientErrHits.size>5000) clientErrHits.clear();
  const b=req.body&&typeof req.body==='object'?req.body:{};
  const cut=(v,n)=>String(v==null?'':v).replace(/[\r\n]+/g,' ').slice(0,n);
  db_saveClientError(b);
  console.warn('[client-error]',JSON.stringify({kind:cut(b.kind,12),message:cut(b.message,300),src:cut(b.src,120),line:Number(b.line)||0,tid:cut(b.telegramId,20),screen:cut(b.screen,24),lang:cut(b.lang,4),v:cut(b.version,20),ua:cut(b.ua,160),stack:cut(b.stack,800)}));
  res.sendStatus(204);
});

let dashboardShapeLogged=false;
async function getBingoProfile(tid){
  const hit=profileCache.get(tid);
  if(hit&&Date.now()-hit.t<PROFILE_TTL_MS) return hit.data;

  const u=await loadUser(tid);
  if(!u||!u.userId) return null;

  // ONE database call: get_bingo_user_dashboard has balances, totals and per-stake totals.
  // The three extra stats queries only run if the dashboard failed.
  let dash=null, stats=null;
  try{ dash=await bingoDb.getBingoUserDashboard(u.userId); }
  catch(e){
    console.error('getBingoUserDashboard:',e.message);
    stats=await bingoDb.getBingoProfileStats(u.userId).catch(e2=>{ console.error('getBingoProfileStats:',e2.message); return null; });
  }
  const d=(dash&&typeof dash==='object')?dash:null;
  if(d&&!dashboardShapeLogged){ dashboardShapeLogged=true; console.log('ℹ️ getBingoUserDashboard keys:',Object.keys(d).join(', ')); }
  if(d&&d.status&&d.status!=='active') return {blocked:true,status:d.status};

  const num=v=>{const x=Number(v);return Number.isFinite(x)?x:undefined;};
  const walletOf=type=>{
    const row=(d&&Array.isArray(d.balances))?d.balances.find(b=>b&&b.wallet_type===type):null;
    return row?num(row.balance):undefined;
  };
  const wallets={
    main:round2(walletOf('main')??u.wallets.main),
    play:round2(walletOf('play')??u.wallets.play),
    bonus:round2(walletOf('bonus')??u.wallets.bonus)
  };
  if(Math.abs(wallets.main-u.wallets.main)>0.009||Math.abs(wallets.play-u.wallets.play)>0.009){
    console.warn(`⚠️ dashboard wallets differ from the wallet view for user ${u.userId}:`,wallets,u.wallets);
  }

  const sum=(d&&d.summary)||{};
  const games=num(sum.games_played)??stats?.games??0;
  const wins=num(sum.games_won)??stats?.wins??0;
  const earning=num(sum.total_earned)??stats?.earning??0;

  // one row per ACTIVE stake (even with 0 wins), straight from the dashboard
  let stakeRows=[];
  if(d&&Array.isArray(d.stakes)){
    stakeRows=d.stakes.map(st=>({
      stake:num(st.amount)||0,
      wins:Math.trunc(num(st.games_won)||0),
      played:Math.trunc(num(st.games_played)||0),
      win_amount:num(st.total_earned)||0
    })).filter(r=>r.stake>0&&(r.played>0||r.wins>0)).sort((a,b)=>a.stake-b.stake);   // only stakes the player has played in
  }
  if(!stakeRows.length&&stats?.by_stake) stakeRows=stats.by_stake;

  const out={
    telegramId:String(tid),
    name:u.name||'',
    balance:round2(wallets.main+wallets.play),          // header amount (main + play)
    main_wallet:wallets.main,
    play_wallet:wallets.play,
    bonus:wallets.bonus,
    wallets,
    total_games:Math.max(0,Math.trunc(games)),
    total_wins:Math.max(0,Math.trunc(wins)),
    total_winnings:Math.max(0,earning),
    stake_stats:stakeRows,
    latest_earnings:0,
    source:{dashboard:!!d,stats:!!stats}
  };
  profileCache.set(tid,{t:Date.now(),data:out});
  return out;
}

app.get('/api/user/:tid', async(req,res)=>{
  const tid=String(req.params.tid||'').trim();
  if(!tid) return res.status(400).json({error:'Missing Telegram ID'});
  // a profile is only served to the player it belongs to (signed initData in the X-Telegram-Init-Data header)
  const who=resolveTelegramId(req.headers['x-telegram-init-data'],tid);
  if(!who||who!==tid) return res.status(401).json({error:'Open the game from Telegram'});
  try{
    const out=await getBingoProfile(tid);
    if(!out) return res.status(404).json({error:'Not found'});
    if(out.blocked) return res.status(403).json({error:`Account is ${out.status}`,status:out.status});
    return res.json(out);
  }catch(e){
    console.error('GET /api/user (db.js):',e.stack||e.message);
    return res.status(500).json({error:'Database query failed'});
  }
});


// Last 10 games played and last 10 games won (one query, one request; cached 60 s per player).
// The client only asks when the player opens the "Recent games" tabs, never with the normal profile load.
const recentCache=new Map();   // tid -> { t, data }
app.get('/api/user/:tid/recent',async(req,res)=>{
  const tid=String(req.params.tid||'').trim();
  if(!/^\d{1,20}$/.test(tid)) return res.status(400).json({error:'Missing Telegram ID'});
  const who=resolveTelegramId(req.headers['x-telegram-init-data'],tid);
  if(!who||who!==tid) return res.status(401).json({error:'Open the game from Telegram'});
  try{
    let hit=recentCache.get(tid);
    if(!hit||Date.now()-hit.t>60000){
      const rows=await bingoDb.getPlayerRecentGames(tid);
      const shape=r=>({code:r.game_code,stake:Number(r.stake_amount)||0,won:Number(r.amount_won)||0});
      hit={t:Date.now(),data:{played:rows.filter(r=>r.k==='p').map(shape),won:rows.filter(r=>r.k==='w').map(shape)}};
      recentCache.set(tid,hit);
      if(recentCache.size>5000){ const cut=Date.now()-60000; for(const [k,v] of recentCache) if(v.t<cut) recentCache.delete(k); }
    }
    res.setHeader('Cache-Control','private, max-age=30');
    return res.json(hit.data);
  }catch(e){
    console.error('GET /api/user/:tid/recent:',e.stack||e.message);
    return res.status(500).json({error:'Could not load games'});
  }
});

// ─── PROVABLY FAIR: public data for /verify ───────────────────
// The commitment is public from the start; the call order and the salt are only returned once the game is over (database function).
const verifyCache=new Map();   // game code -> { t, data } (finished games never change; running ones are cached for 5 s)
app.get('/api/verify/:code',async(req,res)=>{
  const code=String(req.params.code||'').trim().toUpperCase();
  if(!/^[A-Z0-9_-]{3,40}$/.test(code)) return res.status(400).json({error:'Invalid game code'});
  try{
    const hit=verifyCache.get(code);
    if(hit&&Date.now()-hit.t<(hit.final?3600e3:5000)) return res.json(hit.data);
    const g=await bingoDb.getBingoFairness(code);
    if(!g) return res.status(404).json({error:'Game not found'});
    const final=g.status==='completed'||g.status==='cancelled';
    const data={gameCode:g.game_code,stake:Number(g.stake_amount),status:g.status,startedAt:g.started_at,endedAt:g.ended_at,cards:g.card_count,
      commitment:g.commitment||null,salt:final?(g.salt||null):null,order:final?(g.call_order||null):null,called:g.called_numbers||[]};
    if(verifyCache.size>2000) verifyCache.clear();
    verifyCache.set(code,{t:Date.now(),data,final});
    res.json(data);
  }catch(e){
    console.error('GET /api/verify:',e.message,/get_bingo_fairness/.test(e.message)?'- run fairness.sql':'');
    res.status(500).json({error:'Database query failed'});
  }
});


// ─── ADMIN DASHBOARD (admin.html) ─────────────────────────────
// Access: ONLY a Telegram Web App opened by an active, unblocked MAIN or STATISTICS admin of the bot (signed initData;
// the role is read from the users table on every check, so removing an admin locks him out within 20 seconds).
// Browser access: the shared secret ADMIN_TOKEN (min. 16 characters) opens the dashboard with MAIN rights from any browser.
// It is on whenever ADMIN_TOKEN is set; set ADMIN_TOKEN_LOGIN=off to switch it off again.
// Everything is read-only except: statement import, "run reconciliation", settings (MAIN only).
const DASH_TZ=/^[A-Za-z_\/+\-0-9]{2,40}$/.test(process.env.DASH_TZ||'')?process.env.DASH_TZ:'Africa/Addis_Ababa';
const adminCache=new Map(), adminFails=new Map(), adminDeniedLog=new Map();
const ADMIN_TOKEN_OK=String(process.env.ADMIN_TOKEN||'').length>=16;
const ADMIN_TOKEN_LOGIN=String(process.env.ADMIN_TOKEN_LOGIN||'').toLowerCase()!=='off'&&ADMIN_TOKEN_OK;
if(process.env.ADMIN_TOKEN&&!ADMIN_TOKEN_OK) console.error('[admin] ADMIN_TOKEN is shorter than 16 characters: token login is DISABLED. Use a long random value.');
else if(ADMIN_TOKEN_LOGIN) console.log('[admin] browser login with ADMIN_TOKEN is ON (main admin rights). Set ADMIN_TOKEN_LOGIN=off to disable it.');
else if(process.env.ADMIN_TOKEN) console.log('[admin] ADMIN_TOKEN login is switched OFF (ADMIN_TOKEN_LOGIN=off): only main and statistics admins from Telegram can open the dashboard');
function safeEq(a,b){ const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length&&crypto.timingSafeEqual(x,y); }
async function adminAuth(req){
  const auth=String(req.headers.authorization||'');
  if(ADMIN_TOKEN_LOGIN&&auth.startsWith('Bearer ')&&safeEq(auth.slice(7),process.env.ADMIN_TOKEN)) return {role:'main',via:'token'};
  const init=req.headers['x-telegram-init-data'];
  if(!init) return null;
  const tid=verifyInitData(init);                    // always the signed data, never a claimed id
  if(!tid) return null;
  const hit=adminCache.get(tid);
  if(hit&&Date.now()-hit.t<20000) return hit.role?{role:hit.role,via:'telegram',tid}:null;
  const dbRole=await bingoDb.getActiveAdminRoleByTelegramId(tid);
  const role=['main','statistics'].includes(dbRole)?dbRole:null;
  adminCache.set(tid,{t:Date.now(),role});
  if(adminCache.size>5000) adminCache.clear();
  if(!role){   // audit trail: somebody who is not an allowed admin tried to open the dashboard (logged once per 10 min per account)
    const last=adminDeniedLog.get(tid)||0;
    if(Date.now()-last>600000){ adminDeniedLog.set(tid,Date.now()); if(adminDeniedLog.size>5000) adminDeniedLog.clear(); console.warn('[admin] access DENIED for telegram id '+tid+' (not an active main/statistics admin)'); }
  }
  return role?{role,via:'telegram',tid}:null;
}
function adminRoute(needMain,fn){
  return async(req,res)=>{
    const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',').pop().trim();   // last entry = added by the proxy, a client cannot fake it
    try{
      const f=adminFails.get(ip); if(f&&f.n>=20&&Date.now()-f.t<60000) return res.sendStatus(429);
      const who=await adminAuth(req);
      if(!who){ const g=adminFails.get(ip); adminFails.set(ip,{t:g&&Date.now()-g.t<60000?g.t:Date.now(),n:(g&&Date.now()-g.t<60000?g.n:0)+1}); if(adminFails.size>2000) adminFails.clear(); return res.status(401).json({error:'Not authorised'}); }
      if(needMain&&who.role!=='main') return res.status(403).json({error:'Main admin only'});
      res.setHeader('Cache-Control','no-store');
      await fn(req,res,who);
    }catch(e){
      console.error('admin route:',req.path,e.message,/does not exist|relation/.test(e.message)?'- run safety_dashboard.sql':'');
      if(!res.headersSent) res.status(500).json({error:'Query failed: '+String(e.message).slice(0,160)});
    }
  };
}

// public: tells the page whether the token box may be shown at all (no secret is revealed)
app.get('/api/admin/mode',(req,res)=>{ res.setHeader('Cache-Control','no-store'); res.json({tokenLogin:ADMIN_TOKEN_LOGIN}); });
app.get('/api/admin/whoami',adminRoute(false,async(req,res,who)=>res.json({role:who.role,via:who.via,tz:DASH_TZ})));

app.get('/api/admin/overview',adminRoute(false,async(req,res)=>{
  const [{dep,wd,games,users,open,liab,series,errs},userTotals]=await Promise.all([bingoDb.getDashboardOverview(DASH_TZ),bingoDb.getDashboardUserTotals()]);
  res.json({tz:DASH_TZ,today:{deposits:dep[0],withdrawalsPaid:wd[0],games:games[0],newUsers:users[0].n,netCash:Number(dep[0].sum)-Number(wd[0].sum)},open:open[0],liabilities:liab,series,errors24h:errs[0].n,users:userTotals});
}));

app.get('/api/admin/queues',adminRoute(false,async(req,res)=>{
  res.json(await bingoDb.getDashboardQueues());
}));

// who is online / playing right now: lives in the memory of the game server, so it is asked for it (shared secret LIVE_KEY)
const GAME_SERVER_URL=String(process.env.GAME_SERVER_URL||'').replace(/\/+$/,'');
const LIVE_KEY=String(process.env.LIVE_KEY||'');
app.get('/api/admin/live',adminRoute(false,async(req,res)=>{
  if(!GAME_SERVER_URL||LIVE_KEY.length<16) return res.status(503).json({error:'Set GAME_SERVER_URL and LIVE_KEY (min 16 characters, same value as on the game server) on the data server.'});
  const ctl=new AbortController(), t=setTimeout(()=>ctl.abort(),4000);
  try{
    const r=await fetch(GAME_SERVER_URL+'/internal/live',{headers:{'X-Live-Key':LIVE_KEY},signal:ctl.signal,cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok) return res.status(502).json({error:'Game server answered '+r.status+(j&&j.error?': '+j.error:'')});
    res.json(j);
  }catch(e){ res.status(502).json({error:'Cannot reach the game server ('+(e.name==='AbortError'?'timeout':e.message)+')'}); }
  finally{ clearTimeout(t); }
}));

app.get('/api/admin/errors',adminRoute(false,async(req,res)=>{
  res.json(await bingoDb.getDashboardClientErrors());
}));

app.get('/api/admin/recon',adminRoute(false,async(req,res)=>{
  res.json(await bingoDb.getDashboardReconciliation());
}));
let reconRunning=false;
app.post('/api/admin/recon/run',adminRoute(true,async(req,res)=>{
  if(reconRunning) return res.status(409).json({error:'Already running'});
  reconRunning=true;
  try{
    const r=await reconcile.runReconciliation(bingoDb);
    if(req.body&&req.body.alert) r.alert=await reconcile.sendAlert(bingoDb,r,'Reconciliation (manual run)');
    res.json({ok:r.ok,critical:r.critical,warnings:r.warnings,id:r.id,alert:r.alert||null});
  }finally{ reconRunning=false; }
}));

const SETTINGS_FIELDS={enabled:'bool',daily_limit_amount:[0,1e7],daily_limit_count:[0,1000],review_threshold:[0,1e7],cooldown_after_deposit_min:[0,10080],min_play_ratio:[0,100],block_low_play:'bool',new_account_hours:[0,8760]};

// ─── DATABASE BACKUP (admin.html -> Backup tab) ───────────────
// MAIN admin only. Runs `pg_dump` against DATABASE_URL and streams the result as the file "bbpbackup.sql" (plain SQL: schema +
// data, restorable with psql). The download uses a one-time link that is valid for 60 seconds, because the Telegram app
// cannot save files fetched with scripts; the link is only handed out to a signed-in main admin.
// Needs the PostgreSQL client tools (pg_dump) on this server and a pg_dump version >= the database version.
const BACKUP_FILE='bbpbackup.sql';
const backupTickets=new Map();
let backupRunning=false, lastBackup=null;
function pgEnv(){
  const raw=process.env.DATABASE_URL||'';
  const u=new URL(raw);
  const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.replace(/^\//,'')),PGCONNECT_TIMEOUT:'15'};
  delete env.DATABASE_URL;
  const sm=u.searchParams.get('sslmode');
  env.PGSSLMODE=sm||(String(process.env.DB_SSL||'').toLowerCase()==='false'?'disable':'require');   // same rule as db.js: SSL on unless DB_SSL=false
  return env;
}
function run(cmd,args,env){
  return new Promise(resolve=>execFile(cmd,args,{env,timeout:20000,maxBuffer:1<<20},(err,out,errOut)=>resolve({err,out:String(out||'').trim(),errOut:String(errOut||'').trim()})));
}
app.get('/api/admin/backup/info',adminRoute(true,async(req,res)=>{
  const out={file:BACKUP_FILE,tool:null,toolMajor:null,dbName:null,dbBytes:null,dbMajor:null,ready:false,problem:null,running:backupRunning,last:lastBackup};
  const v=await run('pg_dump',['--version']);
  if(v.err){ out.problem=(v.err.code==='ENOENT')?'pg_dump is not installed on the data server. See the install notes below (Dockerfile.data_server).':'pg_dump failed: '+(v.errOut||v.err.message).slice(0,200); }
  else{ out.tool=v.out; const m=v.out.match(/(\d+)(?:\.\d+)?\s*(?:\(|$)/); out.toolMajor=m?Number(m[1]):null; }
  try{
    const r=await bingoDb.getDatabaseInfo();
    out.dbName=r.db; out.dbBytes=Number(r.bytes); out.dbMajor=Number(r.major);
  }catch(e){ out.problem=out.problem||('Cannot read the database: '+e.message.slice(0,120)); }
  if(!out.problem&&out.toolMajor&&out.dbMajor&&out.toolMajor<out.dbMajor) out.problem=`pg_dump is version ${out.toolMajor} but the database is version ${out.dbMajor}: install pg_dump ${out.dbMajor} or newer.`;
  out.ready=!out.problem&&!!out.tool;
  res.json(out);
}));
app.post('/api/admin/backup/ticket',adminRoute(true,async(req,res,who)=>{
  if(backupRunning) return res.status(429).json({error:'A backup is already running. Wait for it to finish.'});
  for(const [k,v] of backupTickets) if(v.exp<Date.now()) backupTickets.delete(k);
  const t=crypto.randomBytes(24).toString('hex');
  backupTickets.set(t,{tid:who.tid||null,via:who.via,exp:Date.now()+60000});
  console.log(`[admin] backup link issued to ${who.via==='token'?'token login':'telegram id '+who.tid}`);
  res.json({url:'/api/admin/backup/download?t='+t,file:BACKUP_FILE});
}));
app.get('/api/admin/backup/download',async(req,res)=>{
  const fail=(code,msg)=>{ res.setHeader('Cache-Control','no-store'); res.status(code).type('text/plain').send(msg); };
  const t=String(req.query.t||'');
  const tk=backupTickets.get(t); backupTickets.delete(t);                   // single use
  if(!tk||tk.exp<Date.now()) return fail(403,'This backup link has expired. Go back to the dashboard and press "Download backup" again.');
  try{   // the person must still be a main admin right now
    if(tk.via==='telegram'){
      if(!(await bingoDb.isActiveMainAdminTelegramId(tk.tid))) return fail(403,'Not authorised.');
    }
  }catch(e){ return fail(500,'Could not check access: '+e.message.slice(0,100)); }
  if(backupRunning) return fail(429,'A backup is already running.');
  let env; try{ env=pgEnv(); }catch(e){ return fail(500,'DATABASE_URL is not valid.'); }
  backupRunning=true;
  const started=Date.now(); let bytes=0, sent=false, errText='', finished=false;
  console.log(`[admin] BACKUP started by ${tk.via==='token'?'token login':'telegram id '+tk.tid}`);
  const child=spawn('pg_dump',['--no-owner','--no-privileges','--format=plain','--encoding=UTF8'],{env,stdio:['ignore','pipe','pipe']});
  const killer=setTimeout(()=>{ errText+='\ntimed out after 15 minutes'; try{ child.kill('SIGKILL'); }catch(e){} },15*60*1000);
  const done=(ok,msg)=>{
    if(finished) return; finished=true; clearTimeout(killer); backupRunning=false;
    lastBackup={at:new Date().toISOString(),by:tk.via==='token'?'token':tk.tid,ok,bytes,ms:Date.now()-started,error:ok?null:String(msg||'').slice(0,300)};
    console.log(ok?`[admin] BACKUP finished: ${bytes} bytes in ${lastBackup.ms} ms`:`[admin] BACKUP FAILED: ${lastBackup.error}`);
  };
  child.stderr.on('data',d=>{ if(errText.length<4000) errText+=d.toString(); });
  child.on('error',e=>{
    done(false,e.code==='ENOENT'?'pg_dump is not installed on the data server':e.message);
    if(!sent){ sent=true; fail(e.code==='ENOENT'?501:500,e.code==='ENOENT'?'pg_dump is not installed on the data server.':'Backup failed: '+e.message); }
  });
  child.stdout.on('data',chunk=>{
    if(!sent){   // headers only go out once the dump really produces data, so a failure can still be reported properly
      sent=true;
      res.writeHead(200,{'Content-Type':'application/sql; charset=utf-8','Content-Disposition':`attachment; filename="${BACKUP_FILE}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    }
    bytes+=chunk.length;
    if(!res.write(chunk)){ child.stdout.pause(); res.once('drain',()=>child.stdout.resume()); }
  });
  child.on('close',code=>{
    if(finished) return;
    if(code===0){ done(true); if(!sent){ sent=true; res.writeHead(200,{'Content-Type':'application/sql; charset=utf-8','Content-Disposition':`attachment; filename="${BACKUP_FILE}"`}); } res.end(); }
    else{ done(false,errText.trim()||('pg_dump exited with code '+code)); if(!sent){ sent=true; fail(500,'Backup failed:\n'+(errText.trim()||('pg_dump exited with code '+code)).slice(0,800)); } else res.destroy(); }
  });
  res.on('close',()=>{ if(!finished){ try{ child.kill('SIGTERM'); }catch(e){} done(false,'download cancelled'); } });
});

app.get('/api/admin/settings',adminRoute(false,async(req,res)=>{
  res.json({settings:await bingoDb.getWithdrawalSafetySettings(),fields:SETTINGS_FIELDS});
}));
app.post('/api/admin/settings',adminRoute(true,async(req,res)=>{
  const b=req.body||{}; const changes={};
  for(const [k,rule] of Object.entries(SETTINGS_FIELDS)){
    if(!(k in b)) continue;
    let v=b[k];
    if(rule==='bool'){ if(typeof v!=='boolean') return res.status(400).json({error:k+' must be true/false'}); }
    else{ v=Number(v); if(!Number.isFinite(v)||v<rule[0]||v>rule[1]) return res.status(400).json({error:`${k} must be between ${rule[0]} and ${rule[1]}`}); }
    changes[k]=v;
  }
  if(!Object.keys(changes).length) return res.status(400).json({error:'Nothing to change'});
  await bingoDb.updateWithdrawalSafetySettings(changes);
  console.log('[admin] withdrawal safety settings changed:',JSON.stringify(b));
  res.json({settings:await bingoDb.getWithdrawalSafetySettings()});
}));

// Payment provider statement lines (CSV pasted in the dashboard, parsed there): { provider, rows:[{reference,direction,amount,counterparty,date}] }
app.post('/api/admin/statement',adminRoute(true,async(req,res)=>{
  const b=req.body||{}; const provider=String(b.provider||'').trim().slice(0,40);
  const rows=Array.isArray(b.rows)?b.rows.slice(0,3000):[];
  if(!provider||!rows.length) return res.status(400).json({error:'provider and rows are required'});
  let added=0, skipped=0, bad=0;
  for(const r of rows){
    const ref=String(r.reference||'').trim().slice(0,100), dir=String(r.direction||'').toLowerCase()==='out'?'out':(String(r.direction||'').toLowerCase()==='in'?'in':null);
    const amt=Number(String(r.amount).replace(/,/g,'')), when=new Date(r.date);
    if(!ref||!dir||!(amt>0)||isNaN(when.getTime())){ bad++; continue; }
    const isNew=await bingoDb.insertProviderStatementLine(provider,ref,dir,amt,String(r.counterparty||'').slice(0,60)||null,when.toISOString());
    if(isNew) added++; else skipped++;
  }
  console.log(`[admin] statement import ${provider}: +${added}, duplicates ${skipped}, invalid ${bad}`);
  res.json({added,skipped,invalid:bad});
}));

// start the nightly reconciliation
try{ reconcile.startSchedule(bingoDb); }catch(e){ console.error('reconciliation schedule:',e.message); }

// ─── TOP WINNERS (Winners screen) ─────────────────────────────
// GET /api/top-winners?period=today|7d|30d|1y   (signed-in Telegram players only)
// Only display names, totals and counts are returned - never phone numbers or Telegram IDs.
const WINNERS_TTL_MS=60*1000;
const winnersCache=new Map(); // period -> { t, rows }
app.get('/api/top-winners', async(req,res)=>{
  const who=resolveTelegramId(req.headers['x-telegram-init-data'],String(req.query.tid||''));
  if(!who) return res.status(401).json({error:'Open the game from Telegram'});
  const period=['today','7d','30d','1y'].includes(req.query.period)?req.query.period:'today';
  try{
    let hit=winnersCache.get(period);
    if(!hit||Date.now()-hit.t>WINNERS_TTL_MS){
      const rows=await bingoDb.getTopWinners(period,100);
      hit={t:Date.now(),rows};
      winnersCache.set(period,hit);
    }
    const all=hit.rows;
    const shape=(r,i)=>({rank:i+1,name:String(r.name||'Player').slice(0,40),total:Number(r.total)||0,wins:Number(r.wins)||0,best:Number(r.best)||0,me:String(r.telegram_id)===String(who)});
    const top=all.slice(0,20).map(shape);
    const myIdx=all.findIndex(r=>String(r.telegram_id)===String(who));
    const me=myIdx>=0?shape(all[myIdx],myIdx):null;
    res.setHeader('Cache-Control','no-store');
    return res.json({period,updatedAt:new Date(hit.t).toISOString(),rows:top,me});
  }catch(e){
    console.error('GET /api/top-winners:',e.stack||e.message);
    return res.status(500).json({error:'Could not load winners'});
  }
});


server.listen(PORT,()=>console.log(`\n📊 Data server on port ${PORT}\n`));
process.on('unhandledRejection',e=>console.error('unhandledRejection:',e));
