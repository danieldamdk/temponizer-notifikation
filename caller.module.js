/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue */
// Caller module for Temponizer (IPNordic Communicator integration)
// v7.12.12-hard — hard override + no about:blank + self/mirror toast + optional OS notifications
// - ALWAYS overrides any older window.TPCaller (e.g. '1.0.0') and exports an immutable TPCaller
// - Beacon broadcasts event; other tabs ACK and show toast
// - If no ACK: beacon shows its OWN toast, then soft-redirects to front (no window.close)
// - If ACK and this tab is visible (manual URL paste): short mirror toast here, then redirect
// - Normalizes numbers (+45, spaces, *suffix). Looks up name/ID from CSV. Debounce by number
// - Optional OS notifications so you see something even if Chrome is minimized

(function (w) {
  'use strict';

  // >>> HARD OVERRIDE: remove any old TPCaller so this version always takes over
  try {
    Object.defineProperty(w, 'TPCaller', { value: undefined, writable: true, configurable: true });
    delete w.TPCaller; // ignore result
  } catch (_) { try { w.TPCaller = undefined; } catch (_) {} }

  const VER = 'v7.12.12-hard';
  const NS  = `[TP][Caller ${VER}]`;
  const debug = localStorage.getItem('tpDebug') === '1';
  const dlog  = (...a) => { if (debug) console.info(NS, ...a); };

  const DEF = Object.freeze({
    rawPhonebookUrl: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/vikarer.csv',
    cacheKeyCSV:     'tpCSVCache',
    queueSuffix:     '*1500',
    queueCode:       '1500',
    debounceMs:      10000,
    autohideMs:      8000,
    eventKey:        'tpCallerEvtV2',
    ackPrefix:       'tpCallerAckV2:',
    lastKey:         'tpCallerLastV2',
    waitAckMs:       300,     // wait briefly for other tabs to ACK
    selfToastMs:     1800,    // duration when beacon shows its own toast
    mirrorOnAckWhenVisible: true,
    ackMirrorMs:     1100,    // short mirror toast if this tab is visible and others ACKed
    frontUrl:        '/index.php?page=front',
    z:               2147483646,
    osNotifs:        true     // show OS notifications if permitted
  });

  let CFG = { ...DEF };
  let _listenerAttached = false;

  // ----------------- utils -----------------
  const now   = () => Date.now();
  const clamp = (n,min,max) => Math.max(min, Math.min(max, n));
  function absFront(){ try{ return location.origin + CFG.frontUrl; }catch(_){ return CFG.frontUrl; } }

  function normPhone(raw){
    if (!raw) return '';
    let s = String(raw).trim();
    try { s = decodeURIComponent(s); } catch(_){ /* ignore */ }
    s = s.replace(/\s+/g,'');
    s = s.replace(/\*[0-9]+$/,''); // drop *queue suffix
    s = s.replace(/[^0-9]/g,'');
    if (s.length > 8) s = s.slice(-8); // DK 8 digits
    return s;
  }
  function fmtPhone8(p8){
    const s = String(p8||'');
    return s.replace(/(\d{2})(?=\d)/g, (m,a)=> a + ' ').trim();
  }

  function gmGET(url){
    return new Promise((resolve,reject)=>{
      try {
        GM_xmlhttpRequest({ method:'GET', url, headers:{'Accept':'*/*','Cache-Control':'no-cache','Pragma':'no-cache'},
          onload:r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
          onerror:e => reject(e)
        });
      } catch (e){ reject(e); }
    });
  }
  const GM_GetValueSafe = (k,def) => { try{ return GM_getValue(k,def); }catch(_){ return def; } };
  const GM_SetValueSafe = (k,v) => { try{ return GM_setValue(k,v); }catch(_){ return; } };

  function parsePhonebookCSV(txt){
    const map = new Map(); // p8 -> { id, name }
    try {
      const lines = txt.split(/\r?\n/);
      const header = (lines.shift()||'').split(';');
      const idxName = header.findIndex(h=>/navn/i.test(h));
      const idxPhone= header.findIndex(h=>/tlf|telefon|mobil/i.test(h));
      const idxId   = header.findIndex(h=>/id/i.test(h));
      for (const line of lines){
        if (!line.trim()) continue;
        const row = line.split(';');
        const name = (row[idxName]||'').trim();
        const phoneRaw = (row[idxPhone]||'').trim();
        const id = (row[idxId]||'').trim();
        const p8 = normPhone(phoneRaw);
        if (p8){ map.set(p8,{id,name}); }
      }
    } catch(e){ dlog('CSV parse error', e); }
    return map;
  }

  async function getCSVMap(){
    try{
      const txt = await gmGET(CFG.rawPhonebookUrl + '?t=' + now());
      if (txt && txt.length > 50) GM_SetValueSafe(CFG.cacheKeyCSV, txt);
      const map = parsePhonebookCSV(txt);
      if (map.size) return map;
    }catch(e){ dlog('live CSV error', e); }
    try{
      const cached = GM_GetValueSafe(CFG.cacheKeyCSV, '') || '';
      if (cached){ const map = parsePhonebookCSV(cached); if (map.size) return map; }
    }catch(e){ dlog('cache CSV error', e); }
    return new Map();
  }

  // --------- Notifications ---------
  function osNotify(title, body){
    if (!CFG.osNotifs || !('Notification' in window)) return;
    try{
      const show = ()=>{ try { new Notification(title||'Indgående opkald', { body: body||'', silent:false }); } catch(_){} };
      if (Notification.permission === 'granted') return show();
      if (Notification.permission === 'default'){
        const asked = localStorage.getItem('tpCallerNotifAsked') === '1';
        if (!asked){
          Notification.requestPermission().then(p=>{ try{ localStorage.setItem('tpCallerNotifAsked','1'); }catch(_){/* ignore */} if (p==='granted') show(); });
        }
      }
    }catch(_){/* ignore */}
  }

  function showCallerToast(opts){
    const { title, primary, secondary, profileUrl, autohideMs } = opts || {};
    try{
      const host = document.createElement('div');
      Object.assign(host.style, {
        position:'fixed', right:'12px', bottom:'12px', zIndex:String(CFG.z),
        background:'#1f2937', color:'#fff', borderRadius:'10px', boxShadow:'0 12px 28px rgba(0,0,0,.25)',
        padding:'10px 12px', maxWidth:'360px', font:'13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
        cursor: profileUrl ? 'pointer' : 'default', opacity:'0', transform:'translateY(8px)', transition:'opacity .16s ease, transform .16s ease'
      });
      host.setAttribute('role','alert');
      host.innerHTML = '<div style="font-weight:600;margin-bottom:2px;">'+(title||'Indgående opkald')+' ☎️</div>'+
        '<div style="font-size:14px;">'+(primary||'')+'</div>'+
        (secondary?'<div style="opacity:.8;margin-top:2px;">'+secondary+'</div>':'');
      if (profileUrl){ host.addEventListener('click',()=>{ try{ window.open(profileUrl, '_blank'); }catch(_){} }); }
      document.body.appendChild(host);
      requestAnimationFrame(()=>{ host.style.opacity='1'; host.style.transform='translateY(0)'; });
      const ms = clamp(Number(autohideMs||CFG.autohideMs)|0,1200,60000);
      setTimeout(()=>{ host.style.opacity='0'; host.style.transform='translateY(8px)';
        setTimeout(()=>{ try{ host.remove(); }catch(_){} }, 220);
      }, ms);
    }catch(e){ dlog('toast error', e); }
  }

  async function resolveAndShow(payload, ms){
    try{
      let title='Indgående opkald', primary='', secondary='', profileUrl=null;
      if (payload.secret){
        secondary = 'Via kø ('+CFG.queueCode+')';
        primary   = 'Hemmelig/ukendt nummer';
      } else {
        const map = await getCSVMap();
        const hit = map.get(payload.phone8||'');
        const nice = fmtPhone8(payload.phone8);
        if (hit){ primary = hit.name+' ('+nice+')'; profileUrl = '/index.php?page=vikar&show='+encodeURIComponent(hit.id); }
        else { primary = nice; }
      }
      showCallerToast({ title, primary, secondary, profileUrl, autohideMs: ms||CFG.autohideMs });
      osNotify(title, primary + (secondary ? (' — ' + secondary) : ''));
    }catch(e){ dlog('resolveAndShow error', e); }
  }

  function broadcast(ev){
    try{ localStorage.setItem(CFG.eventKey, JSON.stringify(ev)); }catch(_){/* ignore */}
  }

  function attachStorageListenerOnce(){
    if (_listenerAttached) return; _listenerAttached = true;
    window.addEventListener('storage', async (e)=>{
      if (e.key !== CFG.eventKey || !e.newValue) return;
      let ev=null; try{ ev = JSON.parse(e.newValue||'{}'); }catch(_){ return; }
      if (!ev || !ev.payload) return;
      const id = ev.id;
      // Debounce per number
      const p8 = ev.payload.phone8 || (ev.payload.secret ? 'secret' : 'x');
      const seenKey = 'tpCallerSeen_'+p8;
      if (now() - Number(localStorage.getItem(seenKey)||'0') < CFG.debounceMs) return;
      localStorage.setItem(seenKey, String(now()));
      // ACK back to beacon
      try { if (id) localStorage.setItem(CFG.ackPrefix+id, String(now())); } catch(_){/* ignore */}
      await resolveAndShow(ev.payload);
    });
  }

  function getParam(name){
    const rx = new RegExp('[?&]'+name+'=([^&]*)','i');
    const m  = rx.exec(location.search);
    return m ? m[1] : '';
  }

  function navigateAfter(ms){
    setTimeout(()=>{ try{ location.replace(absFront()); }catch(_){} }, Math.max(0, Number(ms)||0));
  }

  async function processFromUrl(){
    try{
      const raw = String(getParam('tp_caller')||'').trim();
      if (!raw) return false;
      const hasDigits = /\d/.test(raw);
      const p8 = hasDigits ? normPhone(raw) : '';
      const payload = hasDigits ? { phone8: p8 } : { secret:true };
      const ev = { id: Math.random().toString(36).slice(2)+now(), ts: now(), payload };
      try { localStorage.setItem(CFG.lastKey, JSON.stringify(ev)); } catch(_){/* ignore */}
      broadcast(ev);
      dlog('beacon broadcast', ev);

      setTimeout(async ()=>{
        const acked = !!localStorage.getItem(CFG.ackPrefix+ev.id);
        const p8key = payload.phone8 || (payload.secret ? 'secret' : 'x');
        const seenKey = 'tpCallerSeen_'+p8key;

        if (!acked){
          try { localStorage.setItem(seenKey, String(now())); } catch(_){/* ignore */}
          await resolveAndShow(payload, CFG.selfToastMs);
          navigateAfter(CFG.selfToastMs + 100);
        } else {
          if (CFG.mirrorOnAckWhenVisible && document.visibilityState === 'visible'){
            await resolveAndShow(payload, CFG.ackMirrorMs);
            navigateAfter(CFG.ackMirrorMs + 100);
          } else {
            navigateAfter(40);
          }
        }
      }, CFG.waitAckMs);
      return true;
    }catch(e){ dlog('processFromUrl error', e); return false; }
  }

  async function showLastIfRecent(){
    try{
      const ev = JSON.parse(localStorage.getItem(CFG.lastKey)||'null');
      if (!ev || !ev.ts) return;
      if (now() - ev.ts > 3000) return; // only very recent events
      const p8 = ev.payload.phone8 || (ev.payload.secret ? 'secret' : 'x');
      const seenKey = 'tpCallerSeen_'+p8;
      if (now() - Number(localStorage.getItem(seenKey)||'0') < CFG.debounceMs) return;
      localStorage.setItem(seenKey, String(now()));
      await resolveAndShow(ev.payload);
    }catch(_){/* ignore */}
  }

  const TPCaller = {
    install(opts){
      CFG = Object.freeze({ ...DEF, ...(opts||{}) });
      dlog('installed with CFG', CFG);
      attachStorageListenerOnce();
      try { processFromUrl(); } catch(_){/* ignore */}
      try { showLastIfRecent(); } catch(_){/* ignore */}
    },
    processFromUrl,
    config(){ return { ...CFG }; },
    version: VER
  };

  // Export as immutable value so older scripts cannot overwrite it with assignment.
  try {
    Object.defineProperty(w, 'TPCaller', { value: TPCaller, writable: false, configurable: true });
  } catch (_) {
    w.TPCaller = TPCaller;
  }

})(window);
