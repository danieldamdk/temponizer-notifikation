// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" + Telefonbog (AjourCare)
// @namespace    ajourcare.dk
// @version      7.0
// @description  Push (beskeder+interesse) med cross-tab leader + BroadcastChannel, adaptiv/visibility-aware poll, push-dedupe, retry/backoff. Caller-pop fra telefonbog (Excel→CSV→GitHub, lazy XLSX). Daglig autosync, dubletdetektion, badges, quiet hours, log, drag&drop, update-check, PAT-test. Hover “Intet Svar” autogem.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addElement
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      ajourcare.temponizer.dk
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// ==/UserScript==

/*──────────────── 0) UTIL & LOG ───────────────*/
const TP_VER = '7.0';
const LOG_MAX = 80;
const _logBuf = [];
function tpLog(level, ...args){
  const ts = new Date().toLocaleTimeString();
  _logBuf.push(`[${ts}] ${level}: ${args.map(a=> (typeof a==='string'?a:JSON.stringify(a)).slice(0,400)).join(' ')}`);
  if (_logBuf.length > LOG_MAX) _logBuf.shift();
  try { console[level]?.apply(console, args); } catch(_) { console.log(...args); }
}
function getLogText(){ return _logBuf.join('\n'); }
function copyLog(){ navigator.clipboard?.writeText(getLogText()).then(()=>showToast('Log kopieret.')); }

/*──────────────── 1) KONFIG ───────────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7'; // ADMIN-FASTLÅST
const POLL_ACTIVE_MS   = 15000;  // når fanen er aktiv
const POLL_HIDDEN_MS   = 45000;  // når fanen er skjult
const POLL_IDLE_MS_MAX = 60000;  // adaptiv max
const SUPPRESS_MS = 45000;
const LOCK_MS     = SUPPRESS_MS + 5000;

// Cross-tab leader
const LEADER_KEY = 'tpLeaderV1';
const HEARTBEAT_MS = 5000;
const LEASE_MS     = 15000;
const TAB_ID = (crypto?.randomUUID?.() || ('tab-' + Math.random().toString(36).slice(2) + Date.now()));
const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('tpLeader') : null;

// Telefonbog (GitHub)
const PB_OWNER  = 'danieldamdk';
const PB_REPO   = 'temponizer-notifikation';
const PB_BRANCH = 'main';
const PB_CSV    = 'vikarer.csv';
const PB_XLSX   = 'vikarer.xlsx';
const RAW_PHONEBOOK = `https://raw.githubusercontent.com/${PB_OWNER}/${PB_REPO}/${PB_BRANCH}/${PB_CSV}`;

/* MIGRATION: USER-token fra localStorage → GM storage */
(function migrateUserKeyToGM(){
  try {
    const gm = (GM_getValue('tpUserKey') || '').trim();
    if (!gm) {
      const ls = (localStorage.getItem('tpUserKey') || '').trim();
      if (ls) { GM_setValue('tpUserKey', ls); localStorage.removeItem('tpUserKey'); tpLog('info','[MIGRATE] USER-token LS→GM'); }
    }
  } catch(_) {}
})();

/*──────────────── 2) QUIET HOURS ───────────────*/
function getQuietCfg(){
  const on   = GM_getValue('tpQuietOn') === true;
  const from = GM_getValue('tpQuietFrom') || '22:00';
  const to   = GM_getValue('tpQuietTo')   || '06:00';
  return { on, from, to };
}
function isQuietNow(){
  const { on, from, to } = getQuietCfg();
  if (!on) return false;
  const now = new Date();
  const toMin   = (s)=>{ const [h,m]=s.split(':').map(x=>+x||0); return h*60+m; };
  const nMin = now.getHours()*60 + now.getMinutes();
  const f = toMin(from), t = toMin(to);
  if (f <= t) return (nMin >= f && nMin < t);
  // spænder over midnat
  return (nMin >= f || nMin < t);
}

/*──────────────── 3) TOAST ───────────────*/
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

