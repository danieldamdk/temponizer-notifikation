/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue */
// TPNotifs — besked/interest poll + DOM toasts + Pushover + badge events
(function(){
  'use strict';
  const VER = '2025-08-28-05';
  console.info('[TP] notifs.module v'+VER+' loaded at', new Date().toISOString());

  // defaults
  const DEF = Object.freeze({
    pushoverToken: '',
    pollMs: 15000,
    suppressMs: 45000,
    msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
    interestUrl: location.origin + '/index.php?page=freevagter',
    enableInterestNameHints: true,
    rawPhonebookUrl: '',
    cacheKeyCSV: 'tpCSVCache'
  });
  let CFG = { ...DEF };

  // state
  const ST_MSG = 'tpNotifs_msgStateV1';
  const ST_INT = 'tpNotifs_intStateV1';
  const LOCK_PREFIX = 'tpNotifs_lock_';

  const loadJson = (k,fb)=>{ try { return JSON.parse(localStorage.getItem(k)||JSON.stringify(fb)); } catch(_) { return JSON.parse(JSON.stringify(fb)); } };
  const saveJson = (k,v)=>{ localStorage.setItem(k, JSON.stringify(v)); };

  function showDOMToast(msg){
    const el=document.createElement('div');
    el.textContent=msg;
    Object.assign(el.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:2147483646,background:'#333',color:'#fff',padding:'8px 10px',borderRadius:'8px',font:'12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif',boxShadow:'0 6px 18px #00000059',opacity:0,transform:'translateY(8px)',transition:'opacity  220ms, transform  220ms'});
    document.body.appendChild(el);
    requestAnimationFrame(()=>{el.style.opacity=1;el.style.transform='translateY(0)';});
    setTimeout(()=>{el.style.opacity=0;el.style.transform='translateY(8px)';setTimeout(()=>el.remove(),260);},4200);
  }
  function toast(msg){
    if ('Notification' in window){
      if (Notification.permission==='granted'){
        try { new Notification('Temponizer',{ body: msg }); return; } catch(_){}
      } else if (Notification.permission!=='denied'){
        Notification.requestPermission().then(p=>{
          if (p==='granted'){ try { new Notification('Temponizer',{ body: msg }); } catch(_){ showDOMToast(msg); } }
          else showDOMToast(msg);
        }).catch(()=> showDOMToast(msg));
        return;
      }
    }
    showDOMToast(msg);
  }

  function takeLock(kind, ms){
    const k = LOCK_PREFIX+kind;
    const o = JSON.parse(localStorage.getItem(k)||'{"t":0}');
    if (Date.now() - o.t < ms) return false;
    localStorage.setItem(k, JSON.stringify({ t: Date.now() }));
    return true;
  }

  function sendPushover(message){
    const token = (CFG.pushoverToken||'').trim();
    const user  = (GM_getValue('tpUserKey')||'').trim();
    if (!token || !user) return;
    const data = 'token='+encodeURIComponent(token)+'&user='+encodeURIComponent(user)+'&message='+encodeURIComponent(message);
    GM_xmlhttpRequest({
      method:'POST',
      url:'https://api.pushover.net/1/messages.json',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      data
    });
  }

  function pollMessages(){
    fetch(CFG.msgUrl + '&_=' + Date.now(), { credentials:'same-origin', cache:'no-store' })
      .then(r=>r.json())
      .then(d=>{
        const st = loadJson(ST_MSG, {count:0,lastPush:0});
        const n  = Number(d.vagt_unread||0) + Number(d.generel_unread||0);
        // badge
        try { document.dispatchEvent(new CustomEvent('tp:msg-count', { detail:{ count:n } })); } catch(_){}

        if (n>st.count){
          const can = (Date.now()-st.lastPush > CFG.suppressMs) && takeLock('msg', CFG.suppressMs);
          if (can){
            const m = `🔔 Du har nu ${n} ulæst(e) besked(er).`;
            if (localStorage.getItem('tpPushEnableMsg')==='true') sendPushover(m);
            toast(m);
            st.lastPush = Date.now();
          }
        }
        st.count = n; saveJson(ST_MSG, st);
      })
      .catch(()=>{ /* stille */ });
  }

  // very light interest counter (no HEAD/ETag; robust against page markup)
  function parseInterestCount(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let nodes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    if (!nodes.length) nodes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
    let sum = 0;
    for (const n of nodes){
      const t = (n.textContent||'').replace(/\D+/g,'');
      if (t) sum += Number(t)||0;
    }
    return sum;
  }
  function pollInterest(){
    fetch(CFG.interestUrl + '&_=' + Date.now(), { credentials:'same-origin', cache:'no-store' })
      .then(r=>r.text())
      .then(html=>{
        const st = loadJson(ST_INT, {count:0,lastPush:0});
        const n  = parseInterestCount(html);
        // badge
        try { document.dispatchEvent(new CustomEvent('tp:int-count', { detail:{ count:n } })); } catch(_){}

        if (n>st.count){
          const can = (Date.now()-st.lastPush > CFG.suppressMs) && takeLock('int', CFG.suppressMs);
          if (can){
            const m = `👀 ${n} vikar(er) har vist interesse.`;
            if (localStorage.getItem('tpPushEnableInt')==='true') sendPushover(m);
            toast(m);
            st.lastPush = Date.now();
          }
        }
        st.count = n; saveJson(ST_INT, st);
      })
      .catch(()=>{ /* stille */ });
  }

  let _timer = null;
  function start(){
    if (_timer) return;
    const tick = ()=>{ try { pollMessages(); pollInterest(); } catch(_){} };
    tick();
    _timer = setInterval(tick, CFG.pollMs);
    document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible') tick(); });
  }
  function stop(){ if (_timer){ clearInterval(_timer); _timer=null; } }

  function install(opts={}){
    CFG = { ...DEF, ...(opts||{}) };
    // heal state
    const heal = (k)=>{ const st=loadJson(k,{count:0,lastPush:0}); if (typeof st.count!=='number') st.count=0; if (typeof st.lastPush!=='number') st.lastPush=0; saveJson(k,st); };
    heal(ST_MSG); heal(ST_INT);
    start();
  }

  function testPushover(){
    const user = (GM_getValue('tpUserKey')||'').trim();
    if (!user) { toast('Indsæt din Pushover USER-token i ⚙️ først.'); return; }
    const ts = new Date().toLocaleTimeString();
    sendPushover('🧪 [TEST] Besked-kanal OK — '+ts);
    setTimeout(()=> sendPushover('🧪 [TEST] Interesse-kanal OK — '+ts), 600);
    toast('Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
  }

  const api = { install, start, stop, testPushover, _cfg:()=>({ ...CFG }) };
  try { window.TPNotifs = Object.freeze(api); } catch(_) { window.TPNotifs = api; }
})();
