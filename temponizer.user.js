// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      7.11.1
// @description  Push (leader + suppression + pending flush), OS/DOM toast (cross-tab, no dupes), “Intet Svar”-auto-gem, caller-pop via RAW CSV, Excel→CSV→Upload (robust, with warm-up) + clearer GitHub errors. SMS mini-toggle. Compact UI.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @noframes
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      ajourcare.temponizer.dk
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// ==/UserScript==

/*──────── 0) VERSION ────────*/
const TP_VERSION = '7.11.1';

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_MS     = 15000;
const SUPPRESS_MS = 45000;
const LOCK_MS     = SUPPRESS_MS + 5000;

// Cross-tab leader
const LEADER_KEY = 'tpLeaderV1';
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

// Script RAW for update-kontrol
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

/*──────── helpers ────────*/
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function primeCSVCache(){
  try{
    const txt = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now());
    if (txt && txt.length > 50) GM_setValue(CACHE_KEY_CSV, txt);
  }catch(_){}
}

/*──────── 2) TOASTS (OS + DOM) + cross-tab broadcast ────────*/
const TOAST_EVT_KEY = 'tpToastEventV1';
function broadcastToast(type, msg) {
  try {
    const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type, msg, ts: Date.now() };
    localStorage.setItem(TOAST_EVT_KEY, JSON.stringify(ev));
  } catch (_) {}
}
window.addEventListener('storage', e => {
  if (e.key !== TOAST_EVT_KEY || !e.newValue) return;
  try {
    const ev = JSON.parse(e.newValue);
    const seenKey = 'tpToastSeen_' + ev.id;
    if (localStorage.getItem(seenKey)) return;
    localStorage.setItem(seenKey, '1');
    if (!isLeader()) showDOMToast(ev.msg); // non-leader viser kun DOM
  } catch (_) {}
});

function showToastOnce(key, msg) {
  const lk = 'tpToastLock_' + key;
  const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
  if (Date.now() - o.t < LOCK_MS) return;
  localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
  broadcastToast(key, msg);
  showToast(msg);
}
function showToast(msg) {
  if (isLeader() && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      try { new Notification('Temponizer', { body: msg }); } catch (_) { showDOMToast(msg); }
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => {
        if (p === 'granted') try { new Notification('Temponizer', { body: msg }); } catch (_) { showDOMToast(msg); }
        else showDOMToast(msg);
      });
    } else { showDOMToast(msg); }
  } else { showDOMToast(msg); }
}
function showDOMToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '12px', right: '12px',
    background: '#333', color: '#fff', padding: '8px 10px',
    borderRadius: '8px', fontSize: '12px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    boxShadow: '0 6px 18px rgba(0,0,0,.35)', zIndex: 2147483646,
    opacity: 0, transition: 'opacity .22s, transform .22s', transform: 'translateY(8px)'
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = 1; el.style.transform = 'translateY(0)'; });
  setTimeout(() => { el.style.opacity = 0; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 280); }, 4200);
}

/*──────── 2b) STATUS-BANNER (caller-pop debug) ────────*/
function tpBanner(msg, ms = 3000) {
  try {
    let el = document.getElementById('tpCallerBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tpCallerBanner';
      Object.assign(el.style, {
        position: 'fixed', top: '8px', left: '8px',
        zIndex: 2147483647, background: '#212121', color: '#fff',
        padding: '6px 8px', borderRadius: '6px', font: '12px/1.3 system-ui, sans-serif',
        boxShadow: '0 2px 10px rgba(0,0,0,.35)', opacity: '0', transition: 'opacity .25s'
      });
      document.body.appendChild(el);
      requestAnimationFrame(() => el.style.opacity = '1');
    }
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => { if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); } }, ms);
  } catch(_) {}
}

/*──────── 3) PUSHOVER ────────*/
function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
function sendPushover(msg) {
  const userKey = getUserKey();
  if (!PUSHOVER_TOKEN || !userKey) return;
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) + '&user=' + encodeURIComponent(userKey) + '&message=' + encodeURIComponent(msg);
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
    onerror: () => {
      fetch('https://api.pushover.net/1/messages.json', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })
        .catch(()=>{});
    }
  });
}

/*──────── 4) STATE + LOCK ────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];
const ST_MSG_KEY = 'tpPushState';
const ST_INT_KEY = 'tpInterestState';

function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (_) { return JSON.parse(JSON.stringify(fallback)); } }
function saveJsonIfLeader(key, obj) { if (isLeader()) localStorage.setItem(key, JSON.stringify(obj)); }
function takeLock() {
  const l = JSON.parse(localStorage.getItem('tpPushLock') || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock', JSON.stringify({ t: Date.now() })); return true;
}

/* Pending flush (fix for “missed notifications”) */
function maybeFlushPending(kind, pushEnableKey, stateKey, buildMsg) {
  const st = loadJson(stateKey, {count:0,lastPush:0,lastSent:0,pending:0});
  if (st.pending && st.pending > (st.lastSent||0)) {
    if (Date.now() - st.lastPush > SUPPRESS_MS && takeLock()) {
      const text = (typeof buildMsg === 'function') ? buildMsg(st.pending) : buildMsg;
      const enabled = localStorage.getItem(pushEnableKey) === 'true';
      if (enabled) sendPushover(text);
      showToastOnce(kind, text);
      st.lastPush = Date.now();
      st.lastSent = st.pending;
      st.pending  = 0;
      saveJsonIfLeader(stateKey, st);
      return true;
    }
  }
  return false;
}

