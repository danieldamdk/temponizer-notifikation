// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.12.4
// @description  (1) Besked/Interesse + Pushover + toasts (TPNotifs). (2) Caller-toast via Communicator-beacon (TPCaller). (3) SMS on/off (TPSms). (4) Excel→CSV→Upload (TPExcel). (5) “Registrér intet svar” (TPActions). Kompakt UI + ⚙️-menu.
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
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @require      https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/notifs.module.js
// @require      https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/sms.module.js
// @require      https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/excel.module.js
// @require      https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/caller.module.js
// @require      https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/tp-actions.module.js
// ==/UserScript==

/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX, TPNotifs, TPSms, TPExcel, TPCaller, TPActions */

(function () {
  'use strict';

  const TP_VERSION   = '7.12.4';
  const PUSH_TOKEN   = 'a27du13k8h2yf8p4wabxeukthr1fu7'; // din app-token
  const SCRIPT_RAW   = 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js';
  const CSV_JSDELIVR = 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv';

  function getUserKey() { try { return (GM_getValue('tpUserKey') || '').trim(); } catch (_) { return ''; } }
  function setUserKey(v) { try { GM_setValue('tpUserKey', (v || '').trim()); } catch (_) {} }
  function notify(text){ try { new Notification('Temponizer', { body: text }); } catch(_) {} }

  // helpers
  function gmGET(url){
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        headers: { 'Accept': '*/*' },
        onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
        onerror: reject
      });
    });
  }
  function versionCompare(a,b){
    const pa = String(a).split('.').map(n=>parseInt(n,10)||0);
    const pb = String(b).split('.').map(n=>parseInt(n,10)||0);
    const len = Math.max(pa.length, pb.length);
    for (let i=0;i<len;i++){ const x=pa[i]||0, y=pb[i]||0; if (x>y) return 1; if (x<y) return -1; }
    return 0;
  }
  function setBadge(el, n){ if(el) el.textContent = String(Number(n||0)); }
  function pulse(el){ if(!el) return; el.animate([{ transform:'scale(1)' }, { transform:'scale(1.12)' }, { transform:'scale(1)' }], { duration:320, easing:'ease-out' }); }

  /** Fallback: send 2 testbeskeder direkte til Pushover */
  function pushTestFallback(){
    const user = getUserKey();
    if (!user) { notify('Indsæt din Pushover USER token i ⚙️ først.'); return; }
    const send = (msg) => GM_xmlhttpRequest({
      method:'POST',
      url:'https://api.pushover.net/1/messages.json',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      data:'token='+encodeURIComponent(PUSH_TOKEN)+'&user='+encodeURIComponent(user)+'&message='+encodeURIComponent(msg)
    });
    const ts = new Date().toLocaleTimeString();
    send('🧪 [TEST] Besked-kanal OK — '+ts);
    setTimeout(()=> send('🧪 [TEST] Interesse-kanal OK — '+ts), 600);
    notify('Sendte Pushover test (Besked + Interesse).');
  }

  /** UI */
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

      '<div id="tpSMS" style="border-top:1px solid #eee;margin-top:6px;padding-top:6px">' +
        '<div id="tpSMSStatus" style="color:#666;margin-bottom:6px">Indlæser SMS-status…</div>' +
        '<button id="tpSMSOneBtn" style="padding:5px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Aktivér</button>' +
      '</div>'
    );
    document.body.appendChild(wrap);

    // toggles
    const cbMsg = wrap.querySelector('#tpEnableMsg');
    const cbInt = wrap.querySelector('#tpEnableInt');
    cbMsg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    cbInt.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    cbMsg.onchange = () => localStorage.setItem('tpPushEnableMsg', cbMsg.checked ? 'true' : 'false');
    cbInt.onchange = () => localStorage.setItem('tpPushEnableInt', cbInt.checked ? 'true' : 'false');

    // badges via events
    const badgeMsg = wrap.querySelector('#tpMsgCountBadge');
    const badgeInt = wrap.querySelector('#tpIntCountBadge');
    document.addEventListener('tp:msg-count', (e) => {
      const prev = Number(localStorage.getItem('tpMsgPrevBadge')||0);
      const n = e.detail?.count || 0;
      setBadge(badgeMsg, n);
      if (n > prev) pulse(badgeMsg);
      localStorage.setItem('tpMsgPrevBadge', String(n));
    });
    document.addEventListener('tp:int-count', (e) => {
      const prev = Number(localStorage.getItem('tpIntPrevBadge')||0);
      const n = e.detail?.count || 0;
      setBadge(badgeInt, n);
      if (n > prev) pulse(badgeInt);
      localStorage.setItem('tpIntPrevBadge', String(n));
    });

    // gear menu
    const gearBtn = wrap.querySelector('#tpGearBtn');
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

      // wire pushover key + test + update
      const inp = menu.querySelector('#tpUserKeyMenu');
      const save = menu.querySelector('#tpSaveUserKeyMenu');
      const test = menu.querySelector('#tpTestPushoverBtn');
      const chk  = menu.querySelector('#tpCheckUpdate');

      inp.value = getUserKey();
      save.addEventListener('click', () => { setUserKey(inp.value); notify('USER-token gemt.'); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setUserKey(inp.value); notify('USER-token gemt.'); } });

      // robust Pushover-test (wait + fallback)
      test.addEventListener('click', async () => {
        const tryCall = () => (window.TPNotifs && typeof window.TPNotifs.testPushover === 'function');
        let ok = tryCall();
        let tries = 0;
        while (!ok && tries < 10) { // ~1s total
          await new Promise(r=>setTimeout(r,100));
          ok = tryCall(); tries++;
        }
        if (ok){
          try { window.TPNotifs.testPushover(); }
          catch { pushTestFallback(); }
        } else {
          pushTestFallback();
        }
      });

      // version check
      chk.addEventListener('click', async () => {
        try {
          const raw = await gmGET(SCRIPT_RAW + '?t=' + Date.now());
          const m = raw.match(/@version\s+([0-9.]+)/);
          const remote = m ? m[1] : null;
          if (!remote) { notify('Kunne ikke læse remote version.'); return; }
          const cmp = versionCompare(remote, TP_VERSION);
          if (cmp > 0) { notify('Ny version: ' + remote + ' (du kører ' + TP_VERSION + '). Åbner…'); window.open(SCRIPT_RAW, '_blank', 'noopener'); }
          else notify('Du kører nyeste version (' + TP_VERSION + ').');
        } catch { notify('Update-tjek fejlede.'); }
      });

      // Wire Excel/CSV via modul (samme UI som 7.11.4)
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
        const outside = (e) => { if (!m.contains(e.target) && e.target !== gearBtn) { m.style.display = 'none'; cleanup(); } };
        const esc = (e) => { if (e.key === 'Escape') { m.style.display = 'none'; cleanup(); } };
        function cleanup() { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); }
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', esc, true);
      }
    }
    gearBtn.addEventListener('click', toggleMenu);
  }

  /** Boot */
  function boot() {
    injectUI();

    // Notifikationer
    TPNotifs.install({
      pushoverToken: PUSH_TOKEN,
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
    if (TPCaller && typeof TPCaller.processFromUrl === 'function') {
      TPCaller.processFromUrl().catch(()=>{});
    }

    // Registrér “Intet svar”
    if (typeof window.TPActions !== 'undefined' && typeof window.TPActions.install === 'function') {
      window.TPActions.install();
    }

    // Bridge til page for nem debug
    try {
      const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
      root.TPNotifs = TPNotifs;
      root.TPSms    = TPSms;
      root.TPExcel  = TPExcel;
      root.TPCaller = TPCaller;
      root.TPActions= (typeof window.TPActions !== 'undefined') ? window.TPActions : undefined;
      console.info('[TP][MAIN] v'+TP_VERSION+' loaded at', new Date().toISOString());
    } catch (e) {
      console.warn('[TP] bridge error', e);
    }
  }

  try { boot(); } catch (e) { console.warn('[TP][BOOT ERR]', e); }
})();
