/* eslint-env browser */
// TPActions — hjælper til “Registrér Intet svar” i interesse-popups.
// - Finder popups med .vikar_interresse_list_container
// - Tilføjer en lille “Intet svar” knap pr. række (uden at ændre Temponizer-koden)
// - Klikker på den native “Intet svar” kontrol, hvis den findes
// - Hotkey: Alt+I klikker “Intet svar” på første række i en åben popup

(function(){
  'use strict';
  const MOD = 'actions.module';
  const VER = '2025-08-28-04';
  console.info('[TP]', MOD, 'v'+VER, 'loaded at', new Date().toISOString());

  function toast(t){ try { new Notification('Temponizer', { body: t }); } catch(_) {} }

  function findRows(root){
    return Array.from(root.querySelectorAll('.vikar_interresse_list_container'));
  }
  function findNativeNoAnswerBtn(row){
    // match på tekst eller id/class/onclick
    const nodes = Array.from(row.querySelectorAll('a,button'));
    const hit = nodes.find(el =>
      /intet\s*svar/i.test(el.textContent||'') ||
      /intet[_-]?svar|no[_-]?answer/i.test((el.id||'') + ' ' + (el.className||'')) ||
      /IntetSvar|noAnswer|intetSvar/i.test(el.getAttribute('onclick')||'')
    );
    return hit || null;
  }

  function addQuickButton(row){
    if (row.querySelector('.tp-intetsvar-btn')) return;
    const host = row.querySelector('.vikar_interresse_list_remove_container') || row;
    const btn = document.createElement('button');
    btn.className = 'tp-intetsvar-btn';
    btn.textContent = 'Intet svar';
    Object.assign(btn.style, {
      marginLeft:'6px', padding:'3px 6px', border:'1px solid #ccc', borderRadius:'6px',
      background:'#fff', cursor:'pointer', fontSize:'12px'
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const native = findNativeNoAnswerBtn(row);
      if (native) { native.click(); toast('Registreret “Intet svar”.'); }
      else { toast('Kunne ikke finde “Intet svar” i rækken.'); }
    });
    host.appendChild(btn);
  }

  function scan(root){
    findRows(root).forEach(addQuickButton);
  }

  function install(){
    // initial scan
    scan(document);

    // observe popups og dynamik
    const mo = new MutationObserver(muts => {
      for (const m of muts){
        for (const n of m.addedNodes){
          if (!(n instanceof HTMLElement)) continue;
          if (n.matches && (n.matches('.vikar_interresse_list_container') || n.querySelector('.vikar_interresse_list_container'))){
            scan(n);
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });

    // hotkey Alt+I: klik første række i åben popup
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key.toLowerCase() === 'i')){
        const first = document.querySelector('.vikar_interresse_list_container');
        if (first){
          const btn = first.querySelector('.tp-intetsvar-btn') || findNativeNoAnswerBtn(first);
          if (btn){ e.preventDefault(); btn.click(); }
        }
      }
    }, true);
  }

  const API = Object.freeze({ install });
  try { window.TPActions = API; } catch { window.TPActions = API; }
})();