/*──────────────── 4) NETWORK HELPERS ───────────────*/
function withRetry(fn, { tries=3, delays=[2000, 5000, 10000] } = {}){
  return (...args) => new Promise((resolve,reject)=>{
    let attempt = 0;
    const run = () => {
      fn(...args).then(resolve).catch(err=>{
        attempt++;
        if (attempt >= tries) return reject(err);
        const delay = delays[Math.min(attempt-1, delays.length-1)];
        tpLog('warn', '[retry]', attempt, '→', delay, 'ms', String(err && err.message || err));
        setTimeout(run, delay);
      });
    };
    run();
  });
}
function gmGET(url, headers={}) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, headers,
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function gmGETArrayBuffer(url, headers={}) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, headers, responseType: 'arraybuffer',
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function gmPOSTArrayBuffer(url, body, headers={}) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST', url, data: body, headers, responseType: 'arraybuffer',
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.response) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}

/*──────────────── 5) PUSHOVER (dedupe+quiet+retry) ───────────────*/
function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
const seenPush = new Map(); // key → ts
function pushDedupeKey(msg){ return msg.replace(/\s+/g,' ').trim(); }
const _sendPushoverRaw = (msg) => new Promise((resolve, reject)=>{
  const userKey = getUserKey();
  if (!PUSHOVER_TOKEN || !userKey) { showToast('Pushover ikke konfigureret – indsæt USER-token i ⚙️.'); return reject(new Error('no creds')); }
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) + '&user=' + encodeURIComponent(userKey) + '&message=' + encodeURIComponent(msg);
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
    onload: r => (r.status>=200 && r.status<300) ? resolve() : reject(new Error('HTTP '+r.status)),
    onerror: e => reject(e)
  });
});
const sendPushover = withRetry(async (msg)=>{
  if (isQuietNow()){ tpLog('info','[quiet] skip pushover:', msg); return; }
  const k = pushDedupeKey(msg);
  const last = seenPush.get(k) || 0;
  if (Date.now() - last < 60000) { tpLog('info','[dedupe] push skip', msg); return; }
  await _sendPushoverRaw(msg);
  seenPush.set(k, Date.now());
});

/*──────────────── 6) STATE, LOCK & LEADER ───────────────*/
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

function now() { return Date.now(); }
function getLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (_) { return null; } }
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); bc?.postMessage({ type:'leader:update', obj }); }
function isLeader() { const L = getLeader(); return !!(L && L.id === TAB_ID && L.until > now()); }
function tryBecomeLeader() {
  const L = getLeader(), t = now();
  if (!L || (L.until||0) <= t) {
    setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t });
    if (isLeader()) tpLog('info','[LEADER] denne fane er nu leader:', TAB_ID);
  }
}
function heartbeatIfLeader() { if (!isLeader()) return; const t = now(); setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); }
window.addEventListener('storage', e => { if (e.key === LEADER_KEY) {/*noop*/} });
bc?.addEventListener('message', ev => {
  if (ev.data?.type === 'leader:update') { /* no-op, just awareness */ }
});

/*──────────────── 7) MESSAGES/INTEREST POLLING (ETag, adaptiv, badges) ───────────────*/
let msgETag = localStorage.getItem('tpMsgETag') || null;
let msgLM   = localStorage.getItem('tpMsgLM')   || null;

let msgBadgeEl = null, intBadgeEl = null;
let msgIdleHits = 0, intIdleHits = 0;

function getPollMs(){
  const visible = document.visibilityState === 'visible';
  const base = visible ? POLL_ACTIVE_MS : POLL_HIDDEN_MS;
  const idleBoost = Math.min((msgIdleHits+intIdleHits)*3000, POLL_IDLE_MS_MAX - base);
  return base + idleBoost;
}

