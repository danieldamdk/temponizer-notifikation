// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      6.56
// @description  Push ved nye beskeder og interesse, hover-menu “Intet Svar”. Interesse-poll bruger HEAD+ETag og henter kun 20 kB HTML ved ændring. APP-token er fastlåst af administrator. USER-token sættes i ⚙️-menuen (GM storage). Inkl. testknap i ⚙️-menuen.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @run-at       document-idle
// @updateURL    https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// @downloadURL  https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// ==/UserScript==

/*──────────────────── 1) KONFIG (APP-token fastlåst) ────────────────────*/
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7'; // ADMIN-FASTLÅST
const POLL_MS     = 30000;
const SUPPRESS_MS = 45000;
const LOCK_MS     = SUPPRESS_MS + 5000;

/*──────────────────── 1a) MIGRATION til GM storage ────────────────────*/
(function migrateUserKeyToGM(){
  try {
    const gm = (GM_getValue('tpUserKey') || '').trim();
    if (!gm) {
      const ls = (localStorage.getItem('tpUserKey') || '').trim();
      if (ls) {
        GM_setValue('tpUserKey', ls);
        localStorage.removeItem('tpUserKey');
        console.info('[TP][MIGRATE] Flyttede USER-token fra localStorage → GM storage');
      }
    }
  } catch(_) {}
})();

/*──────────────────── 2) TOAST ────────────────────*/
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

/*──────────────────── 3) PUSHOVER ────────────────────*/
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

/*──────────────────── 4) BESKEDER ────────────────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];
const stMsg = JSON.parse(localStorage.getItem('tpPushState') || '{"count":0,"lastPush":0,"lastSent":0}');
function saveMsg() { localStorage.setItem('tpPushState', JSON.stringify(stMsg)); }
function takeLock() {
  const l = JSON.parse(localStorage.getItem('tpPushLock') || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock', JSON.stringify({ t: Date.now() })); return true;
}
function pollMessages() {
  fetch(MSG_URL + '&ts=' + Date.now(), { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      const n = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
      const en = localStorage.getItem('tpPushEnableMsg') === 'true';
      console.debug('[TP][DBG][MSG]', { n, stMsg, en });
      if (n > stMsg.count && n !== stMsg.lastSent) {
        const canPush = (Date.now() - stMsg.lastPush > SUPPRESS_MS) && takeLock();
        if (canPush) {
          const m = '🔔 Du har nu ' + n + ' ulæst(e) Temponizer-besked(er).';
          if (en) { console.info('[TP][SEND][MSG] push'); sendPushover(m); }
          else    { console.info('[TP][SKIP][MSG] en=false (kun toast)'); }
          showToastOnce('msg', m);
          stMsg.lastPush = Date.now(); stMsg.lastSent = n;
        } else {
          console.info('[TP][SKIP][MSG]', 'suppression/lock', { dt: Date.now() - stMsg.lastPush });
          stMsg.lastSent = n;
        }
      } else if (n < stMsg.count) {
        stMsg.lastPush = 0;
      }
      stMsg.count = n; saveMsg();
      console.info('[TP-besked]', n, new Date().toLocaleTimeString());
    })
    .catch(e => console.warn('[TP][ERR][MSG]', e));
}

/*──────────────────── 5) INTERESSE (HEAD + ETag) ────────────────────*/
const HTML_URL = location.origin + '/index.php?page=freevagter';
let lastETag = localStorage.getItem('tpLastETag') || null;
const stInt = JSON.parse(localStorage.getItem('tpInterestState') || '{"count":0,"lastPush":0,"lastSent":0}');
function saveInt() { localStorage.setItem('tpInterestState', JSON.stringify(stInt)); }
function pollInterest() {
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
  const doc   = new DOMParser().parseFromString(html, 'text/html');
  const boxes = Array.prototype.slice.call(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  const c = boxes.reduce((s, el) => { const v = parseInt(el.textContent.trim(), 10); return s + (isNaN(v) ? 0 : v); }, 0);
  handleInterestCount(c);
  console.info('[TP-interesse]', c, new Date().toLocaleTimeString());
}
function handleInterestCount(c) {
  const en = localStorage.getItem('tpPushEnableInt') === 'true';
  console.debug('[TP][DBG][INT]', { c, stInt, en });
  if (c > stInt.count && c !== stInt.lastSent) {
    if (Date.now() - stInt.lastPush > SUPPRESS_MS && takeLock()) {
      const m = '👀 ' + c + ' vikar(er) har vist interesse for ledige vagter';
      if (en) { console.info('[TP][SEND][INT] push'); sendPushover(m); }
      else    { console.info('[TP][SKIP][INT] en=false (kun toast)'); }
      showToastOnce('int', m);
      stInt.lastPush = Date.now(); stInt.lastSent = c;
    } else {
      console.info('[TP][SKIP][INT]', 'suppression/lock', { dt: Date.now() - stInt.lastPush });
      stInt.lastSent = c;
    }
  } else if (c < stInt.count) {
    stInt.lastPush = 0;
  }
  stInt.count = c; saveInt();
}

/*──────────────────── 6) UI (panel m. toggles + gear; gear-menu har token+test) ────────────────────*/
function injectUI() {
  // Panel: kun toggles
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

  // Gear-menu (byg ved behov)
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
      '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;width:100%;text-align:left">🧪 Test Pushover (Besked + Interesse)</button>';
    document.body.appendChild(menu);

    // Prefill + events
    const inp  = menu.querySelector('#tpUserKeyMenu');
    const save = menu.querySelector('#tpSaveUserKeyMenu');
    const test = menu.querySelector('#tpTestPushoverBtn');

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

    return menu;
  }

  function toggleMenu() {
    const mnu = buildMenu();
    const r = gear.getBoundingClientRect();
    mnu.style.right = (window.innerWidth - r.right) + 'px';
    mnu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    mnu.style.display = (mnu.style.display === 'block' ? 'none' : 'block');
    // hver åbning: sync feltet med GM
    const inp = mnu.querySelector('#tpUserKeyMenu');
    if (inp) inp.value = getUserKey();
  }
  gear.addEventListener('click', toggleMenu);

  // Klik udenfor → luk menu
  document.addEventListener('mousedown', function (e) {
    if (menu && e.target !== menu && !menu.contains(e.target) && e.target !== gear) menu.style.display = 'none';
  });

  console.debug('[TP][DBG] ui init', { panel: !!d, gear: !!gear });
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

/* Test-knap (bruger USER-token fra GM storage) */
function tpTestPushoverBoth(){
  const userKey = getUserKey();
  if (!userKey) {
    showToast('Indsæt din USER-token i ⚙️-menuen før test.');
    return;
  }
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

/*──────────────────── 7) START ────────────────────*/
document.addEventListener('click', function (e) {
  const a = e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent)) { stMsg.lastPush = stMsg.lastSent = 0; saveMsg(); }
});
pollMessages(); pollInterest();
setInterval(pollMessages, POLL_MS);
setInterval(pollInterest, POLL_MS);
injectUI();
console.info('[TP] kører version 6.56');

/*──────────────────── 8) HOVER “Intet Svar” (auto-gem) ────────────────────*/
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
