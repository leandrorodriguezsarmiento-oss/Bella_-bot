import { neon } from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
const token=()=>process.env.TELEGRAM_TOKEN||process.env.TELEGRAM_BOT_TOKEN;
const sql=()=>neon(process.env.DATABASE_URL);
async function tg(method,body){const r=await fetch(`https://api.telegram.org/bot${token()}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.description||'Telegram error');return j.result;}
async function init(db){await db`CREATE TABLE IF NOT EXISTS bella_users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, language TEXT DEFAULT 'es', is_adult BOOLEAN DEFAULT FALSE, balance NUMERIC(12,2) DEFAULT 0, reserved_balance NUMERIC(12,2) DEFAULT 0, pix_key TEXT, state TEXT DEFAULT 'menu', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`;await db`CREATE TABLE IF NOT EXISTS bella_content (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT REFERENCES bella_users(telegram_id), file_id TEXT NOT NULL, media_type TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`;await db`CREATE TABLE IF NOT EXISTS bella_withdrawals (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT REFERENCES bella_users(telegram_id), amount NUMERIC(12,2) NOT NULL, pix_key TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`;}
const menu={keyboard:[[{text:'👤 Mi perfil'},{text:'💰 Saldo'}],[{text:'📸 Enviar contenido'},{text:'💸 Retirar PIX'}],[{text:'📜 Historial'}]],resize_keyboard:true};

const adminId=()=>String(process.env.ADMIN_ID||'').trim();
const isAdmin=id=>String(id||'')===adminId();
const adminMenu={keyboard:[[{text:'📥 Revisar pendientes'},{text:'📊 Resumen'}],[{text:'🏠 Panel admin'}]],resize_keyboard:true,is_persistent:true,one_time_keyboard:false,input_field_placeholder:'Revisión de publicaciones'};

async function ensureApprovalSchema(db){
 await db`ALTER TABLE bella_content ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(12,2)`;
 await db`CREATE TABLE IF NOT EXISTS bella_admin_payment_drafts (admin_id BIGINT PRIMARY KEY, content_id BIGINT NOT NULL, amount NUMERIC(12,2), review_message_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
}
function parseReais(value){
 const raw=String(value||'').trim().replace(/^R\$\s*/i,'').replace(/\s/g,'');
 if(!/^\d{1,5}(?:[.,]\d{1,2})?$/.test(raw))return null;
 const valueNumber=Number(raw.replace(',','.'));
 if(!Number.isFinite(valueNumber)||valueNumber<0.01||valueNumber>10000)return null;
 return Math.round(valueNumber*100);
}
const formatReais=cents=>'R$ '+(Number(cents)/100).toFixed(2).replace('.',',');
function payConfirmKeyboard(contentId,cents){
 return {inline_keyboard:[
  [{text:'✅ Confirmar '+formatReais(cents),callback_data:'pay_confirm_'+contentId}],
  [{text:'✏️ Cambiar importe',callback_data:'pay_edit_'+contentId},{text:'❌ Cancelar',callback_data:'pay_cancel_'+contentId}]
 ]};
}
async function paymentDraft(db,admin){
 const rows=await db`SELECT content_id,amount,review_message_id FROM bella_admin_payment_drafts WHERE admin_id=${admin} LIMIT 1`;
 return rows[0]||null;
}
async function startApproval(db,admin,contentId,reviewMessageId,chat){
 await ensureApprovalSchema(db);
 const pending=await db`SELECT id FROM bella_content WHERE id=${contentId} AND status='pending'`;
 if(!pending.length){
  await tg('sendMessage',{chat_id:chat,text:'⚠️ Esta publicación ya fue revisada. No se aplicó ningún pago.',reply_markup:adminMenu});
  return false;
 }
 await db`INSERT INTO bella_admin_payment_drafts(admin_id,content_id,amount,review_message_id,created_at) VALUES(${admin},${contentId},NULL,${reviewMessageId||null},NOW()) ON CONFLICT(admin_id) DO UPDATE SET content_id=EXCLUDED.content_id,amount=NULL,review_message_id=EXCLUDED.review_message_id,created_at=NOW()`;
 await tg('sendMessage',{chat_id:chat,text:'💵 Publicación #'+contentId+'\\n\\n¿Cuánto quieres abonar al saldo del usuario por aprobarla?\\n\\nEscribe una cantidad en reales (por ejemplo: 5,00 o 12,50).\\n\\nNo se abonará nada hasta que lo confirmes. Para cancelar envía /cancelar.',reply_markup:adminMenu});
 return true;
}

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
 if(!items.length){await tg('sendMessage',{chat_id:adminId(),text:'✅ No hay publicaciones pendientes.',reply_markup:adminMenu});return;}
 await tg('sendMessage',{chat_id:adminId(),text:'📥 Publicaciones pendientes: '+items.length+' (máximo 5 por consulta).',reply_markup:adminMenu});
 for(const item of items){
  try{await sendReview({id:item.id,chat:item.telegram_id,type:item.media_type,fileId:item.file_id});}
  catch(e){console.error('pending_delivery_failed',item.id,e.message);await tg('sendMessage',{chat_id:adminId(),text:'⚠️ No se pudo entregar la publicación #'+item.id+'. Está guardada en la base de datos.'});}
 }
}

export default async function handler(req,res){
 if(req.method!=='POST')return res.status(200).json({ok:true});
 const rawSecret=process.env.WEBHOOK_SECRET;
 const actualSecret=req.headers?.['x-telegram-bot-api-secret-token'];
 const expectedSecret=rawSecret?createHash('sha256').update(rawSecret).digest('hex'):null;
 if(!expectedSecret||actualSecret!==expectedSecret)return res.status(403).json({ok:false,error:'Invalid webhook signature'});
 try{if(!token()||!process.env.DATABASE_URL)throw new Error('Configuration missing');const db=sql();await init(db);const u=req.body||{};const m=u.message||u.callback_query?.message;const chat=m?.chat?.id;if(!chat)return res.status(200).json({ok:true});const from=u.message?.from||u.callback_query?.from||{};await db`INSERT INTO bella_users(telegram_id,username,first_name) VALUES(${chat},${from.username||null},${from.first_name||null}) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()`;const text=u.message?.text||'';const cb=u.callback_query?.data||'';
if(isAdmin(from.id)&&(cb.startsWith('lang_')||cb==='adult_yes'||cb==='adult_no')){
 await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Usa el panel administrador.'});
 await tg('sendMessage',{chat_id:chat,text:'🛡️ BELLA CLUB · Panel administrador',reply_markup:adminMenu});
 return res.status(200).json({ok:true});
}
if(cb.startsWith('lang_')){const lang=cb.slice(5);await db`UPDATE bella_users SET language=${lang} WHERE telegram_id=${chat}`;await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});await tg('sendMessage',{chat_id:chat,text:'🔞 Bella Club es solo para mayores de 18 años.\n\n¿Confirmas que tienes 18 años o más?',reply_markup:{inline_keyboard:[[{text:'✅ Sí, soy +18',callback_data:'adult_yes'},{text:'❌ No',callback_data:'adult_no'}]]}});return res.status(200).json({ok:true});}
if(cb==='adult_yes'){await db`UPDATE bella_users SET is_adult=TRUE,state='menu' WHERE telegram_id=${chat}`;await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});await tg('sendMessage',{chat_id:chat,text:'🔥 BELLA CLUB\n\n✅ Registro completado.\nElige una opción:',reply_markup:menu});return res.status(200).json({ok:true});}
if(cb==='adult_no'){await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});await tg('sendMessage',{chat_id:chat,text:'❌ Este servicio es solo para mayores de 18 años.'});return res.status(200).json({ok:true});}


