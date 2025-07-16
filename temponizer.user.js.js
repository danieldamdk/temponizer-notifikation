// ==UserScript==
// @name         Temponizer → Pushover + toast (AjourCare) v6.6
// @namespace    ajourcare.dk
// @version      6.6
// @description  Push ved nye beskeder og interesse, uanset fanestatus eller opdatering – med UI-panel
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.pushover.net
// @run-at       document-idle
// ==/UserScript==

const PUSHOVER_USER  = 'uPenUF7H43j6R8JxwAq1YYyHBn7ZFd';
const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';

const POLL_MS = 30_000;
const SUPPRESS_MS = 45_000;
const LOCK_MS = SUPPRESS_MS + 5_000;

const ENABLE_MSG_KEY = 'tpEnableMessages';
const ENABLE_INT_KEY = 'tpEnableInterest';

function isEnabled(key) {
  return localStorage[key] !== 'false';
}

function setEnabled(key, val) {
  localStorage[key] = val;
}

// === GENERELE FUNKTIONER === //
function sendPushover(txt){
  const body = `token=${PUSHOVER_TOKEN}&user=${PUSHOVER_USER}&message=${encodeURIComponent(txt)}`;
  GM_xmlhttpRequest({
    method :'POST',
    url    :'https://api.pushover.net/1/messages.json',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    data   : body,
    onload : r=>console.debug('[Pushover]', r.status, r.responseText),
    onerror: _=>{
      console.warn('[Pushover] GM_xhr blocked – using fetch');
      fetch('https://api.pushover.net/1/messages.json',{
        method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body
      })
      .then(r=>r.text()).then(t=>console.debug('[Pushover/fetch]', t))
      .catch(e=>console.error('[Pushover/fetch] net-error', e));
    }
  });

  if (Notification.permission==='granted') {
    new Notification('Temponizer', { body: txt });
  } else if (Notification.permission!=='denied') {
    Notification.requestPermission().then(p=>p==='granted' && new Notification('Temponizer', { body: txt }));
  }
}

// === BESKEDER === //
const UNREAD_URL = `${location.origin}/index.php?page=get_comcenter_counters&ajax=true`;
const KEYS = ['vagt_unread', 'generel_unread'];
const stMsg = JSON.parse(localStorage.tpPushState || '{"count":0,"lastPush":0,"lastSent":0}');
const saveMsg = () => localStorage.tpPushState = JSON.stringify(stMsg);

function takeLock(){
  const lock = JSON.parse(localStorage.tpPushLock || '{"t":0}');
  if (Date.now() - lock.t < LOCK_MS) return false;
  localStorage.tpPushLock = JSON.stringify({ t: Date.now() });
  return true;
}

function pollMessages(){
  if (!isEnabled(ENABLE_MSG_KEY)) return;
  GM_xmlhttpRequest({
    method:'GET',
    url:`${UNREAD_URL}&ts=${Date.now()}`,
    withCredentials:true,
    onload:r=>{
      if (r.status!==200) return;
      const d = JSON.parse(r.responseText);
      const now = KEYS.reduce((s,k)=>s + Number(d[k]||0), 0);
      if (now > stMsg.count && now !== stMsg.lastSent) {
        if (Date.now() - stMsg.lastPush > SUPPRESS_MS && takeLock()) {
          sendPushover(`🔔 Du har nu ${now} ulæst(e) Temponizer-besked(er).`);
          stMsg.lastPush = Date.now();
          stMsg.lastSent = now;
        } else {
          stMsg.lastSent = now;
        }
      } else if (now < stMsg.count) {
        stMsg.lastPush = 0;
      }
      stMsg.count = now;
      saveMsg();
      console.debug('[TP-besked]', now);
    }
  });
}

// === INTERESSE === //
const stInterest = JSON.parse(localStorage.tpInterestState || '{"count":0,"lastPush":0,"lastSent":0}');
const saveInterest = () => localStorage.tpInterestState = JSON.stringify(stInterest);

function pollInterest(){
  if (!isEnabled(ENABLE_INT_KEY)) return;
  fetch('https://ajourcare.temponizer.dk/index.php?page=freevagter')
    .then(r => r.text())
    .then(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const boxes = [...doc.querySelectorAll('div[id^="vagtlist_synlig_interesse_display_number_"]')];
      console.debug('[TP-interest] Bokse fundet:', boxes.length);
      const count = boxes.reduce((sum, el) => {
        const val = parseInt(el.textContent.trim(), 10);
        return sum + (isNaN(val) ? 0 : val);
      }, 0);
      if (count > stInterest.count && count !== stInterest.lastSent) {
        if (Date.now() - stInterest.lastPush > SUPPRESS_MS) {
          sendPushover(`👀 ${count} vikar(er) har vist interesse for ledige vagter`);
          stInterest.lastPush = Date.now();
          stInterest.lastSent = count;
        } else {
          stInterest.lastSent = count;
        }
      } else if (count < stInterest.count) {
        stInterest.lastPush = 0;
      }
      stInterest.count = count;
      saveInterest();
      console.debug('[TP-interest]', count);
    });
}

// === AUTO-RESET VED KLIK PÅ BESKEDER === //
document.addEventListener('click', e => {
  const link = e.target.closest('a');
  if (link && /Beskeder/.test(link.textContent)) {
    stMsg.lastPush = 0;
    stMsg.lastSent = 0;
    saveMsg();
    console.debug('[TP] Auto-reset ved klik på Beskeder');
  }
});

// === UI MED TOGGLE === //
function injectTestUI(){
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9999;background:#f9f9f9;border:1px solid #ccc;padding:6px 10px;border-radius:6px;font-size:12px;font-family:sans-serif;box-shadow:1px 1px 5px rgba(0,0,0,0.2)';
  div.innerHTML = `
    <b>TP-Notifikationer</b><br>
    <label><input type="checkbox" id="tpEnableMsg"> Beskeder</label><br>
    <label><input type="checkbox" id="tpEnableInt"> Interesse</label>
  `;
  document.body.appendChild(div);
  const msgBox = document.getElementById('tpEnableMsg');
  const intBox = document.getElementById('tpEnableInt');
  msgBox.checked = isEnabled(ENABLE_MSG_KEY);
  intBox.checked = isEnabled(ENABLE_INT_KEY);
  msgBox.onchange = () => setEnabled(ENABLE_MSG_KEY, msgBox.checked);
  intBox.onchange = () => setEnabled(ENABLE_INT_KEY, intBox.checked);
}

// === KØR POLLING + UI === //
pollMessages();
pollInterest();
setInterval(pollMessages, POLL_MS);
setInterval(pollInterest, POLL_MS);
injectTestUI();

// Eksponer til konsollen (til test)
unsafeWindow.fetchInterestFromDOM = () => stInterest.count;
unsafeWindow.handleInterest = pollInterest;
unsafeWindow.handleMessages = pollMessages;
