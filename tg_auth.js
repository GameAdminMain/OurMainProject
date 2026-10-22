/**
 * Telegram sign-in check shared by the game server (server.js) and the data server (data_server.js).
 */
require('dotenv').config();
const crypto=require('crypto');

// ─── TELEGRAM SIGN-IN VERIFICATION ───────────────────────────
// The Telegram ID a player sends is NOT trusted. The page sends Telegram's signed `initData`; it is checked here
// with the bot token (HMAC-SHA256, https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
// and the player's ID is taken from the verified data only.
//   BOT_TOKEN                 token of the bot that opens the web app (required)
//   INITDATA_MAX_AGE_SEC      how old initData may be (default 86400 = 24 h)
//   ALLOW_UNVERIFIED_AUTH=1   old behaviour (trust the ID the page sends). For local development only.
const BOT_TOKEN=String(process.env.BOT_TOKEN||'').trim().replace(/^["']|["']$/g,'');
const ALLOW_UNVERIFIED_AUTH=process.env.ALLOW_UNVERIFIED_AUTH==='1';
const INITDATA_MAX_AGE_SEC=Number(process.env.INITDATA_MAX_AGE_SEC)||86400;
const INITDATA_SECRET=BOT_TOKEN?crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest():null;
if(ALLOW_UNVERIFIED_AUTH) console.warn('⚠️ ALLOW_UNVERIFIED_AUTH=1: Telegram IDs are NOT verified. Never use this in production.');
else if(!BOT_TOKEN) console.error('❌ BOT_TOKEN is not set: every sign-in will be refused. Set BOT_TOKEN (or ALLOW_UNVERIFIED_AUTH=1 for local tests).');
// returns the verified Telegram ID (string) or null
function verifyInitData(initData){
  try{
    if(!INITDATA_SECRET) return fail('BOT_TOKEN not set');
    if(typeof initData!=='string'||initData.length<10) return fail('initData empty - page was not opened as a Telegram Web App (length '+(initData&&initData.length||0)+')');
    if(initData.length>4096) return fail('initData too long');
    const params=new URLSearchParams(initData);
    const hash=params.get('hash'); if(!hash||!/^[0-9a-f]{64}$/i.test(hash)) return fail('no valid hash in initData');
    params.delete('hash');
    const check=[...params.entries()].map(([k,v])=>k+'='+v).sort().join('\n');
    const calc=crypto.createHmac('sha256',INITDATA_SECRET).update(check).digest();
    const given=Buffer.from(hash,'hex');
    if(given.length!==calc.length||!crypto.timingSafeEqual(calc,given)) return fail('signature mismatch - BOT_TOKEN on the server is not the token of the bot that opened this app');
    const age=Math.floor(Date.now()/1000)-Number(params.get('auth_date')||0);
    if(!(age>=-60&&age<=INITDATA_MAX_AGE_SEC)) return fail('initData too old/future: age '+age+'s (server clock '+new Date().toISOString()+')');
    const user=JSON.parse(params.get('user')||'null');
    const id=String(user&&user.id||'');
    return /^\d+$/.test(id)&&Number(id)>0?id:fail('no user id in initData');
  }catch(e){ return fail('exception '+e.message); }
}
function fail(why){ console.warn('[auth] sign-in refused: '+why); return null; }
// the Telegram ID for a request: verified from initData, or (development only) the one the page claims
function resolveTelegramId(initData,claimedId){
  if(INITDATA_SECRET){
    const id=verifyInitData(initData);
    if(id) return id;
    if(!ALLOW_UNVERIFIED_AUTH) return null;
  }
  if(!ALLOW_UNVERIFIED_AUTH) return null;
  const id=String(claimedId||'').trim();
  return /^\d+$/.test(id)&&Number(id)>0?id:null;
}

module.exports={BOT_TOKEN,ALLOW_UNVERIFIED_AUTH,verifyInitData,resolveTelegramId};