/*──────── 5) POLLERS: BESKED ────────*/
function pollMessagesLeader() {
  // Try flush any pending first
  maybeFlushPending('msg', 'tpPushEnableMsg', ST_MSG_KEY, (n) => `🔔 Du har nu ${n} ulæst(e) Temponizer-besked(er).`);

  fetch(MSG_URL + '&ts=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', headers: {'Cache-Control':'no-cache','Pragma':'no-cache'} })
    .then(r => r.json())
    .then(d => {
      const st = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
      const n  = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
      const en = localStorage.getItem('tpPushEnableMsg') === 'true';

      if (n > st.count && n !== st.lastSent) {
        const canPush = (Date.now() - st.lastPush > SUPPRESS_MS) && takeLock();
        if (canPush) {
          const m = '🔔 Du har nu ' + n + ' ulæst(e) Temponizer-besked(er).';
          if (en) sendPushover(m);
          showToastOnce('msg', m);
          st.lastPush = Date.now();
          st.lastSent = n;
        } else {
          st.pending = Math.max(st.pending||0, n); // queue til senere flush
        }
      } else if (n < st.count) {
        st.lastPush = 0;
        if (st.pending && n <= st.pending) st.pending = 0; // reset pending hvis tæller falder
      }

      st.count = n; saveJsonIfLeader(ST_MSG_KEY, st);

      const badge = document.getElementById('tpMsgCountBadge'); setBadge(badge, n);
      const prevBadge = Number(localStorage.getItem('tpMsgPrevBadge')||0);
      if (n > prevBadge) badgePulse(badge);
      localStorage.setItem('tpMsgPrevBadge', String(n));

      console.info('[TP-besked][leader]', n, new Date().toLocaleTimeString());
    })
    .catch(e => console.warn('[TP][ERR][MSG]', e));
}

/*──────── 6) INTERESSE (HEAD→GET + navne) ────────*/
const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETagSeen = localStorage.getItem('tpLastETag') || null;

let lastIntParseTS = 0;
function markParsedNow(){ lastIntParseTS = Date.now(); }
function mustForceParse(){ return (Date.now() - lastIntParseTS) > (POLL_MS * 2); }

function parseInterestHTML(html) {
  const doc   = new DOMParser().parseFromString(html, 'text/html');
  let boxes = Array.prototype.slice.call(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  if (!boxes.length) boxes = Array.prototype.slice.call(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
  const c = boxes.reduce((s, el) => { const v = parseInt((el.textContent||'').replace(/\D+/g,''), 10); return s + (isNaN(v) ? 0 : v); }, 0);
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

/* Interesse-navne */
const INT_NAMES_CACHE_TTL_MS = 120000;
const INT_NAMES_MAX_VAGTER   = 3;
const INT_NAMES_MAX_NAMES    = 2;
let gIntPerPrev = {};
const gIntNamesCache = new Map();
let INT_NAME_HINT = '';

function fetchInterestPopupHTML(vagtAvailId) {
  const url = `${location.origin}/index.php?page=update_vikar_synlighed_from_list&ajax=true&vagt_type=single&vagt_avail_id=${encodeURIComponent(vagtAvailId)}&t=${Date.now()}`;
  return gmGET(url);
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
  return hint
    ? `👀 ${hint} har vist interesse for ledige vagter.`
    : `👀 ${count} vikar(er) har vist interesse for ledige vagter.`;
}

function pollInterestLeader() {
  // Try flush any pending first
  maybeFlushPending('int', 'tpPushEnableInt', ST_INT_KEY, buildInterestMsg);

  const force = mustForceParse();
  fetch(HTML_URL, {
    method: 'HEAD',
    credentials: 'same-origin',
    cache: 'no-store',
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

        // hent navne for et lille udsnit af stigende vagter
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
            } catch(_){}
          }
          const merged = Array.from(new Set(nameSets.flat()));
          const summary = summarizeNames(merged);
          if (summary) namesHint = summary;
        }
        if (namesHint) INT_NAME_HINT = namesHint;

        // handle count with pending
        const st = loadJson(ST_INT_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
        if (total > st.count && total !== st.lastSent) {
          const canPush = (Date.now() - st.lastPush > SUPPRESS_MS) && takeLock();
          if (canPush) {
            const text = buildInterestMsg(total);
            const en = localStorage.getItem('tpPushEnableInt') === 'true';
            if (en) sendPushover(text);
            showToastOnce('int', text);
            st.lastPush = Date.now(); st.lastSent = total;
          } else {
            st.pending = Math.max(st.pending||0, total);
          }
        } else if (total < st.count) {
          st.lastPush = 0;
          if (st.pending && total <= st.pending) st.pending = 0;
        }
        st.count = total; saveJsonIfLeader(ST_INT_KEY, st);

        const badgeI = document.getElementById('tpIntCountBadge'); setBadge(badgeI, total);
        const prevBadge = Number(localStorage.getItem('tpIntPrevBadge')||0);
        if (total > prevBadge) badgePulse(badgeI);
        localStorage.setItem('tpIntPrevBadge', String(total));

        console.info('[TP-interesse][leader]', total, rising.length ? `rising=${rising.join(',')}` : '', new Date().toLocaleTimeString());
      });
    } else {
      console.info('[TP-interesse][leader] 304', new Date().toLocaleTimeString());
    }
  })
  .catch(e => console.warn('[TP][ERR][INT][leader][HEAD]', e));
}

