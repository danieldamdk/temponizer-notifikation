/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX */
// TPNotifs: beskeder + interesse + pushover + egne toasts/locks (kører på samme origin)
// Selvstændigt modul: kræver kun at hovedscriptet kalder TPNotifs.install(opts)

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
    rawPhonebookUrl: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache'
  });

  let CFG = { ...DEF };

  // ------- utils -------
  const now = () => Date.now();
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  function lockKey(kind){ return 'tpPushLock_'+kind; }

  function gmGET(url){
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method:'GET', url, headers:{ 'Accept':'*/*','Cache-Control':'no-cache','Pragma':'no-cache' },
        onload:r=> (r.status>=200&&r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)), onerror:reject });
    });
  }
  function loadJson(key, fallback){ try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch(_) { return JSON.parse(JSON.stringify(fallback)); } }
  function saveJson(key, obj){ localStorage.setItem(key, JSON.stringify(obj)); }
  function takeLock(kind){
    const key = lockKey(kind);
    const l = JSON.parse(localStorage.getItem(key)||'{"t":0}');
    if (Date.now() - l.t < (CFG.suppressMs + CFG.lockMsExtra)) return false;
    localStorage.setItem(key, JSON.stringify({ t: Date.now() }));
    return true;
  }

  // ------- toasts (OS + DOM) -------
  function showDOMToast(msg){
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position:'fixed', bottom:'12px', right:'12px', zIndex:2147483646,
      background:'#333', color:'#fff', padding:'8px 10px', borderRadius:'8px', fontSize:'12px',
      fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', boxShadow:'0 6px 18px rgba(0,0,0,.35)',
      opacity:0, transform:'translateY(8px)', transition:'opacity .22s, transform .22s'
    });
    document.body.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity=1; el.style.transform='translateY(0)'; });
    setTimeout(()=>{ el.style.opacity=0; el.style.transform='translateY(8px)'; setTimeout(()=>el.remove(), 260); }, 4200);
  }
  function showToast(msg){
    if ('Notification' in window){
      if (Notification.permission === 'granted') { try { new Notification('Temponizer', { body: msg }); } catch(_) { showDOMToast(msg); } return; }
      if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p=>{ if (p==='granted'){ try { new Notification('Temponizer', { body: msg }); } catch(_) { showDOMToast(msg); } else showDOMToast(msg); }).catch(()=>showDOMToast(msg));
        return;
      }
    }
    showDOMToast(msg);
  }
  function showToastOnce(key, msg){
    const lk = 'tpToastLock_'+key;
    const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
    if (Date.now() - o.t < (CFG.suppressMs + CFG.lockMsExtra)) return;
    localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
    showToast(msg);
  }

  // ------- Pushover -------
  function getUserKey(){ try { return (GM_getValue('tpUserKey')||'').trim(); } catch(_) { return ''; } }
  function sendPushover(msg){
    const userKey = getUserKey();
    const token = CFG.pushoverToken;
    if (!token || !userKey) return;
    const body = 'token=' + encodeURIComponent(token) + '&user=' + encodeURIComponent(userKey) + '&message=' + encodeURIComponent(msg);
    GM_xmlhttpRequest({ method:'POST', url:'https://api.pushover.net/1/messages.json', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, data: body });
  }

  // ------- Messages poller -------
  const MSG_KEYS = ['vagt_unread','generel_unread'];
  const ST_MSG_KEY = 'tpPushState_mod';
  function pollMessages(){
    fetch(CFG.msgUrl + '&ts=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:{ 'Cache-Control':'no-cache','Pragma':'no-cache' }} )
      .then(r=>r.json())
      .then(d => {
        const st = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
        const n  = MSG_KEYS.reduce((s,k)=> s + Number(d[k]||0), 0);
        const en = localStorage.getItem('tpPushEnableMsg') === 'true';
        if (n > st.count && n !== st.lastSent){
          const canPush = (Date.now()-st.lastPush > CFG.suppressMs) && takeLock('msg');
          if (canPush){
            const m = `🔔 Du har nu ${n} ulæst(e) Temponizer-besked(er).`;
            if (en) sendPushover(m);
            showToastOnce('msg', m);
            st.lastPush = Date.now(); st.lastSent = n;
          } else st.pending = Math.max(st.pending||0, n);
        } else if (n < st.count){ st.lastPush = 0; st.lastSent = n; if (st.pending && n <= st.pending) st.pending = 0; }
        st.count = n; saveJson(ST_MSG_KEY, st);
      })
      .catch(e=>console.warn('[TPNotifs][MSG]', e));
  }

  // ------- Interest poller -------
  const ST_INT_KEY = 'tpInterestState_mod';
  let lastETagSeen = localStorage.getItem('tpLastETag_mod') || null;

  function parseInterestHTML(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    if (!boxes.length) boxes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
    return boxes.reduce((s, el)=> s + (parseInt((el.textContent||'').replace(/\D+/g,''),10) || 0), 0);
  }
  function parseInterestPerMap(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const map = {};
    let boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    if (!boxes.length) boxes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
    for (const el of boxes){ const m=(el.id||'').match(/display_number_(\d+)/); if (!m) continue; map[m[1]] = parseInt((el.textContent||'').replace(/\D+/g,''),10) || 0; }
    return map;
  }
  // CSV support for name hints (vikarId→name)
  function parseCSV(text){ if (!text) return []; text=text.replace(/^\uFEFF/,''); const first=(text.split(/\r?\n/)[0]||''); const delim=(first.indexOf(';')>first.indexOf(','))?';':(first.includes(';')?';':','); const rows=[]; let i=0,f='',row=[],q=false; while(i<text.length){ const c=text[i]; if (q){ if(c==='"'){ if(text[i+1]==='"'){ f+='"'; i+=2; continue;} q=false; i++; continue;} f+=c; i++; continue;} if(c==='"'){ q=true; i++; continue;} if(c==='\r'){ i++; continue;} if(c==='\n'){ row.push(f.trim()); rows.push(row); row=[]; f=''; i++; continue;} if(c===delim){ row.push(f.trim()); f=''; i++; continue;} f+=c; i++; } if(f.length||row.length){ row.push(f.trim()); rows.push(row);} return rows.filter(r=>r.length&&r.some(x=>x!=='')); }
  function buildVikarIdMap(csv){ const rows=parseCSV(csv); const res=new Map(); if(!rows.length) return res; const hdr=rows[0].map(h=>h.toLowerCase()); const idxId=hdr.findIndex(h=>/(vikar.*nr|vikar[_ ]?id|^id$)/.test(h)); const idxName=hdr.findIndex(h=>/(navn|name)/.test(h)); if(idxId<0) return res; for(let r=1;r<rows.length;r++){ const row=rows[r]; const id=(row[idxId]||'').trim(); const name=idxName>=0?(row[idxName]||'').trim():''; if(id) res.set(String(id), name||''); } return res; }

  const INT_NAMES_CACHE_TTL_MS = 120000;
  const INT_NAMES_MAX_VAGTER = 3;
  const INT_NAMES_MAX_NAMES = 2;
  const gIntNamesCache = new Map();

  function summarizeNames(names){ if(!names||!names.length) return ''; const a=names.slice(0, INT_NAMES_MAX_NAMES); const rest=Math.max(0, names.length-a.length); const short=a.map(n=>{ const p=n.trim().split(/\s+/); return p.length>=2 ? (p[0]+' '+p[1][0].toUpperCase()+'.') : n; }); const main=short.join(', '); return rest>0? `${main} + ${rest} andre` : main; }

  function buildInterestMsg(count, hint){ return hint? `👀 ${hint} har vist interesse for ledige vagter.` : `👀 ${count} vikar(er) har vist interesse for ledige vagter.`; }

  async function pollInterest(){
    const force = false; // enkel version – evt. udvid via visibility
    fetch(CFG.interestUrl, { method:'HEAD', credentials:'same-origin', cache:'no-store', headers:{ ...(lastETagSeen?{'If-None-Match':lastETagSeen}:{}), 'Cache-Control':'no-cache','Pragma':'no-cache' }})
      .then(h => {
        const et = h.headers.get('ETag') || null; const changed = et && et!==lastETagSeen; if (et) localStorage.setItem('tpLastETag_mod', et); lastETagSeen = et || lastETagSeen || null;
        if (changed || h.status!==304 || force || !et){
          return fetch(CFG.interestUrl + '&_=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:{ 'Cache-Control':'no-cache', 'Pragma':'no-cache', 'Range':'bytes=0-40000' }})
            .then(r=>r.text())
            .then(async html => {
              const total = parseInterestHTML(html);
              const perMap = parseInterestPerMap(html);

              // Rising logic: find vagter whose count increased
              const prevPer = JSON.parse(localStorage.getItem('tpIntPer_prev_mod')||'{}');
              const rising = [];
              for (const [id,cnt] of Object.entries(perMap)){ const prev=Number(prevPer[id]||0); if (cnt>prev) rising.push(id); }
              localStorage.setItem('tpIntPer_prev_mod', JSON.stringify(perMap));

              let hint='';
              if (CFG.enableInterestNameHints && rising.length){
                const toFetch = rising.slice(0, INT_NAMES_MAX_VAGTER);
                const nowTs = Date.now();
                const allNames = [];
                // Fetch popup HTML per vagt to get visible names
                for (const vagtId of toFetch){
                  const cached = gIntNamesCache.get(vagtId);
                  if (cached && (nowTs-cached.ts) < INT_NAMES_CACHE_TTL_MS && cached.names?.length){ allNames.push(...cached.names); continue; }
                  try {
                    const url = `${location.origin}/index.php?page=update_vikar_synlighed_from_list&ajax=true&vagt_type=single&vagt_avail_id=${encodeURIComponent(vagtId)}&t=${Date.now()}`;
                    const popup = await gmGET(url);
                    const doc = new DOMParser().parseFromString(popup,'text/html');
                    const rows = Array.from(doc.querySelectorAll('.vikar_interresse_list_container'));
                    const extracted = [];
                    for (const row of rows){
                      let name = (row.querySelector('.vikar_interresse_list_navn_container')||{}).textContent?.trim() || '';
                      if (name) extracted.push(name);
                    }
                    gIntNamesCache.set(vagtId, { ts: nowTs, names: extracted });
                    allNames.push(...extracted);
                  } catch(_){ /* ignore */ }
                }
                const uniq = Array.from(new Set(allNames));
                const summary = summarizeNames(uniq);
                if (summary) hint = summary;
                // If names end with '...' we could cross-ref CSV by vikarId. Omitted here for brev.
              }

              const st = loadJson(ST_INT_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
              if (total > st.count && total !== st.lastSent){
                const canPush = (Date.now()-st.lastPush > CFG.suppressMs) && takeLock('int');
                if (canPush){
                  const text = buildInterestMsg(total, hint);
                  if (localStorage.getItem('tpPushEnableInt')==='true') sendPushover(text);
                  showToastOnce('int', text);
                  st.lastPush = Date.now(); st.lastSent = total;
                } else st.pending = Math.max(st.pending||0, total);
              } else if (total < st.count){ st.lastPush=0; st.lastSent=total; if (st.pending && total<=st.pending) st.pending=0; }
              st.count = total; saveJson(ST_INT_KEY, st);
            });
        }
      })
      .catch(e=>console.warn('[TPNotifs][INT]', e));
  }

  let _timer = null;
  function start(){ if (_timer) return; const tick = ()=>{ try { pollMessages(); pollInterest(); } catch(_){} }; tick(); _timer = setInterval(tick, CFG.pollMs); document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible') tick(); }); }
  function stop(){ if (_timer){ clearInterval(_timer); _timer=null; } }

  const TPNotifs = {
    install(opts={}){ CFG = { ...DEF, ...(opts||{}) }; start(); },
    start, stop,
    _cfg: ()=>({ ...CFG })
  };

  try { window.TPNotifs = Object.freeze(TPNotifs); } catch(_) {}
})();
