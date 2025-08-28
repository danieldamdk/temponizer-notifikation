/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, unsafeWindow */
// Caller module for Temponizer (IPNordic Communicator integration)
// - Beacon tab opened by Communicator with ?tp_caller=<number> broadcasts to other tabs and auto-closes
// - Other tabs show a toast with name lookup from CSV phonebook and optional link to vikar profile
// - Robust to whitespace, +45, and optional queue suffix (e.g. *1500). Last 8 digits used for DK numbers.

(function(){
  'use strict';

  if (window.TPCaller?.installed) return;

  const VER = 'v7.12.6-02';
  const NS  = `[TP][Caller ${VER}]`;
  const debug = localStorage.getItem('tpDebug') === '1';
  const dlog  = (...a) => { if (debug) console.info(NS, ...a); };

  // ---- Config (override by TPCaller.install(opts)) ----
  const DEF = Object.freeze({
    rawPhonebookUrl: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache',
    queueSuffix: '*1500',      // accepted but NOT required
    queueCode:   '1500',       // shown if secret/queue-only
    openInNewTab: true,
    debounceMs: 10000,
    autohideMs: 8000,
    eventKey: 'tpCallerEvtV2',
    z: 2147483646
  });

  let CFG = { ...DEF };
  let _installed = false;
  let _listenerAttached = false;

  // ---- Small utils ----
  const clamp = (n,min,max) => Math.max(min, Math.min(max, n));
  const now   = () => Date.now();

  function normPhone(raw){
    if (!raw) return '';
    // Trim, decode and strip non-digits except optional trailing *digits (queue suffix)
    let s = String(raw).trim();
    try { s = decodeURIComponent(s); } catch(_){}
    // Remove spaces
    s = s.replace(/\s+/g,'');
    // If suffix like *1500, drop it
    s = s.replace(/\*[0-9]+$/,'');
    // Strip non-digits
    s = s.replace(/[^0-9]/g,'');
    // Drop country code 45 if present by keeping last 8
    if (s.length > 8) s = s.slice(-8);
    return s;
  }

  function fmtPhone8(p8){
    return String(p8||'').replace(/(\d{2})(?=\d)/g,'$1 ').trim();
  }

  // ---- GM wrappers ----
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

  // ---- CSV phonebook ----
  function parsePhonebookCSV(txt){
    const map = new Map(); // p8 -> { id, name }
    const vikarsById = new Map();
    let header = [];
    try {
      const lines = txt.split(/\r?\n/);
      header = (lines.shift()||'').split(';');
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
        if (p8){ map.set(p8,{id,name}); if (id) vikarsById.set(id,{name,p8}); }
      }
    } catch(e){ dlog('CSV parse error', e); }
    return { map, header, vikarsById };
  }

  async function getCSVMap(){
    // Try live
    try{
      const txt = await gmGET(CFG.rawPhonebookUrl + '?t=' + now());
      if (txt && txt.length > 50) GM_SetValueSafe(CFG.cacheKeyCSV, txt);
      const { map } = parsePhonebookCSV(txt);
      if (map.size) return map;
    }catch(e){ dlog('live CSV error', e); }
    // Fallback to cache
    try{
      const cached = GM_GetValueSafe(CFG.cacheKeyCSV, '') || '';
      if (cached){ const { map } = parsePhonebookCSV(cached); if (map.size) return map; }
    }catch(e){ dlog('cache CSV error', e); }
    return new Map();
  }

  // ---- Toast UI ----
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
      host.innerHTML = `<div style="font-weight:600;margin-bottom:2px;">${title||'Indgående opkald'} ☎️</div>
        <div style="font-size:14px;">${primary||''}</div>
        ${secondary?`<div style="opacity:.8;margin-top:2px;">${secondary}</div>`:''}`;
      if (profileUrl){ host.addEventListener('click',()=>{ try{ window.open(profileUrl, CFG.openInNewTab?'_blank':'_self'); }catch(_){} }); }
      document.body.appendChild(host);
      requestAnimationFrame(()=>{ host.style.opacity='1'; host.style.transform='translateY(0)'; });
      const ms = clamp(Number(autohideMs||CFG.autohideMs)|0,1500,60000);
      setTimeout(()=>{ host.style.opacity='0'; host.style.transform='translateY(8px)';
        setTimeout(()=>{ try{ host.remove(); }catch(_){} }, 220);
      }, ms);
    }catch(e){ dlog('toast error', e); }
  }

  // ---- Broadcast between tabs ----
  function broadcast(payload){
    try{
      const ev = { ts: now(), payload };
      localStorage.setItem(CFG.eventKey, JSON.stringify(ev));
    }catch(_){/* ignore */}
  }

  function attachStorageListenerOnce(){
    if (_listenerAttached) return; _listenerAttached = true;
    window.addEventListener('storage', async (e)=>{
      if (e.key !== CFG.eventKey || !e.newValue) return;
      try{
        const { payload } = JSON.parse(e.newValue||'{}');
        if (!payload) return;
        // Debounce by number
        const p8 = payload.phone8 || (payload.secret ? 'secret' : 'x');
        const seenKey = 'tpCallerSeen_'+p8;
        const last = Number(localStorage.getItem(seenKey)||'0');
        if (now() - last < CFG.debounceMs) return;
        localStorage.setItem(seenKey, String(now()));

        let title   = 'Indgående opkald';
        let primary = '';
        let secondary = '';
        let profileUrl = null;

        if (payload.secret){
          secondary = `Via kø (${CFG.queueCode})`;
          primary   = 'Hemmelig/ukendt nummer';
        } else {
          const map = await getCSVMap();
          const hit = map.get(payload.phone8||'');
          const nice = fmtPhone8(payload.phone8);
          if (hit){ primary = `${hit.name} (${nice})`; profileUrl = `/index.php?page=vikar&show=${encodeURIComponent(hit.id)}`; }
          else { primary = nice; }
        }
        showCallerToast({ title, primary, secondary, profileUrl, autohideMs: CFG.autohideMs });
      }catch(err){ dlog('storage listener error', err); }
    });
  }

  // ---- Beacon tab handler ----
  function getParam(name){
    const rx = new RegExp(`[?&]${name}=([^&]*)`,'i');
    const m  = rx.exec(location.search);
    return m ? m[1] : '';
  }

  function tryClose(){
    try{ window.close(); }catch(_){}
    // Some browsers block close() if not opened by script; attempt to blank out
    try{ setTimeout(()=>{ try{ window.open('','_self'); window.close(); }catch(_){} }, 100); }catch(_){}
  }

  function processFromUrl(){
    try{
      const raw = String(getParam('tp_caller')||'').trim();
      if (!raw) return false;
      // Support secret or withheld numbers from Communicator (could be empty) → treat as secret when non-digits
      const hasDigits = /\d/.test(raw);
      const p8 = hasDigits ? normPhone(raw) : '';
      const secret = !hasDigits;
      const payload = secret ? { secret:true } : { phone8: p8 };
      broadcast(payload);
      dlog('beacon broadcast', payload);
      tryClose();
      return true;
    }catch(e){ dlog('processFromUrl error', e); return false; }
  }

  // ---- Public API ----
  const TPCaller = {
    install(opts){
      if (_installed) return; _installed = true;
      CFG = Object.freeze({ ...DEF, ...(opts||{}) });
      dlog('installed with CFG', CFG);
      attachStorageListenerOnce();
      // Auto-process beacon if param exists
      try { processFromUrl(); } catch(_){/* ignore */}
    },
    processFromUrl,
    config(){ return { ...CFG }; },
    version: VER,
    installed: true
  };

  try{ window.TPCaller = TPCaller; }catch(_){/* ignore */}

})();
