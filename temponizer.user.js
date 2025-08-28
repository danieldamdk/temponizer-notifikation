// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.11.5
// @description  Modulært setup: Notifikationer (Besked/Interesse + Pushover), Caller-toast (klik for at åbne profil i nyt faneblad), SMS on/off, Excel→CSV→GitHub. Kompakt UI + ⚙️.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      api.github.com
// @connect      cdn.jsdelivr.net
// @connect      ajourcare.temponizer.dk
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js?v=7180
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js?v=7180
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js?v=7180
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js?v=7180
// ==/UserScript==

/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX, TPNotifs, TPSms, TPExcel, TPCaller */

(function () {
  'use strict';

  const TP_VERSION = '7.11.5';
  function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
  function setUserKey(v) { try { GM_setValue('tpUserKey', (v || '').trim()); } catch (_) {} }

  function injectUI() {
    if (document.getElementById('tpPanel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tpPanel';
    wrap.style.cssText = [
      'position:fixed','right:8px','bottom:12px','z-index:2147483645','background:#fff','border:1px solid #d7d7d7',
      'padding:8px','border-radius:8px','font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.15)','max-width:260px','min-width:180px'
    ].join(';');
    wrap.innerHTML =
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<div style="font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
        '<button id="tpGearBtn" title="Indstillinger" style="width:22px;height:22px;line-height:22px;text-align:center;border:1px solid #ccc;border-radius:50%;background:#fff;cursor:pointer">⚙️</button>' +
      '</div>' +
      '<label style="display:flex;gap:6px;align-items:center;margin:2px 0"><input type="checkbox" id="tpEnableMsg"> <span>Besked → Pushover</span></label>' +
      '<label style="display:flex;gap:6px;align-items:center;margin:2px 0"><input type="checkbox" id="tpEnableInt"> <span>Interesse → Pushover</span></label>' +
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

    const gear = wrap.querySelector('#tpGearBtn');
    let menu = null;
    function buildMenu() {
      if (menu) return menu;
      menu = document.createElement('div');
      Object.assign(menu.style, {
        position: 'fixed', right: '8px', bottom: (wrap.offsetHeight + 18) + 'px', zIndex: 2147483646,
        background: '#fff', border: '1px solid #ccc', borderRadius: '10px',
        boxShadow: '0 12px 36px rgba(0,0,0,.22)', padding: '12px', width: '380px',
        maxWidth: 'calc(100vw - 16px)', maxHeight: '70vh', overflow: 'auto', display: 'none',
        font: '12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
      });
      menu.innerHTML =
        '<div style="font-weight:700;margin-bottom:8px">Indstillinger</div>' +
        '<div style="margin-bottom:10px">' +
          '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
          '<input id="tpUserKeyMenu" type="text" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
          '<div style="margin-top:6px"><button id="tpSaveUserKeyMenu" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Gem</button></div>' +
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

      const inp = menu.querySelector('#tpUserKeyMenu');
      const save = menu.querySelector('#tpSaveUserKeyMenu');
      inp.value = getUserKey();
      save.addEventListener('click', () => { setUserKey(inp.value); try { new Notification('Temponizer', { body: 'USER-token gemt.' }); } catch(_){} });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setUserKey(inp.value); try { new Notification('Temponizer', { body: 'USER-token gemt.' }); } catch(_){} } });

      if (window.TPExcel && typeof window.TPExcel.attachToMenu === 'function') {
        window.TPExcel.attachToMenu(menu);
      }
      return menu;
    }
    function toggleMenu() {
      const m = buildMenu();
      m.style.display = (m.style.display === 'block') ? 'none' : 'block';
      if (m.style.display === 'block') {
        const outside = (e) => { if (!m.contains(e.target) && e.target !== gear) { m.style.display = 'none'; cleanup(); } };
        const esc = (e) => { if (e.key === 'Escape') { m.style.display = 'none'; cleanup(); } };
        function cleanup() { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); }
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', esc, true);
      }
    }
    const gear = wrap.querySelector('#tpGearBtn');
    gear.addEventListener('click', toggleMenu);
  }

  function boot() {
    injectUI();

    // Brug jsDelivr til CSV (slipper for @connect raw.githubusercontent.com)
    const CSV_JSDELIVR = 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv';

    // Notifikationer (besked + interesse + Pushover)
    TPNotifs.install({
      pushoverToken: 'a27du13k8h2yf8p4wabxeukthr1fu7',
      pollMs: 15000,
      suppressMs: 45000,
      msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
      interestUrl: location.origin + '/index.php?page=freevagter',
      enableInterestNameHints: true,
      rawPhonebookUrl: CSV_JSDELIVR,
      cacheKeyCSV: 'tpCSVCache'
    });

    // SMS toggle
    TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' });

    // Excel/CSV/GitHub
    TPExcel.install({
      owner: 'danieldamdk',
      repo: 'temponizer-notifikation',
      branch: 'main',
      csvPath: 'vikarer.csv',
      cacheKeyCSV: 'tpCSVCache',
      printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
      settingsUrl: location.origin + '/index.php?page=showmy_settings'
    });

    // Caller-toast
    TPCaller.install({
      queueSuffix: '*1500',
      queueCode: '1500',
      rawPhonebookUrl: CSV_JSDELIVR,
      cacheKeyCSV: 'tpCSVCache',
      openInNewTab: true,
      debounceMs: 10000,
      autohideMs: 8000
    });

    // Hvis vi står i beacon-fanen, så behandl URL og luk
    if (TPCaller && typeof TPCaller.processFromUrl === 'function') {
      TPCaller.processFromUrl().catch(()=>{});
    }

    // Bridge til page-window (så du kan kalde fra Console)
    try {
      const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
      root.TPNotifs = TPNotifs;
      root.TPSms    = TPSms;
      root.TPExcel  = TPExcel;
      root.TPCaller = TPCaller;
      console.info('[TP] bridged APIs to page window');
    } catch (e) {
      console.warn('[TP] bridge error', e);
    }
  }

  try { boot(); } catch (e) { console.warn('[TP][BOOT ERR]', e); }
})();
