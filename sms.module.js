/* eslint-env browser */
/* eslint no-console: "off" */
(function () {
  'use strict';
  const MOD = 'sms.module';
  const VER = 'v2025-08-29-02';
  const debug = localStorage.getItem('tpDebug') === '1';
  const log = (...a) => { if (debug) console.info('[TP]', MOD, VER, ...a); };
  log('loaded at', new Date().toISOString());
})();

/* global GM_xmlhttpRequest */
(function(){
  'use strict';

  const DEF = Object.freeze({ settingsUrl: location.origin + '/index.php?page=showmy_settings' });
  let CFG = { ...DEF };
  let _busy = false;

  function hasDisplayBlock(el){
    if(!el) return false;
    const s=(el.getAttribute('style')||'').replace(/\s+/g,'').toLowerCase();
    if (s.includes('display:none')) return false;
    if (s.includes('display:block')) return true;
    return false;
  }
  function parseSmsStatusFromDoc(doc){
    const elA = doc.getElementById('sms_notifikation_aktiv');
    const elI = doc.getElementById('sms_notifikation_ikke_aktiv');
    const aktivShown = hasDisplayBlock(elA);
    const inaktivShown = hasDisplayBlock(elI);
    const hasDeact = !!(doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_aktiv a[href*="deactivate_cell_sms_notifikationer"]'));
    const hasAct   = !!(doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') || doc.querySelector('#sms_notifikation_ikke_aktiv a[href*="activate_cell_sms_notifikationer"]'));
    let state = 'unknown', phone='';
    if (aktivShown || (!inaktivShown && hasDeact && !hasAct)) state='active';
    else if (inaktivShown || (!aktivShown && hasAct && !hasDeact)) state='inactive';
    const refTxt = state==='active' ? (elA?.textContent||'') : (elI?.textContent||'');
    const m = refTxt.replace(/\u00A0/g,' ').match(/\+?\d[\d\s]{5,}/); if (m) phone=m[0].replace(/\s+/g,'');
    return { state, phone };
  }
  function parseSmsStatusFromHTML(html){ return parseSmsStatusFromDoc(new DOMParser().parseFromString(html, 'text/html')); }

  function gmGET(url){
    return new Promise((resolve, reject)=>{
      GM_xmlhttpRequest({ method:'GET', url, headers:{ 'Accept':'*/*','Cache-Control':'no-cache','Pragma':'no-cache' },
        onload:r=> (r.status>=200&&r.status<300)?resolve(r.responseText):reject(new Error('HTTP '+r.status)),
        onerror:reject });
    });
  }

  async function fetchSmsStatusHTML(){ return gmGET(CFG.settingsUrl + '&t=' + Date.now()); }
  async function getSmsStatus(){ try { return parseSmsStatusFromHTML(await fetchSmsStatusHTML()); } catch { return { state:'unknown' }; } }

  function hardenSmsIframe(ifr){
    try {
      const w=ifr.contentWindow, d=ifr.contentDocument;
      if(!w||!d) return;
      w.open=()=>null; w.alert=()=>{}; w.confirm=()=>true;
      d.addEventListener('click',ev=>{
        const a=ev.target.closest&&ev.target.closest('a');
        if(!a) return;
        ev.preventDefault(); ev.stopPropagation(); return false;
      },true);
    } catch(_){}
  }

  async function ensureSmsFrameLoaded(){
    let ifr = document.getElementById('tpSmsFrame');
    if (!ifr){
      ifr = document.createElement('iframe'); ifr.id='tpSmsFrame';
      Object.assign(ifr.style,{ position:'fixed', left:'-10000px', top:'-10000px', width:'1px', height:'1px', opacity:'0', pointerEvents:'none', border:'0' });
      document.body.appendChild(ifr);
    }
    const loadOnce = () => new Promise(res => { ifr.onload = () => { hardenSmsIframe(ifr); res(); }; });
    const wantUrl = CFG.settingsUrl;
    if (ifr.src !== wantUrl){ ifr.src = wantUrl; await loadOnce(); }
    else if (!ifr.contentWindow || !ifr.contentDocument || !ifr.contentDocument.body){ ifr.src = wantUrl; await loadOnce(); }
    else hardenSmsIframe(ifr);
    return ifr;
  }

  function getIframeStatus(ifr){ try { return parseSmsStatusFromDoc(ifr.contentDocument); } catch { return { state:'unknown' }; } }
  function invokeIframeAction(ifr, wantOn){
    const w=ifr.contentWindow, d=ifr.contentDocument;
    try { if (wantOn && typeof w.activate_cell_sms_notifikationer==='function'){ w.activate_cell_sms_notifikationer(); return true; }
          if (!wantOn && typeof w.deactivate_cell_sms_notifikationer==='function'){ w.deactivate_cell_sms_notifikationer(); return true; } } catch(_){}
    try { const link = wantOn
            ? (d.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"],#sms_notifikation_ikke_aktiv a'))
            : (d.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"],#sms_notifikation_aktiv a'));
          if (link){ link.click(); return true; } } catch(_){}
    return false;
  }

  async function toggleSmsInIframe(wantOn, timeoutMs=15000, pollMs=500){
    const ifr = await ensureSmsFrameLoaded();
    const st0 = getIframeStatus(ifr);
    if ((wantOn && st0.state==='active') || (!wantOn && st0.state==='inactive')) return st0;
    const invoked = invokeIframeAction(ifr, wantOn);
    if (!invoked) throw new Error('Kan ikke udløse aktivering/deaktivering i iframe.');
    const maybeReloaded = new Promise(res => { let done=false; ifr.addEventListener('load',()=>{ if(!done){ done=true; res(); } },{ once:true }); setTimeout(()=>{ if(!done) res(); },1200); });
    await maybeReloaded;
    const t0 = Date.now();
    while (Date.now()-t0 < timeoutMs){
      const st = getIframeStatus(ifr);
      if ((wantOn && st.state==='active') || (!wantOn && st.state==='inactive')) return st;
      await new Promise(r=>setTimeout(r,pollMs));
    }
    const reload = () => new Promise(res => { ifr.onload=()=>res(); ifr.src = CFG.settingsUrl + '&ts=' + Date.now(); });
    await reload();
    return getIframeStatus(ifr);
  }

  function bindUI(container){
    const lbl = container.querySelector('#tpSMSStatus');
    const btn = container.querySelector('#tpSMSOneBtn');
    function setBusy(on, text){ if (btn){ btn.disabled=on; btn.style.opacity = on ? 0.6 : 1; } if (on && text && lbl) lbl.textContent = text; }
    function paint(st){
      if(!lbl||!btn) return;
      switch(st.state){
        case 'active':   btn.textContent='Deaktiver'; lbl.textContent='SMS: Aktiv' + (st.phone?(' — '+st.phone):''); lbl.style.color='#0a7a35'; break;
        case 'inactive': btn.textContent='Aktivér';  lbl.textContent='SMS: Ikke aktiv' + (st.phone?(' — '+st.phone):''); lbl.style.color='#a33'; break;
        default:         btn.textContent='Aktivér';  lbl.textContent='SMS: Ukendt'; lbl.style.color='#666';
      }
    }
    btn.addEventListener('click', async ()=>{
      if (_busy) return; _busy=true;
      const wantOn = (btn.textContent==='Aktivér');
      setBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
      try { const st = await toggleSmsInIframe(wantOn, 15000, 500); paint(st); }
      finally { _busy=false; setBusy(false); }
    });
    (async()=>{ setBusy(true,'indlæser…'); try { paint(await getSmsStatus()); } finally { setBusy(false); } })();
  }

  function ensureSection(){
    let root = document.getElementById('tpSMS');
    if (!root){
      root = document.createElement('div'); root.id='tpSMS';
      root.style.cssText='position:fixed;right:12px;bottom:12px;background:#fff;border:1px solid #ccc;border-radius:8px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,0.15);font:12px system-ui,sans-serif;z-index:2147483645';
      root.innerHTML = '<div id="tpSMSStatus" style="font-size:12px; color:#666;">Indlæser SMS-status…</div><div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;"><button id="tpSMSOneBtn" style="padding:5px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;flex:0 0 auto">Aktivér</button></div>';
      document.body.appendChild(root);
    }
    return root;
  }

  const TPSms = {
    install(opts={}){ CFG = { ...DEF, ...(opts||{}) }; const sec = ensureSection(); bindUI(sec); },
    setEnabled: toggleSmsInIframe,
    getStatus: getSmsStatus,
  };

  try { window.TPSms = Object.freeze(TPSms); } catch(_) {}
})();
