// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet svar" (AjourCare)
// @namespace    https://ajourcare.dk/
// @version      6.48
// @description  Push ved nye beskeder & interesse, hover-menu “Intet svar” AUTOGEM (single-shot + stealth). Poll via HEAD+ETag (20 kB range). ⚙︎ Pushover-opsætning; API-token er låst af administrator.
// @match        https://ajourcare.temponizer.dk/*
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=temponizer.dk
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*──────────────────── 1. KONFIG ────────────────────*/
const POLL_MS     = 30000;   // interval mellem polls
const SUPPRESS_MS = 45000;   // min. tid mellem push/toast pr. kategori
const LOCK_MS     = SUPPRESS_MS + 5000; // lås mod dobbelte notifikationer mellem tabs

// *** ADMIN – låst Pushover-token (samme for alle) ***
const ORG_PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';

/*──────────────────── Utils ────────────────────*/
function isPushEnabled(ch) {
  const v = (localStorage.getItem(ch === 'msg' ? 'tpPushEnableMsg'
                                               : 'tpPushEnableInt') || '')
            .trim().toLowerCase();
  return v === 'true';
}
function showToastOnce(key, msg) {
  const lk = 'tpToastLock_' + key;
  const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
  if (Date.now() - o.t < LOCK_MS) return;
  localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
  showToast(msg);
}
function showToast(msg) {
  if (Notification.permission === 'granted') {
    try { new Notification('Temponizer', { body: msg }); }
    catch (_) { showDOMToast(msg); }
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => {
      p === 'granted' ? new Notification('Temponizer', { body: msg })
                      : showDOMToast(msg);
    });
  } else showDOMToast(msg);
}
function showDOMToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position:'fixed',bottom:'16px',right:'16px',background:'#333',color:'#fff',
    padding:'10px 14px',borderRadius:'6px',fontSize:'13px',fontFamily:'sans-serif',
    boxShadow:'1px 1px 8px rgba(0,0,0,.4)',zIndex:2147483647,
    opacity:0,transition:'opacity .4s'
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.style.opacity = 1);
  setTimeout(()=>{ el.style.opacity = 0;
                   setTimeout(()=>el.remove(),500); }, 4000);
}

/*──────────────────── 2. Pushover ────────────────────*/
function sendPushover(msg, channel) {
  if (!isPushEnabled(channel)) {                       // gate
    console.info('[TP] Push blokeret – toggle OFF for', channel);
    return;
  }
  const user = GM_getValue('pushover_user','').trim();
  const token = ORG_PUSHOVER_TOKEN.trim();
  if (!token) { showToastOnce('noToken', 'ADMIN: API-token mangler i scriptet'); return; }
  if (!user)  { showToastOnce('noUser',  'Manglende USER-key – klik ⚙︎'); openTpSettings(); return; }

  const body = 'token=' + encodeURIComponent(token) +
               '&user='  + encodeURIComponent(user)  +
               '&message='+ encodeURIComponent(msg);

  GM_xmlhttpRequest({
    method:'POST', url:'https://api.pushover.net/1/messages.json',
    headers:{'Content-Type':'application/x-www-form-urlencoded'}, data:body,
    onerror(){ fetch('https://api.pushover.net/1/messages.json',
                     {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body})
               .catch(console.error);}
  });
}

/*──────────────────── 3. Beskeder ────────────────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread','generel_unread'];
const stMsg = JSON.parse(localStorage.getItem('tpPushState')||'{"count":0,"lastPush":0,"lastSent":0}');
function saveMsg(){ localStorage.setItem('tpPushState',JSON.stringify(stMsg)); }
function takeLock(){
  const l = JSON.parse(localStorage.getItem('tpPushLock')||'{"t":0}');
  if (Date.now()-l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock',JSON.stringify({t:Date.now()}));
  return true;
}
function pollMessages(){
  fetch(MSG_URL+'&ts='+Date.now(),{credentials:'same-origin'})
    .then(r=>r.json())
    .then(d=>{
      const n = MSG_KEYS.reduce((s,k)=>s+Number(d[k]||0),0);
      if (n>stMsg.count && n!==stMsg.lastSent){
        if (Date.now()-stMsg.lastPush>SUPPRESS_MS && takeLock()){
          const m='🔔 Du har nu '+n+' ulæst(e) Temponizer-besked(er).';
          sendPushover(m,'msg'); showToastOnce('msg',m);
          stMsg.lastPush=Date.now(); stMsg.lastSent=n;
        } else stMsg.lastSent=n;
      } else if (n<stMsg.count) stMsg.lastPush=0;
      stMsg.count=n; saveMsg();
      console.info('[TP-besked]',n,new Date().toLocaleTimeString());
    })
    .catch(console.error);
}

/*──────────────────── 4. Interesse (HEAD+ETag+Range) ────────────────────*/
const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETag=null;
const stInt=JSON.parse(localStorage.getItem('tpInterestState')||'{"count":0,"lastPush":0,"lastSent":0}');
function saveInt(){ localStorage.setItem('tpInterestState',JSON.stringify(stInt)); }
function pollInterest(){
  fetch(HTML_URL,{method:'HEAD',credentials:'same-origin',
                  headers:lastETag?{'If-None-Match':lastETag}:{}})
    .then(h=>{
      if (h.status===304){ console.info('[TP-int] uændret',new Date().toLocaleTimeString()); return;}
      lastETag=h.headers.get('ETag')||null;
      return fetch(HTML_URL,{credentials:'same-origin',headers:{Range:'bytes=0-20000'}})
             .then(r=>r.text()).then(parseInterestHTML);
    })
    .catch(console.error);
}
function parseInterestHTML(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const boxes=[...doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]')];
  const c=boxes.reduce((s,e)=>s+(parseInt(e.textContent.trim(),10)||0),0);
  if (c>stInt.count && c!==stInt.lastSent){
    if (Date.now()-stInt.lastPush>SUPPRESS_MS){
      const m='👀 '+c+' vikar(er) har vist interesse for ledige vagter';
      sendPushover(m,'int'); showToastOnce('int',m);
      stInt.lastPush=Date.now(); stInt.lastSent=c;
    } else stInt.lastSent=c;
  } else if (c<stInt.count) stInt.lastPush=0;
  stInt.count=c; saveInt();
  console.info('[TP-int]',c,new Date().toLocaleTimeString());
}