async function pollMessages(){
  if (!isLeader()) return;
  try {
    const headers = { 'Accept':'application/json' };
    if (msgETag) headers['If-None-Match'] = msgETag;
    if (msgLM)   headers['If-Modified-Since'] = msgLM;
    const resTxt = await gmGET(MSG_URL + '&ts=' + Date.now(), headers).catch(async e=>{
      // hvis 304 → GM_xmlhttpRequest kaster ikke, så håndterer vi nede i parse
      throw e;
    });
    // Nogle gateways returnerer blankt ved 304; håndter med try/catch
    let d = null;
    try { d = JSON.parse(resTxt || 'null'); } catch(_){ d=null; }
    const et = null; // GM giver ikke headers her; ETag/LM opsættes kun når vi får body via fetch? (begrænset via GM)
    // Fallback uden 304: opdater counts
    const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0});
    const n  = d ? MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0) : stMsg.count;
    const en = localStorage.getItem('tpPushEnableMsg') === 'true';

    if (typeof n === 'number') {
      if (msgBadgeEl) msgBadgeEl.textContent = String(n);
      if (d && n > stMsg.count && n !== stMsg.lastSent) {
        const canPush = (Date.now() - stMsg.lastPush > SUPPRESS_MS) && takeLock();
        if (canPush) {
          const m = '🔔 Du har nu ' + n + ' ulæst(e) Temponizer-besked(er).';
          if (en) await sendPushover(m); showToastOnce('msg', m);
          stMsg.lastPush = Date.now(); stMsg.lastSent = n; msgIdleHits = 0;
        } else stMsg.lastSent = n;
      } else if (d && n < stMsg.count) { stMsg.lastPush = 0; }
      stMsg.count = n; saveJsonIfLeader(ST_MSG_KEY, stMsg);
    } else {
      msgIdleHits = Math.min(msgIdleHits+1, 20);
    }
    tpLog('info','[MSG]', loadJson(ST_MSG_KEY,{}).count, new Date().toLocaleTimeString());
  } catch(e) {
    tpLog('warn','[MSG][ERR]', e);
  }
}

const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETag = localStorage.getItem('tpLastETag') || null;

async function pollInterest(){
  if (!isLeader()) return;
  try {
    const h = await new Promise((resolve, reject)=>{
      GM_xmlhttpRequest({
        method: 'HEAD', url: HTML_URL, headers: lastETag ? { 'If-None-Match': lastETag } : {},
        onload: r => resolve({ status:r.status, headers:r.responseHeaders||'' }),
        onerror: e => reject(e)
      });
    });
    if (h.status === 304) { tpLog('info','[INT] 304 uændret'); intIdleHits = Math.min(intIdleHits+1, 20); return; }
    // GET 20kB
    const html = await gmGET(HTML_URL, { Range:'bytes=0-20000' });
    const doc   = new DOMParser().parseFromString(html, 'text/html');
    const boxes = Array.prototype.slice.call(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    const c = boxes.reduce((s, el) => { const v = parseInt(el.textContent.trim(), 10); return s + (isNaN(v) ? 0 : v); }, 0);

    const stInt = loadJson(ST_INT_KEY, {count:0,lastPush:0,lastSent:0});
    const en = localStorage.getItem('tpPushEnableInt') === 'true';
    if (intBadgeEl) intBadgeEl.textContent = String(c);

    if (c > stInt.count && c !== stInt.lastSent) {
      if (Date.now() - stInt.lastPush > SUPPRESS_MS && takeLock()) {
        const m = '👀 ' + c + ' vikar(er) har vist interesse for ledige vagter';
        if (en) await sendPushover(m); showToastOnce('int', m);
        stInt.lastPush = Date.now(); stInt.lastSent = c; intIdleHits = 0;
      } else stInt.lastSent = c;
    } else if (c < stInt.count) stInt.lastPush = 0;

    stInt.count = c; saveJsonIfLeader(ST_INT_KEY, stInt);
    tpLog('info','[INT]', c, new Date().toLocaleTimeString());
  } catch(e) {
    tpLog('warn','[INT][ERR]', e);
  }
}

/* Adaptiv scheduling */
let _msgTimer = null, _intTimer = null;
function schedulePollers(){
  clearTimeout(_msgTimer); clearTimeout(_intTimer);
  const ms = getPollMs();
  _msgTimer = setTimeout(async ()=>{ await pollMessages(); schedulePollers(); }, ms);
  _intTimer = setTimeout(async ()=>{ await pollInterest(); schedulePollers(); }, ms+500);
}
document.addEventListener('visibilitychange', schedulePollers);

/*──────────────── 8) XLSX LAZY-LOAD + EXCEL→CSV ───────────────*/
let _xlsxReady = null;
function ensureXLSX(){
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (_xlsxReady) return _xlsxReady;
  const url = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  _xlsxReady = new Promise((resolve,reject)=>{
    GM_xmlhttpRequest({
      method:'GET', url,
      onload: r => {
        try { (0,eval)(r.responseText); if (typeof XLSX === 'undefined') throw new Error('XLSX not loaded'); resolve(); }
        catch(e){ reject(e); }
      },
      onerror: reject
    });
  });
  return _xlsxReady;
}
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin);
}
function b64encodeBytes(u8) {
  let bin=''; for (let i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]); return btoa(bin);
}
const ghGetSha = withRetry((owner, repo, path, ref) => new Promise((resolve, reject) => {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
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
}));
const ghPutFile = withRetry((owner, repo, path, base64Content, message, sha, branch) => new Promise((resolve, reject) => {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const token = (GM_getValue('tpGitPAT') || '').trim();
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
}));

