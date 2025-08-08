// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      7.9.9
// @description  Push (leader+suppression), toast (Smart/Force DOM, max 1 OS på tværs af faner), “Intet Svar”-auto-gem, telefonbog m. inbound caller-pop (kun kø *1500, nyt faneblad, nul flash), Excel→CSV→Upload til GitHub, RAW CSV lookup. Statusbanner, “Søg efter opdatering”, drag af UI + CSV drag&drop, samt SMS (status + aktivér/deaktiver) direkte i hovedpanelet. Robuste UI-placeringer (panel, gear, menu).
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
// @homepageURL  https://github.com/danieldamdk/temponizer-notifikation
// @supportURL   https://github.com/danieldamdk/temponizer-notifikation/issues
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// ==/UserScript==

/*──────── 0) VERSION ────────*/
const TP_VERSION = '7.9.9';

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_MS     = 30000;
const SUPPRESS_MS = 45000;
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

/*──────── 2) TOAST ────────*/
function showToastOnce(key, msg) {
  const lk = 'tpToastLock_' + key;
  const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
  if (Date.now() - o.t < LOCK_MS) return;
  localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
  showToast(msg);
}
function showToast(msg) {
  const forceDom = localStorage.getItem('tpForceDOMToast') === 'true';
  const smart    = localStorage.getItem('tpSmartToast') === 'true';
  if (forceDom) { showDOMToast(msg); return; }
  if (smart && document.visibilityState === 'visible') { showDOMToast(msg); return; }
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
    opacity: 0, transition: 'opacity .25s'
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = 1; });
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => { el.remove(); }, 350); }, 3800);
}

/*──────── 2a) CROSS-TAB TOAST (max 1 OS) ────────*/
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
    if (!isLeader() && document.visibilityState === 'visible') {
      showDOMToast(ev.msg); // kun DOM i non-leader
    }
  } catch (_) {}
});

