// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      7.10.6
// @description  Push (leader-only), OS/DOM toast m. cross-tab dedupe, “Intet Svar”-auto-gem (uden popup), telefonbog m. inbound caller-pop (nyt faneblad), Excel→CSV→Upload til GitHub, RAW CSV lookup, interesse-navne, smalt UI (badge tæt på tekst), én SMS-toggle under status, standardplacering helt ude til højre. Gear-menu auto-placeres i viewport.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      ajourcare.temponizer.dk
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @homepageURL  https://github.com/danieldamdk/temponizer-notifikation
// @supportURL   https://github.com/danieldamdk/temponizer-notifikation/issues
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// ==/UserScript==

/*──────── 0) VERSION ────────*/
const TP_VERSION = '7.10.6';

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_MS_LEADER    = 10000; // 10s snappy
const POLL_MS_NONLEADER = 15000; // 15s
const SUPPRESS_MS = 45000;       // channel-level suppression
const LOCK_MS     = SUPPRESS_MS + 5000;

// Cross-tab leader
const LEADER_KEY   = 'tpLeaderV1';
const HEARTBEAT_MS = 5000;
const LEASE_MS     = 15000;
const TAB_ID = (crypto && crypto.randomUUID ? crypto.randomUUID() : ('tab-' + Math.random().toString(36).slice(2) + Date.now()));

// Telefonbog / GitHub
const PB_OWNER  = 'danieldamdk';
const PB_REPO   = 'temponizer-notifikation';
const PB_BRANCH = 'main';
const PB_CSV    = 'vikarer.csv';
const RAW_PHONEBOOK = `https://raw.githubusercontent.com/${PB_OWNER}/${PB_REPO}/${PB_BRANCH}/${PB_CSV}`;
const CACHE_KEY_CSV = 'tpCSVCache';
const SCRIPT_RAW_URL = `https://raw.githubusercontent.com/${PB_OWNER}/${PB_REPO}/${PB_BRANCH}/temponizer.user.js`;

// Caller-pop
const OPEN_NEW_TAB_ON_INBOUND = true;

/*──────── 1a) MIGRATION ────────*/
(function migrateUserKeyToGM(){
  try {
    const gm = (GM_getValue('tpUserKey') || '').trim();
    if (!gm) {
      const ls = (localStorage.getItem('tpUserKey') || '').trim();
      if (ls) { GM_setValue('tpUserKey', ls); localStorage.removeItem('tpUserKey'); }
    }
  } catch(_) {}
})();

/*──────── 1b) NOTIF PERMISSION HINT (så OS-popups virker når minimeret) ────────*/
(function ensureNotifPermEarly(){
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      setTimeout(() => { Notification.requestPermission().catch(()=>{}); }, 1200);
    }
  } catch(_) {}
})();

/*──────── 2) TOAST + CROSS-TAB DEDUPE ────────*/
function showDOMToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position:'fixed', bottom:'12px', right:'12px',
    background:'#333', color:'#fff', padding:'8px 10px',
    borderRadius:'6px', fontSize:'12px', fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    boxShadow:'0 6px 18px rgba(0,0,0,.35)', zIndex:2147483646,
    opacity:0, transform:'translateY(8px)', transition:'opacity .22s, transform .22s'
  });
  document.body.appendChild(el);
  requestAnimationFrame(()=>{ el.style.opacity=1; el.style.transform='translateY(0)'; });
  setTimeout(()=>{ el.style.opacity=0; el.style.transform='translateY(8px)'; setTimeout(()=>el.remove(),260); }, 4000);
}
function showOSNotificationIfLeader(title, body){
  if (!isLeader()) return false;
  try {
    if (typeof Notification==='undefined') return false;
    if (Notification.permission==='granted') { new Notification(title, { body }); return true; }
    return false;
  } catch(_){ return false; }
}
function showToastOnce(key, msg){
  const lk = 'tpToastLock_' + key;
  const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
  if (Date.now() - o.t < LOCK_MS) return;
  localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
  showDOMToast(msg);
}

// Cross-tab event broadcast (leader → visible tab shows exactly 1 DOM toast)
const EVT_KEY = 'tpEvtV2';
function genEvtId(){ return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function broadcastEvt(channel, kind, msg){
  try {
    const ev = { id: genEvtId(), ch: channel, kind, msg, ts: Date.now() };
    localStorage.setItem(EVT_KEY, JSON.stringify(ev));
  } catch(_){}
}
window.addEventListener('storage', e => {
  if (e.key !== EVT_KEY || !e.newValue) return;
  try {
    const ev = JSON.parse(e.newValue);
    const seenK = 'tpEvtSeen_' + ev.id;
    if (localStorage.getItem(seenK)) return;
    if (document.visibilityState !== 'visible') return;
    // claim once
    const claimK = 'tpEvtClaim_' + ev.id;
    localStorage.setItem(claimK, TAB_ID);
    const v = localStorage.getItem(claimK);
    if (v !== TAB_ID) return;
    localStorage.setItem(seenK, String(Date.now()));
    showDOMToast(ev.msg);
  } catch(_){}
});

/*──────── 3) PUSHOVER ────────*/
function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
function sendPushover(msg) {
  const userKey = getUserKey();
  if (!PUSHOVER_TOKEN || !userKey) return;
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) + '&user=' + encodeURIComponent(userKey) + '&message=' + encodeURIComponent(msg);
  GM_xmlhttpRequest({
    method:'POST',
    url:'https://api.pushover.net/1/messages.json',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    data: body,
    onerror: () => { fetch('https://api.pushover.net/1/messages.json', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body }).catch(()=>{}); }
  });
}

