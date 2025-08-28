// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.12.2
// @description  (1) Besked/Interesse + Pushover + toasts (TPNotifs). (2) Caller-toast (TPCaller). (3) SMS toggle (TPSms). (4) Excel→CSV→Upload (TPExcel). Kompakt UI + ⚙️.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      cdn.jsdelivr.net
// @connect      api.github.com
// @connect      ajourcare.temponizer.dk
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/tp-actions.module.js
// ==/UserScript==

/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX, TPNotifs, TPSms, TPExcel, TPCaller, TPActions */
(function () {
  'use strict';

  const TP_VERSION = '7.12.2';
  const CSV_JSDELIVR = 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv';
  const PUSHOVER_APP_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';

  // ---------- helpers ----------
  function notify(text) {
    try { new Notification('Temponizer', { body: text }); }
    catch (e) { showDOMToast(text); }
  }
  function showDOMToast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position:'fixed', bottom:'12px', right:'12px', zIndex:2147483646,
      background:'#333', color:'#fff', padding:'8px 10px', borderRadius:'8px', fontSize:'12px',
      fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', boxShadow:'0 6px 18px rgba(0,0,0,.35)',
      opacity:0, transform:'translateY(8px)', transition:'opacity .22s, transform .22s'
    });
    document.body.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity=1; el.style.transform='translateY(0)'; });
    setTimeout(()=>{ el.style.opacity=0; el.style.transform='translateY(8px)'; setTimeout(()=>el.remove(), 260); }, 4200);
  }
  function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (e) { return ''; } }
  function setUserKey(v) { try { GM_setValue('tpUserKey', (v || '').trim()); } catch (e) {} }
  function setBadge(el, n) { if (el) el.textContent = String(Number(n || 0)); }
  function pulse(el) { if (!el) return; el.animate([{transform:'scale(1)'},{transform:'scale(1.12)'},{transform:'scale(1)'}], {duration:320,easing:'ease-out'}); }

  // ---------- UI ----------
  function injectUI() {
    if (document.getElementById('tpPanel')) return;

    const wrap = document.createElement('div');
    wrap.id = 'tpPanel';
    wrap.style.cssText = [
      'position:fixed','right:8px','bottom:12px','z-index:2147483645','background:#fff','border:1px solid #d7d7d7',
      'padding:8px','border-radius:8px','font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.15)','max-width:260px','min-width:200px'
    ].join(';');

    wrap.innerHTML =
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<div style="font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
        '<button id="tpGearBtn" title="Indstillinger" style="width:22px;height:22px;line-height:22px;text-align:center;border:1px solid #ccc;border-radius:50%;background:#fff;cursor:pointer">⚙️</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin:2px 0">' +
        '<label style="display:flex;align-items:center;gap:6px;min-width:0;"><input type="checkbox" id="tpEnableMsg"><span>Besked</span></label>' +
        '<span id="tpMsgCountBadge" style="margin-left:auto;min-width:18px;text-align:center;background:#eef;border:1px solid #cbd;padding:0 6px;border-radius:999px;font-weight:600">0</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin:2px 0 6px 0">' +
        '<label style="display:flex;align-items:center;gap:6px;min-width:0;"><input type="checkbox" id="tpEnableInt"><span>Interesse</span></label>' +
        '<span id="tpIntCountBadge" style="margin-left:auto;min-width:18px;text-align:center;background:#efe;border:1px solid #cbd;padding:0 6px;border-radius:999px;font-weight:600">0</span>' +
      '</div>' +
      '<div id="tpSMS" style="border-top:1px solid #eee;margin-top:6px;padding-top:6px">' +
        '<div id="tpSMSStatus" style="color:#666;margin-bottom:6px">Indlæser SMS-status…</div>' +
        '<button id="tpSMSOneBtn" style="padding:5px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Aktivér</button>' +
      '</div>';

    document.body.appendChild(wrap);

    const cbMsg = wrap.querySelector('#tpEnableMsg');
    const cbInt = wrap.querySelector('#tpEnableInt');
    cbMsg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    cbInt.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    cbMsg.onchange = () => localStorage.setItem('tpPushEnableMsg', cbMsg.checked ? 'true' : 'false');
    cbInt.onchange = () => localStorage.setItem('tpPushEnableInt', cbInt.checked ? 'true' : 'false');

    const badgeMsg = wrap.querySelector('#tpMsgCountBadge');
    const badgeInt = wrap.querySelector('#tpIntCountBadge');
    document.addEventListener('tp:msg-count', (e) => {
      const n = e.detail && typeof e.detail.count === 'number' ? e.detail.count : 0;
      const prev = Number(localStorage.getItem('tpMsgPrevBadge') || 0);
      setBadge(badgeMsg, n); if (n > prev) pulse(badgeMsg);
      localStorage.setItem('tpMsgPrevBadge', String(n));
    });
    document.addEventListener('tp:int-count', (e) => {
      const n = e.detail && typeof e.detail.count === 'number' ? e.detail.count : 0;
      const prev = Number(localStorage.getItem('tpIntPrevBadge') || 0);
      setBadge(badgeInt, n); if (n > prev) pulse(badgeInt);
      localStorage.setItem('tpIntPrevBadge', String(n));
    });

    // ---- ⚙️ menu ----
    const gearBtn = wrap.querySelector('#tpGearBtn');
    let menu = null;
    function buildMenu() {
      if (menu) return menu;
      menu = document.createElement('div');
      Object.assign(menu.style, {
        position:'fixed', right:'8px', bottom:(wrap.offsetHeight+18)+'px', zIndex:2147483646,
        background:'#fff', border:'1px solid #ccc', borderRadius:'10px',
        boxShadow:'0 12px 36px rgba(0,0,0,.22)', padding:'12px', width:'380px',
        maxWidth:'calc(100vw - 16px)', maxHeight:'70vh', overflow:'auto', display:'none',
        font:'12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
      });
      menu.innerHTML =
        '<div style="font-weight:700;margin-bottom:8px">Indstillinger</div>' +
        '<div style="margin-bottom:10px">' +
          '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
          '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
          '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<button id="tpSaveUserKeyMenu" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Gem</button>' +
            '<button id="tpTestPushoverBtn" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">🧪 Test Pushover</button>' +
            '<button id="tpCheckUpdate" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">🔄 Søg opdatering</button>' +
          '</div>' +
        '</div>' +
        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<div style="font-weight:700;margin-bottom:6px">Telefonbog / CSV</div>' +
        '<div style="margin-bottom:6px">' +
          '<div style="font-weight:600;margin-bottom:4px">GitHub PAT</div>' +
          '<input id="tpGitPAT" type="password" placeholder="fine-grained token" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
            '<input id="tpCSVFile" type="file" accept=".csv" style="flex:1">' +
            '<button id="tpUploadCSV" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Upload CSV → GitHub</button>' +
          '</div>' +
          '<div style="margin-top:8px"><button id="tpFetchCSVUpload" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">⚡ Hent Excel → CSV + Upload</button></div>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
            '<input id="tpTestPhone" type="text" placeholder="Test nummer (fx 22 44 66 88)" style="flex:1;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
            '<button id="tpLookupPhone" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Slå op i CSV</button>' +
          '</div>' +
          '<div id="tpPBHint" style="margin-top:6px;color:#666"></div>' +
        '</div>' +
        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<div style="font-size:11px;color:#666">Kører v.' + TP_VERSION + '</div>';
      document.body.appendChild(menu);

      // Gem USER token
      const inp  = menu.querySelector('#tpUserKeyMenu');
      const save = menu.querySelector('#tpSaveUserKeyMenu');
      const test = menu.querySelector('#tpTestPushoverBtn');
      const chk  = menu.querySelector('#tpCheckUpdate');
      inp.value = getUserKey();
      save.addEventListener('click', function () { setUserKey(inp.value); notify('USER-token gemt.'); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); setUserKey(inp.value); notify('USER-token gemt.'); }
      });

      // Test Pushover (fallback direkte → Pushover hvis TPNotifs ikke er klar)
      test.addEventListener('click', function () {
        var did = false;
        if (window.TPNotifs && typeof window.TPNotifs.testPushover === 'function') {
          try { window.TPNotifs.testPushover(); did = true; } catch (e) {}
        }
        if (!did) {
          var user = getUserKey();
          if (!user) { notify('Indsæt din Pushover USER-token først.'); return; }
          var body = 'token=' + encodeURIComponent(PUSHOVER_APP_TOKEN) +
                     '&user=' + encodeURIComponent(user) +
                     '&message=' + encodeURIComponent('🧪 [TEST] Pushover fra Temponizer');
          try {
            GM_xmlhttpRequest({
              method: 'POST',
              url: 'https://api.pushover.net/1/messages.json',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              data: body,
              onload: function (r) {
                if (r.status >= 200 && r.status < 300) notify('Test sendt ✅');
                else notify('Pushover-fejl: ' + r.status);
              },
              onerror: function () { notify('Pushover-fejl (netværk).'); }
            });
          } catch (e) { notify('Pushover-fejl.'); }
        }
      });

      // Update-tjek (simpelt)
      chk.addEventListener('click', function () {
        fetch('https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js?ts=' + Date.now(), { cache: 'no-store' })
          .then(function (r) { return r.text(); })
          .then(function (txt) {
            var m = txt.match(/@version\s+([0-9.]+)/);
            var remote = m ? m[1] : null;
            if (!remote) { notify('Kunne ikke læse remote version.'); return; }
            var a = TP_VERSION.split('.').map(function (n) { return parseInt(n, 10) || 0; });
            var b = remote.split('.').map(function (n) { return parseInt(n, 10) || 0; });
            var cmp = 0;
            for (var i = 0; i < Math.max(a.length, b.length); i++) { var x = a[i] || 0, y = b[i] || 0; if (x > y) { cmp = 1; break; } if (x < y) { cmp = -1; break; } }
            if (cmp < 0) { notify('Ny version ' + remote + ' (du kører ' + TP_VERSION + '). Åbner…'); window.open('https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js', '_blank', 'noopener'); }
            else notify('Du kører nyeste (' + TP_VERSION + ').');
          })
          .catch(function () { notify('Update-tjek fejlede.'); });
      });

      // Excel/CSV wiring fra modul
      if (window.TPExcel && typeof window.TPExcel.attachToMenu === 'function') {
        window.TPExcel.attachToMenu(menu);
      } else {
        var pbh = menu.querySelector('#tpPBHint');
        if (pbh) pbh.textContent = 'Excel/CSV-modul ikke indlæst endnu.';
      }
      return menu;
    }

    function toggleMenu() {
      var m = buildMenu();
      m.style.display = (m.style.display === 'block') ? 'none' : 'block';
      if (m.style.display === 'block') {
        function outside(e) { if (!m.contains(e.target) && e.target !== gearBtn) { m.style.display = 'none'; cleanup(); } }
        function esc(e) { if (e.key === 'Escape') { m.style.display = 'none'; cleanup(); } }
        function cleanup() { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); }
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', esc, true);
      }
    }
    gearBtn.addEventListener('click', toggleMenu);
  }

  // ---------- Boot ----------
  function boot() {
    injectUI();

    // Notifikationer
    TPNotifs.install({
      pushoverToken: PUSHOVER_APP_TOKEN,
      pollMs: 15000,
      suppressMs: 45000,
      msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
      interestUrl: location.origin + '/index.php?page=freevagter',
      enableInterestNameHints: true,
      rawPhonebookUrl: CSV_JSDELIVR,
      cacheKeyCSV: 'tpCSVCache'
    });

    // SMS
    TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' });

    // Excel/CSV
    TPExcel.install({
      owner: 'danieldamdk',
      repo: 'temponizer-notifikation',
      branch: 'main',
      csvPath: 'vikarer.csv',
      cacheKeyCSV: 'tpCSVCache',
      printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
      settingsUrl: location.origin + '/index.php?page=showmy_settings'
    });

    // Caller (+ beacon-url processor)
    TPCaller.install({
      queueSuffix: '*1500',
      queueCode: '1500',
      rawPhonebookUrl: CSV_JSDELIVR,
      cacheKeyCSV: 'tpCSVCache',
      openInNewTab: true,
      debounceMs: 10000,
      autohideMs: 8000
    });
    if (TPCaller && typeof TPCaller.processFromUrl === 'function') { TPCaller.processFromUrl().catch(function(){}); }

    // Actions (Intet svar)
    if (typeof window.TPActions !== 'undefined' && typeof window.TPActions.install === 'function') {
      window.TPActions.install();
    }

    try {
      var root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
      root.TPNotifs = TPNotifs; root.TPSms = TPSms; root.TPExcel = TPExcel; root.TPCaller = TPCaller; root.TPActions = window.TPActions;
      console.info('[TP][MAIN] v' + TP_VERSION + ' loaded at', new Date().toISOString());
    } catch (e) {
      console.warn('[TP] bridge error', e);
    }
  }

  try { boot(); } catch (e) { console.warn('[TP][BOOT ERR]', e); }
})();