/*──────── 2b) STATUS-BANNER ────────*/
function tpBanner(msg, ms = 4000) {
  try {
    let el = document.getElementById('tpCallerBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tpCallerBanner';
      Object.assign(el.style, {
        position: 'fixed', top: '8px', left: '8px',
        zIndex: 2147483647, background: '#212121', color: '#fff',
        padding: '8px 10px', borderRadius: '6px', font: '12px/1.3 system-ui, sans-serif',
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
  if (!PUSHOVER_TOKEN || !userKey) { showToast('Pushover ikke konfigureret – indsæt USER-token i ⚙️.'); return; }
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) + '&user=' + encodeURIComponent(userKey) + '&message=' + encodeURIComponent(msg);
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
    onerror: () => { fetch('https://api.pushover.net/1/messages.json', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body }).catch(console.warn); }
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
          if (en) sendPushover(m);
          broadcastToast('msg', m);
          showToastOnce('msg', m);
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
  fetch(HTML_URL, { method: 'HEAD', credentials: 'same-origin', headers: lastETag ? { 'If-None-Match': lastETag } : {} })
  .then(h => {
    if (h.status === 304) { console.info('[TP-interesse] uændret', new Date().toLocaleTimeString()); return; }
    lastETag = h.headers.get('ETag') || null;
    if (lastETag) localStorage.setItem('tpLastETag', lastETag);
    return fetch(HTML_URL, { credentials: 'same-origin', headers: { Range: 'bytes=0-20000' } }).then(r => r.text()).then(parseInterestHTML);
  })
  .catch(e => {
    console.warn('[TP][ERR][INT][HEAD]', e);
    fetch(HTML_URL, { credentials: 'same-origin', headers: { Range: 'bytes=0-20000' } })
      .then(r => r.text()).then(parseInterestHTML).catch(err => console.warn('[TP][ERR][INT][GET]', err));
  });
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
      if (en) sendPushover(m);
      broadcastToast('int', m);
      showToastOnce('int', m);
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
window.addEventListener('storage', e => { if (e.key === LEADER_KEY) {/*no-op*/} });

/*──────── 6a) HTTP helpers ────────*/
function gmGET(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: { 'Accept': '*/*', 'Referer': location.href },
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
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8',
        'Referer': location.href
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
        'Referer': location.href
      },
      data: body,
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}

/*──────── 6b) CALLER-POP ────────*/
function normPhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
}
function detectDelimiter(sample) {
  const lines = sample.split(/\r?\n/).slice(0, 5).filter(Boolean);
  let cComma = 0, cSemi = 0;
  for (const ln of lines) {
    const stripped = ln.replace(/"[^"]*"/g, '');
    cComma += (stripped.match(/,/g) || []).length;
    cSemi  += (stripped.match(/;/g) || []).length;
  }
  return cSemi > cComma ? ';' : ',';
}
function parseCSV(text) {
  if (!text) return [];
  text = text.replace(/^\uFEFF/, '');
  const delim = detectDelimiter(text);
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
  const map = new Map();
  const rows = parseCSV(text);
  if (!rows.length) return { map, header: [] };
  const header = rows[0].map(h => h.toLowerCase());
  const idxId   = header.findIndex(h => /(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));
  const idxName = header.findIndex(h => /(navn|name)/.test(h));
  const phoneCols = header.map((h, idx) => ({ h, idx })).filter(x => /(telefon(?:nummer)?|^tlf\.?$|mobil|cell(?:phone)?|mobile|phone)/.test(x.h));
  if (idxId < 0 || phoneCols.length === 0) return { map, header };
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
  return { map, header };
}
async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const rawParam = q.get('tp_caller');
    if (!rawParam) return;

    const rawStr = String(rawParam).trim();

    // Nul flash for ikke-køkald
    const unsetHide = (() => {
      const html = document.documentElement; const old = html.style.visibility;
      html.style.visibility = 'hidden'; return () => { html.style.visibility = old; };
    })();

    const isQueueInbound = /\*1500\s*$/.test(rawStr);
    if (!isQueueInbound) {
      tpBanner('Udgående/ikke-kø — lukker …', 900);
      try { window.close(); } catch (_) {}
      try { window.open('', '_self'); window.close(); } catch (_) {}
      try { location.replace('about:blank'); } catch (_) {}
      return;
    }

    unsetHide();

    const digitsRaw = rawStr.replace(/\*1500\s*$/,'').replace(/[^\d+]/g, '');
    const phone8 = normPhone(digitsRaw);

    console.info('[TP][CALLER] Inbound køkald', { raw: rawStr, digitsRaw, phone8 });
    tpBanner('Indgående køkald: ' + (phone8 || '—') + ' — slår op …', 2500);

    if (!phone8) { tpBanner('Ukendt nummerformat: ' + rawStr, 5000); return; }

    let csvText = '';
    try { csvText = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now()); if (csvText) GM_setValue(CACHE_KEY_CSV, csvText); } catch(_) {}
    if (!csvText) csvText = GM_getValue(CACHE_KEY_CSV) || '';
    if (!csvText) { tpBanner('Ingen telefonbog tilgængelig (RAW og cache tom).', 5000); return; }

    const { map } = parsePhonebookCSV(csvText);
    const rec = map.get(phone8);
    if (!rec) { tpBanner('Ingen match i CSV: ' + phone8, 4000); return; }

    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    tpBanner(`Match: ${rec.name || '(uden navn)'} (#${rec.id}) — åbner …`, 1800);
    if (OPEN_NEW_TAB_ON_INBOUND) { window.open(url, '_blank', 'noopener'); } else { location.assign(url); }
  } catch (e) {
    console.warn('[TP][CALLER] error', e);
    tpBanner('Fejl under opslag — se konsol.', 5000);
  }
}