/*──────── 4) STATE + LOCKS ────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];
const ST_MSG_KEY = 'tpPushState';     // {count,lastPush,lastSent,pendingCount,pendingTs}
const ST_INT_KEY = 'tpInterestState'; // {count,lastPush,lastSent,pendingCount,pendingTs}

function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (_) { return JSON.parse(JSON.stringify(fallback)); } }
function saveJson(key, obj)       { localStorage.setItem(key, JSON.stringify(obj)); }
function takeLock(channel) {
  const k = 'tpPushLock_' + channel;
  const l = JSON.parse(localStorage.getItem(k) || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem(k, JSON.stringify({ t: Date.now() })); return true;
}

/*──────── 5) POLLERS: BESKED ────────*/
function pollMessages(tabRole='leader') {
  fetch(MSG_URL + '&ts=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:{'Cache-Control':'no-cache','Pragma':'no-cache'} })
    .then(r => r.json())
    .then(d => {
      const n = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
      handleCount('msg', n, 'tpPushEnableMsg', ST_MSG_KEY, (c)=>`🔔 Du har nu ${c} ulæst(e) Temponizer-besked(er).`);
      const badge = document.getElementById('tpMsgCountBadge'); setBadge(badge, n);
    })
    .catch(e => console.warn('[TP][ERR][MSG]['+tabRole+']', e));
}

/*──────── 6) INTERESSE (HEAD→GET + navne) ────────*/
const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETagSeen = localStorage.getItem('tpLastETag') || null;
let lastIntParseTS = 0;
function markParsedNow(){ lastIntParseTS = Date.now(); }
function mustForceParse(){ return (Date.now() - lastIntParseTS) > (POLL_MS_LEADER * 2); }

function parseInterestHTML(html) {
  const doc   = new DOMParser().parseFromString(html, 'text/html');
  const boxes = Array.prototype.slice.call(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  const c = boxes.reduce((s, el) => { const v = parseInt((el.textContent||'').trim(), 10); return s + (isNaN(v) ? 0 : v); }, 0);
  return c;
}
function parseInterestPerMap(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const map = {};
  let boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  if (!boxes.length) boxes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
  for (const el of boxes) {
    const id = el.id || '';
    const m = id.match(/display_number_(\d+)/);
    if (!m) continue;
    const vagtId = m[1];
    const v = parseInt((el.textContent || '').replace(/\D+/g,''), 10);
    map[vagtId] = isNaN(v) ? 0 : v;
  }
  return map;
}

/* Navneopslag */
const INT_NAMES_CACHE_TTL_MS = 120000;  // 2 min
const INT_NAMES_MAX_VAGTER   = 3;
const INT_NAMES_MAX_NAMES    = 2;
let gIntPerPrev = {};
const gIntNamesCache = new Map();
let INT_NAME_HINT = '';

function gmGET(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: { 'Accept': '*/*', 'Referer': location.href, 'Cache-Control':'no-cache','Pragma':'no-cache' },
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function fetchInterestPopupHTML(vagtAvailId) {
  const url = `${location.origin}/index.php?page=update_vikar_synlighed_from_list&ajax=true&vagt_type=single&vagt_avail_id=${encodeURIComponent(vagtAvailId)}&t=${Date.now()}`;
  return gmGET(url);
}
function parseCSV(text) {
  if (!text) return [];
  text = text.replace(/^\uFEFF/, '');
  const firstLine = (text.split(/\r?\n/)[0] || '');
  const delim = (firstLine.indexOf(';') > firstLine.indexOf(',')) ? ';' : (firstLine.includes(';') ? ';' : ',');
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field.trim()); rows.push(row); row=[]; field=''; i++; continue; }
    if (c === delim) { row.push(field.trim()); field=''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter(r => r.length && r.some(x => x !== ''));
}
function parsePhonebookCSV(text) {
  const vikarsById = new Map();
  const map = new Map();
  const rows = parseCSV(text);
  if (!rows.length) return { map, header: [], vikarsById };
  const header = rows[0].map(h => h.toLowerCase());
  const idxId   = header.findIndex(h => /(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));
  const idxName = header.findIndex(h => /(navn|name)/.test(h));
  const phoneCols = header.map((h, idx) => ({ h, idx })).filter(x => /(telefon|mobil|cellphone|mobile|phone|tlf)/.test(x.h));
  if (idxId < 0 || phoneCols.length === 0) return { map, header, vikarsById };
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id   = (row[idxId]   || '').trim();
    const name = idxName >= 0 ? (row[idxName] || '').trim() : '';
    if (id) vikarsById.set(String(id), { id, name });
    if (!id) continue;
    for (const pc of phoneCols) {
      const val = (row[pc.idx] || '').trim();
      const p8 = normPhone(val);
      if (p8) map.set(p8, { id, name });
    }
  }
  return { map, header, vikarsById };
}
function csvLookupByVikarIdFactory() {
  try {
    const csv = GM_getValue(CACHE_KEY_CSV) || '';
    const parsed = parsePhonebookCSV(csv);
    const map = parsed.vikarsById || new Map();
    return (vikarId) => map.get(String(vikarId)) || null;
  } catch(_){ return null; }
}
function parseInterestPopupNames(html, csvLookupByVikarId) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = Array.from(doc.querySelectorAll('.vikar_interresse_list_container'));
  const out = [];
  for (const row of rows) {
    let vikarId = '';
    const idAttr = row.id || '';
    let m = idAttr.match(/vagter_synlig_container_(\d+)_/);
    if (m) vikarId = m[1];
    if (!vikarId) {
      const a = row.querySelector('.vikar_interresse_list_remove_container a');
      const on = a && a.getAttribute && a.getAttribute('onclick') || '';
      m = on.match(/removeVagtInteresse\((\d+)\s*,/);
      if (m) vikarId = m[1];
    }
    let name = (row.querySelector('.vikar_interresse_list_navn_container') || {}).textContent?.trim() || '';
    if (name.endsWith('...') && vikarId && csvLookupByVikarId) {
      const rec = csvLookupByVikarId(vikarId);
      if (rec && rec.name) name = rec.name;
    }
    if (name) out.push(name);
  }
  const seen = new Set(); const uniq = [];
  for (const n of out) { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(n); } }
  return uniq;
}
function summarizeNames(names) {
  if (!names || !names.length) return '';
  const a = names.slice(0, INT_NAMES_MAX_NAMES);
  const rest = Math.max(0, names.length - a.length);
  const short = a.map(n => {
    const parts = n.trim().split(/\s+/);
    if (parts.length >= 2) return parts[0] + ' ' + parts[1][0].toUpperCase() + '.';
    return n;
  });
  const main = short.join(', ');
  return rest > 0 ? `${main} + ${rest} andre` : main;
}
function buildInterestMsg(count) {
  const hint = INT_NAME_HINT && INT_NAME_HINT.trim();
  INT_NAME_HINT = '';
  return hint ? `👀 ${hint} har vist interesse for ledige vagter.` : `👀 ${count} vikar(er) har vist interesse for ledige vagter.`;
}