/*──────── 7) LEADER-ELECTION ────────*/
function now() { return Date.now(); }
function getLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (_) { return null; } }
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); }
function isLeader() { const L = getLeader(); return !!(L && L.id === TAB_ID && L.until > now()); }
function tryBecomeLeader() { const L = getLeader(), t = now(); if (!L || (L.until || 0) <= t) { setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); if (isLeader()) console.info('[TP][LEADER] Denne fane er nu leader:', TAB_ID);} }
function heartbeatIfLeader() { if (!isLeader()) return; const t = now(); setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); }
window.addEventListener('storage', e => { if (e.key === LEADER_KEY) {/*no-op*/} });

/*──────── 8) HTTP helpers ────────*/
function gmGET(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: { 'Accept': '*/*', 'Referer': location.href, 'Cache-Control':'no-cache','Pragma':'no-cache' },
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}

// NEW (CSV-only scope): CSRF + fælles AJAX-headers til Temponizer POST/Excel
function getCsrfToken() {
  const m = document.querySelector('meta[name="csrf-token"]');
  if (m && m.content) return m.content.trim();
  const i = document.querySelector('input[name="csrf-token"], input[name="csrf_token"], input[name="token"]');
  if (i && i.value) return i.value.trim();
  return '';
}
function commonAjaxHeaders() {
  const h = { 'X-Requested-With': 'XMLHttpRequest', 'Referer': location.href };
  const t = getCsrfToken(); if (t) h['x-csrf-token'] = t;
  return h;
}
function gmPOST(url, body) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: { ...commonAjaxHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}

function gmGETArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: {
        ...commonAjaxHeaders(),
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8',
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
        ...commonAjaxHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8',
        'Cache-Control':'no-cache','Pragma':'no-cache'
      },
      data: body,
      onload: r => (r.status===200 || r.status===201 || r.status===204) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}

/*──────── 9) CALLER-POP (RAW CSV) ────────*/
function normPhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
}
function parseCSV(text) {
  if (!text) return [];
  text = text.replace(/^\uFEFF/, '');
  const first = (text.split(/\r?\n/)[0] || '');
  const delim = (first.indexOf(';') > first.indexOf(',')) ? ';' : (first.includes(';') ? ';' : ',');
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
async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const rawParam = q.get('tp_caller');
    if (!rawParam) return;

    const dirParam = (q.get('tp_dir') || '').toLowerCase();
    const rawStr = String(rawParam).trim();

    const isInbound = /\*1500\s*$/.test(rawStr) || dirParam === 'in';
    if (!isInbound) { console.info('[TP][CALLER] Outbound/unknown, ignoring.', { raw: rawStr, dir: dirParam }); return; }

    const digitsRaw = rawStr.replace(/\*1500\s*$/,'').replace(/[^\d+]/g, '');
    const phone8 = normPhone(digitsRaw);
    console.info('[TP][CALLER] Inbound', { raw: rawStr, dir: dirParam, digitsRaw, phone8 });
    tpBanner('Indgående kald: ' + (phone8 || '—') + ' — slår op …', 1600);

    if (!phone8) { tpBanner('Ukendt nummerformat: ' + rawStr, 4000); return; }

    let csvText = '';
    try {
      csvText = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now());
      if (csvText) GM_setValue(CACHE_KEY_CSV, csvText);
    } catch(_) {}
    if (!csvText) csvText = GM_getValue(CACHE_KEY_CSV) || '';
    if (!csvText) { tpBanner('Ingen telefonbog tilgængelig (RAW og cache tom).', 4000); return; }

    const { map } = parsePhonebookCSV(csvText);
    const rec = map.get(phone8);
    if (!rec) { tpBanner('Ingen match i CSV: ' + phone8, 3000); return; }

    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    tpBanner(`Match: ${rec.name || '(uden navn)'} (#${rec.id}) — åbner …`, 1200);

    if (OPEN_NEW_TAB_ON_INBOUND) window.open(url, '_blank', 'noopener');
    else location.assign(url);
  } catch (e) {
    console.warn('[TP][CALLER] error', e);
    tpBanner('Fejl under opslag — se konsol.', 3500);
  }
}

