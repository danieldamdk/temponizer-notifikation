/*
FILE: tp-actions.module.js
Purpose: Genskaber "Intet svar" 1:1 som i v7.11.4 – stabil og isoleret. (Ingen nye features)
Notes:
- Hover over Temponizers ikon med title/aria-label "Registrer opkald til vikar" viser én lille menu-knap.
- Klik på knappen åbner Temponizers popup, udfylder textarea[name="phonetext"] med "Intet Svar" og klikker "Gem registrering" automatisk.
- Popup er skjult (opacity 0 / pointer-events none) i millisekunder under auto-registreringen for at undgå flimmer.
- MutationObserver aktiveres KUN pr. handling og disconnect'er igen (failsafe efter 3s).
*/

/* eslint-env browser */
/* global unsafeWindow */
(function (w) {
  'use strict';
  if (w.TPActions?.installed) return;

  const VER = 'v7.12.6-01';
  const NS  = `[TP][TPActions ${VER}]`;

  let menu = null;
  let iconEl = null;
  let hideTimer = null;
  let auto = false;
  let obs = null;

  // Find klikbart ikon via title/aria-label (som i 7.11.4)
  function findIcon(el){
    try {
      while (el && el !== document && el.nodeType === 1){
        const t = ((el.getAttribute('title')||'') + ' ' + (el.getAttribute('aria-label')||'')).toLowerCase();
        if (t && /registrer\s*opkald\s*til\s*vikar/.test(t)){
          return el.closest('a') || el; // klik-element
        }
        el = el.parentElement;
      }
    } catch(_){/* ignore */}
    return null;
  }

  // Lille hover-menu
  function mkMenu(){
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'tpIntetSvarMenu';
    Object.assign(menu.style, {
      position:'fixed', zIndex:'2147483647', background:'#fff', border:'1px solid #ccc',
      boxShadow: '0 12px 28px rgba(0,0,0,0.22)',
      // og erstat font-shorthand med sikre properties:
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      fontSize: '12px',
      lineHeight: '20px',
      padding:'6px', display:'none'
    });
    const btn = document.createElement('div');
    btn.textContent = "Registrér 'Intet Svar'";
    Object.assign(btn.style, { padding:'6px 8px', borderRadius:'6px', cursor:'pointer', userSelect:'none' });
    btn.onmouseenter = () => { btn.style.background = '#f2f2f2'; };
    btn.onmouseleave = () => { btn.style.background = 'transparent'; };
    btn.onclick = () => { try { autoRegister(); } catch(e){ console.warn(NS,'autoRegister error',e); } hideMenu(); };
    menu.appendChild(btn);
    document.body.appendChild(menu);
    return menu;
  }

  function showMenuForIcon(el){
    const m = mkMenu();
    iconEl = el;
    const r = el.getBoundingClientRect();
    m.style.display = 'block';
    const mw = m.offsetWidth || 180;
    const mh = m.offsetHeight || 32;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left));
    const top  = Math.min(window.innerHeight - mh - 8, r.bottom + 6);
    m.style.left = left + 'px';
    m.style.top  = top  + 'px';
  }
  function hideMenu(){
    if (!menu) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(()=>{ if (menu) menu.style.display = 'none'; }, 120);
  }

  function autoRegister(){
    if (!iconEl) return;
    auto = true;
    attachObserverOnce();
    try { iconEl.click(); } catch(_) {}
  }

  function attachObserverOnce(){
    if (obs) { try { obs.disconnect(); } catch {} obs=null; }

    const cloak = (root)=>{
      try{
        const hsBody = root.querySelector ? root.querySelector('.highslide-body') : null;
        const hsCont = root.querySelector ? root.querySelector('.highslide-container') : null;
        [hsBody, hsCont].filter(Boolean).forEach(el=>{
          el._tp_prev = { opacity: el.style.opacity, pointerEvents: el.style.pointerEvents, transform: el.style.transform };
          el.style.opacity='0'; el.style.pointerEvents='none'; el.style.transform='scale(0.98)';
        });
      }catch{}
    };
    const uncloackAll = ()=>{
      try { document.querySelectorAll('.highslide-body,.highslide-container').forEach(el=>{
        if (!el._tp_prev) return;
        el.style.opacity = el._tp_prev.opacity || '';
        el.style.pointerEvents = el._tp_prev.pointerEvents || '';
        el.style.transform = el._tp_prev.transform || '';
        delete el._tp_prev;
      }); } catch{}
    };

    const tryProcess = (node)=>{
      try{
        const root = (node && node.nodeType===1) ? node : document;
        cloak(root);

        let ta = null;
        if (root.matches && root.matches('textarea[name="phonetext"]')) ta = root;
        if (!ta && root.querySelector) ta = root.querySelector('textarea[name="phonetext"]');
        if (!ta) return false;

        if (!ta.value || !ta.value.trim()) ta.value = 'Intet Svar';
        const form = ta.closest('form') || ta.form || (root.querySelector && root.querySelector('form'));
        if (!form) return false;

        const btn = Array.from(form.querySelectorAll('input[type="button"],input[type="submit"],button')).find(b=>{
          const v = (b.value || b.textContent || '').trim().toLowerCase();
          return /gem\s+registrering/.test(v);
        });
        if (!btn) return false;

        setTimeout(()=>{
          try { btn.click(); } catch{}
          try {
            const uw = (typeof unsafeWindow!=='undefined') ? unsafeWindow : w;
            if (uw && uw.hs && typeof uw.hs.close==='function') uw.hs.close();
          } catch{}
          setTimeout(uncloackAll, 120);
        }, 30);
        return true;
      }catch(e){ console.warn(NS,'process error', e); return false; }
    };

    obs = new MutationObserver((mlist)=>{
      if (!auto) return;
      for (const m of mlist){
        for (const n of m.addedNodes){
          if (tryProcess(n)){
            auto = false;
            try { obs.disconnect(); } catch{}
            obs = null;
            return;
          }
        }
      }
    });
    obs.observe(document.body, { childList:true, subtree:true });

    // failsafe
    setTimeout(()=>{ if (auto){ auto=false; try{ obs && obs.disconnect(); }catch{} obs=null; } }, 3000);
  }

  function onMouseOver(e){ const el = findIcon(e.target); if (!el) return; showMenuForIcon(el); }
  function onMouseMove(e){ if (!menu || menu.style.display!=='block') return; const t=e.target; if (menu.contains(t)) return; if (iconEl && iconEl.contains && iconEl.contains(t)) return; hideMenu(); }

  function install(){ if (install._did) return; install._did = true; document.addEventListener('mouseover', onMouseOver, true); document.addEventListener('mousemove', onMouseMove, true); console.info(NS,'installed'); }

  w.TPActions = { install, VER };
  w.TPActions.installed = true;
})(window);