function pollInterestLeader() {
  const force = mustForceParse();
  fetch(HTML_URL, {
    method: 'HEAD', credentials: 'same-origin', cache: 'no-store',
    headers: { ...(lastETagSeen ? { 'If-None-Match': lastETagSeen } : {}), 'Cache-Control':'no-cache','Pragma':'no-cache' }
  })
  .then(h => {
    const et = h.headers.get('ETag') || null;
    const changed = et && et !== lastETagSeen;
    if (et) localStorage.setItem('tpLastETag', et);
    lastETagSeen = et || lastETagSeen || null;
    if (changed || h.status !== 304 || force || !et) {
      return fetch(HTML_URL + '&_=' + Date.now(), {
        credentials: 'same-origin', cache: 'no-store',
        headers: { 'Cache-Control':'no-cache', 'Pragma':'no-cache', 'Range':'bytes=0-40000' }
      })
      .then(r => r.text())
      .then(async (html) => {
        const total = parseInterestHTML(html);
        const perNow = parseInterestPerMap(html);
        const rising = [];
        for (const [id, cnt] of Object.entries(perNow)) {
          const prev = gIntPerPrev[id] || 0;
          if (cnt > prev) rising.push(id);
        }
        gIntPerPrev = perNow;
        markParsedNow();

        let namesHint = '';
        if (rising.length) {
          const toFetch = rising.slice(0, INT_NAMES_MAX_VAGTER);
          const now = Date.now();
          const lookup = csvLookupByVikarIdFactory();
          const nameSets = [];
          for (const vagtId of toFetch) {
            const cached = gIntNamesCache.get(vagtId);
            if (cached && (now - cached.ts) < INT_NAMES_CACHE_TTL_MS && cached.names?.length) {
              nameSets.push(cached.names);
              continue;
            }
            try {
              const htmlPopup = await fetchInterestPopupHTML(vagtId);
              const names = parseInterestPopupNames(htmlPopup, lookup);
              gIntNamesCache.set(vagtId, { ts: now, names });
              if (names.length) nameSets.push(names);
            } catch(_) {}
          }
          const merged = Array.from(new Set(nameSets.flat()));
          const summary = summarizeNames(merged);
          if (summary) namesHint = summary;
        }
        if (namesHint) INT_NAME_HINT = namesHint;

        handleCount('int', total, 'tpPushEnableInt', ST_INT_KEY, buildInterestMsg);
        const badgeI = document.getElementById('tpIntCountBadge'); setBadge(badgeI, total);
      });
    }
  })
  .catch(e => console.warn('[TP][ERR][INT][leader][HEAD]', e));
}

/* Fælles notify-håndtering med pending + micro-toast, leader-only push/OS */
function handleCount(channel, newCount, enableKey, stateKey, builderOrFn) {
  const st = loadJson(stateKey, { count:0, lastPush:0, lastSent:0, pendingCount:null, pendingTs:0, lastMicroTs:0 });
  const prev = st.count;
  const textFor = (c) => (typeof builderOrFn === 'function') ? builderOrFn(c) : builderOrFn;
  const now = Date.now();
  const canPushNow = (now - st.lastPush > SUPPRESS_MS) && takeLock(channel);

  // UI badges pulsering håndteres udenfor
  if (newCount > prev) {
    // Micro DOM (kun leader → broadcast til én synlig fane)
    if (!canPushNow && isLeader() && (now - st.lastMicroTs > 1500)) {
      const microMsg = textFor(newCount);
      broadcastEvt(channel, 'micro', microMsg);
      st.lastMicroTs = now;
    }
    if (canPushNow) {
      const txt = textFor(newCount);
      // Leader sender kun
      if (isLeader()) {
        // OS (hvis tilladt)
        const usedOS = showOSNotificationIfLeader('Temponizer', txt);
        // Pushover (hvis slået til)
        const en = localStorage.getItem(enableKey) === 'true';
        if (en) sendPushover(txt);
        // DOM: hvis vi brugte OS → broadcast til præcis 1 synlig fane; ellers local DOM i leader
        if (usedOS) broadcastEvt(channel, 'os', txt);
        else showToastOnce(channel, txt);
      }
      st.lastPush = now;
      st.lastSent = newCount;
      st.pendingCount = null; st.pendingTs = 0;
    } else {
      st.pendingCount = Math.max(st.pendingCount || 0, newCount);
      if (!st.pendingTs) st.pendingTs = now;
    }
  } else if (st.pendingCount != null && canPushNow) {
    const txt = textFor(st.pendingCount);
    if (isLeader()) {
      const usedOS = showOSNotificationIfLeader('Temponizer', txt);
      const en = localStorage.getItem(enableKey) === 'true';
      if (en) sendPushover(txt);
      if (usedOS) broadcastEvt(channel, 'os', txt);
      else showToastOnce(channel, txt);
    }
    st.lastPush = now; st.lastSent = st.pendingCount; st.pendingCount = null; st.pendingTs = 0;
  }
  if (newCount < prev) st.lastPush = 0;

  st.count = newCount; saveJson(stateKey, st);
}

/*──────── 7) LEADER-ELECTION ────────*/
function nowTs() { return Date.now(); }
function getLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (_) { return null; } }
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); }
function isLeader() { const L = getLeader(); return !!(L && L.id === TAB_ID && L.until > nowTs()); }
function tryBecomeLeader() {
  const L = getLeader(), t = nowTs();
  if (!L || (L.until || 0) <= t) {
    setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t });
    if (isLeader()) {
      // Øjeblikkelig poll ved leder-skifte
      pollMessages('leader');
      pollInterestLeader();
    }
  }
}
function heartbeatIfLeader() { if (!isLeader()) return; const t = nowTs(); setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); }

/*──────── 8) HTTP helpers (binære også) ────────*/
function gmGETArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: {
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8',
        'Referer': location.href,
        'Cache-Control':'no-cache','Pragma':'no-cache'
      },
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function gmPOSTArrayBuffer(url, body) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      responseType: 'arraybuffer',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8',
        'Referer': location.href,
        'Cache-Control':'no-cache','Pragma':'no-cache'
      },
      data: body,
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}

