'use strict';
// Chromora server — Node 22+, sem dependências. Contas, save na nuvem, ranking, prêmios e assinaturas (Google Play).
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=+process.env.PORT||3000,DB_FILE=process.env.DB_FILE||path.join(__dirname,'chromora.db');
const MAXS=21e6,HR_CAP=6000,DAY_CAP=40000,LIM_CC=20,BKF=.05,PLANS={e:{cost:300},l:{cost:800}},PLAN_MS=30*864e5; // CC: supply fixo, só nasce por mineração
const db=new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT UNIQUE COLLATE NOCASE,display TEXT,salt TEXT,hash TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid INTEGER,created INTEGER);
CREATE TABLE IF NOT EXISTS saves(uid INTEGER PRIMARY KEY,data TEXT,score REAL,updated INTEGER);
CREATE TABLE IF NOT EXISTS stats(uid INTEGER PRIMARY KEY,lv INTEGER,xp INTEGER,st INTEGER,pts INTEGER,flag INTEGER DEFAULT 0,updated INTEGER);
CREATE TABLE IF NOT EXISTS weekly(uid INTEGER,wid INTEGER,pts INTEGER,PRIMARY KEY(uid,wid));
CREATE TABLE IF NOT EXISTS claims(uid INTEGER,key TEXT,at INTEGER,PRIMARY KEY(uid,key));
CREATE TABLE IF NOT EXISTS plans(uid INTEGER PRIMARY KEY,pid TEXT,exp INTEGER,token TEXT);
CREATE TABLE IF NOT EXISTS wallets(uid INTEGER PRIMARY KEY,bal REAL DEFAULT 0,mined REAL DEFAULT 0,hr INTEGER DEFAULT 0,hamt REAL DEFAULT 0,dy INTEGER DEFAULT 0,damt REAL DEFAULT 0,bd INTEGER DEFAULT 0,bu REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ccg(id INTEGER PRIMARY KEY CHECK(id=1),mined REAL DEFAULT 0,res REAL DEFAULT 0,lk REAL DEFAULT 0);
INSERT OR IGNORE INTO ccg(id) VALUES(1);
CREATE INDEX IF NOT EXISTS ix_w ON weekly(wid,pts DESC);CREATE INDEX IF NOT EXISTS ix_l ON stats(lv DESC,xp DESC);`);
const q={};for(const[k,s]of Object.entries({
 uByName:'SELECT * FROM users WHERE name=?',uById:'SELECT * FROM users WHERE id=?',uNew:'INSERT INTO users(name,display,salt,hash,created) VALUES(?,?,?,?,?)',
 sNew:'INSERT INTO sessions VALUES(?,?,?)',sGet:'SELECT uid FROM sessions WHERE token=?',sDel:'DELETE FROM sessions WHERE token=?',
 svGet:'SELECT * FROM saves WHERE uid=?',svSet:'INSERT INTO saves VALUES(?,?,?,?) ON CONFLICT(uid) DO UPDATE SET data=excluded.data,score=excluded.score,updated=excluded.updated',
 stGet:'SELECT * FROM stats WHERE uid=?',stSet:'INSERT INTO stats VALUES(?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET lv=excluded.lv,xp=excluded.xp,st=excluded.st,pts=excluded.pts,flag=excluded.flag,updated=excluded.updated',
 wSet:'INSERT INTO weekly VALUES(?,?,?) ON CONFLICT(uid,wid) DO UPDATE SET pts=MAX(pts,excluded.pts)',wGet:'SELECT pts FROM weekly WHERE uid=? AND wid=?',
 wTop:'SELECT u.display n,w.pts p,w.uid FROM weekly w JOIN users u ON u.id=w.uid JOIN stats s ON s.uid=w.uid WHERE w.wid=? AND w.pts>0 AND s.flag=0 ORDER BY w.pts DESC,w.uid LIMIT ?',
 wPos:'SELECT COUNT(*)+1 c FROM weekly w JOIN stats s ON s.uid=w.uid WHERE w.wid=? AND s.flag=0 AND (w.pts>? OR (w.pts=? AND w.uid<?))',
 tTop:'SELECT u.display n,s.pts p,s.uid FROM stats s JOIN users u ON u.id=s.uid WHERE s.flag=0 ORDER BY s.pts DESC,s.uid LIMIT ?',
 tPos:'SELECT COUNT(*)+1 c FROM stats WHERE flag=0 AND (pts>? OR (pts=? AND uid<?))',
 nTop:'SELECT u.display n,s.lv p,s.xp x,s.uid FROM stats s JOIN users u ON u.id=s.uid WHERE s.flag=0 ORDER BY s.lv DESC,s.xp DESC,s.uid LIMIT ?',
 nPos:'SELECT COUNT(*)+1 c FROM stats WHERE flag=0 AND (lv>? OR (lv=? AND xp>?) OR (lv=? AND xp=? AND uid<?))',
 cGet:'SELECT 1 FROM claims WHERE uid=? AND key=?',cSet:'INSERT OR IGNORE INTO claims VALUES(?,?,?)',
 wList:'SELECT wid FROM weekly WHERE uid=? AND wid<? AND pts>0 ORDER BY wid DESC LIMIT 8',
 cwGet:'SELECT * FROM wallets WHERE uid=?',cwNew:'INSERT OR IGNORE INTO wallets(uid) VALUES(?)',cwSet:'UPDATE wallets SET bal=?,mined=?,hr=?,hamt=?,dy=?,damt=?,bd=?,bu=? WHERE uid=?',gGet:'SELECT * FROM ccg WHERE id=1',gSet:'UPDATE ccg SET mined=?,res=?,lk=? WHERE id=1',
 pGet:'SELECT * FROM plans WHERE uid=?',pSet:'INSERT INTO plans VALUES(?,?,?,?) ON CONFLICT(uid) DO UPDATE SET pid=excluded.pid,exp=excluded.exp,token=excluded.token'
}))q[k]=db.prepare(s);
// ---- CC global: carteira por conta, supply fixo de 21.000.000, reserva do Banco
const r3=x=>Math.round(x*1000)/1000;
function wal(uid){q.cwNew.run(uid);const w=q.cwGet.get(uid),d=dayBR(),h=Math.floor(Date.now()/36e5);if(w.hr!=h){w.hr=h;w.hamt=0}if(w.dy!=d){w.dy=d;w.damt=0}if(w.bd!=d){w.bd=d;w.bu=0}return w}
function wsave(w,g){q.cwSet.run(w.bal,w.mined,w.hr,w.hamt,w.dy,w.damt,w.bd,w.bu,w.uid);if(g)q.gSet.run(g.mined,g.res,g.lk)}
const ccInfo=(w,g)=>({bal:r3(w.bal),res:r3(g.res),lk:r3(g.lk),mined:r3(g.mined),max:MAXS,u:r3(w.bu),mine:r3(w.mined),limCC:LIM_CC,left:r3(MAXS-g.mined)});
function ccDo(uid,fn){db.exec('BEGIN IMMEDIATE');try{const w=wal(uid),g=q.gGet.get(),r=fn(w,g);wsave(w,r&&r.err?null:g);db.exec(r&&r.err?'ROLLBACK':'COMMIT');return r&&r.err?r:{...r,cc:ccInfo(w,g)}}catch(e){db.exec('ROLLBACK');throw e}}
// tempo: semana começa segunda 00:00 e dia vira 00:00 no horário de Brasília (UTC-3)
const H3=3*36e5,weekId=(t=Date.now())=>Math.floor((t-4*864e5-H3)/(7*864e5)),dayBR=(t=Date.now())=>Math.floor((t-H3)/864e5);
const reward=r=>r==1?{g:300,o:1000}:r<=3?{g:150,o:600}:r<=10?{g:80,o:300}:r<=50?{g:40,o:150}:{g:20,o:50};
const dailyTier=(w,n)=>{const r=Math.min(w||1e9,n||1e9);return r<=10?{g:12,o:300}:r<=50?{g:8,o:200}:r<=100?{g:5,o:120}:null};
const J=(res,code,o)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(o))};
const hashPw=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
const tries=new Map();function limited(ip){const n=Date.now(),a=(tries.get(ip)||[]).filter(t=>n-t<6e5);a.push(n);tries.set(ip,a);return a.length>20}
const score=s=>(+s.st||1)*1e9+(+s.lv||1)*1e4+Math.min(9999,Math.floor(+s.ccm||0)%1e4);
function body(req){return new Promise((ok,no)=>{let b='',n=0;req.on('data',c=>{n+=c.length;if(n>2e6){no(new Error('big'));req.destroy()}else b+=c});req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch(e){no(e)}})})}
function auth(req){const t=(req.headers.authorization||'').replace(/^Bearer /,'');if(!t)return null;const r=q.sGet.get(t);return r?r.uid:null}
function planOf(uid){const p=q.pGet.get(uid);return p&&p.exp>Date.now()?{id:p.pid,exp:p.exp}:{id:'',exp:0}}
// ---- validação de plausibilidade: o jogo roda no aparelho, então o servidor limita saltos absurdos para proteger o ranking
function sane(uid,sv){const old=q.stGet.get(uid),n=Date.now();if(!(sv.lv>=1&&sv.lv<=10000&&sv.st>=1&&sv.st<=1000))return false;if(!old)return sv.lv<=300&&sv.st<=100;
 const h=Math.max(.05,(n-old.updated)/36e5);return sv.lv-old.lv<=40+400*h&&sv.st-old.st<=5+40*h&&(+sv.pts||0)-old.pts<=2000+20000*h}
function putSave(uid,data,force){let sv;try{sv=typeof data=='string'?JSON.parse(data):data}catch(e){return{code:400,o:{err:'save inválido'}}}
 if(!sv||typeof sv!='object'||typeof sv.lv!='number')return{code:400,o:{err:'save inválido'}};
 const cur=q.svGet.get(uid),sc=score(sv),n=Date.now();
 if(cur&&!force&&cur.score>sc)return{code:409,o:{err:'conflito',cloud:{data:JSON.parse(cur.data),updated:cur.updated,score:cur.score}}};
 const ok=sane(uid,sv);q.svSet.run(uid,JSON.stringify(sv),sc,n);
 const old=q.stGet.get(uid);q.stSet.run(uid,sv.lv|0,Math.floor(sv.xp)||0,sv.st|0,Math.max(Math.floor(sv.pts)||0,old?old.pts:0),ok?(old?old.flag:0):1,n);
 if(ok&&sv.wid==weekId()&&sv.wk>0)q.wSet.run(uid,weekId(),Math.floor(sv.wk));
 return{code:200,o:{ok:true,updated:n,flag:!ok}}}
// ---- rotas
async function api(req,res,u){const m=req.method,p=u.pathname,ip=req.socket.remoteAddress;
 if(p=='/api/auth'&&m=='POST'){if(limited(ip))return J(res,429,{err:'Muitas tentativas. Espere alguns minutos.'});const b=await body(req),name=String(b.user||'').trim(),pw=String(b.pass||'');
  if(!/^[A-Za-z0-9_]{3,16}$/.test(name))return J(res,400,{err:'Usuário: 3 a 16 letras, números ou _.'});if(pw.length<6||pw.length>72)return J(res,400,{err:'Senha: 6 a 72 caracteres.'});
  let us=q.uByName.get(name);
  if(b.mode=='register'){if(us)return J(res,409,{err:'Esse usuário já existe.'});const salt=crypto.randomBytes(16).toString('hex');q.uNew.run(name,name,salt,hashPw(pw,salt),Date.now());us=q.uByName.get(name)}
  else{if(!us||!crypto.timingSafeEqual(Buffer.from(hashPw(pw,us.salt),'hex'),Buffer.from(us.hash,'hex')))return J(res,401,{err:'Usuário ou senha incorretos.'})}
  const tk=crypto.randomBytes(32).toString('hex');q.sNew.run(tk,us.id,Date.now());return J(res,200,{token:tk,name:us.display})}
 const uid=auth(req);if(!uid)return J(res,401,{err:'Entre na sua conta.'});
 if(p=='/api/logout'&&m=='POST'){q.sDel.run((req.headers.authorization||'').replace(/^Bearer /,''));return J(res,200,{ok:true})}
 if(p=='/api/me'&&m=='GET')return J(res,200,{name:q.uById.get(uid).display,plan:planOf(uid),week:weekId(),day:dayBR(),now:Date.now()});
 if(p=='/api/save'&&m=='GET'){const s=q.svGet.get(uid);return J(res,200,s?{data:JSON.parse(s.data),updated:s.updated,score:s.score}:{data:null})}
 if(p=='/api/save'&&m=='PUT'){const b=await body(req),r=putSave(uid,b.data,!!b.force);return J(res,r.code,r.o)}
 if(p=='/api/rank'&&m=='GET'){const t=u.searchParams.get('t')||'w',N=50,wid=weekId(),st=q.stGet.get(uid);let list,me=null;
  if(t=='w'){list=q.wTop.all(wid,N).map(x=>({n:x.n,p:x.p,me:x.uid==uid}));const w=q.wGet.get(uid,wid);if(w&&w.pts>0&&st&&!st.flag)me={pos:q.wPos.get(wid,w.pts,w.pts,uid).c,p:w.pts}}
  else if(t=='t'){list=q.tTop.all(N).map(x=>({n:x.n,p:x.p,me:x.uid==uid}));if(st&&!st.flag)me={pos:q.tPos.get(st.pts,st.pts,uid).c,p:st.pts}}
  else{list=q.nTop.all(N).map(x=>({n:x.n,p:x.p,me:x.uid==uid}));if(st&&!st.flag)me={pos:q.nPos.get(st.lv,st.lv,st.xp,st.lv,st.xp,uid).c,p:st.lv}}
  return J(res,200,{list,me,week:wid})}
 if(p=='/api/rewards'&&m=='GET'){const wid=weekId(),pend=[];
  for(const x of q.wList.all(uid,wid)){if(q.cGet.get(uid,'w'+x.wid))continue;const w=q.wGet.get(uid,x.wid),pos=db.prepare('SELECT COUNT(*)+1 c FROM weekly w JOIN stats s ON s.uid=w.uid WHERE w.wid=? AND s.flag=0 AND (w.pts>? OR (w.pts=? AND w.uid<?))').get(x.wid,w.pts,w.pts,uid).c;pend.push({kind:'w',wid:x.wid,pos,...reward(pos),skin:pos<=3?'s6':''})}
  const st=q.stGet.get(uid),d=dayBR();let daily={can:false};
  if(st&&!st.flag){const w=q.wGet.get(uid,wid),wp=w&&w.pts>0?q.wPos.get(wid,w.pts,w.pts,uid).c:0,np=q.nPos.get(st.lv,st.lv,st.xp,st.lv,st.xp,uid).c,t=dailyTier(wp,np);if(t)daily={can:!q.cGet.get(uid,'d'+d),...t,wp,np}}
  return J(res,200,{pending:pend,daily,day:d})}
 if(p=='/api/rewards/claim'&&m=='POST'){const b=await body(req);
  if(b.kind=='w'){const wid=b.wid|0;if(wid>=weekId())return J(res,400,{err:'Essa semana ainda não fechou.'});if(q.cGet.get(uid,'w'+wid))return J(res,409,{err:'Já recebido.'});
   const w=q.wGet.get(uid,wid);if(!w||w.pts<=0)return J(res,400,{err:'Sem pontos nessa semana.'});const pos=db.prepare('SELECT COUNT(*)+1 c FROM weekly w JOIN stats s ON s.uid=w.uid WHERE w.wid=? AND s.flag=0 AND (w.pts>? OR (w.pts=? AND w.uid<?))').get(wid,w.pts,w.pts,uid).c;
   q.cSet.run(uid,'w'+wid,Date.now());return J(res,200,{...reward(pos),pos,skin:pos<=3?'s6':''})}
  if(b.kind=='d'){const d=dayBR();if(q.cGet.get(uid,'d'+d))return J(res,409,{err:'Já recebido hoje.'});const st=q.stGet.get(uid);if(!st||st.flag)return J(res,400,{err:'Sem prêmio.'});
   const wid=weekId(),w=q.wGet.get(uid,wid),wp=w&&w.pts>0?q.wPos.get(wid,w.pts,w.pts,uid).c:0,np=q.nPos.get(st.lv,st.lv,st.xp,st.lv,st.xp,uid).c,t=dailyTier(wp,np);if(!t)return J(res,400,{err:'Entre no top 100 para ganhar o prêmio diário.'});
   q.cSet.run(uid,'d'+d,Date.now());return J(res,200,t)}
  return J(res,400,{err:'Pedido inválido.'})}

 if(p=='/api/cc'&&m=='GET'){const w=wal(uid);return J(res,200,ccInfo(w,q.gGet.get()))}
 if(p=='/api/cc/claim'&&m=='POST'){const b=await body(req),amt=r3(Math.max(0,Math.min(+b.amt||0,1e6)));
  const r=ccDo(uid,(w,g)=>{const room=Math.min(HR_CAP-w.hamt,DAY_CAP-w.damt,MAXS-g.mined),gr=r3(Math.max(0,Math.min(amt,room)));w.bal=r3(w.bal+gr);w.mined=r3(w.mined+gr);w.hamt=r3(w.hamt+gr);w.damt=r3(w.damt+gr);g.mined=r3(g.mined+gr);return{granted:gr,exhausted:MAXS-g.mined<.001}});return J(res,200,r)}
 if(p=='/api/cc/spend'&&m=='POST'){const b=await body(req),amt=r3(+b.amt||0);if(!(amt>0&&amt<=1e7))return J(res,400,{err:'Valor inválido.'});
  const r=ccDo(uid,(w,g)=>{if(w.bal+1e-9<amt)return{err:'CC insuficiente.',code:402};w.bal=r3(w.bal-amt);g.res=r3(g.res+amt);return{ok:true}});return J(res,r.err?r.code:200,r)}
 if(p=='/api/cc/sell'&&m=='POST'){const b=await body(req),n=Math.floor(+b.n||0);if(n<1)return J(res,400,{err:'Valor inválido.'});
  const r=ccDo(uid,(w,g)=>{if(w.bal+1e-9<n)return{err:'CC insuficiente.',code:402};if(w.bu+n>LIM_CC)return{err:'Limite diário de CC do Banco atingido.',code:429};w.bal=r3(w.bal-n);w.bu=r3(w.bu+n);g.res=r3(g.res+n*(1-BKF));g.lk=r3(g.lk+n*BKF);return{ok:true}});return J(res,r.err?r.code:200,r)}
 if(p=='/api/cc/buy'&&m=='POST'){const b=await body(req),n=Math.floor(+b.n||0);if(n<1)return J(res,400,{err:'Valor inválido.'});
  const r=ccDo(uid,(w,g)=>{if(Math.floor(g.res+1e-9)<n)return{err:'A reserva do Banco não tem tanto CC.',code:409};if(w.bu+n>LIM_CC)return{err:'Limite diário de CC do Banco atingido.',code:429};w.bal=r3(w.bal+n);w.bu=r3(w.bu+n);g.res=r3(g.res-n);return{ok:true}});return J(res,r.err?r.code:200,r)}
 if(p=='/api/plan/buy'&&m=='POST'){const b=await body(req),pl=PLANS[b.id];if(!pl)return J(res,400,{err:'Plano inválido.'});
  const r=ccDo(uid,(w,g)=>{if(w.bal+1e-9<pl.cost)return{err:'CC insuficiente para este plano.',code:402};w.bal=r3(w.bal-pl.cost);g.res=r3(g.res+pl.cost);const cur=q.pGet.get(uid),n=Date.now(),base=cur&&cur.pid==b.id&&cur.exp>n?cur.exp:n;q.pSet.run(uid,b.id,base+PLAN_MS,'');return{plan:{id:b.id,exp:base+PLAN_MS}}});return J(res,r.err?r.code:200,r)}
 J(res,404,{err:'Rota não encontrada.'})}
const PUB=path.join(__dirname,'public'),MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://x');
 res.setHeader('access-control-allow-origin',process.env.CORS_ORIGIN||'*');res.setHeader('access-control-allow-headers','authorization,content-type');res.setHeader('access-control-allow-methods','GET,POST,PUT,OPTIONS');
 if(req.method=='OPTIONS'){res.writeHead(204);return res.end()}
 if(u.pathname.startsWith('/api/'))return await api(req,res,u);
 let f=path.normalize(path.join(PUB,u.pathname=='/'?'index.html':u.pathname));if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
 res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)}catch(e){console.error(e);if(!res.headersSent)J(res,500,{err:'Erro no servidor.'});else res.end()}}).listen(PORT,()=>console.log('Chromora server em http://localhost:'+PORT));
module.exports={weekId,dayBR};
