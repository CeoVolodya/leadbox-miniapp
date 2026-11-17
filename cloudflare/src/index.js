const services = {"bot":"Telegram-бот","site":"Сайт","miniapp":"Telegram Mini App","webapp":"Веб-приложение"};
async function tg(env, method, data) {
  const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  if(!r.ok) throw new Error("Telegram HTTP "+r.status);
  const j=await r.json(); if(!j.ok) throw new Error("Telegram API error"); return j.result;
}
const msg=(env,chat_id,text,reply_markup)=>tg(env,"sendMessage",{chat_id,text,...(reply_markup?{reply_markup}:{})});
const kb=(rows)=>({inline_keyboard:rows});
const menu=(env)=>kb([
  [{text:"🚀 Оставить заявку",callback_data:"new"}],
  [{text:"💼 Услуги",callback_data:"services"}],
  ...(env.MINI_APP_URL&&env.MINI_APP_URL.startsWith("https://")?[[{text:"🌐 Открыть Mini App",web_app:{url:env.MINI_APP_URL}}]]:[])
]);
async function start(env,chat){await msg(env,chat,"Добро пожаловать в LeadBox Studio! Разрабатываем ботов, сайты и веб-приложения.",menu(env));}
async function onUpdate(env,u){
 if(!Number.isInteger(u.update_id)) return;
 const mark=await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)").bind(u.update_id).run();
 if(!mark.meta.changes) return;
 try {
  if(u.callback_query){
   const q=u.callback_query,c=q.message?.chat?.id,id=q.from?.id,v=q.data||"";
   await tg(env,"answerCallbackQuery",{callback_query_id:q.id});
   if(!c||!id) return;
   if(v==="new") await msg(env,c,"Какой проект вас интересует?",kb(Object.entries(services).map(([k,t])=>[{text:t,callback_data:"service:"+k}])));
   else if(v==="services") await msg(env,c,"Telegram-боты, сайты, Mini Apps и веб-приложения. Нажмите «Оставить заявку» для консультации.",menu(env));
   else if(v.startsWith("service:")&&services[v.slice(8)]){
    await env.DB.prepare("INSERT INTO drafts(user_id,step,service,description) VALUES (?,'description',?,'') ON CONFLICT(user_id) DO UPDATE SET step='description',service=excluded.service,description=''").bind(id,v.slice(8)).run();
    await msg(env,c,"Опишите задачу и желаемые функции проекта.");
   }
  }
  if(u.message&&u.message.chat?.type==="private"){
   const m=u.message,c=m.chat.id,id=m.from?.id,t=(m.text||"").trim();
   if(!id) return;
   if(t==="/start"||t==="/menu"){await env.DB.prepare("DELETE FROM drafts WHERE user_id=?").bind(id).run();await start(env,c);return;}
   if(t==="/cancel"){await env.DB.prepare("DELETE FROM drafts WHERE user_id=?").bind(id).run();await msg(env,c,"Заявка отменена.",menu(env));return;}
   const draft=await env.DB.prepare("SELECT step,service,description FROM drafts WHERE user_id=?").bind(id).first();
   if(!draft){await start(env,c);return;}
   if(!t){await msg(env,c,"Отправьте текстовое сообщение.");return;}
   if(draft.step==="description"){
    if(t.length<10){await msg(env,c,"Опишите задачу чуть подробнее (не менее 10 символов).");return;}
    await env.DB.prepare("UPDATE drafts SET step='contact', description=? WHERE user_id=?").bind(t.slice(0,3000),id).run();
    await msg(env,c,"Укажите контакт: Telegram @username или другой удобный способ связи.");
   }else if(draft.step==="contact"){
    const name=[m.from.first_name,m.from.last_name].filter(Boolean).join(" ");
    const service=services[draft.service]||draft.service;
    await env.DB.prepare("INSERT INTO leads(user_id,username,full_name,service,description,contact) VALUES (?,?,?,?,?,?)").bind(id,m.from.username||"",name,service,draft.description,t.slice(0,500)).run();
    await env.DB.prepare("DELETE FROM drafts WHERE user_id=?").bind(id).run();
    await msg(env,c,"✅ Заявка принята! Мы свяжемся с вами.",menu(env));
    if(env.ADMIN_CHAT_ID) {
     try{await msg(env,env.ADMIN_CHAT_ID,["🔔 Новая заявка","Услуга: "+service,"Имя: "+name,"Telegram: "+(m.from.username?"@"+m.from.username:"нет username"),"ID: "+id,"Задача: "+draft.description,"Контакт: "+t.slice(0,500)].join("\n"));}
     catch(e){console.error("Admin notification failed",e);}
    }
   }
  }
 }catch(e){
  await env.DB.prepare("DELETE FROM processed_updates WHERE update_id=?").bind(u.update_id).run();
  throw e;
 }
}
export default {
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(request.method==="GET"&&path==="/health") return Response.json({status:"ok",service:"LeadBox Studio"});
  if(request.method!=="POST"||path!=="/telegram/webhook") return new Response("Not found",{status:404});
  if(!env.DB||!env.BOT_TOKEN||!env.WEBHOOK_SECRET) return new Response("Not configured",{status:503});
  if(request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET) return new Response("Unauthorized",{status:403});
  let u;try{u=await request.json();}catch{return new Response("Invalid JSON",{status:400});}
  try{await onUpdate(env,u);}catch(e){console.error(e);return new Response("Temporary failure",{status:500});}
  return new Response("OK");
 }
};