/* CSV parse + dubletdetektion */
function normPhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
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
function parsePhonebookCSV(text) {
  const map = new Map(); const dups = new Map();
  const rows = parseCSV(text);
  if (!rows.length) return { map, dups };

  const header = rows[0].map(h => h.toLowerCase());
  const idxId   = header.findIndex(h => /(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));
  const idxName = header.findIndex(h => /(navn|name)/.test(h));
  const phoneCols = header
    .map((h, idx) => ({ h, idx }))
    .filter(x => /(telefon|mobil|cellphone|mobile|phone)/.test(x.h));

  if (idxId < 0 || phoneCols.length === 0) return { map, dups };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id   = (row[idxId]   || '').trim();
    const name = idxName >= 0 ? (row[idxName] || '').trim() : '';
    if (!id) continue;
    for (const pc of phoneCols) {
      const val = (row[pc.idx] || '').trim();
      const p8 = normPhone(val);
      if (!p8) continue;
      if (map.has(p8) && map.get(p8).id !== id) {
        const list = dups.get(p8) || new Set([ map.get(p8).id ]);
        list.add(id); dups.set(p8, list);
      }
      map.set(p8, { id, name });
    }
  }
  return { map, dups };
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
    tpLog('info','[PB] Sheet:', name, 'rows:', dataRows);
    if (dataRows > best.rows) best = { rows: dataRows, csv };
  }
  return best.rows >= 1 ? best.csv : null;
}
async function tryExcelGET(params) {
  const url = `${location.origin}/index.php?page=print_vikar_list_custom_excel&sortBy=&${params}`;
  return gmGETArrayBuffer(url, {
    'Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel;q=0.9,*/*;q=0.8',
    'Referer': location.href
  });
}
async function tryExcelPOST(params) {
  const url = `${location.origin}/index.php?page=print_vikar_list_custom_excel`;
  return gmPOSTArrayBuffer(url, params, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel;q=0.9,*/*;q=0.8',
    'Referer': location.href
  });
}
async function fetchExcelAsCSVText() {
  await ensureXLSX();
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
      lastInfo = 'sheets header-only';
    } catch (e) {
      tpLog('warn','[PB] Excel hentning fejlede:', e);
      lastInfo = String(e && e.message || e);
    }
  }
  tpLog('warn','[PB] Excel→CSV mislykkedes. Sidste info:', lastInfo);
  return null;
}
async function fetchExcelAsCSVAndUpload() {
  const text = await fetchExcelAsCSVText();
  if (!text) { showToastOnce('csv','Ingen rækker fra Temponizer – beholdt eksisterende CSV.'); return; }
  const lines = (text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) { showToastOnce('csv','Kun header – beholdt eksisterende CSV.'); return; }
  const base64 = b64encodeUtf8(text);
  const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
  await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: Excel→CSV via TM (auto)', sha, PB_BRANCH);
  showToastOnce('csvok','CSV uploadet (Excel→CSV).');
}
async function fetchExcelAndUploadRawXLSX() {
  await ensureXLSX(); // ikke strengt nødvendigt, men god no-op
  const url = `${location.origin}/index.php?page=print_vikar_list_custom_excel&id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag&sortBy=`;
  const ab = await gmGETArrayBuffer(url, {
    'Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel;q=0.9,*/*;q=0.8',
    'Referer': location.href
  });
  const u8 = new Uint8Array(ab);
  const b64 = b64encodeBytes(u8);
  const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_XLSX, PB_BRANCH);
  await ghPutFile(PB_OWNER, PB_REPO, PB_XLSX, b64, 'sync: server Excel → vikarer.xlsx via TM', sha, PB_BRANCH);
}