/*──────────────────── 5. UI (panel + ⚙︎) ────────────────────*/
function injectUI(){
  const d=document.createElement('div');
  Object.assign(d.style,{position:'fixed',bottom:'8px',right:'8px',zIndex:2147483646,
    background:'#f9f9f9',border:'1px solid #ccc',padding:'10px 12px',borderRadius:'6px',
    fontSize:'12px',fontFamily:'sans-serif',boxShadow:'1px 1px 5px rgba(0,0,0,.2)',
    minWidth:'220px'});
  d.innerHTML=
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'+
      '<b>TP Notifikationer</b>'+
      '<button id="tpSettings" style="all:unset;display:inline-flex;width:22px;height:22px;'+
      'justify-content:center;align-items:center;border-radius:50%;cursor:pointer;'+
      'background:rgba(255,255,255,.95);border:1px solid rgba(0,0,0,.15);'+
      'box-shadow:0 1px 3px rgba(0,0,0,.2);" title="Indstillinger">⚙︎</button>'+
    '</div>'+
    '<label style="display:block;margin:4px 0;"><input id="tp_msg" type="checkbox"> Besked (Push)</label>'+
    '<label style="display:block;margin:2px 0;"><input id="tp_int" type="checkbox"> Interesse (Push)</label>';
  document.body.appendChild(d);

  const m=document.getElementById('tp_msg'), i=document.getElementById('tp_int');
  m.checked=isPushEnabled('msg'); i.checked=isPushEnabled('int');
  m.onchange=()=>localStorage.setItem('tpPushEnableMsg',m.checked);
  i.onchange=()=>localStorage.setItem('tpPushEnableInt',i.checked);
  document.getElementById('tpSettings').onclick=openTpSettings;
}
function openTpSettings(){
  if (document.getElementById('tpSettingsModal')) return;
  const ov=document.createElement('div'); ov.id='tpSettingsModal';
  Object.assign(ov.style,{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',zIndex:2147483647});
  const box=document.createElement('div');
  Object.assign(box.style,{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
    background:'#fff',padding:'16px',borderRadius:'8px',width:'380px',
    boxShadow:'0 8px 24px rgba(0,0,0,.25)',fontFamily:'sans-serif',fontSize:'13px'});
  const user=GM_getValue('pushover_user','');
  box.innerHTML=
    '<h3 style="margin:0 0 8px;font-size:15px;">Pushover – opsætning</h3>'+
    '<label>Din USER-key<br><input id="tpUserKey" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;" value="'+user+'"></label>'+
    '<p style="margin:10px 0 8px;padding:8px;background:#fafafa;border:1px solid #e5e5e5;border-radius:6px;">'+
      '<b>API-token:</b> Låst af administrator.</p>'+
    '<div style="text-align:right;margin-top:14px;">'+
      '<button id="tpSave" style="padding:6px 10px;">Gem</button>'+
      '<button id="tpCancel" style="padding:6px 10px;margin-left:6px;">Luk</button>'+
    '</div>';
  ov.appendChild(box); document.body.appendChild(ov);
  document.getElementById('tpSave').onclick=()=>{ GM_setValue('pushover_user',document.getElementById('tpUserKey').value.trim());
                                                showToast('USER-key gemt'); ov.remove(); };
  document.getElementById('tpCancel').onclick=()=>ov.remove();
}

/*──────────────────── 6. Hover-menu “Intet svar” (auto + stealth, single-shot) ────────────────────*/
(function(){
  let auto=false, icon=null, menu=null, hideT=null, inFlight=false;
  function ensureCSS(){
    if (document.getElementById('tp-stealth')) return;
    const st=document.createElement('style'); st.id='tp-stealth';
    st.textContent='.tp-stealth .highslide-container,.tp-stealth .highslide-body,'+
                   '.tp-stealth .highslide-html,.tp-stealth .highslide-wrapper{opacity:0!important;pointer-events:none!important}';
    document.head.appendChild(st);
  }
  function mkMenu(){
    if (menu) return menu;
    menu=document.createElement('div');
    Object.assign(menu.style,{position:'fixed',zIndex:2147483647,background:'#fff',
      border:'1px solid #ccc',borderRadius:'4px',boxShadow:'0 2px 8px rgba(0,0,0,.25)',
      fontSize:'12px',fontFamily:'sans-serif'});
    const b=document.createElement('div');
    b.textContent='Registrér “Intet svar”';
    Object.assign(b.style,{padding:'6px 12px',whiteSpace:'nowrap',cursor:'default'});
    b.onmouseenter=()=>b.style.background='#f0f0f0';
    b.onmouseleave=()=>b.style.background='';
    b.onclick=()=>{
      if (inFlight) return;
      auto=true; inFlight=true; ensureCSS();
      document.documentElement.classList.add('tp-stealth');
      if (icon) icon.click(); hide();
    };
    menu.appendChild(b); document.body.appendChild(menu); return menu;
  }
  function show(el){ icon=el; const r=el.getBoundingClientRect();
    const m=mkMenu(); m.style.left=r.left+'px'; m.style.top=r.bottom+4+'px'; m.style.display='block'; }
  function hide(){ clearTimeout(hideT); hideT=setTimeout(()=>{ if(menu)menu.style.display='none'; icon=null; },120);}
  function findIcon(n){ while(n&&n!==document){ if(n.getAttribute&&n.getAttribute('title')==='Registrer opkald til vikar') return n; n=n.parentNode;} return null;}
  function triggerInput(el){ el.dispatchEvent(new Event('input',{bubbles:true}));
                            el.dispatchEvent(new Event('change',{bubbles:true})); }
  function findGem(root){
    return root.querySelector('input[type="button"][value="Gem registrering"]')||
      [...root.querySelectorAll('input[type="button"][onclick]')].find(b=>/(^|\\s)RegistrerOpkald\\(/.test(b.onclick+''));
  }
  function callDirect(str){
    const m=str&&str.match(/RegistrerOpkald\\(['"]?([^,'"]+)['"]?\\s*,\\s*['"]?([^,'"]+)['"]?\\)/);
    if (m&&unsafeWindow.RegistrerOpkald){ unsafeWindow.RegistrerOpkald(m[1],m[2]); return true;}
    return false;
  }
  function finish(){ setTimeout(()=>{ inFlight=false;
                                      document.documentElement.classList.remove('tp-stealth'); },250);}
  function handleTA(ta){
    if (!inFlight) return;
    const wanted='Intet svar';
    if (ta.value.trim()!==wanted){ ta.value=wanted; triggerInput(ta);}
    const form=(ta.closest&&ta.closest('form'))||document;
    const root=(ta.closest&& (ta.closest('.highslide-body,[role="dialog"],.modal,.ui-dialog,.bootbox,.sweet-alert')||form))||form;
    const btn=findGem(root)||findGem(document);
    if (btn){ setTimeout(()=>{ btn.click(); finish(); },60); }
    else if (callDirect(btn?btn.onclick+'':null) || callDirect((document.querySelector('input[onclick*="RegistrerOpkald"]')||{}).onclick+'')){ finish();}
    else { form&&form!==document? (form.requestSubmit?form.requestSubmit():form.submit()):null; finish();}
    auto=false;
  }

  document.addEventListener('mouseover',e=>{ const ic=findIcon(e.target); if(ic)show(ic); },true);
  document.addEventListener('mousemove',e=>{
    if(!menu||menu.style.display!=='block')return;
    const overM=menu.contains(e.target);
    const overI=icon&&(icon===e.target||icon.contains(e.target)||e.target.contains&&e.target.contains(icon));
    if(!overM&&!overI) hide();
  },true);

  new MutationObserver(mList=>{
    if(!auto) return;
    for(const m of mList){
      for(const n of m.addedNodes){
        if(!(n instanceof HTMLElement)) continue;
        const ta=n.matches&&n.matches('textarea[name="phonetext"]')?n:
                 n.querySelector&&n.querySelector('textarea[name="phonetext"]');
        if(ta){ handleTA(ta); return; }
      }
    }
  }).observe(document.body,{childList:true,subtree:true});
})();

/*──────────────────── 7. Init ────────────────────*/
document.addEventListener('click',e=>{
  const a=e.target.closest&&e.target.closest('a');
  if(a&&/Beskeder/.test(a.textContent||'')){ const st=JSON.parse(localStorage.getItem('tpPushState')||'{}'); st.lastPush=st.lastSent=0; localStorage.setItem('tpPushState',JSON.stringify(st)); }
});
pollMessages(); pollInterest();
setInterval(pollMessages,POLL_MS);
setInterval(pollInterest,POLL_MS);
injectUI();

console.info('[TP] kører version 6.48');
