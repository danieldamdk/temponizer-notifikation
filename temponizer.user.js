// ==UserScript==
// @name         Temponizer → Pushover + Toast + Quick "Intet Svar" (AjourCare)
// @namespace    https://ajourcare.dk/
// @version      6.47
// @description  Push ved nye beskeder og interesse, hover-menu “Intet svar” AUTOGEM. Interesse-poll bruger HEAD+ETag og henter kun første 20 kB ved ændring. ⚙ Pushover-opsætning (API låst).
// @match        https://ajourcare.temponizer.dk/*
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=temponizer.dk
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*──────────────────── 1. KONFIG ────────────────────*/
const POLL_MS     = 30000;  // interval mellem polls
const SUPPRESS_MS = 45000;  // min. tid mellem push/toast pr. kategori
const LOCK_MS     = SUPPRESS_MS + 5000; // lås til at undgå dobbelte notifikationer mellem tabs

// **ORG-TOKEN (admin-låst)**
const ORG_PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';

/*──────────────────── Utils ────────────────────*/
function isPushEnabled(channel) {
  if (channel === 'msg') return (localStorage.getItem('tpPushEnableMsg') || '').trim().toLowerCase() === 'true';
  if (channel === 'int') return (localStorage.getItem('tpPushEnableInt') || '').trim().toLowerCase() === 'true';
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

/*──────────────────── 3. Pushover (admin-låst token) ────────────────────*/
function sendPushover(msg, channel) {
  // dobbelttjek toggle
  if (!isPushEnabled(channel)) {
    console.info('[TP] Push blokeret (toggle OFF for', channel + ')');
    return;
  }

  const user  = (GM_getValue('pushover_user', '') || '').trim();
  const token = ORG_PUSHOVER_TOKEN.trim();
  if (!token) { showToastOnce('po_missing_token', 'ADMIN: ORG_PUSHOVER_TOKEN mangler i scriptet'); return; }
  if (!user)  { showToastOnce('po_missing_user', 'Pushover USER mangler – klik ⚙︎ og indsæt din USER key'); openTpSettings(); return; }

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

/*──────────────────── 4. BESKEDER ────────────────────*/
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

/*──────────────────── 5. INTERESSE (HEAD + ETag + Range) ────────────────────*/
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

/*──────────────────── 6. UI (panel + ⚙︎ i header – robust) ────────────────────*/
function injectUI() {
  const d = document.createElement('div');
  d.id = 'tpPanel';
  Object.assign(d.style, {
    position: 'fixed', bottom: '8px', right: '8px', zIndex: 2147483646,
    background: '#f9f9f9', border: '1px solid #ccc', padding: '10px 12px', borderRadius: '6px',
    fontSize: '12px', fontFamily: 'sans-serif', boxShadow: '1px 1px 5px rgba(0,0,0,.2)',
    boxSizing: 'border-box', minWidth: '220px'
  });

  const header = document.createElement('div');
  Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', gap: '8px' });

  const title = document.createElement('b'); title.textContent = 'TP Notifikationer';

  // ⚙︎ – neutraliser side-CSS via all: unset
  const gear = document.createElement('button');
  gear.id = 'tpSettings'; gear.title = 'Indstillinger'; gear.setAttribute('aria-label', 'Indstillinger');
  gear.style.all = 'unset';
  Object.assign(gear.style, {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '22px', height: '22px', cursor: 'pointer',
    borderRadius: '50%', padding: '0', margin: '0', lineHeight: '1',
    userSelect: 'none', WebkitUserSelect: 'none',
    background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(0,0,0,0.15)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
  });
  gear.textContent = '⚙︎';
  gear.onclick = openTpSettings;

  header.appendChild(title);
  header.appendChild(gear);
  d.appendChild(header);

  const line1 = document.createElement('label'); line1.style.display = 'block'; line1.style.marginTop = '4px'; line1.innerHTML = '<input type="checkbox" id="tp_msg"> Besked (Pushover)';
  const line2 = document.createElement('label'); line2.style.display = 'block'; line2.style.marginTop = '2px'; line2.innerHTML = '<input type="checkbox" id="tp_int"> Interesse (Pushover)';
  d.appendChild(line1); d.appendChild(line2);

  document.body.appendChild(d);

  var m = document.getElementById('tp_msg'); var i = document.getElementById('tp_int');
  m.checked = isPushEnabled('msg'); i.checked = isPushEnabled('int');
  m.onchange = function () { localStorage.setItem('tpPushEnableMsg', m.checked ? 'true' : 'false'); debugState('toggle msg'); };
  i.onchange = function () { localStorage.setItem('tpPushEnableInt', i.checked ? 'true' : 'false'); debugState('toggle int'); };

  debugState('ui init');
}
function openTpSettings() {
  if (document.getElementById('tpSettingsModal')) return;
  const overlay = document.createElement('div'); overlay.id = 'tpSettingsModal';
  Object.assign(overlay.style, { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 2147483647 });

  const box = document.createElement('div');
  Object.assign(box.style, { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: '8px', padding: '16px', width: '380px', boxShadow: '0 8px 24px rgba(0,0,0,.25)', fontFamily: 'sans-serif', fontSize: '13px' });

  const userVal = GM_getValue('pushover_user', '');

  box.innerHTML =
    '<div style="font-weight:600;margin-bottom:8px;">Pushover – opsætning</div>'+
    '<label style="display:block;margin:6px 0 2px;">Din USER key</label>'+
    '<input id="tpUserKey" type="text" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;" value="' + (userVal||'') + '">' +
    '<div style="margin-top:8px;padding:8px;border:1px solid #e5e5e5;border-radius:6px;background:#fafafa;">' +
      '<b>API Token:</b> Låst af administrator i scriptet.' +
    '</div>' +
    '<div style="margin-top:10px;line-height:1.4;">' +
      'Hjælp: <a href="https://pushover.net/" target="_blank" rel="noopener">Find din USER key (Dashboard)</a>' +
    '</div>' +
    '<div style="margin-top:14px;text-align:right;">' +
      '<button id="tpCancel" style="margin-right:6px;padding:6px 10px;">Luk</button>' +
      '<button id="tpSave" style="padding:6px 10px;">Gem</button>' +
    '</div>';

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('tpCancel').onclick = function () { overlay.remove(); };
  document.getElementById('tpSave').onclick = function () {
    const u = document.getElementById('tpUserKey').value.trim();
    GM_setValue('pushover_user', u);
    showToast('Pushover USER gemt');
    overlay.remove();
  };
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

/*──────────────────── 8. HOVER “Intet svar” (auto-udfyld + auto-gem) ────────────────────*/
(function () {
  var auto = false, icon = null, menu = null, hideT = null;

  function mkMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'fixed', zIndex: 2147483647, background: '#fff',
      border: '1px solid #ccc', borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,.25)', fontSize: '12px',
      fontFamily: 'sans-serif'
    });
    var btn = document.createElement('div');
    btn.textContent = 'Registrér “Intet svar”';
    btn.style.cssText = 'padding:6px 12px;white-space:nowrap;cursor:default';
    btn.onmouseenter = function () { btn.style.background = '#f0f0f0'; };
    btn.onmouseleave = function () { btn.style.background = ''; };
    btn.onclick = function () { auto = true; if (icon) icon.click(); hide(); };
    menu.appendChild(btn);
    document.body.appendChild(menu);
    return menu;
  }

  function show(el) {
    icon = el;
    var r = el.getBoundingClientRect();
    var m = mkMenu();
    m.style.left = r.left + 'px';
    m.style.top = (r.bottom + 4) + 'px';
    m.style.display = 'block';
  }
  function hide() { clearTimeout(hideT); hideT = setTimeout(function () { if (menu) menu.style.display = 'none'; icon = null; }, 120); }
  function findIcon(n) { while (n && n !== document) { if (n.getAttribute && n.getAttribute('title') === 'Registrer opkald til vikar') return n; n = n.parentNode; } return null; }

  function triggerInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findGemKnap(root) {
    // Præcis knap
    var btn = root.querySelector('input[type="button"][value="Gem registrering"]');
    if (btn) return btn;
    // Fallback: andre varianter med RegistrerOpkald i onclick
    var cand = Array.prototype.slice.call(
      root.querySelectorAll('input[type="button"][onclick]')
    ).find(function (b) {
      var oc = b.getAttribute('onclick') || '';
      return /RegistrerOpkald\s*\(/.test(oc);
    });
    return cand || null;
  }

  function callRegistrerOpkaldFrom(onclickStr) {
    try {
      if (!onclickStr) return false;
      var m = onclickStr.match(/RegistrerOpkald\s*\(\s*(['"]?)([^,'")]+)\1\s*,\s*(['"]?)([^,'")]+)\3\s*\)/);
      if (m && typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.RegistrerOpkald === 'function') {
        unsafeWindow.RegistrerOpkald(m[2], m[4]);
        console.info('[TP][Intet svar] Kaldte RegistrerOpkald(', m[2], ',', m[4], ') direkte');
        return true;
      }
    } catch (e) {
      console.warn('[TP][Intet svar] Direkte kald fejlede', e);
    }
    return false;
  }

  function submitIntetSvar(textarea) {
    try {
      // 1) Udfyld tekst
      var wanted = 'Intet svar';
      if (textarea.value.trim() !== wanted) {
        textarea.value = wanted;
        triggerInput(textarea);
      }

      // 2) Find knap i nærmeste form/dialog – ellers hele dokumentet
      var form = (textarea.closest && textarea.closest('form')) || document;
      var root = (textarea.closest && (textarea.closest('[role="dialog"], .modal, .ui-dialog, .bootbox, .sweet-alert') || form)) || form;
      var btn = findGemKnap(root) || findGemKnap(document);

      if (btn) {
        setTimeout(function () {
          btn.click();
          console.info('[TP][Intet svar] Klikkede "Gem registrering"');
          auto = false;
        }, 80);
        return;
      }

      // 3) Fallback: parse onclick og kald direkte
      var any = document.querySelector('input[type="button"][onclick*="RegistrerOpkald"]');
      if (any && callRegistrerOpkaldFrom(any.getAttribute('onclick'))) {
        auto = false;
        return;
      }

      // 4) Sidste udvej: submit form eller send Enter
      if (form && form !== document) {
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
        console.info('[TP][Intet svar] Submit af nærmeste form (fallback)');
      } else {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
        console.info('[TP][Intet svar] Faldt tilbage til Enter-event');
      }
      auto = false;
    } catch (e) {
      console.error('[TP][Intet svar] Auto-gem fejlede', e);
      auto = false;
    }
  }

  document.addEventListener('mouseover', function (e) {
    var ic = findIcon(e.target);
    if (ic) show(ic);
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!menu || menu.style.display !== 'block') return;
    var overM = menu.contains(e.target);
    var overI = icon && (icon === e.target || icon.contains(e.target) || (e.target && e.target.contains && e.target.contains(icon)));
    if (!overM && !overI) hide();
  }, true);

  // Når dialogen/textarea dukker op, udfyld & gem automatisk
  new MutationObserver(function (ml) {
    if (!auto) return;
    ml.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (!(n instanceof HTMLElement)) return;
        var ta = (n.matches && n.matches('textarea[name="phonetext"]')) ? n :
                 (n.querySelector && n.querySelector('textarea[name="phonetext"]'));
        if (ta) submitIntetSvar(ta);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();

// Hjælp i konsol
console.info('[TP] kører version', '6.47');
