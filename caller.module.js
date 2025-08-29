/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue */
(function(){
  'use strict';

  const MOD = 'caller.module';
  const VER = 'v2025-08-29-01';
  const debug = localStorage.getItem('tpDebug') === '1';
  const log = (...a) => { if (debug) console.info('[TP]', MOD, VER, ...a); };

  const DEF = Object.freeze({
    rawPhonebookUrl: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache',
    queueSuffix: '*1500',
    queueCode: '1500',
    openInNewTab: true,
    debounceMs: 10000,
    autohideMs: 8000,
    eventKey: 'tpCallerEvtV2'
  });

  let CFG = { ...DEF };
  let _installed = false;
  let _listenerAttached = false;

  const now = () => Date.now();
  const clamp = (n,min,max)=> Math.max(min, Math.min(max, n));

  function normPhone(raw){
    const digits=String(raw||'').replace(/\D/g,'').replace(/^0+/, '').replace(/^45/, '');
    return digits.length>=8?digits.slice(-8):'';
  }
  function fmtPhoneDK(p8){ return String(p8||'').replace(/(\d{2})(?=\d)/g,'$1 ').trim(); }

  function gmGET(url){
    return new Promise((resolve, reject)=>{
      GM_xmlhttpRequest({
        method:'GET', url,
        headers:{ 'Accept':'*/*','Cache-Control':'no-cache','Pragma':'no-cache' },
        onload:r=> (r.status>=200 && r.status<300) ? resolve(r.responseText) : reject(new Error('HTTP '+r.status)),
        onerror: reject
      });
    });
  }
  function GM_GetValueSafe(k, fb=null){ try { const v=GM_getValue(k); return v==null?fb:v; } catch(_) { return fb; } }
  function GM_SetValueSafe(k,v){ try { GM_setValue(k,v); } catch(_){} }

  function parseCSV(text){
    if (!text) return [];
    text = text.replace(/^\uFEFF/, '');
    const first = (text.split(/\r?\n/)[0] || '');
    const delim = (first.indexOf(';') > first.indexOf(',')) ? ';' : (first.includes(';') ? ';' : ',');
    const rows = []; let i=0, field='', row=[], inQ=false;
    while (i < text.length){
      const c = text[i];
      if (inQ){ if (c==='"'){ if (text[i+1]==='"'){ field+='"'; i+=2; continue; } inQ=false; i++; continue; } field+=c; i++; continue; }
      if (c==='"'){ inQ=true; i++; continue; }
      if (c==='\r'){ i++; continue; }
      if (c==='\n'){ row.push(field.trim()); rows.push(row); row=[]; field=''; i++; continue; }
      if (c===delim){ row.push(field.trim()); field=''; i++; continue; }
      field+=c; i++;
    }
    if (field.length || row.length){ row.push(field.trim()); rows.push(row); }
    return rows.filter(r => r.length && r.some(x => x !== ''));
  }
  function parsePhonebookCSV(text){
    const vikarsById = new Map();
    const map = new Map();
    const rows = parseCSV(text);
    if (!rows.length) return { map, header: [], vikarsById };
    const header = rows[0].map(h => h.toLowerCase());
    const idxId   = header.findIndex(h => /(vikar.*nr|vikar[_ ]?id|^id$)/.test(h));
    const idxName = header.findIndex(h => /(navn|name)/.test(h));
    const phoneCols = header.map((h, idx) => ({ h, idx })).filter(x => /(telefon|mobil|cellphone|mobile|phone|tlf)/.test(x.h));
    if (idxId < 0 || phoneCols.length === 0) return { map, header, vikarsById };
    for (let r=1; r<rows.length; r++){
      const row = rows[r];
      const id = (row[idxId]||'').trim();
      const name = idxName>=0 ? (row[idxName]||'').trim() : '';
      if (id) vikarsById.set(String(id), { id, name });
      if (!id) continue;
      for (const pc of phoneCols){
        const val = (row[pc.idx]||'').trim();
        const p8 = normPhone(val);
        if (p8) map.set(p8, { id, name });
      }
    }
    return { map, header, vikarsById };
  }

  function showCallerToast(opts){
    try{
      const host = document.createElement('div');
      Object.assign(host.style, {
        position:'fixed', bottom:'12px', right:'12px', zIndex:2147483647,
        maxWidth:'360px', font:'12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
      });
      const card = document.createElement('div');
      Object.assign(card.style, {
        background:'#1f1f1f', color:'#fff', borderRadius:'10px', padding:'10px 12px',
        boxShadow:'0 10px 28px rgba(0,0,0,.38)', display:'flex', gap:'10px', alignItems:'flex-start',
        opacity:'0', transform:'translateY(8px)', transition:'opacity .22s, transform .22s'
      });
      const icon = document.createElement('div'); icon.textContent='☎️'; icon.style.fontSize='18px';
      const body = document.createElement('div'); body.style.flex='1 1 auto';
      const h = document.createElement('div'); h.textContent = opts.title || 'Indgående opkald'; h.style.fontWeight='700'; h.style.marginBottom='2px';
      const p = document.createElement('div'); p.textContent = opts.primary || ''; p.style.fontSize='13px'; p.style.marginBottom='2px';
      const s = document.createElement('div'); s.textContent = opts.secondary || ''; s.style.color='#bbb'; s.style.fontSize='11px';
      body.appendChild(h); body.appendChild(p); if (opts.secondary) body.appendChild(s);

      const actions = document.createElement('div');
      actions.style.display='flex'; actions.style.flexDirection='column'; actions.style.gap='6px'; actions.style.marginLeft='6px';

      if (opts.profileUrl){
        const btn = document.createElement('button'); btn.type='button';
        btn.textContent='Åbn vikarprofil';
        Object.assign(btn.style,{ cursor:'pointer', background:'#fff', color:'#111', border:'1px solid #ccc', borderRadius:'8px', padding:'6px 8px', fontWeight:600 });
        btn.addEventListener('click', ()=>{ try{ window.open(opts.profileUrl, '_blank', 'noopener'); }catch(_){} });
        actions.appendChild(btn);
      }
      const close = document.createElement('button'); close.type='button'; close.textContent='Luk';
      Object.assign(close.style,{ cursor:'pointer', background:'transparent', color:'#fff', border:'1px solid #666', borderRadius:'8px', padding:'4px 8px' });
      close.addEventListener('click', ()=>{ try{ host.remove(); }catch(_){} });
      actions.appendChild(close);

      card.appendChild(icon); card.appendChild(body); card.appendChild(actions);
      host.appendChild(card); document.body.appendChild(host);
      requestAnimationFrame(()=>{ card.style.opacity='1'; card.style.transform='translateY(0)'; });

      const ah = clamp(Number(opts.autohideMs||CFG.autohideMs)||0, 1500, 60000);
      let t = setTimeout(()=>{ try{ host.remove(); }catch(_){} }, ah);
      card.addEventListener('mouseenter', ()=>{ clearTimeout(t); t=null; });
      card.addEventListener('mouseleave', ()=>{ if(!t) t=setTimeout(()=>{ try{ host.remove(); }catch(_){} }, 1800); });
    }catch(_){}
  }

  function broadcastCallerEvent(payload){
    try {
      const ev = { id:`${Date.now()}-${Math.random().toString(36).slice(2)}`, ts:Date.now(), payload };
      localStorage.setItem(CFG.eventKey, JSON.stringify(ev));
    } catch(_){}
  }
  function attachStorageListenerOnce(){
    if (_listenerAttached) return;
    _listenerAttached = true;
    window.addEventListener('storage', (e)=>{
      if (e.key !== CFG.eventKey || !e.newValue) return;
      try{
        const { payload } = JSON.parse(e.newValue||'{}');
        if (!payload) return;
        const p8 = payload.phone8 || (payload.secret ? 'secret' : 'x');
        const seenKey = 'tpCallerSeen_' + p8;
        const last = Number(localStorage.getItem(seenKey)||'0');
        if (Date.now() - last < CFG.debounceMs) return;
        localStorage.setItem(seenKey, String(Date.now()));

        const viaKoe = payload.viaQueue === true;
        const secondary = viaKoe ? `Via kø (${CFG.queueCode})` : '';

        if (payload.secret){
          showCallerToast({ title:'Indgående opkald', primary:'Hemmelig via kø', secondary });
          return;
        }
        const numTxt = fmtPhoneDK(payload.phone8||'');
        if (!payload.match){
          showCallerToast({ title:'Indgående opkald', primary:`Ukendt nummer · ${numTxt}`, secondary });
          return;
        }
        const nm = payload.match.name || '(uden navn)';
        const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(payload.match.id)}#stamoplysninger`;
        showCallerToast({ title:'Indgående opkald', primary:`${nm} · ${numTxt}`, secondary, profileUrl:url });
      }catch(_){}
    });
  }

  async function maybeLookupCSV(p8){
    try{
      const txt = await gmGET(CFG.rawPhonebookUrl + '?t=' + Date.now());
      if (txt && txt.length > 50) GM_SetValueSafe(CFG.cacheKeyCSV, txt);
      const { map } = parsePhonebookCSV(txt);
      return map.get(p8) || null;
    }catch(_){
      const cached = GM_GetValueSafe(CFG.cacheKeyCSV, '');
      try{ const { map } = parsePhonebookCSV(cached); return map.get(p8) || null; }catch(_){ return null; }
    }
  }
  function hidePageQuickly(){
    try{ const de=document.documentElement; if (!de) return; de.style.opacity='0'; de.style.pointerEvents='none'; }catch(_){}
  }
  function tryAutoClose(){
    setTimeout(()=>{ try{ window.close(); }catch(_){} }, 50);
    setTimeout(()=>{ try{ open('', '_self'); window.close(); }catch(_){} }, 120);
    setTimeout(()=>{ try{ location.replace('about:blank'); }catch(_){} }, 200);
  }

  async function processFromUrl(){
    try{
      const q = new URLSearchParams(location.search);
      const rawParam = (q.get('tp_caller') || '').trim();
      if (!rawParam) return false;

      hidePageQuickly();

      const isSecret = (rawParam === CFG.queueCode);
      const isQueueInbound = rawParam.endsWith(CFG.queueSuffix);
      const digitsRaw = rawParam
        .replace(new RegExp(String(CFG.queueSuffix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), '')
        .replace(/[^\d+]/g, '');
      const phone8 = normPhone(digitsRaw);

      if (!isSecret && !isQueueInbound){
        tryAutoClose();
        return true;
      }

      const payload = { dir:'in', viaQueue:true, secret:isSecret, raw:rawParam };
      if (!isSecret && phone8){
        payload.phone8 = phone8;
        const rec = await maybeLookupCSV(phone8);
        if (rec) payload.match = { id: rec.id, name: rec.name || '' };
      }

      broadcastCallerEvent(payload);
      tryAutoClose();
      return true;
    }catch(_){ return false; }
  }

  const TPCaller = {
    install(opts={}){
      if (_installed) return; _installed = true;
      CFG = { ...DEF, ...(opts||{}) };
      attachStorageListenerOnce();
      if (opts.beaconFromUrl !== false) processFromUrl();
      log('installed with', CFG);
    },
    processFromUrl,
    config(){ return { ...CFG }; },
    version: '1.0.0'
  };

  try { window.TPCaller = Object.freeze(TPCaller); } catch(_) { window.TPCaller = TPCaller; }
})();