/*──────── 6c) GITHUB API ────────*/
function b64encodeUtf8(str) { const bytes = new TextEncoder().encode(str); let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin); }
function ghGetSha(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: { 'Accept': 'application/vnd.github+json', ...(token ? {'Authorization': 'Bearer ' + token} : {}), 'X-GitHub-Api-Version': '2022-11-28' },
      onload: r => { if (r.status===200){ try{ const js=JSON.parse(r.responseText); resolve({ sha: js.sha, exists: true }); } catch(_){ resolve({ sha:null, exists:true }); } }
                     else if (r.status===404) resolve({ sha:null, exists:false });
                     else reject(new Error('GitHub GET sha: HTTP '+r.status)); },
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
      headers: { 'Accept': 'application/vnd.github+json', ...(token ? {'Authorization': 'Bearer ' + token} : {}), 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json;charset=UTF-8' },
      data: JSON.stringify({ message, content: base64Content, branch, ...(sha ? { sha } : {}) }),
      onload: r => { (r.status===200 || r.status===201) ? resolve(r.responseText) : reject(new Error('GitHub PUT: HTTP '+r.status+' '+(r.responseText||''))); },
      onerror: e => reject(e)
    });
  });
}

/*──────── 6d) EXCEL → CSV ────────*/
function normalizePhonebookHeader(csv) {
  const lines = csv.split(/\r?\n/); if (!lines.length) return csv;
  const hdr = (lines[0] || '').split(',');
  const mapName = (h) => {
    const x = h.trim().toLowerCase();
    if (/(vikar.*nr|vikar[_ ]?id|^id$)/.test(x)) return 'vikar_id';
    if (/(navn|name)/.test(x)) return 'name';
    if (/(^telefon$|^telefonnummer$|phone(?!.*cell)|^tlf\.?$)/.test(x)) return 'phone';
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
    } catch (e) {
      console.warn('[TP][PB] Excel hentning fejlede:', e);
      lastInfo = String(e && e.message || e);
    }
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

/*──────── 6e) SMS (status + aktivér/deaktiver) ────────*/
const SMS_SETTINGS_URL = `${location.origin}/index.php?page=showmy_settings`;

// Stram parser: brug KUN inline display + linksignaturer (onclick/href)
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

  // Link-signaturer (Temponizer bruger onclick="activate_cell_sms_notifikationer()" / deactivate_...)
  const hasDeactivateLink = !!(doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') ||
                               doc.querySelector('#sms_notifikation_aktiv a[href*="deactivate_cell_sms_notifikationer"]'));
  const hasActivateLink   = !!(doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') ||
                               doc.querySelector('#sms_notifikation_ikke_aktiv a[href*="activate_cell_sms_notifikationer"]'));

  let state = 'unknown', phone = '';

  if (aktivShown || (!inaktivShown && hasDeactivateLink && !hasActivateLink)) {
    state = 'active';
  } else if (inaktivShown || (!aktivShown && hasActivateLink && !hasDeactivateLink)) {
    state = 'inactive';
  } else {
    // Tekst-fallback, men kun hvis unik
    const txtA = (elAktiv?.textContent || '').toLowerCase();
    const txtI = (elInaktiv?.textContent || '').toLowerCase();
    const aHit = /er\s*aktiv/.test(txtA);
    const iHit = /er\s*ikke\s*aktiv/.test(txtI);
    if (aHit && !iHit) state = 'active';
    else if (iHit && !aHit) state = 'inactive';
  }

  const refTxt = state === 'active'
    ? (elAktiv?.textContent || '')
    : (elInaktiv?.textContent || '');
  const m = refTxt.replace(/\u00A0/g,' ').match(/\+?\d[\d\s]{5,}/);
  if (m) phone = m[0].replace(/\s+/g,'');

  return { state, phone };
}
function parseSmsStatusFromHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return parseSmsStatusFromDoc(doc);
}
async function fetchSmsStatusHTML() {
  return gmGET(SMS_SETTINGS_URL + '&t=' + Date.now());
}
async function getSmsStatus() {
  try {
    const html = await fetchSmsStatusHTML();
    return parseSmsStatusFromHTML(html);
  } catch {
    return { state: 'unknown' };
  }
}

