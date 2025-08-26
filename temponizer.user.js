// ==UserScript==
// @name         Temponizer → Moduler (Notifs + Caller + SMS + Excel/CSV)
// @namespace    ajourcare.dk
// @version      7.11.5
// @description  Kører moduler: Notifikationer (besked+interesse+pushover), Caller-toast, SMS-toggle, Excel→CSV. Minimal boot.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      ajourcare.temponizer.dk
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/notifs.module.js?v=7166
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/sms.module.js?v=7166
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/excel.module.js?v=7166
// @require      https://cdn.jsdelivr.net/gh/danieldamdk/temponizer-notifikation@main/caller.module.js?v=7166
// ==/UserScript==

/* eslint-env browser */
/* global TPNotifs, TPSms, TPExcel, TPCaller */

(function () {
  'use strict';

  // 1) Notifikationer (besked + interesse + Pushover)
  TPNotifs.install({
  pushoverToken: 'a27du13k8h2yf8p4wabxeukthr1fu7',
  pollMs: 15000,
  suppressMs: 45000,
  msgUrl: location.origin + '/index.php?page=get_comcenter_counters&ajax=true',
  interestUrl: location.origin + '/index.php?page=freevagter',
  enableInterestNameHints: true,
  rawPhonebookUrl: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/vikarer.csv',
  cacheKeyCSV: 'tpCSVCache'
  });
  
  // 2) SMS-toggle (har egen lille fallback-UI hvis #tpSMS ikke findes)
  TPSms.install({ settingsUrl: location.origin + '/index.php?page=showmy_settings' });

  // 3) Excel/CSV/GitHub (gear-binding kan tilføjes senere via attachToMenu)
  TPExcel.install({
    owner: 'danieldamdk',
    repo: 'temponizer-notifikation',
    branch: 'main',
    csvPath: 'vikarer.csv',
    cacheKeyCSV: 'tpCSVCache',
    printUrl: location.origin + '/index.php?page=print_vikar_list_custom_excel',
    settingsUrl: location.origin + '/index.php?page=showmy_settings'
  });

  // 4) Caller-toast fra Communicator beacon
  TPCaller.install({
    queueSuffix: '*1500',
    queueCode: '1500',
    rawPhonebookUrl: 'https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/vikarer.csv',
    cacheKeyCSV: 'tpCSVCache',
    openInNewTab: true,
    debounceMs: 10000,
    autohideMs: 8000
  });
  if (typeof TPCaller.processFromUrl === 'function') {
    TPCaller.processFromUrl().catch(()=>{});
  }
})();
