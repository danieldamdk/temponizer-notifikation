// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      6.65
// @description  Push (leader), hover “Intet Svar”, ETag-optimering. Telefonbog: Excel→CSV + GitHub-synk + JSON-map fallback (>1MB). Caller-pop læser CSV/JSON fra repo. Robust Excel-download og beskyttelse mod tom upload. ⚙️ har test + cache-rydning.
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
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// ==/UserScript==

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_MS     = 30000;
const SUPPRESS_MS = 45000;
const LOCK_MS     = SUPPRESS_MS + 5000;

// Cross-tab leader
const LEADER_KEY = 'tpLeaderV1';
const HEARTBEAT_MS = 5000;
const LEASE_MS     = 15000;
const TAB_ID = (crypto && crypto.randomUUID ? crypto.randomUUID() : ('tab-' + Math.random().toString(36).slice(2) + Date.now()));

// Telefonbog (GitHub)
const PB_OWNER  = 'danieldamdk';
const PB_REPO   = 'temponizer-notifikation';
const PB_BRANCH = 'main';
const PB_CSV    = 'vikarer.csv';
const PB_XLSX   = 'vikarer.xlsx';
const PB_MAP    = 'vikarer.map.json';

const RAW_PHONEBOOK     = `https://raw.githubusercontent.com/${PB_OWNER}/${PB_REPO}/${PB_BRANCH}/${PB_CSV}`;
const RAW_PHONEBOOK_MAP = `https://raw.githubusercontent.com/${PB_OWNER}/${PB_REPO}/${PB_BRANCH}/${PB_MAP}`;

const CSV_CACHE_KEY = 'tpCsvCacheV1'; // { text, etag, ts, len }
const MAP_CACHE_KEY = 'tpMapCacheV1'; // { text, etag, ts, len }
const RAW_MAX_BYTES = 1_000_000;      // vælg JSON-map over CSV hvis CSV > 1MB

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

/*──────── 2) TOAST ────────*/
function showToastOnce(key, msg) {
  const lk = 'tpToastLock_' + key;
  const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
  if (Date.now() - o.t < LOCK_MS) return;
  localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
  showToast(msg);
}
function showToast(msg) {
  if (Notification.permission === 'granted') {
    try { new Notification('Temponizer', { body: msg }); } catch (_) { showDOMToast(msg); }
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { p === 'granted' ? new Notification('Temponizer', { body: msg }) : showDOMToast(msg); });
  } else showDOMToast(msg);
}
function showDOMToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '16px', right: '16px',
    background: '#333', color: '#fff', padding: '10px 14px',
    borderRadius: '6px', fontSize: '13px', fontFamily: 'sans-serif',
    boxShadow: '1px 1px 8px rgba(0,0,0,.4)', zIndex: 2147483646,
    opacity: 0, transition: 'opacity .4s'
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = 1; });
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => { el.remove(); }, 450); }, 4000);
}

/*──────── 3) PUSHOVER ────────*/
function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
function sendPushover(msg) {
  const userKey = getUserKey();
  if (!PUSHOVER_TOKEN || !userKey) { showToast('Pushover ikke konfigureret – indsæt USER-token i ⚙️.'); return; }
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) + '&user=' + encodeURIComponent(userKey) + '&message=' + encodeURIComponent(msg);
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
    onerror: () => {
      fetch('https://api.pushover.net/1/messages.json', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })
        .catch(console.warn);
    }
  });
}

