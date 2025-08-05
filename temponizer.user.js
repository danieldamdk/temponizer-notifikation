// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      6.53
// @description  Push ved nye beskeder og interesse, hover-menu “Intet Svar”. Interesse-poll bruger HEAD+ETag og henter kun 20 kB HTML ved ændring (ESLint-clean). Inkl. testknap for Pushover.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.pushover.net
// @run-at       document-idle
// @updateURL    https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// @downloadURL  https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// ==/UserScript==

/*──────────────────── 1. KONFIG ────────────────────*/
// Fælles app-token (fast i scriptet) + modtager (gruppe/brugernøgle).
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
const PUSHOVER_USER  = 'uPenUF7H43j6R8JxwAq1YYyHBn7ZFd'; // kan være gruppe-nøgle

const POLL_MS     = 30000;  // poll-interval for besked + interesse
const SUPPRESS_MS = 45000;  // minimumstid mellem push på samme tæller
const LOCK_MS     = SUPPRESS_MS + 5000; // låse-vindue så faner ikke dobbelt-sender

/*──────────────────── 2. TOAST ────────────────────*/
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

/*──────────────────── 3. PUSHOVER ────────────────────*/
function sendPushover(msg) {
  const body = 'token=' + encodeURIComponent(PUSHOVER_TOKEN) +
               '&user=' + encodeURIComponent(PUSHOVER_USER) +
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
      // fallback med fetch
      fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
      })
      .then(r => r.text().then(t => console.info('[TP][PUSH][OK][fetch]', r.status, t.slice(0,120))))
      .catch(err => console.warn('[TP][PUSH][ERR][fetch]', err));
    }
  });
}

/*──────────────────── 4. BESKEDER ────────────────────*/
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
          stMsg.lastSent = n; // husk vi har set denne stigning
        }
      } else if (n < stMsg.count) {
        stMsg.lastPush = 0; // reset hvis tæller falder
      }

      stMsg.count = n; saveMsg();
      console.info('[TP-besked]', n, new Date().toLocaleTimeString());
    })
    .catch(e => console.warn('[TP][ERR][MSG]', e));
}

/*──────────────────── 5. INTERESSE (HEAD + ETag) ────────────────────*/
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
      if (h.status === 304) {
        console.info('[TP-interesse] uændret', new Date().toLocaleTimeString());
        return;
      }
      lastETag = h.headers.get('ETag') || null;
      if (lastETag) localStorage.setItem('tpLastETag', lastETag);

      return fetch(HTML_URL, {
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-20000' } // første 20 kB
      })
        .then(r => r.text())
        .then(parseInterestHTML);
    })
    .catch(e => console.warn('[TP][ERR][INT][HEAD]', e));
}

function parseInterestHTML(html) {
  const doc   = new DOMParser().parseFromString(html, 'text/html');
  const boxes = Array.prototype.slice.call(
    doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]')
  );
  const c = boxes.reduce((s, el) => {
    const v = parseInt(el.textContent.trim(), 10);
    return s + (isNaN(v) ? 0 : v);
  }, 0);
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

