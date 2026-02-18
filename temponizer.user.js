// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      7.11.7
// @description  Pushover + OS/DOM toast (no dupes, på tværs af faner & når Chrome er minimeret). Pending-flush for bursts. “Intet Svar”-auto. Én SMS-aktiver/deaktiver-knap (iframe). Kompakt UI nederst-højre med ⚙️ inde i boksen.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      ajourcare.temponizer.dk
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// ==/UserScript==

/*──────── 0) VERSION ────────*/
const TP_VERSION = '7.11.7';

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const POLL_MS     = 15000;
const SUPPRESS_MS = 45000; // “cooldown” for at undgå spam
const LOCK_MS     = SUPPRESS_MS + 5000; // toast-lås

// (Leader bevares til evt. fremtid, men pollers kører nu i ALLE faner)
const LEADER_KEY = 'tpLeaderV1';
const HEARTBEAT_MS = 5000;
const LEASE_MS     = 15000;
const TAB_ID = (crypto && crypto.randomUUID ? crypto.randomUUID() : ('tab-' + Math.random().toString(36).slice(2) + Date.now()));

// Script RAW for update-kontrol
const GH_OWNER  = 'danieldamdk';
const GH_REPO   = 'temponizer-notifikation';
const GH_BRANCH = 'main';
const SCRIPT_RAW_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/temponizer.user.js`;

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


function now() { return Date.now(); }
function getLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (_) { return null; } }
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); }
function isLeader() { const L = getLeader(); return !!(L && L.id === TAB_ID && L.until > now()); }
function tryBecomeLeader() { const L = getLeader(), t = now(); if (!L || (L.until || 0) <= t) { setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); } }
function heartbeatIfLeader() { if (!isLeader()) return; const t = now(); setLeader({ id:TAB_ID, until:t+LEASE_MS, ts:t }); }
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
    if (sessionStorage.getItem(seenKey)) return;
    sessionStorage.setItem(seenKey, '1');
    showToast(ev.msg);
  } catch (_) {}
});

function showToast(msg, ms = 4500) {
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        const n = new Notification('Temponizer', { body: msg });
        setTimeout(() => n.close(), Math.min(ms, 6000));
      }
    }
  } catch(_) {}

  try {
    let el = document.getElementById('tpToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tpToast';
      el.style.cssText = [
        'position:fixed','right:16px','bottom:16px','z-index:2147483646',
        'background:#111','color:#fff','padding:10px 12px','border-radius:10px',
        'box-shadow:0 10px 30px rgba(0,0,0,.35)','font-size:13px',
        'font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        'max-width:360px','opacity:0','transition:opacity .25s'
      ].join(';');
      document.body.appendChild(el);
      requestAnimationFrame(() => el.style.opacity = '1');
    }
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => { if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); } }, ms);
  } catch(_) {}
}

const TOAST_LOCK_KEY_PREFIX = 'tpToastLock_';
function takeToastLock(kind) {
  try {
    const key = TOAST_LOCK_KEY_PREFIX + kind;
    const l = JSON.parse(localStorage.getItem(key) || '{"t":0}');
    if (Date.now() - l.t < LOCK_MS) return false;
    localStorage.setItem(key, JSON.stringify({ t: Date.now() }));
    return true;
  } catch(_) { return true; }
}
function showToastOnce(kind, msg) {
  if (!takeToastLock(kind)) return;
  showToast(msg);
  broadcastToast(kind, msg);
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
function saveJson(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); }

// Per-kanal lock
function takeLock(kind = 'global') {
  const key = 'tpPushLock_' + kind;
  const l = JSON.parse(localStorage.getItem(key) || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem(key, JSON.stringify({ t: Date.now() }));
  return true;
}

/* Heal/normalisér state ved opstart */
(function healStates(){
  const fix = (key) => {
    const st = loadJson(key, {count:0,lastPush:0,lastSent:0,pending:0});
    if (typeof st.pending !== 'number') st.pending = 0;
    if (st.lastSent > st.count) st.lastSent = st.count;
    saveJson(key, st);
  };
  fix(ST_MSG_KEY);
  fix(ST_INT_KEY);
  // ryd gamle globale locks, hvis de findes
  try { localStorage.removeItem('tpPushLock'); } catch(_) {}
})();

/* Pending flush (løser “missed” ved suppression/lock) */
function maybeFlushPending(kind, pushEnableKey, stateKey, buildMsg) {
  const st = loadJson(stateKey, {count:0,lastPush:0,lastSent:0,pending:0});
  const shouldFlush = st.pending && (st.pending > (st.lastSent || 0) || st.pending > (st.count || 0));
  if (shouldFlush) {
    if (Date.now() - st.lastPush > SUPPRESS_MS && takeLock(kind)) {
      const text = (typeof buildMsg === 'function') ? buildMsg(st.pending) : String(buildMsg);
      const enabled = localStorage.getItem(pushEnableKey) === 'true';
      if (enabled) sendPushover(text);
      showToastOnce(kind, text);
      st.lastPush = Date.now();
      st.lastSent = st.pending;
      st.pending  = 0;
      saveJson(stateKey, st);
      return true;
    }
  }
  return false;
}

/*──────── 5) POLLERS: BESKED ────────*/
function setBadge(el, n) {
  if (!el) return;
  el.textContent = String(n);
  el.style.opacity = n > 0 ? '1' : '.45';
}
function badgePulse(el){
  if (!el) return;
  el.animate([{ transform:'scale(1)'},{ transform:'scale(1.18)'},{ transform:'scale(1)'}], { duration: 420, easing: 'ease-out' });
}

function pollMessages() {
  // flush evt. pending
  maybeFlushPending('msg', 'tpPushEnableMsg', ST_MSG_KEY, (n)=>`🔔 Du har nu ${n} ulæst(e) Temponizer-besked(er).`);

  fetch(MSG_URL + '&ts=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', headers: {'Cache-Control':'no-cache','Pragma':'no-cache'} })
    .then(r => r.json())
    .then(d => {
      const st = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
      const n  = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
      const en = localStorage.getItem('tpPushEnableMsg') === 'true';

      if (n > st.count && n !== st.lastSent) {
        const canPush = (Date.now() - st.lastPush > SUPPRESS_MS) && takeLock('msg');
        if (canPush) {
          const m = `🔔 Du har nu ${n} ulæst(e) Temponizer-besked(er).`;
          if (en) sendPushover(m);
          showToastOnce('msg', m);
          st.lastPush = Date.now();
          st.lastSent = n;
        } else {
          st.pending = Math.max(st.pending||0, n);
        }
      } else if (n < st.count) {
        st.lastPush = 0;
        st.lastSent = n;
        if (st.pending && n <= st.pending) st.pending = 0;
      }

      st.count = n; saveJson(ST_MSG_KEY, st);

      const badge = document.getElementById('tpMsgCountBadge'); setBadge(badge, n);
      const prevBadge = Number(localStorage.getItem('tpMsgPrevBadge')||0);
      if (n > prevBadge) badgePulse(badge);
      localStorage.setItem('tpMsgPrevBadge', String(n));
    })
    .catch(e => console.warn('[TP][ERR][MSG]', e));
}

/*──────── 6) INTERESSE (HEAD→GET) ────────*/
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

function buildInterestMsg(count) {
  return '👀 ' + count + ' vikar(er) har vist interesse for ledige vagter.';
}

function pollInterest() {
  // flush evt. pending
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
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Cache-Control':'no-cache', 'Pragma':'no-cache', 'Range':'bytes=0-40000' }
      })
      .then(r => r.text())
      .then((html) => {
        const total = parseInterestHTML(html);
        markParsedNow();

        const st = loadJson(ST_INT_KEY, {count:0,lastPush:0,lastSent:0,pending:0});
        const en = localStorage.getItem('tpPushEnableInt') === 'true';

        if (total > st.count && total !== st.lastSent) {
          const canPush = (Date.now() - st.lastPush > SUPPRESS_MS) && takeLock('int');
          const m = buildInterestMsg(total);
          if (canPush) {
            if (en) sendPushover(m);
            showToastOnce('int', m);
            st.lastPush = Date.now();
            st.lastSent = total;
          } else {
            st.pending = Math.max(st.pending||0, total);
          }
        } else if (total < st.count) {
          st.lastPush = 0;
          st.lastSent = total;
          if (st.pending && total <= st.pending) st.pending = 0;
        }

        st.count = total; saveJson(ST_INT_KEY, st);

        const badgeI = document.getElementById('tpIntCountBadge'); setBadge(badgeI, total);
        const prevBadge = Number(localStorage.getItem('tpIntPrevBadge')||0);
        if (total > prevBadge) badgePulse(badgeI);
        localStorage.setItem('tpIntPrevBadge', String(total));
      });
    }
  })
  .catch(e => console.warn('[TP][ERR][INT][HEAD]', e));
}

/*──────── 12) UI (panel + gear i boksen + SMS) ────────*/
const POS_KEY = 'tpPanelPosV3';

function injectUI() {
  if (document.getElementById('tpPanel')) return;

  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = [
    'position:fixed','z-index:2147483645','background:#fff','border:1px solid #d7d7d7',
    'padding:8px','border-radius:8px','font-size:12px','font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,15)','max-width:240px','min-width:170px','line-height:1.25'
  ].join(';');

  d.innerHTML =
    '<div id="tpHeader" style="cursor:move; display:flex; align-items:center; gap:6px; margin-bottom:4px;">' +
      '<div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
      '<div style="margin-left:auto; display:flex; align-items:center; gap:6px;">' +
        '<div id="tpDragHint" style="font-size:10px; color:#888">træk</div>' +
        '<button id="tpGearBtn" title="Indstillinger" style="width:22px;height:22px;line-height:20px;text-align:center;background:#fff;border:1px solid #ccc;border-radius:50%;box-shadow:0 4px 12px rgba(0,0,0,.18);cursor:pointer;padding:0;user-select:none">⚙️</button>' +
      '</div>' +
    '</div>' +

    '<div style="display:flex; align-items:center; gap:6px; margin:2px 0 2px 0; white-space:nowrap;">' +
      '<label style="display:flex; align-items:center; gap:6px; min-width:0;"><input type="checkbox" id="tpEnableMsg"> <span>Besked</span>' +
      '<span id="tpMsgCountBadge" style="display:inline-block;min-width:18px;text-align:center;padding:1px 6px;border-radius:999px;background:#f0f0f0;border:1px solid #e3e3e3;font-size:11px">0</span></label>' +
    '</div>' +

    '<div style="display:flex; align-items:center; gap:6px; margin:2px 0 6px 0; white-space:nowrap;">' +
      '<label style="display:flex; align-items:center; gap:6px; min-width:0;"><input type="checkbox" id="tpEnableInt"> <span>Interesse</span>' +
      '<span id="tpIntCountBadge" style="display:inline-block;min-width:18px;text-align:center;padding:1px 6px;border-radius:999px;background:#f0f0f0;border:1px solid #e3e3e3;font-size:11px">0</span></label>' +
    '</div>' +

    '<div style="display:flex; align-items:center; gap:6px; margin:0 0 2px 0;">' +
      '<span id="tpSMSStatus" style="font-size:11px;color:#666">SMS: …</span>' +
      '<button id="tpSMSOneBtn" style="margin-left:auto; padding:4px 8px;font-size:11px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;flex:0 0 auto">Aktivér</button>' +
    '</div>';

  document.body.appendChild(d);

  // Gear-menu (⚙️) – inde i boksen
  const gearBtn = d.querySelector('#tpGearBtn');
  let menu = null;

  function buildMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'tpMenu';
    Object.assign(menu.style, {
      position: 'fixed',
      zIndex: 2147483647,
      background: '#fff',
      border: '1px solid #ccc',
      borderRadius: '8px',
      boxShadow: '0 10px 28px rgba(0,0,0,.20)',
      padding: '10px',
      width: '320px',
      maxWidth: 'calc(100vw - 16px)',
      maxHeight: '70vh',
      overflow: 'auto',
      display: 'none'
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
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button id="tpTestPushover" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Test Pushover</button>' +
        '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Tjek update</button>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:11px;color:#666">Version: ' + TP_VERSION + '</div>';

    document.body.appendChild(menu);

    const inp  = menu.querySelector('#tpUserKeyMenu');
    const save = menu.querySelector('#tpSaveUserKeyMenu');
    const test = menu.querySelector('#tpTestPushover');
    const chk  = menu.querySelector('#tpCheckUpdate');

    inp.value = getUserKey();
    save.addEventListener('click', () => { GM_setValue('tpUserKey', (inp.value||'').trim()); showToast('USER-token gemt.'); });
    inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); GM_setValue('tpUserKey',(inp.value||'').trim()); showToast('USER-token gemt.'); }});

    test.addEventListener('click', () => { tpTestPushoverBoth(); toggleMenu(false); });

    chk.addEventListener('click', async () => {
      try {
        const raw = await gmGET(SCRIPT_RAW_URL+'?t='+Date.now());
        const m = raw.match(/@version\s+([0-9.]+)/);
        if (!m) { showToast('Kunne ikke læse remote version.'); return; }
        const remote = m[1];
        if (remote === TP_VERSION) showToast('Du kører allerede nyeste version ('+remote+').');
        else { showToast('Ny version tilgængelig: '+remote+' (du kører '+TP_VERSION+'). Starter…'); window.open(SCRIPT_RAW_URL, '_blank'); }
      } catch(_) { showToast('Update-tjek fejlede.'); }
    });

    return menu;
  }

  function positionMenu(menu) {
    const pr = d.getBoundingClientRect();
    const mw = Math.min(menu.offsetWidth || 320, window.innerWidth - 16);
    const mh = Math.min(menu.offsetHeight || 260, Math.floor(window.innerHeight * 0.7));
    let top = pr.top - mh - 10;
    let below = false;
    if (top < 8) { top = pr.bottom + 8; below = true; }
    let left = pr.right - mw;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw;
    if (below && top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - mh);
    Object.assign(menu.style, { left:left+'px', top:top+'px', right:'auto', bottom:'auto', display:'block', maxWidth:'calc(100vw - 16px)', maxHeight:'70vh' });
  }

  function toggleMenu(show) {
    const mnu = buildMenu();
    if (show === false) { mnu.style.display = 'none'; return; }
    mnu.style.display = (mnu.style.display === 'block' ? 'none' : 'block');
    if (mnu.style.display === 'block') {
      mnu.style.visibility = 'hidden';
      positionMenu(mnu); mnu.style.visibility = 'visible';
      ensureFullyVisible(mnu);
      const inp  = mnu.querySelector('#tpUserKeyMenu');
      if (inp) inp.value = getUserKey();

      // klik udenfor → luk
      const outside = (e) => {
        if (!mnu || mnu.style.display !== 'block') return cleanup();
        if (e.target === mnu || mnu.contains(e.target) || e.target === gearBtn) return;
        mnu.style.display = 'none'; cleanup();
      };
      const esc = (e) => { if (e.key === 'Escape') { if (mnu) mnu.style.display='none'; cleanup(); } };
      function cleanup(){ document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); }
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
    }
  }

  gearBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(); });

  // toggles
  const msg = d.querySelector('#tpEnableMsg');
  const intr = d.querySelector('#tpEnableInt');
  msg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  intr.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  msg.onchange = () => localStorage.setItem('tpPushEnableMsg', msg.checked ? 'true' : 'false');
  intr.onchange = () => localStorage.setItem('tpPushEnableInt', intr.checked ? 'true' : 'false');

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

function makeDraggable(el, storageKey, handleSelector) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  handle.style.cursor = 'move'; handle.style.userSelect = 'none';

  let drag = null;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return; // ikke drag på UI controls
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
function badgePulse(el){
  if (!el) return;
  el.animate([{ transform:'scale(1)', offset:0 }, { transform:'scale(1.12)', offset:.35 }, { transform:'scale(1)', offset:1 }], { duration:320, easing:'ease-out' });
}

/*──────── 13) SMS ────────*/
const SMS_SETTINGS_URL = location.origin + '/index.php?page=kontor_indstillinger&sub=kontor_sms';
const SMS_IFRAME_ID = 'tpSMSFrameV2';
const SMS_BTN_ID = 'tpSMSOneBtn';
const SMS_STATUS_ID = 'tpSMSStatus';

function parseSmsStatusFromDoc(doc) {
  const aktivShown   = !!doc.querySelector('.sms_aktiv_container, .kontor_sms_aktiv_container');
  const inaktivShown = !!doc.querySelector('.sms_inaktiv_container, .kontor_sms_inaktiv_container');
  const hasActivateLink   = !!doc.querySelector('a[href*="aktiver_kontor_sms"]');
  const hasDeactivateLink = !!doc.querySelector('a[href*="deaktiver_kontor_sms"]');

  const elAktiv = doc.querySelector('.sms_aktiv_container, .kontor_sms_aktiv_container');
  const elInaktiv = doc.querySelector('.sms_inaktiv_container, .kontor_sms_inaktiv_container');

  let state = 'unknown';
  if (aktivShown || (!inaktivShown && hasDeactivateLink && !hasActivateLink)) state = 'active';
  else if (inaktivShown || (!aktivShown && hasActivateLink && !hasDeactivateLink)) state = 'inactive';

  let phone = '';
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
      if (/print|excel|download/i.test(a.href||'')) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
  } catch(_){}
}

async function ensureSmsIframe(){
  let ifr = document.getElementById(SMS_IFRAME_ID);
  if (ifr) return ifr;

  ifr = document.createElement('iframe');
  ifr.id = SMS_IFRAME_ID;
  ifr.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  ifr.src = SMS_SETTINGS_URL + '&t=' + Date.now();
  document.body.appendChild(ifr);

  await new Promise(res => ifr.addEventListener('load', res, { once:true }));
  hardenSmsIframe(ifr);
  return ifr;
}

async function smsClickLink(which){
  const ifr = await ensureSmsIframe();
  const doc = ifr.contentDocument;
  if (!doc) throw new Error('No iframe doc');
  const sel = which === 'activate' ? 'a[href*="aktiver_kontor_sms"]' : 'a[href*="deaktiver_kontor_sms"]';
  const a = doc.querySelector(sel);
  if (!a) throw new Error('Link not found: ' + which);
  a.click();

  // vent lidt + reload iframe for frisk status
  await sleep(700);
  ifr.src = SMS_SETTINGS_URL + '&t=' + Date.now();
  await new Promise(res => ifr.addEventListener('load', res, { once:true }));
  hardenSmsIframe(ifr);
}

function renderSmsUI(status){
  const el = document.getElementById(SMS_STATUS_ID);
  const btn = document.getElementById(SMS_BTN_ID);
  if (!el || !btn) return;

  if (status.state === 'active') {
    el.textContent = status.phone ? `SMS: Aktiv — ${status.phone}` : 'SMS: Aktiv';
    btn.textContent = 'Deaktivér';
  } else if (status.state === 'inactive') {
    el.textContent = 'SMS: Inaktiv';
    btn.textContent = 'Aktivér';
  } else {
    el.textContent = 'SMS: Ukendt';
    btn.textContent = 'Aktivér';
  }
}

async function refreshSmsStatus(){
  const status = await getSmsStatus();
  renderSmsUI(status);
  return status;
}

function initSMSControls(panel){
  // bind click
  const btn = panel.querySelector('#'+SMS_BTN_ID);
  if (!btn || btn._bound) return;
  btn._bound = true;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const st = await getSmsStatus();
      if (st.state === 'active') {
        showToast('Deaktiverer SMS…');
        await smsClickLink('deactivate');
        await refreshSmsStatus();
        showToast('SMS deaktiveret.');
      } else {
        showToast('Aktiverer SMS…');
        await smsClickLink('activate');
        await refreshSmsStatus();
        showToast('SMS aktiveret.');
      }
    } catch(e) {
      console.warn('[TP][SMS]', e);
      showToast('SMS-handling fejlede. Prøv igen.');
    } finally {
      btn.disabled = false;
    }
  });

  // initial load
  refreshSmsStatus().catch(()=>{});
}

/* Test-knap */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  sendPushover('🧪 [TEST] Besked-kanal OK — ' + ts);
  setTimeout(() => sendPushover('🧪 [TEST] Interesse-kanal OK — ' + ts), 800);
  showToast('Sendte Pushover-test. Tjek Pushover.');
}

/*──────── 14) STARTUP ────────*/
// UI
injectUI();

// Leader liv, men ikke afgørende længere
tryBecomeLeader();
setInterval(heartbeatIfLeader, HEARTBEAT_MS);
setInterval(tryBecomeLeader, HEARTBEAT_MS + 1200);

// Pollers kører i ALLE faner (dup-beskyttet via lock/pending/once)
function doPoll() { pollMessages(); pollInterest(); }
doPoll();
setInterval(doPoll, POLL_MS);

// Ekstra: poll lige når man vender tilbage til tab (hurtig catch-up)
document.addEventListener('visibilitychange', () => { if (!document.hidden) doPoll(); });

/*──────── 15) HOVER / “Intet Svar” auto (beholdt) ────────*/
(function(){
  let auto = false;
  const OBS = new MutationObserver(() => {
    if (auto) return;
    const hsWrap = document.querySelector('#highslide-wrapper-0');
    if (!hsWrap) return;

    const btn = hsWrap.querySelector('input[type="button"][value*="Intet"]');
    if (!btn) return;

    auto = true;
    try {
      hsWrap.style.transition = 'opacity .15s, transform .15s';
      hsWrap.style.opacity = '0.35';
      hsWrap.style.pointerEvents = 'none';
      hsWrap.style.transform = 'scale(.99)';
    } catch(_) {}

    setTimeout(() => {
      try { btn.click(); } catch (_) {}
      setTimeout(() => {
        const saveBtn = hsWrap.querySelector('input[type="submit"], button[type="submit"], input[value*="Gem"]');
        if (saveBtn) {
          setTimeout(function () {
            try { saveBtn.click(); } catch (_) {}
            try { if ((unsafeWindow && unsafeWindow.hs && unsafeWindow.hs.close)) unsafeWindow.hs.close(); } catch (_) {}
            if (hsWrap) { setTimeout(()=>{ hsWrap.style.opacity = ''; hsWrap.style.pointerEvents = ''; hsWrap.style.transform=''; }, 120); }
          }, 30);
        }
        auto = false;
      }, 120);
    }, 30);
  });
  OBS.observe(document.body, { childList: true, subtree: true });
})();
