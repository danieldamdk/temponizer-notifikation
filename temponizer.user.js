// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    https://ajourcare.dk/
// @version      6.42
// @description  Push ved nye beskeder og interesse, hover-menu “Intet Svar”. HEAD+ETag + 20 kB range. ⚙ Indstillinger til Pushover. **Sikkerhed**: sendPushover dobbelttjekker nu de to toggles (msg/int), og logger når push blokeres.
// @match        https://ajourcare.temponizer.dk/*
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=temponizer.dk
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      api.pushover.net
// @run-at       document-idle
// ==/UserScript==

/*──────────────────── 1. KONFIG ────────────────────*/
const POLL_MS     = 30000;  // interval mellem polls
const SUPPRESS_MS = 45000;  // min. tid mellem push/toast pr. kategori
const LOCK_MS     = SUPPRESS_MS + 5000; // lås til at undgå dobbelte notifikationer mellem tabs

/*──────────────────── Utils ────────────────────*/
function isPushEnabled(channel) {
  if (channel === 'msg') return localStorage.getItem('tpPushEnableMsg') === 'true';
  if (channel === 'int') return localStorage.getItem('tpPushEnableInt') === 'true';
  return false;
}
function debugState(prefix) {
  try {
    console.info('[TP][DBG]', prefix, {
      msg: localStorage.getItem('tpPushEnableMsg'),
      int: localStorage.getItem('tpPushEnableInt')
    });
  } catch(_) {}
}

/*──────────────────── 2. TOAST ────────────────────*/
function showToastOnce(key, msg) {
  const lk = 'tpToastLock_' + key;
  const o  = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
  if (Date.now() - o.t < LOCK_MS) return;
  localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
  showToast(msg);
}
function showToast(msg) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification('Temponizer', { body: msg }); }
    catch (_) { showDOMToast(msg); }
  } else if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
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
    boxShadow: '1px 1px 8px rgba(0,0,0,.4)', zIndex: 2147483647,
    opacity: 0, transition: 'opacity .4s'
  });
  document.body.appendChild(el);
  requestAnimationFrame(function () { el.style.opacity = 1; });
  setTimeout(function () { el.style.opacity = 0; setTimeout(function () { el.remove(); }, 500); }, 4000);
}

/*──────────────────── 3. Pushover (GM storage) ────────────────────*/
function sendPushover(msg, channel) {
  // **DOBBELT GATE** – også her, så push aldrig sendes ved fejl andetsteds
  if (!isPushEnabled(channel)) {
    console.info('[TP] Push blokeret (toggle OFF for', channel + ')');
    return;
  }

  const user  = GM_getValue('pushover_user', '');
  const token = GM_getValue('pushover_token', '');
  if (!user || !token) {
    showToastOnce('po_missing', 'Pushover ikke sat op – klik tandhjulet for at indtaste nøgler');
    openTpSettings();
    return;
  }

  const body = 'token=' + encodeURIComponent(token) +
               '&user=' + encodeURIComponent(user) +
               '&message=' + encodeURIComponent(msg);

  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.pushover.net/1/messages.json',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
    onerror: function () {
      fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
      }).catch(console.error);
    }
  });
}

/*──────────────────── 4. Beskeder ────────────────────*/
const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
const MSG_KEYS = ['vagt_unread', 'generel_unread'];
const stMsg = JSON.parse(localStorage.getItem('tpPushState') || '{"count":0,"lastPush":0,"lastSent":0}');
function saveMsg() { localStorage.setItem('tpPushState', JSON.stringify(stMsg)); }
function takeLock() {
  const l = JSON.parse(localStorage.getItem('tpPushLock') || '{"t":0}');
  if (Date.now() - l.t < LOCK_MS) return false;
  localStorage.setItem('tpPushLock', JSON.stringify({ t: Date.now() }));
  return true;
}
function pollMessages() {
  fetch(MSG_URL + '&ts=' + Date.now(), { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      const n = MSG_KEYS.reduce((s, k) => s + Number(d[k] || 0), 0);
      const en = isPushEnabled('msg');

      if (n > stMsg.count && n !== stMsg.lastSent) {
        if (Date.now() - stMsg.lastPush > SUPPRESS_MS && takeLock()) {
          const m = '🔔 Du har nu ' + n + ' ulæst(e) Temponizer-besked(er).';
          if (en) sendPushover(m, 'msg'); else console.info('[TP] Ingen push (msg toggle OFF)');
          showToastOnce('msg', m);
          stMsg.lastPush = Date.now(); stMsg.lastSent = n;
        } else stMsg.lastSent = n;
      } else if (n < stMsg.count) stMsg.lastPush = 0;

      stMsg.count = n; saveMsg();
      console.info('[TP-besked]', n, new Date().toLocaleTimeString());
    })
    .catch(console.error);
}