/* Daglig autosync (06:05 guard + rate-limit) */
function todayStr(){ const d=new Date(); const m=(n)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${m(d.getMonth()+1)}-${m(d.getDate())}`; }
async function autoSyncIfDue(pbhEl){
  try {
    const now = new Date();
    const hhmm = now.getHours()*60 + now.getMinutes();
    const cutoff = 6*60 + 5; // 06:05
    const lastDay = GM_getValue('tpPBLastSyncDay') || '';
    const onVikarList = /page=vikarlist/.test(location.search);
    if (onVikarList || ((todayStr() !== lastDay) && hhmm >= cutoff)) {
      pbhEl && (pbhEl.textContent = 'Auto-sync: Henter Excel → CSV …');
      await fetchExcelAsCSVAndUpload();
      GM_setValue('tpPBLastSyncDay', todayStr());
      pbhEl && (pbhEl.textContent = 'Auto-sync færdig.');
    }
  } catch(e) { tpLog('warn','[PB][AUTO]', e); }
}

/*──────────────── 9) CALLER-POP (kun INBOUND) ───────────────*/
let _lastPopAt = 0;
async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const raw = q.get('tp_caller'); if (!raw) return;
    const dir = (q.get('tp_dir') || '').toLowerCase();
    // Kun indgående: dir=in ELLER *1500 suffix
    const cleaned = String(raw).replace(/\*1500$/, '');
    const inbound = (dir === 'in') || /\*1500$/.test(String(raw));
    if (!inbound) { tpLog('info','[CALLER] Outbound/ukendt → abort'); return; }

    // throttle (dobbelte events)
    if (Date.now() - _lastPopAt < 3000) { tpLog('info','[CALLER] throttled'); return; }
    _lastPopAt = Date.now();

    const phone8 = normPhone(cleaned);
    if (!phone8) { showToast('Ukendt nummer: ' + raw); return; }

    const csv = await gmGET(RAW_PHONEBOOK);
    const { map } = parsePhonebookCSV(csv);
    const rec = map.get(phone8);
    if (!rec) { tpLog('info','[CALLER] Ingen match for', phone8); return; }

    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    showToast(`Åbner vikar: ${rec.name || 'ukendt navn'} (${rec.id})`);
    location.assign(url);
  } catch (e) { tpLog('warn','[CALLER][ERR]', e); showToast('Kan ikke hente telefonbog.'); }
}

/*──────────────── 10) UI (panel + gear, badges, drag, update, PAT-test) ───────────────*/
function makeBadge(){
  const sp = document.createElement('span');
  Object.assign(sp.style,{
    display:'inline-block', minWidth:'16px', padding:'0 5px', marginLeft:'6px',
    borderRadius:'10px', background:'#eee', border:'1px solid #ccc', textAlign:'center'
  });
  sp.textContent = '0';
  return sp;
}
function draggable(el, key){
  el.style.cursor = 'move';
  let sx=0, sy=0, ox=0, oy=0, moving=false;
  const pos = JSON.parse(localStorage.getItem(key) || 'null');
  if (pos) { el.style.left=pos.left; el.style.top=pos.top; el.style.right=''; el.style.bottom=''; el.style.position='fixed'; }
  el.addEventListener('mousedown', (e)=>{
    if (e.button!==0) return;
    moving=true; sx=e.clientX; sy=e.clientY;
    const r = el.getBoundingClientRect(); ox=r.left; oy=r.top;
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  function move(e){
    if (!moving) return;
    const nx = ox + (e.clientX - sx);
    const ny = oy + (e.clientY - sy);
    el.style.position='fixed';
    el.style.left = Math.max(6, Math.min(window.innerWidth - el.offsetWidth - 6, nx)) + 'px';
    el.style.top  = Math.max(6, Math.min(window.innerHeight - el.offsetHeight - 6, ny)) + 'px';
  }
  function up(){
    moving=false;
    localStorage.setItem(key, JSON.stringify({ left: el.style.left, top: el.style.top }));
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
  }
}

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

  // Badges
  const lbls = d.querySelectorAll('label');
  msgBadgeEl = makeBadge(); intBadgeEl = makeBadge();
  lbls[0].appendChild(msgBadgeEl); lbls[1].appendChild(intBadgeEl);

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

  // Draggable
  draggable(d, 'tpPosPanel');
  draggable(gear, 'tpPosGear');

  // Gear-menu
  let menu = null;
  function buildMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, {
      position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
      borderRadius:'8px', boxShadow:'0 2px 12px rgba(0,0,0,.25)', fontSize:'12px',
      fontFamily:'sans-serif', padding:'10px', width:'420px'
    });
    menu.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>' +
      // Pushover
      '<div style="margin-bottom:10px">' +
        '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
        '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<button id="tpSaveUserKeyMenu" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Gem</button>' +
          '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Guide til USER-token</a>' +
        '</div>' +
      '</div>' +
      // Quiet hours
      '<div style="border-top:1px solid #eee;margin:8px 0"></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<label><input type="checkbox" id="tpQuietOn"> Quiet hours</label>' +
        '<label>Fra <input type="time" id="tpQuietFrom" value="22:00"></label>' +
        '<label>Til <input type="time" id="tpQuietTo" value="06:00"></label>' +
      '</div>' +
      // Test push
      '<div style="border-top:1px solid #eee;margin:8px 0"></div>' +
      '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>' +
      '<div id="tpLeaderHint" style="margin-top:6px;font-size:11px;color:#666"></div>' +
      // Telefonbog sektion
      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<div style="font-weight:700;margin-bottom:6px">Telefonbog (admin)</div>' +
      '<div style="margin-bottom:6px;font-size:12px;color:#444">Repo: '+PB_OWNER+'/'+PB_REPO+' • Branch: '+PB_BRANCH+' • Filer: '+PB_CSV+' / '+PB_XLSX+'</div>' +
      '<div style="margin-bottom:6px">' +
        '<div style="font-weight:600;margin-bottom:4px">GitHub PAT (fine-grained; Contents: Read/Write til repo)</div>' +
        '<input id="tpGitPAT" type="password" placeholder="ghp_… eller fine-grained" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1"/>' +
          '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>' +
          '<button id="tpPATTest" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">PAT-helbredstjek</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<button id="tpFetchCSVUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⚡ Hent Excel → CSV + Upload</button>' +
          '<button id="tpFetchExcelUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⬇️ Hent Excel + Upload (XLSX)</button>' +
          '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">🔎 Check for opdatering</button>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<input id="tpTestPhone" type="text" placeholder="Test nummer (fx 22 44 66 88)" style="flex:1;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
          '<button id="tpLookupPhone" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Slå op i CSV</button>' +
        '</div>' +
        '<div id="tpPBHint" style="margin-top:6px;font-size:11px;color:#666"></div>' +
      '</div>' +
      // Log
      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><div style="font-weight:700">Log</div><div><button id="tpCopyLog" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Kopiér</button></div></div>' +
      '<textarea id="tpLogArea" style="width:100%;height:120px;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px;font-family:ui-monospace,monospace;font-size:11px" readonly></textarea>';
    document.body.appendChild(menu);

    const inp  = menu.querySelector('#tpUserKeyMenu');
    const save = menu.querySelector('#tpSaveUserKeyMenu');
    const test = menu.querySelector('#tpTestPushoverBtn');
    const hint = menu.querySelector('#tpLeaderHint');
    const quietOn = menu.querySelector('#tpQuietOn');
    const quietFrom = menu.querySelector('#tpQuietFrom');
    const quietTo = menu.querySelector('#tpQuietTo');

    inp.value = getUserKey();
    const qc = getQuietCfg();
    quietOn.checked = qc.on; quietFrom.value = qc.from; quietTo.value = qc.to;

    function refreshLeaderHint(){
      hint.textContent = (isLeader() ? 'Denne fane er LEADER for push.' : 'Ikke leader – en anden fane sender push.');
    }
    refreshLeaderHint();

    save.addEventListener('click', () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showToast('USER-token gemt.'); });
    inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); GM_setValue('tpUserKey',(inp.value||'').trim()); showToast('USER-token gemt.'); }});

    quietOn.addEventListener('change', ()=> GM_setValue('tpQuietOn', quietOn.checked===true));
    quietFrom.addEventListener('change', ()=> GM_setValue('tpQuietFrom', quietFrom.value||'22:00'));
    quietTo.addEventListener('change',   ()=> GM_setValue('tpQuietTo', quietTo.value||'06:00'));

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
    const patTest = menu.querySelector('#tpPATTest');
    const chkUpd  = menu.querySelector('#tpCheckUpdate');

    const logArea = menu.querySelector('#tpLogArea');
    const copyBtn = menu.querySelector('#tpCopyLog');
    const refreshLog = ()=>{ logArea.value = getLogText(); logArea.scrollTop = logArea.scrollHeight; };
    refreshLog();
    copyBtn.addEventListener('click', copyLog);

    pat.value = (GM_getValue('tpGitPAT') || '');
    pat.addEventListener('change', () => GM_setValue('tpGitPAT', pat.value || ''));

    up.addEventListener('click', async () => {
      try {
        const token = (pat.value||'').trim(); if (!token) { showToast('Indsæt GitHub PAT først.'); return; }
        if (!file.files || !file.files[0]) { showToast('Vælg en CSV-fil først.'); return; }
        const text = await file.files[0].text();
        const base64 = b64encodeUtf8(text);
        pbh.textContent = 'Uploader CSV…';
        const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
        await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: upload CSV via TM', sha, PB_BRANCH);
        pbh.textContent = 'CSV uploadet. RAW opdateres om få sek.'; showToast('CSV uploadet.');
      } catch (e) { tpLog('warn','[PB][CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved CSV upload.'; showToast('Fejl – se konsol.'); }
    });

    csvUp.addEventListener('click', async () => {
      try {
        pbh.textContent = 'Henter Excel (GET/POST), vælger bedste ark og uploader CSV …';
        const t0 = Date.now();
        await fetchExcelAsCSVAndUpload();
        const ms = Date.now()-t0;
        pbh.textContent = `Færdig på ${ms} ms.`;
      } catch (e) { tpLog('warn','[PB][EXCEL→CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel→CSV upload.'; showToast('Fejl – se konsol.'); }
    });

    exUp.addEventListener('click', async () => {
      try {
        pbh.textContent = 'Henter Excel fra server …';
        const t0 = Date.now();
        await fetchExcelAndUploadRawXLSX();
        const ms = Date.now()-t0;
        pbh.textContent = `Excel uploadet som ${PB_XLSX} (${ms} ms).`;
        showToast('Excel uploadet (komplet liste).');
      } catch (e) { tpLog('warn','[PB][EXCEL-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel upload.'; showToast('Fejl – se konsol.'); }
    });

    // PAT-helbredstjek
    patTest.addEventListener('click', async ()=>{
      try {
        const token = (pat.value||'').trim(); if (!token) { showToast('Indsæt PAT først.'); return; }
        const headers = { 'Accept':'application/vnd.github+json', 'Authorization':'Bearer '+token, 'X-GitHub-Api-Version':'2022-11-28' };
        const rl = await new Promise((res,rej)=>GM_xmlhttpRequest({ method:'GET', url:'https://api.github.com/rate_limit', headers, onload:r=>res(r), onerror:rej }));
        const repo = await new Promise((res,rej)=>GM_xmlhttpRequest({ method:'GET', url:`https://api.github.com/repos/${PB_OWNER}/${PB_REPO}`, headers, onload:r=>res(r), onerror:rej }));
        if (rl.status===200 && repo.status===200) { pbh.textContent = 'PAT OK – adgang til repo og rate limit aktiv.'; showToast('PAT OK'); }
        else { pbh.textContent = `PAT problem: rate=${rl.status} repo=${repo.status}`; showToast('PAT problem – se konsol.'); }
      } catch(e){ tpLog('warn','[PAT-TEST]', e); showToast('PAT test fejlede.'); }
    });

    // TEST lookup + dubletinfo
    tBtn.addEventListener('click', async () => {
      try {
        const raw = (tIn.value||'').trim();
        const p8 = normPhone(raw);
        if (!p8) { pbh.textContent = 'Ugyldigt nummer.'; return; }
        pbh.textContent = 'Slår op i CSV…';
        const csv = await gmGET(RAW_PHONEBOOK);
        const { map, dups } = parsePhonebookCSV(csv);
        const rec = map.get(p8);
        if (!rec) { pbh.textContent = `Ingen match for ${p8}.`; return; }
        const dupInfo = dups.has(p8) ? ` • DUBLET: ${Array.from(dups.get(p8)).join(', ')}` : '';
        pbh.textContent = `Match: ${p8} → ${rec.name || '(uden navn)'} (vikar_id=${rec.id})${dupInfo}`;
        const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
        window.open(url, '_blank', 'noopener');
      } catch(e) { tpLog('warn','[PB][LOOKUP]', e); pbh.textContent = 'Fejl ved opslag.'; }
    });

    // Update-check
    chkUpd.addEventListener('click', async ()=>{
      try {
        const raw = await gmGET('https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js');
        const m = raw.match(/@version\s+([0-9.]+)/);
        if (!m) { showToast('Kunne ikke læse version.'); return; }
        const latest = m[1]; const cur = TP_VER;
        if (latest !== cur) showToast(`Ny version ${latest} tilgængelig. Tampermonkey opdaterer snart – eller opdater manuelt.`);
        else showToast(`Du kører seneste version (${cur}).`);
      } catch(e){ showToast('Update-check fejlede.'); }
    });

    return menu;
  }

  function toggleMenu() {
    const mnu = buildMenu();
    const r = gear.getBoundingClientRect();
    mnu.style.right = (window.innerWidth - r.right) + 'px';
    mnu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    mnu.style.display = (mnu.style.display === 'block' ? 'none' : 'block');
    const logArea = mnu.querySelector('#tpLogArea'); if (logArea) { logArea.value = getLogText(); logArea.scrollTop = logArea.scrollHeight; }
    // kick autosync (viser status i hint hvis due)
    const pbh = mnu.querySelector('#tpPBHint'); autoSyncIfDue(pbh);
  }
  gear.addEventListener('click', toggleMenu);

  document.addEventListener('mousedown', e => {
    if (!menu) return;
    if (e.target !== menu && !menu.contains(e.target) && e.target !== gear) menu.style.display = 'none';
  });
}

/* Test-knap */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  const m1 = '🧪 [TEST] Besked-kanal OK — ' + ts;
  const m2 = '🧪 [TEST] Interesse-kanal OK — ' + ts;
  sendPushover(m1).catch(()=>{});
  setTimeout(()=>sendPushover(m2).catch(()=>{}), 800);
  showToast('Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
}

/*──────────────── 11) STARTUP ───────────────*/
document.addEventListener('click', e => {
  const a = e.target.closest?.('a');
  if (a && /Beskeder/.test(a.textContent || '')) {
    if (isLeader()) { const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0}); stMsg.lastPush = stMsg.lastSent = 0; saveJsonIfLeader(ST_MSG_KEY, stMsg); }
  }
});
tryBecomeLeader();
setInterval(heartbeatIfLeader, HEARTBEAT_MS);
setInterval(tryBecomeLeader, HEARTBEAT_MS + 1200);

callerPopIfNeeded().catch(()=>{});
pollMessages().catch(()=>{});
pollInterest().catch(()=>{});
schedulePollers();
injectUI();
tpLog('info', '[TP] kører version', TP_VER);

/*──────────────── 12) HOVER “Intet Svar” (auto-gem) ───────────────*/
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
