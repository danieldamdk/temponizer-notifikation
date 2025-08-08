// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" + Telefonbog (AjourCare)
// @namespace    ajourcare.dk
// @version      7.3
// @description  Fix: Excel→CSV→Upload bruger nu fetchIds fra DOM/fallback-ajax; RAW CSV-lookup med cache-busting. Push (leader), inbound caller-pop, hover “Intet Svar”, drag panel, reset-knap, quiet hours.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      ajourcare.temponizer.dk
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// ==/UserScript==

if (window.__TP73_RUNNING__) { console.info('[TP] already running'); } else { window.__TP73_RUNNING__ = true;

/* ───────────── cfg ───────────── */
const TP_VER='7.3';
const PUSHOVER_TOKEN='a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_ACTIVE_MS=15000, POLL_HIDDEN_MS=45000, POLL_IDLE_MS_MAX=60000;
const SUPPRESS_MS=45000, LOCK_MS=SUPPRESS_MS+5000;
const LEADER_KEY='tpLeaderV1', HEARTBEAT_MS=5000, LEASE_MS=15000;
const TAB_ID=(crypto?.randomUUID?.()||('tab-'+Math.random().toString(36).slice(2)+Date.now()));
const bc=(typeof BroadcastChannel!=='undefined')?new BroadcastChannel('tpLeader'):null;

const PB_OWNER='danieldamdk', PB_REPO='temponizer-notifikation', PB_BRANCH='main', PB_CSV='vikarer.csv';
const RAW_PHONEBOOK=`https://raw.githubusercontent.com/${PB_OWNER}/${PB_REPO}/${PB_BRANCH}/${PB_CSV}`;

/* migrate USER-token LS→GM */
(function(){try{const gm=(GM_getValue('tpUserKey')||'').trim();if(!gm){const ls=(localStorage.getItem('tpUserKey')||'').trim();if(ls){GM_setValue('tpUserKey',ls);localStorage.removeItem('tpUserKey');}}}catch(_){}})();

/* ───────────── utils ───────────── */
function showToast(msg){if(Notification.permission==='granted'){try{new Notification('Temponizer',{body:msg});}catch(_){domToast(msg);}}else if(Notification.permission!=='denied'){Notification.requestPermission().then(p=>{p==='granted'?new Notification('Temponizer',{body:msg}):domToast(msg)});}else domToast(msg);}
function domToast(msg){const el=document.createElement('div');el.textContent=msg;Object.assign(el.style,{position:'fixed',bottom:'16px',right:'16px',background:'#333',color:'#fff',padding:'10px 14px',borderRadius:'6px',fontSize:'13px',fontFamily:'sans-serif',boxShadow:'1px 1px 8px rgba(0,0,0,.4)',zIndex:2147483646,opacity:0,transition:'opacity .4s'});document.body.appendChild(el);requestAnimationFrame(()=>el.style.opacity=1);setTimeout(()=>{el.style.opacity=0;setTimeout(()=>el.remove(),450);},4000);}
function showToastOnce(k,msg){const lk='tpToastLock_'+k;const o=JSON.parse(localStorage.getItem(lk)||'{"t":0}');if(Date.now()-o.t<LOCK_MS)return;localStorage.setItem(lk,JSON.stringify({t:Date.now()}));showToast(msg);}
function withRetry(fn,{tries=3,delays=[1500,3000,6000]}={}){return(...args)=>new Promise((res,rej)=>{let n=0;const run=()=>fn(...args).then(res).catch(e=>{n++;if(n>=tries)return rej(e);setTimeout(run,delays[Math.min(n-1,delays.length-1)]);});run();});}
function gmGET(url,headers={}){return new Promise((res,rej)=>GM_xmlhttpRequest({method:'GET',url,headers,onload:r=>((r.status>=200&&r.status<300)?res(r.responseText):rej(new Error('HTTP '+r.status))),onerror:rej}));}
function gmGETArrayBuffer(url,headers={}){return new Promise((res,rej)=>GM_xmlhttpRequest({method:'GET',url,headers,responseType:'arraybuffer',onload:r=>((r.status>=200&&r.status<300)?res(r.response):rej(new Error('HTTP '+r.status))),onerror:rej}));}
function gmPOST(url,body,headers={}){return new Promise((res,rej)=>GM_xmlhttpRequest({method:'POST',url,headers,data:body,onload:r=>((r.status>=200&&r.status<300)?res(r.responseText):rej(new Error('HTTP '+r.status))),onerror:rej}));}
function gmPOSTArrayBuffer(url,body,headers={}){return new Promise((res,rej)=>GM_xmlhttpRequest({method:'POST',url,headers,data:body,responseType:'arraybuffer',onload:r=>((r.status>=200&&r.status<300)?res(r.response):rej(new Error('HTTP '+r.status))),onerror:rej}));}
function b64Utf8(s){const b=new TextEncoder().encode(s);let bin='';b.forEach(x=>bin+=String.fromCharCode(x));return btoa(bin);}
function normPhone(raw){const d=String(raw||'').replace(/\D/g,'').replace(/^0+/,'').replace(/^45/,'');return d.length>=8?d.slice(-8):'';}

/* quiet hours */
function getQuietCfg(){return{on:GM_getValue('tpQuietOn')===true,from:GM_getValue('tpQuietFrom')||'22:00',to:GM_getValue('tpQuietTo')||'06:00'};}
function isQuietNow(){const{on,from,to}=getQuietCfg();if(!on)return false;const m=s=>{const[a,b]=s.split(':').map(n=>+n||0);return a*60+b;};const n=new Date().getHours()*60+new Date().getMinutes(), f=m(from), t=m(to);return f<=t?(n>=f&&n<t):(n>=f||n<t);}

/* pushover */
function getUserKey(){try{return (GM_getValue('tpUserKey')||'').trim();}catch(_){return'';}}
const _sendRaw=(msg)=>new Promise((res,rej)=>{const user=getUserKey();if(!PUSHOVER_TOKEN||!user){showToast('Pushover ikke konfigureret – indsæt USER-token i ⚙️.');return rej(new Error('no creds'));}const body='token='+encodeURIComponent(PUSHOVER_TOKEN)+'&user='+encodeURIComponent(user)+'&message='+encodeURIComponent(msg);GM_xmlhttpRequest({method:'POST',url:'https://api.pushover.net/1/messages.json',headers:{'Content-Type':'application/x-www-form-urlencoded'},data:body,onload:r=>((r.status>=200&&r.status<300)?res():rej(new Error('HTTP '+r.status))),onerror:rej});});
const sendPushover=withRetry(async(msg)=>{if(isQuietNow())return;await _sendRaw(msg);});

/* leader */
function now(){return Date.now();}
function getLeader(){try{return JSON.parse(localStorage.getItem(LEADER_KEY)||'null');}catch(_){return null;}}
function setLeader(o){localStorage.setItem(LEADER_KEY,JSON.stringify(o));bc?.postMessage({type:'leader:update',o});}
function isLeader(){const L=getLeader();return !!(L&&L.id===TAB_ID&&L.until>now());}
function tryBecomeLeader(){const L=getLeader(),t=now();if(!L||(L.until||0)<=t){setLeader({id:TAB_ID,until:t+LEASE_MS,ts:t});}}
function heartbeatIfLeader(){if(!isLeader())return;const t=now();setLeader({id:TAB_ID,until:t+LEASE_MS,ts:t});}
window.addEventListener('storage',e=>{if(e.key===LEADER_KEY){}});
bc?.addEventListener('message',()=>{});

/* state */
const MSG_URL=location.origin+'/index.php?page=get_comcenter_counters&ajax=true';
const HTML_URL=location.origin+'/index.php?page=freevagter';
const MSG_KEYS=['vagt_unread','generel_unread'];
const ST_MSG_KEY='tpPushState', ST_INT_KEY='tpInterestState';
function loadJson(k,f){try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(f));}catch(_){return JSON.parse(JSON.stringify(f));}}
function saveJsonIfLeader(k,o){if(isLeader())localStorage.setItem(k,JSON.stringify(o));}
function takeLock(){const l=JSON.parse(localStorage.getItem('tpPushLock')||'{"t":0}');if(Date.now()-l.t<LOCK_MS)return false;localStorage.setItem('tpPushLock',JSON.stringify({t:Date.now()}));return true;}