if(cb.startsWith('review_')){
 const match=/^review_(approve|reject)_(\d+)$/.exec(cb);
 if(!match||!isAdmin(from.id)){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Acceso no autorizado',show_alert:true});
  return res.status(200).json({ok:true});
 }
 const contentId=Number(match[2]);
 if(match[1]==='approve'){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Introduce la cantidad en reales'});
  await startApproval(db,from.id,contentId,m?.message_id,chat);
  return res.status(200).json({ok:true});
 }
 const rejected=await db`UPDATE bella_content SET status='rejected' WHERE id=${contentId} AND status='pending' RETURNING id,telegram_id`;
 await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:rejected.length?'Rechazado':'Ya revisado'});
 if(rejected.length){
  try{await tg('editMessageReplyMarkup',{chat_id:chat,message_id:m.message_id,reply_markup:{inline_keyboard:[]}});}catch(e){console.warn('reject_button_clear_failed',e.message);}
  try{await tg('sendMessage',{chat_id:chat,text:'❌ Rechazado · Publicación #'+contentId,reply_markup:adminMenu});}catch(e){console.warn('reject_admin_ack_failed',e.message);}
  try{await tg('sendMessage',{chat_id:String(rejected[0].telegram_id),text:'❌ Tu publicación #'+contentId+' fue rechazada.'});}catch(e){console.warn('reject_user_notification_failed',e.message);}
 }
 return res.status(200).json({ok:true});
}
if(cb.startsWith('pay_')){
 const match=/^pay_(confirm|edit|cancel)_(\d+)$/.exec(cb);
 if(!match||!isAdmin(from.id)){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Acceso no autorizado',show_alert:true});
  return res.status(200).json({ok:true});
 }
 const action=match[1],contentId=Number(match[2]);
 await ensureApprovalSchema(db);
 const draft=await paymentDraft(db,from.id);
 if(!draft||Number(draft.content_id)!==contentId){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Esta confirmación ya no está activa',show_alert:true});
  return res.status(200).json({ok:true});
 }
 if(action==='cancel'){
  await db`DELETE FROM bella_admin_payment_drafts WHERE admin_id=${from.id} AND content_id=${contentId}`;
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Operación cancelada'});
  await tg('sendMessage',{chat_id:chat,text:'🚫 Cancelado. La publicación #'+contentId+' sigue pendiente y no se modificó ningún saldo.',reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 if(action==='edit'){
  await db`UPDATE bella_admin_payment_drafts SET amount=NULL WHERE admin_id=${from.id} AND content_id=${contentId}`;
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Escribe el nuevo importe'});
  await tg('sendMessage',{chat_id:chat,text:'✏️ Introduce el nuevo importe en reales para la publicación #'+contentId+'. Ejemplo: 7,50',reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 if(draft.amount===null||draft.amount===undefined){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'Introduce primero el importe',show_alert:true});
  return res.status(200).json({ok:true});
 }
 const amount=Number(draft.amount);
 const cents=Math.round(amount*100);
 if(!Number.isFinite(cents)||cents<=0||cents>1000000)throw Error('Importe de pago fuera de rango');
 // Una sola transacción SQL: aprobar y sumar saldo, solo si continúa pendiente.
 const paid=await db`WITH approved AS (
   UPDATE bella_content SET status='approved',payout_amount=${amount}
   WHERE id=${contentId} AND status='pending'
   RETURNING id,telegram_id
  ), credited AS (
   UPDATE bella_users AS u SET balance=u.balance+${amount},updated_at=NOW()
   FROM approved a WHERE u.telegram_id=a.telegram_id
   RETURNING u.telegram_id,u.balance
  )
  SELECT a.id,a.telegram_id,c.balance FROM approved a INNER JOIN credited c ON c.telegram_id=a.telegram_id`;
 await db`DELETE FROM bella_admin_payment_drafts WHERE admin_id=${from.id} AND content_id=${contentId}`;
 await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:paid.length?'Saldo abonado':'Publicación ya revisada'});
 if(!paid.length){
  await tg('sendMessage',{chat_id:chat,text:'⚠️ La publicación #'+contentId+' ya estaba revisada. No se duplicó ningún abono.',reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 const balance=Number(paid[0].balance);
 try{await tg('editMessageReplyMarkup',{chat_id:chat,message_id:Number(draft.review_message_id),reply_markup:{inline_keyboard:[]}});}catch(e){console.warn('approved_button_clear_failed',e.message);}
 try{await tg('sendMessage',{chat_id:chat,text:'✅ Publicación #'+contentId+' aprobada\\n💵 Abonado al saldo: '+formatReais(cents)+'\\n💰 Nuevo saldo del usuario: '+formatReais(Math.round(balance*100))+'\\n\\nEl PIX se paga manualmente cuando corresponda.',reply_markup:adminMenu});}catch(e){console.warn('approval_admin_ack_failed',e.message);}
 try{await tg('sendMessage',{chat_id:String(paid[0].telegram_id),text:'✅ Tu publicación #'+contentId+' fue aprobada.\\n💵 Se añadieron '+formatReais(cents)+' a tu saldo.\\n💰 Saldo actual: '+formatReais(Math.round(balance*100))+'\\n\\nPuedes consultar tu saldo y solicitar retiro PIX cuando alcances R$ 20,00.'});}catch(e){console.warn('approval_creator_notice_failed',e.message);}
 return res.status(200).json({ok:true});
}

if(text==='/miid'||text==='/id'){
 const myId=String(from.id||chat);
 await tg('sendMessage',{chat_id:chat,text:'🪪 Identificación de Telegram\n\nTu ID: '+myId+'\nAcceso administrador: '+(myId===adminId()?'✅ Sí':'❌ No')+'\n\nSi no coincide, el ADMIN_ID de Bella Club debe actualizarse al ID de tu cuenta.'});
 return res.status(200).json({ok:true});
}
// El administrador tiene un panel exclusivo; no utiliza el menú de clientes.
if(isAdmin(from.id)){
 if(text==='/cancelar'){
  await ensureApprovalSchema(db);
  await db`DELETE FROM bella_admin_payment_drafts WHERE admin_id=${from.id}`;
  await tg('sendMessage',{chat_id:chat,text:'🚫 Operación cancelada. No se ha abonado ningún importe.',reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 if(u.message?.text && !['/start','/admin','/panel','/pendientes','/miid','/id','🏠 Panel admin','📥 Revisar pendientes','📊 Resumen'].includes(text)){
  await ensureApprovalSchema(db);
  const draft=await paymentDraft(db,from.id);
  if(draft){
   const cents=parseReais(text);
   if(cents===null){
    await tg('sendMessage',{chat_id:chat,text:'⚠️ Cantidad no válida. Escribe un importe entre R$ 0,01 y R$ 10.000,00. Ejemplo: 8,50\\nO envía /cancelar.',reply_markup:adminMenu});
    return res.status(200).json({ok:true});
   }
   await db`UPDATE bella_admin_payment_drafts SET amount=${(cents/100).toFixed(2)} WHERE admin_id=${from.id} AND content_id=${draft.content_id}`;
   await tg('sendMessage',{chat_id:chat,text:'🧾 Confirma el abono:\\n\\n📸 Publicación #'+draft.content_id+'\\n💵 A sumar al saldo: '+formatReais(cents)+'\\n\\nSolo se abonará cuando pulses Confirmar.',reply_markup:payConfirmKeyboard(draft.content_id,cents)});
   return res.status(200).json({ok:true});
  }
 }
 if(text==='/start'||text==='/admin'||text==='/panel'||text==='🏠 Panel admin'){
  await tg('sendMessage',{chat_id:chat,text:'🛡️ BELLA CLUB · Panel administrador\n\nAquí recibes y revisas las publicaciones de los usuarios. No necesitas enviar contenido.',reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 if(text==='/pendientes'||text==='📥 Revisar pendientes'){
  await pendingForAdmin(db);
  return res.status(200).json({ok:true});
 }
 if(text==='📊 Resumen'){
  const rows=await db`SELECT status,COUNT(*)::int AS total FROM bella_content GROUP BY status`;
  const counts=Object.fromEntries(rows.map(r=>[r.status,Number(r.total)]));
  await tg('sendMessage',{chat_id:chat,text:'📊 BELLA CLUB · Resumen de publicaciones\n\n⏳ Pendientes: '+(counts.pending||0)+'\n✅ Aprobadas: '+(counts.approved||0)+'\n❌ Rechazadas: '+(counts.rejected||0),reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 if(u.callback_query){
  await tg('answerCallbackQuery',{callback_query_id:u.callback_query.id});
  await tg('sendMessage',{chat_id:chat,text:'🛡️ Usa tu panel para revisar publicaciones.',reply_markup:adminMenu});
  return res.status(200).json({ok:true});
 }
 await tg('sendMessage',{chat_id:chat,text:u.message?.photo||u.message?.video?'🛡️ Esta cuenta es solo para administrar y revisar fotos y videos de los usuarios.':'🛡️ Selecciona una opción del panel de administrador.',reply_markup:adminMenu});
 return res.status(200).json({ok:true});
}
if(text==='/pendientes'){
 await tg('sendMessage',{chat_id:chat,text:'🔐 Solo el administrador puede revisar publicaciones. Envía /miid si necesitas comprobar tu ID de Telegram.',reply_markup:menu});
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
export { parseReais };
