(function(w){
  if (w.TPActions?.installed) return;
  const VER = '2025-08-29-02';
  const NS = '[TP][TPActions v' + VER + ']';

  let menu = null, iconEl = null, hideTimer = null, auto = false, obs = null;

  function findIcon(el){ /* uændret som før */ 
    try {
      while (el && el !== document && el.nodeType === 1){
        const title = (el.getAttribute('title') || '');
        const aria  = (el.getAttribute('aria-label') || '');
        const t = (title + ' ' + aria).toLowerCase();
        if (t && /registrer\s*opkald\s*til\s*vikar/.test(t)){
          const a = el.closest('a') || el;
          return a;
        }
        el = el.parentElement;
      }
    } catch(_){}
    return null;
  }

  function mkMenu(){
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'tpIntetSvarMenu';
    // SIKRE styles (ingen shorthand/decimal uden 0)
    menu.style.position = 'fixed';
    menu.style.zIndex = '2147483647';
    menu.style.background = '#ffffff';
    menu.style.border = '1px solid #cccccc';
    menu.style.boxShadow = '0 12px 28px rgba(0,0,0,0.22)';
    menu.style.borderRadius = '8px';
    menu.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    menu.style.fontSize = '12px';
    menu.style.lineHeight = '20px';
    menu.style.padding = '6px';
    menu.style.display = 'none';

    const btn = document.createElement('div');
    btn.textContent = "Registrér 'Intet Svar'";
    btn.style.padding = '6px 8px';
    btn.style.borderRadius = '6px';
    btn.style.cursor = 'pointer';
    btn.style.userSelect = 'none';
    btn.onmouseenter = () => { btn.style.background = '#f2f2f2'; };
    btn.onmouseleave = () => { btn.style.background = 'transparent'; };
    btn.onclick = () => { try { autoRegister(); } catch(e){ console.warn(NS,'autoRegister error', e); } hideMenu(); };

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
  function hideMenu(){ if (!menu) return; clearTimeout(hideTimer); hideTimer=setTimeout(()=>{ if(menu) menu.style.display='none'; }, 120); }

  function autoRegister(){ /* uændret som før */ 
    if (!iconEl) return;
    auto = true;
    attachObserverOnce();
    try { iconEl.click(); } catch(_) {}
  }

  function attachObserverOnce(){ /* uændret logik – kun styles sikre hvis sat */ 
    if (obs) { try { obs.disconnect(); } catch {} obs = null; }
    const cloak = (root) => {
      try{
        const hsBody = root.querySelector ? root.querySelector('.highslide-body') : null;
        const hsCont = root.querySelector ? root.querySelector('.highslide-container') : null;
        const els = [hsBody, hsCont].filter(Boolean);
        for (const el of els){
          el._tp_prev = { opacity: el.style.opacity, pointerEvents: el.style.pointerEvents, transform: el.style.transform };
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          el.style.transform = 'scale(0.98)';
        }
      }catch{}
    };
    const uncloackAll = () => {
      try {
        document.querySelectorAll('.highslide-body,.highslide-container').forEach(el=>{
          if (el && el._tp_prev){
            el.style.opacity = el._tp_prev.opacity || '';
            el.style.pointerEvents = el._tp_prev.pointerEvents || '';
            el.style.transform = el._tp_prev.transform || '';
            delete el._tp_prev;
          }
        });
      } catch {}
    };
    const tryProcess = (node) => {
      try {
        const root = (node && node.nodeType === 1) ? node : document;
        cloak(root);
        let ta = null;
        if (root.matches && root.matches('textarea[name=\"phonetext\"]')) ta = root;
        if (!ta && root.querySelector) ta = root.querySelector('textarea[name=\"phonetext\"]');
        if (!ta) return false;
        if (!ta.value || !ta.value.trim()) ta.value = 'Intet Svar';
        const form = ta.closest('form') || ta.form || (root.querySelector && root.querySelector('form'));
        if (!form) return false;
        const btn = Array.from(form.querySelectorAll('input[type=\"button\"],input[type=\"submit\"],button')).find(b=>{
          const v = (b.value || b.textContent || '').trim().toLowerCase();
          return /gem\\s+registrering/.test(v);
        });
        if (!btn) return false;
        setTimeout(()=>{
          try { btn.click(); } catch {}
          try { if (w && w.hs && typeof w.hs.close === 'function') w.hs.close(); } catch {}
          setTimeout(uncloackAll, 120);
        }, 30);
        return true;
      } catch (e) { console.warn(NS,'process error', e); return false; }
    };
    obs = new MutationObserver((mlist)=>{
      if (!auto) return;
      for (const m of mlist){
        for (const n of m.addedNodes){
          if (tryProcess(n)){ auto=false; try { obs.disconnect(); } catch {} obs=null; return; }
        }
      }
    });
    obs.observe(document.body, { childList:true, subtree:true });
    setTimeout(()=>{ if (auto){ auto=false; try { obs && obs.disconnect(); } catch{} obs=null; } }, 3000);
  }

  function onMouseOver(e){ const el = findIcon(e.target); if (!el) return; showMenuForIcon(el); }
  function onMouseMove(e){
    if (!menu || menu.style.display !== 'block') return;
    const t = e.target;
    if (menu.contains(t)) return;
    if (iconEl && iconEl.contains && iconEl.contains(t)) return;
    hideMenu();
  }

  function install(){
    if (install._did) return; install._did = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mousemove', onMouseMove, true);
    console.info(NS,'installed');
  }

  w.TPActions = { install, VER };
  w.TPActions.installed = true;
})(window);
