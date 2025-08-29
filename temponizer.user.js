// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.12.24
// @description  7.12.6-funktionalitet, men UI injiceres uden inline-decimaler (safe CSS via <style> + klasser).
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
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js?v=7.12.23
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js?v=7.12.23
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js?v=7.12.23
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js?v=7.12.24
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/tp-actions.module.js?v=7.12.23
// ==/UserScript==
/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX, TPNotifs, TPSms, TPExcel, TPCaller, TPActions */

(function () {
  'use strict';

  if (window.__TP_MAIN_ACTIVE__) return;
  window.__TP_MAIN_ACTIVE__ = Date.now();

  const TP_VERSION   = '7.12.24';
  const CSV_JSDELIVR = 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv';
  const SCRIPT_RAW_URL = 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js';

  const notify = (t)=>{ try { new Notification('Temponizer', { body: t }); } catch(_){} };
  const gmGET = (url)=> new Promise((resolve, reject)=>{
    GM_xmlhttpRequest({ method:'GET', url, headers:{ 'Accept':'*/*' },
      onload:r=> (r.status>=200&&r.status<300)? resolve(r.responseText):reject(new Error('HTTP '+r.status)),
      onerror: reject });
  });
  function versionCompare(a,b){const pa=String(a).split('.').map(n=>+n||0),pb=String(b).split('.').map(n=>+n||0),L=Math.max(pa.length,pb.length);for(let i=0;i<L;i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1}return 0}
  function getUserKey(){ try { return (GM_getValue('tpUserKey')||'').trim(); } catch(_) { return ''; } }
  function setUserKey(v){ try { GM_setValue('tpUserKey', (v||'').trim()); } catch(_){} }

  // ---------- Ultra-safe CSS (ingen decimaler i tal) ----------
  function injectStylesOnce(){
    if (document.getElementById('tpSafeStyles')) return;
    const css =
      // panel
      '#tpPanel{position:fixed;right:8px;bottom:12px;z-index:2147483645;background:#ffffff;border:1px solid #d7d7d7;padding:8px;border-radius:8px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:20px;max-width:260px;min-width:200px;box-shadow:0 8px 24px #00000026}' +
      '.tp-row{display:flex;align-items:center;gap:6px}' +
      '.tp-row-margin{margin:2px 0}' +
      '.tp-row-margin2{margin:2px 0 6px 0}' +
      '.tp-title{font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.tp-gear{width:22px;height:22px;line-height:22px;text-align:center;border:1px solid #cccccc;border-radius:9999px;background:#ffffff;cursor:pointer}' +
      '.tp-badge{margin-left:auto;min-width:18px;text-align:center;background:#eef2ff;border:1px solid #ccd5ee;padding:0 6px;border-radius:999px;font-weight:600}' +
      '.tp-badge-green{background:#e6ffe6;border-color:#cce6cc}' +
      '#tpSMS{border-top:1px solid #eeeeee;margin-top:6px;padding-top:6px}' +
      '#tpSMSStatus{color:#666666;margin-bottom:6px}' +
      '#tpSMSOneBtn{padding:5px 8px;border:1px solid #cccccc;border-radius:6px;background:#ffffff;cursor:pointer}' +
      // gear menu
      '#tpGearMenu{position:fixed;right:8px;z-index:2147483646;background:#ffffff;border:1px solid #cccccc;border-radius:10px;box-shadow:0 12px 36px #00000038;padding:12px;width:380px;max-width:calc(100vw - 16px);max-height:70vh;overflow:auto;display:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:20px}' +
      '.tp-hdr{font-weight:700;margin-bottom:8px}' +
      '.tp-subhdr{font-weight:600;margin-bottom:4px}' +
      '.tp-input{width:100%;box-sizing:border-box;padding:6px;border:1px solid #cccccc;border-radius:6px}' +
      '.tp-btnrow{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
      '.tp-btn{padding:6px 8px;border:1px solid #cccccc;border-radius:6px;background:#ffffff;cursor:pointer}' +
      '.tp-sep{border-top:1px solid #eeeeee;margin:10px 0}' +
      '.tp-foot{font-size:11px;color:#666666}';
    const st = document.createElement('style');
    st.id = 'tpSafeStyles';
    st.type = 'text/css';
    st.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(st);
  }

  function injectUI(){
    if (document.getElementById('tpPanel')) return;
    injectStylesOnce();

    // panel
    const wrap = document.createElement('div');
    wrap.id = 'tpPanel';

    const top = document.createElement('div');
    top.className = 'tp-row';
    top.style.marginBottom = '6px';

    const title = document.createElement('div');
    title.className = 'tp-title';
    title.textContent = 'TP Notifikationer';

    const gearBtn = document.createElement('button');
    gearBtn.id = 'tpGearBtn';
    gearBtn.className = 'tp-gear';
    gearBtn.title = 'Indstillinger';
    gearBtn.textContent = '⚙️';

    top.appendChild(title); top.appendChild(gearBtn);

    const rowMsg = document.createElement('div');
    rowMsg.className = 'tp-row tp-row-margin';

    const lblMsg = document.createElement('label');
    lblMsg.className = 'tp-row';
    const cbMsg = document.createElement('input'); cbMsg.type = 'checkbox'; cbMsg.id = 'tpEnableMsg';
    const txtMsg = document.createElement('span'); txtMsg.textContent = 'Besked';
    lblMsg.appendChild(cbMsg); lblMsg.appendChild(txtMsg);

    const badgeMsg = document.createElement('span');
    badgeMsg.id = 'tpMsgCountBadge';
    badgeMsg.className = 'tp-badge';
    badgeMsg.textContent = '0';

    rowMsg.appendChild(lblMsg); rowMsg.appendChild(badgeMsg);

    const rowInt = document.createElement('div');
    rowInt.className = 'tp-row tp-row-margin2';

    const lblInt = document.createElement('label');
    lblInt.className = 'tp-row';
    const cbInt = document.createElement('input'); cbInt.type = 'checkbox'; cbInt.id = 'tpEnableInt';
    const txtInt = document.createElement('span'); txtInt.textContent = 'Interesse';
    lblInt.appendChild(cbInt); lblInt.appendChild(txtInt);

    const badgeInt = document.createElement('span');
    badgeInt.id = 'tpIntCountBadge';
    badgeInt.className = 'tp-badge tp-badge-green';
    badgeInt.textContent = '0';

    rowInt.appendChild(lblInt); rowInt.appendChild(badgeInt);

    const sms = document.createElement('div');
    sms.id = 'tpSMS';
    const smsStatus = document.createElement('div');
    smsStatus.id = 'tpSMSStatus';
    smsStatus.textContent = 'Indlæser SMS-status…';
    const smsBtn = document.createElement('button');
    smsBtn.id = 'tpSMSOneBtn';
    smsBtn.textContent = 'Aktivér';
    sms.appendChild(smsStatus); sms.appendChild(smsBtn);

    wrap.appendChild(top);
    wrap.appendChild(rowMsg);
    wrap.appendChild(rowInt);
    wrap.appendChild(sms);

    // append panel (ingen inline styles på descendants ved append → undgår '.'-kollisionshook)
    (document.body || document.documentElement).appendChild(wrap);

    // toggles
    cbMsg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    cbInt.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    cbMsg.onchange = ()=> localStorage.setItem('tpPushEnableMsg', cbMsg.checked?'true':'false');
    cbInt.onchange = ()=> localStorage.setItem('tpPushEnableInt', cbInt.checked?'true':'false');

    // badges live-opdatering
    document.addEventListener('tp:msg-count', e => { try { badgeMsg.textContent = String(e.detail?.count||0); } catch{} });
    document.addEventListener('tp:int-count', e => { try { badgeInt.textContent = String(e.detail?.count||0); } catch{} });

    // gear menu (ingen inline style)
    let menu = null;
    function buildMenu(){
      if (menu) return menu;
      menu = document.createElement('div');
      menu.id = 'tpGearMenu';
      // placering under panelet
      menu.style.bottom = (wrap.offsetHeight + 18) + 'px';

      // indhold
      const hdr = document.createElement('div'); hdr.className='tp-hdr'; hdr.textContent='Indstillinger';
      const box = document.createElement('div'); box.style.marginBottom='10px';

      const sub1 = document.createElement('div'); sub1.className='tp-subhdr'; sub1.textContent='Pushover USER-token';
      const inp = document.createElement('input'); inp.id='tpUserKeyMenu'; inp.type='text'; inp.placeholder='uxxxxxxxxxxxxxxxxxxxxxxxxxxx'; inp.className='tp-input';
      try { inp.value = getUserKey(); } catch {}

      const btnRow = document.createElement('div'); btnRow.className='tp-btnrow';
      function mkBtn(txt,id){ const b=document.createElement('button'); b.textContent=txt; b.id=id; b.className='tp-btn'; return b; }
      const bSave = mkBtn('Gem','tpSaveUserKeyMenu');
      const bTest = mkBtn('🧪 Test Pushover','tpTestPushoverBtn');
      const bUpd  = mkBtn('🔄 Søg opdatering','tpCheckUpdate');

      btnRow.appendChild(bSave); btnRow.appendChild(bTest); btnRow.appendChild(bUpd);
      box.appendChild(sub1); box.appendChild(inp); box.appendChild(btnRow);

      const sep = document.createElement('div'); sep.className='tp-sep';

      const foot = document.createElement('div'); foot.className='tp-foot'; foot.textContent='Kører v.'+TP_VERSION;

      menu.appendChild(hdr);
      menu.appendChild(box);
      menu.appendChild(sep);
      // Excel/CSV hook indsættes af TPExcel.attachToMenu(menu) senere
      menu.appendChild(document.createElement('div')); // placeholder / ingen inline-style
      menu.appendChild(document.createElement('div')); // plads til flere sektioner hvis TPExcel vil tilføje
      menu.appendChild(document.createElement('div'));
      menu.appendChild(foot);

      (document.body || document.documentElement).appendChild(menu);

      // handlers
      bSave.addEventListener('click', ()=>{ setUserKey(inp.value); notify('USER-token gemt.'); });
      inp.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); setUserKey(inp.value); notify('USER-token gemt.'); } });
      bTest.addEventListener('click', ()=>{ try { if (typeof TPNotifs?.testPushover === 'function') TPNotifs.testPushover(); else notify('TPNotifs er ikke klar endnu.'); } catch { notify('Kunne ikke køre test.'); } });
      bUpd .addEventListener('click', async ()=>{
        try {
          const raw = await gmGET(SCRIPT_RAW_URL + '?t=' + Date.now());
          const m = raw.match(/@version\s+([0-9.]+)/);
          const remote = m ? m[1] : null;
          if (!remote) return notify('Kunne ikke læse remote version.');
          const cmp = versionCompare(remote, TP_VERSION);
          if (cmp > 0) { notify(`Ny version: ${remote} (du kører ${TP_VERSION}). Åbner…`); window.open(SCRIPT_RAW_URL, '_blank', 'noopener'); }
          else notify(`Du kører nyeste version (${TP_VERSION}).`);
        } catch { notify('Update-tjek fejlede.'); }
      });

      // Excel-menu binder sig her, uden inline-styles fra os
      try { if (window.TPExcel?.attachToMenu) TPExcel.attachToMenu(menu); } catch {}
      return menu;
    }

    function toggleMenu(){
      const m = buildMenu();
      m.style.display = (m.style.display==='block')?'none':'block';
      if (m.style.display==='block'){
        const outside = (e)=>{ if (!m.contains(e.target) && e.target !== gearBtn){ m.style.display='none'; cleanup(); } };
        const esc = (e)=>{ if (e.key==='Escape'){ m.style.display='none'; cleanup(); } };
        function cleanup(){ document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); }
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', esc, true);
      }
    }
    gearBtn.addEventListener('click', toggleMenu);
  }

  function boot(){
    console.info('[TP][MAIN] v'+TP_VERSION+' loaded at', new Date().toISOString());
    injectUI();

    // Notifikationer
    try { TPNotifs.install({
      pushoverToken: 'a27du13k8h2yf8p4wabxeukthr1fu7',
      pollMs: 15000,
      suppressMs: 45000,
      msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
      interestUrl: location.origin + '/index.php?page=freevagter',
      enableInterestNameHints: true,
      rawPhonebookUrl: CSV_JSDELIVR,
      cacheKeyCSV: 'tpCSVCache'
    }); } catch(_){}

    // SMS
    try { TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' }); } catch(_){}

    // Excel
    try { TPExcel.install({
      owner: 'danieldamdk',
      repo: 'temponizer-notifikation',
      branch: 'main',
      csvPath: 'vikarer.csv',
      cacheKeyCSV: 'tpCSVCache',
      printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
      settingsUrl: location.origin + '/index.php?page=showmy_settings'
    }); } catch(_){}

    // Caller
    try {
      TPCaller.install({
        queueSuffix: '*1500',
        queueCode: '1500',
        rawPhonebookUrl: CSV_JSDELIVR,
        cacheKeyCSV: 'tpCSVCache',
        openInNewTab: true,
        debounceMs: 10000,
        autohideMs: 8000
      });
      TPCaller?.processFromUrl && TPCaller.processFromUrl().catch(()=>{});
    } catch(_){}

    // Actions (Registrér “Intet svar”)
    try { window.TPActions?.install && window.TPActions.install(); } catch(_){}

    // Bridge for DevTools
    try {
      const root = (typeof unsafeWindow!=='undefined'? unsafeWindow : window);
      root.TPNotifs = TPNotifs; root.TPSms = TPSms; root.TPExcel = TPExcel; root.TPCaller = TPCaller; root.TPActions = window.TPActions;
      console.info('[TP] bridged APIs to page window');
    } catch(e){ /* noop */ }
  }

  try { boot(); } catch(e){ console.warn('[TP][BOOT ERR]', e); }
})();
