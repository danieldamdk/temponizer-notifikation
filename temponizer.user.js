// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" + Overlevering (AjourCare)
// @namespace    ajourcare.dk
// @version      7.10.0
// @description  Push (leader, suppression), toast (Smart/Force, max 1 OS), badges, stealth “Intet Svar”, inbound caller-pop (kun *1500, nyt faneblad, nul flash), SMS status/toggle uden popups, Excel→CSV→GitHub (UI), RAW CSV lookup, drag+anker, auto-update. NYT: Overleverings-UI i panelet (lokal lagring; vikar-link til profil).
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
const TP_VERSION = '7.10.0';

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_MS_LEADER    = 10000; // 10s
const POLL_MS_NONLEADER = 15000; // 15s
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

/*──────── 1b) TOAST DEFAULT + PERMISSION ────────*/
(function initToastMode() {
  const f = localStorage.getItem('tpForceDOMToast');
  const s = localStorage.getItem('tpSmartToast');
  if (f === null && s === null) localStorage.setItem('tpSmartToast', 'true');
})();
(function ensureNotifPermEarly(){
  try {
    if (localStorage.getItem('tpSmartToast') === 'true' &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'default') {
      setTimeout(() => { Notification.requestPermission().catch(()=>{}); }, 1500);
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
  if (typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted') {
      try { new Notification('Temponizer', { body: msg }); } catch (_) { showDOMToast(msg); }
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => { p === 'granted' ? new Notification('Temponizer', { body: msg }) : showDOMToast(msg); });
    } else showDOMToast(msg);
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
    if (!isLeader()) showDOMToast(ev.msg); // non-leader: kun DOM
  } catch (_) {}
});

/*──────── 2b) BADGE + UI helpers ────────*/
function badgePulse(el) { if (!el) return; el.animate([{transform:'scale(1)'},{transform:'scale(1.15)'},{transform:'scale(1)'}],{duration:320,easing:'ease-out'}); }
function setBadge(el, val) { if (!el) return; el.textContent = (typeof val === 'number' ? String(val) : '–'); }

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

/*──────── 4) STATE + LOCK + COUNT EVENTS ────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];

const ST_MSG_KEY = 'tpPushState';     // {count,lastPush,lastSent,pendingCount,pendingTs}
const ST_INT_KEY = 'tpInterestState'; // {count,lastPush,lastSent,pendingCount,pendingTs}

const COUNT_MSG_EVT = 'tpCount_msg';
const COUNT_INT_EVT = 'tpCount_int';

function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (_) { return JSON.parse(JSON.stringify(fallback)); } }
function saveJson(key, obj)       { localStorage.setItem(key, JSON.stringify(obj)); }
function broadcastCount(channel, count) {
  const key = channel === 'msg' ? COUNT_MSG_EVT : COUNT_INT_EVT;
  try { localStorage.setItem(key, JSON.stringify({ count, ts: Date.now() })); } catch(_){}
}
function takeLock() {
  const l = JSON.parse(localStorage.getItem('tpPushLock') || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock', JSON.stringify({ t: Date.now() })); return true;
}

/*──────── 5) NOTIFY HELPERS ────────*/
function handleCount(channel, newCount, enableKey, stateKey, msgBuilder) {
  const st = loadJson(stateKey, {
    count: 0, lastPush: 0, lastSent: 0, pendingCount: null, pendingTs: 0
  });
  const enabled = localStorage.getItem(enableKey) === 'true';
  const now = Date.now();
  const canPushNow = (now - st.lastPush > SUPPRESS_MS) && takeLock();

  const microDomOnRise = (count) => {
    if (document.visibilityState === 'visible' && !canPushNow) showDOMToast(msgBuilder(count));
  };

  if (newCount > st.count) {
    microDomOnRise(newCount);
    if (canPushNow) {
      const text = msgBuilder(newCount);
      if (enabled) sendPushover(text);
      broadcastToast(channel, text);
      showToastOnce(channel, text);
      st.lastPush = now; st.lastSent = newCount; st.pendingCount = null; st.pendingTs = 0;
    } else {
      st.pendingCount = Math.max(st.pendingCount || 0, newCount);
      if (!st.pendingTs) st.pendingTs = now;
    }
  } else if (st.pendingCount != null && canPushNow) {
    const text = msgBuilder(st.pendingCount);
    if (enabled) sendPushover(text);
    broadcastToast(channel, text);
    showToastOnce(channel, text);
    st.lastPush = now; st.lastSent = st.pendingCount; st.pendingCount = null; st.pendingTs = 0;
  }
  if (newCount < st.count) st.lastPush = 0;

  st.count = newCount;
  saveJson(stateKey, st);
  broadcastCount(channel, newCount);
}

/*──────── 6) POLLERS ────────*/
function jitter(base) { return base + Math.floor(Math.random()*0.25*base); }

/* — BESKED — */
function pollMessages(tabRole='leader') {
  fetch(MSG_URL + '&ts=' + Date.now(), {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Cache-Control':'no-cache', 'Pragma':'no-cache' }
  })
  .then(r => r.json())
  .then(d => {
    const n  = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
    const stPrev = loadJson(ST_MSG_KEY, {count:0});
    handleCount('msg', n, 'tpPushEnableMsg', ST_MSG_KEY, (c)=>'🔔 Du har nu ' + c + ' ulæst(e) Temponizer-besked(er).');
    const badge = document.getElementById('tpMsgCountBadge');
    setBadge(badge, n);
    if (n > stPrev.count) badgePulse(badge);
    console.info('[TP-besked]['+tabRole+']', n, new Date().toLocaleTimeString());
  })
  .catch(e => console.warn('[TP][ERR][MSG]['+tabRole+']', e));
}