/*──────── 10) GITHUB API (upload) ────────*/
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin);
}
function getGitPAT(){ return (GM_getValue('tpGitPAT') || '').trim(); }

function ghGetSha(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const token = getGitPAT();
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: {
        'Accept': 'application/vnd.github+json',
        ...(token ? {'Authorization': 'Bearer ' + token} : {}),
        'X-GitHub-Api-Version': '2022-11-28'
      },
      onload: r => {
        if (r.status === 200) {
          try { const js = JSON.parse(r.responseText); resolve({ sha: js.sha, exists: true }); }
          catch(_) { resolve({ sha:null, exists:true }); }
        } else if (r.status === 404) resolve({ sha:null, exists:false });
        else reject(new Error('GitHub GET sha: HTTP '+r.status+' :: '+String(r.responseText||'').slice(0,160)));
      },
      onerror: e => reject(e)
    });
  });
}
function ghPutFile(owner, repo, path, base64Content, message, sha, branch) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const token = getGitPAT();
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'PUT', url,
      headers: {
        'Accept': 'application/vnd.github+json',
        ...(token ? {'Authorization': 'Bearer ' + token} : {}),
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json;charset=UTF-8'
      },
      data: JSON.stringify({ message, content: base64Content, branch, ...(sha ? { sha } : {}) }),
      onload: r => {
        if (r.status===200 || r.status===201) resolve(r.responseText);
        else reject(new Error('GitHub PUT: HTTP '+r.status+' :: '+String(r.responseText||'').slice(0,260)));
      },
      onerror: e => reject(e)
    });
  });
}

/*──────── 11) EXCEL → CSV (auto) + warm-up ────────*/
async function warmupExcelEndpoints(){
  try { await gmGET(location.origin + '/index.php?page=showmy_settings&t=' + Date.now()); } catch(_){}
  try { await gmGET(location.origin + '/index.php?page=print_vikar_list_custom_excel&t=' + Date.now()); } catch(_){}
  await sleep(300);
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
    console.info('[TP][PB] Sheet:', name, 'rows:', dataRows);
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

// NEW (CSV-only scope): rigtig warm-up der “varmer” printlisten på serveren
function fmtTodayDK() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}
async function warmUpVikarListSession() {
  const today = encodeURIComponent(fmtTodayDK());
  const body =
    'page=vikarlist_get' +
    '&ajax=true' +
    '&showheader=true' +
    '&printlist=true' +
    '&fieldset_filtre=closed' +
    '&fieldset_aktivitet=closed' +
    '&kunder_id=0' +
    '&kunde_afdeling_id=' +
    '&arbejdssteder_id=' +
    '&searchFromUrl=false' +
    '&query=' +
    '&query_vikar_nr=' +
    '&postnummer_fra=' +
    '&postnummer_til=' +
    '&fetchIds=' +
    '&days_to_birthday=2' +
    '&vagtonskeridag_dato=i+dag' +
    '&vagtoenskeridag_starttidspunkt=' +
    '&vagtoenskeridag_sluttidspunkt=' +
    '&vagtoenskeridag_dag=true' +
    '&vagtoenskeridag_aften=true' +
    '&vagtoenskeridag_nat=true' +
    '&vagtoenskeridag_heledag=true' +
    '&ansaettelsesdato_datofra=' +
    '&ansaettelsesdato_datotil=' +
    '&ingenvagterfra=' +
    '&ingenvagtertil=' +
    '&medvagterfra=' +
    '&medvagtertil=' +
    '&medgodkendtevagterfra=' +
    '&medgodkendtevagtertil=' +
    '&afholdte_dato=' + today +
    '&ingenvagtoenskerfra=' +
    '&ingenvagtoenskertil=' +
    '&sex=both' +
    '&kontor_id=-1' +
    '&udbetalingsmetode=-1' +
    '&loenkorsel_id=0' +
    '&kunde_radius_search=0' +
    '&vikar_rolle=0' +
    '&booking_grupper_id=-1' +
    '&kunder_sel_width=400' +
    '&kunder_sel_id=0' +
    '&kunder_select_search=' +
    '&kunder_id_0=0' +
    '&vagterfra=' +
    '&vagtertil=' +
    '&list_uddannelse_id_all=true' +
    '&uddannelse_gyldig=' + today +
    '&kompetencegyldig=' + today;

  await gmPOST(`${location.origin}/index.php`, body);
}