/*──────── 4) STATE + LOCK ────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];
const ST_MSG_KEY = 'tpPushState';        // {count,lastPush,lastSent}
const ST_INT_KEY = 'tpInterestState';    // {count,lastPush,lastSent}
function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (_) { return JSON.parse(JSON.stringify(fallback)); } }
function saveJsonIfLeader(key, obj) { if (isLeader()) localStorage.setItem(key, JSON.stringify(obj)); }
function takeLock() {
  const l = JSON.parse(localStorage.getItem('tpPushLock') || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock', JSON.stringify({ t: Date.now() })); return true;
}

/*──────── 5) POLLERS ────────*/
function pollMessages() {
  if (!isLeader()) return;
  fetch(MSG_URL + '&ts=' + Date.now(), { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0});
      const n  = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
      const en = localStorage.getItem('tpPushEnableMsg') === 'true';
      if (n > stMsg.count && n !== stMsg.lastSent) {
        const canPush = (Date.now() - stMsg.lastPush > SUPPRESS_MS) && takeLock();
        if (canPush) {
          const m = '🔔 Du har nu ' + n + ' ulæst(e) Temponizer-besked(er).';
          if (en) sendPushover(m); showToastOnce('msg', m);
          stMsg.lastPush = Date.now(); stMsg.lastSent = n;
        } else stMsg.lastSent = n;
      } else if (n < stMsg.count) { stMsg.lastPush = 0; }
      stMsg.count = n; saveJsonIfLeader(ST_MSG_KEY, stMsg);
      console.info('[TP-besked]', n, new Date().toLocaleTimeString());
    })
    .catch(e => console.warn('[TP][ERR][MSG]', e));
}

const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETag = localStorage.getItem('tpLastETag') || null;

function pollInterest() {
  if (!isLeader()) return;
  fetch(HTML_URL, {
    method: 'HEAD', credentials: 'same-origin',
    headers: lastETag ? { 'If-None-Match': lastETag } : {}
  })
  .then(h => {
    if (h.status === 304) { console.info('[TP-interesse] uændret', new Date().toLocaleTimeString()); return; }
    lastETag = h.headers.get('ETag') || null;
    if (lastETag) localStorage.setItem('tpLastETag', lastETag);
    return fetch(HTML_URL, { credentials: 'same-origin', headers: { Range: 'bytes=0-20000' } })
      .then(r => r.text()).then(parseInterestHTML);
  })
  .catch(e => console.warn('[TP][ERR][INT][HEAD]', e));
}
function parseInterestHTML(html) {
  if (!isLeader()) return;
  const doc   = new DOMParser().parseFromString(html, 'text/html');
  const boxes = Array.prototype.slice.call(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  const c = boxes.reduce((s, el) => { const v = parseInt(el.textContent.trim(), 10); return s + (isNaN(v) ? 0 : v); }, 0);
  const stInt = loadJson(ST_INT_KEY, {count:0,lastPush:0,lastSent:0});
  const en = localStorage.getItem('tpPushEnableInt') === 'true';
  if (c > stInt.count && c !== stInt.lastSent) {
    if (Date.now() - stInt.lastPush > SUPPRESS_MS && takeLock()) {
      const m = '👀 ' + c + ' vikar(er) har vist interesse for ledige vagter';
      if (en) sendPushover(m); showToastOnce('int', m);
      stInt.lastPush = Date.now(); stInt.lastSent = c;
    } else stInt.lastSent = c;
  } else if (c < stInt.count) stInt.lastPush = 0;
  stInt.count = c; saveJsonIfLeader(ST_INT_KEY, stInt);
  console.info('[TP-interesse]', c, new Date().toLocaleTimeString());
}

/*──────── 6) LEADER-ELECTION ────────*/
function now() { return Date.now(); }
function getLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (_) { return null; } }
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); }
function isLeader() { const L = getLeader(); return !!(L && L.id === TAB_ID && L.until > now()); }
function tryBecomeLeader() { const L = getLeader(), t = now(); if (!L || (L.until || 0) <= t) { setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); if (isLeader()) console.info('[TP][LEADER] Denne fane er nu leder:', TAB_ID);} }
function heartbeatIfLeader() { if (!isLeader()) return; const t = now(); setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); }
window.addEventListener('storage', e => { if (e.key === LEADER_KEY) {/*noop*/} });