/* pollers */
let msgBadgeEl=null,intBadgeEl=null,msgIdleHits=0,intIdleHits=0;
function pollDelay(){const vis=document.visibilityState==='visible';const base=vis?POLL_ACTIVE_MS:POLL_HIDDEN_MS;const idle=Math.min((msgIdleHits+intIdleHits)*3000,POLL_IDLE_MS_MAX-base);return base+idle;}
async function pollMessages(){ if(!isLeader())return; try{const txt=await gmGET(MSG_URL+'&ts='+Date.now(),{'Accept':'application/json'});const d=JSON.parse(txt||'null')||{};const st=loadJson(ST_MSG_KEY,{count:0,lastPush:0,lastSent:0});const n=MSG_KEYS.reduce((s,k)=>s+Number(d[k]||0),0);const en=localStorage.getItem('tpPushEnableMsg')==='true';msgBadgeEl&&(msgBadgeEl.textContent=String(n));if(n>st.count&&n!==st.lastSent){const can=(Date.now()-st.lastPush>SUPPRESS_MS)&&takeLock();if(can){const m='🔔 Du har nu '+n+' ulæst(e) Temponizer-besked(er).';if(en)await sendPushover(m);showToastOnce('msg',m);st.lastPush=Date.now();st.lastSent=n;msgIdleHits=0;}else st.lastSent=n;}else if(n<st.count){st.lastPush=0;}st.count=n;saveJsonIfLeader(ST_MSG_KEY,st);}catch(e){console.warn('[TP][MSG]',e);}}
async function pollInterest(){ if(!isLeader())return; try{const html=await gmGET(HTML_URL,{Range:'bytes=0-20000'});const doc=new DOMParser().parseFromString(html,'text/html');const boxes=[...doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]')];const c=boxes.reduce((s,el)=>{const v=parseInt(el.textContent.trim(),10);return s+(isNaN(v)?0:v);},0);const st=loadJson(ST_INT_KEY,{count:0,lastPush:0,lastSent:0});const en=localStorage.getItem('tpPushEnableInt')==='true';intBadgeEl&&(intBadgeEl.textContent=String(c));if(c>st.count&&c!==st.lastSent){if(Date.now()-st.lastPush>SUPPRESS_MS&&takeLock()){const m='👀 '+c+' vikar(er) har vist interesse for ledige vagter';if(en)await sendPushover(m);showToastOnce('int',m);st.lastPush=Date.now();st.lastSent=c;intIdleHits=0;}else st.lastSent=c;}else if(c<st.count){st.lastPush=0;}st.count=c;saveJsonIfLeader(ST_INT_KEY,st);}catch(e){console.warn('[TP][INT]',e);} }
let _msgTimer=null,_intTimer=null; function schedule(){clearTimeout(_msgTimer);clearTimeout(_intTimer);const ms=pollDelay();_msgTimer=setTimeout(async()=>{await pollMessages();schedule();},ms);_intTimer=setTimeout(async()=>{await pollInterest();schedule();},ms+500);}

/* XLSX loader on demand */
let _xlsxReady=null;
function ensureXLSX(){ if(typeof XLSX!=='undefined')return Promise.resolve(); if(_xlsxReady)return _xlsxReady; const url='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; _xlsxReady=new Promise((res,rej)=>GM_xmlhttpRequest({method:'GET',url,onload:r=>{try{(0,eval)(r.responseText);if(typeof XLSX==='undefined')throw new Error('XLSX not loaded');res();}catch(e){rej(e)}},onerror:rej})); return _xlsxReady;}

/* GitHub helpers */
const ghGetSha=withRetry((o,r,p,ref)=>new Promise((res,rej)=>{const url=`https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(ref)}`;const t=(GM_getValue('tpGitPAT')||'').trim();GM_xmlhttpRequest({method:'GET',url,headers:{'Accept':'application/vnd.github+json',...(t?{'Authorization':'Bearer '+t}:{}),'X-GitHub-Api-Version':'2022-11-28'},onload:x=>{if(x.status===200){try{const j=JSON.parse(x.responseText);res({sha:j.sha,exists:true});}catch(_){res({sha:null,exists:true});}}else if(x.status===404)res({sha:null,exists:false});else rej(new Error('GitHub sha '+x.status));},onerror:rej});}));
const ghPutFile=withRetry((o,r,p,content,msg,sha,branch)=>new Promise((res,rej)=>{const url=`https://api.github.com/repos/${o}/${r}/contents/${encodeURIComponent(p)}`;const t=(GM_getValue('tpGitPAT')||'').trim();GM_xmlhttpRequest({method:'PUT',url,headers:{'Accept':'application/vnd.github+json',...(t?{'Authorization':'Bearer '+t}:{}),'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json;charset=UTF-8'},data:JSON.stringify({message:msg,content,branch,...(sha?{sha}:{})}),onload:x=>((x.status===200||x.status===201)?res(x.responseText):rej(new Error('GitHub PUT '+x.status+' '+(x.responseText||'')))),onerror:rej});}));

/* CSV parse */
function parseCSV(t){if(!t)return[];t=t.replace(/^\uFEFF/,'');const first=(t.split(/\r?\n/)[0]||'');const delim=(first.indexOf(';')>first.indexOf(','))?';':(first.includes(';')?';':',');const rows=[];let i=0,f='',row=[],q=false;while(i<t.length){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i+=2;continue;}q=false;i++;continue;}f+=c;i++;continue;}if(c==='"'){q=true;i++;continue;}if(c==='\r'){i++;continue;}if(c==='\n'){row.push(f.trim());rows.push(row);row=[];f='';i++;continue;}if(c===delim){row.push(f.trim());f='';i++;continue;}f+=c;i++;}if(f.length||row.length){row.push(f.trim());rows.push(row);}return rows.filter(r=>r.length&&r.some(x=>x!==''));}
function parsePhonebookCSV(text){const map=new Map(),dups=new Map();const rows=parseCSV(text);if(!rows.length)return{map,dups};const hdr=rows[0].map(h=>h.toLowerCase());const idxId=hdr.findIndex(h=>/(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));const idxName=hdr.findIndex(h=>/(navn|name)/.test(h));const phoneCols=hdr.map((h,idx)=>({h,idx})).filter(x=>/(telefon|mobil|cellphone|mobile|phone)/.test(x.h));if(idxId<0||phoneCols.length===0)return{map,dups};for(let r=1;r<rows.length;r++){const row=rows[r];const id=(row[idxId]||'').trim();const name=idxName>=0?(row[idxName]||'').trim():'';if(!id)continue;for(const pc of phoneCols){const p8=normPhone((row[pc.idx]||'').trim());if(!p8)continue;if(map.has(p8)&&map.get(p8).id!==id){const s=dups.get(p8)||new Set([map.get(p8).id]);s.add(id);dups.set(p8,s);}map.set(p8,{id,name});}}return{map,dups};}