async function fetchExcelAsCSVText() {
  // RIGTIG warm-up (POST) før Excel-eksport
  try { await warmUpVikarListSession(); } catch (e) { console.warn('[TP][PB] warmUp (POST) fejlede — fortsætter:', e); }

  // Behold eksisterende “blid” warm-up og GET-forsøg
  await warmupExcelEndpoints();
  const tries = [
    { fn: tryExcelGET,  params: 'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag' },
    { fn: tryExcelGET,  params: 'id=true&name=true&phone=true&cellphone=true' },
  ];
  for (const t of tries) {
    try {
      const ab = await t.fn(t.params);
      if (!ab || ab.byteLength < 128) continue;
      const wb = XLSX.read(ab, { type: 'array' });
      if (!wb.SheetNames || wb.SheetNames.length === 0) continue;
      const csv = pickBestSheetCSV(wb);
      if (csv) return csv;
    } catch (_) {}
  }

  // Gentag blid warm-up og prøv POST-forsøg
  await warmupExcelEndpoints();
  const postTries = [
    { fn: tryExcelPOST, params: 'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag' },
    { fn: tryExcelPOST, params: 'id=true&name=true&phone=true&cellphone=true' },
  ];
  for (const t of postTries) {
    try {
      const ab = await t.fn(t.params);
      if (!ab || ab.byteLength < 128) continue;
      const wb = XLSX.read(ab, { type: 'array' });
      if (!wb.SheetNames || wb.SheetNames.length === 0) continue;
      const csv = pickBestSheetCSV(wb);
      if (csv) return csv;
    } catch (_) {}
  }
  console.warn('[TP][PB] Excel→CSV mislykkedes.');
  return null;
}
async function fetchExcelAsCSVAndUpload() {
  // guard: PAT must exist
  const pat = getGitPAT();
  if (!pat) { showToast('Indsæt GitHub PAT i ⚙️ først.'); throw new Error('Missing GitHub PAT'); }

  const text = await fetchExcelAsCSVText();
  if (!text) { showToastOnce('csv', 'Temponizer gav ingen rækker – beholdt eksisterende CSV.'); return; }
  const lines = (text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) { showToastOnce('csv', 'CSV havde kun header – beholdt eksisterende CSV.'); return; }
  const base64 = b64encodeUtf8(text);
  const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
  await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: Excel→CSV via TM (auto)', sha, PB_BRANCH);
  GM_setValue(CACHE_KEY_CSV, text);
  try { await primeCSVCache(); } catch(_){}
  showToastOnce('csvok', 'CSV uploadet (Excel→CSV).');
}