/* — INTERESSE — (KUN leader laver HEAD/GET) */
const HTML_URL = location.origin + '/index.php?page=freevagter';
const INT_FORCE_GET_MS = 30000; // mindst hver 30s fuld parse
let lastParseTs = Number(localStorage.getItem('tpIntLastFull') || 0);
let lastETagSeen = null;
function mustForceParse() { return (Date.now() - lastParseTs) > INT_FORCE_GET_MS; }
function markParsedNow() { lastParseTs = Date.now(); localStorage.setItem('tpIntLastFull', String(lastParseTs)); }
function parseInterestHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  if (!boxes.length) boxes = Array.from(doc.querySelectorAll('[id*="interesse"][id*="display_number"]'));
  return boxes.reduce((s, el) => {
    const v = parseInt((el.textContent || '').replace(/\D+/g,''), 10);
    return s + (isNaN(v) ? 0 : v);
  }, 0);
}
function pollInterestLeader() {
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
    lastETagSeen = et || lastETagSeen || null;
    if (changed || h.status !== 304 || force || !et) {
      return fetch(HTML_URL + '&_=' + Date.now(), {
        credentials: 'same-origin', cache: 'no-store',
        headers: { 'Cache-Control':'no-cache', 'Pragma':'no-cache', 'Range':'bytes=0-30000' }
      })
      .then(r => r.text())
      .then(html => {
        const c = parseInterestHTML(html);
        markParsedNow();
        const stPrev = loadJson(ST_INT_KEY, {count:0});
        handleCount('int', c, 'tpPushEnableInt', ST_INT_KEY, x=>'👀 ' + x + ' vikar(er) har vist interesse for ledige vagter');
        const badgeI = document.getElementById('tpIntCountBadge');
        setBadge(badgeI, c);
        if (c > stPrev.count) badgePulse(badgeI);
        console.info('[TP-interesse][leader]', c, new Date().toLocaleTimeString());
      });
    } else {
      console.info('[TP-interesse][leader] 304', new Date().toLocaleTimeString());
    }
  })
  .catch(e => console.warn('[TP][ERR][INT][leader][HEAD]', e));
}

/* Non-leader: lyt efter counts fra leader */
window.addEventListener('storage', (e) => {
  try {
    if (e.key === COUNT_INT_EVT && e.newValue) {
      const data = JSON.parse(e.newValue || '{}'); const c = Number(data.count || 0);
      const stPrev = loadJson(ST_INT_KEY, {count:0});
      const badgeI = document.getElementById('tpIntCountBadge');
      setBadge(badgeI, c);
      if (c > stPrev.count) badgePulse(badgeI);
      const st = loadJson(ST_INT_KEY, {count:0}); st.count = c; saveJson(ST_INT_KEY, st);
    }
    if (e.key === COUNT_MSG_EVT && e.newValue) {
      const data = JSON.parse(e.newValue || '{}'); const n = Number(data.count || 0);
      const stPrev = loadJson(ST_MSG_KEY, {count:0});
      const badge = document.getElementById('tpMsgCountBadge');
      setBadge(badge, n);
      if (n > stPrev.count) badgePulse(badge);
      const st = loadJson(ST_MSG_KEY, {count:0}); st.count = n; saveJson(ST_MSG_KEY, st);
    }
  } catch(_){}
});

/*──────── 7) LEADER-ELECTION ────────*/
function now() { return Date.now(); }
function getLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (_) { return null; } }
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); }
function isLeader() { const L = getLeader(); return !!(L && L.id === TAB_ID && L.until > now()); }
function tryBecomeLeader() {
  const L = getLeader(), t = now();
  if (!L || (L.until || 0) <= t) {
    setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t });
    if (isLeader()) {
      console.info('[TP][LEADER] Denne fane er nu leader:', TAB_ID);
      pollMessages('leader');
      pollInterestLeader();
    }
  }
}
function heartbeatIfLeader() { if (!isLeader()) return; const t = now(); setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); }

/*──────── 8) HTTP helpers ────────*/
function gmGET(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: { 'Accept': '*/*', 'Referer': location.href },
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function gmGETArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer',
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
      method: 'POST', url, responseType: 'arraybuffer',
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

/*──────── 9) CALLER-POP ────────*/
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
  if (!rows.length) return { map, header: [], vikars: [] };
  const header = rows[0].map(h => h.toLowerCase());
  const idxId   = header.findIndex(h => /(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));
  const idxName = header.findIndex(h => /(navn|name)/.test(h));
  const phoneCols = header.map((h, idx) => ({ h, idx }))
    .filter(x => /(telefon(?:nummer)?|^tlf\.?$|mobil|cell(?:phone)?|mobile|phone)/.test(x.h));
  const vikars = [];
  const seen = new Set();
  if (idxId >= 0) {
    for (let r = 1; r < rows.length; r++) {
      const id = (rows[r][idxId] || '').trim();
      if (!id || seen.has(id)) continue;
      const name = idxName >= 0 ? (rows[r][idxName] || '').trim() : '';
      seen.add(id);
      vikars.push({ id, name });
    }
  }
  if (idxId < 0 || phoneCols.length === 0) return { map, header, vikars };
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
  return { map, header, vikars };
}

// Luk “launcher”-fanen hurtigt og stille
function silentSelfClose() {
  try { const html = document.documentElement; html.style.visibility='hidden'; html.style.opacity='0'; } catch(_){}
  try { window.stop && window.stop(); } catch(_){}
  let tries = 0;
  const tryClose = () => {
    tries++;
    try { window.close(); } catch(_){}
    if (!window.closed) { try { window.open('', '_self'); window.close(); } catch(_){} }
    if (!window.closed) { try { location.replace('about:blank'); } catch(_){} }
    if (!window.closed && tries < 6) setTimeout(tryClose, 250);
  };
  tryClose();
}