// Autopilot på settings-siden (klik “Aktivér/Deaktiver” og luk)
(function smsAutopilot(){
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('page') !== 'showmy_settings') return;
    const m = (u.hash || '').toLowerCase().match(/tp_sms_auto=(activate|deactivate)/);
    if (!m) return;
    const action = m[1];
    const doClick = () => {
      const doc = document;
      const link = action === 'activate'
        ? (doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') ||
           doc.querySelector('#sms_notifikation_ikke_aktiv a'))
        : (doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') ||
           doc.querySelector('#sms_notifikation_aktiv a'));
      if (link) link.click();
      const targetSel = action === 'activate' ? '#sms_notifikation_aktiv' : '#sms_notifikation_ikke_aktiv';
      const t0 = Date.now();
      const iv = setInterval(() => {
        const target = doc.querySelector(targetSel);
        const ok = target && hasDisplayBlock(target);
        if (ok || Date.now() - t0 > 12000) { clearInterval(iv); try { window.close(); } catch(_) {} }
      }, 500);
    };
    setTimeout(doClick, 300);
  } catch(_) {}
})();

const sms = {
  _busy: false,
  _last: null,
  async refresh(cb) {
    const st = await getSmsStatus();
    this._last = st; cb && cb(st);
  },
  _openPopup(action) {
    // Diskret popup/fane – forsøg at placere off-screen
    const features = [
      'popup=yes','noopener','noreferrer',
      'toolbar=no','location=no','status=no','menubar=no','scrollbars=no','resizable=no',
      'width=320','height=320','left=-10000','top=-10000'
    ].join(',');
    const w = window.open(`${SMS_SETTINGS_URL}#tp_sms_auto=${action}`, 'tpSmsCtl', features);
    try { window.focus(); } catch(_) {}
    return w;
  },
  async _pollUntil(desired, timeoutMs=15000, intervalMs=600) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const st = await getSmsStatus();
      this._last = st;
      if (st.state === desired) return st;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('Timeout waiting for state=' + desired);
  },
  async setEnabled(wantOn, uiBusy, cb) {
    if (this._busy) return;
    this._busy = true;
    uiBusy && uiBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
    try {
      const pop = this._openPopup(wantOn ? 'activate' : 'deactivate');
      let st;
      try { st = await this._pollUntil(wantOn ? 'active' : 'inactive'); }
      finally { try { if (pop && !pop.closed) pop.close(); } catch(_) {} }
      cb && cb(st);
      showToast(wantOn ? 'SMS aktiveret.' : 'SMS deaktiveret.');
    } catch (e) {
      showToast('Kunne ikke ' + (wantOn ? 'aktivere' : 'deaktivere') + ' SMS (timeout).');
      const st = await getSmsStatus(); this._last = st; cb && cb(st);
    } finally {
      this._busy = false;
      uiBusy && uiBusy(false);
    }
  }
};

/*──────── 7) DRAGGABLE + UI CLAMP ────────*/
function makeDraggable(el, storageKey, handleSelector) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  handle.style.cursor = 'move'; handle.style.userSelect = 'none';
  let moving = false, startX=0, startY=0, baseLeft=0, baseTop=0;
  try { const pos = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (pos) { el.style.left = pos.left+'px'; el.style.top = pos.top+'px'; el.style.right='auto'; el.style.bottom='auto'; el.style.position='fixed'; }
  } catch(_) {}
  const down = e => {
    const p = e.touches ? e.touches[0] : e; moving = true;
    const r = el.getBoundingClientRect(); startX=p.clientX; startY=p.clientY; baseLeft=r.left; baseTop=r.top;
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, {passive:false}); document.addEventListener('touchend', up);
    e.preventDefault();
  };
  const move = e => {
    if (!moving) return;
    const p = e.touches ? e.touches[0] : e;
    const nx = Math.min(window.innerWidth - el.offsetWidth - 8, Math.max(8, baseLeft + (p.clientX - startX)));
    const ny = Math.min(window.innerHeight - el.offsetHeight - 8, Math.max(8, baseTop  + (p.clientY - startY)));
    el.style.left = nx+'px'; el.style.top = ny+'px'; el.style.right='auto'; el.style.bottom='auto'; el.style.position='fixed';
    localStorage.setItem(storageKey, JSON.stringify({left:nx, top:ny})); e.preventDefault();
  };
  const up = () => {
    moving = false;
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up);
  };
  handle.addEventListener('mousedown', down); handle.addEventListener('touchstart', down, {passive:false});
}