/*──────── 12) UI (panel + gear + SMS) ────────*/
const POS_KEY = 'tpPanelPosV3';
function injectUI() {
  if (document.getElementById('tpPanel')) return;

  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = [
    'position:fixed','z-index:2147483645','background:#fff','border:1px solid #d7d7d7',
    'padding:8px','border-radius:8px','font-size:12px','font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.15)','max-width:240px','min-width:170px','line-height:1.25'
  ].join(';');

  d.innerHTML =
    '<div id="tpHeader" style="cursor:move; display:flex; align-items:center; gap:6px; margin-bottom:4px;">' +
      '<div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
      '<div id="tpDragHint" style="margin-left:auto; font-size:10px; color:#888">træk</div>' +
    '</div>' +

    '<div style="display:flex; align-items:center; gap:6px; margin:2px 0 2px 0; white-space:nowrap;">' +
      '<label style="display:flex; align-items:center; gap:6px; min-width:0;"><input type="checkbox" id="tpEnableMsg"> <span>Besked</span></label>' +
      '<span id="tpMsgCountBadge" style="margin-left:auto;min-width:18px;text-align:center;background:#eef;border:1px solid #cbd; padding:0 6px;border-radius:999px;font-weight:600">0</span>' +
    '</div>' +
    '<div style="display:flex; align-items:center; gap:6px; margin:2px 0 6px 0; white-space:nowrap;">' +
      '<label style="display:flex; align-items:center; gap:6px; min-width:0;"><input type="checkbox" id="tpEnableInt"> <span>Interesse</span></label>' +
      '<span id="tpIntCountBadge" style="margin-left:auto;min-width:18px;text-align:center;background:#efe;border:1px solid #cbd; padding:0 6px;border-radius:999px;font-weight:600">0</span>' +
    '</div>' +

    '<div id="tpSMS" style="border-top:1px solid #eee;padding-top:6px;display:flex;flex-direction:column;gap:6px;align-items:stretch;">' +
      '<div id="tpSMSStatus" style="font-size:12px; color:#666;">Indlæser SMS-status…</div>' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
        '<button id="tpSMSOneBtn" style="padding:5px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;flex:0 0 auto">Aktivér</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(d);

  // Gear
  if (!document.getElementById('tpGear')) {
    const gear = document.createElement('div');
    gear.id = 'tpGear'; gear.title = 'Indstillinger'; gear.innerHTML = '⚙️';
    Object.assign(gear.style, {
      position:'fixed',
      width:'22px', height:'22px', lineHeight:'22px', textAlign:'center',
      background:'#fff', border:'1px solid #ccc', borderRadius:'50%',
      boxShadow:'0 4px 12px rgba(0,0,0,.18)', cursor:'pointer',
      zIndex:2147483647, userSelect:'none'
    });
    document.body.appendChild(gear);

    // Gear-menu
    let menu = null;
    function buildMenu() {
      if (menu) return menu;
      menu = document.createElement('div');
      Object.assign(menu.style, {
        position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
        borderRadius:'10px', boxShadow:'0 12px 36px rgba(0,0,0,.22)', fontSize:'12px',
        fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding:'12px', width:'380px', maxHeight:'70vh', overflow:'auto', display:'none'
      });
      menu.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>' +

        '<div style="margin-bottom:10px">' +
          '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
          '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
          '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            '<button id="tpSaveUserKeyMenu" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Gem</button>' +
            '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Guide</a>' +
          '</div>' +
        '</div>' +

        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<div style="font-weight:700;margin-bottom:6px">Telefonbog</div>' +
        '<div style="margin-bottom:6px;font-size:12px;color:#444">CSV i GitHub bruges af caller-pop og navne i interesse.</div>' +
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
        '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>' +

        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🔄 Søg efter opdatering</button>' +
        '<div style="margin-top:6px;font-size:11px;color:#666">Kører v.'+TP_VERSION+'</div>';
      document.body.appendChild(menu);

      // Wire menu
      const inp  = menu.querySelector('#tpUserKeyMenu');
      const save = menu.querySelector('#tpSaveUserKeyMenu');
      const pat   = menu.querySelector('#tpGitPAT');
      const file  = menu.querySelector('#tpCSVFile');
      const up    = menu.querySelector('#tpUploadCSV');
      const csvUp = menu.querySelector('#tpFetchCSVUpload');
      const tIn   = menu.querySelector('#tpTestPhone');
      const tBtn  = menu.querySelector('#tpLookupPhone');
      const pbh   = menu.querySelector('#tpPBHint');
      const test  = menu.querySelector('#tpTestPushoverBtn');
      const chk   = menu.querySelector('#tpCheckUpdate');

      inp.value = getUserKey();
      save.addEventListener('click', () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showToast('USER-token gemt.'); });
      inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); GM_setValue('tpUserKey',(inp.value||'').trim()); showToast('USER-token gemt.'); }});

      pat.value = (GM_getValue('tpGitPAT') || '');
      // persist PAT on input (no need to blur)
      pat.addEventListener('input', () => GM_setValue('tpGitPAT', pat.value || ''));

      // Upload selected local CSV → GitHub
      up.addEventListener('click', async () => {
        try {
          // ensure PAT is persisted now
          GM_setValue('tpGitPAT', (pat.value||'').trim());
          if (!getGitPAT()) { showToast('Indsæt GitHub PAT i ⚙️ først.'); return; }
          if (!file.files || !file.files[0]) { showToast('Vælg en CSV-fil først.'); return; }
          const text = await file.files[0].text();
          const base64 = b64encodeUtf8(text);
          pbh.textContent = 'Uploader CSV…';
          const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
          await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: upload CSV via TM', sha, PB_BRANCH);
          GM_setValue(CACHE_KEY_CSV, text);
          pbh.textContent = 'CSV uploadet. RAW opdateres om få sek.'; showToast('CSV uploadet.');
        } catch (e) {
          console.warn('[TP][PB][CSV-UPLOAD]', e);
          pbh.textContent = 'Fejl ved CSV upload (se konsol).';
          showToast('GitHub-fejl: ' + (e && e.message ? e.message : 'ukendt'));
        }
      });

      // Auto: Excel → CSV → Upload
      csvUp.addEventListener('click', async () => {
        try {
          // ensure PAT is persisted now
          GM_setValue('tpGitPAT', (pat.value||'').trim());
          pbh.textContent = 'Henter Excel, konverterer og uploader CSV …';
          const t0 = Date.now();
          await fetchExcelAsCSVAndUpload();
          const ms = Date.now()-t0;
          pbh.textContent = `Færdig på ${ms} ms.`;
        } catch (e) {
          console.warn('[TP][PB][EXCEL→CSV-UPLOAD]', e);
          pbh.textContent = 'Fejl ved Excel→CSV upload (se konsol).';
          showToast('GitHub/Excel-fejl: ' + (e && e.message ? e.message : 'ukendt'));
        }
      });

      // TEST lookup (RAW CSV)
      tBtn.addEventListener('click', async () => {
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
      });

      test.addEventListener('click', () => { tpTestPushoverBoth(); toggleMenu(false); });

      chk.addEventListener('click', async () => {
        try {
          const raw = await gmGET(SCRIPT_RAW_URL+'?t='+Date.now());
          const m = raw.match(/@version\s+([0-9.]+)/);
          if (!m) { showToast('Kunne ikke læse remote version.'); return; }
          const remote = m[1];
          if (remote === TP_VERSION) showToast('Du kører allerede nyeste version ('+remote+').');
          else { showToast('Ny version tilgængelig: '+remote+' (du kører '+TP_VERSION+'). Åbner opdatering…'); window.open(SCRIPT_RAW_URL, '_blank'); }
        } catch(_) { showToast('Update-tjek fejlede.'); }
      });

      return menu;
    }

    function positionMenu(menu) {
      const pr = d.getBoundingClientRect();
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      let left = Math.max(8, Math.min(window.innerWidth - mw - 8, pr.right - mw));
      let top  = Math.max(8, Math.min(window.innerHeight - mh - 8, pr.top - mh - 10 < 8 ? pr.bottom + 8 : pr.top - mh - 10));
      Object.assign(menu.style, { left:left+'px', top:top+'px', right:'auto', bottom:'auto', position:'fixed' });
    }

    function toggleMenu(show) {
      const mnu = buildMenu();
      if (show === false) { mnu.style.display = 'none'; return; }
      mnu.style.display = (mnu.style.display === 'block' ? 'none' : 'block');
      if (mnu.style.display === 'block') {
        mnu.style.visibility = 'hidden';
        positionMenu(mnu); mnu.style.visibility = 'visible';
        const inp  = mnu.querySelector('#tpUserKeyMenu');
        const pat  = mnu.querySelector('#tpGitPAT');
        inp.value = getUserKey();
        pat.value = (GM_getValue('tpGitPAT') || '');
      }
    }
    gear.addEventListener('click', () => toggleMenu());

    function positionGearNearPanel(){
      const r = d.getBoundingClientRect();
      gear.style.left = (r.right - 11) + 'px';
      gear.style.top  = (r.top   - 11) + 'px';
    }
    window.addEventListener('resize', positionGearNearPanel);
    positionGearNearPanel();
  }

  // toggles
  const msg = d.querySelector('#tpEnableMsg');
  const intr = d.querySelector('#tpEnableInt');
  msg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  intr.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  msg.onchange = () => localStorage.setItem('tpPushEnableMsg', msg.checked ? 'true' : 'false');
  intr.onchange = () => localStorage.setItem('tpPushEnableInt', intr.checked ? 'true' : 'false');

  // drag
  makeDraggable(d, POS_KEY, '#tpHeader');

  // **Always start bottom-right (still draggable)**
  d.style.bottom = '12px';
  d.style.right  = '8px';
  d.style.top    = 'auto';
  d.style.left   = 'auto';

  // SMS UI
  initSMSControls(d);

  // initial badges
  setBadge(document.getElementById('tpMsgCountBadge'), Number(loadJson(ST_MSG_KEY,{count:0}).count||0));
  setBadge(document.getElementById('tpIntCountBadge'), Number(loadJson(ST_INT_KEY,{count:0}).count||0));
}

