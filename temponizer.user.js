// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      6.58
// @description  6.57-stil + caller-pop fra central telefonbog. Push ved nye beskeder/interesse (leader på tværs af faner), hover-menu “Intet Svar” (auto), ETag-optimering. APP-token fastlåst. USER-token i GM storage. Testknap i ⚙️.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @updateURL    https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// @downloadURL  https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// ==/UserScript==

/*──────── 1) KONFIG ────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7'; // ADMIN-FASTLÅST
const POLL_MS     = 30000;
const SUPPRESS_MS = 45000;
const LOCK_MS     = SUPPRESS_MS + 5000;

// Cross-tab leader (én fane styrer push)
const LEADER_KEY = 'tpLeaderV1';
const HEARTBEAT_MS = 5000;         // hvor tit leder forlænger sit “lease”
const LEASE_MS     = 15000;        // gyldighed for lederskab
const TAB_ID = (crypto && crypto.randomUUID ? crypto.randomUUID() : ('tab-' + Math.random().toString(36).slice(2) + Date.now()));

// Caller-pop: central telefonbog (RAW CSV i dit repo)
const RAW_PHONEBOOK = 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/refs/heads/main/vikarer.csv';

/*──────── 1a) MIGRATION til GM storage ────────*/
(function migrateUserKeyToGM(){
  try {
    const gm = (GM_getValue('tpUserKey') || '').trim();
    if (!gm) {
      const ls = (localStorage.getItem('tpUserKey') || '').trim();
      if (ls) {
        GM_setValue('tpUserKey', ls);
        localStorage.removeItem('tpUserKey');
        console.info('[TP][MIGRATE] USER-token localStorage → GM storage');
      }
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
    try { new Notification('Temponizer', { body: msg }); }
    catch (_) { showDOMToast(msg); }
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(function (p) {
      p === 'granted' ? new Notification('Temponizer', { body: msg }) : showDOMToast(msg);
    });
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
  requestAnimationFrame(function () { el.style.opacity = 1; });
  setTimeout(function () { el.style.opacity = 0; setTimeout(function () { el.remove(); }, 500); }, 4000);
}

/*──────── 3) PUSHOVER ────────*/
function getUserKey() {
  try { return (GM_getValue('tpUserKey') || '').trim(); }
  catch (_) { return ''; }
}
function sendPushover(msg) {
  const userKey = getUserKey();
  if (!PUSHOVER_TOKEN || !userKey) {
    console.warn('[TP][PUSH][SKIP] mangler token/user', { hasApp: !!PUSHOVER_TOKEN, hasUser: !!userKey });
    showToast('Pushover er ikke konfigureret (mangler USER-token). Klik på ⚙️ og gem din USER-nøgle.');
    return;
  }
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) +
               '&user=' + encodeURIComponent(userKey) +
               '&message=' + encodeURIComponent(msg);
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
    onload: function (r) {
      try { console.info('[TP][PUSH][OK]', r.status, (r.responseText||'').slice(0,120)); } catch (_) {}
    },
    onerror: function (e) {
      console.warn('[TP][PUSH][ERR][GM]', e && e.error || e);
      fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
      })
      .then(r => r.text().then(t => console.info('[TP][PUSH][OK][fetch]', r.status, t.slice(0,120))))
      .catch(err => console.warn('[TP][PUSH][ERR][fetch]', err));
    }
  });
}

/*──────── 4) FÆLLES STATE + LOCK ────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];
const ST_MSG_KEY = 'tpPushState';        // {count,lastPush,lastSent}
const ST_INT_KEY = 'tpInterestState';    // {count,lastPush,lastSent}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch (_) { return JSON.parse(JSON.stringify(fallback)); }
}
function saveJsonIfLeader(key, obj) {
  if (!isLeader()) return;   // kritisk: kun leder må skrive
  localStorage.setItem(key, JSON.stringify(obj));
}
function takeLock() {
  const l = JSON.parse(localStorage.getItem('tpPushLock') || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock', JSON.stringify({ t: Date.now() })); return true;
}

/*──────── 5) POLLERS (kun leder agerer) ────────*/
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
          showToastOnce('msg', m);
          stMsg.lastPush = Date.now(); stMsg.lastSent = n;
        } else {
          stMsg.lastSent = n;
        }
      } else if (n < stMsg.count) {
        stMsg.lastPush = 0;
      }

      stMsg.count = n;
      saveJsonIfLeader(ST_MSG_KEY, stMsg);
      console.info('[TP-besked]', n, new Date().toLocaleTimeString());
    })
    .catch(e => console.warn('[TP][ERR][MSG]', e));
}

