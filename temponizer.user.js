// ==UserScript==
// @name         Temponizer → Notifikationer + “Intet svar” + Caller-pop + Telefonbog (AjourCare)
// @namespace    ajourcare.dk
// @version      7.0
// @description  Pushover (leder på tværs af faner) + toast + “Intet svar” (auto) + telefonbog-synk/Caller-pop. Stabil auto-update via GitHub.
// @match        https://ajourcare.temponizer.dk/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @updateURL    https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// @downloadURL  https://github.com/danieldamdk/temponizer-notifikation/raw/refs/heads/main/temponizer.user.js
// ==/UserScript==

(function () {
  'use strict';

  /*──────────────────── 0. KONFIG (fastlåst app-token, skift IKKE) ────────────────────*/
  const APP = {
    NAME: 'Temponizer',
    VERSION: '7.0',

    // Pushover
    PUSHOVER_TOKEN: 'a27du13k8h2yf8p4wabxeukthr1fu7',    // fastlåst i script (org.-token)
    GM_USER_TOKEN_KEY: 'tpUserToken',                     // brugerens eget Pushover user token (indtastes i ⚙️)
    GM_ENABLE_MSG: 'tpPushEnableMsg',
    GM_ENABLE_INT: 'tpPushEnableInt',

    POLL_MS: 30000,
    SUPPRESS_MS: 45000,
    LOCK_MS: 50000, // SUPPRESS_MS + 5s

    // Telefonbog (central CSV i dit repo)
    RAW_PHONEBOOK: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/refs/heads/main/vikarer.csv',

    // GitHub (til upload af vikarer.csv – valgfrit for admin)
    GH_OWNER:  'danieldamdk',
    GH_REPO:   'temponizer-notifikation',
    GH_PATH:   'vikarer.csv',
    GH_BRANCH: 'main',

    // Excel-download fra Vikaroversigt (samme som Excel-knappen åbner)
    SEL_SEARCH_FORM: '#vikarsearchform',
    EXCEL_URL: '/index.php?page=print_vikar_list_custom_excel'
             + '&id=true&name=true&phone=true&cellphone=true'
             + '&gdage_dato=' + encodeURIComponent('i dag')
             + '&sortBy='
  };

  /*──────────────────── 1. HJÆLPERE ────────────────────*/
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  function log(...a){ try{ console.log('[TP]', ...a);}catch{} }
  function dbg(...a){ try{ console.debug('[TP][DBG]', ...a);}catch{} }

  function normPhone(v) {
    if (v == null) return '';
    let s = String(v).replace(/\D/g, '').replace(/^0+/, '').replace(/^45/, '');
    return s.length >= 8 ? s.slice(-8) : '';
  }

  function showToast(msg) {
    try {
      if (Notification?.permission === 'granted') { new Notification(APP.NAME, { body: msg }); return; }
      if (Notification?.permission !== 'denied') {
        Notification.requestPermission().then(p => {
          if (p==='granted') new Notification(APP.NAME, { body: msg });
          else domToast(msg);
        });
        return;
      }
    } catch(_){}
    domToast(msg);
  }
  function domToast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style,{
      position:'fixed', bottom:'16px', right:'16px', background:'#333', color:'#fff',
      padding:'8px 12px', borderRadius:'6px', fontSize:'13px', fontFamily:'system-ui, sans-serif',
      boxShadow:'1px 1px 8px rgba(0,0,0,.4)', zIndex: 999999, opacity:0, transition:'opacity .25s'
    });
    document.body.appendChild(el);
    requestAnimationFrame(()=> el.style.opacity = 1);
    setTimeout(()=>{ el.style.opacity = 0; setTimeout(()=> el.remove(), 300); }, 3500);
  }
  function showToastOnce(key, msg) {
    const lk = 'tpToastLock_' + key;
    const o = JSON.parse(localStorage.getItem(lk) || '{"t":0}');
    if (Date.now() - o.t < APP.LOCK_MS) return;
    localStorage.setItem(lk, JSON.stringify({ t: Date.now() }));
    showToast(msg);
  }

  async function gmGET(url, { responseType='text' } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType,
        onload: r => (r.status>=200 && r.status<300) ? resolve(r.responseText ?? r.response) : reject(new Error('HTTP '+r.status)),
        onerror: e => reject(e)
      });
    });
  }

  /*──────────────────── 2. MULTI-TAB LEADER (kun leder sender Pushover) ────────────────────*/
  const leader = (() => {
    const KEY = 'tpLeader', BEAT_MS = 4000, TTL = 9000;
    const id = Math.random().toString(36).slice(2);
    let isLead = false;
    function now(){ return Date.now(); }
    function read(){ try{ return JSON.parse(localStorage.getItem(KEY)||'{}'); }catch{ return {}; } }
    function write(obj){ localStorage.setItem(KEY, JSON.stringify(obj)); }
    function attemptElect() {
      const cur = read();
      if (!cur.id || (now()- (cur.t||0) > TTL)) {
        write({ id, t: now() }); isLead = true; return;
      }
      isLead = cur.id === id;
    }
    function beat(){
      if (isLead) write({ id, t: now() });
    }
    attemptElect();
    setInterval(attemptElect, 3000);
    setInterval(beat, BEAT_MS);
    window.addEventListener('storage', (e)=> {
      if (e.key === KEY) attemptElect();
    });
    return { amI: ()=> isLead };
  })();

  /*──────────────────── 3. PUSHOVER ────────────────────*/
  function sendPushover(message) {
    // kun leder sender, men alle viser toast (med Once-lås)
    if (!leader.amI()) return;

    const user = GM_getValue(APP.GM_USER_TOKEN_KEY, '').trim();
    if (!user) return;

    const body = 'token=' + encodeURIComponent(APP.PUSHOVER_TOKEN)
               + '&user='  + encodeURIComponent(user)
               + '&message=' + encodeURIComponent(message);

    GM_xmlhttpRequest({
      method:'POST',
      url:'https://api.pushover.net/1/messages.json',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      data: body
    });
  }

  /*──────────────────── 4. POLL: BESKEDER + INTERESSE ────────────────────*/
  const MSG_URL  = location.origin + '/index.php?page=get_comcenter_counters&ajax=true';
  const MSG_KEYS = ['vagt_unread', 'generel_unread'];
  const stMsg = JSON.parse(localStorage.getItem('tpPushState') || '{"count":0,"lastPush":0,"lastSent":0}');
  function saveMsg(){ localStorage.setItem('tpPushState', JSON.stringify(stMsg)); }

  function pollMessages() {
    fetch(MSG_URL + '&ts=' + Date.now(), { credentials:'same-origin' })
      .then(r => r.json())
      .then(d => {
        const n = MSG_KEYS.reduce((s,k)=> s + Number(d[k]||0), 0);
        const en = !!GM_getValue(APP.GM_ENABLE_MSG, false);
        dbg('[MSG]', {n, stMsg, en});

        if (n > stMsg.count && n !== stMsg.lastSent) {
          if (Date.now()-stMsg.lastPush > APP.SUPPRESS_MS) {
            const m = '🔔 Du har nu ' + n + ' ulæst(e) besked(er).';
            if (en) sendPushover(m);
            showToastOnce('msg', m);
            stMsg.lastPush = Date.now(); stMsg.lastSent = n;
          } else stMsg.lastSent = n;
        } else if (n < stMsg.count) {
          stMsg.lastPush = 0;
        }
        stMsg.count = n; saveMsg();
        log('[TP-besked]', n, new Date().toLocaleTimeString());
      })
      .catch(console.error);
  }

  const HTML_URL = location.origin + '/index.php?page=freevagter';
  let   lastETag = null;
  const stInt = JSON.parse(localStorage.getItem('tpInterestState') || '{"count":0,"lastPush":0,"lastSent":0}');
  function saveInt(){ localStorage.setItem('tpInterestState', JSON.stringify(stInt)); }

  function pollInterest() {
    fetch(HTML_URL, {
      method:'HEAD', credentials:'same-origin',
      headers: lastETag ? { 'If-None-Match': lastETag } : {}
    })
      .then(h => {
        if (h.status === 304) { dbg('[INT] 304'); return null; }
        lastETag = h.headers.get('ETag') || null;
        return fetch(HTML_URL, {
          credentials:'same-origin',
          headers: { Range: 'bytes=0-20000' }
        }).then(r => r.text());
      })
      .then(html => { if (html != null) parseInterestHTML(html); })
      .catch(console.error);
  }
  function parseInterestHTML(html) {
    const doc = new DOMParser().parseFromString(html,'text/html');
    const boxes = Array.from(doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]'));
    const c = boxes.reduce((s, el) => {
      const v = parseInt(el.textContent.trim(), 10);
      return s + (isNaN(v) ? 0 : v);
    }, 0);
    handleInterestCount(c);
    log('[TP-interesse]', c, new Date().toLocaleTimeString());
  }
  function handleInterestCount(c) {
    const en = !!GM_getValue(APP.GM_ENABLE_INT, false);
    dbg('[INT]', {c, stInt, en});
    if (c > stInt.count && c !== stInt.lastSent) {
      if (Date.now()-stInt.lastPush > APP.SUPPRESS_MS) {
        const m = '👀 ' + c + ' vikar(er) har vist interesse for ledige vagter.';
        if (en) sendPushover(m);
        showToastOnce('int', m);
        stInt.lastPush = Date.now(); stInt.lastSent = c;
      } else stInt.lastSent = c;
    } else if (c < stInt.count) stInt.lastPush = 0;
    stInt.count = c; saveInt();
  }

  // reset når man klikker "Beskeder"
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && /Beskeder/.test(a.textContent||'')) {
      stMsg.lastPush = stMsg.lastSent = 0; saveMsg();
    }
  });

  /*──────────────────── 5. UI: CHECKS + ⚙️ PANEL ────────────────────*/
  function injectUI() {
    if ($('#tpUi')) return;
    const d = document.createElement('div');
    d.id = 'tpUi';
    d.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99998;background:#f9f9f9;border:1px solid #ccc;padding:6px 10px;border-radius:8px;font:12px/1.3 system-ui,sans-serif;box-shadow:1px 1px 6px rgba(0,0,0,.15)';
    d.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <div>
          <b>Notifikationer</b><br>
          <label title="Pushover ved nye beskeder"><input type="checkbox" id="tpMsg"> Besked (Pushover)</label><br>
          <label title="Pushover når interesse stiger"><input type="checkbox" id="tpInt"> Interesse (Pushover)</label>
        </div>
        <button id="tpGear" title="Indstillinger" style="margin-left:6px;width:28px;height:28px;border:1px solid #ccc;border-radius:50%;background:#fff;cursor:pointer;box-shadow:0 1px 5px rgba(0,0,0,.15)">⚙️</button>
      </div>
    `;
    document.body.appendChild(d);

    const m = $('#tpMsg'), i = $('#tpInt');
    m.checked = !!GM_getValue(APP.GM_ENABLE_MSG, false);
    i.checked = !!GM_getValue(APP.GM_ENABLE_INT, false);
    m.onchange = ()=> GM_setValue(APP.GM_ENABLE_MSG, !!m.checked);
    i.onchange = ()=> GM_setValue(APP.GM_ENABLE_INT, !!i.checked);
    $('#tpGear').onclick = openSettings;
  }

  function openSettings() {
    if ($('#tpPanel')) { $('#tpPanel').style.display='block'; renderSettings(); return; }
    const p = document.createElement('div');
    p.id = 'tpPanel';
    Object.assign(p.style, {
      position:'fixed', bottom:'48px', right:'8px', maxWidth:'92vw', width:'380px',
      background:'#fff', border:'1px solid #ccc', borderRadius:'10px', padding:'12px',
      font:'13px/1.5 system-ui,sans-serif', zIndex: 99999, boxShadow:'0 8px 24px rgba(0,0,0,.25)'
    });
    p.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b>Indstillinger</b>
        <button id="tpClose" title="Luk" style="border:0;background:transparent;font-size:18px;cursor:pointer">×</button>
      </div>

      <div style="margin:8px 0;padding:8px;background:#f7f7f7;border-radius:8px">
        <div><b>Pushover</b> (app-token er låst af administrator)</div>
        <div style="margin-top:6px">Din <i>User Key</i> (user token):</div>
        <input id="tpUserTok" type="password" placeholder="uXXXXXXXX…" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px">
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="tpSaveTok" style="padding:6px 10px;border:1px solid #999;border-radius:6px;cursor:pointer">Gem</button>
          <button id="tpTestPush" style="padding:6px 10px;border:1px solid #999;border-radius:6px;cursor:pointer">Test push (besked + interesse)</button>
        </div>
        <div id="tpLeaderInfo" style="margin-top:6px;color:#555"></div>
      </div>

      <div style="margin:10px 0;padding:8px;background:#f7f7f7;border-radius:8px">
        <div style="margin-bottom:6px"><b>Telefonbog</b></div>
        <div style="color:#444;margin-bottom:6px">Kør her fra <i>Vikaroversigt</i> (samme fane hvor Excel-knappen virker).</div>
        <button id="tpSync" style="padding:6px 10px;border:1px solid #999;border-radius:6px;cursor:pointer">↻ Synk (Excel → CSV)</button>
        <label style="margin-left:8px"><input id="tpUploadChk" type="checkbox"> Upload til GitHub efter synk</label>
        <div style="margin-top:8px;font-size:12px">
          RAW-link (Caller-pop læser herfra):<br>
          <code>${APP.RAW_PHONEBOOK}</code>
        </div>
      </div>

      <div style="margin:10px 0;padding:8px;background:#f7f7f7;border-radius:8px">
        <div style="margin-bottom:6px"><b>GitHub (kun admin for upload)</b></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input id="tpGhTok" type="password" placeholder="GitHub token (contents: write)" style="grid-column:1/3;padding:8px;border:1px solid #ccc;border-radius:6px">
          <input id="tpGhOwner" placeholder="Owner"  style="padding:8px;border:1px solid #ccc;border-radius:6px">
          <input id="tpGhRepo"  placeholder="Repo"   style="padding:8px;border:1px solid #ccc;border-radius:6px">
          <input id="tpGhPath"  placeholder="Path (vikarer.csv)" style="grid-column:1/3;padding:8px;border:1px solid #ccc;border-radius:6px">
          <input id="tpGhBranch" placeholder="Branch (main)" style="grid-column:1/3;padding:8px;border:1px solid #ccc;border-radius:6px">
        </div>
        <div style="margin-top:8px">
          <button id="tpSaveGh" style="padding:6px 10px;border:1px solid #999;border-radius:6px;cursor:pointer">Gem GitHub-indstillinger</button>
        </div>
      </div>
    `;
    document.body.appendChild(p);

    $('#tpClose').onclick = ()=> p.style.display='none';
    $('#tpSaveTok').onclick = ()=> {
      GM_setValue(APP.GM_USER_TOKEN_KEY, ($('#tpUserTok').value||'').trim());
      showToast('Pushover user key gemt');
    };
    $('#tpTestPush').onclick = ()=> {
      const u = (GM_getValue(APP.GM_USER_TOKEN_KEY,'')||'').trim();
      if (!u) { showToast('Angiv din Pushover user key først.'); return; }
      const enMsg = !!GM_getValue(APP.GM_ENABLE_MSG,false);
      const enInt = !!GM_getValue(APP.GM_ENABLE_INT,false);
      // tving sender (leder) men altid toast
      const ts = new Date().toLocaleTimeString();
      if (enMsg) sendPushover('🔔 TEST (besked) ' + ts);
      showToast('🔔 TEST (besked) ' + ts);
      if (enInt) sendPushover('👀 TEST (interesse) ' + ts);
      showToast('👀 TEST (interesse) ' + ts);
    };

    $('#tpSync').onclick = async () => {
      try {
        const csv = await syncTelefonbogExcelToCSV();
        const name = `vikarer_forenklet_${new Date().toISOString().slice(0,10)}.csv`;
        const dataUrl = 'data:text/csv;base64,' + btoa(unescape(encodeURIComponent(csv)));
        GM_download({ url: dataUrl, name, saveAs: false });
        showToast('CSV downloadet ('+name+')');
        if ($('#tpUploadChk').checked) {
          await uploadToGitHub(csv);
          showToast('CSV uploadet til GitHub ✓');
        }
      } catch(e){ console.warn(e); showToast('Synk fejlede: ' + (e?.message||e)); }
    };

    $('#tpUploadChk').checked = !!GM_getValue('tpGhUpload', false);
    $('#tpUploadChk').onchange = e => GM_setValue('tpGhUpload', !!e.target.checked);

    // GitHub felter
    $('#tpGhTok').value    = GM_getValue('tpGhTok','');
    $('#tpGhOwner').value  = GM_getValue('tpGhOwner', APP.GH_OWNER);
    $('#tpGhRepo').value   = GM_getValue('tpGhRepo',  APP.GH_REPO);
    $('#tpGhPath').value   = GM_getValue('tpGhPath',  APP.GH_PATH);
    $('#tpGhBranch').value = GM_getValue('tpGhBranch',APP.GH_BRANCH);
    $('#tpSaveGh').onclick = ()=> {
      GM_setValue('tpGhTok', ($('#tpGhTok').value||'').trim());
      GM_setValue('tpGhOwner', ($('#tpGhOwner').value||APP.GH_OWNER).trim());
      GM_setValue('tpGhRepo',  ($('#tpGhRepo').value||APP.GH_REPO).trim());
      GM_setValue('tpGhPath',  ($('#tpGhPath').value||APP.GH_PATH).trim());
      GM_setValue('tpGhBranch',($('#tpGhBranch').value||APP.GH_BRANCH).trim());
      showToast('GitHub-indstillinger gemt');
    };

    renderSettings();
  }
  function renderSettings(){
    const el = $('#tpLeaderInfo');
    if (el) el.textContent = leader.amI() ? 'Denne fane er LEDERe (sender Pushover)' : 'Denne fane er IKKE leder (ingen Pushover-afsendelse)';
    const u = GM_getValue(APP.GM_USER_TOKEN_KEY,'');
    if ($('#tpUserTok')) $('#tpUserTok').value = u;
  }

  /*──────────────────── 6. TELEFONBOG: Synk (Excel→CSV) + Upload ────────────────────*/
  async function syncTelefonbogExcelToCSV() {
    const csrf = $('meta[name="csrf-token"]')?.content || '';
    const form = $(APP.SEL_SEARCH_FORM);
    if (!form) throw new Error('Kør fra Vikaroversigt – søgeformular ikke fundet.');

    // 1) bind filtre (samme som Excel-knappen gør)
    const serForm = f => new URLSearchParams(new FormData(f)).toString();
    const postBody = serForm(form) + '&' + new URLSearchParams({
      page:'vikarlist_get', ajax:'true', showheader:'true', printlist:'true',
      fieldset_filtre:'closed', fieldset_aktivitet:'closed',
      group_checkboxgroupKompetencer:'closed', group_checkboxgroupkundetyper:'closed',
      group_checkboxgroupkurser:'closed', group_checkboxgroupvikarpuljer:'closed'
    }).toString();

    await fetch('/index.php', {
      method:'POST',
      headers:{
        'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRF-Token': csrf,
        'X-Requested-With':'XMLHttpRequest'
      },
      body: postBody, credentials:'same-origin'
    });

    // 2) hent Excel
    const resp = await fetch(APP.EXCEL_URL, { credentials:'same-origin' });
    if (!resp.ok) throw new Error('Excel GET fejlede: ' + resp.status);
    const buf = await resp.arrayBuffer();

    // 3) parse første ark
    const wb = XLSX.read(new Uint8Array(buf), { type:'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws); // fx [{ID, Navn, Telefon, Mobil}, …]

    // 4) forenkling
    let out = 'vikar_id,name,phone\n';
    for (const r of rows) {
      const id   = (r.ID ?? r.Id ?? r.id ?? r.vikar_id ?? '').toString().trim();
      const navn = (r.Navn ?? r.Name ?? r.name ?? '').toString().replace(/,/g,' ').trim();
      const phone = normPhone(r.Mobil ?? r.Cellphone ?? r.cellphone ?? r.Mobile ?? '')
                 || normPhone(r.Telefon ?? r.Phone ?? r.phone ?? '');
      if (id && phone) out += `${id},${navn},${phone}\n`;
    }
    return out;
  }

  async function uploadToGitHub(csvText) {
    const token  = GM_getValue('tpGhTok','');
    const owner  = GM_getValue('tpGhOwner', APP.GH_OWNER);
    const repo   = GM_getValue('tpGhRepo',  APP.GH_REPO);
    const path   = GM_getValue('tpGhPath',  APP.GH_PATH);
    const branch = GM_getValue('tpGhBranch',APP.GH_BRANCH);
    if (!token) throw new Error('GitHub token mangler');

    const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`;

    // hent eksisterende sha
    let sha = null;
    await new Promise((resolve)=> {
      GM_xmlhttpRequest({
        method:'GET', url: apiBase + `?ref=${encodeURIComponent(branch)}`,
        headers:{ 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json' },
        onload: r => { if (r.status===200) { try{ sha = JSON.parse(r.responseText).sha || null; }catch{} } resolve(); },
        onerror: ()=> resolve()
      });
    });

    const contentB64 = btoa(unescape(encodeURIComponent(csvText)));
    const body = { message:`Update ${path} (auto)`, content: contentB64, branch };
    if (sha) body.sha = sha;

    await new Promise((resolve, reject)=> {
      GM_xmlhttpRequest({
        method:'PUT', url: apiBase,
        headers:{
          'Authorization':'Bearer '+token,
          'Accept':'application/vnd.github+json',
          'Content-Type':'application/json'
        },
        data: JSON.stringify(body),
        onload: r => (r.status===200 || r.status===201) ? resolve() : reject(new Error('GitHub PUT '+r.status+': '+r.responseText)),
        onerror: e => reject(e)
      });
    });
  }

  /*──────────────────── 7. CALLER-POP (åbn vikar fra central telefonbog) ────────────────────*/
  (async function callerPop(){
    const raw = new URLSearchParams(location.search).get('tp_caller');
    if (!raw) return;
    if (!raw.endsWith('*1500')) return;       // kun indgående (som i jeres flow)
    const phone8 = normPhone(raw.slice(0,-5));
    if (!phone8) { showToast('Ukendt nummer: '+raw); return; }

    try {
      const csv = await gmGET(APP.RAW_PHONEBOOK);
      const map = parsePhonebook(csv);          // phone8 -> vikar_id
      const id  = map.get(phone8);
      if (!id) { showToast('Ukendt nummer: '+phone8); return; }
      const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(id)}#stamoplysninger`;
      showToast('Åbner vikar…'); location.assign(url);
    } catch(e){ console.warn(e); showToast('Kan ikke hente telefonbog.'); }
  })();
  function parsePhonebook(text) {
    const out = new Map();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return out;
    const head = lines.shift().split(',');
    const idId = head.findIndex(h=>/^vikar_id$/i.test(h));
    const idPh = head.findIndex(h=>/^phone$/i.test(h));
    for (const ln of lines) {
      const c = ln.split(',');
      const id = (c[idId]||'').trim();
      const ph = (c[idPh]||'').trim();
      if (id && ph) out.set(ph, id);
    }
    return out;
  }

  /*──────────────────── 8. “INTET SVAR” – Quick hover + auto-registrering ────────────────────*/
  (function quickNoAnswer(){
    let auto = false, icon = null, menu = null, hideT = null, firedKey = null;

    function mkMenu(){
      if (menu) return menu;
      menu = document.createElement('div');
      Object.assign(menu.style, {
        position:'fixed', zIndex:2147483647, background:'#fff', border:'1px solid #ccc',
        borderRadius:'6px', boxShadow:'0 2px 10px rgba(0,0,0,.25)', font:'12px/1.3 system-ui,sans-serif', display:'none'
      });
      const btn = document.createElement('div');
      btn.textContent = 'Registrér “Intet svar” (auto)';
      btn.style.cssText = 'padding:8px 12px;white-space:nowrap;cursor:default';
      btn.onmouseenter = ()=> btn.style.background = '#f0f0f0';
      btn.onmouseleave = ()=> btn.style.background = '';
      btn.onclick = ()=> { auto = true; if (icon) icon.click(); hide(); };
      menu.appendChild(btn); document.body.appendChild(menu); return menu;
    }
    function show(el){
      icon = el;
      const r = el.getBoundingClientRect();
      const m = mkMenu();
      m.style.left = Math.max(8, Math.min(window.innerWidth-180, r.left)) + 'px';
      m.style.top  = Math.min(window.innerHeight-40, r.bottom + 6) + 'px';
      m.style.display = 'block';
    }
    function hide(){ clearTimeout(hideT); hideT = setTimeout(()=> { if (menu) menu.style.display='none'; icon=null; }, 120); }
    function findIcon(n){
      while(n && n!==document){
        if (n.getAttribute && n.getAttribute('title') === 'Registrer opkald til vikar') return n;
        n = n.parentNode;
      }
      return null;
    }

    document.addEventListener('mouseover', e => { const ic = findIcon(e.target); if (ic) show(ic); }, true);
    document.addEventListener('mousemove', e => {
      if (!menu || menu.style.display!=='block') return;
      const overM = menu.contains(e.target);
      const overI = icon && (icon===e.target || icon.contains(e.target) || e.target.contains(icon));
      if (!overM && !overI) hide();
    }, true);

    // observer: når popup/form dukker op, skriv “Intet svar” og submit én gang
    new MutationObserver(ml => {
      if (!auto) return;
      for (const m of ml) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          // find textarea
          const ta = n.matches?.('textarea[name="phonetext"]') ? n : n.querySelector?.('textarea[name="phonetext"]');
          if (!ta) continue;

          // find knappen "Gem registrering" og dens onclick="RegistrerOpkald('vikarId','vagtId')"
          const btn = n.querySelector?.('input[type="button"][value="Gem registrering"]');
          const on  = btn?.getAttribute('onclick') || '';
          const m2  = on.match(/RegistrerOpkald\('(\d+)','(\d+)'\)/);
          if (!m2) { ta.value = 'Intet svar'; ta.dispatchEvent(new Event('input',{bubbles:true})); auto=false; continue; }

          const vikarId = m2[1], vagtId = m2[2];
          const key = vikarId + '_' + vagtId;
          if (firedKey === key) { auto=false; continue; } // allerede kørt

          if (!ta.value.trim()) ta.value = 'Intet svar';
          ta.dispatchEvent(new Event('input',{bubbles:true}));

          try { // direkte registrering (undgå flere)
            if (window.RegistrerOpkald) {
              window.RegistrerOpkald(vikarId, vagtId);
              firedKey = key;
              // luk popup hvis Highslide er brugt
              if (window.hs && window.hs.close) setTimeout(()=> window.hs.close(), 50);
            } else {
              btn?.click(); firedKey = key;
            }
          } catch(_){ btn?.click(); firedKey = key; }
          auto = false;
          return;
        }
      }
    }).observe(document.body, { childList:true, subtree:true });
  })();

  /*──────────────────── 9. INIT ────────────────────*/
  function init(){
    dbg('ui init', { gear: true, panel: true });
    injectUI();

    // start pollere
    pollMessages(); pollInterest();
    setInterval(pollMessages, APP.POLL_MS);
    setInterval(pollInterest, APP.POLL_MS);

    log('kører version', APP.VERSION);

    // måltid ;-)
    try {
      const t0 = performance.now();
      setTimeout(()=> {
        const dt = performance.now() - t0;
        console.log('SCRIPT RUN TIME['+document.title.replaceAll('"','$1')+']: ' + dt + ' ms');
      }, 0);
    } catch(_){}
  }

  document.addEventListener('DOMContentLoaded', init);
})();