/*──────── 9) CALLER-POP (RAW CSV) ────────*/
function normPhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
}
async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const rawParam = q.get('tp_caller');
    if (!rawParam) return;

    const dirParam = (q.get('tp_dir') || '').toLowerCase();
    const rawStr = String(rawParam).trim();
    const isInbound = /\*1500\s*$/.test(rawStr) || dirParam === 'in';
    if (!isInbound) return;

    const digitsRaw = rawStr.replace(/\*1500\s*$/,'').replace(/[^\d+]/g, '');
    const phone8 = normPhone(digitsRaw);
    if (!phone8) return;

    let csvText = '';
    try {
      csvText = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now());
      if (csvText) GM_setValue(CACHE_KEY_CSV, csvText);
    } catch(_) {}
    if (!csvText) csvText = GM_getValue(CACHE_KEY_CSV) || '';
    if (!csvText) return;

    const { map } = parsePhonebookCSV(csvText);
    const rec = map.get(phone8);
    if (!rec) return;

    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    if (OPEN_NEW_TAB_ON_INBOUND) window.open(url, '_blank', 'noopener'); else location.assign(url);
  } catch (e) {
    console.warn('[TP][CALLER] error', e);
  }
}

/*──────── 10) GITHUB API (upload) + Excel → CSV ────────*/
function b64encodeUtf8(str) { const bytes = new TextEncoder().encode(str); let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin); }
async function ghGetSha(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: { 'Accept': 'application/vnd.github+json', ...(token ? {'Authorization': 'Bearer ' + token} : {}), 'X-GitHub-Api-Version': '2022-11-28' },
      onload: r => {
        if (r.status === 200) { try { const js = JSON.parse(r.responseText); resolve({ sha: js.sha, exists: true }); } catch(_) { resolve({ sha:null, exists:true }); } }
        else if (r.status === 404) resolve({ sha:null, exists:false });
        else reject(new Error('GitHub GET sha: HTTP '+r.status));
      },
      onerror: e => reject(e)
    });
  });
}
async function ghPutFile(owner, repo, path, base64Content, message, sha, branch) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'PUT', url,
      headers: { 'Accept': 'application/vnd.github+json', ...(token ? {'Authorization': 'Bearer ' + token} : {}), 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json;charset=UTF-8' },
      data: JSON.stringify({ message, content: base64Content, branch, ...(sha ? { sha } : {}) }),
      onload: r => { (r.status===200 || r.status===201) ? resolve(r.responseText) : reject(new Error('GitHub PUT: HTTP '+r.status+' '+(r.responseText||''))); },
      onerror: e => reject(e)
    });
  });
}
function normalizePhonebookHeader(csv) {
  const lines = csv.split(/\r?\n/);
  if (!lines.length) return csv;
  const hdr = (lines[0] || '').split(',');
  const mapName = (h) => {
    const x = h.trim().toLowerCase();
    if (/(vikar.*nr|vikar[_ ]?id|^id$)/.test(x)) return 'vikar_id';
    if (/(navn|name)/.test(x)) return 'name';
    if (/(^telefon$|phone(?!.*cell)|tlf)/.test(x)) return 'phone';
    if (/(mobil|cellphone|mobile)/.test(x)) return 'cellphone';
    return h.trim();
  };
  lines[0] = hdr.map(mapName).join(',');
  return lines.join('\n');
}
function pickBestSheetCSV(wb) {
  let best = { rows: 0, csv: '' };
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    let csv = XLSX.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n' });
    csv = normalizePhonebookHeader(csv);
    const lines = csv.trim().split(/\r?\n/).filter(Boolean);
    const dataRows = Math.max(0, lines.length - 1);
    if (dataRows > best.rows) best = { rows: dataRows, csv };
  }
  return best.rows >= 1 ? best.csv : null;
}
async function tryExcelGET(params) {
  const url = `${location.origin}/index.php?page=print_vikar_list_custom_excel&sortBy=&${params}`;
  return await gmGETArrayBuffer(url);
}
async function tryExcelPOST(params) {
  const url = `${location.origin}/index.php?page=print_vikar_list_custom_excel`;
  return await gmPOSTArrayBuffer(url, params);
}
async function fetchExcelAsCSVText() {
  const tries = [
    { fn: tryExcelGET,  params: 'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag' },
    { fn: tryExcelGET,  params: 'id=true&name=true&phone=true&cellphone=true' },
    { fn: tryExcelPOST, params: 'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag' },
    { fn: tryExcelPOST, params: 'id=true&name=true&phone=true&cellphone=true' },
  ];
  let lastInfo = '';
  for (const t of tries) {
    try {
      const ab = await t.fn(t.params);
      if (!ab || ab.byteLength < 128) { lastInfo = 'too small'; continue; }
      const wb = XLSX.read(ab, { type: 'array' });
      if (!wb.SheetNames || wb.SheetNames.length === 0) { lastInfo = 'no sheets'; continue; }
      const csv = pickBestSheetCSV(wb);
      if (csv) return csv;
      lastInfo = 'sheets found but header-only';
    } catch (e) { lastInfo = String(e && e.message || e); }
  }
  console.warn('[TP][PB] Excel→CSV mislykkedes. Sidste info:', lastInfo);
  return null;
}
async function fetchExcelAsCSVAndUpload() {
  const text = await fetchExcelAsCSVText();
  if (!text) { showToastOnce('csv', 'Temponizer gav ingen rækker – beholdt eksisterende CSV.'); return; }
  const lines = (text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) { showToastOnce('csv', 'CSV havde kun header – beholdt eksisterende CSV.'); return; }
  const base64 = b64encodeUtf8(text);
  const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
  await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: Excel→CSV via TM (auto)', sha, PB_BRANCH);
  GM_setValue(CACHE_KEY_CSV, text);
  showToastOnce('csvok', 'CSV uploadet (Excel→CSV).');
}

