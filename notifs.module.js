/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue */
(function(){
  'use strict';

  const DEF = Object.freeze({
    pushoverToken: '',
    pollMs: 15000,
    suppressMs: 45000,
    lockMsExtra: 5000,
    msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
    interestUrl: location.origin + '/index.php?page=freevagter',
    enableInterestNameHints: true,
    rawPhonebookUrl: 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache'
  });
  let CFG = { ...DEF };

  const ST_MSG_KEY = 'tpNotifs_msgStateV1';
  const ST_INT_KEY = 'tpNotifs_intStateV1';
  const ETag_KEY   = 'tpNotifs_lastETagV1';
  const TOAST_EVTKEY = 'tpNotifs_toastEventV1';

  const dbg = (...a)=>{ if (localStorage.getItem('tpDebug')==='1') console.log('[TPNotifs]', ...a); };

  // utils
  const loadJson = (k,fb)=>{ try { return JSON.parse(localStorage.getItem(k)||JSON.stringify(fb)); } catch(_){ return JSON.parse(JSON.stringify(fb)); } };
  const saveJson = (k,o)=> localStorage.setItem(k, JSON.stringify(o));
  const gmGET = (url)=> new Promise((res,rej)=>{
    GM_xmlhttpRequest({ method:'GET', url, headers:{'Accept':'*/*','Cache-Control':'no-cache','Pragma':'no-cache'},
      onload:r=>(r.status>=200&&r.status<300)?res(r.responseText):rej(new Error('HTTP '+r.status)),
      onerror:rej });
  });
  const takeLock = (kind)=>{
    const key='tpNotifs_lock_'+kind;
    const l = JSON.parse(localStorage.getItem(key)||'{"t":0}');
    if (Date.now()-l.t < (CFG.suppressMs+CFG.lockMsExtra)) return false;
    localStorage.setItem(key, JSON.stringify({ t: Date.now() }));
    return true;
  };

  // cross-tab DOM toast
  function showDOMToast(msg){
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position:'fixed', bottom:'12px', right:'12px', zIndex:2147483646,
      background:'#333', color:'#fff', padding:'8px 10px', borderRadius:'8px', fontSize:'12px',
      fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', boxShadow:'0 6px 18px rgba(0,0,0,.35)',
      opacity:0, transform:'translateY(8px)', transition:'opacity .22s, transform .22s'
    });
    document.body.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity=1; el.style.transform='translateY(0)'; });
    setTimeout(()=>{ el.style.opacity=0; el.style.transform='translateY(8px)'; setTimeout(()=>el.remove(),260); }, 4200);
  }
  const broadcastToast=(type,msg)=>{
    try {
      const ev={ id:`${Date.now()}-${Math.random().toString(36).slice(2)}`, type, msg, ts:Date.now() };
      localStorage.setItem(TOAST_EVTKEY, JSON.stringify(ev));
    } catch(_){}
  };
  window.addEventListener('storage', e=>{
    if (e.key!==TOAST_EVTKEY || !e.newValue) return;
    try {
      const ev = JSON.parse(e.newValue);
      const seenKey = 'tpNotifs_seen_'+ev.id;
      if (localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey,'1');
      showDOMToast(ev.msg);
    } catch(_){}
  });

  function showToast(msg){
    if ('Notification' in window){
      if (Notification.permission==='granted'){
        try { new Notification('Temponizer', { body: msg }); } catch(_){ showDOMToast(msg); }
        return;
      } else if (Notification.permission!=='denied'){
        Notification.requestPermission().then(p=>{
          if (p==='granted'){ try { new Notification('Temponizer', { body: msg }); } catch(_){ showDOMToast(msg); } else showDOMToast(msg);
        }).catch(()=>showDOMToast(msg));
        return;
      }
    }
    showDOMToast(msg);
  }
  function showToastOnce(key,msg){
    const lk='tpNotifs_toastLock_'+key;
    const o=JSON.parse(localStorage.getItem(lk)||'{"t":0}');
    if (Date.now()-o.t < (CFG.suppressMs+CFG.lockMsExtra)) return;
    localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
    broadcastToast(key,msg);
    showToast(msg);
  }

  // Pushover
  const getUserKey=()=>{ try { return (GM_getValue('tpUserKey')||'').trim(); } catch(_){ return ''; } };
  function sendPushover(msg){
    const token=(CFG.pushoverToken||'').trim(); const user=getUserKey();
    if (!token || !user) return;
    const body='token='+encodeURIComponent(token)+'&user='+encodeURIComponent(user)+'&message='+encodeURIComponent(msg);
    GM_xmlhttpRequest({ method:'POST', url:'https://api.pushover.net/1/messages.json', headers:{'Content-Type':'application/x-www-form-urlencoded'}, data: body });
  }

  // pending flush
  function maybeFlushPending(kind, pushEnableKey, stateKey, buildMsg){
    const st=loadJson(stateKey,{count:0,lastPush:0,lastSent:0,pending:0});
    const should = st.pending && (st.pending>(st.lastSent||0) || st.pending>(st.count||0));
    if (!should) return false;
    if (Date.now()-st.lastPush > CFG.suppressMs && takeLock(kind)){
      const text = (typeof buildMsg==='function') ? buildMsg(st.pending) : String(buildMsg);
      if (localStorage.getItem(pushEnableKey)==='true') sendPushover(text);
      showToastOnce(kind, text);
      st.lastPush=Date.now(); st.lastSent=st.pending; st.pending=0; saveJson(stateKey, st);
      return true;
    }
    return false;
  }

  // Messages poller
  const MSG_KEYS=['vagt_unread','generel_unread'];
  function pollMessages(){
    maybeFlushPending('msg','tpPushEnableMsg',ST_MSG_KEY, n=>`🔔 Du har nu ${n} ulæst(e) Temponizer-besked(er).`);
    fetch(CFG.msgUrl + '&ts=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:{'Cache-Control':'no-cache','Pragma':'no-cache'} })
      .then(r=>r.json())
      .then(d=>{
        const st=loadJson(ST_MSG_KEY,{count:0,lastPush:0,lastSent:0,pending:0});
        const n = MSG_KEYS.reduce((s,k)=> s + Number(d[k]||0), 0);
        const en = localStorage.getItem('tpPushEnableMsg')==='true';
        if (n>st.count && n!==st.lastSent){
          const canPush = (Date.now()-st.lastPush > CFG.suppressMs) && takeLock('msg');
          if (canPush){
            const m = `🔔 Du har nu ${n} ulæst(e) Temponizer-besked(er).`;
            if (en) sendPushover(m);
            showToastOnce('msg', m);
            st.lastPush=Date.now(); st.lastSent=n;
          } else { st.pending=Math.max(st.pending||0, n); }
        } else if (n<st.count){
          st.lastPush=0; st.lastSent=n; if (st.pending && n<=st.pending) st.pending=0;
        }
        st.count=n; saveJson(ST_MSG_KEY, st);
        try { document.dispatchEvent(new CustomEvent('tp:msg-count', { detail:{ count:n } })); } catch(_){}
      })
      .catch(e=>dbg('MSG poll error', e));
  }

  // Interesse poller
  let lastETagSeen = localStorage.getItem(ETag_KEY) || null;
  let lastIntParseTS = 0;
  let gIntPerPrev = {};
  const INT_NAMES_CACHE_TTL_MS = 120000;
  const INT_NAMES_MAX_VAGTER   = 3;
  const INT_NAMES_MAX_NAMES    = 2;
  const gIntNamesCache = new Map();

  const markParsedNow = ()=>{ lastIntParseTS=Date.now(); };
  const mustForceParse = ()=> (Date.now()-lastIntParseTS) > (CFG.pollMs*2);

  const parseInterestHTML = (html)=>{
    const doc = new DOMParser().parseFromString(html,'text/html');
    let boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    if (!boxes.length) boxes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
    return boxes.reduce((s,el)=> s + (parseInt((el.textContent||'').replace(/\D+/g,''),10)||0), 0);
  };
  const parseInterestPerMap = (html)=>{
    const doc = new DOMParser().parseFromString(html,'text/html');
    const map = {};
    let boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    if (!boxes.length) boxes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
    for (const el of boxes){
      const m = (el.id||'').match(/display_number_(\d+)/);
      if (m) map[m[1]] = parseInt((el.textContent||'').replace(/\D+/g,''),10)||0;
    }
    return map;
  };

  // CSV → Map(vikarId -> name)
  function parseCSV(t){ if(!t) return []; t=t.replace(/^\uFEFF/,''); const first=(t.split(/\r?\n/)[0]||''); const delim=(first.indexOf(';')>first.indexOf(','))?';':(first.includes(';')?';':','); const rows=[]; let i=0,f='',row=[],q=false; while(i<t.length){ const c=t[i]; if(q){ if(c==='"'){ if(t[i+1]==='"'){ f+='"'; i+=2; continue;} q=false; i++; continue;} f+=c; i++; continue;} if(c==='"'){ q=true; i++; continue;} if(c==='\r'){ i++; continue;} if(c==='\n'){ row.push(f.trim()); rows.push(row); row=[]; f=''; i++; continue;} if(c===delim){ row.push(f.trim()); f=''; i++; continue;} f+=c; i++; } if(f.length||row.length){ row.push(f.trim()); rows.push(row);} return rows.filter(r=>r.length&&r.some(x=>x!=='')); }
  function buildVikarIdMap(csv){ const rows=parseCSV(csv); const res=new Map(); if(!rows.length) return res; const hdr=rows[0].map(h=>h.toLowerCase()); const idxId=hdr.findIndex(h=>/(vikar.*nr|vikar[_ ]?id|^id$)/.test(h)); const idxName=hdr.findIndex(h=>/(navn|name)/.test(h)); if(idxId<0) return res; for(let r=1;r<rows.length;r++){ const row=rows[r]; const id=(row[idxId]||'').trim(); const name=idxName>=0?(row[idxName]||'').trim():''; if(id) res.set(String(id), name||''); } return res; }
  let _vikarNameById=null;
  async function ensureVikarNameMap(){
    if (_vikarNameById && _vikarNameById.size) return _vikarNameById;
    let csv=''; try { csv = await gmGET(CFG.rawPhonebookUrl + '?t=' + Date.now()); if (csv) GM_setValue(CFG.cacheKeyCSV, csv); } catch(_){}
    if (!csv) csv = GM_getValue(CFG.cacheKeyCSV) || '';
    _vikarNameById = buildVikarIdMap(csv);
    return _vikarNameById;
  }

  function summarizeNames(names){
    if (!names || !names.length) return '';
    const a = names.slice(0, INT_NAMES_MAX_NAMES);
    const rest = Math.max(0, names.length - a.length);
    const short = a.map(n => {
      const parts = n.trim().split(/\s+/);
      return parts.length>=2 ? (parts[0] + ' ' + parts[1][0].toUpperCase() + '.') : n;
    });
    const main = short.join(', ');
    return rest>0 ? `${main} + ${rest} andre` : main;
  }
  const buildInterestMsg = (count, hint)=> hint
    ? `👀 ${hint} har vist interesse for ledige vagter.`
    : `👀 ${count} vikar(er) har vist interesse for ledige vagter.`;

  const fetchInterestPopupHTML = (vagtAvailId)=>
    gmGET(`${location.origin}/index.php?page=update_vikar_synlighed_from_list&ajax=true&vagt_type=single&vagt_avail_id=${encodeURIComponent(vagtAvailId)}&t=${Date.now()}`);

  function parseInterestPopupNames(html, lookupByVikarId){
    const doc = new DOMParser().parseFromString(html,'text/html');
    const rows = Array.from(doc.querySelectorAll('.vikar_interresse_list_container, .vikar_interesse_list_container'));
    const out = [];
    for (const row of rows){
      // find vikarId
      let vikarId = '';
      const idAttr = row.id || '';
      let m = idAttr.match(/vagter_synlig_container_(\d+)_/);
      if (!m){
        const a = row.querySelector('.vikar_interresse_list_remove_container a, .vikar_interesse_list_remove_container a');
        const on = a && a.getAttribute && a.getAttribute('onclick') || '';
        m = on.match(/removeVagtInteresse\((\d+)\s*,/);
      }
      if (m) vikarId = m[1];

      let name = (row.querySelector('.vikar_interresse_list_navn_container, .vikar_interesse_list_navn_container')||{}).textContent?.trim() || '';
      // robust: både "..." og typografisk "…"
      if ((/\.{3}$/.test(name) || /\u2026$/.test(name)) && vikarId && lookupByVikarId){
        const full = lookupByVikarId(vikarId);
        if (full) name = full;
      }
      if (name) out.push(name);
    }
    // uniq (case-insensitive)
    const seen=new Set(), uniq=[];
    for (const n of out){ const k=n.toLowerCase(); if(!seen.has(k)){ seen.add(k); uniq.push(n); } }
    return uniq;
  }

  async function pollInterest(){
    const force = mustForceParse();
    fetch(CFG.interestUrl, {
      method:'HEAD', credentials:'same-origin', cache:'no-store',
      headers:{ ...(lastETagSeen ? {'If-None-Match': lastETagSeen} : {}), 'Cache-Control':'no-cache','Pragma':'no-cache' }
    }).then(h=>{
      const et = h.headers.get('ETag') || null;
      const changed = et && et !== lastETagSeen;
      if (et) localStorage.setItem(ETag_KEY, et);
      lastETagSeen = et || lastETagSeen || null;

      if (changed || h.status !== 304 || force || !et){
        return fetch(CFG.interestUrl + '&_=' + Date.now(), {
          credentials:'same-origin', cache:'no-store', headers:{ 'Cache-Control':'no-cache','Pragma':'no-cache','Range':'bytes=0-50000' }
        })
        .then(r=>r.text())
        .then(async html=>{
          const total = parseInterestHTML(html);
          const perNow = parseInterestPerMap(html);
          const rising = [];
          for (const [id,cnt] of Object.entries(perNow)){
            const prev = gIntPerPrev[id] || 0; if (cnt > prev) rising.push(id);
          }
          gIntPerPrev = perNow; markParsedNow();

          // navn-hint
          let namesHint = '';
          if (CFG.enableInterestNameHints && rising.length){
            const toFetch = rising.slice(0, INT_NAMES_MAX_VAGTER);
            const ts = Date.now();
            const nameMap = await ensureVikarNameMap();
            const lookup = (vikarId)=> nameMap.get(String(vikarId)) || '';
            const collected = [];
            for (const vagtId of toFetch){
              const cached = gIntNamesCache.get(vagtId);
              if (cached && (ts - cached.ts) < INT_NAMES_CACHE_TTL_MS && cached.names && cached.names.length){
                collected.push(...cached.names); continue;
              }
              try {
                const popup = await fetchInterestPopupHTML(vagtId);
                const names = parseInterestPopupNames(popup, lookup);
                gIntNamesCache.set(vagtId, { ts, names });
                if (names.length) collected.push(...names);
              } catch(_) {}
            }
            const merged = Array.from(new Set(collected));
            const summary = summarizeNames(merged);
            if (summary) namesHint = summary;
          }

          const st=loadJson(ST_INT_KEY,{count:0,lastPush:0,lastSent:0,pending:0});
          // flush pending hvis nødvendigt
          maybeFlushPending('int','tpPushEnableInt',ST_INT_KEY,(n)=>buildInterestMsg(n, namesHint));

          if (total > st.count && total !== st.lastSent){
            const canPush = (Date.now()-st.lastPush > CFG.suppressMs) && takeLock('int');
            if (canPush){
              const text = buildInterestMsg(total, namesHint);
              if (localStorage.getItem('tpPushEnableInt')==='true') sendPushover(text);
              showToastOnce('int', text);
              st.lastPush=Date.now(); st.lastSent=total;
            } else { st.pending=Math.max(st.pending||0, total); }
          } else if (total < st.count){
            st.lastPush=0; st.lastSent=total; if (st.pending && total<=st.pending) st.pending=0;
          }
          st.count=total; saveJson(ST_INT_KEY, st);
          try { document.dispatchEvent(new CustomEvent('tp:int-count', { detail:{ count: total } })); } catch(_){}
        });
      }
    }).catch(e=>dbg('INT poll error', e));
  }

  // public API
  let _timer=null;
  function start(){ if (_timer) return; const tick=()=>{ try{ pollMessages(); pollInterest(); }catch(_){}}; tick(); _timer=setInterval(tick, CFG.pollMs);
    document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible') tick(); });
  }
  function stop(){ if (_timer){ clearInterval(_timer); _timer=null; } }
  function install(opts={}){ CFG={ ...DEF, ...(opts||{}) };
    const heal=(key)=>{ const st=loadJson(key,{count:0,lastPush:0,lastSent:0,pending:0}); if(typeof st.pending!=='number') st.pending=0; if (st.lastSent>st.count) st.lastSent=st.count; saveJson(key, st); };
    heal(ST_MSG_KEY); heal(ST_INT_KEY);
    try{ localStorage.removeItem('tpPushLock'); }catch(_){}
    ensureVikarNameMap().catch(()=>{});
    start();
  }
  function testPushover(){ const user=getUserKey(); if(!user){ showToastOnce('test','Indsæt din Pushover USER-token i ⚙️ først.'); return; }
    const ts=new Date().toLocaleTimeString();
    sendPushover('🧪 [TEST] Besked-kanal OK — ' + ts);
    setTimeout(()=> sendPushover('🧪 [TEST] Interesse-kanal OK — ' + ts), 600);
    showToastOnce('testok','Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
  }

  const TPNotifs = { install, start, stop, testPushover, _cfg:()=>({ ...CFG }) };
  try { window.TPNotifs = Object.freeze(TPNotifs); } catch(_) { window.TPNotifs = TPNotifs; }
})();
