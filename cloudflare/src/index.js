const services = {"bot":"Telegram-бот","site":"Сайт","miniapp":"Telegram Mini App","webapp":"Веб-приложение"};
async function tg(env, method, data) {
  const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  if(!r.ok) throw new Error("Telegram HTTP "+r.status);
  const j=await r.json(); if(!j.ok) throw new Error("Telegram API error"); return j.result;
}

let chatTableInitialized;
function ensureChatTable(env) {
  if (!chatTableInitialized) chatTableInitialized=env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_last_messages (chat_id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL)").run().catch(e=>{chatTableInitialized=null;throw e;});
  return chatTableInitialized;
}
// Only tidy up previous conversational bot messages in private chats. Never delete channel/group posts or admin notifications.
async function msg(env,chat_id,text,reply_markup) {
  const sent=await tg(env,"sendMessage",{chat_id,text,...(reply_markup?{reply_markup}:{})});
  // Fail closed: only Telegram-confirmed private chats may ever be cleaned.
  // Channel, group, supergroup and unknown chat types retain every post.
  if(sent.chat?.type!=="private" || !Number.isSafeInteger(sent.chat.id) || sent.chat.id<=0) return sent;
  await ensureChatTable(env);
  const previous=await env.DB.prepare("SELECT message_id FROM bot_last_messages WHERE chat_id=?").bind(chat_id).first();
  await env.DB.prepare("INSERT INTO bot_last_messages(chat_id,message_id) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET message_id=excluded.message_id").bind(chat_id,sent.message_id).run();
  if(previous && previous.message_id!==sent.message_id) {
    try{ await tg(env,"deleteMessage",{chat_id,message_id:previous.message_id}); }
    catch(e){console.warn("Could not delete previous message",String(e));}
  }
  return sent;
}

const kb=(rows)=>({inline_keyboard:rows});
const menu=(env)=>kb([
  [{text:"🚀 Оставить заявку",callback_data:"new"}],
  [{text:"💼 Услуги",callback_data:"services"}],
  ...(env.MINI_APP_URL&&env.MINI_APP_URL.startsWith("https://")?[[{text:"🌐 Открыть Mini App",web_app:{url:env.MINI_APP_URL}}]]:[])
]);
// Configure the persistent button in Telegram's input-bar menu (not an inline message button).
async function setupPersistentAppMenu(env) {
  if(!env.MINI_APP_URL || !env.MINI_APP_URL.startsWith("https://")) return;
  await tg(env,"setChatMenuButton",{
    menu_button: {type:"web_app",text:"🌐 Открыть приложение",web_app:{url:env.MINI_APP_URL}}
  });
}
async function start(env,chat){
  try { await setupPersistentAppMenu(env); }
  catch(e) { console.error("Could not configure Telegram menu button",String(e)); }
  await msg(env,chat,"Добро пожаловать в LeadBox Studio! Разрабатываем ботов, сайты и веб-приложения.",menu(env));
}
async function onUpdate(env,u){
 if(!Number.isInteger(u.update_id)) return;
 const mark=await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)").bind(u.update_id).run();
 if(!mark.meta.changes) return;
 try {
  if(u.callback_query){
   const q=u.callback_query,c=q.message?.chat?.id,id=q.from?.id,v=q.data||"";
   await tg(env,"answerCallbackQuery",{callback_query_id:q.id});
   if(!c||!id||q.message?.chat?.type!=="private") return;
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
   if(t==="/start"||t==="/menu"||t.startsWith("/start ")){await env.DB.prepare("DELETE FROM drafts WHERE user_id=?").bind(id).run();if(t.toLowerCase().includes("order")) {
     await msg(env,c,"Выберите тип проекта:",kb(Object.entries(services).map(([k,label])=>[{text:label,callback_data:"service:"+k}])));
    } else await start(env,c);return;}
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
     try{await tg(env,"sendMessage",{chat_id:env.ADMIN_CHAT_ID,text:["🔔 Новая заявка","Услуга: "+service,"Имя: "+name,"Telegram: "+(m.from.username?"@"+m.from.username:"нет username"),"ID: "+id,"Задача: "+draft.description,"Контакт: "+t.slice(0,500)].join("\n")});}
     catch(e){console.error("Admin notification failed",e);}
    }
   }
  }
 }catch(e){
  await env.DB.prepare("DELETE FROM processed_updates WHERE update_id=?").bind(u.update_id).run();
  throw e;
 }
}