/* Drag + placering helpers */
function makeDraggable(el, storageKey, handleSelector) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  handle.style.cursor = 'move'; handle.style.userSelect = 'none';

  let drag = null;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const x = Math.min(window.innerWidth - el.offsetWidth - 8, Math.max(8, e.clientX - drag.dx));
    const y = Math.min(window.innerHeight - el.offsetHeight - 8, Math.max(8, e.clientY - drag.dy));
    el.style.position='fixed';
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.right='auto'; el.style.bottom='auto';
    savePos(x, y);
    positionGearNearPanel();
  });
  document.addEventListener('mouseup', () => drag = null);
  window.addEventListener('resize', clampPanelIntoView);
}
function savePos(x, y){ localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); }
function clampPanelIntoView(){
  const d = document.getElementById('tpPanel'); if (!d) return;
  const r = d.getBoundingClientRect();
  let x = r.left, y = r.top;
  const maxX = window.innerWidth - d.offsetWidth - 8;
  const maxY = window.innerHeight - d.offsetHeight - 8;
  if (x > maxX) x = maxX;
  if (y > maxY) y = maxY;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  d.style.left = x + 'px'; d.style.top = y + 'px';
  d.style.right='auto'; d.style.bottom='auto';
  savePos(x, y);
  positionGearNearPanel();
}
function positionGearNearPanel(){
  const d = document.getElementById('tpPanel'); const gear = document.getElementById('tpGear');
  if (!d || !gear) return;
  const r = d.getBoundingClientRect();
  gear.style.left = (r.right - 11) + 'px';
  gear.style.top  = (r.top   - 11) + 'px';
}
function ensureFullyVisible(el, margin = 8) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top;
  const w = r.width, h = r.height;
  if (left < margin) left = margin;
  if (top  < margin) top  = margin;
  if (left + w > window.innerWidth  - margin) left = Math.max(margin, window.innerWidth  - margin - w);
  if (top  + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - h);
  el.style.position = 'fixed';
  el.style.left = left + 'px';
  el.style.top  = top  + 'px';
  el.style.right  = 'auto';
  el.style.bottom = 'auto';
}