/*──────── 11) SMS (status + aktiver/deaktiver via skjult iframe – virker på alle sider) ────────*/
const SMS_SETTINGS_URL = `${location.origin}/index.php?page=showmy_settings`;
function hasDisplayBlock(el) {
  if (!el) return false;
  const s = (el.getAttribute('style') || '').replace(/\s+/g,'').toLowerCase();
  if (s.includes('display:none'))  return false;
  if (s.includes('display:block')) return true;
  return false;
}
function parseSmsStatusFromDoc(doc) {
  const elOn  = doc.getElementById('sms_notifikation_aktiv');
  const elOff = doc.getElementById('sms_notifikation_ikke_aktiv');
  const onShown  = hasDisplayBlock(elOn);
  const offShown = hasDisplayBlock(elOff);
  const hasDeact = !!(doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_aktiv a[href*="deactivate_cell_sms_notifikationer"]'));
  const hasAct   = !!(doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_ikke_aktiv a[href*="activate_cell_sms_notifikationer"]'));
  let state = 'unknown', phone = '';
  if (onShown || (!offShown && hasDeact && !hasAct)) state = 'active';
  else if (offShown || (!onShown && hasAct && !hasDeact)) state = 'inactive';
  const refTxt = state === 'active' ? (elOn?.textContent || '') : (elOff?.textContent || '');
  const m = refTxt.replace(/\u00A0/g,' ').match(/\+?\d[\d\s]{5,}/);
  if (m) phone = m[0].replace(/\s+/g,'');
  return { state, phone };
}
function parseSmsStatusFromHTML(html) { return parseSmsStatusFromDoc(new DOMParser().parseFromString(html, 'text/html')); }
async function fetchSmsStatusHTML() { return gmGET(SMS_SETTINGS_URL + '&t=' + Date.now()); }
async function getSmsStatus() { try { return parseSmsStatusFromHTML(await fetchSmsStatusHTML()); } catch { return { state: 'unknown' }; } }
function hardenSmsIframe(ifr){
  try {
    const w=ifr.contentWindow, d=ifr.contentDocument;
    if(!w||!d) return;
    w.open=()=>null; w.alert=()=>{}; w.confirm=()=>true;
    d.addEventListener('click',ev=>{
      const a=ev.target.closest&&ev.target.closest('a'); if(!a) return;
      ev.preventDefault(); ev.stopPropagation(); return false;
    },true);
  } catch(_){}
}
async function ensureSmsFrameLoaded() {
  let ifr = document.getElementById('tpSmsFrame');
  if (!ifr) {
    ifr = document.createElement('iframe');
    ifr.id = 'tpSmsFrame';
    Object.assign(ifr.style, { position:'fixed', left:'-10000px', top:'-10000px', width:'1px', height:'1px', opacity:'0', pointerEvents:'none', border:'0' });
    document.body.appendChild(ifr);
  }
  const loadOnce = () => new Promise(res => { ifr.onload = () => { hardenSmsIframe(ifr); res(); }; });
  const wantUrl = SMS_SETTINGS_URL;
  if (ifr.src !== wantUrl) { ifr.src = wantUrl; await loadOnce(); }
  else if (!ifr.contentWindow || !ifr.contentDocument || !ifr.contentDocument.body) { ifr.src = wantUrl; await loadOnce(); }
  else hardenSmsIframe(ifr);
  return ifr;
}
function getIframeStatus(ifr) { try { return parseSmsStatusFromDoc(ifr.contentDocument); } catch { return { state:'unknown' }; } }
function invokeIframeAction(ifr, wantOn) {
  const win = ifr.contentWindow, doc = ifr.contentDocument;
  try {
    if (wantOn && typeof win.activate_cell_sms_notifikationer === 'function') { win.activate_cell_sms_notifikationer(); return true; }
    if (!wantOn && typeof win.deactivate_cell_sms_notifikationer === 'function') { win.deactivate_cell_sms_notifikationer(); return true; }
  } catch(_) {}
  try {
    const link = wantOn
      ? (doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_ikke_aktiv a'))
      : (doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_aktiv a'));
    if (link) { link.click(); return true; }
  } catch(_) {}
  return false;
}
async function toggleSmsInIframe(wantOn, timeoutMs=15000, pollMs=500) {
  const ifr = await ensureSmsFrameLoaded();
  let st0 = getIframeStatus(ifr);
  if ((wantOn && st0.state === 'active') || (!wantOn && st0.state === 'inactive')) return st0;
  const invoked = invokeIframeAction(ifr, wantOn);
  if (!invoked) throw new Error('Kan ikke udløse aktivering/deaktiver i iframe.');
  const maybeReloaded = new Promise(res => { let done=false; ifr.addEventListener('load', () => { if (!done){ done=true; res(); } }, { once:true }); setTimeout(() => { if (!done) res(); }, 1200); });
  await maybeReloaded;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = getIframeStatus(ifr);
    if (wantOn && st.state === 'active') return st;
    if (!wantOn && st.state === 'inactive') return st;
    await new Promise(r => setTimeout(r, pollMs));
  }
  const reload = () => new Promise(res => { ifr.onload = () => res(); ifr.src = SMS_SETTINGS_URL + '&ts=' + Date.now(); });
  await reload();
  return getIframeStatus(ifr);
}
const sms = {
  _busy:false, _last:null,
  async refresh(cb){ const st = await getSmsStatus(); this._last = st; cb && cb(st); },
  async setEnabled(wantOn, uiBusy, cb){
    if (this._busy) return;
    this._busy = true;
    uiBusy && uiBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
    try {
      const st = await toggleSmsInIframe(wantOn, 15000, 500);
      this._last = st; cb && cb(st);
    } catch (e) {
      console.warn('[TP][SMS] setEnabled error', e);
      const st = await getSmsStatus(); this._last = st; cb && cb(st);
    } finally {
      this._busy = false; uiBusy && uiBusy(false);
    }
  }
};

/*──────── 12) UI (smalt panel + gear) ────────*/
function setBadge(el, n) { if (el) el.textContent = String(Number(n||0)); }
function badgePulse(el){ if (!el) return; el.animate([{transform:'scale(1)'},{transform:'scale(1.12)'},{transform:'scale(1)'}],{duration:300,easing:'ease-out'}); }

const POS_KEY = 'tpPanelPosV2';
function ensureFullyVisible(el, margin = 8) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top;
  const w = r.width, h = r.height;
  if (left < margin) left = margin;
  if (top  < margin) top  = margin;
  if (left + w > window.innerWidth  - margin) left = Math.max(margin, window.innerWidth  - margin - w);
  if (top  + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - h);
  el.style.position='fixed'; el.style.left=left+'px'; el.style.top=top+'px'; el.style.right='auto'; el.style.bottom='auto';
}
function makeDraggable(el, storageKey, handleSelector) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  handle.style.cursor='move'; handle.style.userSelect='none';
  let moving=false,startX=0,startY=0,baseLeft=0,baseTop=0;
  const down = e => {
    const p = e.touches ? e.touches[0] : e; moving = true;
    const r = el.getBoundingClientRect(); startX=p.clientX; startY=p.clientY; baseLeft=r.left; baseTop=r.top;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, {passive:false});
    document.addEventListener('touchend', up);
    e.preventDefault();
  };
  const move = e => {
    if (!moving) return;
    const p = e.touches ? e.touches[0] : e;
    const nx = Math.min(window.innerWidth - el.offsetWidth - 8, Math.max(8, baseLeft + (p.clientX - startX)));
    const ny = Math.min(window.innerHeight - el.offsetHeight - 8, Math.max(8, baseTop  + (p.clientY - startY)));
    el.style.position='fixed'; el.style.left = nx+'px'; el.style.top = ny+'px'; el.style.right='auto'; el.style.bottom='auto';
    e.preventDefault();
  };
  const up = () => {
    if (!moving) return; moving=false;
    const r = el.getBoundingClientRect();
    localStorage.setItem(storageKey, JSON.stringify({ left:r.left, top:r.top }));
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
  };
  handle.addEventListener('mousedown', down);
  handle.addEventListener('touchstart', down, {passive:false});
  window.addEventListener('resize', () => ensureFullyVisible(el, 8));
}
function injectUI() {
  if (document.getElementById('tpPanel')) return;

  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = [
    'position:fixed','top:12px','right:8px','z-index:2147483645',
    'background:#fff','border:1px solid #d7d7d7','padding:6px',
    'border-radius:6px','font-size:12px','font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.15)','display:inline-block',
    'min-width:180px','max-width:240px','width:auto','line-height:1.25'
  ].join(';');

  d.innerHTML =
    '<div id="tpHeader" style="display:flex;align-items:center;gap:4px;user-select:none">' +
      '<div style="font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
      '<div id="tpDragHint" style="font-size:10px;color:#888">træk</div>' +
    '</div>' +
    '<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">' +
      '<label style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><input type="checkbox" id="tpEnableMsg"> <span>Besked</span><span id="tpMsgCountBadge" style="margin-left:6px;min-width:16px;text-align:center;padding:0 4px;border-radius:10px;background:#eef;color:#224;font-weight:600;display:inline-block;border:1px solid #cbd;">0</span></label>' +
      '<label style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><input type="checkbox" id="tpEnableInt"> <span>Interesse</span><span id="tpIntCountBadge" style="margin-left:6px;min-width:16px;text-align:center;padding:0 4px;border-radius:10px;background:#efe;color:#262;font-weight:600;display:inline-block;border:1px solid #cbd;">0</span></label>' +
      '<div id="tpSMS" style="border-top:1px solid #eee;padding-top:6px;display:flex;flex-direction:column;gap:4px">' +
        '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">' +
          '<strong>SMS</strong>' +
          '<span id="tpSMSStatus" style="font-size:11px;color:#666;overflow:hidden;text-overflow:ellipsis;">indlæser…</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button id="tpSMSToggle" style="padding:4px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Aktivér</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(d);

  // Gear-knap ved panelet
  const gear = document.createElement('div');
  gear.id = 'tpGear'; gear.title = 'Indstillinger'; gear.innerHTML = '⚙️';
  Object.assign(gear.style, {
    position:'fixed', width:'20px', height:'20px', lineHeight:'20px', textAlign:'center',
    background:'#fff', border:'1px solid #ccc', borderRadius:'50%',
    boxShadow:'0 4px 12px rgba(0,0,0,.18)', cursor:'pointer', zIndex:2147483647, userSelect:'none'
  });
  document.body.appendChild(gear);

  function positionGearNearPanel(){
    const r = d.getBoundingClientRect();
    gear.style.left = (r.right - 10) + 'px';
    gear.style.top  = (r.top - 10) + 'px';
  }

  // Gem/indlæs placering (pixel)
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos && typeof pos.left==='number' && typeof pos.top==='number') {
      d.style.left = pos.left+'px'; d.style.top = pos.top+'px'; d.style.right='auto';
    }
  } catch(_){}
  ensureFullyVisible(d); positionGearNearPanel();

  makeDraggable(d, POS_KEY, '#tpHeader');
  window.addEventListener('resize', () => { ensureFullyVisible(d); positionGearNearPanel(); });

  // Toggles (styrer kun Pushover – OS/DOM styres automatisk)
  const msg = d.querySelector('#tpEnableMsg');
  const intr = d.querySelector('#tpEnableInt');
  msg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  intr.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  msg.onchange = () => localStorage.setItem('tpPushEnableMsg', msg.checked ? 'true' : 'false');
  intr.onchange = () => localStorage.setItem('tpPushEnableInt', intr.checked ? 'true' : 'false');

  // Badges init ud fra state
  const stMsg = loadJson(ST_MSG_KEY, {count:0});
  const stInt = loadJson(ST_INT_KEY, {count:0});
  setBadge(d.querySelector('#tpMsgCountBadge'), Number(stMsg.count||0));
  setBadge(d.querySelector('#tpIntCountBadge'), Number(stInt.count||0));

  // SMS UI (én toggle-knap)
  const smsBtn  = d.querySelector('#tpSMSToggle');
  const smsTag  = d.querySelector('#tpSMSStatus');
  function smsSetBusy(on, text){ smsBtn.disabled=on; if (on && text) smsTag.textContent=text; }
  function smsRender(st){
    const mark = (txt, color) => { smsTag.innerHTML = `<span style="color:${color};font-weight:600">${txt}</span>`; };
    smsBtn.disabled = false;
    switch (st.state) {
      case 'active':   smsBtn.textContent = 'Deaktiver';   mark('Aktiv' + (st.phone ? ' ('+st.phone+')' : ''), '#0a7a35'); break;
      case 'inactive': smsBtn.textContent = 'Aktivér';     mark('Ikke aktiv' + (st.phone ? ' ('+st.phone+')' : ''), '#a33'); break;
      default:         smsBtn.textContent = 'Aktivér';     mark('Ukendt', '#666');
    }
  }
  smsBtn.addEventListener('click', async () => {
    const wantOn = (sms._last?.state !== 'active');
    smsSetBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
    await sms.setEnabled(wantOn, smsSetBusy, smsRender);
  });
  (async () => { smsSetBusy(true, 'indlæser…'); await sms.refresh(smsRender); smsSetBusy(false); })();

  // Gear-menu
  let menu = null;
  function buildMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, {
      position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
      borderRadius:'8px', boxShadow:'0 12px 36px rgba(0,0,0,.22)', fontSize:'12px',
      fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      padding:'10px', width:'360px', maxHeight:'70vh', overflow:'auto', display:'none'
    });
    menu.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>' +
      '<div style="margin-bottom:10px">' +
        '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
        '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<button id="tpSaveUserKeyMenu" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Gem</button>' +
          '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">🧪 Test Pushover (Besked + Interesse)</button>' +
          '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Guide</a>' +
        '</div>' +
      '</div>' +
      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<div style="font-weight:700;margin-bottom:6px">Telefonbog</div>' +
      '<div style="margin-bottom:6px;font-size:12px;color:#444">CSV i GitHub bruges af caller-pop opslag.</div>' +
      '<div style="margin-bottom:6px">' +
        '<div style="font-weight:600;margin-bottom:4px">GitHub PAT (fine-grained • Contents: RW)</div>' +
        '<input id="tpGitPAT" type="password" placeholder="fine-grained token" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1"/>' +
          '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<button id="tpFetchCSVUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⚡ Hent Excel → CSV + Upload</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<input id="tpTestPhone" type="text" placeholder="Test nummer (fx 22 44 66 88)" style="flex:1;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
          '<button id="tpLookupPhone" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Slå op i CSV</button>' +
        '</div>' +
        '<div id="tpPBHint" style="margin-top:6px;font-size:11px;color:#666"></div>' +
      '</div>' +
      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🔄 Søg efter opdatering</button>' +
      '<div style="margin-top:6px;font-size:11px;color:#666">Kører v.'+TP_VERSION+'</div>';
    document.body.appendChild(menu);
    return menu;
  }
  function positionMenu(menu) {
    const pr = d.getBoundingClientRect();
    // placer under panelet hvis muligt, ellers over – altid 8px margin fra kanter
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.max(8, Math.min(window.innerWidth - mw - 8, pr.right - mw));
    let top  = pr.bottom + 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, pr.top - mh - 8);
    Object.assign(menu.style, { left:left+'px', top:top+'px', right:'auto', bottom:'auto' });
  }
  function openMenu(){
    const m = buildMenu();
    const inp  = m.querySelector('#tpUserKeyMenu');
    const save = m.querySelector('#tpSaveUserKeyMenu');
    const test = m.querySelector('#tpTestPushoverBtn');
    const pat  = m.querySelector('#tpGitPAT');
    const file = m.querySelector('#tpCSVFile');
    const up   = m.querySelector('#tpUploadCSV');
    const csvUp= m.querySelector('#tpFetchCSVUpload');
    const tIn  = m.querySelector('#tpTestPhone');
    const tBtn = m.querySelector('#tpLookupPhone');
    const pbh  = m.querySelector('#tpPBHint');
    const chk  = m.querySelector('#tpCheckUpdate');

    inp.value = getUserKey();
    save.onclick = () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showDOMToast('USER-token gemt.'); };

    pat.value = (GM_getValue('tpGitPAT') || '');
    pat.onchange = () => GM_setValue('tpGitPAT', pat.value || '');

    up.onclick = async () => {
      try {
        if (!file.files || !file.files[0]) { showDOMToast('Vælg en CSV-fil først.'); return; }
        const text = await file.files[0].text();
        const base64 = b64encodeUtf8(text);
        pbh.textContent = 'Uploader CSV…';
        const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
        await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: upload CSV via TM', sha, PB_BRANCH);
        GM_setValue(CACHE_KEY_CSV, text);
        pbh.textContent = 'CSV uploadet. RAW opdateres om få sek.'; showDOMToast('CSV uploadet.');
      } catch (e) { console.warn('[TP][PB][CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved CSV upload.'; showDOMToast('Fejl – se konsol.'); }
    };
    csvUp.onclick = async () => {
      try {
        pbh.textContent = 'Henter Excel, konverterer og uploader CSV …';
        const t0 = Date.now();
        await fetchExcelAsCSVAndUpload();
        pbh.textContent = `Færdig på ${Date.now()-t0} ms.`;
      } catch (e) { console.warn('[TP][PB][EXCEL→CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel→CSV upload.'; showDOMToast('Fejl – se konsol.'); }
    };
    tBtn.onclick = async () => {
      try {
        const raw = (tIn.value||'').trim();
        const p8 = normPhone(raw);
        if (!p8) { pbh.textContent = 'Ugyldigt nummer.'; return; }
        pbh.textContent = 'Slår op i CSV…';
        let csv = '';
        try { csv = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now()); if (csv) GM_setValue(CACHE_KEY_CSV, csv); } catch(_) {}
        if (!csv) csv = GM_getValue(CACHE_KEY_CSV) || '';
        const { map } = parsePhonebookCSV(csv);
        const rec = map.get(p8);
        if (!rec) { pbh.textContent = `Ingen match for ${p8}.`; return; }
        pbh.textContent = `Match: ${p8} → ${rec.name || '(uden navn)'} (vikar_id=${rec.id})`;
        const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
        window.open(url, '_blank', 'noopener');
      } catch(e) { console.warn('[TP][PB][LOOKUP]', e); pbh.textContent = 'Fejl ved opslag.'; }
    };
    test.onclick = () => { tpTestPushoverBoth(); closeMenu(); };
    chk.onclick = async () => {
      try {
        const raw = await gmGET(SCRIPT_RAW_URL+'?t='+Date.now());
        const m = raw.match(/@version\s+([0-9.]+)/);
        if (!m) { showDOMToast('Kunne ikke læse remote version.'); return; }
        const remote = m[1];
        if (remote === TP_VERSION) showDOMToast('Du kører allerede nyeste version ('+remote+').');
        else { showDOMToast('Ny version tilgængelig: '+remote+' (du kører '+TP_VERSION+'). Åbner…'); window.open(SCRIPT_RAW_URL, '_blank'); }
      } catch(_) { showDOMToast('Update-tjek fejlede.'); }
    };

    menu.style.display='block'; menu.style.visibility='hidden';
    positionMenu(menu); menu.style.visibility='visible';
    setTimeout(()=>{ document.addEventListener('mousedown', outsideClick, true); document.addEventListener('keydown', escClose, true); },0);
  }
  function closeMenu(){ if (!menu) return; menu.style.display='none'; document.removeEventListener('mousedown', outsideClick, true); document.removeEventListener('keydown', escClose, true); }
  function toggleMenu(){ if (!menu || menu.style.display !== 'block') openMenu(); else closeMenu(); }
  function outsideClick(e){
    if (!menu) return;
    if (e.target === menu || menu.contains(e.target) || e.target === gear) return;
    closeMenu();
  }
  function escClose(e){ if (e.key === 'Escape') closeMenu(); }

  gear.addEventListener('click', toggleMenu);
  window.addEventListener('resize', () => { ensureFullyVisible(d); positionGearNearPanel(); if (menu && menu.style.display==='block') positionMenu(menu); });
}