/*──────────────────── 6. UI (gear + on/off) ────────────────────*/
function injectUI() {
  // wrapper (panel) – eksisterende toggle-boks
  const d = document.createElement('div');
  d.id = 'tpPanel';
  d.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483645;background:#f9f9f9;border:1px solid #ccc;padding:6px 10px;border-radius:6px;font-size:12px;font-family:sans-serif;box-shadow:1px 1px 5px rgba(0,0,0,.2)';
  d.innerHTML = '<b>TP Notifikationer</b><br><label><input type="checkbox" id="m"> Besked (Pushover)</label><br><label><input type="checkbox" id="i"> Interesse (Pushover)</label>';
  document.body.appendChild(d);

  var m = document.getElementById('m'); var i = document.getElementById('i');
  m.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
  i.checked = localStorage.getItem('tpPushEnableInt') === 'true';
  m.onchange = function () { localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false'); };
  i.onchange = function () { localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false'); };

  // tandhjul – lille, diskret, altid fuldt synligt
  const gear = document.createElement('div');
  gear.id = 'tpGear';
  gear.setAttribute('title', 'Indstillinger');
  gear.innerHTML = '⚙️';
  Object.assign(gear.style, {
    position:'fixed', right:'12px', bottom: (8 + d.offsetHeight + 8) + 'px',
    width:'22px', height:'22px', lineHeight:'22px', textAlign:'center',
    background:'#fff', border:'1px solid #ccc', borderRadius:'50%',
    boxShadow:'0 1px 5px rgba(0,0,0,.2)', cursor:'pointer',
    zIndex:2147483647, userSelect:'none'
  });
  document.body.appendChild(gear);
  ensureFullyVisible(gear);

  // menu
  let menu = null;
  function toggleMenu() {
    if (!menu) {
      menu = document.createElement('div');
      Object.assign(menu.style, {
        position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
        borderRadius:'6px', boxShadow:'0 2px 12px rgba(0,0,0,.25)', fontSize:'12px',
        fontFamily:'sans-serif', padding:'6px 0'
      });
      document.body.appendChild(menu);
      tpAddMenuItems(menu);
    }
    const r = gear.getBoundingClientRect();
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    menu.style.display = (menu.style.display === 'block' ? 'none' : 'block');
  }
  gear.addEventListener('click', toggleMenu);

  // klik udenfor → luk
  document.addEventListener('mousedown', function (e) {
    if (menu && e.target !== menu && !menu.contains(e.target) && e.target !== gear) menu.style.display = 'none';
  });

  console.debug('[TP][DBG] ui init', {panel: !!d, gear: !!gear});
}

function ensureFullyVisible(el){
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  if (r.right > window.innerWidth) dx = window.innerWidth - r.right - 6;
  if (r.bottom > window.innerHeight) dy = window.innerHeight - r.bottom - 6;
  if (r.left < 0) dx = 6 - r.left;
  if (r.top < 0) dy = 6 - r.top;
  if (dx || dy) {
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }
}

function tpAddMenuItems(menuEl) {
  // standard menu items (kan udvides)
  function addItem(txt, onclick){
    var item = document.createElement('div');
    item.textContent = txt;
    item.style.cssText = 'padding:6px 10px; white-space:nowrap; cursor:pointer';
    item.onmouseenter = function(){ item.style.background = '#f0f0f0'; };
    item.onmouseleave = function(){ item.style.background = ''; };
    item.onclick = function(){ onclick(); menuEl.style.display = 'none'; };
    menuEl.appendChild(item);
  }

  addItem('🧪 Test Pushover (Besked + Interesse)', tpTestPushoverBoth);
  // evt. flere menupunkter kan tilføjes her…
}

// Test-knap: sender to Pushover-tests (ignorerer toggles)
function tpTestPushoverBoth(){
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

/*──────────────────── 7. START ────────────────────*/
document.addEventListener('click', function (e) {
  const a = e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent)) { stMsg.lastPush = stMsg.lastSent = 0; saveMsg(); }
});
pollMessages(); pollInterest();
setInterval(pollMessages, POLL_MS);
setInterval(pollInterest, POLL_MS);
injectUI();

console.info('[TP] kører version 6.53');

/*──────────────────── 8. HOVER “Intet Svar” (én knap, auto-gem) ────────────────────*/
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

  // Auto-udfyld + auto-gem + “ingen blink”
  new MutationObserver(function (ml) {
    if (!auto) return;
    ml.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (!(n instanceof HTMLElement)) return;

        // skjul popup midlertidigt (ingen blink)
        const hsWrap = n.closest && n.closest('.highslide-body, .highslide-container');
        if (hsWrap) { hsWrap.style.opacity = '0'; hsWrap.style.pointerEvents = 'none'; }

        var ta = (n.matches && n.matches('textarea[name="phonetext"]')) ? n : (n.querySelector && n.querySelector('textarea[name="phonetext"]'));
        if (ta) {
          if (!ta.value.trim()) ta.value = 'Intet Svar';
          // find “Gem registrering”-knappen i samme form
          var frm = ta.closest('form');
          var saveBtn = frm && Array.prototype.find.call(frm.querySelectorAll('input[type="button"]'), function (b) {
            return /Gem registrering/i.test(b.value || '');
          });
          if (saveBtn) {
            setTimeout(function () {
              try { saveBtn.click(); } catch (_) {}
              // luk popup (highslide)
              try { if (unsafeWindow.hs && unsafeWindow.hs.close) unsafeWindow.hs.close(); } catch (_) {}
              // genskab visning
              if (hsWrap) { hsWrap.style.opacity = ''; hsWrap.style.pointerEvents = ''; }
            }, 30);
          }
          auto = false;
        }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
