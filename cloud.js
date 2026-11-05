/* Пульс 3.0 — Cloud sync without external JavaScript dependencies.
   Browser-only Supabase Auth + PostgREST with offline outbox and per-item tombstones.
   See supabase_setup.sql and README.md. */
(()=>{'use strict';
const P=window.PulseBridge;
if(!P){console.error('Pulse bridge not found');return;}
const $=id=>document.getElementById(id);
const CFG_KEY='pulse-cloud-config-v3';
let cfg=null,session=null,activeUser=null,project='',pending={},busy=false,again=false,syncTimer=null,lastStamp=0,recovering=false;
const deep=x=>JSON.parse(JSON.stringify(x));
const safeParse=(x,fallback)=>{try{return x?JSON.parse(x):fallback;}catch{return fallback;}};
const num=x=>Number.isFinite(Date.parse(x))?Date.parse(x):0;
function time(){lastStamp=Math.max(Date.now(),lastStamp+1);return new Date(lastStamp).toISOString();}
function scopeId(id){return 'pulse-v3-user:'+project+':'+id;}
function pendKey(){return 'pulse-v3-queue:'+project+':'+activeUser.id;}
function sessionKey(){return 'pulse-v3-session:'+project;}
function itemKey(kind,id){return kind+'|'+id;}
function getIds(f){return f.at+'|'+f.date+'|'+f.minutes;}
function items(data){const m=new Map();for(const t of data.tasks||[])m.set(itemKey('task',t.id),{kind:'task',id:t.id,payload:t});for(const h of data.habits||[])m.set(itemKey('habit',h.id),{kind:'habit',id:h.id,payload:h});for(const f of data.focusSessions||[])m.set(itemKey('focus',getIds(f)),{kind:'focus',id:getIds(f),payload:f});m.set(itemKey('settings','main'),{kind:'settings',id:'main',payload:data.settings||{theme:'dark',autoRollover:false}});return m;}
function persistPending(){if(!activeUser)return;try{localStorage.setItem(pendKey(),JSON.stringify(pending));}catch{message('Не удалось сохранить очередь изменений. Скачай резервную копию .cfg.',true);}draw();}
function dataEmpty(d){return !d||(!d.tasks.length&&!d.habits.length&&!d.focusSessions.length);}
function message(t,error=false){const el=$('cloudMessage');el.textContent=t||'';el.classList.toggle('error',error);}
function mark(status,detail,error=false){$('cloudStateTitle').textContent=status;$('cloudStateDetail').textContent=detail||'';$('cloudStatusBox').classList.toggle('is-error',error);}
function draw(){const isAuth=!!activeUser,configured=!!cfg,offline=!navigator.onLine,n=Object.keys(pending).length;
 $('cloudConfigurePanel').hidden=configured;$('cloudAuthPanel').hidden=!configured||isAuth;$('cloudUserPanel').hidden=!isAuth||recovering;$('cloudResetPanel').hidden=!recovering;
 $('cloudUserEmail').textContent=isAuth?(activeUser.email||'Личный аккаунт'):'Аккаунт';
 $('accountLabel').textContent=isAuth?(activeUser.email?.split('@')[0]||'Мой аккаунт'):'Локальный режим';
 $('accountSubLabel').textContent=isAuth?(offline?'Офлайн · локально':n?'Ожидает: '+n:'Облачная синхронизация'):(configured?'Войти в аккаунт':'Подключить Supabase');
 $('cloudPendingText').textContent=n?`${n} изменений ожидают отправки. Пока они сохранены на этом устройстве.`:'Все отправленные изменения синхронизированы после последней успешной проверки.';
 const pill=$('cloudTopButton');pill.className='cloud-pill '+(isAuth?(offline?'cloud-offline':n?'cloud-pending':'cloud-online'):'cloud-off');
 $('cloudPillLabel').textContent=isAuth?(offline?'Офлайн':n?'В очереди · '+n:'Облако'):'Локально';
 if(recovering)mark('Восстановление пароля','Введи новый пароль для аккаунта.');
 else if(!configured)mark('Локальный режим','Укажи URL и публичный ключ Supabase.');
 else if(!isAuth)mark('Supabase подключён','Войди, чтобы начать синхронизацию.');
 else if(offline)mark('Офлайн','Изменения сохраняются здесь и отправятся при появлении сети.');
 else if(busy)mark('Синхронизация…',`Ожидает отправки: ${n}`);
 else if(n)mark('Ожидает синхронизации',`Изменений в очереди: ${n}`);
 else mark('Облако активно','Автоматическая проверка каждые 15 секунд.');
 P.setStatus(isAuth?(offline?'Офлайн · '+n+' в очереди':n?n+' изменений в очереди':'Облачный режим'):'Сохранено на устройстве');
}
function open(){draw();const d=$('cloudDialog');if(!d.open)d.showModal();}
function validConfig(url,key){let u;try{u=new URL(String(url).trim());}catch{throw Error('Проверь адрес проекта Supabase.');}
 if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||u.search||u.hash)throw Error('Нужен HTTPS-адрес вида https://project.supabase.co');
 if(u.pathname!=='/'&&u.pathname!=='')throw Error('Укажи корневой адрес проекта без /rest и /auth.');
 const k=String(key).trim();if(k.startsWith('sb_secret_')||k.includes('service_role'))throw Error('Secret/service_role-ключ нельзя использовать в браузере!');
 if(!(k.startsWith('sb_publishable_')||/^eyJ[A-Za-z0-9._-]{70,}$/.test(k)))throw Error('Укажи Publishable key (sb_publishable_…) или старый anon key.');
 if(k.startsWith('eyJ')){try{const part=k.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');const decoded=JSON.parse(atob(part));if(decoded.role&&decoded.role!=='anon')throw Error('Можно использовать только anon key, не service_role.');}catch(e){throw Error('Не удалось проверить legacy JWT. Лучше используй sb_publishable_ ключ.');}}
 return{url:u.origin,key:k};}
function getConfig(){const shipped=window.PULSE_CONFIG||{},stored=safeParse(localStorage.getItem(CFG_KEY),null);try{if(stored?.url&&stored?.key)return validConfig(stored.url,stored.key);if(shipped.url&&shipped.publishableKey)return validConfig(shipped.url,shipped.publishableKey);}catch(e){message(e.message,true);}return null;}
async function request(path,{method='GET',body,token=true}={}){if(!cfg)throw Error('Supabase не настроен.');
 const headers={'apikey':cfg.key};if(token&&session?.access_token)headers.Authorization='Bearer '+session.access_token;if(body!==undefined)headers['Content-Type']='application/json';
 let res;try{res=await fetch(cfg.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});}catch{throw Error('Нет соединения с Supabase. Изменения остались на устройстве.');}
 const raw=await res.text();let json=safeParse(raw,raw||null);
 if(!res.ok){const m=typeof json==='object'?(json.msg||json.message||json.error_description||json.error||json.hint):raw;throw Error(`${m||'Ошибка подключения'} (${res.status})`);}
 return json;}
function stashSession(obj){session=obj;try{localStorage.setItem(sessionKey(),JSON.stringify(session));}catch{};}
async function authRefresh(){if(!session)return false;if(!navigator.onLine)return false;if((session.expires_at||0)>Date.now()/1000+70)return true;
 if(!session.refresh_token)throw Error('Сессия истекла. Войди снова.');
 const result=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:session.refresh_token},token:false});
 stashSession({...result,expires_at:result.expires_at||(Math.floor(Date.now()/1000)+(result.expires_in||3600)),user:result.user||session.user});return true;}
