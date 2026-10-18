import {neon} from '@neondatabase/serverless';
import {createHash,randomBytes} from 'node:crypto';
const hash=s=>createHash('sha256').update(String(s)).digest('hex');
const secret=(n=24)=>randomBytes(n).toString('base64url');
const err=(r,status,message)=>r.status(status).json({ok:false,error:message});
const admin=()=>String(process.env.ADMIN_ID||'').trim();
const bot=()=>process.env.TELEGRAM_TOKEN||process.env.TELEGRAM_BOT_TOKEN;
const cents=s=>{const m=/^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(String(s||'').trim());if(!m)return null;const n=Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));return n>=2000&&n<=100000000?n:null};
const allowed=s=>typeof s==='string'&&/^[\w:-]{8,110}$/.test(s);
const schema=[
"CREATE TABLE IF NOT EXISTS bella_users(telegram_id BIGINT PRIMARY KEY,username TEXT,first_name TEXT,language TEXT DEFAULT 'es',is_adult BOOLEAN DEFAULT FALSE,balance NUMERIC(12,2) DEFAULT 0,reserved_balance NUMERIC(12,2) DEFAULT 0,pix_key TEXT,state TEXT DEFAULT 'menu',created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS bella_content(id BIGSERIAL PRIMARY KEY,telegram_id BIGINT REFERENCES bella_users(telegram_id),file_id TEXT NOT NULL,media_type TEXT NOT NULL,status TEXT DEFAULT 'pending',created_at TIMESTAMPTZ DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS bella_withdrawals(id BIGSERIAL PRIMARY KEY,telegram_id BIGINT REFERENCES bella_users(telegram_id),amount NUMERIC(12,2) NOT NULL,pix_key TEXT,status TEXT DEFAULT 'pending',created_at TIMESTAMPTZ DEFAULT NOW())",
"ALTER TABLE bella_content ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(12,2)",
"ALTER TABLE bella_content ADD COLUMN IF NOT EXISTS web_request_key TEXT",
"ALTER TABLE bella_content ADD COLUMN IF NOT EXISTS web_send_method TEXT",
"CREATE UNIQUE INDEX IF NOT EXISTS bella_content_web_once ON bella_content(telegram_id,web_request_key) WHERE web_request_key IS NOT NULL",
"ALTER TABLE bella_withdrawals ADD COLUMN IF NOT EXISTS web_request_key TEXT",
"CREATE UNIQUE INDEX IF NOT EXISTS bella_withdrawals_web_once ON bella_withdrawals(telegram_id,web_request_key) WHERE web_request_key IS NOT NULL",
"CREATE TABLE IF NOT EXISTS bella_web_links(id TEXT PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,poll_hash TEXT NOT NULL,ip_hash TEXT NOT NULL,telegram_id BIGINT REFERENCES bella_users(telegram_id),created_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL)",
"CREATE INDEX IF NOT EXISTS bella_web_links_ip_idx ON bella_web_links(ip_hash,created_at)",
"CREATE TABLE IF NOT EXISTS bella_web_sessions(id BIGSERIAL PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,telegram_id BIGINT NOT NULL REFERENCES bella_users(telegram_id),expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW())"
];
let initialized=null;
async function ready(db){if(!initialized)initialized=(async()=>{for(const s of schema)await db.query(s,[])})().catch(e=>{initialized=null;throw e});return initialized}
async function telegram(method,body){
 if(!bot())throw Error('Telegram no configurado');
 const r=await fetch('https://api.telegram.org/bot'+bot()+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(14000)});
 const j=await r.json();if(!j.ok)throw Error('Error Telegram');return j.result;
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Cookie');
 const action=String(req.query?.action||'');
 try{
  if(!process.env.DATABASE_URL)return err(res,503,'Base de datos sin configurar');
  if(!['GET','POST'].includes(req.method))return err(res,405,'Método no permitido');
  if(req.method==='POST'&&req.headers.origin){let incoming;try{incoming=new URL(req.headers.origin)}catch{return err(res,403,'Origen no autorizado')};if(incoming.host!==req.headers.host||incoming.protocol!=='https:')return err(res,403,'Origen no autorizado')}
  const db=neon(process.env.DATABASE_URL);await ready(db);
  const q=(s,...values)=>db.query(s,values);
  if(req.method==='POST'&&action==='start'){
   const ip=String(req.headers['x-forwarded-for']||req.headers['x-real-ip']||'unknown').split(',')[0],ipHash=hash('BellaWeb:'+ip);
   const count=await q("SELECT COUNT(*)::int AS n FROM bella_web_links WHERE ip_hash=$1 AND created_at>NOW()-INTERVAL '15 minutes'",ipHash);
   if(Number(count[0]?.n||0)>=8)return err(res,429,'Demasiados intentos. Prueba después');
   const id=secret(18),poll=secret(32),code=randomBytes(6).toString('hex').toUpperCase();
   await q("INSERT INTO bella_web_links(id,code_hash,poll_hash,ip_hash,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')",id,hash(code),hash(poll),ipHash);
   let botUsername=null;try{const identity=await telegram('getMe',{});if(/^[a-zA-Z0-9_]{5,32}$/.test(identity?.username||''))botUsername=identity.username}catch(e){console.warn('Bot username lookup unavailable')}
   return res.json({ok:true,pairId:id,pollSecret:poll,code,botUsername});
  }
  if(req.method==='POST'&&action==='link'){
   const {pairId,pollSecret}=req.body||{};
   if(!allowed(pairId)||!allowed(pollSecret))return err(res,400,'Código inválido');
   const linked=await q('SELECT telegram_id FROM bella_web_links WHERE id=$1 AND poll_hash=$2 AND expires_at>NOW()',pairId,hash(pollSecret));
   if(!linked.length)return err(res,410,'Código caducado');
   if(!linked[0].telegram_id)return res.json({ok:true,linked:false});
   const adult=await q('SELECT is_adult FROM bella_users WHERE telegram_id=$1',linked[0].telegram_id);
   if(!adult[0]?.is_adult)return err(res,403,'Debes completar el registro +18 en Telegram');
   const taken=await q('DELETE FROM bella_web_links WHERE id=$1 AND poll_hash=$2 AND telegram_id=$3 RETURNING telegram_id',pairId,hash(pollSecret),linked[0].telegram_id);
   if(!taken.length)return err(res,409,'Código ya usado');
   const session=secret(32);
   await q("INSERT INTO bella_web_sessions(token_hash,telegram_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",hash(session),taken[0].telegram_id);
   res.setHeader('Set-Cookie','bella_session='+session+'; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax');
   return res.json({ok:true,linked:true});
  }
  const auth=/^Bearer ([A-Za-z0-9_-]{32,180})$/.exec(String(req.headers.authorization||''));
  const cookie=/(?:^|;\s*)bella_session=([A-Za-z0-9_-]{32,180})(?:;|$)/.exec(String(req.headers.cookie||''));
  const presented=auth?.[1]||cookie?.[1];
  if(!presented)return err(res,401,'Vincula tu Telegram');
  const sessions=await q('SELECT u.telegram_id,u.first_name,u.username,u.language,u.is_adult,u.balance,u.reserved_balance,s.id AS session_id FROM bella_web_sessions s JOIN bella_users u ON u.telegram_id=s.telegram_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND s.revoked_at IS NULL',hash(presented));
  const u=sessions[0];if(!u)return err(res,401,'Sesión vencida');if(!u.is_adult)return err(res,403,'Solo +18');
  if(req.method==='GET'&&action==='me')return res.json({ok:true,user:{id:String(u.telegram_id),name:u.first_name||u.username||'Usuario',username:u.username||'',language:u.language,balance:Number(u.balance),reserved:Number(u.reserved_balance),admin:admin()===String(u.telegram_id)}});
  if(req.method==='GET'&&action==='history'){
   const posts=await q('SELECT id,media_type,status,payout_amount,created_at FROM bella_content WHERE telegram_id=$1 ORDER BY id DESC LIMIT 50',u.telegram_id);
   const withdrawals=await q('SELECT id,amount,status,created_at FROM bella_withdrawals WHERE telegram_id=$1 ORDER BY id DESC LIMIT 50',u.telegram_id);
   return res.json({ok:true,posts:posts.map(p=>({...p,id:Number(p.id),payout_amount:p.payout_amount==null?null:Number(p.payout_amount)})),withdrawals:withdrawals.map(w=>({...w,id:Number(w.id),amount:Number(w.amount)}))});
  }
  if(req.method==='POST'&&action==='withdraw'){
   const n=cents(req.body?.amount),pix=String(req.body?.pix||'').trim(),requestKey=String(req.body?.requestKey||'');
   if(n===null||pix.length<3||pix.length>160||/[\r\n\x00-\x1f]/.test(pix)||!allowed(requestKey))return err(res,400,'Mínimo R$20 y clave PIX válida');
   const price=(n/100).toFixed(2);
   let rows=[];
   try{rows=await q("WITH reserved AS (UPDATE bella_users SET balance=balance-$2::numeric,reserved_balance=reserved_balance+$2::numeric,updated_at=NOW() WHERE telegram_id=$1 AND is_adult=TRUE AND balance>=$2::numeric RETURNING telegram_id), saved AS (INSERT INTO bella_withdrawals(telegram_id,amount,pix_key,status,web_request_key) SELECT telegram_id,$2::numeric,$3,'pending',$4 FROM reserved RETURNING id) SELECT id FROM saved",u.telegram_id,price,pix,requestKey)}
   catch(e){if(e.code!=='23505')throw e}
   if(!rows.length){const old=await q('SELECT id FROM bella_withdrawals WHERE telegram_id=$1 AND web_request_key=$2',u.telegram_id,requestKey);if(old.length)return res.json({ok:true,id:Number(old[0].id),duplicate:true});return err(res,409,'Saldo insuficiente')}
   const id=Number(rows[0].id);
   try{if(/^\d+$/.test(admin()))await telegram('sendMessage',{chat_id:admin(),text:'💸 BELLA CLUB · PIX #'+id+'\nUsuario: '+u.telegram_id+'\nImporte: R$ '+price+'\nClave: '+pix+'\nPagar manualmente antes de confirmar.',reply_markup:{inline_keyboard:[[{text:'✅ Marcar pagado',callback_data:'webwd_paid_'+id},{text:'❌ Rechazar y devolver',callback_data:'webwd_reject_'+id}]]}})}catch(e){console.warn('PIX notify',e.message)}
   return res.status(201).json({ok:true,id});
  }
  if(req.method==='POST'&&action==='upload'){
   const {base64,mime,requestKey}=req.body||{};
   const images=['image/jpeg','image/png','image/webp'];
   const videos=['video/mp4','video/quicktime','video/webm'];
   const isVideo=videos.includes(mime);
   if(typeof base64!=='string'||base64.length>(isVideo?3740000:2050000)||!([...images,...videos].includes(mime))||!allowed(requestKey)||!/^[A-Za-z0-9+/=]+$/.test(base64))return err(res,400,'Formato no admitido o archivo demasiado grande');
   const bytes=Buffer.from(base64,'base64');
   const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
   const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
   const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
   const mp4=bytes.toString('ascii',4,8)==='ftyp';
   const webm=bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3;
   const valid=isVideo?(bytes.length>=256&&bytes.length<=2700000&&(mime==='video/webm'?webm:mp4)):(bytes.length>=100&&bytes.length<=1500000&&((mime==='image/jpeg'&&jpg)||(mime==='image/png'&&png)||(mime==='image/webp'&&webp)));
   if(!valid)return err(res,400,isVideo?'Video inválido o de más de 2,7 MB':'Imagen inválida o de más de 1,5 MB');
   const old=await q('SELECT id FROM bella_content WHERE telegram_id=$1 AND web_request_key=$2',u.telegram_id,requestKey);
   if(old.length)return res.json({ok:true,id:Number(old[0].id),duplicate:true});
   if(!/^\d+$/.test(admin())||!bot())return err(res,503,'Bot o administrador no configurados');
   const method=isVideo&&mime!=='video/mp4'?'sendDocument':(isVideo?'sendVideo':'sendPhoto');
   const field=method==='sendDocument'?'document':(isVideo?'video':'photo');
   const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm'})[mime];
   const form=new FormData();form.append('chat_id',admin());form.append('caption','📥 Bella Club · '+(isVideo?'Video':'Foto')+' desde web');form.append(field,new Blob([bytes],{type:mime}),'bella-'+Date.now()+'.'+ext);
   const response=await fetch('https://api.telegram.org/bot'+bot()+'/'+method,{method:'POST',body:form,signal:AbortSignal.timeout(22000)});
   let json;try{json=await response.json()}catch{throw Error('Respuesta inválida del servidor de Telegram')}
   const media=json?.result?.[field],item=Array.isArray(media)?media.at(-1):media;
   if(!json?.ok||!item?.file_id)return err(res,502,'Telegram no pudo recibir el archivo. Intenta desde el bot');
   const rows=await q("INSERT INTO bella_content(telegram_id,file_id,media_type,status,web_request_key,web_send_method) VALUES($1,$2,$3,'pending',$4,$5) ON CONFLICT(telegram_id,web_request_key) WHERE web_request_key IS NOT NULL DO UPDATE SET web_request_key=EXCLUDED.web_request_key RETURNING id",u.telegram_id,item.file_id,isVideo?'video':'photo',requestKey,method==='sendDocument'?'document':null);
   const id=Number(rows[0].id);
   const caption='📥 BELLA CLUB · Publicación #'+id+'\n👤 '+(u.username||u.first_name||'Usuario')+'\n'+(isVideo?'🎥 Video':'📷 Foto')+' enviado desde web';
   try{await telegram('editMessageCaption',{chat_id:admin(),message_id:json.result.message_id,caption,reply_markup:{inline_keyboard:[[{text:'✅ Aprobar',callback_data:'review_approve_'+id},{text:'❌ Rechazar',callback_data:'review_reject_'+id}]]}})}catch(e){console.warn('No se pudo agregar botón revisión',e.message)}
   return res.status(201).json({ok:true,id,mediaType:isVideo?'video':'photo'});
  }
  if(req.method==='GET'&&action==='admin'){
   if(String(u.telegram_id)!==admin())return err(res,403,'Solo administrador');
   const counts=await q('SELECT status,COUNT(*)::int AS n FROM bella_content GROUP BY status');
   const pending=await q("SELECT id,amount,telegram_id,pix_key FROM bella_withdrawals WHERE status='pending' ORDER BY id DESC LIMIT 25");
   return res.json({ok:true,counts,pending:pending.map(w=>({...w,id:Number(w.id),amount:Number(w.amount),telegram_id:String(w.telegram_id)}))});
  }
  if(req.method==='POST'&&action==='logout'){await q('UPDATE bella_web_sessions SET revoked_at=NOW() WHERE id=$1',u.session_id);res.setHeader('Set-Cookie','bella_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax');return res.json({ok:true})}
  return err(res,404,'Ruta no encontrada');
 }catch(e){console.error('Bella web',action,e?.message||e);return err(res,500,'No se pudo completar la operación')}
}