/* Excel helpers */
function normalizeHeader(csv){const lines=csv.split(/\r?\n/);if(!lines.length)return csv;const hdr=(lines[0]||'').split(',');const mapH=h=>{const x=h.trim().toLowerCase();if(/(vikar.*nr|vikar[_ ]?id|^id$)/.test(x))return'vikar_id';if(/(navn|name)/.test(x))return'name';if(/(^telefon$|phone(?!.*cell)|tlf)/.test(x))return'phone';if(/(mobil|cellphone|mobile)/.test(x))return'cellphone';return h.trim();};lines[0]=hdr.map(mapH).join(',');return lines.join('\n');}
function pickBestSheetCSV(wb){let best={rows:0,csv:''};for(const n of wb.SheetNames){const sh=wb.Sheets[n];let csv=XLSX.utils.sheet_to_csv(sh,{FS:',',RS:'\n'});csv=normalizeHeader(csv);const rows=Math.max(0,csv.trim().split(/\r?\n/).filter(Boolean).length-1);if(rows>best.rows)best={rows,csv};}return best.rows>=1?best.csv:null;}
async function tryExcelGET(p){const url=`${location.origin}/index.php?page=print_vikar_list_custom_excel&sortBy=&${p}`;return gmGETArrayBuffer(url,{'Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel;q=0.9,*/*;q=0.8','Referer':location.href});}
async function tryExcelPOST(p){const url=`${location.origin}/index.php?page=print_vikar_list_custom_excel`;return gmPOSTArrayBuffer(url,p,{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel;q=0.9,*/*;q=0.8','Referer':location.href});}

/* NYT: Saml vikar-IDs */
function collectVisibleVikarIds(doc=document){ const ids=new Set();
  [...doc.querySelectorAll('a[href*="showvikaroplysninger"][href*="vikar_id="]')].forEach(a=>{const m=(a.href||'').match(/vikar_id=(\d+)/);if(m)ids.add(m[1]);});
  [...doc.querySelectorAll('[data-vikar-id]')].forEach(el=>{const v=el.getAttribute('data-vikar-id');if(/^\d+$/.test(v))ids.add(v);});
  return [...ids];
}
async function collectIdsViaAjax(){ // poster den aktive formular til vikarlist_get og parser IDs
  const form=document.querySelector('form#vikarsearchform');
  if(!form) return [];
  const fd=new FormData(form);
  fd.set('page','vikarlist_get'); fd.set('ajax','true'); fd.set('showheader','true'); fd.set('printlist','true');
  const body=[...fd.entries()].map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  const html=await gmPOST(location.origin+'/index.php', body, {'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'});
  const doc=new DOMParser().parseFromString(html,'text/html');
  return collectVisibleVikarIds(doc);
}

/* Hent Excel som CSV – med fetchIds */
async function fetchExcelAsCSVText(){
  await ensureXLSX();

  // 1) Prøv først at bruge de IDs, der faktisk er vist i UI’et
  let ids=collectVisibleVikarIds(document);
  if(!ids.length){ // 2) Fallback: hent via ajax (samme som knappen gør)
    try{ ids=await collectIdsViaAjax(); }catch(_){}
  }

  if(ids.length){
    const params='fetchIds='+encodeURIComponent(ids.join(','))+'&id=true&name=true&phone=true&cellphone=true';
    try{
      const ab=await tryExcelPOST(params);
      const wb=XLSX.read(ab,{type:'array'}); const csv=pickBestSheetCSV(wb);
      if(csv) return csv;
    }catch(e){ console.warn('[TP][PB] Excel m. fetchIds fejlede', e); }
  }

  // 3) Sidste fallback (kan give 0 rækker på nogle setups)
  const tries=[{fn:tryExcelGET,params:'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag'},
               {fn:tryExcelGET,params:'id=true&name=true&phone=true&cellphone=true'},
               {fn:tryExcelPOST,params:'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag'},
               {fn:tryExcelPOST,params:'id=true&name=true&phone=true&cellphone=true'}];
  for(const t of tries){ try{
      const ab=await t.fn(t.params); if(!ab||ab.byteLength<128) continue;
      const wb=XLSX.read(ab,{type:'array'}); if(!wb.SheetNames?.length) continue;
      const csv=pickBestSheetCSV(wb); if(csv) return csv;
    }catch(e){ console.warn('[TP][PB] Excel fallback', e); } }
  return null;
}

async function fetchExcelAsCSVAndUpload(){
  const text=await fetchExcelAsCSVText();
  if(!text){ showToastOnce('csv','Ingen rækker fra Temponizer – beholdt eksisterende CSV.'); return; }
  const lines=text.trim().split(/\r?\n/).filter(Boolean);
  if(lines.length<2){ showToastOnce('csv','Kun header – beholdt eksisterende CSV.'); return; }
  const base64=b64Utf8(text);
  const {sha}=await ghGetSha(PB_OWNER,PB_REPO,PB_CSV,PB_BRANCH);
  await ghPutFile(PB_OWNER,PB_REPO,PB_CSV,base64,'sync: Excel→CSV via TM (fetchIds)',sha,PB_BRANCH);
  showToastOnce('csvok','CSV uploadet (Excel→CSV).');
}

/* Caller-pop (kun INBOUND) */
let _lastPopAt=0;
async function callerPopIfNeeded(){
  try{
    const q=new URLSearchParams(location.search);
    const raw=q.get('tp_caller'); if(!raw) return;
    const dir=(q.get('tp_dir')||'').toLowerCase();
    const inbound=(dir==='in')||/\*1500$/.test(String(raw));
    if(!inbound) return;
    if(Date.now()-_lastPopAt<3000) return; _lastPopAt=Date.now();

    const p8=normPhone(String(raw).replace(/\*1500$/,''));
    if(!p8){ showToast('Ukendt nummer: '+raw); return; }

    // cache-bust RAW CSV
    const csv = await gmGET(RAW_PHONEBOOK+'?t='+(Date.now()));
    const {map} = parsePhonebookCSV(csv);
    const rec = map.get(p8);
    if(!rec){ showToast('Ingen match i telefonbogen: '+p8); return; }
    const url=`/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    showToast(`Åbner vikar: ${rec.name||'ukendt navn'} (${rec.id})`);
    location.assign(url);
  }catch(e){ console.warn('[TP][CALLER]', e); }
}

/* UI: panel + gear (som 7.2, trimmed) */
function draggable(el,key,handle){(handle||el).style.cursor='move';let sx=0,sy=0,ox=0,oy=0,moving=false;restore();function restore(){const saved=JSON.parse(localStorage.getItem(key)||'null');if(!saved)return;el.style.position='fixed';el.style.right='';el.style.bottom='';el.style.left=saved.left;el.style.top=saved.top;setTimeout(()=>ensureOnScreen(el,key,true),0);}function down(e){if(e.button!==0)return;const t=e.target;if(/(input|textarea|select|button|a)/i.test(t.tagName))return;moving=true;sx=e.clientX;sy=e.clientY;const r=el.getBoundingClientRect();ox=r.left;oy=r.top;el.style.width=r.width+'px';el.style.height=r.height+'px';el.style.position='fixed';el.style.right='';el.style.bottom='';document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);e.preventDefault();}function move(e){if(!moving)return;const nx=ox+(e.clientX-sx);const ny=oy+(e.clientY-sy);el.style.left=Math.max(6,Math.min(window.innerWidth-el.offsetWidth-6,nx))+'px';el.style.top=Math.max(6,Math.min(window.innerHeight-el.offsetHeight-6,ny))+'px';}function up(){moving=false;localStorage.setItem(key,JSON.stringify({left:el.style.left,top:el.style.top}));document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);} (handle||el).addEventListener('mousedown',down);}
function ensureOnScreen(el,key,save){const r=el.getBoundingClientRect();let left=parseInt(el.style.left||'0',10), top=parseInt(el.style.top||'0',10);let ch=false;
  if(r.right<40||r.bottom<40||r.left>window.innerWidth-40||r.top>window.innerHeight-40){left=Math.max(6,Math.min(window.innerWidth-el.offsetWidth-6,left||window.innerWidth-el.offsetWidth-12));top=Math.max(6,Math.min(window.innerHeight-el.offsetHeight-6,top||window.innerHeight-el.offsetHeight-12));el.style.left=left+'px';el.style.top=top+'px';el.style.right='';el.style.bottom='';ch=true;}
  if(ch&&save){localStorage.setItem(key,JSON.stringify({left:el.style.left,top:el.style.top}));}
}
function injectUI(){
  document.getElementById('tpPanel')?.remove();
  document.getElementById('tpGear')?.remove();
  document.getElementById('tpMenu')?.remove();

  const d=document.createElement('div');
  d.id='tpPanel';
  d.style.cssText='position:fixed;bottom:8px;right:8px;z-index:2147483645;background:#f9f9f9;border:1px solid #ccc;border-radius:6px;font-size:12px;font-family:sans-serif;box-shadow:1px 1px 5px rgba(0,0,0,.2);min-width:220px';
  d.innerHTML='<div id="tpPanelHandle" style="padding:6px 10px;font-weight:700;background:#f3f3f3;border-bottom:1px solid #ddd;cursor:move">TP Notifikationer</div>'+
              '<div style="padding:8px 10px">'+
              '<label style="display:block;margin:2px 0"><input type="checkbox" id="m"> Besked (Pushover) <span id="tpMsgBadge" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:6px;border-radius:10px;background:#eee;border:1px solid #ccc;text-align:center">0</span></label>'+
              '<label style="display:block;margin:2px 0"><input type="checkbox" id="i"> Interesse (Pushover) <span id="tpIntBadge" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:6px;border-radius:10px;background:#eee;border:1px solid #ccc;text-align:center">0</span></label>'+
              '</div>';
  document.body.appendChild(d);
  setTimeout(()=>ensureOnScreen(d,'tpPosPanel',false),0);
  const handle=d.querySelector('#tpPanelHandle'); draggable(d,'tpPosPanel',handle);

  const m=d.querySelector('#m'), i=d.querySelector('#i');
  m.checked=localStorage.getItem('tpPushEnableMsg')==='true';
  i.checked=localStorage.getItem('tpPushEnableInt')==='true';
  m.onchange=()=>localStorage.setItem('tpPushEnableMsg',m.checked?'true':'false');
  i.onchange=()=>localStorage.setItem('tpPushEnableInt',i.checked?'true':'false');
  msgBadgeEl=d.querySelector('#tpMsgBadge'); intBadgeEl=d.querySelector('#tpIntBadge');

  const gear=document.createElement('div');
  gear.id='tpGear'; gear.title='Indstillinger (Shift+klik = reset panel)'; gear.innerHTML='⚙️';
  Object.assign(gear.style,{position:'fixed',right:'12px',bottom:(8+d.offsetHeight+10)+'px',width:'22px',height:'22px',lineHeight:'22px',textAlign:'center',background:'#fff',border:'1px solid #ccc',borderRadius:'50%',boxShadow:'0 1px 5px rgba(0,0,0,.2)',cursor:'pointer',zIndex:2147483647,userSelect:'none'});
  document.body.appendChild(gear);

  let menu=null, leaderTimer=null;
  function buildMenu(){
    if(menu) return menu;
    menu=document.createElement('div'); menu.id='tpMenu';
    Object.assign(menu.style,{position:'fixed',zIndex:2147483647,background:'#fff',border:'1px solid #ccc',borderRadius:'8px',boxShadow:'0 2px 12px rgba(0,0,0,.25)',fontSize:'12px',fontFamily:'sans-serif',padding:'10px',width:'420px',maxHeight:'80vh',overflow:'auto'});
    menu.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>'+
      '<div style="margin-bottom:10px">'+
        '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>'+
        '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">'+
        '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'+
          '<button id="tpSaveUserKeyMenu" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Gem</button>'+
          '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Guide til USER-token</a>'+
        '</div>'+
      '</div>'+
      '<div style="border-top:1px solid #eee;margin:8px 0"></div>'+
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'+
        '<label><input type="checkbox" id="tpQuietOn"> Quiet hours</label>'+
        '<label>Fra <input type="time" id="tpQuietFrom" value="22:00"></label>'+
        '<label>Til <input type="time" id="tpQuietTo" value="06:00"></label>'+
        '<button id="tpResetPanel" style="margin-left:auto;padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Reset panel</button>'+
      '</div>'+
      '<div style="border-top:1px solid #eee;margin:8px 0"></div>'+
      '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>'+
      '<div id="tpLeaderHint" style="margin-top:6px;font-size:11px;color:#666"></div>'+
      '<div style="border-top:1px solid #eee;margin:10px 0"></div>'+
      '<div style="font-weight:700;margin-bottom:6px">Telefonbog</div>'+
      '<div style="margin-bottom:6px;font-size:12px;color:#444">CSV → GitHub</div>'+
      '<div style="margin-bottom:6px">'+
        '<div style="font-weight:600;margin-bottom:4px">GitHub PAT (fine-grained; Contents: RW til repo)</div>'+
        '<input id="tpGitPAT" type="password" placeholder="ghp_… eller fine-grained" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">'+
        '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'+
          '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1"/>'+
          '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>'+
          '<button id="tpPATTest" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">PAT-helbredstjek</button>'+
        '</div>'+
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">'+
          '<button id="tpFetchCSVUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⚡ Hent Excel → CSV + Upload</button>'+
        '</div>'+
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">'+
          '<input id="tpTestPhone" type="text" placeholder="Test nummer (fx 22 44 66 88)" style="flex:1;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">'+
          '<button id="tpLookupPhone" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Slå op i CSV</button>'+
        '</div>'+
        '<div id="tpPBHint" style="margin-top:6px;font-size:11px;color:#666"></div>'+
      '</div>';
    document.body.appendChild(menu);

    // wire
    const inp=menu.querySelector('#tpUserKeyMenu'), save=menu.querySelector('#tpSaveUserKeyMenu');
    const test=menu.querySelector('#tpTestPushoverBtn'), hint=menu.querySelector('#tpLeaderHint');
    const qOn=menu.querySelector('#tpQuietOn'), qF=menu.querySelector('#tpQuietFrom'), qT=menu.querySelector('#tpQuietTo');
    const resetBtn=menu.querySelector('#tpResetPanel');
    inp.value=getUserKey();
    const qc=getQuietCfg(); qOn.checked=qc.on; qF.value=qc.from; qT.value=qc.to;
    const applyQuiet=()=>{GM_setValue('tpQuietOn',qOn.checked===true);GM_setValue('tpQuietFrom',qF.value||'22:00');GM_setValue('tpQuietTo',qT.value||'06:00');};
    qOn.addEventListener('change',applyQuiet); qF.addEventListener('change',applyQuiet); qT.addEventListener('change',applyQuiet);
    save.addEventListener('click',()=>{GM_setValue('tpUserKey',(inp.value||'').trim());showToast('USER-token gemt.');});
    inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();GM_setValue('tpUserKey',(inp.value||'').trim());showToast('USER-token gemt.');}});
    test.addEventListener('click',()=>{tpTest();menu.style.display='none';});
    resetBtn.addEventListener('click',()=>{localStorage.removeItem('tpPosPanel');d.style.left='';d.style.top='';d.style.right='8px';d.style.bottom='8px';showToast('Panel reset.');});

    const pat=menu.querySelector('#tpGitPAT'), file=menu.querySelector('#tpCSVFile'), up=menu.querySelector('#tpUploadCSV');
    const csvUp=menu.querySelector('#tpFetchCSVUpload'), pbh=menu.querySelector('#tpPBHint'), patTest=menu.querySelector('#tpPATTest');
    pat.value=(GM_getValue('tpGitPAT')||''); pat.addEventListener('change',()=>GM_setValue('tpGitPAT',pat.value||''));
    up.addEventListener('click',async()=>{try{const token=(pat.value||'').trim();if(!token){showToast('Indsæt GitHub PAT først.');return;}if(!file.files||!file.files[0]){showToast('Vælg en CSV-fil først.');return;}const text=await file.files[0].text();const base64=b64Utf8(text);pbh.textContent='Uploader CSV…';const {sha}=await ghGetSha(PB_OWNER,PB_REPO,PB_CSV,PB_BRANCH);await ghPutFile(PB_OWNER,PB_REPO,PB_CSV,base64,'sync: upload CSV via TM',sha,PB_BRANCH);pbh.textContent='CSV uploadet.';showToast('CSV uploadet.');}catch(e){console.warn('[TP][CSV-UPLOAD]',e);pbh.textContent='Fejl ved CSV upload.';showToast('Fejl – se konsol.');}});
    csvUp.addEventListener('click',async()=>{try{pbh.textContent='Henter Excel → (fetchIds) → CSV → upload …';const t0=Date.now();await fetchExcelAsCSVAndUpload();pbh.textContent=`Færdig på ${Date.now()-t0} ms.`;}catch(e){console.warn('[TP][EXCEL→CSV]',e);pbh.textContent='Fejl ved Excel→CSV upload.';showToast('Fejl – se konsol.');}});
    patTest.addEventListener('click',async()=>{try{const token=(pat.value||'').trim();if(!token){showToast('Indsæt PAT først.');return;}const headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'};const rl=await new Promise((res,rej)=>GM_xmlhttpRequest({method:'GET',url:'https://api.github.com/rate_limit',headers,onload:r=>res(r),onerror:rej}));const repo=await new Promise((res,rej)=>GM_xmlhttpRequest({method:'GET',url:`https://api.github.com/repos/${PB_OWNER}/${PB_REPO}`,headers,onload:r=>res(r),onerror:rej}));if(rl.status===200&&repo.status===200){pbh.textContent='PAT OK – adgang til repo og rate limit aktiv.';showToast('PAT OK');}else{pbh.textContent=`PAT problem: rate=${rl.status} repo=${repo.status}`;showToast('PAT problem – se konsol.');}}catch(e){console.warn('[TP][PAT-TEST]',e);showToast('PAT test fejlede.');}});

    let leaderTimer=setInterval(()=>{hint.textContent=(isLeader()?'Denne fane er LEADER for push.':'Ikke leader – en anden fane sender push.')},1000);
    menu._stopLeader=()=>clearInterval(leaderTimer);
    return menu;
  }
  function toggleMenu(e){
    if(e && e.shiftKey){ localStorage.removeItem('tpPosPanel'); const d=document.getElementById('tpPanel'); if(d){d.style.left='';d.style.top='';d.style.right='8px';d.style.bottom='8px';} showToast('Panel reset.'); return;}
    const m=buildMenu(); const r=gear.getBoundingClientRect();
    m.style.right=(window.innerWidth-r.right)+'px'; m.style.bottom=(window.innerHeight-r.top+6)+'px';
    m.style.display=(m.style.display==='block'?'none':'block');
    if(m.style.display==='none' && m._stopLeader){m._stopLeader(); m._stopLeader=null;}
  }
  gear.addEventListener('click',toggleMenu);
  document.addEventListener('mousedown',e=>{const m=document.getElementById('tpMenu');if(m&&e.target!==m&&!m.contains(e.target)&&e.target!==gear)m.style.display='none';});
}

function tpTest(){const k=getUserKey();if(!k){showToast('Indsæt USER-token i ⚙️ først.');return;}const ts=new Date().toLocaleTimeString();_sendRaw('🧪 [TEST] Besked-kanal OK — '+ts).catch(()=>{});setTimeout(()=>_sendRaw('🧪 [TEST] Interesse-kanal OK — '+ts).catch(()=>{}),800);showToast('Sendte Pushover-test (Besked + Interesse).');}

/* startup */
document.addEventListener('click',e=>{const a=e.target.closest?.('a');if(a&&/Beskeder/.test(a.textContent||'')){if(isLeader()){const st=loadJson(ST_MSG_KEY,{count:0,lastPush:0,lastSent:0});st.lastPush=st.lastSent=0;saveJsonIfLeader(ST_MSG_KEY,st);}}});
tryBecomeLeader(); setInterval(heartbeatIfLeader,HEARTBEAT_MS); setInterval(tryBecomeLeader,HEARTBEAT_MS+1200);
callerPopIfNeeded().catch(()=>{});
pollMessages().catch(()=>{}); pollInterest().catch(()=>{}); (function schedule(){const ms=pollDelay();setTimeout(async()=>{await pollMessages();schedule();},ms);setTimeout(async()=>{await pollInterest();},ms+500);})();
injectUI();
console.info('[TP] kører version', TP_VER);

/* Hover “Intet Svar” (uændret) */
(function(){var auto=false,icon=null,menu=null,hideT=null;function mk(){if(menu)return menu;menu=document.createElement('div');Object.assign(menu.style,{position:'fixed',zIndex:2147483647,background:'#fff',border:'1px solid #ccc',borderRadius:'4px',boxShadow:'0 2px 8px rgba(0,0,0,.25)',fontSize:'12px',fontFamily:'sans-serif'});var btn=document.createElement('div');btn.textContent='Registrér “Intet Svar”';btn.style.cssText='padding:6px 12px;white-space:nowrap;cursor:default';btn.onmouseenter=function(){btn.style.background='#f0f0f0';};btn.onmouseleave=function(){btn.style.background='';};btn.onclick=function(){auto=true;if(icon)icon.click();hide();};menu.appendChild(btn);document.body.appendChild(menu);return menu;}
function show(el){icon=el;var r=el.getBoundingClientRect();var m=mk();m.style.left=r.left+'px';m.style.top=(r.bottom+4)+'px';m.style.display='block';}
function hide(){clearTimeout(hideT);hideT=setTimeout(function(){if(menu)menu.style.display='none';icon=null;},120);}
function find(n){while(n&&n!==document){if(n.getAttribute&&n.getAttribute('title')==='Registrer opkald til vikar')return n;n=n.parentNode;}return null;}
document.addEventListener('mouseover',function(e){var ic=find(e.target);if(ic)show(ic);},true);
document.addEventListener('mousemove',function(e){if(!menu||menu.style.display!=='block')return;var overM=menu.contains(e.target);var overI=icon&&(icon===e.target||icon.contains(e.target)||e.target.contains(icon));if(!overM&&!overI)hide();},true);
new MutationObserver(function(ml){if(!auto)return;ml.forEach(function(m){m.addedNodes.forEach(function(n){if(!(n instanceof HTMLElement))return;const hsWrap=n.closest&&n.closest('.highslide-body, .highslide-container');if(hsWrap){hsWrap.style.opacity='0';hsWrap.style.pointerEvents='none';}var ta=(n.matches&&n.matches('textarea[name="phonetext"]'))?n:(n.querySelector&&n.querySelector('textarea[name="phonetext"]'));if(ta){if(!ta.value.trim())ta.value='Intet Svar';var frm=ta.closest('form');var saveBtn=frm&&Array.prototype.find.call(frm.querySelectorAll('input[type="button"]'),function(b){return /Gem registrering/i.test(b.value||'');});if(saveBtn){setTimeout(function(){try{saveBtn.click();}catch(_){ }try{if(unsafeWindow.hs&&unsafeWindow.hs.close)unsafeWindow.hs.close();}catch(_){ }if(hsWrap){hsWrap.style.opacity='';hsWrap.style.pointerEvents='';}},30);}auto=false;}});});}).observe(document.body,{childList:true,subtree:true});})();
} // guard
