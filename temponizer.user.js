// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.11.5
// @description  Modulært setup: Notifikationer (Besked/Interesse + Pushover + toasts), Caller-toast, SMS on/off, Excel→CSV→GitHub. Kompakt UI + ⚙️.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      api.github.com
// @connect      cdn.jsdelivr.net
// @connect      ajourcare.temponizer.dk
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js?v=20250828-03
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js?v=20250828-03
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js?v=20250828-03
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js?v=20250828-03
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/tp-actions.module.js?v=20250828-03
// ==/UserScript==

/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX, TPNotifs, TPSms, TPExcel, TPCaller, TPActions */

(function () {
  'use strict';

  /*──────── 0) Version + små helpers ────────*/
  const TP_VERSION = '7.11.5';
  const SCRIPT_RAW_URL = 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js';
  const CSV_JSDELIVR  = 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv';

  function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
  function setUserKey(v) { try { GM_setValue('tpUserKey', (v || '').trim()); } catch (_) {} }

  function gmGET(url){
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { 'Accept': '*/*' },
          onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
          onerror: e => reject(e)
        });
      } catch (e) { reject(e); }
    });
  }
  function versionCompare(a,b){
    const pa = String(a).split('.').map(n=>parseInt(n,10)||0);
    const pb = String(b).split('.').map(n=>parseInt(n,10)||0);
    const len = Math.max(pa.length, pb.length);
    for (let i=0;i<len;i++){ const x=pa[i]||0, y=pb[i]||0; if (x>y) return 1; if (x<y) return -1; }
    return 0;
  }
  function notify(text){ try { new Notification('Temponizer', { body: text }); } catch(_) {} }
  function setBadge(el, n){ if(el) el.textContent = String(Number(n||0)); }
  function pulse(el){ if(!el) return; el.animate([{ transform:'scale(1)' }, { transform:'scale(1.12)' }, { transform:'scale(1)' }], { duration:320, easing:'ease-out' }); }

  /*──────── 1) UI (kompakt panel + ⚙️) ────────*/
  function injectUI() {
    if (document.getElementById('tpPanel')) return;

    const wrap = document.createElement('div');
    wrap.id = 'tpPanel';
    wrap.style.cssText = [
      'position:fixed','right:8px','bottom:12px','z-index:2147483645','background:#fff','border:1px solid #d7d7d7',
      'padding:8px','border-radius:8px','font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.15)','max-width:260px','min-width:200px'
    ].join(';');
    wrap.innerHTML = (
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<div style="font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
        '<button id="tpGearBtn" title="Indstillinger" style="width:22px;height:22px;line-height:22px;text-align:center;border:1px solid #ccc;border-radius:50%;background:#fff;cursor:pointer">⚙️</button>' +
      '</div>' +

      // Linje 1: Besked toggle + badge
      '<div style="display:flex; align-items:center; gap:6px; margin:2px 0; white-space:nowrap;">' +
        '<label style="display:flex; align-items:center; gap:6px; min-width:0;"><input type="checkbox" id="tpEnableMsg"> <span>Besked</span></label>' +
        '<span id="tpMsgCountBadge" style="margin-left:auto;min-width:18px;text-align:center;background:#eef;border:1px solid #cbd; padding:0 6px;border-radius:999px;font-weight:600">0</span>' +
      '</div>' +

      // Linje 2: Interesse toggle + badge
      '<div style="display:flex; align-items:center; gap:6px; margin:2px 0 6px 0; white-space:nowrap;">' +
        '<label style="display:flex; align-items:center; gap:6px; min-width:0;"><input type="checkbox" id="tpEnableInt"> <span>Interesse</span></label>' +
        '<span id="tpIntCountBadge" style="margin-left:auto;min-width:18px;text-align:center;background:#efe;border:1px solid #cbd; padding:0 6px;border-radius:999px;font-weight:600">0</span>' +
      '</div>' +

      // SMS sektion – knap + status (TPSms binder på disse IDs)
      '<div id="tpSMS" style="border-top:1px solid #eee;margin-top:6px;padding-top:6px">' +
        '<div id="tpSMSStatus" style="color:#666;margin-bottom:6px">Indlæser SMS-status…</div>' +
        '<button id="tpSMSOneBtn" style="padding:5px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Aktivér</button>' +
      '</div>'
    );
    document.body.appendChild(wrap);

    // Sync toggles
    const cbMsg = wrap.querySelector('#tpEnableMsg');
    const cbInt = wrap.querySelector('#tpEnableInt');
    cbMsg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    cbInt.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    cbMsg.onchange = () => localStorage.setItem('tpPushEnableMsg', cbMsg.checked ? 'true' : 'false');
    cbInt.onchange = () => localStorage.setItem('tpPushEnableInt', cbInt.checked ? 'true' : 'false');

    // Badges opdateres via CustomEvents fra notifs.module
    const badgeMsg = wrap.querySelector('#tpMsgCountBadge');
    const badgeInt = wrap.querySelector('#tpIntCountBadge');
    document.addEventListener('tp:msg-count', (e) => {
      const prev = Number(localStorage.getItem('tpMsgPrevBadge')||0);
      setBadge(badgeMsg, e.detail?.count || 0);
      if ((e.detail?.count||0) > prev) pulse(badgeMsg);
      localStorage.setItem('tpMsgPrevBadge', String(e.detail?.count||0));
    });
    document.addEventListener('tp:int-count', (e) => {
      const prev = Number(localStorage.getItem('tpIntPrevBadge')||0);
      setBadge(badgeInt, e.detail?.count || 0);
      if ((e.detail?.count||0) > prev) pulse(badgeInt);
      localStorage.setItem('tpIntPrevBadge', String(e.detail?.count||0));
    });

    // ⚙️ menu
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
      menu.innerHTML = (
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
        '<div style="font-size:11px;color:#666">Kører v.' + TP_VERSION + '</div>'
      );
      document.body.appendChild(menu);

      // Pushover key + test + update
      const inp = menu.querySelector('#tpUserKeyMenu');
      const save = menu.querySelector('#tpSaveUserKeyMenu');
      const test = menu.querySelector('#tpTestPushoverBtn');
      const chk  = menu.querySelector('#tpCheckUpdate');
      inp.value = getUserKey();
      save.addEventListener('click', () => { setUserKey(inp.value); notify('USER-token gemt.'); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setUserKey(inp.value); notify('USER-token gemt.'); } });
      test.addEventListener('click', () => {
        try { if (window.TPNotifs && typeof window.TPNotifs.testPushover === 'function') window.TPNotifs.testPushover(); } catch(_){}
      });
      chk.addEventListener('click', async () => {
        try {
          const raw = await gmGET(SCRIPT_RAW_URL + '?t=' + Date.now());
          const m = raw.match(/@version\s+([0-9.]+)/);
          const remote = m ? m[1] : null;
          if (!remote) { notify('Kunne ikke læse remote version.'); return; }
          const cmp = versionCompare(remote, TP_VERSION);
          if (cmp > 0) { notify('Ny version: ' + remote + ' (du kører ' + TP_VERSION + '). Åbner…'); window.open(SCRIPT_RAW_URL, '_blank', 'noopener'); }
          else notify('Du kører nyeste version (' + TP_VERSION + ').');
        } catch { notify('Update-tjek fejlede.'); }
      });

      // Excel/CSV wiring via modul
      if (window.TPExcel && typeof window.TPExcel.attachToMenu === 'function') {
        window.TPExcel.attachToMenu(menu);
      } else {
        const pbh = menu.querySelector('#tpPBHint');
        if (pbh) pbh.textContent = 'Excel/CSV-modul ikke indlæst endnu.';
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

  /*──────── 2) Boot moduler ────────*/
  function boot() {
    injectUI();

    // Notifikationer (besked + interesse + pushover)
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

    // SMS toggle (binder på #tpSMS*)
    TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' });

    // Excel/CSV/GitHub – init konfiguration (gear-menu binder sig selv via attachToMenu)
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

    // **TPActions (Registrér “Intet svar”) — robust guard**
    if (typeof window.TPActions !== 'undefined' && typeof window.TPActions.install === 'function') {
      window.TPActions.install();
    }

    // Kør URL-processor for det tilfælde vi står i beacon-fanen
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
      root.TPActions = (typeof window.TPActions !== 'undefined') ? window.TPActions : undefined;
      console.info('[TP] bridged APIs to page window');
    } catch (e) {
      console.warn('[TP] bridge error', e);
    }
  }

  try { boot(); } catch (e) { console.warn('[TP][BOOT ERR]', e); }
})();