/* Test-knap */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showDOMToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  const m1 = '🧪 [TEST] Besked-kanal OK — ' + ts;
  const m2 = '🧪 [TEST] Interesse-kanal OK — ' + ts;
  sendPushover(m1); setTimeout(() => sendPushover(m2), 800);
  showDOMToast('Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
}

/*──────── 13) STARTUP + SCHEDULE ────────*/
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent || '')) {
    const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0,pendingCount:null,pendingTs:0});
    stMsg.lastPush = stMsg.lastSent = 0; stMsg.pendingCount=null; stMsg.pendingTs=0; saveJson(ST_MSG_KEY, stMsg);
  }
});

tryBecomeLeader();
setInterval(heartbeatIfLeader, HEARTBEAT_MS);
setInterval(tryBecomeLeader, HEARTBEAT_MS + 1200);

callerPopIfNeeded().catch(()=>{});
injectUI();
console.info('[TP] kører version', TP_VERSION);

function jitter(ms){ return ms + Math.floor(Math.random()*0.25*ms); }
function schedulePollers(){
  const leaderNow = isLeader();
  const role = leaderNow ? 'leader' : 'nonleader';
  const base = leaderNow ? POLL_MS_LEADER : POLL_MS_NONLEADER;

  // Beskeder: alle faner, så UI badges er friske
  pollMessages(role);
  // Interesse: kun leader laver HEAD/GET, andre tabs får toast via broadcastEvt
  if (leaderNow) pollInterestLeader();

  setTimeout(schedulePollers, jitter(base));
}
schedulePollers();