async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const rawParam = q.get('tp_caller');
    if (!rawParam) return;

    const rawStr = String(rawParam).trim();

    // Skjul side straks – vi viser kun noget hvis der ER match
    document.documentElement.style.visibility = 'hidden';
    document.documentElement.style.opacity = '0';

    const isQueueInbound = /\*1500\s*$/.test(rawStr);
    if (!isQueueInbound) { silentSelfClose(); return; }

    const digitsRaw = rawStr.replace(/\*1500\s*$/,'').replace(/[^\d+]/g, '');
    const phone8 = normPhone(digitsRaw);
    if (!phone8) { silentSelfClose(); return; }

    let csvText = '';
    try { csvText = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now()); if (csvText) GM_setValue(CACHE_KEY_CSV, csvText); } catch(_) {}
    if (!csvText) csvText = GM_getValue(CACHE_KEY_CSV) || '';
    if (!csvText) { silentSelfClose(); return; }

    const { map } = parsePhonebookCSV(csvText);
    const rec = map.get(phone8);
    if (!rec) { silentSelfClose(); return; }

    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`;
    if (OPEN_NEW_TAB_ON_INBOUND) { window.open(url, '_blank', 'noopener'); } else { location.assign(url); }
    setTimeout(() => silentSelfClose(), 120);
  } catch (e) {
    console.warn('[TP][CALLER] error', e);
    silentSelfClose();
  }
}

/*──────── 10) GITHUB + Excel→CSV (UI) ────────*/
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

/*──────── 11) SMS (status + aktiver/deaktiver) ────────*/
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
  else {
    const txtA = (elAktiv?.textContent || '').toLowerCase();
    const txtI = (elInaktiv?.textContent || '').toLowerCase();
    const aHit = /er\s*aktiv/.test(txtA);
    const iHit = /er\s*ikke\s*aktiv/.test(txtI);
    if (aHit && !iHit) state = 'active';
    else if (iHit && !aHit) state = 'inactive';
  }
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

/*──────── 12) DRAG + ANKER + UI HELPERS ────────*/
function applyAnchor(el, a) {
  el.style.position='fixed';
  el.style.left  = (a.anchor.h === 'left') ? (a.offset.x + 'px') : 'auto';
  el.style.right = (a.anchor.h === 'right') ? (a.offset.x + 'px') : 'auto';
  el.style.top   = (a.anchor.v === 'top')  ? (a.offset.y + 'px') : 'auto';
  el.style.bottom= (a.anchor.v === 'bottom') ? (a.offset.y + 'px') : 'auto';
}
function makeDraggable(el, storageKey, handleSelector) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  handle.style.cursor = 'move'; handle.style.userSelect = 'none';

  let anchor = null;
  try { anchor = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch(_) {}
  if (anchor && anchor.anchor) applyAnchor(el, anchor);
  else if (anchor && typeof anchor.left === 'number') { el.style.position='fixed'; el.style.left=anchor.left+'px'; el.style.top=anchor.top+'px'; }

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
    el.style.position='fixed';
    el.style.left = nx+'px'; el.style.top = ny+'px';
    el.style.right='auto'; el.style.bottom='auto';
    e.preventDefault();
  };
  const up = () => {
    if (!moving) return;
    moving=false;

    const r = el.getBoundingClientRect();
    const toLeft   = r.left;
    const toRight  = window.innerWidth - (r.left + r.width);
    const toTop    = r.top;
    const toBottom = window.innerHeight - (r.top + r.height);

    const hAnchor = (toRight < toLeft) ? 'right' : 'left';
    const vAnchor = (toBottom < toTop) ? 'bottom' : 'top';
    const offsetX = (hAnchor === 'left') ? toLeft : toRight;
    const offsetY = (vAnchor === 'top')  ? toTop  : toBottom;

    anchor = { anchor: { h: hAnchor, v: vAnchor }, offset: { x: offsetX, y: offsetY } };
    localStorage.setItem(storageKey, JSON.stringify(anchor));

    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
  };

  handle.addEventListener('mousedown', down);
  handle.addEventListener('touchstart', down, {passive:false});

  window.addEventListener('resize', () => {
    if (anchor && anchor.anchor) applyAnchor(el, anchor);
    ensureFullyVisible(el, 8);
  });
}
function ensureFullyVisible(el, margin = 8) {
  if (!el) return;
  el.style.transform = 'none';
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

/*──────── 13) UI (panel + gear + OVERLEVERING) ────────*/
function injectUI() {
  if (document.getElementById('tpPanel')) return;

  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = [
    'position:fixed','top:12px','right:8px','z-index:2147483645',
    'background:#f9f9f9','border:1px solid #ccc','padding:8px 10px',
    'border-radius:6px','font-size:12px','font-family:sans-serif',
    'box-shadow:1px 1px 5px rgba(0,0,0,.2)',
    'display:inline-block','min-width:240px','max-width:420px','width:auto'
  ].join(';');
  d.innerHTML =
    '<div id="tpPanelHeader" style="display:flex;align-items:center;gap:8px;user-select:none">' +
      '<div style="font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
      '<button id="tpGearBtn" title="Indstillinger" style="width:22px;height:22px;line-height:22px;text-align:center;background:#fff;border:1px solid #ccc;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,.2);cursor:pointer;user-select:none;padding:0">⚙️</button>' +
    '</div>' +
    '<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">' +
      '<label style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><input type="checkbox" id="m"> <span>Besked (Pushover)</span><span id="tpMsgCountBadge" style="margin-left:auto;min-width:22px;text-align:center;padding:2px 6px;border-radius:10px;background:#eef;color:#224;font-weight:600;display:inline-block;">–</span></label>' +
      '<label style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><input type="checkbox" id="i"> <span>Interesse (Pushover)</span><span id="tpIntCountBadge" style="margin-left:auto;min-width:22px;text-align:center;padding:2px 6px;border-radius:10px;background:#efe;color:#262;font-weight:600;display:inline-block;">–</span></label>' +
      '<div id="smsRow" style="display:flex;align-items:flex-start;gap:6px">' +
        '<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">' +
            '<strong>SMS</strong>' +
            '<span id="smsTag" style="font-size:11px;color:#666;overflow:hidden;text-overflow:ellipsis;">indlæser…</span>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button id="smsAction" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Aktivér</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="border-top:1px solid #eee;margin:6px 0"></div>' +
      '<button id="tpHandoverToggle" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">✍️ Overlevering</button>' +
      '<div id="tpHandoverBox" style="display:none;margin-top:6px;border:1px solid #ddd;border-radius:6px;background:#fff;padding:8px;box-shadow:inset 0 1px 2px rgba(0,0,0,.05)"></div>' +
    '</div>';
  document.body.appendChild(d);

  makeDraggable(d, 'tpPanelPos', '#tpPanelHeader'); ensureFullyVisible(d);

  /* Checkboxes */
  const m = d.querySelector('#m'), i = d.querySelector('#i');
  m.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  i.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  m.onchange = () => localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false');
  i.onchange = () => localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false');

  /* Sæt badges fra last-known state */
  const stMsg = loadJson(ST_MSG_KEY, {count:0});
  const stInt = loadJson(ST_INT_KEY, {count:0});
  setBadge(d.querySelector('#tpMsgCountBadge'), Number(stMsg.count||0));
  setBadge(d.querySelector('#tpIntCountBadge'), Number(stInt.count||0));

  /* SMS UI */
  const smsAction  = d.querySelector('#smsAction');
  const smsTag     = d.querySelector('#smsTag');
  function smsSetBusy(on, text) { smsAction.disabled = on; if (on) smsTag.textContent = text || 'arbejder…'; }
  function smsRender(st) {
    const mark = (txt, color) => { smsTag.innerHTML = `<span style="color:${color};font-weight:600">${txt}</span>`; };
    smsAction.disabled = false;
    switch (st.state) {
      case 'active':   smsAction.textContent = 'Deaktiver';   mark('Aktiv' + (st.phone ? ' ('+st.phone+')' : ''), '#090'); break;
      case 'inactive': smsAction.textContent = 'Aktivér';     mark('Ikke aktiv' + (st.phone ? ' ('+st.phone+')' : ''), '#a00'); break;
      case 'sys_off':  smsAction.textContent = 'Ikke muligt'; smsAction.disabled = true; mark('System slået fra', '#a00'); break;
      case 'no_mobile':smsAction.textContent = 'Kræver mobilnr.'; smsAction.disabled = true; mark('Manglende mobil på login', '#a00'); break;
      default:         smsAction.textContent = 'Aktivér';     mark('Ukendt', '#666');
    }
  }
  smsAction.addEventListener('click', async () => {
    const wantOn = (sms._last?.state !== 'active');
    smsSetBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
    await sms.setEnabled(wantOn, smsSetBusy, smsRender);
  });
  (async () => { smsSetBusy(true, 'indlæser…'); await sms.refresh(smsRender); smsSetBusy(false); })();

  /* OVERLEVERING UI */
  initHandoverUI(d.querySelector('#tpHandoverToggle'), d.querySelector('#tpHandoverBox'));

  /* Gear menu */
  buildGearMenu(d);
}

/*──────── 13a) Gear-menu ────────*/
function buildGearMenu(panelRoot){
  let menu = null;
  const gearBtn = panelRoot.querySelector('#tpGearBtn');

  function createMenu() {
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
      '<label style="display:block;margin:4px 0"><input type="checkbox" id="tpForceDomToast"> Brug altid skærm-toast (ingen OS-popups)</label>' +
      '<label style="display:block;margin:4px 0"><input type="checkbox" id="tpSmartToast"> Smart toast (DOM når synlig, OS når skjult)</label>' +

      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<div style="font-weight:700;margin-bottom:6px">Telefonbog</div>' +
      '<div style="margin-bottom:6px;font-size:12px;color:#444">CSV ligger i GitHub og bruges ved indgående kald.</div>' +
      '<div style="margin-bottom:6px">' +
        '<div style="font-weight:600;margin-bottom:4px">GitHub PAT (fine-grained • Contents: RW)</div>' +
        '<input id="tpGitPAT" type="password" placeholder="fine-grained token" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
          '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1"/>' +
          '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>' +
        '</div>' +
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
      '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>' +

      '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
      '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🔄 Søg efter opdatering</button>' +
      '<div style="margin-top:6px;font-size:11px;color:#666">Kører v.'+TP_VERSION+'</div>';
    document.body.appendChild(menu);
    return menu;
  }

  function positionMenu(menu) {
    const r = panelRoot.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
    let top  = Math.max(8, Math.min(window.innerHeight - mh - 8, r.bottom + 8));
    Object.assign(menu.style, { left:left+'px', top:top+'px', right:'auto', bottom:'auto', position:'fixed' });
  }

  function openMenu() {
    const mnu = createMenu();
    mnu.style.display = 'block'; mnu.style.visibility = 'hidden';
    positionMenu(mnu); mnu.style.visibility = 'visible';
    setTimeout(()=>{ document.addEventListener('mousedown', outsideClick, true); document.addEventListener('keydown', escClose, true); },0);
    if (!mnu._wired) {
      const inp  = mnu.querySelector('#tpUserKeyMenu');
      const save = mnu.querySelector('#tpSaveUserKeyMenu');
      const forceDom = mnu.querySelector('#tpForceDomToast');
      const smart    = mnu.querySelector('#tpSmartToast');
      const pat   = mnu.querySelector('#tpGitPAT');
      const file  = mnu.querySelector('#tpCSVFile');
      const up    = mnu.querySelector('#tpUploadCSV');
      const csvUp = mnu.querySelector('#tpFetchCSVUpload');
      const tIn   = mnu.querySelector('#tpTestPhone');
      const tBtn  = mnu.querySelector('#tpLookupPhone');
      const pbh   = mnu.querySelector('#tpPBHint');
      const test  = mnu.querySelector('#tpTestPushoverBtn');
      const chk   = mnu.querySelector('#tpCheckUpdate');

      inp.value = getUserKey();
      save.addEventListener('click', () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showToast('USER-token gemt.'); });
      inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); GM_setValue('tpUserKey',(inp.value||'').trim()); showToast('USER-token gemt.'); }});

      forceDom.checked = localStorage.getItem('tpForceDOMToast') === 'true';
      smart.checked    = localStorage.getItem('tpSmartToast') === 'true';
      const syncToggles = (src) => {
        if (src === 'force' && forceDom.checked) { smart.checked = false; localStorage.setItem('tpSmartToast','false'); }
        if (src === 'smart' && smart.checked)   { forceDom.checked = false; localStorage.setItem('tpForceDOMToast','false'); }
      };
      forceDom.onchange = () => { localStorage.setItem('tpForceDOMToast', forceDom.checked ? 'true' : 'false'); syncToggles('force'); };
      smart.onchange    = () => { localStorage.setItem('tpSmartToast',    smart.checked    ? 'true' : 'false'); syncToggles('smart'); };

      pat.value = (GM_getValue('tpGitPAT') || '');
      pat.addEventListener('change', () => GM_setValue('tpGitPAT', pat.value || ''));

      up.addEventListener('click', async () => {
        try {
          if (!file.files || !file.files[0]) { showToast('Vælg en CSV-fil først.'); return; }
          const text = await file.files[0].text();
          const base64 = b64encodeUtf8(text);
          pbh.textContent = 'Uploader CSV…';
          const { sha } = await ghGetSha(PB_OWNER, PB_REPO, PB_CSV, PB_BRANCH);
          await ghPutFile(PB_OWNER, PB_REPO, PB_CSV, base64, 'sync: upload CSV via TM', sha, PB_BRANCH);
          GM_setValue(CACHE_KEY_CSV, text);
          pbh.textContent = 'CSV uploadet. RAW opdateres om få sek.'; showToast('CSV uploadet.');
        } catch (e) { console.warn('[TP][PB][CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved CSV upload.'; showToast('Fejl – se konsol.'); }
      });

      csvUp.addEventListener('click', async () => {
        try {
          pbh.textContent = 'Henter Excel (GET/POST), vælger bedste ark og uploader CSV …';
          const t0 = Date.now();
          await fetchExcelAsCSVAndUpload();
          const ms = Date.now()-t0;
          pbh.textContent = `Færdig på ${ms} ms.`;
        } catch (e) { console.warn('[TP][PB][EXCEL→CSV-UPLOAD]', e); pbh.textContent = 'Fejl ved Excel→CSV upload.'; showToast('Fejl – se konsol.'); }
      });

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

      test.addEventListener('click', () => { tpTestPushoverBoth(); closeMenu(); });

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

      menu._wired = true;
    }
  }
  function closeMenu() {
    if (!menu) return;
    menu.style.display = 'none';
    document.removeEventListener('mousedown', outsideClick, true);
    document.removeEventListener('keydown', escClose, true);
  }
  function toggleMenu(){ if (!menu || menu.style.display !== 'block') openMenu(); else closeMenu(); }
  function outsideClick(e){
    if (!menu) return;
    const gb = gearBtn;
    if (e.target === menu || menu.contains(e.target) || e.target === gb) return;
    closeMenu();
  }
  function escClose(e){ if (e.key === 'Escape') closeMenu(); }

  gearBtn.addEventListener('click', toggleMenu);
  window.addEventListener('resize', () => {
    ensureFullyVisible(panelRoot);
    if (menu && menu.style.display === 'block') {
      const m = menu; const rect = panelRoot.getBoundingClientRect();
      const mw = m.offsetWidth, mh = m.offsetHeight;
      let left = Math.max(8, Math.min(window.innerWidth - mw - 8, rect.right - mw));
      let top  = Math.max(8, Math.min(window.innerHeight - mh - 8, rect.bottom + 8));
      Object.assign(m.style, { left:left+'px', top:top+'px' });
    }
  });
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

/*──────── 14) STARTUP ────────*/
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

// Planlæg pollers
function schedulePollers(){
  const leaderNow = isLeader();
  const role = leaderNow ? 'leader' : 'nonleader';
  const base = leaderNow ? POLL_MS_LEADER : POLL_MS_NONLEADER;

  pollMessages(role);
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

/*──────── 15) HOVER “Intet Svar” (stealth + robust close) ────────*/
(function () {
  let auto = false, iconEl = null, menu = null, hideT = null, stealthCssEl = null;

  function stealthOn() {
    if (stealthCssEl) return;
    stealthCssEl = document.createElement('style');
    stealthCssEl.id = 'tpIntetSvarStealth';
    stealthCssEl.textContent = `
      .highslide-container, .highslide-container * { opacity:0 !important; pointer-events:none !important; }
      .ui-dialog, .ui-dialog * { opacity:0 !important; pointer-events:none !important; }
    `;
    document.head.appendChild(stealthCssEl);
  }
  function stealthOff() { if (stealthCssEl) { stealthCssEl.remove(); stealthCssEl = null; } }

  function getClickable(el){ return el && el.closest ? (el.closest('a[href],button,[onclick]') || el) : el; }
  function findIcon(n) {
    while (n && n !== document) {
      if (n.getAttribute) {
        const t = (n.getAttribute('title') || n.getAttribute('aria-label') || '').trim();
        if (/Registrer opkald til vikar/i.test(t)) return n;
      }
      n = n.parentNode;
    }
    return null;
  }
  function mkMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, { position: 'fixed', zIndex: 2147483647, background: '#fff', border: '1px solid #ccc', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,.25)', fontSize: '12px', fontFamily: 'sans-serif' });
    const btn = document.createElement('div');
    btn.textContent = 'Registrér “Intet Svar”';
    btn.style.cssText = 'padding:6px 12px;white-space:nowrap;cursor:default';
    btn.onmouseenter = () => { btn.style.background = '#f0f0f0'; };
    btn.onmouseleave = () => { btn.style.background = ''; };
    btn.onclick = function () {
      auto = true;
      stealthOn();
      if (iconEl) {
        const target = getClickable(iconEl);
        try { target.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, view:window })); }
        catch(_) { try { target.click(); } catch(_){} }
      }
      hide();
    };
    menu.appendChild(btn);
    document.body.appendChild(menu);
    return menu;
  }
  function show(el) {
    iconEl = el;
    const r = el.getBoundingClientRect();
    const m = mkMenu();
    m.style.left = r.left + 'px';
    m.style.top = r.bottom + 4 + 'px';
    m.style.display = 'block';
  }
  function hide() {
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (menu) menu.style.display = 'none'; iconEl = null; }, 120);
  }

  document.addEventListener('mouseover', (e) => { const ic = findIcon(e.target); if (ic) show(ic); }, true);
  document.addEventListener('mousemove', (e) => {
    if (!menu || menu.style.display !== 'block') return;
    const overM = menu.contains(e.target);
    const overI = iconEl && (iconEl === e.target || iconEl.contains(e.target) || (e.target.contains && e.target.contains(iconEl)));
    if (!overM && !overI) hide();
  }, true);

  const TEXTAREA_SEL = [
    'textarea[name*="phonetext" i]','textarea[id*="phonetext" i]',
    'textarea[name*="phone" i]','textarea[id*="phone" i]',
    'textarea[name*="note" i]','textarea[id*="note" i]',
    'textarea'
  ].join(',');

  function findSave(root) {
    return (
      root.querySelector('input[type="button"][value*="Gem" i]') ||
      root.querySelector('input[type="submit"][value*="Gem" i]') ||
      Array.from(root.querySelectorAll('button')).find(b => /gem registrering/i.test(b.textContent||'') || /^\s*gem\s*$/i.test(b.textContent||''))
    ) || null;
  }
  function tryCloseDialog() {
    const closeBtn = document.querySelector('.highslide-container .highslide-close, .ui-dialog .ui-dialog-titlebar-close');
    if (closeBtn) { try { closeBtn.click(); } catch(_) {} }
    try { if (unsafeWindow.hs && typeof unsafeWindow.hs.close === 'function') unsafeWindow.hs.close(); } catch(_){}
  }

  new MutationObserver((ml) => {
    if (!auto) return;
    for (const m of ml) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const container = (n.closest && (n.closest('.highslide-body, .highslide-container, .modal, .ui-dialog, body') || n)) || n;
        const ta = container.querySelector && container.querySelector(TEXTAREA_SEL);
        if (ta) {
          if (!ta.value.trim()) ta.value = 'Intet Svar';
          const btn = findSave(container);
          if (btn) {
            setTimeout(() => {
              try { btn.click(); } catch(_) {}
              let tries = 0;
              const tick = () => {
                tryCloseDialog();
                const stillOpen = document.querySelector('.highslide-container, .ui-dialog');
                if (!stillOpen || ++tries > 20) { stealthOff(); return; }
                setTimeout(tick, 50);
              };
              setTimeout(tick, 50);
            }, 30);
            auto = false;
            return;
          }
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();

/*──────── 16) OVERLEVERING (lokal lagring, pæn UI) ────────*/
const HO_KEY = 'tpHandoverV1';
function hoTodayKey() {
  // yyyy-mm-dd i lokal tid
  const d = new Date();
  const y = d.getFullYear(), m = (d.getMonth()+1).toString().padStart(2,'0'), dd = d.getDate().toString().padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function hoLoad() {
  try { return JSON.parse(localStorage.getItem(HO_KEY) || '{}'); } catch { return {}; }
}
function hoSave(store) { localStorage.setItem(HO_KEY, JSON.stringify(store||{})); }
function hoListToday() { const s = hoLoad(); return Array.isArray(s[hoTodayKey()]) ? s[hoTodayKey()] : []; }
function hoUpsertToday(arr) { const s = hoLoad(); s[hoTodayKey()] = arr; hoSave(s); }
function hoAdd(entry){
  const arr = hoListToday();
  arr.push(entry);
  hoUpsertToday(arr);
}
function hoGenId(){ return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
function hoMarkdown(arr){
  const dd = new Date();
  const dateStr = dd.toLocaleDateString('da-DK');
  const esc = s => (s||'').replace(/\r?\n/g,' ');
  const lines = [];
  lines.push(`# Overlevering – ${dateStr} (Aften)`);
  const cats = {
    sygemelding: 'Sygemeldinger',
    forsinket: 'For sent',
    noshow: 'No-show',
    kunde_annullerede: 'Afbud/annullering fra kunde',
    gendaekket: 'Gendækket',
    ikkegendaekket: 'Ikke gendækket',
    ring: 'Ringeaftaler',
    kompetence: 'Kompetence',
    klage: 'Klage/OBS',
    oekonomi: 'Økonomi',
    andet: 'Andet'
  };
  const byCat = {};
  for (const e of arr) {
    const c = e.type || 'andet';
    (byCat[c] ||= []).push(e);
  }
  for (const [k, title] of Object.entries(cats)) {
    const list = byCat[k]||[];
    if (!list.length) continue;
    lines.push(`\n**${title}:**`);
    for (const e of list) {
      const who = e.vikarName ? e.vikarName : (e.vikarId ? `#${e.vikarId}` : '');
      const kund = e.kunde || '';
      const dt   = e.vagtDato ? (e.vagtTid ? `${e.vagtDato} ${e.vagtTid}` : e.vagtDato) : '';
      const res  = e.resultat ? ` – ${e.resultat}` : '';
      const fu   = e.follow ? ` [${e.follow}]` : '';
      const note = e.note ? ` – ${esc(e.note)}` : '';
      const parts = [who, kund, dt].filter(Boolean).join(' • ');
      lines.push(`- ${parts}${res}${fu}${note}`);
    }
  }
  const opens = arr.filter(e => e.status !== 'closed');
  if (opens.length) {
    lines.push(`\n**Åbne opgaver til morgenvagten:**`);
    for (const e of opens) {
      const txt = e.follow ? `${e.follow}` : (e.note||'Opfølgning');
      lines.push(`- [ ] ${txt}`);
    }
  }
  return lines.join('\n');
}