async function authEmail(mode){const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
 if(!email||!password||password.length<6){message('Укажи почту и пароль не короче 6 символов.',true);return;}
 message('Подключение к аккаунту…');
 try{let result;if(mode==='signup')result=await request('/auth/v1/signup',{method:'POST',body:{email,password},token:false});
 else result=await request('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password},token:false});
 if(!result?.access_token){message('Аккаунт создан. Проверь почту, подтверди адрес по ссылке и затем войди.');return;}
 const user=result.user||await getAuthUser(result.access_token);
 await enter({...result,user});$('cloudPassword').value='';message('Вход выполнен. Синхронизация запущена.');
 }catch(e){message(e.message,true);}}
async function getAuthUser(token){const h={'apikey':cfg.key,'Authorization':'Bearer '+token};const res=await fetch(cfg.url+'/auth/v1/user',{headers:h,cache:'no-store'});if(!res.ok)throw Error('Не удалось определить пользователя.');return res.json();}
async function enter(nextSession){if(!nextSession?.user?.id)throw Error('От Supabase не получен ID пользователя.');
 const other=activeUser?.id!==nextSession.user.id;if(other){if(activeUser){pending={};}activeUser={id:nextSession.user.id,email:nextSession.user.email||''};project=new URL(cfg.url).hostname.split('.')[0];P.switchStore(scopeId(activeUser.id));pending=safeParse(localStorage.getItem(pendKey()),{})||{};}
 stashSession({...nextSession,expires_at:nextSession.expires_at||(Math.floor(Date.now()/1000)+(nextSession.expires_in||3600))});draw();
 if(navigator.onLine)await sync();}
async function restoreSession(){if(!cfg)return;project=new URL(cfg.url).hostname.split('.')[0];const restored=safeParse(localStorage.getItem(sessionKey()),null);if(!restored?.user?.id||!restored.refresh_token)return;
 // Show cached personal data immediately, including when the device is offline.
 session=restored;activeUser={id:restored.user.id,email:restored.user.email||''};P.switchStore(scopeId(activeUser.id));pending=safeParse(localStorage.getItem(pendKey()),{})||{};draw();
 if(navigator.onLine){try{await sync();}catch(e){message(e.message,true);}}
}
function applyRowToData(current,row){const d=deep(current),kind=row.kind,obj=row.payload;switch(kind){
 case 'task':{const arr=d.tasks;const i=arr.findIndex(t=>t.id===row.item_id);if(i>=0)arr.splice(i,1);if(!row.deleted&&obj?.title)arr.push(obj);break;}
 case 'habit':{const arr=d.habits;const i=arr.findIndex(h=>h.id===row.item_id);if(i>=0)arr.splice(i,1);if(!row.deleted&&obj?.name)arr.push(obj);break;}
 case 'focus':{const arr=d.focusSessions;const i=arr.findIndex(f=>getIds(f)===row.item_id);if(i>=0)arr.splice(i,1);if(!row.deleted&&obj?.date)arr.push(obj);break;}
 case 'settings':if(!row.deleted&&obj)d.settings=obj;break;}
 return d;}
async function fetchRows(){let all=[];for(let offset=0;offset<=10000;offset+=1000){const page=await request('/rest/v1/pulse_items?select=kind,item_id,payload,deleted,client_changed_at&order=client_changed_at.asc&limit=1000&offset='+offset);if(!Array.isArray(page))throw Error('Supabase вернул некорректный список записей.');all.push(...page);if(page.length<1000)return all;}throw Error('Больше 10000 записей: скачай копию и обратись к разработчику.');}
function mergeRemote(rows){let current=P.getData(),changed=false,conflicts=0;for(const row of rows){if(!['task','habit','focus','settings'].includes(row.kind)||typeof row.item_id!=='string')continue;
 const key=itemKey(row.kind,row.item_id),local=pending[key];
 if(local&&num(local.changed_at)>num(row.client_changed_at))continue;
 if(local){delete pending[key];conflicts++;}
 const next=applyRowToData(current,row);
 if(JSON.stringify(next)!==JSON.stringify(current)){current=next;changed=true;}}
 if(changed)P.setData(current,true);if(conflicts)persistPending();}
async function pushOne(op){const returned=await request('/rest/v1/rpc/pulse_apply',{method:'POST',body:{p_kind:op.kind,p_item_id:op.id,p_payload:op.payload||{},p_deleted:!!op.deleted,p_client_changed_at:op.changed_at}});
 const row=Array.isArray(returned)?returned[0]:returned;
 if(row?.client_changed_at&&num(row.client_changed_at)>num(op.changed_at)){
  const key=itemKey(op.kind,op.id),current=pending[key];if(current?.changed_at===op.changed_at){delete pending[key];P.setData(applyRowToData(P.getData(),row),true);persistPending();}
 }
}
async function sync(){if(!activeUser||!cfg||!navigator.onLine){draw();return;}
 if(busy){again=true;return;}busy=true;draw();
 try{await authRefresh();if(!session?.access_token)throw Error('Войди в аккаунт повторно.');
  const rows=await fetchRows();mergeRemote(rows);
  // Every operation is sent individually so an error cannot erase the entire queue.
  for(const [key,op] of Object.entries({...pending})){
   if(!pending[key]||pending[key].changed_at!==op.changed_at)continue;
   await pushOne(op);
   if(pending[key]?.changed_at===op.changed_at){delete pending[key];persistPending();}
  }
  message('Все доступные изменения проверены и синхронизированы.');
 }catch(e){message(e.message,true);if(e.message.includes('404')||e.message.includes('relation'))message('Не найдена таблица или функция Supabase. Выполни supabase_setup.sql. '+e.message,true);}
 finally{busy=false;draw();if(again){again=false;setTimeout(sync,100);}}
}
function queueChanges(before,after){if(!activeUser)return;const a=items(before),b=items(after),keys=new Set([...a.keys(),...b.keys()]);let count=0;
 for(const key of keys){const old=a.get(key),next=b.get(key);if(JSON.stringify(old?.payload)===JSON.stringify(next?.payload))continue;
 const source=next||old;pending[key]={kind:source.kind,id:source.id,payload:next?.payload||{},deleted:!next,changed_at:time()};count++;}
 if(count){persistPending();clearTimeout(syncTimer);syncTimer=setTimeout(sync,650);}}
function mergeGuest(){if(!activeUser)return;const guest=P.getGuestData();if(dataEmpty(guest)){message('В локальном режиме пока нет задач для переноса.');return;}
 if(!confirm(`Перенести ${guest.tasks.length} задач и ${guest.habits.length} привычек из локального режима в аккаунт? Локальная копия сохранится.`))return;
 const dest=P.getData(),combine=(first,second)=>{const m=new Map(first.map(x=>[x.id,x]));second.forEach(x=>{if(!m.has(x.id))m.set(x.id,x);});return [...m.values()]};
 dest.tasks=combine(dest.tasks,guest.tasks);dest.habits=combine(dest.habits,guest.habits);
 const exists=new Set(dest.focusSessions.map(getIds));for(const f of guest.focusSessions)if(!exists.has(getIds(f))){dest.focusSessions.push(f);exists.add(getIds(f));}
 P.setData(dest,false);message(`Локальные записи перенесены в аккаунт. Они будут синхронизированы.`);}
async function logout(){if(!activeUser)return;const n=Object.keys(pending).length;
 if(n&&!confirm(`${n} изменений ещё не синхронизированы. Они останутся в локальной копии этого аккаунта, но не появятся на втором устройстве до следующего входа. Всё равно выйти?`))return;
 const old=session;const oldCfg=cfg;session=null;activeUser=null;pending={};
 localStorage.removeItem('pulse-v3-session:'+project);P.switchStore('pulse-planner-data-v3-guest');draw();message('Вы вышли. Данные аккаунта остались в локальном кэше этого устройства.');
 if(navigator.onLine&&old?.access_token){try{await fetch(oldCfg.url+'/auth/v1/logout',{method:'POST',headers:{'apikey':oldCfg.key,'Authorization':'Bearer '+old.access_token}});}catch{}}
}
function setConfig(e){e.preventDefault();try{const next=validConfig($('cloudUrl').value,$('cloudKey').value);
 if(activeUser)throw Error('Сначала выйди из текущего аккаунта.');
 cfg=next;project=new URL(cfg.url).hostname.split('.')[0];localStorage.setItem(CFG_KEY,JSON.stringify(cfg));message('Supabase подключён. Теперь войди в аккаунт.');draw();}
 catch(err){message(err.message,true);}}
function editConfig(){if(activeUser){message('Сначала выйди из аккаунта.',true);return;}cfg=null;project='';localStorage.removeItem(CFG_KEY);draw();message('Введи новые настройки подключения.');}
async function handleHashAuth(){if(!cfg||!location.hash.includes('access_token='))return;const params=new URLSearchParams(location.hash.slice(1));const isRecovery=params.get('type')==='recovery';const a=params.get('access_token'),r=params.get('refresh_token');if(!a||!r)return;
 history.replaceState(null,'',location.pathname+location.search);
 try{const user=await getAuthUser(a);await enter({access_token:a,refresh_token:r,expires_in:Number(params.get('expires_in')||3600),user});if(isRecovery){recovering=true;draw();open();message('Введи новый пароль, чтобы завершить восстановление.');}else message('Почта подтверждена. Добро пожаловать!');}
 catch(e){message('Не удалось завершить вход из письма: '+e.message,true);}}
async function recoverPassword(){const email=$('cloudEmail').value.trim();if(!email){message('Сначала укажи почту в поле выше.',true);return;}
 try{const redirect=location.protocol==='https:'?location.origin+location.pathname:undefined;
 await request('/auth/v1/recover'+(redirect?'?redirect_to='+encodeURIComponent(redirect):''),{method:'POST',body:{email},token:false});message('Если адрес существует, Supabase отправит письмо для смены пароля.');}
 catch(e){message('Не удалось отправить письмо: '+e.message,true);}}
async function updatePassword(e){e.preventDefault();const password=$('cloudNewPassword').value;if(password.length<6){message('Пароль должен содержать не менее 6 символов.',true);return;}
 try{await authRefresh();await request('/auth/v1/user',{method:'PUT',body:{password}});recovering=false;$('cloudNewPassword').value='';draw();message('Пароль обновлён. Теперь можно пользоваться Пульсом.');}
 catch(err){message(err.message,true);}}
function init(){cfg=getConfig();if(cfg){project=new URL(cfg.url).hostname.split('.')[0];$('cloudUrl').value=cfg.url;$('cloudKey').value=cfg.key;}
 $('cloudSidebar').addEventListener('click',open);$('cloudTopButton').addEventListener('click',open);$('settingsCloud').addEventListener('click',()=>{$('settingsDialog').close();open();});$('closeCloud').addEventListener('click',()=>$('cloudDialog').close());
 $('cloudConfigForm').addEventListener('submit',setConfig);$('cloudEditConfig').addEventListener('click',editConfig);
 $('cloudAuthForm').addEventListener('submit',e=>{e.preventDefault();authEmail('login');});$('cloudRecover').addEventListener('click',recoverPassword);$('cloudResetForm').addEventListener('submit',updatePassword);$('cloudRegister').addEventListener('click',()=>authEmail('signup'));
 $('cloudSyncNow').addEventListener('click',sync);$('cloudImportGuest').addEventListener('click',mergeGuest);$('cloudLogout').addEventListener('click',logout);
 window.addEventListener('pulse:save',e=>queueChanges(e.detail.before,e.detail.after));
 window.addEventListener('online',()=>{draw();sync();});window.addEventListener('offline',draw);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
 window.addEventListener('storage',e=>{if(e.key===pendKey()&&activeUser){pending=safeParse(e.newValue,{})||{};draw();}});
 setInterval(()=>{if(!document.hidden&&activeUser)sync();},15000);
 draw();restoreSession().then(handleHashAuth).catch(e=>message(e.message,true));
 if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('Service Worker:',e));
 if(location.protocol==='file:')message('Для синхронизации и установки на iPhone размести сайт по HTTPS (например GitHub Pages). Локальные задачи доступны и сейчас.');
}
init();
window.PulseCloudDebug={state:()=>({activeUser,project,pending:deep(pending),busy,cfg:cfg?{url:cfg.url}:null}),sync};
})();