async function verifyTelegramInitData(env, initData) {
  if(typeof initData!=="string" || !initData || initData.length>8192 || !env.BOT_TOKEN) return null;
  const params=new URLSearchParams(initData), hash=params.get("hash"), auth=Number(params.get("auth_date"));
  if(!hash || !/^[a-fA-F0-9]{64}$/.test(hash) || !Number.isFinite(auth) || Math.abs(Date.now()/1000-auth)>86400) return null;
  const enc=new TextEncoder();
  const material=[...params.entries()].filter(([k])=>k!=="hash"&&k!=="signature").sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
  const key=await crypto.subtle.importKey("raw",enc.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const secret=await crypto.subtle.sign("HMAC",key,enc.encode(env.BOT_TOKEN));
  const hmacKey=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=new Uint8Array(await crypto.subtle.sign("HMAC",hmacKey,enc.encode(material)));
  const given=new Uint8Array(hash.match(/../g).map(x=>parseInt(x,16)));
  let diff=0; for(let i=0;i<32;i++)diff|=digest[i]^given[i];
  if(diff) return null;
  try {const user=JSON.parse(params.get("user")||"null");return user && Number.isSafeInteger(user.id)?user:null;}
  catch{return null;}
}
async function createMiniAppLead(request,env) {
  if(!env.DB||!env.BOT_TOKEN) return Response.json({error:"Service unavailable"},{status:503});
  let body;try {body=await request.json();}catch{return Response.json({error:"Invalid JSON"},{status:400});}
  const user=await verifyTelegramInitData(env,body.initData);
  if(!user) return Response.json({error:"Откройте приложение из Telegram-бота."},{status:401});
  const service=String(body.service||"Другое").trim().slice(0,80);
  const description=String(body.description||"").trim().slice(0,3000);
  const contact=String(body.contact||"").trim().slice(0,500);
  if(description.length<10||!contact) return Response.json({error:"Укажите описание проекта и контакт."},{status:400});
  const name=[user.first_name,user.last_name].filter(Boolean).join(" ");
  await env.DB.prepare("INSERT INTO leads(user_id,username,full_name,service,description,contact) VALUES (?,?,?,?,?,?)")
    .bind(user.id,user.username||"",name,service,description,contact).run();
  if(env.ADMIN_CHAT_ID) {
    try {
      await tg(env,"sendMessage",{chat_id:env.ADMIN_CHAT_ID,text:["🔔 Заявка из Mini App","Услуга: "+service,"Имя: "+name,"Telegram: "+(user.username?"@"+user.username:"нет username"),"User ID: "+user.id,"Описание: "+description,"Контакт: "+contact].join("\n")});
    } catch(e){console.error("Mini App admin notification failed",e);}
  }
  return Response.json({ok:true});
}
async function getBotInfo(env) {
  if(!env.BOT_TOKEN) return Response.json({error:"Unavailable"},{status:503});
  try{const result=await tg(env,"getMe",{});return Response.json({username:result.username},{headers:{"Cache-Control":"public,max-age=300"}});}
  catch{return Response.json({error:"Unavailable"},{status:503});}
}

export default {
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(request.method==="GET"&&path==="/api/bot") return getBotInfo(env);
  if(request.method==="POST"&&path==="/api/leads") return createMiniAppLead(request,env);
  if(request.method==="GET"&&path==="/health") return Response.json({status:"ok",service:"LeadBox Studio"});
  if(request.method!=="POST"||path!=="/telegram/webhook") return new Response("Not found",{status:404});
  if(!env.DB||!env.BOT_TOKEN||!env.WEBHOOK_SECRET) return new Response("Not configured",{status:503});
  if(request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET) return new Response("Unauthorized",{status:403});
  let u;try{u=await request.json();}catch{return new Response("Invalid JSON",{status:400});}
  try{await onUpdate(env,u);}catch(e){console.error(e);return new Response("Temporary failure",{status:500});}
  return new Response("OK");
 }
};