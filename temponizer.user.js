// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.12.20
// @description  (UI med “safe” inline CSS: ingen decimaltal). Loader eksisterende moduler som før.
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
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js?v=7.12.20-safe
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js?v=7.12.20-safe
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js?v=7.12.20-safe
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js?v=7.12.9     /* beholder din stabile caller */
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/tp-actions.module.js?v=7.12.20-safe
// ==/UserScript==
/* eslint-env browser */
/* global TPNotifs, TPSms, TPExcel, TPCaller, TPActions, GM_getValue, GM_setValue */

(function () {
  'use strict';
  if (window.__TP_MAIN_ACTIVE__) return;
  window.__TP_MAIN_ACTIVE__ = Date.now();
  const TP_VERSION = '7.12.20';
  console.info('[TP][MAIN] v'+TP_VERSION+' loaded at', new Date().toISOString());

  // ---------- SAFE UI (ingen decimaltal i inline CSS) ----------
  function injectUI(){
    if (document.getElementById('tpPanel')) return;

    const wrap = document.createElement('div');
    wrap.id = 'tpPanel';
    // Kun værdier uden punktummer
    const s = wrap.style;
    s.position = 'fixed';
    s.right = '8px';
    s.bottom = '12px';
    s.zIndex = '2147483645';
    s.background = '#ffffff';
    s.border = '1px solid #d7d7d7';
    s.padding = '8px';
    s.borderRadius = '8px';
    s.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    s.fontSize = '12px';
    s.lineHeight = '20px';
    s.maxWidth = '260px';
    s.minWidth = '200px';
    // ingen box-shadow / rgba / opacity / transition her

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.gap = '6px';
    top.style.alignItems = 'center';
    top.style.marginBottom = '6px';

    const title = document.createElement('div');
    title.textContent = 'TP Notifikationer';
    title.style.fontWeight = '700';
    title.style.flex = '1';
    title.style.minWidth = '0';
    title.style.whiteSpace = 'nowrap';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';

    const gearBtn = document.createElement('button');
    gearBtn.id = 'tpGearBtn';
    gearBtn.title = 'Indstillinger';
    gearBtn.textContent = '⚙️';
    const g = gearBtn.style;
    g.width = '22px';
    g.height = '22px';
    g.lineHeight = '22px';
    g.textAlign = 'center';
    g.border = '1px solid #cccccc';
    g.borderRadius = '50%';
    g.background = '#ffffff';
    g.cursor = 'pointer';

    top.appendChild(title); top.appendChild(gearBtn);

    const rowMsg = document.createElement('div');
    rowMsg.style.display = 'flex';
    rowMsg.style.alignItems = 'center';
    rowMsg.style.gap = '6px';
    rowMsg.style.margin = '2px 0';

    const lblMsg = document.createElement('label');
    lblMsg.style.display = 'flex';
    lblMsg.style.gap = '6px';
    lblMsg.style.alignItems = 'center';
    lblMsg.style.minWidth = '0';
    const cbMsg = document.createElement('input'); cbMsg.type = 'checkbox'; cbMsg.id = 'tpEnableMsg';
    const txtMsg = document.createElement('span'); txtMsg.textContent = 'Besked';
    lblMsg.appendChild(cbMsg); lblMsg.appendChild(txtMsg);

    const badgeMsg = document.createElement('span');
    badgeMsg.id = 'tpMsgCountBadge';
    badgeMsg.textContent = '0';
    badgeMsg.style.marginLeft = 'auto';
    badgeMsg.style.minWidth = '18px';
    badgeMsg.style.textAlign = 'center';
    badgeMsg.style.background = '#eef2ff'; // hex uden punktum
    badgeMsg.style.border = '1px solid #ccd5ee';
    badgeMsg.style.padding = '0 6px';
    badgeMsg.style.borderRadius = '999px';
    badgeMsg.style.fontWeight = '600';

    rowMsg.appendChild(lblMsg); rowMsg.appendChild(badgeMsg);

    const rowInt = document.createElement('div');
    rowInt.style.display = 'flex';
    rowInt.style.alignItems = 'center';
    rowInt.style.gap = '6px';
    rowInt.style.margin = '2px 0 6px 0';

    const lblInt = document.createElement('label');
    lblInt.style.display = 'flex';
    lblInt.style.gap = '6px';
    lblInt.style.alignItems = 'center';
    lblInt.style.minWidth = '0';
    const cbInt = document.createElement('input'); cbInt.type = 'checkbox'; cbInt.id = 'tpEnableInt';
    const txtInt = document.createElement('span'); txtInt.textContent = 'Interesse';
    lblInt.appendChild(cbInt); lblInt.appendChild(txtInt);

    const badgeInt = document.createElement('span');
    badgeInt.id = 'tpIntCountBadge';
    badgeInt.textContent = '0';
    badgeInt.style.marginLeft = 'auto';
    badgeInt.style.minWidth = '18px';
    badgeInt.style.textAlign = 'center';
    badgeInt.style.background = '#e6ffe6';
    badgeInt.style.border = '1px solid #cce6cc';
    badgeInt.style.padding = '0 6px';
    badgeInt.style.borderRadius = '999px';
    badgeInt.style.fontWeight = '600';

    rowInt.appendChild(lblInt); rowInt.appendChild(badgeInt);

    const sms = document.createElement('div');
    sms.id = 'tpSMS';
    sms.style.borderTop = '1px solid #eeeeee';
    sms.style.marginTop = '6px';
    sms.style.paddingTop = '6px';

    const smsStatus = document.createElement('div');
    smsStatus.id = 'tpSMSStatus';
    smsStatus.textContent = 'Indlæser SMS-status…';
    smsStatus.style.color = '#666666';
    smsStatus.style.marginBottom = '6px';

    const smsBtn = document.createElement('button');
    smsBtn.id = 'tpSMSOneBtn';
    smsBtn.textContent = 'Aktivér';
    const sb = smsBtn.style;
    sb.padding = '5px 8px';
    sb.border = '1px solid #cccccc';
    sb.borderRadius = '6px';
    sb.background = '#ffffff';
    sb.cursor = 'pointer';

    sms.appendChild(smsStatus); sms.appendChild(smsBtn);

    wrap.appendChild(top);
    wrap.appendChild(rowMsg);
    wrap.appendChild(rowInt);
    wrap.appendChild(sms);

    (document.body || document.documentElement).appendChild(wrap);

    // toggles
    cbMsg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    cbInt.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    cbMsg.onchange = ()=> localStorage.setItem('tpPushEnableMsg', cbMsg.checked?'true':'false');
    cbInt.onchange = ()=> localStorage.setItem('tpPushEnableInt', cbInt.checked?'true':'false');

    document.addEventListener('tp:msg-count', e => { try { badgeMsg.textContent = String((e.detail && e.detail.count) || 0); } catch{} });
    document.addEventListener('tp:int-count', e => { try { badgeInt.textContent = String((e.detail && e.detail.count) || 0); } catch{} });

    // Gear menu (også “safe” styles)
    let menu = null;
    function buildMenu(){
      if (menu) return menu;
      menu = document.createElement('div');
      const ms = menu.style;
      ms.position = 'fixed';
      ms.right = '8px';
      ms.background = '#ffffff';
      ms.border = '1px solid #cccccc';
      ms.borderRadius = '10px';
      ms.padding = '12px';
      ms.width = '380px';
      ms.maxWidth = '96vw';
      ms.maxHeight = '70vh';
      ms.overflow = 'auto';
      ms.display = 'none';
      ms.zIndex = '2147483646';
      ms.fontFamily = s.fontFamily;
      ms.fontSize = s.fontSize;
      ms.lineHeight = s.lineHeight;

      function place(){ ms.bottom = (wrap.offsetHeight + 18) + 'px'; }
      place(); window.addEventListener('resize', place);

      const h = document.createElement('div');
      h.textContent = 'Indstillinger';
      h.style.fontWeight = '700';
      h.style.marginBottom = '8px';
      menu.appendChild(h);

      const lab = document.createElement('div');
      lab.textContent = 'Pushover USER-token';
      lab.style.fontWeight = '600';
      lab.style.marginBottom = '4px';
      menu.appendChild(lab);

      const inp = document.createElement('input');
      inp.id='tpUserKeyMenu';
      inp.type='text';
      inp.placeholder='uxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const is = inp.style;
      is.width = '100%'; is.boxSizing = 'border-box';
      is.padding = '6px'; is.border = '1px solid #cccccc'; is.borderRadius = '6px';
      try { inp.value = (GM_getValue('tpUserKey')||'').trim(); } catch {}
      menu.appendChild(inp);

      const btnRow = document.createElement('div');
      btnRow.style.marginTop = '6px';
      btnRow.style.display = 'flex';
      btnRow.style.gap = '6px';
      btnRow.style.flexWrap = 'wrap';
      btnRow.style.alignItems = 'center';
      function mkBtn(txt,id){ const b=document.createElement('button'); b.textContent=txt; b.id=id; const bs=b.style; bs.padding='6px 8px'; bs.border='1px solid #cccccc'; bs.borderRadius='6px'; bs.background='#ffffff'; bs.cursor='pointer'; return b; }
      const bSave = mkBtn('Gem','tpSaveUserKeyMenu');
      const bTest = mkBtn('🧪 Test Pushover','tpTestPushoverBtn');
      const bUpd  = mkBtn('🔄 Søg opdatering','tpCheckUpdate');
      btnRow.appendChild(bSave); btnRow.appendChild(bTest); btnRow.appendChild(bUpd);
      menu.appendChild(btnRow);

      const foot = document.createElement('div');
      foot.style.marginTop = '10px';
      foot.style.borderTop = '1px solid #eeeeee';
      const fv = document.createElement('div');
      fv.style.fontSize = '11px';
      fv.style.color = '#666666';
      fv.textContent = 'Kører v.'+TP_VERSION;
      foot.appendChild(fv);
      menu.appendChild(foot);

      // handlers
      bSave.addEventListener('click', ()=>{ try { GM_setValue('tpUserKey', (inp.value||'').trim()); } catch {} });
      inp.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); try { GM_setValue('tpUserKey', (inp.value||'').trim()); } catch {} } });
      bTest.addEventListener('click', ()=>{ try { TPNotifs?.testPushover && TPNotifs.testPushover(); } catch {} });
      bUpd .addEventListener('click', ()=>{ try { window.open('https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js','_blank','noopener'); } catch {} });

      // Excel-menuen kobler selv på hvis TPExcel.attachToMenu findes:
      try { if (window.TPExcel && typeof TPExcel.attachToMenu==='function') TPExcel.attachToMenu(menu); } catch {}

      (document.body || document.documentElement).appendChild(menu);
      return menu;
    }
    function toggleMenu(){
      const m = buildMenu();
      m.style.display = (m.style.display==='block') ? 'none' : 'block';
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

  // boot
  try { injectUI(); } catch(e){ console.warn('[TP][MAIN] UI inject error', e); }

  // Moduler (beholder dine nuværende endpoints/konfiguration)
  try { TPNotifs?.install && TPNotifs.install({
    pushoverToken: 'a27du13k8h2yf8p4wabxeukthr1fu7',
    pollMs: 15000, suppressMs: 45000,
    msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
    interestUrl: location.origin + '/index.php?page=freevagter',
    enableInterestNameHints: true,
    rawPhonebookUrl: 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache'
  }); } catch(_) {}

  try { TPSms?.install && TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' }); } catch(_) {}

  try { TPExcel?.install && TPExcel.install({
    owner: 'danieldamdk', repo: 'temponizer-notifikation', branch: 'main',
    csvPath: 'vikarer.csv', cacheKeyCSV: 'tpCSVCache',
    printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
    settingsUrl: location.origin + '/index.php?page=showmy_settings'
  }); } catch(_) {}

  try { TPCaller?.install && TPCaller.install({
    queueSuffix: '*1500', queueCode: '1500',
    rawPhonebookUrl: 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache',
    openInNewTab: true, debounceMs: 10000, autohideMs: 8000
  }); TPCaller?.processFromUrl && TPCaller.processFromUrl(); } catch(_) {}

  try { TPActions?.install && TPActions.install(); } catch(e){ console.warn('[TP][main] TPActions install error', e); }
})();
