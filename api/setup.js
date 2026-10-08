import {createHash} from 'node:crypto';
export default async function handler(req,res){
 try{
  const token=process.env.TELEGRAM_TOKEN||process.env.TELEGRAM_BOT_TOKEN;
  const secret=process.env.WEBHOOK_SECRET;
  if(!token||!secret)return res.status(500).json({ok:false,error:'Webhook credentials missing'});
  const url='https://bella-club-bot.vercel.app/api/telegram';
  const secret_token=createHash('sha256').update(secret).digest('hex');
  const r=await fetch('https://api.telegram.org/bot'+token+'/setWebhook',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({url,allowed_updates:['message','callback_query'],secret_token})
  });
  const j=await r.json();
  return res.status(j.ok?200:500).json({ok:!!j.ok,webhook:url,description:j.description});
 }catch(e){return res.status(500).json({ok:false,error:e.message});}
}