/*──────── 6a) HTTP helpers + ETag-cache ────────*/
function gmGET(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function gmGETArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer',
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function headerPick(headersStr, name) {
  const m = headersStr && headersStr.match(new RegExp('^' + name + ':\\s*(.+)$','im'));
  return m ? m[1].trim() : null;
}
function gmHEAD(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'HEAD', url, timeout: 15000,
      onload: r => resolve({ status: r.status, headers: r.responseHeaders || '' }),
      ontimeout: () => reject(new Error('HEAD timeout')),
      onerror:   e => reject(e)
    });
  });
}
function gmGETWithHeaders(url, headers={}) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, headers,
      onload: r => resolve({ status: r.status, text: r.responseText || '', headers: r.responseHeaders || '' }),
      onerror: e => reject(e)
    });
  });
}
/** ETag-cache for RAW GitHub – fallback til cache ved netfejl. */
async function fetchTextWithETagCache(url, cacheKey) {
  let cached = null;
  try { cached = await GM_getValue(cacheKey, null); } catch(_) {}
  try {
    const h = await gmHEAD(url);
    const etag = headerPick(h.headers, 'etag')?.replace(/^W\//,'') || null;
    const len  = Number(headerPick(h.headers, 'content-length') || '0');
    if (cached?.etag && etag && cached.etag === etag) {
      return { text: cached.text, fromCache: true, etag, len };
    }
    const r = await gmGETWithHeaders(url, etag ? { 'If-None-Match': etag } : {});
    if (r.status === 304 && cached) {
      return { text: cached.text, fromCache: true, etag: cached.etag || etag, len };
    }
    if (r.status >= 200 && r.status < 300) {
      const obj = { text: r.text, etag: etag || headerPick(r.headers,'etag') || null, ts: Date.now(), len };
      try { await GM_setValue(cacheKey, obj); } catch(_) {}
      return { text: obj.text, fromCache: false, etag: obj.etag, len };
    }
    throw new Error('HTTP ' + r.status);
  } catch (e) {
    if (cached?.text) return { text: cached.text, fromCache: true, etag: cached.etag || null, len: cached.len || 0 };
    throw e;
  }
}

/*──────── 6b) CALLER-POP (CSV/JSON) ────────*/
function normPhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
}

// Robust CSV parser (,/; + simple quotes)
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
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
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

// CSV → Map(phone8 → {id,name})
function parsePhonebookCSV(text) {
  const map = new Map();
  const rows = parseCSV(text);
  if (!rows.length) return map;

  const header = rows[0].map(h => h.toLowerCase());
  const idxId   = header.findIndex(h => /(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));
  const idxName = header.findIndex(h => /(navn|name)/.test(h));
  const phoneCols = header
    .map((h, idx) => ({ h, idx }))
    .filter(x => /(telefon|mobil|cellphone|mobile|phone)/.test(x.h));

  if (idxId < 0 || phoneCols.length === 0) return map;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id   = (row[idxId]   || '').trim();
    const name = idxName >= 0 ? (row[idxName] || '').trim() : '';
    if (!id) continue;

    for (const pc of phoneCols) {
      const val = (row[pc.idx] || '').trim();
      const p8 = normPhone(val);
      if (p8) map.set(p8, { id, name });
    }
  }
  return map;
}

// JSON-map → Map(phone8 → {id,name})
function parsePhonebookJSON(text) {
  const map = new Map();
  if (!text) return map;
  let obj = null;
  try { obj = JSON.parse(text); } catch(_) { return map; }
  for (const k of Object.keys(obj)) {
    const p8 = normPhone(k);
    if (!p8) continue;
    const v = obj[k] || {};
    if (v.id) map.set(p8, { id: String(v.id), name: String(v.name || '') });
  }
  return map;
}