document.addEventListener('visibilitychange', () => {
  const leaderNow = isLeader();
  if (document.visibilityState === 'visible') {
    pollMessages(leaderNow ? 'leader' : 'nonleader');
    if (leaderNow) pollInterestLeader();
  }
});

/*──────── 14) HOVER “Intet Svar” (auto-gem uden popup) ────────*/
(function () {
  var auto = false, icon = null, menu = null, hideT = null;
  function mkMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, { position: 'fixed', zIndex: 2147483647, background: '#fff', border: '1px solid #ccc', borderRadius: '6px', boxShadow: '0 10px 28px rgba(0,0,0,.2)', fontSize: '12px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' });
    var btn = document.createElement('div');
    btn.textContent = 'Registrér “Intet Svar”';
    btn.style.cssText = 'padding:8px 12px;white-space:nowrap;cursor:default';
    btn.onmouseenter = function () { btn.style.background = '#f0f0f0'; };
    btn.onmouseleave = function () { btn.style.background = ''; };
    btn.onclick = function () { auto = true; if (icon) icon.click(); hide(); };
    menu.appendChild(btn); document.body.appendChild(menu); return menu;
  }
  function show(el) { icon = el; var r = el.getBoundingClientRect(); var m = mkMenu(); m.style.left = r.left + 'px'; m.style.top = r.bottom + 4 + 'px'; m.style.display = 'block'; }
  function hide() { clearTimeout(hideT); hideT = setTimeout(function () { if (menu) menu.style.display = 'none'; icon = null; }, 120); }
  function findIcon(n) { while (n && n !== document) { if (n.getAttribute && /Registrer opkald til vikar/i.test((n.getAttribute('title')||n.getAttribute('aria-label')||''))) return n; n = n.parentNode; } return null; }

  document.addEventListener('mouseover', function (e) { var ic = findIcon(e.target); if (ic) show(ic); }, true);
  document.addEventListener('mousemove', function (e) {
    if (!menu || menu.style.display !== 'block') return;
    var overM = menu.contains(e.target);
    var overI = icon && (icon === e.target || icon.contains(e.target) || e.target.contains(icon));
    if (!overM && !overI) hide();
  }, true);

  new MutationObserver(function (ml) {
    if (!auto) return;
    ml.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (!(n instanceof HTMLElement)) return;
        const hsWrap = n.closest && n.closest('.highslide-body, .highslide-container');
        if (hsWrap) { hsWrap.style.opacity = '0'; hsWrap.style.pointerEvents = 'none'; hsWrap.style.transform = 'scale(.98)'; }
        var ta = (n.matches && n.matches('textarea[name="phonetext"]')) ? n : (n.querySelector && n.querySelector('textarea[name="phonetext"]'));
        if (ta) {
          if (!ta.value.trim()) ta.value = 'Intet Svar';
          var frm = ta.closest('form');
          var saveBtn = frm && Array.prototype.find.call(frm.querySelectorAll('input[type="button"],button'), function (b) { return /Gem registrering/i.test((b.value || b.textContent || '').trim()); });
          if (saveBtn) {
            setTimeout(function () {
              try { saveBtn.click(); } catch (_) {}
              try { if ((unsafeWindow && unsafeWindow.hs && unsafeWindow.hs.close)) unsafeWindow.hs.close(); } catch (_) {}
              if (hsWrap) { setTimeout(()=>{ hsWrap.style.opacity = ''; hsWrap.style.pointerEvents = ''; hsWrap.style.transform=''; }, 120); }
            }, 30);
          }
          auto = false;
        }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