/* Badges */
function setBadge(el, n) { if (el) el.textContent = String(Number(n||0)); }
function badgePulse(el){
  if (!el) return;
  el.animate([{ transform:'scale(1)', offset:0 }, { transform:'scale(1.12)', offset:.35 }, { transform:'scale(1)', offset:1 }], { duration:320, easing:'ease-out' });
}

/*──────── 13) SMS (status + én knap toggle via iframe) ────────*/
const SMS_SETTINGS_URL = `${location.origin}/index.php?page=showmy_settings`;
function hasDisplayBlock(el) {
  if (!el) return false;
  const s = (el.getAttribute('style') || '').replace(/\s+/g,'').toLowerCase();
  if (s.includes('display:none'))  return false;
  if (s.includes('display:block')) return true;
  return false;
}
function parseSmsStatusFromDoc(doc) {
  const elAktiv   = doc.getElementById('sms_notifikation_aktiv');
  const elInaktiv = doc.getElementById('sms_notifikation_ikke_aktiv');
  const aktivShown   = hasDisplayBlock(elAktiv);
  const inaktivShown = hasDisplayBlock(elInaktiv);
  const hasDeactivateLink = !!(doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_aktiv a[href*="deactivate_cell_sms_notifikationer"]'));
  const hasActivateLink   = !!(doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_ikke_aktiv a[href*="activate_cell_sms_notifikationer"]'));
  let state = 'unknown', phone = '';
  if (aktivShown || (!inaktivShown && hasDeactivateLink && !hasActivateLink)) state = 'active';
  else if (inaktivShown || (!aktivShown && hasActivateLink && !hasDeactivateLink)) state = 'inactive';
  const refTxt = state === 'active' ? (elAktiv?.textContent || '') : (elInaktiv?.textContent || '');
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
      const a=ev.target.closest&&ev.target.closest('a');
      if(!a) return;
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
  if (!invoked) throw new Error('Kan ikke udløse aktivering/deaktivering i iframe.');
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
  _busy: false,
  _last: null,
  async refresh(cb) { const st = await getSmsStatus(); this._last = st; cb && cb(st); },
  async setEnabled(wantOn, uiBusy, cb) {
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
function initSMSControls(root){
  const row   = root.querySelector('#tpSMS');
  const lbl   = root.querySelector('#tpSMSStatus');
  const btn   = root.querySelector('#tpSMSOneBtn');
  function setBusy(on, text){ btn.disabled = on; btn.style.opacity = on ? .6 : 1; if (on && text) lbl.textContent = text; }
  function paint(st){
    switch (st.state) {
      case 'active':   btn.textContent = 'Deaktiver'; lbl.textContent = 'SMS: Aktiv'   + (st.phone ? ' — ' + st.phone : ''); lbl.style.color='#0a7a35'; break;
      case 'inactive': btn.textContent = 'Aktivér';   lbl.textContent = 'SMS: Ikke aktiv' + (st.phone ? ' — ' + st.phone : ''); lbl.style.color='#a33'; break;
      default:         btn.textContent = 'Aktivér';   lbl.textContent = 'SMS: Ukendt'; lbl.style.color='#666';
    }
  }
  btn.addEventListener('click', async () => {
    const wantOn = (sms._last?.state !== 'active');
    setBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
    await sms.setEnabled(wantOn, setBusy, paint);
  });
  (async()=>{ setBusy(true,'indlæser…'); await sms.refresh(paint); setBusy(false); })();
}

/* Test-knap (Pushover) */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  sendPushover('🧪 [TEST] Besked-kanal OK — ' + ts);
  setTimeout(() => sendPushover('🧪 [TEST] Interesse-kanal OK — ' + ts), 800);
  showToast('Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
}

/*──────── 14) STARTUP ────────*/
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent || '')) {
    const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
    stMsg.lastPush = stMsg.lastSent = 0; stMsg.pending = 0; saveJsonIfLeader(ST_MSG_KEY, stMsg);
  }
});
tryBecomeLeader();
setInterval(heartbeatIfLeader, HEARTBEAT_MS);
setInterval(tryBecomeLeader, HEARTBEAT_MS + 1200);

callerPopIfNeeded().catch(()=>{});
injectUI();
try { primeCSVCache(); } catch(_){}

function leaderLoop(){
  if (!isLeader()) return;
  pollMessagesLeader();
  pollInterestLeader();
}
leaderLoop();
setInterval(() => { if (isLeader()) pollMessagesLeader(); }, POLL_MS);
setInterval(() => { if (isLeader()) pollInterestLeader(); }, POLL_MS);

console.info('[TP] kører version', TP_VERSION);

/*──────── 15) HOVER “Intet Svar” (auto-gem uden popup) ────────*/
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
  function findIcon(n) { while (n && n !== document) { if (n.getAttribute && /Registrer opkald til vikar/i.test((n.getAttribute('title') || n.getAttribute('aria-label') || ''))) return n; n = n.parentNode; } return null; }

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