/** Hent telefonbog: CSV hvis <1MB, ellers JSON-map. Fallback mellem kilder + ETag-cache. */
async function getPhonebookMapSmart() {
  try {
    const csv = await fetchTextWithETagCache(RAW_PHONEBOOK, CSV_CACHE_KEY);
    // Hvis CSV er tom/kun header, prøv JSON før parse
    if ((csv.text || '').trim().split(/\r?\n/).filter(Boolean).length < 2 || csv.len > RAW_MAX_BYTES) {
      try {
        const js = await fetchTextWithETagCache(RAW_PHONEBOOK_MAP, MAP_CACHE_KEY);
        const map = parsePhonebookJSON(js.text);
        if (map.size) return map;
      } catch(_) { /* fallback til CSV */ }
    }
    const mapCsv = parsePhonebookCSV(csv.text);
    if (mapCsv.size) return mapCsv;
    // CSV parsed tomt – prøv JSON som sidste chance
    const js = await fetchTextWithETagCache(RAW_PHONEBOOK_MAP, MAP_CACHE_KEY);
    const map = parsePhonebookJSON(js.text);
    if (map.size) return map;
    return mapCsv; // tom
  } catch(e) {
    // CSV fejlede; prøv JSON
    try {
      const js = await fetchTextWithETagCache(RAW_PHONEBOOK_MAP, MAP_CACHE_KEY);
      const map = parsePhonebookJSON(js.text);
      if (map.size) return map;
    } catch(_) {}
    throw e;
  }
}

async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const raw = q.get('tp_caller'); if (!raw) return;
    const cleaned = String(raw).replace(/\*1500$/, '');
    const phone8 = normPhone(cleaned);
    if (!phone8) { showToast('Ukendt nummer: ' + raw); return; }

    const map = await getPhonebookMapSmart();
    const rec = map.get(phone8);
    if (!rec) { showToast('Ingen match for: ' + phone8); return; }
    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    showToast(`Åbner vikar: ${rec.name || 'ukendt navn'} (${rec.id})`);
    location.assign(url);
  } catch (e) {
    console.warn('[TP][CALLER]', e);
    showToast('Kan ikke hente telefonbog lige nu.');
  }
}

/*──────── 6c) GITHUB API (upload) ────────*/
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin);
}
function b64encodeBytes(u8) {
  let bin=''; for (let i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]); return btoa(bin);
}
function ghGetSha(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: {
        'Accept': 'application/vnd.github+json',
        ...(token ? {'Authorization': 'Bearer ' + token} : {}),
        'X-GitHub-Api-Version': '2022-11-28'
      },
      onload: r => {
        if (r.status === 200) { try { const js = JSON.parse(r.responseText); resolve({ sha: js.sha, exists: true }); } catch(_) { resolve({ sha:null, exists:true }); } }
        else if (r.status === 404) resolve({ sha:null, exists:false });
        else reject(new Error('GitHub GET sha: HTTP '+r.status));
      },
      onerror: e => reject(e)
    });
  });
}
function ghPutFile(owner, repo, path, base64Content, message, sha, branch) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
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
      onload: r => { (r.status===200 || r.status===201) ? resolve(r.responseText) : reject(new Error('GitHub PUT: HTTP '+r.status+' '+(r.responseText||''))); },
      onerror: e => reject(e)
    });
  });
}