// Ægte clamp (ingen transform)
function ensureFullyVisible(el, margin = 8) {
  if (!el) return;
  el.style.transform = 'none';
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top  = r.top;
  const w = r.width;
  const h = r.height;
  if (left < margin) left = margin;
  if (top  < margin) top  = margin;
  if (left + w > window.innerWidth  - margin) left = Math.max(margin, window.innerWidth  - margin - w);
  if (top  + h > window.innerHeight - margin) top  = Math.max(margin, window.innerHeight - margin - h);
  el.style.position = 'fixed';
  el.style.left = left + 'px';
  el.style.top  = top  + 'px';
  el.style.right  = 'auto';
  el.style.bottom = 'auto';
}

/*──────── 7) UI (panel + gear + menu) ────────*/
function injectUI() {
  if (document.getElementById('tpPanel')) return;

  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = [
    'position:fixed','top:12px','right:12px','z-index:2147483645',
    'background:#f9f9f9','border:1px solid #ccc','padding:8px 10px',
    'border-radius:6px','font-size:12px','font-family:sans-serif',
    'box-shadow:1px 1px 5px rgba(0,0,0,.2)','width:300px','resize:none'
  ].join(';');
  d.innerHTML =
    '<div id="tpPanelHeader" style="font-weight:700;cursor:move;user-select:none">TP Notifikationer</div>' +
    '<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">' +
      '<label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="m"> <span>Besked (Pushover)</span></label>' +
      '<label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="i"> <span>Interesse (Pushover)</span></label>' +
      // SMS som knap + status
      '<div id="smsRow" style="display:flex;align-items:flex-start;gap:6px;white-space:nowrap">' +
        '<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<strong>SMS</strong>' +
            '<span id="smsTag" style="font-size:11px;color:#666;overflow:hidden;text-overflow:ellipsis;">indlæser…</span>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button id="smsAction" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Aktivér</button>' +
            '<button id="smsRefresh" title="Opdatér status" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">↻</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(d);

  makeDraggable(d, 'tpPanelPos', '#tpPanelHeader');
  ensureFullyVisible(d);

  const m = d.querySelector('#m'), i = d.querySelector('#i');
  m.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  i.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  m.onchange = () => localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false');
  i.onchange = () => localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false');

  // ── SMS UI (knap + status)
  const smsAction  = d.querySelector('#smsAction');
  const smsTag     = d.querySelector('#smsTag');
  const smsRefresh = d.querySelector('#smsRefresh');

  function smsSetBusy(on, text) {
    smsAction.disabled = true;
    smsRefresh.disabled = true;
    if (on) smsTag.textContent = text || 'arbejder…';
  }
  function smsRender(st) {
    const time = new Date().toLocaleTimeString();
    const mark = (txt, color) => {
      smsTag.innerHTML = `<span style="color:${color};font-weight:600">${txt}</span> <span style="color:#888;font-size:11px">• ${time}</span>`;
    };
    smsAction.disabled = false;
    smsRefresh.disabled = false;
    switch (st.state) {
      case 'active':   smsAction.textContent = 'Deaktiver';       mark('Aktiv' + (st.phone ? ' ('+st.phone+')' : ''), '#090'); break;
      case 'inactive': smsAction.textContent = 'Aktivér';         mark('Ikke aktiv' + (st.phone ? ' ('+st.phone+')' : ''), '#a00'); break;
      case 'sys_off':  smsAction.textContent = 'Ikke muligt';     smsAction.disabled = true; mark('System slået fra', '#a00'); break;
      case 'no_mobile':smsAction.textContent = 'Kræver mobilnr.'; smsAction.disabled = true; mark('Manglende mobil på login', '#a00'); break;
      default:         smsAction.textContent = 'Aktivér';         mark('Ukendt', '#666');
    }
  }
  smsRefresh.addEventListener('click', async () => { smsSetBusy(true, 'opdaterer…'); await sms.refresh(smsRender); });
  smsAction.addEventListener('click', async () => {
    const wantOn = (sms._last?.state !== 'active');
    smsSetBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
    await sms.setEnabled(wantOn, smsSetBusy, smsRender);
  });
  (async () => { smsSetBusy(true, 'indlæser…'); await sms.refresh(smsRender); })();

  // ── Tandhjul
  if (!document.getElementById('tpGear')) {
    const gear = document.createElement('div');
    gear.id = 'tpGear'; gear.title = 'Indstillinger'; gear.innerHTML = '⚙️';
    Object.assign(gear.style, {
      position:'fixed',
      width:'22px', height:'22px', lineHeight:'22px', textAlign:'center',
      background:'#fff', border:'1px solid #ccc', borderRadius:'50%',
      boxShadow:'0 1px 5px rgba(0,0,0,.2)', cursor:'pointer',
      zIndex:2147483647, userSelect:'none'
    });
    document.body.appendChild(gear);

    // Placér gear lige under panelet
    const panelRect = d.getBoundingClientRect();
    gear.style.left = (panelRect.right - gear.offsetWidth) + 'px';
    gear.style.top  = (panelRect.bottom + 10) + 'px';
    gear.style.right = 'auto';
    gear.style.bottom = 'auto';
    ensureFullyVisible(gear);
    makeDraggable(gear, 'tpGearPos');

    let menu = null;
    function buildMenu() {
      if (menu) return menu;
      menu = document.createElement('div');
      Object.assign(menu.style, {
        position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
        borderRadius:'8px', boxShadow:'0 2px 12px rgba(0,0,0,.25)', fontSize:'12px',
        fontFamily:'sans-serif', padding:'10px', width:'400px', maxHeight:'70vh', overflow:'auto', display:'none'
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

        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<div style="font-weight:700;margin-bottom:6px">Toast-indstillinger</div>' +
        '<label style="display:block;margin:4px 0"><input type="checkbox" id="tpForceDomToast"> Brug altid skærm-toast (ikke OS-meddelelser)</label>' +
        '<label style="display:block;margin:4px 0"><input type="checkbox" id="tpSmartToast"> Smart toast (DOM når synlig, OS når skjult)</label>' +

        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<div style="font-weight:700;margin-bottom:6px">Telefonbog</div>' +
        '<div style="margin-bottom:6px;font-size:12px;color:#444">CSV ligger i GitHub og bruges af opslag ved indgående kald.</div>' +
        '<div style="margin-bottom:6px">' +
          '<div style="font-weight:600;margin-bottom:4px">GitHub PAT (fine-grained • Contents: RW til repo)</div>' +
          '<input id="tpGitPAT" type="password" placeholder="fine-grained token" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
          '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1"/>' +
            '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>' +
          '</div>' +
          '<div id="tpCSVDrop" style="margin-top:8px;padding:10px;border:2px dashed #ccc;border-radius:6px;text-align:center;color:#666">Eller træk & slip CSV her</div>' +
          '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<button id="tpFetchCSVUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⚡ Hent Excel → CSV + Upload</button>' +
          '</div>' +
          '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<input id="tpTestPhone" type="text" placeholder="Test nummer (fx 22 44 66 88)" style="flex:1;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
            '<button id="tpLookupPhone" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Slå op i CSV</button>' +
          '</div>' +
          '<div id="tpPBHint" style="margin-top:6px;font-size:11px;color:#666"></div>' +
        '</div>' +

        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🔄 Søg efter opdatering</button>' +
        '<div style="margin-top:6px;font-size:11px;color:#666">Kører v.'+TP_VERSION+'</div>';
      document.body.appendChild(menu);

      // Pushover-token
      const inp  = menu.querySelector('#tpUserKeyMenu');
      const save = menu.querySelector('#tpSaveUserKeyMenu');
      inp.value = getUserKey();
      save.addEventListener('click', () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showToast('USER-token gemt.'); });
      inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); GM_setValue('tpUserKey',(inp.value||'').trim()); showToast('USER-token gemt.'); }});

      // Toast toggles (gensidigt udelukkende)
      const forceDom = menu.querySelector('#tpForceDomToast');
      const smart    = menu.querySelector('#tpSmartToast');
      forceDom.checked = localStorage.getItem('tpForceDOMToast') === 'true';
      smart.checked    = localStorage.getItem('tpSmartToast') === 'true';
      const syncToggles = (src) => {
        if (src === 'force' && forceDom.checked) { smart.checked = false; localStorage.setItem('tpSmartToast','false'); }
        if (src === 'smart' && smart.checked)   { forceDom.checked = false; localStorage.setItem('tpForceDOMToast','false'); }
      };
      forceDom.onchange = () => { localStorage.setItem('tpForceDOMToast', forceDom.checked ? 'true' : 'false'); syncToggles('force'); };
      smart.onchange    = () => { localStorage.setItem('tpSmartToast',    smart.checked    ? 'true' : 'false'); syncToggles('smart'); };

      // Telefonbog widgets
      const pat   = menu.querySelector('#tpGitPAT');
      const file  = menu.querySelector('#tpCSVFile');
      const up    = menu.querySelector('#tpUploadCSV');
      const csvUp = menu.querySelector('#tpFetchCSVUpload');
      const tIn   = menu.querySelector('#tpTestPhone');
      const tBtn  = menu.querySelector('#tpLookupPhone');
      const pbh   = menu.querySelector('#tpPBHint');
      const drop  = menu.querySelector('#tpCSVDrop');

      pat.value = (GM_getValue('tpGitPAT') || '');
      pat.addEventListener('change', () => GM_setValue('tpGitPAT', pat.value || ''));

      async function uploadCSVText(text) {
        try {
          const token = (pat.value||'').trim(); if (!token) { showToast('Indsæt GitHub PAT først.'); return; }
          const base64 = b64encodeUtf8(text);
          pbh.textContent = 'Uploader CSV…';
          const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
          await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: upload CSV via TM', sha, PB_BRANCH);
          GM_setValue(CACHE_KEY_CSV, text);
          pbh.textContent = 'CSV uploadet. RAW opdateres om få sek.';
          showToast('CSV uploadet.');
        } catch (e) { console.warn('[TP][PB][CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved CSV upload.'; showToast('Fejl – se konsol.'); }
      }
      up.addEventListener('click', async () => {
        try { if (!file.files || !file.files[0]) { showToast('Vælg en CSV-fil først.'); return; }
              const text = await file.files[0].text(); await uploadCSVText(text); } catch (e) { console.warn('[TP][PB][CSV-UPLOAD-BTN]', e); }
      });
      function setDropActive(on) { drop.style.borderColor = on ? '#2e7' : '#ccc'; drop.style.color = on ? '#2e7' : '#666'; }
      drop.addEventListener('dragover', e => { e.preventDefault(); setDropActive(true); });
      drop.addEventListener('dragenter', e => { e.preventDefault(); setDropActive(true); });
      drop.addEventListener('dragleave', e => { e.preventDefault(); setDropActive(false); });
      drop.addEventListener('drop', async e => {
        e.preventDefault(); setDropActive(false);
        const dt = e.dataTransfer; if (!dt || !dt.files || !dt.files[0]) return;
        const f = dt.files[0]; if (!/\.csv$/i.test(f.name)) { showToast('Træk en .csv-fil ind.'); return; }
        const text = await f.text(); await uploadCSVText(text);
      });

      csvUp.addEventListener('click', async () => {
        try { pbh.textContent = 'Henter Excel (GET/POST), vælger bedste ark og uploader CSV …';
              const t0 = Date.now(); await fetchExcelAsCSVAndUpload();
              pbh.textContent = `Færdig på ${Date.now()-t0} ms.`; }
        catch (e) { console.warn('[TP][PB][EXCEL→CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel→CSV upload.'; showToast('Fejl – se konsol.'); }
      });

      tBtn.addEventListener('click', async () => {
        try {
          const raw = (tIn.value||'').trim(); const p8 = normPhone(raw);
          if (!p8) { pbh.textContent = 'Ugyldigt nummer.'; return; }
          pbh.textContent = 'Slår op i CSV…';
          let csv = ''; try { csv = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now()); if (csv) GM_setValue(CACHE_KEY_CSV, csv); } catch(_) {}
          if (!csv) csv = GM_getValue(CACHE_KEY_CSV) || '';
          const { map } = parsePhonebookCSV(csv);
          const rec = map.get(p8);
          if (!rec) { pbh.textContent = `Ingen match for ${p8}.`; return; }
          pbh.textContent = `Match: ${p8} → ${rec.name || '(uden navn)'} (vikar_id=${rec.id})`;
          const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
          window.open(url, '_blank', 'noopener');
        } catch(e) { console.warn('[TP][PB][LOOKUP]', e); pbh.textContent = 'Fejl ved opslag.'; }
      });

      // Update-check
      const chk = menu.querySelector('#tpCheckUpdate');
      chk.addEventListener('click', async () => {
        try {
          const raw = await gmGET(SCRIPT_RAW_URL + '?t=' + Date.now());
          const m = raw.match(/@version\s+([0-9.]+)/);
          if (!m) { showToast('Kunne ikke læse remote version.'); return; }
          const remote = m[1];
          if (remote === TP_VERSION) showToast('Du kører allerede nyeste version ('+remote+').');
          else { showToast('Ny version tilgængelig: '+remote+' (du kører '+TP_VERSION+'). Åbner opdatering…'); window.open(SCRIPT_RAW_URL, '_blank'); }
        } catch(_) { showToast('Update-tjek fejlede.'); }
      });

      return menu;
    }

    function positionMenu(menu, gear) {
      // midlertidigt synlig for at måle
      const oldDisp = menu.style.display;
      const oldVis  = menu.style.visibility;
      menu.style.visibility = 'hidden';
      menu.style.display = 'block';

      const gr = gear.getBoundingClientRect();
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;

      // Primært under gear
      let left = Math.round(gr.right - mw);
      let top  = Math.round(gr.bottom + 8);

      // Hvis ikke plads → placer over
      if (top + mh > window.innerHeight - 8) {
        top = Math.round(gr.top - mh - 8);
      }

      // Clamp
      if (left < 8) left = 8;
      if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - mw);
      if (top < 8) top = 8;

      Object.assign(menu.style, { position:'fixed', left:left+'px', top:top+'px', right:'auto', bottom:'auto' });

      // gendan synlighed
      menu.style.visibility = oldVis || 'visible';
      menu.style.display    = oldDisp || 'block';
    }

    function toggleMenu() {
      const mnu = buildMenu();
      if (mnu.style.display === 'block') {
        mnu.style.display = 'none';
        return;
      }
      mnu.style.display = 'block';
      positionMenu(mnu, gear);
    }
    gear.addEventListener('click', toggleMenu);

    // Luk menu ved klik udenfor
    document.addEventListener('mousedown', e => {
      const m = menu; if (m && m.style.display === 'block' && e.target !== m && !m.contains(e.target) && e.target !== gear) m.style.display = 'none';
    });

    // Hold UI på skærmen ved resize
    window.addEventListener('resize', () => {
      ensureFullyVisible(d);
      ensureFullyVisible(gear);
      if (menu && menu.style.display === 'block') {
        positionMenu(menu, gear);
      }
    });
  }
}

/* Test-knap */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  sendPushover('🧪 [TEST] Besked-kanal OK — ' + ts);
  setTimeout(() => sendPushover('🧪 [TEST] Interesse-kanal OK — ' + ts), 800);
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
console.info('[TP] kører version', TP_VERSION);

/*──────── 9) HOVER “Intet Svar” ────────*/
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
