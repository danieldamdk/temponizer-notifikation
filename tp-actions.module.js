/* eslint-env browser */
/* eslint no-console: "off" */

/*
  TPActions — “Registrér intet svar” (Freevagter → interesse-popup)
  - Finder .vikar_interresse_list_container rækker i popup-HTML
  - Tilføjer en lille "Intet svar"-knap hvis ikke allerede til stede
  - Knap klikker den eksisterende native handling i DOM’en:
      * søger efter <a>/<button> med tekst ~ "intet svar"
      * eller elementer med onclick/href der indeholder "intet" og "svar"
  - Viser en lille toast ved succes/fejl
  Brug:
      TPActions.install();
*/

(function () {
  'use strict';
  const MOD = 'actions.module';
  const VER = 'v2025-08-28-01';

  const debug = localStorage.getItem('tpDebug') === '1';
  const log = (...a) => { if (debug) console.info('[TP]', MOD, VER, ...a); };

  log('loaded at', new Date().toISOString());

  // ───────────────── helpers ─────────────────
  function showToast(msg) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Temponizer', { body: msg });
        return;
      }
    } catch (_) {}
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position:'fixed', bottom:'12px', right:'12px', zIndex:2147483647,
      background:'#333', color:'#fff', padding:'8px 10px', borderRadius:'8px', fontSize:'12px',
      fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', boxShadow:'0 6px 18px rgba(0,0,0, 0.35)',
      opacity:0, transform:'translateY(8px)', transition:'opacity 0.22s, transform .22s'
    });
    document.body.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity=1; el.style.transform='translateY(0)'; });
    setTimeout(()=>{ el.style.opacity=0; el.style.transform='translateY(8px)'; setTimeout(()=>el.remove(), 260); }, 3800);
  }

  // Normaliserer tekst for robust søgning
  function norm(t) {
    return (t || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .normalize ? (t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g,' ').trim()) : (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Find den native “intet svar” handling i rækken
  function findNativeNoAnswerAction(row) {
    if (!row) return null;
    // 1) Tjek tekst på knapper/links
    const candidates = row.querySelectorAll('a,button,input[type="button"],input[type="submit"]');
    for (const el of candidates) {
      const txt = norm(el.value || el.textContent || '');
      if (!txt) continue;
      if (txt.includes('intet svar') || txt.includes('ingen svar') || txt.includes('svarer ikke')) {
        return el;
      }
    }
    // 2) Tjek onclick/href-signatur
    for (const el of candidates) {
      const oc = String(el.getAttribute('onclick') || '');
      const hr = String(el.getAttribute('href') || '');
      const sig = (oc + ' ' + hr).toLowerCase();
      if (sig.includes('intet') && sig.includes('svar')) return el;
    }
    return null;
  }

  // Tilføj vores lille knap i en interesse-række
  function injectButtonForRow(row) {
    if (!row || row.dataset.tpPatchedIntetSvar === '1') return;
    const native = findNativeNoAnswerAction(row);
    // Hvis der allerede findes en native "intet svar"-knap synlig, så lad den være (men vi kan stadig tilføje vores lille hjælp-knap)
    const place =
      row.querySelector('.vikar_interresse_list_navn_container') ||
      row.querySelector('.vikar_interresse_list_remove_container') ||
      row;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Intet svar';
    Object.assign(btn.style, {
      marginLeft:'8px', padding:'3px 6px',
      border:'1px solid #bbb', background:'#fff', borderRadius:'6px',
      cursor:'pointer', fontSize:'11px'
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = native || findNativeNoAnswerAction(row);
      if (el) {
        try {
          el.click();
          showToast('✔ Registreret: Intet svar');
        } catch (err) {
          console.warn('[TPActions] click failed', err);
          showToast('Kunne ikke klikke den oprindelige “Intet svar”.');
        }
      } else {
        showToast('Ingen “Intet svar”-handling fundet i denne boks.');
      }
    });

    place.appendChild(btn);
    row.dataset.tpPatchedIntetSvar = '1';
  }

  // Scan et givent DOM-subtree for interesse-lister
  function scan(root) {
    const scope = root || document;
    // Vores tidligere parser bruger denne klasse – vi genbruger den
    const rows = scope.querySelectorAll('.vikar_interresse_list_container');
    rows.forEach(injectButtonForRow);
  }

  // MutationObserver: fanger når popup’en indlæses/udskiftes
  let _obs = null;
  function startObserver() {
    if (_obs) return;
    _obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          m.addedNodes.forEach(n => {
            if (n.nodeType === 1) {
              // Scan kun hvis det ligner popup-indhold eller indeholder vores rækker
              if (n.querySelector && (n.matches('.highslide-html-content, .hs-content, body, html, #content') || n.querySelector('.vikar_interresse_list_container'))) {
                scan(n);
              }
            }
          });
        }
      }
    });
    _obs.observe(document.documentElement, { childList: true, subtree: true });
    // Første init
    scan(document);
  }

  // Public API
  const TPActions = {
    install() {
      try { startObserver(); } catch (e) { console.warn('[TPActions] install failed', e); }
    },
    // Hjælp i Console: klik første “Intet svar” i synlig popup
    clickFirstNoAnswer() {
      const row = document.querySelector('.vikar_interresse_list_container');
      if (!row) { showToast('Ingen interesse-rækker fundet.'); return; }
      const el = findNativeNoAnswerAction(row);
      if (el) { el.click(); showToast('✔ Registreret: Intet svar (første række)'); }
      else { showToast('Fandt ingen “Intet svar”-handling i første række.'); }
    }
  };

  try { window.TPActions = Object.freeze(TPActions); } catch (_) { window.TPActions = TPActions; }
})();