/*──────── 6d) EXCEL → CSV (robust) ────────*/
async function fetchExcelAsCSVText() {
  const excelUrl = `${location.origin}/index.php?page=print_vikar_list_custom_excel&id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag&sortBy=`;

  // 1) fetch med session-cookies
  let ab = null;
  try {
    const r = await fetch(excelUrl, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    ab = await r.arrayBuffer();
  } catch (_) {
    // 2) Fallback til GM
    ab = await gmGETArrayBuffer(excelUrl);
  }

  if (!ab || ab.byteLength < 200) {
    throw new Error('Excel-download var for lille (' + (ab ? ab.byteLength : 0) + ' bytes)');
  }

  const wb = XLSX.read(ab, { type: 'array' });
  if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('Excel indeholder ingen ark');

  const sheet = wb.Sheets[wb.SheetNames[0]];
  let csv = XLSX.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n' });
  csv = normalizePhonebookHeader(csv);

  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV ser tom ud efter konvertering (kun ' + lines.length + ' linje)');
  return csv;
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

// CSV → JSON-map
function csvToPhoneMapJSON(csvText) {
  const m = parsePhonebookCSV(csvText);
  const obj = {};
  Array.from(m.entries())
    .sort(([a],[b]) => a.localeCompare(b))
    .forEach(([k, v]) => { obj[k] = { id: v.id, name: v.name }; });
  return JSON.stringify(obj, null, 2);
}

// Excel→CSV + upload (med tom-beskyttelse) + JSON-map
async function fetchExcelAsCSVAndUpload() {
  const text = await fetchExcelAsCSVText(); // kaster fejl hvis tom
  const base64 = b64encodeUtf8(text);
  const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
  await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: Excel→CSV via TM', sha, PB_BRANCH);

  // JSON-map
  try {
    const json = csvToPhoneMapJSON(text);
    const base64j = b64encodeUtf8(json);
    const meta = await ghGetSha(PB_OWNER, PB_REPO, PB_MAP, PB_BRANCH);
    await ghPutFile(PB_OWNER, PB_REPO, PB_MAP, base64j, 'sync: regenerate vikarer.map.json', meta.sha, PB_BRANCH);
  } catch(e) {
    console.warn('[TP][PB][MAP-UPLOAD]', e);
  }
}

// Kun rå XLSX (ingen map) – valgfrit
async function fetchExcelAndUploadRawXLSX() {
  const excelUrl = `${location.origin}/index.php?page=print_vikar_list_custom_excel&id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag&sortBy=`;
  const ab = await gmGETArrayBuffer(excelUrl);
  if (!ab || ab.byteLength < 200) throw new Error('Excel-download var for lille');
  const u8 = new Uint8Array(ab);
  const b64 = b64encodeBytes(u8);
  const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_XLSX, PB_BRANCH);
  await ghPutFile(PB_OWNER, PB_REPO, PB_XLSX, b64, 'sync: fetch server Excel → vikarer.xlsx via TM', sha, PB_BRANCH);
}

/*──────── 7) UI (panel + gear) ────────*/
function injectUI() {
  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483645;background:#f9f9f9;border:1px solid #ccc;padding:8px 10px;border-radius:6px;font-size:12px;font-family:sans-serif;box-shadow:1px 1px 5px rgba(0,0,0,.2);min-width:220px';
  d.innerHTML =
    '<b>TP Notifikationer</b>' +
    '<div style="margin-top:6px">' +
      '<label style="display:block;margin:2px 0"><input type="checkbox" id="m"> Besked (Pushover)</label>' +
      '<label style="display:block;margin:2px 0"><input type="checkbox" id="i"> Interesse (Pushover)</label>' +
    '</div>';
  document.body.appendChild(d);

  const m = d.querySelector('#m'), i = d.querySelector('#i');
  m.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  i.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  m.onchange = () => localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false');
  i.onchange = () => localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false');

  // Tandhjul
  const gear = document.createElement('div');
  gear.id = 'tpGear'; gear.title = 'Indstillinger'; gear.innerHTML = '⚙️';
  Object.assign(gear.style, {
    position:'fixed', right:'12px', bottom: (8 + d.offsetHeight + 10) + 'px',
    width:'22px', height:'22px', lineHeight:'22px', textAlign:'center',
    background:'#fff', border:'1px solid #ccc', borderRadius:'50%',
    boxShadow:'0 1px 5px rgba(0,0,0,.2)', cursor:'pointer',
    zIndex:2147483647, userSelect:'none'
  });
  document.body.appendChild(gear);
  ensureFullyVisible(gear);

  // Gear-menu
  let menu = null;
  function buildMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, {
      position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
      borderRadius:'8px', boxShadow:'0 2px 12px rgba(0,0,0,.25)', fontSize:'12px',
      fontFamily:'sans-serif', padding:'10px', width:'380px'
    });
    menu.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>' +
      '<div style="margin-bottom:10px">' +
        '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
        '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<button id="tpSaveUserKeyMenu" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Gem</button>' +
          '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Guide til USER-token</a>' +
        '</div>' +
      '</div>' +
      '<div style="border-top:1px solid #eee;margin:8px 0"></div>' +
      '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>' +
      '<div id="tpLeaderHint" style="margin-top:6px;font-size:11px;color:#666"></div>' +
      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<div style="font-weight:700;margin-bottom:6px">Telefonbog (admin)</div>' +
      '<div style="margin-bottom:6px;font-size:12px;color:#444">Repo: '+PB_OWNER+'/'+PB_REPO+' • Branch: '+PB_BRANCH+' • Filer: '+PB_CSV+' / '+PB_XLSX+' / '+PB_MAP+'</div>' +
      '<div style="margin-bottom:6px">' +
        '<div style="font-weight:600;margin-bottom:4px">GitHub PAT (fine-grained, Contents: RW til dette repo)</div>' +
        '<input id="tpGitPAT" type="password" placeholder="ghp_… eller fine-grained" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1"/>' +
          '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<button id="tpFetchCSVUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⚡ Hent Excel → CSV + Upload</button>' +
          '<button id="tpFetchExcelUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⬇️ Hent Excel + Upload (XLSX)</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<input id="tpTestPhone" type="text" placeholder="Test nummer (fx 22 44 66 88)" style="flex:1;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
          '<button id="tpLookupPhone" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Slå op</button>' +
        '</div>' +
        '<div id="tpPBHint" style="margin-top:6px;font-size:11px;color:#666"></div>' +
      '</div>';
    document.body.appendChild(menu);

    // Pushover
    const inp  = menu.querySelector('#tpUserKeyMenu');
    const save = menu.querySelector('#tpSaveUserKeyMenu');
    const test = menu.querySelector('#tpTestPushoverBtn');
    const hint = menu.querySelector('#tpLeaderHint');
    inp.value = getUserKey();
    function refreshLeaderHint(){ hint.textContent = (isLeader() ? 'Denne fane er LEADER for push.' : 'Ikke leader – en anden fane sender push.'); }
    refreshLeaderHint();
    save.addEventListener('click', () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showToast('USER-token gemt.'); });
    inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); GM_setValue('tpUserKey',(inp.value||'').trim()); showToast('USER-token gemt.'); }});
    test.addEventListener('click', () => { tpTestPushoverBoth(); menu.style.display='none'; });
    window.addEventListener('storage', e => { if (e.key===LEADER_KEY) refreshLeaderHint(); });

    // Telefonbog
    const pat   = menu.querySelector('#tpGitPAT');
    const file  = menu.querySelector('#tpCSVFile');
    const up    = menu.querySelector('#tpUploadCSV');
    const exUp  = menu.querySelector('#tpFetchExcelUpload');
    const csvUp = menu.querySelector('#tpFetchCSVUpload');
    const tIn   = menu.querySelector('#tpTestPhone');
    const tBtn  = menu.querySelector('#tpLookupPhone');
    const pbh   = menu.querySelector('#tpPBHint');

    pat.value = (GM_getValue('tpGitPAT') || '');
    pat.addEventListener('change', () => GM_setValue('tpGitPAT', pat.value || ''));

    // Upload manuel CSV (med tom-beskyttelse)
    up.addEventListener('click', async () => {
      try {
        const token = (pat.value||'').trim(); if (!token) { showToast('Indsæt GitHub PAT først.'); return; }
        if (!file.files || !file.files[0]) { showToast('Vælg en CSV-fil først.'); return; }
        const text = await file.files[0].text();
        const lines = (text || '').trim().split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) {
          pbh.textContent = 'CSV ser tom ud – uploader IKKE.';
          showToast('CSV er tom – upload afbrudt.');
          return;
        }
        const base64 = b64encodeUtf8(text);
        pbh.textContent = 'Uploader CSV…';
        const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
        await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: upload CSV via TM', sha, PB_BRANCH);

        // JSON-map
        try {
          const json = csvToPhoneMapJSON(text);
          const base64j = b64encodeUtf8(json);
          const meta = await ghGetSha(PB_OWNER, PB_REPO, PB_MAP, PB_BRANCH);
          await ghPutFile(PB_OWNER, PB_REPO, PB_MAP, base64j, 'sync: regenerate vikarer.map.json', meta.sha, PB_BRANCH);
        } catch(e) { console.warn('[TP][PB][MAP-UPLOAD]', e); }

        pbh.textContent = 'CSV (og JSON-map) uploadet. RAW opdateres om få sek.';
        showToast('CSV uploadet.');
      } catch (e) { console.warn('[TP][PB][CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved CSV upload.'; showToast('Fejl – se konsol.'); }
    });

    // Excel→CSV + Upload (robust)
    csvUp.addEventListener('click', async () => {
      try {
        const token = (pat.value||'').trim(); if (!token) { showToast('Indsæt GitHub PAT først.'); return; }
        pbh.textContent = 'Henter Excel, konverterer til CSV og uploader …';
        const t0 = Date.now();
        await fetchExcelAsCSVAndUpload(); // kaster hvis tom ⇒ ingen upload
        const ms = Date.now()-t0;
        pbh.textContent = `CSV uploadet (Excel→CSV) på ${ms} ms.`;
        showToast('CSV uploadet (Excel→CSV).');
      } catch (e) { console.warn('[TP][PB][EXCEL→CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel→CSV upload: ' + (e&&e.message?e.message:''); showToast('Fejl – se konsol.'); }
    });

    // Rå XLSX
    exUp.addEventListener('click', async () => {
      try {
        const token = (pat.value||'').trim(); if (!token) { showToast('Indsæt GitHub PAT først.'); return; }
        pbh.textContent = 'Henter Excel fra server …';
        const t0 = Date.now();
        await fetchExcelAndUploadRawXLSX();
        const ms = Date.now()-t0;
        pbh.textContent = `Excel uploadet som ${PB_XLSX} (${ms} ms).`;
        showToast('Excel uploadet (komplet liste).');
      } catch (e) { console.warn('[TP][PB][EXCEL-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel upload.'; showToast('Fejl – se konsol.'); }
    });

    // TEST: opslag (smart CSV/JSON)
    tBtn.addEventListener('click', async () => {
      try {
        const raw = (tIn.value||'').trim();
        const p8 = normPhone(raw);
        if (!p8) { pbh.textContent = 'Ugyldigt nummer.'; return; }

        pbh.textContent = 'Slår op i telefonbog…';
        const map = await getPhonebookMapSmart();
        const rec = map.get(p8);

        if (!rec) {
          pbh.textContent = `Ingen match for ${p8}.`;
          return;
        }

        pbh.textContent = `Match: ${p8} → ${rec.name || '(uden navn)'} (vikar_id=${rec.id})`;
        const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
        window.open(url, '_blank', 'noopener');
      } catch(e) {
        console.warn('[TP][PB][LOOKUP]', e);
        pbh.textContent = 'Fejl ved opslag.';
      }
    });

    // 🧹 Ryd cache-knap
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '🧹 Ryd telefonbogs-cache';
    clearBtn.style.cssText = 'margin-top:8px;padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer';
    clearBtn.addEventListener('click', async () => {
      try {
        await GM_setValue(CSV_CACHE_KEY, null);
        await GM_setValue(MAP_CACHE_KEY, null);
        pbh.textContent = 'Cache ryddet.';
        showToast('Telefonbogs-cache ryddet.');
      } catch (e) {
        pbh.textContent = 'Kunne ikke rydde cache.';
      }
    });
    menu.appendChild(clearBtn);

    return menu;
  }

  function toggleMenu() {
    const mnu = buildMenu();
    const r = gear.getBoundingClientRect();
    mnu.style.right = (window.innerWidth - r.right) + 'px';
    mnu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    mnu.style.display = (mnu.style.display === 'block' ? 'none' : 'block');
  }
  gear.addEventListener('click', toggleMenu);

  document.addEventListener('mousedown', e => {
    const m = menu; if (m && e.target !== m && !m.contains(e.target) && e.target !== gear) m.style.display = 'none';
  });
}
function ensureFullyVisible(el){
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  if (r.right > window.innerWidth)  dx = window.innerWidth - r.right - 6;
  if (r.bottom > window.innerHeight) dy = window.innerHeight - r.bottom - 6;
  if (r.left < 0)  dx = 6 - r.left;
  if (r.top  < 0)  dy = 6 - r.top;
  if (dx || dy) el.style.transform = `translate(${dx}px,${dy}px)`;
}