const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETag = localStorage.getItem('tpLastETag') || null;

function pollInterest() {
  if (!isLeader()) return;
  fetch(HTML_URL, {
    method: 'HEAD',
    credentials: 'same-origin',
    headers: lastETag ? { 'If-None-Match': lastETag } : {}
  })
    .then(function (h) {
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
      if (en) sendPushover(m);
      showToastOnce('int', m);
      stInt.lastPush = Date.now(); stInt.lastSent = c;
    } else {
      stInt.lastSent = c;
    }
  } else if (c < stInt.count) {
    stInt.lastPush = 0;
  }

  stInt.count = c; saveJsonIfLeader(ST_INT_KEY, stInt);
  console.info('[TP-interesse]', c, new Date().toLocaleTimeString());
}

/*──────── 6) LEADER-ELECTION ────────*/
function now() { return Date.now(); }
function getLeader() {
  try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); }
  catch (_) { return null; }
}
function setLeader(obj) { localStorage.setItem(LEADER_KEY, JSON.stringify(obj)); }

function isLeader() {
  const L = getLeader();
  return !!(L && L.id === TAB_ID && L.until > now());
}
function tryBecomeLeader() {
  const L = getLeader();
  const t = now();
  if (!L || (L.until || 0) <= t) {
    setLeader({ id: TAB_ID, until: t + LEASE_MS, ts: t });
    if (isLeader()) console.info('[TP][LEADER] Denne fane er nu leder:', TAB_ID);
  }
}
function heartbeatIfLeader() {
  if (!isLeader()) return;
  const t = now();
  setLeader({ id: TAB_ID, until: t + LEASE_MS, ts: t });
}
window.addEventListener('storage', function (e) {
  if (e.key === LEADER_KEY) {
    // evt. debug
  }
});

/*──────── 6b) CALLER-POP (central telefonbog) ────────*/
function normPhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
}
function gmGET(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
      onerror: e => reject(e)
    });
  });
}
function parsePhonebookCSV(text) {
  // forventer: vikar_id,name,phone\n...
  const map = new Map();
  if (!text) return map;
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return map;
  const header = lines.shift().split(',');
  const idxId = header.findIndex(h=>/^vikar_id$/i.test(h));
  const idxPh = header.findIndex(h=>/^phone$/i.test(h));
  for (const ln of lines) {
    const cols = ln.split(',');
    const id = (cols[idxId]||'').trim();
    const ph = (cols[idxPh]||'').trim();
    if (id && ph) map.set(ph, id);
  }
  return map;
}
async function callerPopIfNeeded() {
  try {
    const q = new URLSearchParams(location.search);
    const raw = q.get('tp_caller');
    if (!raw) return;
    if (!raw.endsWith('*1500')) return; // kun indgående – som jeres flow
    const phone8 = normPhone(raw.slice(0, -5));
    if (!phone8) { showToast('Ukendt nummer: ' + raw); return; }
    const csv = await gmGET(RAW_PHONEBOOK);
    const map = parsePhonebookCSV(csv);
    const id = map.get(phone8);
    if (!id) { showToast('Ukendt nummer: ' + phone8); return; }
    const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(id)}#stamoplysninger`;
    showToast('Åbner vikar …');
    location.assign(url);
  } catch (e) {
    console.warn('[TP][CALLER]', e);
    showToast('Kan ikke hente telefonbog lige nu.');
  }
}