/* Autocomplete fra telefonbog CSV */
let HO_VIKAR_OPTIONS = [];
async function hoEnsureVikarOptions(){
  try {
    let csv = GM_getValue(CACHE_KEY_CSV) || '';
    if (!csv) {
      try { csv = await gmGET(RAW_PHONEBOOK + '?t=' + Date.now()); if (csv) GM_setValue(CACHE_KEY_CSV, csv); } catch(_){}
    }
    if (!csv) return;
    const parsed = parsePhonebookCSV(csv);
    HO_VIKAR_OPTIONS = parsed.vikars || [];
  } catch(_){}
}
function hoFindVikarByInput(str){
  if (!str) return { id:'', name:'' };
  const m = str.match(/(.+?)\s*\(#\s*([^\)]+)\s*\)\s*$/);
  if (m) return { name: m[1].trim(), id: m[2].trim() };
  // fallback: exact by name
  const needle = str.trim().toLowerCase();
  const hit = HO_VIKAR_OPTIONS.find(v => (v.name||'').toLowerCase() === needle || v.id === needle);
  if (hit) return { id: hit.id, name: hit.name };
  return { id:'', name:str.trim() };
}

function initHandoverUI(btn, box){
  if (!btn || !box) return;

  const css = document.createElement('style');
  css.textContent = `
    .tp-chip { padding:3px 8px; border:1px solid #ccc; border-radius:999px; background:#fff; cursor:pointer; font-size:12px; }
    .tp-chip.on { background:#eef; border-color:#99a; }
    .tp-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .tp-col { display:flex; flex-direction:column; gap:4px; }
    .tp-input { padding:5px 6px; border:1px solid #ccc; border-radius:4px; }
    .tp-list-item { border:1px solid #eee; border-radius:6px; padding:6px 8px; background:#fafafa; display:flex; gap:6px; align-items:flex-start; }
    .tp-list-item.closed { opacity:.7; }
    .tp-pill { padding:2px 6px; border-radius:999px; background:#eee; font-size:11px; margin-left:4px; }
    .tp-link { color:#06c; text-decoration:none; }
    .tp-link:hover { text-decoration:underline; }
  `;
  document.head.appendChild(css);

  btn.addEventListener('click', () => {
    box.style.display = (box.style.display === 'none' ? 'block' : 'none');
    if (box.style.display === 'block') renderHandover();
  });

  function chipBtn(text, value, state, onClick){
    const b = document.createElement('button');
    b.className = 'tp-chip' + (state ? ' on' : '');
    b.type='button'; b.textContent = text; b.addEventListener('click', onClick);
    b.dataset.value = value;
    return b;
  }

  function renderHandover(){
    box.innerHTML = '';
    const form = document.createElement('div');
    form.className = 'tp-col';
    form.style.marginBottom = '8px';

    // Type chips
    const types = [
      ['Sygemelding','sygemelding'], ['For sent','forsinket'], ['No-show','noshow'],
      ['Kunde annullerede','kunde_annullerede'], ['Gendækket','gendaekket'], ['Ikke gendækket','ikkegendaekket'],
      ['Ringeaftale','ring'], ['Kompetence','kompetence'], ['Klage/OBS','klage'], ['Økonomi','oekonomi'], ['Andet','andet']
    ];
    let selType = 'andet';
    const typeRow = document.createElement('div'); typeRow.className='tp-row';
    typeRow.appendChild(document.createTextNode('Type:'));
    const typeBtns = [];
    for (const [label,val] of types) {
      const b = chipBtn(label, val, val===selType, () => {
        selType = val;
        typeBtns.forEach(x => x.classList.toggle('on', x.dataset.value===selType));
      });
      typeBtns.push(b); typeRow.appendChild(b);
    }

    // Inputs
    const inRow1 = document.createElement('div'); inRow1.className = 'tp-row';
    const vikar = document.createElement('input'); vikar.placeholder='Vikar (navn eller navn (#id))'; vikar.className='tp-input'; vikar.style.flex='1';
    const vikList = document.createElement('datalist'); vikList.id = 'tpVikarList';
    vikar.setAttribute('list', vikList.id);
    inRow1.appendChild(document.createTextNode('Vikar:'));
    inRow1.appendChild(vikar);
    inRow1.appendChild(vikList);

    const inRow2 = document.createElement('div'); inRow2.className = 'tp-row';
    const kunde = document.createElement('input'); kunde.placeholder='Kunde/Team'; kunde.className='tp-input'; kunde.style.flex='1';
    const vDato = document.createElement('input'); vDato.type='date'; vDato.className='tp-input';
    const vTid  = document.createElement('input'); vTid.type='time'; vTid.className='tp-input';
    inRow2.appendChild(document.createTextNode('Kunde:')); inRow2.appendChild(kunde);
    inRow2.appendChild(document.createTextNode('Dato:'));  inRow2.appendChild(vDato);
    inRow2.appendChild(document.createTextNode('Tid:'));   inRow2.appendChild(vTid);

    // Resultat chips
    const resRow = document.createElement('div'); resRow.className='tp-row';
    resRow.appendChild(document.createTextNode('Resultat:'));
    let selRes = '';
    const resOpts = [['Dækket','Dækket'], ['Ikke dækket','Ikke dækket'], ['Booket','Booket'], ['Annulleret','Annulleret'], ['Flyttet','Flyttet'], ['—','']];
    const resBtns = [];
    for (const [label,val] of resOpts) {
      const b = chipBtn(label, val, val===selRes, () => {
        selRes = val;
        resBtns.forEach(x => x.classList.toggle('on', x.dataset.value===selRes));
      });
      resBtns.push(b); resRow.appendChild(b);
    }

    // Follow-up chips
    const fuRow = document.createElement('div'); fuRow.className='tp-row';
    fuRow.appendChild(document.createTextNode('Følg-op:'));
    let selFU = '';
    const fuBtnCustom = chipBtn('Ring kl …','ring', false, () => {
      const t = prompt('Ring kl. (fx 08:15 eller 12:00)'); if (t) { selFU = 'Ring kl ' + t; syncFU(); }
    });
    const fuBtnImorgen = chipBtn('Tjek i morgen','imorgen', false, () => { selFU='Tjek i morgen'; syncFU(); });
    const fuBtnMandag  = chipBtn('Mandag','mandag', false, () => { selFU='Mandag'; syncFU(); });
    const fuBtnNone    = chipBtn('Ingen','', true, () => { selFU=''; syncFU(); });
    function syncFU(){
      [fuBtnCustom, fuBtnImorgen, fuBtnMandag, fuBtnNone].forEach(b => b.classList.remove('on'));
      const match = selFU.startsWith('Ring kl') ? fuBtnCustom
        : selFU==='Tjek i morgen' ? fuBtnImorgen
        : selFU==='Mandag' ? fuBtnMandag
        : fuBtnNone;
      match.classList.add('on');
    }
    fuRow.append(fuBtnCustom, fuBtnImorgen, fuBtnMandag, fuBtnNone);

    const note = document.createElement('textarea'); note.placeholder='Kort note (valgfri)'; note.className='tp-input'; note.style.minHeight='44px';

    // Submit row
    const actRow = document.createElement('div'); actRow.className='tp-row';
    const addBtn = document.createElement('button'); addBtn.textContent='Tilføj'; addBtn.className='tp-chip'; addBtn.style.fontWeight='600';
    const copyBtn = document.createElement('button'); copyBtn.textContent='Kopiér som markdown'; copyBtn.className='tp-chip';
    actRow.append(addBtn, copyBtn);

    form.append(typeRow, inRow1, inRow2, resRow, fuRow, note, actRow);
    box.appendChild(form);

    const listWrap = document.createElement('div'); listWrap.style.display='flex'; listWrap.style.flexDirection='column'; listWrap.style.gap='6px';
    const listHdr  = document.createElement('div'); listHdr.style.display='flex'; listHdr.style.alignItems='center'; listHdr.style.justifyContent='space-between';
    listHdr.innerHTML = '<div style="font-weight:700">Dagens overlevering</div><div id="tpHoCounters" style="font-size:11px;color:#666"></div>';
    const list = document.createElement('div'); list.id='tpHandoverList'; list.style.display='flex'; list.style.flexDirection='column'; list.style.gap='6px';
    listWrap.append(listHdr, list);
    box.appendChild(listWrap);

    // Fill vikar datalist
    (async () => {
      await hoEnsureVikarOptions();
      vikList.innerHTML = HO_VIKAR_OPTIONS.slice(0,500).map(v => {
        const label = v.name ? `${v.name} (#${v.id})` : `#${v.id}`;
        return `<option value="${label}"></option>`;
      }).join('');
    })();

    // Add handler
    addBtn.addEventListener('click', () => {
      const who = hoFindVikarByInput(vikar.value);
      const entry = {
        id: hoGenId(),
        t: Date.now(),
        type: selType,
        vikarId: (who.id||'').trim(),
        vikarName: (who.name||'').trim(),
        kunde: (kunde.value||'').trim(),
        vagtDato: (vDato.value||'').trim(),
        vagtTid:  (vTid.value||'').trim(),
        resultat: selRes,
        follow: selFU,
        note: (note.value||'').trim(),
        status: 'open'
      };
      hoAdd(entry);
      vikar.value=''; kunde.value=''; vDato.value=''; vTid.value=''; selRes=''; selFU=''; note.value='';
      resBtns.forEach(x => x.classList.toggle('on', x.dataset.value===selRes));
      syncFU();
      renderList();
    });

    copyBtn.addEventListener('click', () => {
      const md = hoMarkdown(hoListToday());
      try {
        navigator.clipboard.writeText(md);
        showDOMToast('Overlevering kopieret.');
      } catch(_) {
        const ta = document.createElement('textarea'); ta.value = md; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showDOMToast('Overlevering kopieret.'); } catch(_) {}
        ta.remove();
      }
    });

    function renderCounters(arr){
      const g = (k) => arr.filter(e => e.type===k).length;
      const daek = arr.filter(e => e.resultat==='Dækket').length;
      const idaek = arr.filter(e => e.resultat==='Ikke dækket').length;
      const syg  = g('sygemelding');
      const fs   = g('forsinket'); const ns = g('noshow');
      const open = arr.filter(e => e.status!=='closed').length;
      const hdr = box.querySelector('#tpHoCounters');
      hdr.textContent = `Dækket: ${daek} • Ikke dækket: ${idaek} • Syg: ${syg} • For sent/No-show: ${fs+ns} • Åbne: ${open}`;
    }

    function entryToLine(e){
      const wrap = document.createElement('div');
      wrap.className = 'tp-list-item' + (e.status==='closed' ? ' closed' : '');
      const left = document.createElement('div'); left.style.flex='1';

      const who = document.createElement('span');
      if (e.vikarId) {
        who.innerHTML = `<a class="tp-link" target="_blank" rel="noopener" href="/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(e.vikarId)}#stamoplysninger">${e.vikarName || ('#'+e.vikarId)}</a>`;
      } else if (e.vikarName) {
        who.textContent = e.vikarName;
      }

      const info = [];
      if (e.kunde) info.push(e.kunde);
      const dt = e.vagtDato ? (e.vagtTid ? `${e.vagtDato} ${e.vagtTid}` : e.vagtDato) : '';
      if (dt) info.push(dt);
      const meta = info.join(' • ');

      const head = document.createElement('div');
      head.innerHTML = `<strong>${labelForType(e.type)}</strong> `;
      head.appendChild(who);
      if (meta) head.insertAdjacentHTML('beforeend', ` — ${meta}`);
      if (e.resultat) head.insertAdjacentHTML('beforeend', ` <span class="tp-pill">${e.resultat}</span>`);
      if (e.follow)   head.insertAdjacentHTML('beforeend', ` <span class="tp-pill">${e.follow}</span>`);

      const note = document.createElement('div'); note.style.fontSize='11px'; note.style.color='#444'; if (e.note) note.textContent = e.note;

      left.append(head, note);

      const right = document.createElement('div'); right.style.display='flex'; right.style.flexDirection='column'; right.style.gap='4px';
      const bClose = document.createElement('button'); bClose.className='tp-chip'; bClose.textContent = (e.status==='closed' ? 'Genåbn' : 'Luk');
      const bDel   = document.createElement('button'); bDel.className='tp-chip'; bDel.textContent='Slet';
      right.append(bClose, bDel);

      bClose.addEventListener('click', () => {
        const arr = hoListToday();
        const idx = arr.findIndex(x => x.id===e.id);
        if (idx>=0) { arr[idx].status = (arr[idx].status==='closed' ? 'open' : 'closed'); hoUpsertToday(arr); renderList(); }
      });
      bDel.addEventListener('click', () => {
        if (!confirm('Slet denne linje?')) return;
        const arr = hoListToday().filter(x => x.id!==e.id);
        hoUpsertToday(arr); renderList();
      });

      wrap.append(left, right);
      return wrap;
    }

    function labelForType(t){
      switch(t){
        case 'sygemelding': return 'Sygemelding';
        case 'forsinket': return 'For sent';
        case 'noshow': return 'No-show';
        case 'kunde_annullerede': return 'Kunde annullerede';
        case 'gendaekket': return 'Gendækket';
        case 'ikkegendaekket': return 'Ikke gendækket';
        case 'ring': return 'Ringeaftale';
        case 'kompetence': return 'Kompetence';
        case 'klage': return 'Klage/OBS';
        case 'oekonomi': return 'Økonomi';
        default: return 'Andet';
      }
    }

    function renderList(){
      const arr = hoListToday();
      const open = arr.filter(e => e.status!=='closed').sort((a,b)=>a.t-b.t);
      const closed = arr.filter(e => e.status==='closed').sort((a,b)=>a.t-b.t);
      list.innerHTML = '';
      open.forEach(e => list.appendChild(entryToLine(e)));
      if (closed.length) {
        const sep = document.createElement('div'); sep.style.fontSize='11px'; sep.style.color='#666'; sep.style.marginTop='4px'; sep.textContent='Afsluttet i dag';
        list.appendChild(sep);
        closed.forEach(e => list.appendChild(entryToLine(e)));
      }
      renderCounters(arr);
    }

    renderList();
  }
}

/*──────── end OVERLEVERING ────────*/