/* Test-knap */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  const m1 = '🧪 [TEST] Besked-kanal OK — ' + ts;
  const m2 = '🧪 [TEST] Interesse-kanal OK — ' + ts;
  sendPushover(m1); setTimeout(() => sendPushover(m2), 800);
  showToast('Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
}

/*──────── 8) STARTUP ────────*/
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent || '')) {
    if (isLeader()) { const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0}); stMsg.lastPush = stMsg.lastSent = 0; saveJsonIfLeader(ST_MSG_KEY, stMsg); }
  }
});
tryBecomeLeader();
setInterval(heartbeatIfLeader, HEARTBEAT_MS);
setInterval(tryBecomeLeader, HEARTBEAT_MS + 1200);
callerPopIfNeeded().catch(()=>{});
pollMessages(); pollInterest();
setInterval(pollMessages, POLL_MS);
setInterval(pollInterest, POLL_MS);
injectUI();
console.info('[TP] kører version 6.65');

/*──────── 9) HOVER “Intet Svar” (auto-gem) ────────*/
(function () {
  var auto = false, icon = null, menu = null, hideT = null;
  function mkMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, { position: 'fixed', zIndex: 2147483647, background: '#fff', border: '1px solid #ccc', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,.25)', fontSize: '12px', fontFamily: 'sans-serif' });
    var btn = document.createElement('div');
    btn.textContent = 'Registrér “Intet Svar”';
    btn.style.cssText = 'padding:6px 12px;white-space:nowrap;cursor:default';
    btn.onmouseenter = function () { btn.style.background = '#f0f0f0'; };
    btn.onmouseleave = function () { btn.style.background = ''; };
    btn.onclick = function () { auto = true; if (icon) icon.click(); hide(); };
    menu.appendChild(btn); document.body.appendChild(menu); return menu;
  }
  function show(el) { icon = el; var r = el.getBoundingClientRect(); var m = mkMenu(); m.style.left = r.left + 'px'; m.style.top = r.bottom + 4 + 'px'; m.style.display = 'block'; }
  function hide() { clearTimeout(hideT); hideT = setTimeout(function () { if (menu) menu.style.display = 'none'; icon = null; }, 120); }
  function findIcon(n) { while (n && n !== document) { if (n.getAttribute && n.getAttribute('title') === 'Registrer opkald til vikar') return n; n = n.parentNode; } return null; }

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
        if (hsWrap) { hsWrap.style.opacity = '0'; hsWrap.style.pointerEvents = 'none'; }
        var ta = (n.matches && n.matches('textarea[name="phonetext"]')) ? n : (n.querySelector && n.querySelector('textarea[name="phonetext"]'));
        if (ta) {
          if (!ta.value.trim()) ta.value = 'Intet Svar';
          var frm = ta.closest('form');
          var saveBtn = frm && Array.prototype.find.call(frm.querySelectorAll('input[type="button"]'), function (b) { return /Gem registrering/i.test(b.value || ''); });
          if (saveBtn) {
            setTimeout(function () {
              try { saveBtn.click(); } catch (_) {}
              try { if (unsafeWindow.hs && unsafeWindow.hs.close) unsafeWindow.hs.close(); } catch (_) {}
              if (hsWrap) { hsWrap.style.opacity = ''; hsWrap.style.pointerEvents = ''; }
            }, 30);
          }
          auto = false;
        }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