/*──────────────────── 5. Interesse (HEAD + ETag + Range) ────────────────────*/
const HTML_URL = location.origin + '/index.php?page=freevagter';
let   lastETag = null;

const stInt = JSON.parse(localStorage.getItem('tpInterestState') || '{"count":0,"lastPush":0,"lastSent":0}');
function saveInt() { localStorage.setItem('tpInterestState', JSON.stringify(stInt)); }

function pollInterest() {
  fetch(HTML_URL, {
    method: 'HEAD', credentials: 'same-origin', headers: lastETag ? { 'If-None-Match': lastETag } : {}
  })
    .then(function (h) {
      if (h.status === 304) { console.info('[TP-interesse] uændret', new Date().toLocaleTimeString()); return; }
      lastETag = h.headers.get('ETag') || null;
      return fetch(HTML_URL, { credentials: 'same-origin', headers: { Range: 'bytes=0-20000' } })
        .then(r => r.text())
        .then(parseInterestHTML);
    })
    .catch(console.error);
}

function parseInterestHTML(html) {
  const doc   = new DOMParser().parseFromString(html, 'text/html');
  const boxes = Array.prototype.slice.call(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
  const c = boxes.reduce((s, el) => { const v = parseInt(el.textContent.trim(), 10); return s + (isNaN(v) ? 0 : v); }, 0);
  handleInterestCount(c);
  console.info('[TP-interesse]', c, new Date().toLocaleTimeString());
}

function handleInterestCount(c) {
  const en = isPushEnabled('int');
  if (c > stInt.count && c !== stInt.lastSent) {
    if (Date.now() - stInt.lastPush > SUPPRESS_MS) {
      const m = '👀 ' + c + ' vikar(er) har vist interesse for ledige vagter';
      if (en) sendPushover(m, 'int'); else console.info('[TP] Ingen push (int toggle OFF)');
      showToastOnce('int', m);
      stInt.lastPush = Date.now(); stInt.lastSent = c;
    } else stInt.lastSent = c;
  } else if (c < stInt.count) stInt.lastPush = 0;
  stInt.count = c; saveInt();
}

/*──────────────────── 6. UI (on/off + gear) ────────────────────*/
let _tpPanel, _tpGear;
function injectUI() {
  const d = document.createElement('div');
  d.id = 'tpPanel';
  Object.assign(d.style, {
    position: 'fixed', bottom: '8px', right: '8px', zIndex: 2147483646,
    background: '#f9f9f9', border: '1px solid #ccc', padding: '10px 12px', borderRadius: '6px',
    fontSize: '12px', fontFamily: 'sans-serif', boxShadow: '1px 1px 5px rgba(0,0,0,.2)', boxSizing: 'border-box', minWidth: '220px'
  });

  const header = document.createElement('div'); header.style.marginBottom = '4px';
  const title = document.createElement('b'); title.textContent = 'TP Notifikationer'; header.appendChild(title); d.appendChild(header);

  const line1 = document.createElement('label'); line1.style.display = 'block'; line1.style.marginTop = '4px'; line1.innerHTML = '<input type="checkbox" id="tp_msg"> Besked (Pushover)';
  const line2 = document.createElement('label'); line2.style.display = 'block'; line2.style.marginTop = '2px'; line2.innerHTML = '<input type="checkbox" id="tp_int"> Interesse (Pushover)';
  d.appendChild(line1); d.appendChild(line2);

  document.body.appendChild(d); _tpPanel = d;

  const gear = document.createElement('button');
  gear.id = 'tpSettings'; gear.title = 'Indstillinger'; gear.setAttribute('aria-label', 'Indstillinger');
  Object.assign(gear.style, { position: 'fixed', zIndex: 2147483647, width: '22px', height: '22px', padding: 0, margin: 0, lineHeight: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer', opacity: 0.9 });
  gear.onmouseenter = function () { gear.style.opacity = 1; }; gear.onmouseleave = function () { gear.style.opacity = 0.9; };
  gear.innerHTML = '\n    <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">\n      <path d="M12 8.75a3.25 3.25 0 1 1 0 6.5a3.25 3.25 0 0 1 0-6.5Zm8.63 3.5c.03.25.05.5.05.75s-.02.5-.05.75l2 1.56a.5.5 0 0 1 .12.64l-1.9 3.29a.5.5 0 0 1-.6.22l-2.36-.95a7.6 7.6 0 0 1-1.3.76l-.36 2.52a.5.5 0 0 1-.49.42h-3.8a.5.5 0 0 1-.49-.42l-.36-2.52a7.6 7.6 0 0 1-1.3-.76l-2.36.95a.5.5 0 0 1-.6.22l-1.9 3.29a.5.5 0 0 1-.12.64l-2 1.56Z" fill="currentColor"/>\n    </svg>\n  ';
  gear.onclick = openTpSettings; document.body.appendChild(gear); _tpGear = gear; placeGear();
  window.addEventListener('resize', placeGear); window.addEventListener('scroll', placeGear, true);

  var m = document.getElementById('tp_msg'); var i = document.getElementById('tp_int');
  m.checked = isPushEnabled('msg'); i.checked = isPushEnabled('int');
  m.onchange = function () { localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false'); debugState('toggle msg'); };
  i.onchange = function () { localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false'); debugState('toggle int'); };

  debugState('ui init');
}

function placeGear() {
  if (!_tpPanel || !_tpGear) return;
  const r = _tpPanel.getBoundingClientRect();
  const size = 22, padX = 12, padY = 10;
  const candidates = [
    { left: r.right - size - padX, top: r.top + padY }, // TR
    { left: r.right - size - padX, top: r.bottom - size - padY }, // BR
    { left: r.left + padX,        top: r.bottom - size - padY }, // BL
    { left: r.left + padX,        top: r.top + padY }  // TL
  ];
  function vis(p){
    const vx1=Math.max(0,p.left), vy1=Math.max(0,p.top), vx2=Math.min(window.innerWidth,p.left+size), vy2=Math.min(window.innerHeight,p.top+size);
    return Math.max(0,vx2-vx1)*Math.max(0,vy2-vy1);
  }
  let best=candidates[0], s=-1; for(const c of candidates){const sc=vis(c); if(sc>s){s=sc; best=c;}}
  if (s<=0) { best={ left: Math.max(8, window.innerWidth - size - 8), top: Math.max(8, window.innerHeight - size - 8) }; }
  _tpGear.style.left = Math.round(best.left) + 'px';
  _tpGear.style.top  = Math.round(best.top)  + 'px';
}

/*──────────────────── 7. START ────────────────────*/
document.addEventListener('click', function (e) {
  const a = e.target.closest && e.target.closest('a');
  if (a && /Beskeder/.test(a.textContent || '')) { stMsg.lastPush = stMsg.lastSent = 0; saveMsg(); }
});

pollMessages(); pollInterest();
setInterval(pollMessages, POLL_MS);
setInterval(pollInterest, POLL_MS);

injectUI();

/*──────────────────── 8. Hover “Intet Svar” (én knap) ────────────────────*/
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
    var overI = icon && (icon === e.target || icon.contains(e.target) || (e.target && e.target.contains && e.target.contains(icon)));
    if (!overM && !overI) hide();
  }, true);

  new MutationObserver(function (ml) {
    if (!auto) return;
    ml.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (!(n instanceof HTMLElement)) return;
        var ta = (n.matches && n.matches('textarea[name="phonetext"]')) ? n : (n.querySelector && n.querySelector('textarea[name="phonetext"]'));
        if (ta) { if (!ta.value.trim()) ta.value = 'Intet Svar'; ta.focus(); auto = false; }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();

// Hjælp i konsol
console.info('[TP] kører version', '6.42');