/*──────── 7) UI (panel m. toggles + gear; gear-menu har token+test) ────────*/
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

  var m = d.querySelector('#m'), i = d.querySelector('#i');
  m.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  i.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  m.onchange = function () { localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false'); };
  i.onchange = function () { localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false'); };

  // Tandhjul
  const gear = document.createElement('div');
  gear.id = 'tpGear';
  gear.setAttribute('title', 'Indstillinger');
  gear.innerHTML = '⚙️';
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
      fontFamily:'sans-serif', padding:'8px', width:'280px'
    });
    menu.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>' +
      '<div style="margin-bottom:8px">' +
        '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
        '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" ' +
          'style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px">' +
        '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<button id="tpSaveUserKeyMenu" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">Gem</button>' +
          '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Sådan finder du USER-token</a>' +
        '</div>' +
      '</div>' +
      '<div style="border-top:1px solid #eee;margin:6px 0"></div>' +
      '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>' +
      '<div id="tpLeaderHint" style="margin-top:8px;font-size:11px;color:#666"></div>';
    document.body.appendChild(menu);

    const inp  = menu.querySelector('#tpUserKeyMenu');
    const save = menu.querySelector('#tpSaveUserKeyMenu');
    const test = menu.querySelector('#tpTestPushoverBtn');
    const hint = menu.querySelector('#tpLeaderHint');

    function refreshLeaderHint(){
      hint.textContent = (isLeader() ? 'Denne fane er LEADER for push.' : 'Denne fane er ikke leader. En anden fane sender push.');
    }
    refreshLeaderHint();

    inp.value = getUserKey();
    function saveUserKey() {
      const v = (inp.value || '').trim();
      GM_setValue('tpUserKey', v);
      showToast('Pushover USER-token gemt.');
    }
    save.addEventListener('click', saveUserKey);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveUserKey(); } });
    test.addEventListener('click', function () {
      tpTestPushoverBoth();
      menu.style.display = 'none';
    });

    window.addEventListener('storage', function (e) {
      if (e.key === LEADER_KEY) refreshLeaderHint();
    });

    return menu;
  }

  function toggleMenu() {
    const mnu = buildMenu();
    const r = gear.getBoundingClientRect();
    mnu.style.right = (window.innerWidth - r.right) + 'px';
    mnu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    mnu.style.display = (mnu.style.display === 'block' ? 'none' : 'block');
    const inp = mnu.querySelector('#tpUserKeyMenu');
    if (inp) inp.value = getUserKey();
    const hint = mnu.querySelector('#tpLeaderHint');
    if (hint) hint.textContent = (isLeader() ? 'Denne fane er LEADER for push.' : 'Denne fane er ikke leader. En anden fane sender push.');
  }
  gear.addEventListener('click', toggleMenu);

  document.addEventListener('mousedown', function (e) {
    if (menu && e.target !== menu && !menu.contains(e.target) && e.target !== gear) menu.style.display = 'none';
  });

  console.debug('[TP][DBG] ui init', { panel: true, gear: true });
}
function ensureFullyVisible(el){
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  if (r.right > window.innerWidth) dx = window.innerWidth - r.right - 6;
  if (r.bottom > window.innerHeight) dy = window.innerHeight - r.bottom - 6;
  if (r.left < 0) dx = 6 - r.left;
  if (r.top < 0) dy = 6 - r.top;
  if (dx || dy) el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
}

/* Test-knap (sender uanset leader – manuel test må godt gå igennem) */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) { showToast('Indsæt din USER-token i ⚙️-menuen før test.'); return; }
  const ts = new Date().toLocaleTimeString();
  const m1 = '🧪 [TEST] Besked-kanal OK — ' + ts;
  const m2 = '🧪 [TEST] Interesse-kanal OK — ' + ts;
  console.info('[TP][TEST] sender Pushover m1:', m1);
  sendPushover(m1);
  setTimeout(function () {
    console.info('[TP][TEST] sender Pushover m2:', m2);
    sendPushover(m2);
  }, 800);
  showToast('Sendte Pushover-test (Besked + Interesse). Tjek Pushover.');
}

/*──────── 8) STARTUP ────────*/
document.addEventListener('click', function (e) {
  const a = e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent)) {
    if (isLeader()) {
      const stMsg = loadJson(ST_MSG_KEY, {count:0,lastPush:0,lastSent:0});
      stMsg.lastPush = stMsg.lastSent = 0;
      saveJsonIfLeader(ST_MSG_KEY, stMsg);
    }
  }
});

// Leader init + loops
tryBecomeLeader();
setInterval(heartbeatIfLeader, HEARTBEAT_MS);
setInterval(tryBecomeLeader, HEARTBEAT_MS + 1200);

// Caller-pop kør tidligt (hurtigt redirect før UI/pollers gør noget tungt)
callerPopIfNeeded().catch(()=>{});

// Pollers i alle faner (no-op hvis ikke leader)
pollMessages(); pollInterest();
setInterval(pollMessages, POLL_MS);
setInterval(pollInterest, POLL_MS);

// UI
injectUI();
console.info('[TP] kører version 6.58');

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
          var saveBtn = frm && Array.prototype.find.call(frm.querySelectorAll('input[type="button"]'), function (b) {
            return /Gem registrering/i.test(b.value || '');
          });
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
