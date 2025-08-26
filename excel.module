/* eslint-env browser */
/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, XLSX */
// TPExcel: Excel→CSV→Upload (GitHub) + CSV cache + test-lookup i telefonbog
// Brug: TPExcel.install(opts) og/eller TPExcel.attachToMenu(menuEl)

(function(){
  'use strict';

  const DEF = Object.freeze({
    owner: 'danieldamdk', repo: 'temponizer-notifikation', branch: 'main', csvPath: 'vikarer.csv',
    printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
    settingsUrl: location.origin + '/index.php?page=showmy_settings',
    cacheKeyCSV: 'tpCSVCache'
  });
  let CFG = { ...DEF };

  // ---------- utils ----------
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  function b64encodeUtf8(str){ const bytes=new TextEncoder().encode(str); let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin); }

  function gmGET(url){ return new Promise((resolve, reject)=>{ GM_xmlhttpRequest({ method:'GET', url, headers:{ 'Accept':'*/*','Referer': location.href, 'Cache-Control':'no-cache','Pragma':'no-cache' }, onload:r=> (r.status>=200&&r.status<300)?resolve(r.responseText):reject(new Error('HTTP '+r.status)), onerror:reject });}); }
  function gmPOST(url, body){ return new Promise((resolve, reject)=>{ GM_xmlhttpRequest({ method:'POST', url, headers:{ 'Content-Type':'application/x-www-form-urlencoded','Referer': location.href }, data: body, onload:r=>(r.status>=200&&r.status<300)?resolve(r.responseText):reject(new Error('HTTP '+r.status)), onerror:reject });}); }
  function gmGETArrayBuffer(url){ return new Promise((resolve, reject)=>{ GM_xmlhttpRequest({ method:'GET', url, responseType:'arraybuffer', headers:{ 'Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8', 'Referer': location.href, 'Cache-Control':'no-cache','Pragma':'no-cache'}, onload:r=> (r.status>=200&&r.status<300)?resolve(r.response):reject(new Error('HTTP '+r.status)), onerror:reject });}); }
  function gmPOSTArrayBuffer(url, body){ return new Promise((resolve, reject)=>{ GM_xmlhttpRequest({ method:'POST', url, responseType:'arraybuffer', headers:{ 'Content-Type':'application/x-www-form-urlencoded','Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel;q=0.9, */*;q=0.8', 'Referer': location.href, 'Cache-Control':'no-cache','Pragma':'no-cache' }, data: body, onload:r=> (r.status===200||r.status===201||r.status===204)?resolve(r.response):reject(new Error('HTTP '+r.status)), onerror:reject });}); }

  function getPAT(){ return (GM_getValue('tpGitPAT')||'').trim(); }
  function setPAT(v){ GM_setValue('tpGitPAT', v||''); }
  async function ghGetSha(path, ref){
    const url = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
    const token = getPAT();
    return new Promise((resolve, reject)=>{ GM_xmlhttpRequest({ method:'GET', url, headers:{ 'Accept':'application/vnd.github+json', ...(token?{'Authorization':'Bearer '+token}:{}), 'X-GitHub-Api-Version':'2022-11-28' }, onload:r=>{ if(r.status===200){ try{ const js=JSON.parse(r.responseText); resolve({ sha: js.sha, exists:true }); } catch{ resolve({ sha:null, exists:true }); } } else if (r.status===404) resolve({ sha:null, exists:false }); else reject(new Error('GitHub GET sha: HTTP '+r.status)); }, onerror:reject });});
  }
  async function ghPutFile(path, base64Content, message, sha, branch){
    const url = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${encodeURIComponent(path)}`;
    const token = getPAT();
    return new Promise((resolve, reject)=>{ GM_xmlhttpRequest({ method:'PUT', url, headers:{ 'Accept':'application/vnd.github+json', ...(token?{'Authorization':'Bearer '+token}:{}), 'X-GitHub-Api-Version':'2022-11-28', 'Content-Type':'application/json;charset=UTF-8' }, data: JSON.stringify({ message, content: base64Content, branch, ...(sha?{sha}:{}) }), onload:r=>{ if(r.status===200||r.status===201) resolve(r.responseText); else reject(new Error('GitHub PUT: HTTP '+r.status+' :: '+String(r.responseText||'').slice(0,260))); }, onerror:reject });});
  }

  // ---------- CSV helpers ----------
  function normPhone(raw){ const digits=String(raw||'').replace(/\D/g,'').replace(/^0+/,'').replace(/^45/,''); return digits.length>=8?digits.slice(-8):''; }
  function parseCSV(text){ if(!text) return []; text=text.replace(/^\uFEFF/,''); const first=(text.split(/\r?\n/)[0]||''); const delim=(first.indexOf(';')>first.indexOf(','))?';':(first.includes(';')?';':','); const rows=[]; let i=0,f='',row=[],q=false; while(i<text.length){ const c=text[i]; if(q){ if(c==='"'){ if(text[i+1]==='"'){ f+='"'; i+=2; continue;} q=false; i++; continue;} f+=c; i++; continue;} if(c==='"'){ q=true; i++; continue;} if(c==='\r'){ i++; continue;} if(c==='\n'){ row.push(f.trim()); rows.push(row); row=[]; f=''; i++; continue;} if(c===delim){ row.push(f.trim()); f=''; i++; continue;} f+=c; i++; } if(f.length||row.length){ row.push(f.trim()); rows.push(row);} return rows.filter(r=>r.length&&r.some(x=>x!=='')); }
  function parsePhonebookCSV(text){ const vikarsById=new Map(); const map=new Map(); const rows=parseCSV(text); if(!rows.length) return { map, header:[], vikarsById }; const hdr=rows[0].map(h=>h.toLowerCase()); const idxId=hdr.findIndex(h=>/(vikar.*nr|vikar[_ ]?id|^id$)/.test(h)); const idxName=hdr.findIndex(h=>/(navn|name)/.test(h)); const phoneCols=hdr.map((h,idx)=>({h,idx})).filter(x=>/(telefon|mobil|cellphone|mobile|phone|tlf)/.test(x.h)); if(idxId<0||phoneCols.length===0) return { map, header:hdr, vikarsById }; for(let r=1;r<rows.length;r++){ const row=rows[r]; const id=(row[idxId]||'').trim(); const name=idxName>=0?(row[idxName]||'').trim():''; if(id) vikarsById.set(String(id), { id, name }); if(!id) continue; for(const pc of phoneCols){ const val=(row[pc.idx]||'').trim(); const p8=normPhone(val); if(p8) map.set(p8, { id, name }); } } return { map, header:hdr, vikarsById }; }

  // ---------- Excel flow ----------
  async function warmupExcelEndpoints(){ try{ await gmGET(CFG.settingsUrl + '&t=' + Date.now()); } catch{} try{ await gmGET(CFG.printUrl + '&t=' + Date.now()); } catch{} await sleep(300); }
  function normalizePhonebookHeader(csv){ const lines=csv.split(/\r?\n/); if(!lines.length) return csv; const hdr=(lines[0]||'').split(','); const mapName=(h)=>{ const x=h.trim().toLowerCase(); if (/(vikar.*nr|vikar[_ ]?id|^id$)/.test(x)) return 'vikar_id'; if (/(navn|name)/.test(x)) return 'name'; if (/(^telefon$|phone(?!.*cell)|tlf)/.test(x)) return 'phone'; if (/(mobil|cellphone|mobile)/.test(x)) return 'cellphone'; return h.trim(); }; lines[0]=hdr.map(mapName).join(','); return lines.join('\n'); }
  function pickBestSheetCSV(wb){ let best={ rows:0, csv:'' }; for(const nm of wb.SheetNames){ const sh=wb.Sheets[nm]; let csv=XLSX.utils.sheet_to_csv(sh,{FS:',',RS:'\n'}); csv=normalizePhonebookHeader(csv); const lines=csv.trim().split(/\r?\n/).filter(Boolean); const dataRows=Math.max(0, lines.length-1); if(dataRows>best.rows) best={ rows:dataRows, csv }; } return best.rows>=1?best.csv:null; }

  async function tryExcelGET(params){ const url = `${CFG.printUrl}&sortBy=&${params}`; return gmGETArrayBuffer(url); }
  async function tryExcelPOST(params){ const url = CFG.printUrl; return gmPOSTArrayBuffer(url, params); }

  function fmtTodayDK(){ const d=new Date(); const dd=String(d.getDate()).padStart(2,'0'); const mm=String(d.getMonth()+1).padStart(2,'0'); const yyyy=d.getFullYear(); return `${dd}.${mm}.${yyyy}`; }
  async function warmUpVikarListSession(){ const today=encodeURIComponent(fmtTodayDK()); const body='page=vikarlist_get&ajax=true&showheader=true&printlist=true'+'&fieldset_filtre=closed&fieldset_aktivitet=closed&kunder_id=0&kontor_id=-1&loenkorsel_id=0'+'&sex=both&vagterfra=&vagtertil=&uddannelse_gyldig='+today+'&kompetencegyldig='+today; await gmPOST(`${location.origin}/index.php`, body); }

  async function fetchExcelAsCSVText(){ try{ await warmUpVikarListSession(); } catch{} await warmupExcelEndpoints(); const tries=[ {fn:tryExcelGET, params:'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag'}, {fn:tryExcelGET, params:'id=true&name=true&phone=true&cellphone=true'} ]; for(const t of tries){ try{ const ab=await t.fn(t.params); if(!ab||ab.byteLength<128) continue; const wb=XLSX.read(ab,{type:'array'}); if(!wb.SheetNames||wb.SheetNames.length===0) continue; const csv=pickBestSheetCSV(wb); if(csv) return csv; } catch{} } await warmupExcelEndpoints(); const postTries=[ {fn:tryExcelPOST, params:'id=true&name=true&phone=true&cellphone=true&gdage_dato=i+dag'}, {fn:tryExcelPOST, params:'id=true&name=true&phone=true&cellphone=true'} ]; for(const t of postTries){ try{ const ab=await t.fn(t.params); if(!ab||ab.byteLength<128) continue; const wb=XLSX.read(ab,{type:'array'}); if(!wb.SheetNames||wb.SheetNames.length===0) continue; const csv=pickBestSheetCSV(wb); if(csv) return csv; } catch{} } return null; }

  async function fetchExcelAsCSVAndUpload(){ const pat=getPAT(); if(!pat) throw new Error('Missing GitHub PAT'); const text=await fetchExcelAsCSVText(); if(!text) return { ok:false, reason:'no-data' }; const lines=(text||'').trim().split(/\r?\n/).filter(Boolean); if(lines.length<2) return { ok:false, reason:'only-header' }; const base64=b64encodeUtf8(text); const { sha } = await ghGetSha(CFG.csvPath, CFG.branch); await ghPutFile(CFG.csvPath, base64, 'sync: Excel→CSV via TM (auto)', sha, CFG.branch); GM_setValue(CFG.cacheKeyCSV, text); return { ok:true, lines: lines.length-1 };
  }

  // ---------- UI wiring ----------
  function attachToMenu(menu){ if(!menu) return; const pat = menu.querySelector('#tpGitPAT'); const file = menu.querySelector('#tpCSVFile'); const up = menu.querySelector('#tpUploadCSV'); const csvUp = menu.querySelector('#tpFetchCSVUpload'); const tIn = menu.querySelector('#tpTestPhone'); const tBtn = menu.querySelector('#tpLookupPhone'); const pbh = menu.querySelector('#tpPBHint'); if (pat){ pat.value = getPAT(); pat.addEventListener('input', ()=> setPAT(pat.value||'')); }
    if (up){ up.addEventListener('click', async ()=>{ try { setPAT((pat?.value||'').trim()); if(!getPAT()){ pbh.textContent='Mangler GitHub PAT i ⚙️ → Telefonbog.'; return; } if(!file?.files||!file.files[0]){ pbh.textContent='Vælg en CSV-fil først.'; return; } const text = await file.files[0].text(); const base64=b64encodeUtf8(text); pbh.textContent='Uploader CSV…'; const { sha } = await ghGetSha(CFG.csvPath, CFG.branch); await ghPutFile(CFG.csvPath, base64, 'sync: upload CSV via TM', sha, CFG.branch); GM_setValue(CFG.cacheKeyCSV, text); pbh.textContent='CSV uploadet. RAW opdateres om få sek.'; } catch(e){ console.warn('[TPExcel][CSV-UPLOAD]', e); pbh.textContent='Fejl ved CSV upload (se konsol).'; } }); }
    if (csvUp){ csvUp.addEventListener('click', async ()=>{ try { setPAT((pat?.value||'').trim()); pbh.textContent='Henter Excel, konverterer og uploader CSV …'; const t0=Date.now(); const res=await fetchExcelAsCSVAndUpload(); const ms=Date.now()-t0; pbh.textContent = res?.ok ? `Færdig på ${ms} ms. Rækker: ${res.lines}` : `Ingen data (${res?.reason||'ukendt'}).`; } catch(e){ console.warn('[TPExcel][EXCEL→CSV-UPLOAD]', e); pbh.textContent='Fejl ved Excel→CSV upload (se konsol).'; } }); }
    if (tBtn){ tBtn.addEventListener('click', async ()=>{ try { const raw=(tIn?.value||'').trim(); const p8=normPhone(raw); if(!p8){ pbh.textContent='Ugyldigt nummer.'; return; } pbh.textContent='Slår op i CSV…'; let csv=''; try{ csv=await gmGET(`https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/${CFG.csvPath}?t=${Date.now()}`); if(csv) GM_setValue(CFG.cacheKeyCSV, csv); } catch{} if(!csv) csv = GM_getValue(CFG.cacheKeyCSV)||''; const { map } = parsePhonebookCSV(csv); const rec = map.get(p8); pbh.textContent = rec ? `Match: ${p8} → ${rec.name || '(uden navn)'} (vikar_id=${rec.id})` : `Ingen match for ${p8}.`; if (rec){ const url = `/index.php?page=showvikaroplysninger&vikar_id=${encodeURIComponent(rec.id)}#stamoplysninger`; window.open(url,'_blank','noopener'); } } catch(e){ console.warn('[TPExcel][LOOKUP]', e); pbh.textContent='Fejl ved opslag.'; } }); }
  }

  const TPExcel = {
    install(opts={}){ CFG = { ...DEF, ...(opts||{}) }; },
    attachToMenu,
    fetchExcelAsCSVAndUpload,
    parsePhonebookCSV,
    normPhone
  };

  try { window.TPExcel = Object.freeze(TPExcel); } catch(_) {}
})();
