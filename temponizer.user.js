// ==UserScript==
// @name         Temponizer → Pushover + Toast + Caller-Toast + SMS-toggle + Excel→CSV (AjourCare)
// @namespace    ajourcare.dk
// @version      7.12.16
// @description  (1) Besked/Interesse + Pushover + toasts, (2) Caller-toast, (3) SMS on/off, (4) Excel→CSV→GitHub. Kompakt UI + ⚙️.
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
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js?v=7.12.15
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js?v=7.12.15
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js?v=7.12.15
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js?v=7.12.12-hard2
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/modules/tp-actions.module.js?v=2025-08-29-02
// ==/UserScript==
/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX, TPNotifs, TPSms, TPExcel, TPCaller, TPActions */

(function () {
  'use strict';

  // --- SAFETY SHIM ----------------------------------------------------------
  // Nogle Temponizer-sider monkeypatcher appendChild og parser CSS-strings.
  // Hvis de ser ".22" osv., kaster de "Unexpected token '.'" under append.
  // Denne shim fanger KUN den fejl, omskriver styles (".5" -> "0.5", ".22s" -> "0.22s"),
  // og prøver igen. Ingen effekt når der ikke er fejl.
  (function installAppendChildShim(){
    const ORIG = Node.prototype.appendChild;
    if (ORIG.__tpShimmed) return; // undgå dobbelt
    function sanitizeStyleText(css){
      try {
        if (!css || typeof css !== 'string') return css;
        let s = css;
        // .8 / .22 / .35 -> 0.8 / 0.22 / 0.35
        s = s.replace(/([:, (])\.(\d+)/g, '$10.$2');
        // 'transition: opacity .22s' -> 'transition: opacity 0.22s'
        s = s.replace(/(\btransition\s*:\s*[^;]*?)\s\.(\d+)s/gi, '$1 0.$2s');
        // 'opacity:.8' -> 'opacity: 0.8'
        s = s.replace(/\bopacity\s*:\s*\.(\d+)/gi, 'opacity: 0.$1');
        // font shorthand med decimal line-height: 'font: 12px/1.4 ...' -> split ud
        if (/font\s*:\s*[^;]*\/\d+\.\d/.test(s)) {
          // Lad siden ignorere shorthand ved at fjerne font-shorthand helt;
          // vi sætter fontFamily/Size/LineHeight via JS bagefter.
          s = s.replace(/\bfont\s*:[^;]+/g, '');
        }
        return s;
      } catch { return css; }
    }
    function sanitizeDeep(node){
      try {
        if (node && node.nodeType === 1) {
          const el = node;
          const css = el.getAttribute('style');
          if (css && /\.\d/.test(css)) el.setAttribute('style', sanitizeStyleText(css));
        }
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, null, false);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          const css = el.getAttribute && el.getAttribute('style');
          if (css && /\.\d/.test(css)) el.setAttribute('style', sanitizeStyleText(css));
        }
      } catch {/* ignore */}
    }
    Node.prototype.appendChild = function(child){
      try {
        return ORIG.call(this, child);
      } catch(e){
        if (e && String(e.message||'').indexOf("Unexpected token '.'") !== -1) {
          try { sanitizeDeep(child); } catch {}
          return ORIG.call(this, child);
        }
        throw e;
      }
    };
    Node.prototype.appendChild.__tpShimmed = true;
  })();
  // --------------------------------------------------------------------------

  if (window.__TP_MAIN_ACTIVE__) return;
  window.__TP_MAIN_ACTIVE__ = Date.now();

  const TP_VERSION   = '7.12.16';
  const CSV_JSDELIVR = 'https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/vikarer.csv';
  const SCRIPT_RAW_URL = 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js';

  function notify(t){ try { new Notification('Temponizer', { body: t }); } catch(_){} }
  function gmGET(url){ return new Promise((resolve,reject)=>{
    GM_xmlhttpRequest({ method:'GET', url, headers:{ 'Accept':'*/*' },
      onload:r=> (r.status>=200&&r.status<300)? resolve(r.responseText):reject(new Error('HTTP '+r.status)),
      onerror: reject });
  });}
  function versionCompare(a,b){const pa=String(a).split('.').map(n=>+n||0),pb=String(b).split('.').map(n=>+n||0),L=Math.max(pa.length,pb.length);for(let i=0;i<L;i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1}return 0}
  function getUserKey(){ try { return (GM_getValue('tpUserKey')||'').trim(); } catch(_) { return ''; } }
  function setUserKey(v){ try { GM_setValue('tpUserKey', (v||'').trim()); } catch(_){} }

  // SIKKER UI (ingen risky CSS før efter append, og ingen shorthand med decimaler)
  function injectUI(){
    if (document.getElementById('tpPanel')) return;

    const wrap = document.createElement('div');
    wrap.id = 'tpPanel';

    // Append FØR styling (så hvis Temponizer evaluerer style-attributter, er de tomme her)
    (document.body || document.documentElement).appendChild(wrap);

    // Nu styles – kun "sikre" egenskaber
    wrap.style.position='fixed'; wrap.style.right='8px'; wrap.style.bottom='12px';
    wrap.style.zIndex='2147483645'; wrap.style.background='#ffffff'; wrap.style.border='1px solid #d7d7d7';
    wrap.style.padding='8px'; wrap.style.borderRadius='8px';
    wrap.style.fontFamily='system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    wrap.style.fontSize='12px'; wrap.style.lineHeight='20px';
    wrap.style.maxWidth='260px'; wrap.style.minWidth='200px';

    // topbar
    const top = document.createElement('div');
    wrap.appendChild(top);
    top.style.display='flex'; top.style.gap='6px'; top.style.alignItems='center'; top.style.marginBottom='6px';
    const title = document.createElement('div'); title.textContent='TP Notifikationer';
    title.style.fontWeight='700'; title.style.flex='1'; title.style.minWidth='0';
    title.style.whiteSpace='nowrap'; title.style.overflow='hidden'; title.style.textOverflow='ellipsis';
    const gearBtn = document.createElement('button');
    gearBtn.id='tpGearBtn'; gearBtn.title='Indstillinger'; gearBtn.textContent='⚙️';
    gearBtn.style.width='22px'; gearBtn.style.height='22px'; gearBtn.style.lineHeight='22px';
    gearBtn.style.textAlign='center'; gearBtn.style.border='1px solid #cccccc'; gearBtn.style.borderRadius='50%';
    gearBtn.style.background='#ffffff'; gearBtn.style.cursor='pointer';
    top.appendChild(title); top.appendChild(gearBtn);

    // row: Besked
    const rowMsg=document.createElement('div'); wrap.appendChild(rowMsg);
    rowMsg.style.display='flex'; rowMsg.style.alignItems='center'; rowMsg.style.gap='6px'; rowMsg.style.margin='2px 0';
    const lblMsg=document.createElement('label'); rowMsg.appendChild(lblMsg);
    lblMsg.style.display='flex'; lblMsg.style.gap='6px'; lblMsg.style.alignItems='center'; lblMsg.style.minWidth='0';
    const cbMsg=document.createElement('input'); cbMsg.type='checkbox'; cbMsg.id='tpEnableMsg';
    const txtMsg=document.createElement('span'); txtMsg.textContent='Besked';
    lblMsg.appendChild(cbMsg); lblMsg.appendChild(txtMsg);
    const badgeMsg=document.createElement('span'); rowMsg.appendChild(badgeMsg);
    badgeMsg.id='tpMsgCountBadge'; badgeMsg.textContent='0';
    badgeMsg.style.marginLeft='auto'; badgeMsg.style.minWidth='18px'; badgeMsg.style.textAlign='center';
    badgeMsg.style.background='#eeeeff'; badgeMsg.style.border='1px solid #ccbbdd';
    badgeMsg.style.padding='0 6px'; badgeMsg.style.borderRadius='999px'; badgeMsg.style.fontWeight='600';

    // row: Interesse
    const rowInt=document.createElement('div'); wrap.appendChild(rowInt);
    rowInt.style.display='flex'; rowInt.style.alignItems='center'; rowInt.style.gap='6px'; rowInt.style.margin='2px 0 6px 0';
    const lblInt=document.createElement('label'); rowInt.appendChild(lblInt);
    lblInt.style.display='flex'; lblInt.style.gap='6px'; lblInt.style.alignItems='center'; lblInt.style.minWidth='0';
    const cbInt=document.createElement('input'); cbInt.type='checkbox'; cbInt.id='tpEnableInt';
    const txtInt=document.createElement('span'); txtInt.textContent='Interesse';
    lblInt.appendChild(cbInt); lblInt.appendChild(txtInt);
    const badgeInt=document.createElement('span'); rowInt.appendChild(badgeInt);
    badgeInt.id='tpIntCountBadge'; badgeInt.textContent='0';
    badgeInt.style.marginLeft='auto'; badgeInt.style.minWidth='18px'; badgeInt.style.textAlign='center';
    badgeInt.style.background='#eeffee'; badgeInt.style.border='1px solid #ccbbdd';
    badgeInt.style.padding='0 6px'; badgeInt.style.borderRadius='999px'; badgeInt.style.fontWeight='600';

    // SMS
    const sms=document.createElement('div'); wrap.appendChild(sms);
    sms.id='tpSMS'; sms.style.borderTop='1px solid #eeeeee'; sms.style.marginTop='6px'; sms.style.paddingTop='6px';
    const smsStatus=document.createElement('div'); sms.appendChild(smsStatus);
    smsStatus.id='tpSMSStatus'; smsStatus.textContent='Indlæser SMS-status…';
    smsStatus.style.color='#666666'; smsStatus.style.marginBottom='6px';
    const smsBtn=document.createElement('button'); sms.appendChild(smsBtn);
    smsBtn.id='tpSMSOneBtn'; smsBtn.textContent='Aktivér';
    smsBtn.style.padding='5px 8px'; smsBtn.style.border='1px solid #cccccc'; smsBtn.style.borderRadius='6px';
    smsBtn.style.background='#ffffff'; smsBtn.style.cursor='pointer';

    // toggles/badges
    cbMsg.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    cbInt.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    cbMsg.onchange = ()=> localStorage.setItem('tpPushEnableMsg', cbMsg.checked?'true':'false');
    cbInt.onchange = ()=> localStorage.setItem('tpPushEnableInt', cbInt.checked?'true':'false');
    document.addEventListener('tp:msg-count', e => { try { badgeMsg.textContent = String((e.detail && e.detail.count) || 0); } catch{} });
    document.addEventListener('tp:int-count', e => { try { badgeInt.textContent = String((e.detail && e.detail.count) || 0); } catch{} });

    // Gear menu (bygget uden innerHTML)
    let menu=null;
    function buildMenu(){
      if (menu) return menu;
      menu=document.createElement('div');
      (document.body || document.documentElement).appendChild(menu); // append før styling
      menu.style.position='fixed'; menu.style.right='8px'; menu.style.zIndex='2147483646';
      menu.style.background='#ffffff'; menu.style.border='1px solid #cccccc'; menu.style.borderRadius='10px';
      menu.style.padding='12px'; menu.style.width='380px'; menu.style.maxWidth='96vw';
      menu.style.maxHeight='70vh'; menu.style.overflow='auto'; menu.style.display='none';
      menu.style.fontFamily=wrap.style.fontFamily; menu.style.fontSize=wrap.style.fontSize; menu.style.lineHeight=wrap.style.lineHeight;
      function place(){ menu.style.bottom=(wrap.offsetHeight+18)+'px'; } place(); window.addEventListener('resize', place);

      const h=document.createElement('div'); h.textContent='Indstillinger'; h.style.fontWeight='700'; h.style.marginBottom='8px'; menu.appendChild(h);
      const lab=document.createElement('div'); lab.textContent='Pushover USER-token'; lab.style.fontWeight='600'; lab.style.marginBottom='4px'; menu.appendChild(lab);
      const inp=document.createElement('input'); inp.id='tpUserKeyMenu'; inp.type='text'; inp.placeholder='uxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      inp.style.width='100%'; inp.style.boxSizing='border-box'; inp.style.padding='6px'; inp.style.border='1px solid #cccccc'; inp.style.borderRadius='6px';
      try { inp.value=(GM_getValue('tpUserKey')||'').trim(); } catch{} menu.appendChild(inp);

      const btnRow=document.createElement('div'); btnRow.style.marginTop='6px'; btnRow.style.display='flex'; btnRow.style.gap='6px'; btnRow.style.flexWrap='wrap'; btnRow.style.alignItems='center';
      function mkBtn(txt,id){ const b=document.createElement('button'); b.textContent=txt; b.id=id;
        b.style.padding='6px 8px'; b.style.border='1px solid #cccccc'; b.style.borderRadius='6px'; b.style.background='#ffffff'; b.style.cursor='pointer'; return b; }
      const bSave=mkBtn('Gem','tpSaveUserKeyMenu'), bTest=mkBtn('🧪 Test Pushover','tpTestPushoverBtn'), bUpd=mkBtn('🔄 Søg opdatering','tpCheckUpdate');
      btnRow.appendChild(bSave); btnRow.appendChild(bTest); btnRow.appendChild(bUpd); menu.appendChild(btnRow);

      const sep=document.createElement('div'); sep.style.borderTop='1px solid #eeeeee'; sep.style.margin='10px 0'; menu.appendChild(sep);
      const foot=document.createElement('div'); foot.style.fontSize='11px'; foot.style.color='#666666'; foot.textContent='Kører v.'+TP_VERSION; menu.appendChild(foot);

      // handlers
      bSave.addEventListener('click', ()=>{ try { GM_setValue('tpUserKey', (inp.value||'').trim()); notify('USER-token gemt.'); } catch{} });
      inp.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); try { GM_setValue('tpUserKey', (inp.value||'').trim()); notify('USER-token gemt.'); } catch{} } });
      bTest.addEventListener('click', ()=>{ try { if (typeof TPNotifs==='object' && typeof TPNotifs.testPushover==='function') TPNotifs.testPushover(); else notify('TPNotifs er ikke klar endnu.'); } catch { notify('Kunne ikke køre test.'); } });
      bUpd.addEventListener('click', async ()=>{
        try { const raw=await gmGET(SCRIPT_RAW_URL+'?t='+Date.now()); const m=raw&&raw.match(/@version\s+([0-9.]+)/); const remote=m?m[1]:null;
          if(!remote) return notify('Kunne ikke læse remote version.');
          const cmp=versionCompare(remote,TP_VERSION); if(cmp>0){ notify('Ny version: '+remote+' (du kører '+TP_VERSION+'). Åbner…'); window.open(SCRIPT_RAW_URL,'_blank','noopener'); }
          else notify('Du kører nyeste version ('+TP_VERSION+').'); } catch { notify('Update-tjek fejlede.'); }
      });

      try { if (window.TPExcel && typeof TPExcel.attachToMenu==='function') TPExcel.attachToMenu(menu); } catch {}
      return menu;
    }
    function toggleMenu(){
      const menu=buildMenu(); menu.style.display=(menu.style.display==='block')?'none':'block';
      if (menu.style.display==='block'){
        const outside=e=>{ if(!menu.contains(e.target) && e.target!==gearBtn){ menu.style.display='none'; cleanup(); } };
        const esc=e=>{ if(e.key==='Escape'){ menu.style.display='none'; cleanup(); } };
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

    const CSV = CSV_JSDELIVR;

    TPNotifs && TPNotifs.install && TPNotifs.install({
      pushoverToken: 'a27du13k8h2yf8p4wabxeukthr1fu7',
      pollMs: 15000, suppressMs: 45000,
      msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
      interestUrl: location.origin + '/index.php?page=freevagter',
      enableInterestNameHints: true,
      rawPhonebookUrl: CSV, cacheKeyCSV: 'tpCSVCache'
    });

    TPSms && TPSms.install && TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' });

    TPExcel && TPExcel.install && TPExcel.install({
      owner: 'danieldamdk', repo: 'temponizer-notifikation', branch: 'main',
      csvPath: 'vikarer.csv', cacheKeyCSV: 'tpCSVCache',
      printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
      settingsUrl: location.origin + '/index.php?page=showmy_settings'
    });

    TPCaller && TPCaller.install && TPCaller.install({
      queueSuffix: '*1500', queueCode: '1500',
      rawPhonebookUrl: CSV, cacheKeyCSV: 'tpCSVCache',
      openInNewTab: true, debounceMs: 10000, autohideMs: 8000
    });
    try { TPCaller && TPCaller.processFromUrl && TPCaller.processFromUrl(); } catch {}

    try { window.TPActions && typeof TPActions.install==='function' && TPActions.install(); } catch(e){ console.warn('[TP][main] TPActions install error', e); }

    try { const root=(typeof unsafeWindow!=='undefined'?unsafeWindow:window);
      root.TPNotifs=TPNotifs; root.TPSms=TPSms; root.TPExcel=TPExcel; root.TPCaller=TPCaller; root.TPActions=window.TPActions; } catch {}
  }

  try { boot(); } catch(e){ console.warn('[TP][BOOT ERR]', e); }
})();
