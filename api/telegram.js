import { neon } from '@neondatabase/serverless';
const token=()=>process.env.TELEGRAM_TOKEN||process.env.TELEGRAM_BOT_TOKEN;
const sql=()=>neon(process.env.DATABASE_URL);
async function tg(method,body){const r=await fetch(`https://api.telegram.org/bot${token()}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.description||'Telegram error');return j.result;}
async function init(db){await db`CREATE TABLE IF NOT EXISTS bella_users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, language TEXT DEFAULT 'es', is_adult BOOLEAN DEFAULT FALSE, balance NUMERIC(12,2) DEFAULT 0, reserved_balance NUMERIC(12,2) DEFAULT 0, pix_key TEXT, state TEXT DEFAULT 'menu', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`;await db`CREATE TABLE IF NOT EXISTS bella_content (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT REFERENCES bella_users(telegram_id), file_id TEXT NOT NULL, media_type TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`;await db`CREATE TABLE IF NOT EXISTS bella_withdrawals (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT REFERENCES bella_users(telegram_id), amount NUMERIC(12,2) NOT NULL, pix_key TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`;}
const menu={keyboard:[[{text:'👤 Mi perfil'},{text:'💰 Saldo'}],[{text:'📸 Enviar contenido'},{text:'💸 Retirar PIX'}],[{text:'📜 Historial'}]],resize_keyboard:true};

const adminId=()=>String(process.env.ADMIN_ID||'').trim();
const reviewButtons=id=>({inline_keyboard:[[{text:'✅ Aprobar',callback_data:'review_approve_'+id},{text:'❌ Rechazar',callback_data:'review_reject_'+id}]]});
function reviewCaption({id,chat,username,type,caption}){
 const who=username?'@'+String(username).replace(/[^a-zA-Z0-9_]/g,'').slice(0,60):'Sin usuario público';
 return ('📥 BELLA CLUB · Publicación #'+id+'\n👤 '+who+'\n🆔 '+chat+'\n📎 '+(type==='video'?'Video':'Foto')+'\n\n'+String(caption||'').slice(0,500)).slice(0,1000);
}
async function sendReview({id,chat,username,type,caption,messageId,fileId}){
 if(!/^\d+$/.test(adminId()))throw new Error('ADMIN_ID no configurado');
 const label=reviewCaption({id,chat,username,type,caption});
 const reply_markup=reviewButtons(id);
 if(messageId){
  try{return await tg('copyMessage',{chat_id:adminId(),from_chat_id:chat,message_id:messageId,caption:label,reply_markup});}
  catch(e){console.warn('copy_to_admin_failed',id,e.message);}
 }
 const mediaMethod=type==='video'?'sendVideo':'sendPhoto';
 const mediaKey=type==='video'?'video':'photo';
 return await tg(mediaMethod,{chat_id:adminId(),[mediaKey]:fileId,caption:label,reply_markup});
}
async function pendingForAdmin(db){
 const items=await db`SELECT id,telegram_id,file_id,media_type FROM bella_content WHERE status='pending' ORDER BY id ASC LIMIT 5`;
 if(!items.length){await tg('sendMessage',{chat_id:adminId(),text:'✅ No hay publicaciones pendientes.'});return;}
 await tg('sendMessage',{chat_id:adminId(),text:'📥 Publicaciones pendientes: '+items.length+' (máximo 5 por consulta).'});
 for(const item of items){
  try{await sendReview({id:item.id,chat:item.telegram_id,type:item.media_type,fileId:item.file_id});}
  catch(e){console.error('pending_delivery_failed',item.id,e.message);await tg('sendMessage',{chat_id:adminId(),text:'⚠️ No se pudo entregar la publicación #'+item.id+'. Está guardada en la base de datos.'});}
 }
}

export default async function handler(req,res){if(req.method!=='POST')return res.status(200).json({ok:true});try{if(!token()||!process.env.DATABASE_URL)throw new Error('Configuration missing');const db=sql();await init(db);const u=req.body||{};const m=u.message||u.callback_query?.message;const chat=m?.chat?.id;if(!chat)return res.status(200).json({ok:true});const from=u.message?.from||u.callback_query?.from||{};await db`INSERT INTO bella_users(telegram_id,username,first_name) VALUES(${chat},${from.username||null},${from.first_name||null}) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()`;const text=u.message?.text||'';const cb=u.callback_query?.data||'';
if(cb.startsWith('lang_')){const lang=cb.slice(5);await db`UPDATE bella_users SET language=${lang} WHERE telegram_id=${chat}`;await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});await tg('sendMessage',{chat_id:chat,text:'🔞 Bella Club es solo para mayores de 18 años.\n\n¿Confirmas que tienes 18 años o más?',reply_markup:{inline_keyboard:[[{text:'✅ Sí, soy +18',callback_data:'adult_yes'},{text:'❌ No',callback_data:'adult_no'}]]}});return res.status(200).json({ok:true});}
if(cb==='adult_yes'){await db`UPDATE bella_users SET is_adult=TRUE,state='menu' WHERE telegram_id=${chat}`;await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});await tg('sendMessage',{chat_id:chat,text:'🔥 BELLA CLUB\n\n✅ Registro completado.\nElige una opción:',reply_markup:menu});return res.status(200).json({ok:true});}
if(cb==='adult_no'){await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});await tg('sendMessage',{chat_id:chat,text:'❌ Este servicio es solo para mayores de 18 años.'});return res.status(200).json({ok:true});}

if(cb.startsWith('review_')){
 const match=/^review_(approve|reject)_(\d+)$/.exec(cb);
 if(!match||String(from.id)!==adminId()){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Acceso no autorizado',show_alert:true});
  return res.status(200).json({ok:true});
 }
 const contentId=Number(match[2]);
 const status=match[1]==='approve'?'approved':'rejected';
 const updated=await db`UPDATE bella_content SET status=${status} WHERE id=${contentId} AND status='pending' RETURNING id,telegram_id`;
 await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:updated.length?'Decisión registrada':'Ya se había revisado'});
 if(updated.length){
  try{await tg('editMessageReplyMarkup',{chat_id:chat,message_id:m.message_id,reply_markup:{inline_keyboard:[]}});}catch(e){console.warn('edit_review_buttons',e.message);}
  try{await tg('sendMessage',{chat_id:chat,text:(status==='approved'?'✅ Aprobado':'❌ Rechazado')+' · Publicación #'+contentId});}catch(e){console.warn('admin_confirmation_failed',e.message);}
  try{await tg('sendMessage',{chat_id:String(updated[0].telegram_id),text:status==='approved'?'✅ Tu publicación #'+contentId+' fue aprobada.':'❌ Tu publicación #'+contentId+' fue rechazada.'});}catch(e){console.warn('creator_notification_failed',e.message);}
 }
 return res.status(200).json({ok:true});
}
if(text==='/pendientes'&&String(from.id)===adminId()){
 await pendingForAdmin(db);
 return res.status(200).json({ok:true});
}

if(text==='/start'){await tg('sendMessage',{chat_id:chat,text:'🔥 Bienvenido a Bella Club\n\n🌐 Selecciona tu idioma:',reply_markup:{inline_keyboard:[[{text:'🇪🇸 Español',callback_data:'lang_es'},{text:'🇧🇷 Português',callback_data:'lang_pt'}],[{text:'🇺🇸 English',callback_data:'lang_en'}]]}});return res.status(200).json({ok:true});}
const rows=await db`SELECT * FROM bella_users WHERE telegram_id=${chat}`;const user=rows[0];if(!user?.is_adult){await tg('sendMessage',{chat_id:chat,text:'Escribe /start para completar el registro.'});return res.status(200).json({ok:true});}
if(text==='💰 Saldo'){await tg('sendMessage',{chat_id:chat,text:`💰 Saldo disponible: R$ ${Number(user.balance||0).toFixed(2)}\n🔒 Reservado: R$ ${Number(user.reserved_balance||0).toFixed(2)}`,reply_markup:menu});return res.status(200).json({ok:true});}
if(text==='👤 Mi perfil'){await tg('sendMessage',{chat_id:chat,text:`👤 Perfil Bella Club\n\nNombre: ${user.first_name||'-'}\nUsuario: ${user.username?'@'+user.username:'-'}\nIdioma: ${user.language}\n+18: ✅`,reply_markup:menu});return res.status(200).json({ok:true});}
if(text==='📸 Enviar contenido'){await db`UPDATE bella_users SET state='await_content' WHERE telegram_id=${chat}`;await tg('sendMessage',{chat_id:chat,text:'📸 Envíame ahora una foto o video para revisión.'});return res.status(200).json({ok:true});}
if(u.message?.photo||u.message?.video){
 const type=u.message.video?'video':'photo';
 const fid=u.message.video?.file_id||u.message.photo?.at(-1)?.file_id;
 const saved=await db`INSERT INTO bella_content(telegram_id,file_id,media_type) VALUES(${chat},${fid},${type}) RETURNING id`;
 const contentId=saved[0].id;
 await db`UPDATE bella_users SET state='menu' WHERE telegram_id=${chat}`;
 let delivered=true;
 try{await sendReview({id:contentId,chat,username:from.username,type,caption:u.message.caption,messageId:u.message.message_id,fileId:fid});}
 catch(e){delivered=false;console.error('admin_delivery_failed',contentId,e.message);}
 await tg('sendMessage',{chat_id:chat,text:delivered?'✅ Contenido recibido y enviado a revisión. #'+contentId:'✅ Tu contenido #'+contentId+' quedó guardado. ⚠️ La notificación al administrador falló; la publicación sigue pendiente de revisión.',reply_markup:menu});
 return res.status(200).json({ok:true});
}

if(text==='💸 Retirar PIX'){if(Number(user.balance)<20){await tg('sendMessage',{chat_id:chat,text:'⚠️ El retiro mínimo es R$ 20. Tu saldo disponible todavía no alcanza el mínimo.',reply_markup:menu});}else{await db`UPDATE bella_users SET state='await_pix' WHERE telegram_id=${chat}`;await tg('sendMessage',{chat_id:chat,text:'💳 Envíame tu clave PIX.'});}return res.status(200).json({ok:true});}
if(text==='📜 Historial'){const c=await db`SELECT id,media_type,status,created_at FROM bella_content WHERE telegram_id=${chat} ORDER BY id DESC LIMIT 5`;const w=await db`SELECT id,amount,status,created_at FROM bella_withdrawals WHERE telegram_id=${chat} ORDER BY id DESC LIMIT 5`;let out='📜 Historial\n';for(const x of c)out+=`\n📸 #${x.id} ${x.media_type} — ${x.status}`;for(const x of w)out+=`\n💸 #${x.id} R$ ${Number(x.amount).toFixed(2)} — ${x.status}`;if(!c.length&&!w.length)out+='\n\nTodavía no tienes movimientos.';await tg('sendMessage',{chat_id:chat,text:out,reply_markup:menu});return res.status(200).json({ok:true});}
await tg('sendMessage',{chat_id:chat,text:'🔥 BELLA CLUB\n\nElige una opción:',reply_markup:menu});return res.status(200).json({ok:true});}catch(e){console.error('telegram_error',e);return res.status(500).json({ok:false,error:e.message});}}