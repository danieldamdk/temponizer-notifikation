// ==UserScript==
// @name         Temponizer -> Pushover + Toast + Mail + SMS + Quick "Intet Svar" (AjourCare)
// @namespace    ajourcare.dk
// @version      7.14.0
// @description  Notifikation ved nye indgaaende vikarbeskeder, interesse og IPnordic-opkald, Pushover/Toast, Mail-status, SMS, "Intet svar" og kompakt vikaroverblik.
// @match        https://ajourcare.temponizer.dk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.pushover.net
// @connect      raw.githubusercontent.com
// @connect      ajourcare.temponizer.dk
// @connect      vipvikaraps.sharepoint.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// @downloadURL  https://raw.githubusercontent.com/danieldamdk/temponizer-notifikation/main/temponizer.user.js
// ==/UserScript==

(() => {
  'use strict';

  const TP_VERSION = '7.14.0';
  const IS_TEST = globalThis.__TP_TEST_MODE__ === true;

  const PUSHOVER_TOKEN = 'a27du13k8h2yf8p4wabxeukthr1fu7';
  const MESSAGE_POLL_MS = 15000;
  const INTEREST_POLL_MS = 30000;
  const SUPPRESS_MS = 45000;
  const LOCK_MS = SUPPRESS_MS + 5000;
  const FETCH_TIMEOUT_MS = 12000;
  const INTEREST_DETAIL_CONCURRENCY = 4;
  const MESSAGE_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MESSAGE_SEEN_LIMIT = 512;
  const WORKER_HOVER_CACHE_MS = 5 * 60 * 1000;
  const WORKER_HOVER_CACHE_LIMIT = 80;
  const WORKER_HOVER_HIDE_MS = 100;
  const WORKER_HOVER_CANCEL_PAGE_LIMIT = 20;
  const INCOMING_CALL_LOCK_MS = 12000;
  const INCOMING_CALL_CARD_MS = 30000;
  const INCOMING_CALL_POLL_MS = 5000;

  const LEADER_KEY = 'tpLeaderV3';
  const HEARTBEAT_MS = 5000;
  const LEASE_MS = 75000;
  const MUTEX_LEASE_MS = 15000;
  const MUTEX_WAIT_MS = 5000;
  const TAB_ID = globalThis.crypto?.randomUUID?.() || ('tab-' + Math.random().toString(36).slice(2) + Date.now());

  const GH_OWNER = 'danieldamdk';
  const GH_REPO = 'temponizer-notifikation';
  const GH_BRANCH = 'main';
  const SCRIPT_RAW_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/temponizer.user.js`;

  const TP_MAIL_PUSH = {
    key: 'tpPushEnableMail',
    spSite: 'https://vipvikaraps.sharepoint.com/sites/Vikarkonsulenter',
    listTitle: 'TemponizerSettings',
    itemTitle: 'PushoverMail',
    loginUrl: 'https://vipvikaraps.sharepoint.com/sites/Vikarkonsulenter/Lists/TemponizerSettings/AllItems.aspx',
    pollMs: 30000
  };

  const TP_CALL_QUEUE = {
    spSite: TP_MAIL_PUSH.spSite,
    listTitle: 'TemponizerCalls',
    pollMs: INCOMING_CALL_POLL_MS,
    batchSize: 20,
    notificationMaxAgeMs: 10 * 60 * 1000
  };

  const ORIGIN = globalThis.location?.origin || 'https://ajourcare.temponizer.dk';
  const MSG_COUNTER_URL = ORIGIN + '/index.php?page=get_comcenter_counters&ajax=true';
  const MSG_LIST_BASE = ORIGIN + '/index.php?page=get_comcenter_contents&ajax=true&vagt_avail_id=0&vikar_id=0&kontor_id=0&hidemsg=false&comcentertype=';
  const MSG_LIST_URLS = Object.freeze({
    vagt: MSG_LIST_BASE + 'vagt',
    generel: MSG_LIST_BASE + 'gen'
  });
  const INTEREST_URL = ORIGIN + '/index.php?page=freevagter';
  const INTEREST_DETAIL_URL = ORIGIN + '/index.php?page=update_vikar_synlighed_from_list&ajax=true';
  const SMS_SETTINGS_URL = ORIGIN + '/index.php?page=showmy_settings';

  const ST_MSG_KEY = 'tpMessageStateV5';
  const ST_INT_KEY = 'tpInterestStateV3';
  const POS_KEY = 'tpPanelPosV4';
  const TOAST_EVT_KEY = 'tpToastEventV2';
  const INCOMING_CALL_LOCK_KEY = 'tpIncomingCallLockV1';
  const INCOMING_CALL_QUEUE_STATE_KEY = 'tpIncomingCallQueueStateV1';
  const INCOMING_CALL_HASH_PREFIX = '#tp-call=';
  const QUICK_NO_ANSWER_TEXT = 'Intet Svar';
  const QUICK_NO_ANSWER_LINK_SELECTOR = 'a[onclick*="RingVikarOp("]';
  const WORKER_HOVER_CACHE_KEY = 'tpWorkerHoverCacheV2';
  const WORKER_ROW_SELECTOR = 'tr[id^="row_"]';
  const WORKER_SICK_COLOR = '#b32727';
  const WORKER_WITHDRAWN_COLOR = '#1736e6';

  let messagePollInFlight = false;
  let interestPollInFlight = false;
  let incomingCallPollInFlight = false;
  let incomingCallUserEmail = '';
  let incomingCallQueueErrorNotifiedAt = 0;
  let tpMailPushBusy = false;
  let tpMailRefreshInFlight = false;
  let tpMailRefreshGeneration = 0;
  let tpMailPushTimer = null;
  let tpSpDigestCache = { value: '', expires: 0 };
  let tpSpEntityTypeCache = '';
  const workerHoverRequests = new Map();

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function now() {
    return Date.now();
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n ]+/g, ' ')
      .trim();
  }

  function truncateText(value, maxLength) {
    const text = normalizeText(value);
    if (text.length <= maxLength) return text;
    if (maxLength <= 1) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 1).trimEnd() + '…';
  }

  function clampInteger(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  function parseNullableCount(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  function parseMessageCounters(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    return {
      vagt: parseNullableCount(data.vagt_unread),
      generel: parseNullableCount(data.generel_unread),
      brugere: parseNullableCount(data.brugere_unread)
    };
  }

  function compareVersions(left, right) {
    const a = String(left || '').split('.').map(part => parseInt(part, 10) || 0);
    const b = String(right || '').split('.').map(part => parseInt(part, 10) || 0);
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(String(html || ''), 'text/html');
  }

  function parseLabelCount(value, zeroWhenUnnumbered = false) {
    const text = normalizeText(value);
    const match = text.match(/\(([\d.]+)\)\s*$/);
    if (match) return clampInteger(match[1].replace(/\./g, ''), 0);
    return zeroWhenUnnumbered && text ? 0 : null;
  }

  function formatDanishDate(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}.${date.getFullYear()}`;
  }

  function getWorkerHoverDateRange(referenceDate = new Date()) {
    const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - 1);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 89);
    return {
      start,
      end,
      startText: formatDanishDate(start),
      endText: formatDanishDate(end)
    };
  }

  function parseDanishDate(value) {
    const match = normalizeText(value).match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    if (!match) return null;
    const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function normalizePhoneNumber(value) {
    const phonePart = String(value || '').split('*', 1)[0];
    let digits = phonePart.replace(/\D/g, '');
    if (digits.startsWith('0045') && digits.length >= 12) digits = digits.slice(4);
    else if (digits.startsWith('45') && digits.length === 10) digits = digits.slice(2);
    return digits.length === 8 ? digits : '';
  }

  function formatPhoneNumber(value) {
    const phone = normalizePhoneNumber(value);
    return phone ? phone.replace(/(\d{2})(?=\d)/g, '$1 ').trim() : '';
  }

  function getIncomingCallNumberFromHash(hash = globalThis.location?.hash || '') {
    const value = String(hash || '');
    if (!value.toLocaleLowerCase('da').startsWith(INCOMING_CALL_HASH_PREFIX)) return '';
    try {
      return normalizePhoneNumber(decodeURIComponent(value.slice(INCOMING_CALL_HASH_PREFIX.length)));
    } catch (_) {
      return normalizePhoneNumber(value.slice(INCOMING_CALL_HASH_PREFIX.length));
    }
  }

  function parseIncomingCallSearchHTML(html, expectedPhone = '') {
    const phone = normalizePhoneNumber(expectedPhone);
    if (!phone) return [];
    const doc = parseHtml(html);
    const matches = [];
    const seen = new Set();
    for (const row of doc.querySelectorAll('tr')) {
      const profileLink = row.querySelector('a[href*="page=showvikaroplysninger"][href*="vikar_id="]');
      const phoneLink = row.querySelector('a[href^="tel:"]');
      const href = profileLink?.getAttribute('href') || '';
      const workerId = href.match(/[?&]vikar_id=(\d+)/)?.[1] || '';
      const rowPhone = normalizePhoneNumber(phoneLink?.getAttribute('href') || phoneLink?.textContent || '');
      if (!workerId || rowPhone !== phone || seen.has(workerId)) continue;

      const profileLinks = Array.from(row.querySelectorAll('a[href*="page=showvikaroplysninger"][href*="vikar_id="]'));
      const nameLink = profileLinks.find(link => !/^\d+$/.test(normalizeText(link.textContent))) || profileLink;
      const name = normalizeText(nameLink?.textContent);
      if (!name) continue;
      seen.add(workerId);
      matches.push({ workerId, name, phone: rowPhone, profileUrl: buildWorkerProfileURL(workerId) });
    }
    return matches;
  }

  function parseWorkerProfileHTML(html) {
    const doc = parseHtml(html);
    const completedTabs = [
      doc.querySelector('#afholdtikkegodkendt_link'),
      doc.querySelector('#afholdtgodkendt_link'),
      doc.querySelector('#loenudbetalt_link')
    ];
    const completedCounts = completedTabs.map(tab => tab ? parseLabelCount(tab.textContent, true) : null);
    const complaintTab = doc.querySelector('#klager_link');
    return {
      totalCompletedShifts: completedCounts.every(Number.isInteger)
        ? completedCounts.reduce((sum, count) => sum + count, 0)
        : null,
      complaints: complaintTab ? parseLabelCount(complaintTab.textContent, true) : null
    };
  }

  function parseWorkerStatsHTML(html) {
    const doc = parseHtml(html);
    const values = new Map();
    for (const row of doc.querySelectorAll('tr')) {
      const cells = Array.from(row.cells || []);
      for (let index = 0; index + 1 < cells.length; index += 2) {
        const label = normalizeText(cells[index].textContent).replace(/:\s*$/, '').toLocaleLowerCase('da');
        if (!label || values.has(label)) continue;
        const rawValue = normalizeText(cells[index + 1].textContent);
        const match = rawValue.match(/-?[\d.]+/);
        if (match) values.set(label, clampInteger(match[0].replace(/\./g, ''), 0));
      }
    }
    return {
      completedShifts: values.get('antal vagter') ?? null,
      sickShifts: values.get('antal sygevagter') ?? null
    };
  }

  function parseWorkerCancellationHTML(html, range = {}) {
    const doc = parseHtml(html);
    const startTime = range.start instanceof Date ? range.start.getTime() : -Infinity;
    const endTime = range.end instanceof Date ? range.end.getTime() : Infinity;
    const records = [];

    for (const row of doc.querySelectorAll('tr[id^="vagtrow_"]')) {
      const date = parseDanishDate(row.textContent);
      if (!date) continue;
      const marker = row.querySelector('span[style*="background-color"]');
      const color = (marker?.getAttribute('style')?.match(/#[0-9a-f]{6}/i)?.[0] || '').toLowerCase();
      records.push({ date, color });
    }

    const inRange = records.filter(record => {
      const time = record.date.getTime();
      return time >= startTime && time <= endTime;
    });
    const offsets = Array.from(doc.querySelectorAll('[onclick*="switchpage"]'))
      .map(element => element.getAttribute('onclick')?.match(/switchpage\(\s*['"]annullerede['"]\s*,\s*(\d+)/i)?.[1])
      .filter(Boolean)
      .map(Number);
    const oldestTime = records.length
      ? Math.min(...records.map(record => record.date.getTime()))
      : null;

    return {
      withdrawnShifts: inRange.filter(record => record.color === WORKER_WITHDRAWN_COLOR).length,
      redSickMarkers: inRange.filter(record => record.color === WORKER_SICK_COLOR).length,
      recordCount: records.length,
      oldestDate: oldestTime === null ? null : new Date(oldestTime),
      nextOffsets: Array.from(new Set(offsets.filter(offset => offset > 0))).sort((left, right) => left - right)
    };
  }

  function parseWorkerBlockingsHTML(html) {
    const doc = parseHtml(html);
    const toggle = doc.querySelector('#fold_knap');
    return toggle ? parseLabelCount(toggle.textContent, true) : null;
  }

  function getFirstText(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (!element) continue;
      const titled = normalizeText(element.getAttribute('title'));
      if (titled) return titled;
      const clone = element.cloneNode(true);
      clone.querySelectorAll('br').forEach(br => br.replaceWith(' '));
      const text = normalizeText(clone.textContent);
      if (text) return text;
    }
    return '';
  }

  function readUnreadValue(row) {
    const input = row.querySelector('input[id*="unread_count"], input[name*="unread_count"]');
    if (input) return clampInteger(input.value, 0);
    const count = getFirstText(row, ['[id^="new_count_"]', '[class*="unread"]']);
    const match = count.match(/\d+/);
    return match ? clampInteger(match[0], 0) : 0;
  }

  function parseMessageRowIdentity(row, typeHint) {
    const source = [
      row.id || '',
      row.getAttribute('onclick') || '',
      row.querySelector('[onclick]')?.getAttribute('onclick') || ''
    ].join(' ');

    const vagtMatch = source.match(/(?:vikarsms_|MultiList\([^,]*,\s*)(\d+)[_,)](\d+)/i)
      || source.match(/(?:vikarsms_|vagt_unread_count_)(\d+)_(\d+)/i);
    if (vagtMatch) {
      return { type: 'vagt', vikarId: vagtMatch[1], vagtId: vagtMatch[2] };
    }

    const generalMatch = source.match(/(?:generelsms_|GenerelSMSConversationFromMultiList\([^,]*,?\s*)(\d+)/i)
      || row.querySelector('input[id*="unread_count"]')?.id.match(/unread_count_(\d+)/i);
    if (generalMatch) {
      return { type: 'generel', vikarId: generalMatch[1], vagtId: '' };
    }

    return typeHint === 'generel' ? null : null;
  }

  function parseMessageIndexHTML(html, typeHint = 'vagt') {
    const doc = parseHtml(html);
    const candidates = Array.from(doc.querySelectorAll(
      '.vikarsms, .generelsms, [id^="vikarsms_"], [id^="generelsms_"], [onclick*="SMSConversationFromMultiList"]'
    ));
    const seenNodes = new Set();
    const records = [];

    for (const candidate of candidates) {
      const row = candidate.closest('.vikarsms, .generelsms, [id^="vikarsms_"], [id^="generelsms_"]') || candidate;
      if (seenNodes.has(row)) continue;
      seenNodes.add(row);

      const identity = parseMessageRowIdentity(row, typeHint);
      if (!identity) continue;

      const unread = readUnreadValue(row);
      const name = getFirstText(row, [
        '.vikar_navn', '.generel_navn', '[class*="_navn"]', '[class*="name"]'
      ]).replace(/\s*\(\d+\)\s*$/, '').trim();
      const context = getFirstText(row, [
        '.vikar_vagtdata', '.generel_vagtdata', '[class*="vagtdata"]', '[class*="subject"]'
      ]);
      const activity = getFirstText(row, [
        '.vikar_dato', '.generel_dato', '[class*="_dato"]', 'time'
      ]);
      const key = identity.type === 'vagt'
        ? `vagt:${identity.vikarId}:${identity.vagtId}`
        : `generel:${identity.vikarId}`;

      records.push({
        key,
        type: identity.type,
        vikarId: identity.vikarId,
        vagtId: identity.vagtId,
        name: name || 'Ukendt vikar',
        unread,
        context,
        activity,
        snippet: ''
      });
    }

    return {
      records,
      unread: records.reduce((sum, record) => sum + record.unread, 0),
      recognized: candidates.length > 0 || /Endnu ikke aktiveret|ingen beskeder/i.test(doc.body?.textContent || '')
    };
  }

  function parseSidebarPreviews(doc = document) {
    const previews = [];
    for (const row of Array.from(doc.querySelectorAll('.komm_log_sms, .komm_log_sms_vagt'))) {
      const source = [row.className || '', row.id || '', row.getAttribute('onclick') || ''].join(' ');
      const specificMatch = source.match(/komm_log_sms_vagt_(\d+)_(\d+)/i)
        || source.match(/showsmslog\(\s*(\d+)\s*,\s*(\d+)/i);
      const generalMatch = source.match(/(?:gen_vagt_|gen_bruger_|OpenSMSDialog\(\s*)(\d+)/i);
      if (!specificMatch && !generalMatch) continue;

      const type = specificMatch ? 'vagt' : 'generel';
      const vikarId = specificMatch?.[1] || generalMatch?.[1] || '';
      const vagtId = specificMatch?.[2] || '';
      const incoming = !!specificMatch || /(?:^|\s)gen_vagt(?:_|\s)/i.test(source);
      const name = getFirstText(row, [
        '[class*="navn"]', '[class*="name"]', '.komm_log_sms_header', 'span[style*="font-weight:bold"]', 'strong', 'b'
      ]);
      let snippet = getFirstText(row, [
        '[class*="besked"]', '[class*="message"]', '[class*="tekst"]', '[class*="text"]'
      ]);
      const fullText = normalizeText(row.textContent);
      if (!snippet) {
        snippet = name && fullText.startsWith(name)
          ? normalizeText(fullText.slice(name.length))
          : fullText;
      }

      const overlay = row.querySelector('img[src*="overlay"]')?.parentElement;
      const unread = !!overlay && hasDisplayBlock(overlay);

      previews.push({
        type,
        vikarId,
        vagtId,
        name,
        snippet: truncateText(snippet, 300),
        incoming,
        unread
      });
    }
    return previews;
  }

  function parseOpenThreadPreview(doc = document) {
    const wrapper = doc.querySelector('#smsmessages_wrapper');
    if (!wrapper) return null;

    const identitySource = [wrapper.id, wrapper.className, wrapper.getAttribute('data-vikar-id') || ''];
    for (const input of Array.from(wrapper.querySelectorAll('input[type="hidden"]'))) {
      identitySource.push(input.id || '', input.name || '', input.value || '');
    }
    const source = identitySource.join(' ');
    const vikarMatch = source.match(/vikar(?:_id)?[^\d]{0,8}(\d+)/i);
    const vagtMatch = source.match(/vagt(?:_avail)?(?:_id)?[^\d]{0,8}(\d+)/i);
    if (!vikarMatch) return null;

    const messages = Array.from(wrapper.querySelectorAll('.smsmessage'));
    const latest = messages[messages.length - 1];
    if (!latest) return null;
    const incoming = latest.classList.contains('smsfrom')
      ? true
      : (latest.classList.contains('smsto') ? false : null);
    const clone = latest.cloneNode(true);
    clone.querySelectorAll('.smsdatetime, time, script, style').forEach(node => node.remove());
    const snippet = truncateText(clone.textContent, 300);
    if (!snippet) return null;

    return {
      type: vagtMatch ? 'vagt' : 'generel',
      vikarId: vikarMatch[1],
      vagtId: vagtMatch?.[1] || '',
      incoming,
      snippet
    };
  }

  function enrichMessageRecords(records, sidebarPreviews, openPreview) {
    const previews = Array.isArray(sidebarPreviews) ? sidebarPreviews : [];
    return records.map(record => {
      const openMatches = openPreview
        && openPreview.vikarId === record.vikarId
        && (!openPreview.vagtId || openPreview.vagtId === record.vagtId);
      const matchingPreviews = previews.filter(preview => preview.vikarId === record.vikarId
        && preview.type === record.type
        && (!preview.vagtId || preview.vagtId === record.vagtId));
      const unreadIncoming = matchingPreviews.find(preview => preview.incoming === true && preview.unread === true);
      const unreadOutgoing = matchingPreviews.find(preview => preview.incoming === false && preview.unread === true);
      const sidebar = unreadIncoming || unreadOutgoing || matchingPreviews[0]
        || previews.find(preview => preview.vikarId === record.vikarId);
      const snippet = openMatches ? openPreview.snippet : (sidebar?.snippet || '');
      const name = record.name === 'Ukendt vikar' && sidebar?.name ? sidebar.name : record.name;
      const incoming = record.type === 'vagt'
        ? true
        : (openMatches && typeof openPreview.incoming === 'boolean'
          ? openPreview.incoming
          : (unreadIncoming ? true : (unreadOutgoing ? false : null)));
      return { ...record, name, incoming, snippet: truncateText(snippet, 300) };
    });
  }

  function buildMessageRecordMap(sourceRecords, sidebarPreviews, openPreview) {
    const previews = Array.isArray(sidebarPreviews) ? sidebarPreviews : [];
    const enriched = enrichMessageRecords(sourceRecords, previews, openPreview);
    return recordsToMap(enriched);
  }

  function messageRecordSignature(record) {
    return [
      clampInteger(record.unread, 0),
      normalizeText(record.activity),
      normalizeText(record.snippet)
    ].join('|');
  }

  function recordsToMap(records) {
    const map = {};
    for (const source of records || []) {
      if (!source?.key) continue;
      const record = { ...source, unread: clampInteger(source.unread, 0) };
      record.signature = messageRecordSignature(record);
      map[record.key] = record;
    }
    return map;
  }

  function countUnreadMessageThreads(recordMap) {
    return Object.values(recordMap || {}).filter(record => clampInteger(record?.unread, 0) > 0).length;
  }

  function isIncomingMessageRecord(record) {
    if (!record || clampInteger(record.unread, 0) <= 0) return false;
    return record.type === 'vagt' || record.incoming === true;
  }

  function countIncomingUnreadThreads(recordMap) {
    return Object.values(recordMap || {}).filter(isIncomingMessageRecord).length;
  }

  function hasUnresolvedGeneralDirection(recordMap) {
    return Object.values(recordMap || {}).some(record => record?.type === 'generel'
      && clampInteger(record.unread, 0) > 0
      && record.incoming !== true
      && record.incoming !== false);
  }

  function resolveMessageCounterTotal(counters, vagtRecords, generalRecords) {
    const values = counters || {};
    const vagtThreadTotal = (vagtRecords || []).filter(record => clampInteger(record?.unread, 0) > 0).length;
    const generalThreadTotal = (generalRecords || []).filter(record => clampInteger(record?.unread, 0) > 0).length;
    return (values.vagt ?? vagtThreadTotal)
      + (values.generel ?? generalThreadTotal)
      + (values.brugere ?? 0);
  }

  function messageEventId(record) {
    if (!record?.key) return '';
    return `${record.key}|${record.signature || messageRecordSignature(record)}`;
  }

  function pruneSeenMessageEvents(value, time = Date.now()) {
    const source = value && typeof value === 'object' ? value : {};
    const oldest = time - MESSAGE_SEEN_TTL_MS;
    return Object.fromEntries(Object.entries(source)
      .map(([eventId, timestamp]) => [eventId, clampInteger(timestamp, 0)])
      .filter(([eventId, timestamp]) => !!eventId && timestamp >= oldest)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MESSAGE_SEEN_LIMIT));
  }

  function rememberMessageRecords(seen, recordMap, time = Date.now()) {
    const next = { ...(seen || {}) };
    for (const record of Object.values(recordMap || {})) {
      if (!isIncomingMessageRecord(record)) continue;
      const eventId = messageEventId(record);
      if (eventId) next[eventId] = time;
    }
    return pruneSeenMessageEvents(next, time);
  }

  function carryForwardMessageDetails(currentMap, previousMap) {
    const current = currentMap || {};
    const previous = previousMap || {};
    const result = {};
    for (const [key, source] of Object.entries(current)) {
      const old = previous[key];
      const sameUnread = old && clampInteger(source.unread, 0) === clampInteger(old.unread, 0);
      const sameActivity = old && normalizeText(source.activity) === normalizeText(old.activity);
      const record = { ...source };
      if (sameUnread && sameActivity) {
        if (!record.snippet && old.snippet) record.snippet = old.snippet;
        if ((!record.name || record.name === 'Ukendt vikar') && old.name) record.name = old.name;
        if (!record.context && old.context) record.context = old.context;
        if (typeof record.incoming !== 'boolean' && typeof old.incoming === 'boolean') {
          record.incoming = old.incoming;
        }
      }
      record.signature = messageRecordSignature(record);
      result[key] = record;
    }
    return result;
  }

  function diffMessageThreads(previousMap, currentMap) {
    const previous = previousMap || {};
    const current = currentMap || {};
    const events = [];

    for (const record of Object.values(current)) {
      if (!record || record.unread <= 0) continue;
      const old = previous[record.key];
      const signature = record.signature || messageRecordSignature(record);
      let delta = 0;

      if (!old) {
        delta = record.unread;
      } else if (record.unread > clampInteger(old.unread, 0)) {
        delta = record.unread - clampInteger(old.unread, 0);
      } else if (record.type === 'generel' && record.incoming === true && old.incoming !== true) {
        delta = 1;
      } else if (
        clampInteger(old.unread, 0) > 0
        && signature !== (old.signature || messageRecordSignature(old))
        && (normalizeText(record.activity) !== normalizeText(old.activity)
          || (normalizeText(record.snippet)
            && normalizeText(old.snippet)
            && normalizeText(record.snippet) !== normalizeText(old.snippet)))
      ) {
        delta = 1;
      }

      if (delta > 0) {
        events.push({
          kind: 'thread',
          key: record.key,
          eventId: messageEventId({ ...record, signature }),
          signature,
          delta,
          record
        });
      }
    }
    return events;
  }

  function mergePendingEvents(existing, additions, uniqueBy = 'eventId') {
    const merged = new Map();
    for (const event of existing || []) {
      if (event?.[uniqueBy]) merged.set(event[uniqueBy], event);
    }
    for (const event of additions || []) {
      if (!event?.[uniqueBy]) continue;
      if (event.key) {
        for (const [id, pending] of merged) {
          if (pending.key === event.key && id !== event[uniqueBy]) merged.delete(id);
        }
      }
      merged.set(event[uniqueBy], event);
    }
    return Array.from(merged.values());
  }

  function prunePendingMessageEvents(pending, currentMap, currentTotal) {
    const map = currentMap || {};
    return (pending || []).filter(event => {
      if (event.kind === 'generic') return currentTotal >= clampInteger(event.targetTotal, 1);
      const record = map[event.key];
      if (!isIncomingMessageRecord(record)) return false;
      return !event.signature || event.signature === (record.signature || messageRecordSignature(record));
    });
  }

  function parseTopMenuMessageCount(doc = document) {
    const directIds = ['vagt_unread_div', 'generel_unread_div', 'brugere_unread_div'];
    let directTotal = 0;
    let directFound = false;
    for (const id of directIds) {
      const el = doc.getElementById(id);
      if (!el) continue;
      const match = normalizeText(el.textContent).match(/\d+/);
      if (match) {
        directFound = true;
        directTotal += clampInteger(match[0], 0);
      }
    }
    if (directFound) return directTotal;

    for (const element of Array.from(doc.querySelectorAll('a, button, li, span'))) {
      const text = normalizeText(element.textContent);
      if (!/Beskeder/i.test(text)) continue;
      const match = text.match(/Beskeder\s*\((\d+)\)/i) || text.match(/\((\d+)\)/);
      if (match) return clampInteger(match[1], 0);
    }
    return null;
  }

  function cleanCellText(cell) {
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('script, style, input, button, [style*="display:none"], [style*="display: none"]').forEach(node => node.remove());
    return normalizeText(clone.textContent);
  }

  function stripCustomerNumber(value) {
    return normalizeText(value)
      .replace(/^\d+\s*/, '')
      .replace(/^([A-ZÆØÅ]{1,8})\s*-\s*/i, '$1 - ')
      .trim();
  }

  function cleanCustomerName(cell) {
    if (!cell) return '';
    const preferred = cell.querySelector('[id^="kunde_navn_span_"], .fullname');
    const text = normalizeText(preferred?.getAttribute('title') || preferred?.textContent || cleanCellText(cell));
    return stripCustomerNumber(text);
  }

  function parseInterestOverviewHTML(html) {
    const doc = parseHtml(html);
    const shifts = [];
    const seen = new Set();
    const boxes = Array.from(doc.querySelectorAll('[id^="vagtlist_synlig_interesse_display_number_"], [id*="interesse"][id*="display_number"]'));

    for (const box of boxes) {
      const match = (box.id || '').match(/display_number_(\d+)_(single|multi)/i);
      if (!match) continue;
      const id = match[1];
      const type = match[2].toLowerCase();
      const countMatch = normalizeText(box.textContent).match(/\d+/);
      const count = countMatch ? clampInteger(countMatch[0], 0) : 0;
      if (count <= 0 || seen.has(`${id}:${type}`)) continue;
      seen.add(`${id}:${type}`);

      const row = box.closest('tr');
      const cells = row ? Array.from(row.children).filter(child => child.tagName === 'TD') : [];
      const date = cleanCellText(cells[7]);
      const time = cleanCellText(cells[8]);
      const education = cleanCellText(cells[10]);
      const customer = cleanCustomerName(cells[11]);

      shifts.push({ id, type, count, date, time, education, customer });
    }

    return {
      shifts,
      total: shifts.reduce((sum, shift) => sum + shift.count, 0),
      recognized: boxes.length > 0
    };
  }

  function parseInterestDetailHTML(html, shift) {
    const doc = parseHtml(html);
    const entries = [];
    const rows = Array.from(doc.querySelectorAll('.vikar_interresse_list_container, [id^="vagter_synlig_container_"]'));
    const seen = new Set();

    for (const row of rows) {
      const match = (row.id || '').match(/vagter_synlig_container_(\d+)_(\d+)/i);
      if (!match) continue;
      const vikarId = match[1];
      const vagtId = match[2];
      if (String(vagtId) !== String(shift.id)) continue;
      const key = `${vagtId}:${vikarId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const name = getFirstText(row, ['.vikar_interresse_list_navn_container', '[class*="_navn_"]', '[class*="navn"]']);
      const education = getFirstText(row, ['.vikar_interresse_list_udd_container', '[class*="_udd_"]', '[class*="udd"]']);
      const interestDate = getFirstText(row, ['.vikar_interresse_list_dato_container', '[class*="_dato_"]', '[class*="dato"]']);
      entries.push({
        key,
        vikarId,
        vagtId,
        name: name || 'Ukendt vikar',
        education,
        interestDate,
        shift: { ...shift }
      });
    }
    return entries;
  }

  function entriesToMap(entries) {
    const map = {};
    for (const entry of entries || []) {
      if (entry?.key) map[entry.key] = entry;
    }
    return map;
  }

  function diffInterestPairs(previousMap, currentMap) {
    const previous = previousMap || {};
    const current = currentMap || {};
    return Object.values(current)
      .filter(entry => entry?.key && !previous[entry.key])
      .map(entry => ({
        kind: 'interest',
        key: entry.key,
        eventId: entry.key,
        entry
      }));
  }

  function prunePendingInterestEvents(pending, currentMap) {
    const current = currentMap || {};
    return (pending || []).filter(event => !!current[event.key]);
  }

  function formatShift(shift) {
    const customer = normalizeText(shift?.customer) || `Vagt ${shift?.id || ''}`.trim();
    const when = normalizeText([shift?.date, shift?.time].filter(Boolean).join(' '));
    return [customer, when].filter(Boolean).join(' · ');
  }

  function formatMessageNotification(events) {
    const list = Array.isArray(events) ? events : [];
    const total = list.reduce((sum, event) => sum + Math.max(1, clampInteger(event.delta, 1)), 0);
    let title;
    let body;

    if (list.length === 1 && list[0].kind !== 'generic') {
      const record = list[0].record || {};
      title = `Ny besked fra ${record.name || 'en vikar'}`;
      const lines = [];
      if (record.snippet) lines.push(truncateText(record.snippet, 500));
      else lines.push('Ny ulæst besked');
      if (record.type === 'vagt' && record.context) {
        lines.push('Vagt: ' + truncateText(record.context, 260));
      }
      body = lines.join('\n');
    } else {
      title = `${total || list.length} nye Temponizer-beskeder`;
      const lines = list.slice(0, 3).map(event => {
        if (event.kind === 'generic') return event.text || 'Ny ulæst besked';
        const record = event.record || {};
        const detail = record.snippet
          || (record.type === 'vagt' ? record.context : '')
          || 'Ny ulæst besked';
        return `${record.name || 'Ukendt vikar'}: ${truncateText(detail, 190)}`;
      });
      if (list.length > 3) lines.push(`+${list.length - 3} flere`);
      body = lines.join('\n');
    }

    title = truncateText(title, 80);
    body = truncateText(body, 850);
    return { title, body, toast: truncateText(`${title}: ${body}`, 260) };
  }

  function formatInterestNotification(events) {
    const list = Array.isArray(events) ? events : [];
    let title;
    let body;

    if (list.length === 1) {
      const entry = list[0].entry || {};
      title = `Ny interesse fra ${entry.name || 'en vikar'}`;
      const lines = [formatShift(entry.shift)];
      if (entry.education) lines.push(truncateText(entry.education, 160));
      body = lines.filter(Boolean).join('\n');
    } else {
      title = `${list.length} nye interesser`;
      const lines = list.slice(0, 3).map(event => {
        const entry = event.entry || {};
        return `${entry.name || 'Ukendt vikar'}: ${truncateText(formatShift(entry.shift), 190)}`;
      });
      if (list.length > 3) lines.push(`+${list.length - 3} flere`);
      body = lines.join('\n');
    }

    title = truncateText(title, 80);
    body = truncateText(body, 850);
    return { title, body, toast: truncateText(`${title}: ${body}`, 260) };
  }

  async function mapLimit(items, limit, mapper) {
    const list = Array.from(items || []);
    const results = new Array(list.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(clampInteger(limit, 1), list.length || 1));

    async function worker() {
      while (nextIndex < list.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(list[index], index);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : structuredCloneFallback(fallback);
    } catch (_) {
      return structuredCloneFallback(fallback);
    }
  }

  function structuredCloneFallback(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('[TP] Kunne ikke gemme lokal status', error);
    }
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchText(url, options) {
    return (await fetchWithTimeout(url, options)).text();
  }

  async function fetchJson(url, options) {
    return (await fetchWithTimeout(url, options)).json();
  }

  async function fetchIncomingCallMatches(phone) {
    const normalized = normalizePhoneNumber(phone);
    if (!normalized) return [];
    const body = new URLSearchParams({
      page: 'do_gen_search',
      ajax: 'true',
      term: normalized
    }).toString();
    const html = await fetchText(ORIGIN + '/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });
    if (parseHtml(html).querySelector('#login-form, form[action*="login"]')) {
      throw new Error('TP_LOGIN_REQUIRED');
    }
    return parseIncomingCallSearchHTML(html, normalized);
  }

  function buildWorkerProfileURL(workerId, hash = '') {
    return ORIGIN + '/index.php?page=showvikaroplysninger&vikar_id=' + encodeURIComponent(workerId) + hash;
  }

  function loadWorkerHoverCache() {
    const cache = loadJson(WORKER_HOVER_CACHE_KEY, { entries: {} });
    return cache && typeof cache === 'object' && cache.entries && typeof cache.entries === 'object'
      ? cache
      : { entries: {} };
  }

  function getCachedWorkerHoverData(workerId) {
    const entry = loadWorkerHoverCache().entries[String(workerId)];
    return entry && entry.expires > now() && entry.data ? entry.data : null;
  }

  function saveCachedWorkerHoverData(workerId, data) {
    const cache = loadWorkerHoverCache();
    const currentTime = now();
    cache.entries[String(workerId)] = {
      expires: currentTime + WORKER_HOVER_CACHE_MS,
      touched: currentTime,
      data
    };
    const entries = Object.entries(cache.entries)
      .filter(([, entry]) => entry?.expires > currentTime && entry?.data)
      .sort((left, right) => (right[1].touched || 0) - (left[1].touched || 0))
      .slice(0, WORKER_HOVER_CACHE_LIMIT);
    cache.entries = Object.fromEntries(entries);
    saveJson(WORKER_HOVER_CACHE_KEY, cache);
  }

  async function fetchWorkerCancellationSummary(workerId, range) {
    const pendingOffsets = [0];
    const visitedOffsets = new Set();
    let withdrawnShifts = 0;

    while (pendingOffsets.length && visitedOffsets.size < WORKER_HOVER_CANCEL_PAGE_LIMIT) {
      const offset = pendingOffsets.shift();
      if (visitedOffsets.has(offset)) continue;
      visitedOffsets.add(offset);
      const url = ORIGIN + '/index.php?page=vagtlist_get&ajax=true&switchpage=true&vikar_id=' +
        encodeURIComponent(workerId) + '&type=annullerede&offset=' + offset;
      const parsed = parseWorkerCancellationHTML(await fetchText(url), range);
      withdrawnShifts += parsed.withdrawnShifts;

      if (!parsed.recordCount || (parsed.oldestDate && parsed.oldestDate.getTime() <= range.start.getTime())) break;
      for (const nextOffset of parsed.nextOffsets) {
        if (!visitedOffsets.has(nextOffset) && !pendingOffsets.includes(nextOffset)) pendingOffsets.push(nextOffset);
      }
    }

    return { withdrawnShifts };
  }

  async function fetchWorkerHoverData(workerId) {
    const cached = getCachedWorkerHoverData(workerId);
    if (cached) return cached;

    const range = getWorkerHoverDateRange();
    const profileUrl = buildWorkerProfileURL(workerId);
    const statsUrl = ORIGIN + '/index.php?page=get_vikar_statistik_detail&ajax=true&vikar_id=' +
      encodeURIComponent(workerId) + '&stat_periode_start=' + encodeURIComponent(range.startText) +
      '&stat_periode_slut=' + encodeURIComponent(range.endText) + '&kunder_stat_sel=0';
    const blockingsUrl = ORIGIN + '/index.php?page=get_blokeringer&vikar_id=' +
      encodeURIComponent(workerId) + '&ajax=true';

    const [profileResult, statsResult, cancellationResult, blockingsResult] = await Promise.allSettled([
      fetchText(profileUrl).then(parseWorkerProfileHTML),
      fetchText(statsUrl).then(parseWorkerStatsHTML),
      fetchWorkerCancellationSummary(workerId, range),
      fetchText(blockingsUrl).then(parseWorkerBlockingsHTML)
    ]);

    if ([profileResult, statsResult, cancellationResult, blockingsResult].every(result => result.status === 'rejected')) {
      throw new Error('Alle vikarens datakilder fejlede');
    }

    const profile = profileResult.status === 'fulfilled' ? profileResult.value : {};
    const stats = statsResult.status === 'fulfilled' ? statsResult.value : {};
    const cancellations = cancellationResult.status === 'fulfilled' ? cancellationResult.value : {};
    const data = {
      completedShifts: stats.completedShifts ?? null,
      totalCompletedShifts: profile.totalCompletedShifts ?? null,
      sickShifts: stats.sickShifts ?? null,
      withdrawnShifts: cancellations.withdrawnShifts ?? null,
      complaints: profile.complaints ?? null,
      blockings: blockingsResult.status === 'fulfilled' ? blockingsResult.value : null
    };
    if (Object.values(data).every(value => value !== null && value !== undefined)) {
      saveCachedWorkerHoverData(workerId, data);
    }
    return data;
  }

  function getWorkerHoverData(workerId) {
    const key = String(workerId);
    if (!workerHoverRequests.has(key)) {
      workerHoverRequests.set(key, fetchWorkerHoverData(key).finally(() => workerHoverRequests.delete(key)));
    }
    return workerHoverRequests.get(key);
  }

  async function fetchMessageSnapshot() {
    const stamp = Date.now();
    const [counterResult, vagtResult, generalResult] = await Promise.allSettled([
      fetchJson(MSG_COUNTER_URL + '&_=' + stamp),
      fetchText(MSG_LIST_URLS.vagt + '&_=' + stamp),
      fetchText(MSG_LIST_URLS.generel + '&_=' + stamp)
    ]);

    if (counterResult.status === 'rejected' && vagtResult.status === 'rejected' && generalResult.status === 'rejected') {
      throw new Error('Alle beskedkilder fejlede');
    }

    const counters = counterResult.status === 'fulfilled'
      ? parseMessageCounters(counterResult.value)
      : { vagt: null, generel: null, brugere: null };
    const vagtIndex = vagtResult.status === 'fulfilled'
      ? parseMessageIndexHTML(vagtResult.value, 'vagt')
      : { records: [], unread: 0, recognized: false };
    const generalIndex = generalResult.status === 'fulfilled'
      ? parseMessageIndexHTML(generalResult.value, 'generel')
      : { records: [], unread: 0, recognized: false };
    if (counterResult.status === 'rejected' && !vagtIndex.recognized && !generalIndex.recognized) {
      throw new Error('Beskedsvarene lignede ikke en aktiv Temponizer-session');
    }

    let effectiveCounters = counters;
    let sidebar = parseSidebarPreviews(document);
    const openThread = parseOpenThreadPreview(document);
    const sourceRecords = [...vagtIndex.records, ...generalIndex.records].filter(record => record.unread > 0);
    const vagtTotal = counters.vagt
      ?? vagtIndex.records.filter(record => record.unread > 0).length;
    const counterTotal = resolveMessageCounterTotal(counters, vagtIndex.records, generalIndex.records);
    const previousState = loadJson(ST_MSG_KEY, getDefaultMessageState());
    let recordMap = carryForwardMessageDetails(
      buildMessageRecordMap(sourceRecords, sidebar, openThread),
      previousState.records || {}
    );
    let detailedTotal = countUnreadMessageThreads(recordMap);
    let incomingTotal = countIncomingUnreadThreads(recordMap);
    const topMenuTotal = parseTopMenuMessageCount(document);
    let topMenuFallback = 0;
    let homepageEnriched = false;

    // Topmenuens DOM kan være forsinket. Brug den kun som signal til at hente
    // en frisk, læsende forside og accepter først derefter en højere total.
    if ((topMenuTotal ?? 0) > counterTotal) {
      try {
        const homepageDoc = parseHtml(await fetchText(ORIGIN + '/index.php?_=' + Date.now()));
        const freshTopMenuTotal = parseTopMenuMessageCount(homepageDoc) ?? 0;
        if (freshTopMenuTotal > counterTotal) {
          const inferredGeneral = Math.max(0, freshTopMenuTotal - vagtTotal);
          effectiveCounters = {
            ...counters,
            generel: Math.max(counters.generel ?? 0, inferredGeneral)
          };
          sidebar = parseSidebarPreviews(homepageDoc);
          recordMap = carryForwardMessageDetails(
            buildMessageRecordMap(sourceRecords, sidebar, openThread),
            previousState.records || {}
          );
          detailedTotal = countUnreadMessageThreads(recordMap);
          incomingTotal = countIncomingUnreadThreads(recordMap);
          topMenuFallback = freshTopMenuTotal;
          homepageEnriched = true;
        }
      } catch (error) {
        console.warn('[TP][MSG] Kunne ikke bekræfte topmenuens beskedtal', error);
      }
    }

    const rawTotal = Math.max(counterTotal, topMenuFallback);
    const indexedVagtTotal = sourceRecords.filter(record => record.type === 'vagt').length;
    const vagtFallback = Math.max(0, vagtTotal - indexedVagtTotal);
    const userFallback = counters.brugere ?? 0;
    const total = incomingTotal + vagtFallback + userFallback;

    return {
      total,
      rawTotal,
      records: recordMap,
      sourceRecords,
      counters: effectiveCounters,
      detailedTotal,
      incomingTotal,
      vagtFallback,
      userFallback,
      topMenuTotal,
      homepageEnriched,
      observedAt: Date.now()
    };
  }

  async function refreshMessageEnrichmentIfNeeded(snapshot) {
    if (snapshot.homepageEnriched) return snapshot;
    const state = { ...getDefaultMessageState(), ...loadJson(ST_MSG_KEY, getDefaultMessageState()) };
    const generalUnread = (snapshot.counters?.generel ?? 0) + (snapshot.counters?.brugere ?? 0);
    const hasUndetailedGeneral = generalUnread > 0
      && !(snapshot.sourceRecords || []).some(record => record.type === 'generel');
    const hasUnresolvedGeneral = hasUnresolvedGeneralDirection(snapshot.records);
    if (!state.initialized && !hasUndetailedGeneral && !hasUnresolvedGeneral) return snapshot;
    const hasThreadChange = diffMessageThreads(state.records || {}, snapshot.records || {}).length > 0;
    const hasCountIncrease = snapshot.total > clampInteger(state.total, 0);
    if (!hasThreadChange && !hasCountIncrease && !hasUndetailedGeneral) return snapshot;

    try {
      const homepageHtml = await fetchText(ORIGIN + '/index.php?_=' + Date.now());
      const homepageDoc = parseHtml(homepageHtml);
      const freshPreviews = parseSidebarPreviews(homepageDoc);
      const records = buildMessageRecordMap(
        snapshot.sourceRecords || Object.values(snapshot.records || {}),
        freshPreviews,
        parseOpenThreadPreview(document)
      );
      const detailedTotal = countUnreadMessageThreads(records);
      const incomingTotal = countIncomingUnreadThreads(records);
      return {
        ...snapshot,
        records,
        detailedTotal,
        incomingTotal,
        total: incomingTotal
          + clampInteger(snapshot.vagtFallback, 0)
          + clampInteger(snapshot.userFallback, 0)
      };
    } catch (error) {
      console.warn('[TP][MSG] Kunne ikke hente frisk beskedoversigt', error);
      return snapshot;
    }
  }

  async function fetchInterestEntriesForShift(shift) {
    const url = INTEREST_DETAIL_URL
      + '&vagt_type=' + encodeURIComponent(shift.type)
      + '&vagt_avail_id=' + encodeURIComponent(shift.id)
      + '&_=' + Date.now();
    let entries = parseInterestDetailHTML(await fetchText(url), shift);
    if (entries.length !== shift.count) {
      await sleep(650);
      entries = parseInterestDetailHTML(await fetchText(url + '&retry=' + Date.now()), shift);
    }
    if (entries.length !== shift.count) {
      throw new Error(`Interesselisten for vagt ${shift.id} var ufuldstændig (${entries.length}/${shift.count})`);
    }
    return entries;
  }

  async function fetchInterestSnapshot() {
    const overview = parseInterestOverviewHTML(await fetchText(INTEREST_URL + '&_=' + Date.now()));
    if (!overview.recognized && overview.shifts.length === 0) {
      throw new Error('Kunne ikke genkende interessetællerne på siden');
    }
    const nested = await mapLimit(overview.shifts, INTEREST_DETAIL_CONCURRENCY, fetchInterestEntriesForShift);
    const entries = nested.flat();
    return {
      total: overview.total,
      pairs: entriesToMap(entries),
      observedAt: Date.now()
    };
  }

  function getLeader() {
    try {
      return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function setLeader(value) {
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify(value));
    } catch (_) {}
  }

  function isLeader() {
    const leader = getLeader();
    return !!(leader && leader.id === TAB_ID && leader.until > now());
  }

  function writeLeadership(time = now()) {
    setLeader({
      id: TAB_ID,
      until: time + LEASE_MS,
      ts: time,
      visible: !document.hidden
    });
  }

  function tryBecomeLeader(preferVisible = !document.hidden) {
    const leader = getLeader();
    const time = now();
    const expired = !leader || clampInteger(leader.until, 0) <= time;
    const visibleTakeover = preferVisible && leader && leader.id !== TAB_ID && leader.visible === false;
    if (expired || leader?.id === TAB_ID || visibleTakeover) {
      writeLeadership(time);
    }
    return isLeader();
  }

  function heartbeatLeadership() {
    if (isLeader()) {
      writeLeadership();
      return true;
    }
    return tryBecomeLeader();
  }

  async function withLocalStorageMutex(name, task) {
    const key = 'tpMutexV1_' + name;
    const token = `${TAB_ID}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + MUTEX_WAIT_MS;

    while (Date.now() < deadline) {
      let current = null;
      try { current = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
      if (!current || clampInteger(current.until, 0) <= Date.now()) {
        try {
          localStorage.setItem(key, JSON.stringify({ token, until: Date.now() + MUTEX_LEASE_MS }));
          await sleep(25 + Math.floor(Math.random() * 35));
          const verified = JSON.parse(localStorage.getItem(key) || 'null');
          if (verified?.token === token) {
            try {
              return await task();
            } finally {
              try {
                const latest = JSON.parse(localStorage.getItem(key) || 'null');
                if (latest?.token === token) localStorage.removeItem(key);
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
      await sleep(40 + Math.floor(Math.random() * 60));
    }
    console.warn('[TP] Springer en poll over, fordi flerfanelåsen var optaget:', name);
    return undefined;
  }

  async function withCrossTabProcessLock(name, task) {
    try {
      if (globalThis.navigator?.locks?.request) {
        return await globalThis.navigator.locks.request(
          'ajourcare-temponizer-' + name,
          { mode: 'exclusive' },
          task
        );
      }
    } catch (error) {
      console.warn('[TP] Browserens flerfanelås fejlede; bruger lokal reserve.', error);
    }
    return withLocalStorageMutex(name, task);
  }

  function takeChannelLock(kind) {
    const keys = ['tpPushLockV2_' + kind, 'tpPushLock_' + kind];
    try {
      const time = Date.now();
      for (const key of keys) {
        const lock = JSON.parse(localStorage.getItem(key) || '{"t":0}');
        if (time - clampInteger(lock.t, 0) < LOCK_MS) return false;
      }
      const value = JSON.stringify({ t: time, id: TAB_ID });
      for (const key of keys) localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return true;
    }
  }

  function setBadge(element, count) {
    if (!element) return;
    const value = clampInteger(count, 0);
    element.textContent = String(value);
    element.style.opacity = value > 0 ? '1' : '.45';
  }

  function badgePulse(element) {
    if (!element?.animate) return;
    element.animate(
      [{ transform: 'scale(1)', offset: 0 }, { transform: 'scale(1.12)', offset: .35 }, { transform: 'scale(1)', offset: 1 }],
      { duration: 320, easing: 'ease-out' }
    );
  }

  function updateMessageBadge(total) {
    const badge = document.getElementById('tpMsgCountBadge');
    const previous = clampInteger(badge?.textContent, 0);
    setBadge(badge, total);
    if (total > previous) badgePulse(badge);
  }

  function updateInterestBadge(total) {
    const badge = document.getElementById('tpIntCountBadge');
    const previous = clampInteger(badge?.textContent, 0);
    setBadge(badge, total);
    if (total > previous) badgePulse(badge);
  }

  function getDefaultMessageState() {
    return { initialized: false, total: 0, rawTotal: 0, records: {}, pending: [], seen: {}, lastPush: 0 };
  }

  function getDefaultInterestState() {
    return { initialized: false, total: 0, pairs: {}, pending: [], lastPush: 0 };
  }

  function dispatchNotification(kind, enableKey, notification) {
    const enabled = localStorage.getItem(enableKey) === 'true';
    if (enabled) sendPushover(notification.body, notification.title);
    showToast(notification.toast);
    broadcastToast(kind, notification.toast);
  }

  function processMessageSnapshot(snapshot) {
    const state = { ...getDefaultMessageState(), ...loadJson(ST_MSG_KEY, getDefaultMessageState()) };
    state.records = state.records && typeof state.records === 'object' ? state.records : {};
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    const observedAt = Date.now();
    let seen = rememberMessageRecords(
      pruneSeenMessageEvents(state.seen, observedAt),
      state.records,
      observedAt
    );

    if (!state.initialized) {
      seen = rememberMessageRecords(seen, snapshot.records, observedAt);
      saveJson(ST_MSG_KEY, {
        initialized: true,
        total: snapshot.total,
        rawTotal: clampInteger(snapshot.rawTotal, snapshot.total),
        records: snapshot.records,
        pending: [],
        seen,
        lastPush: 0
      });
      updateMessageBadge(snapshot.total);
      return { baseline: true, events: [] };
    }

    let events = diffMessageThreads(state.records, snapshot.records)
      .filter(event => event.kind !== 'thread' || isIncomingMessageRecord(event.record));
    const detailedDelta = events.reduce((sum, event) => sum + event.delta, 0);
    const totalDelta = Math.max(0, snapshot.total - clampInteger(state.total, 0));
    if (totalDelta > detailedDelta) {
      const unknownDelta = totalDelta - detailedDelta;
      events.push({
        kind: 'generic',
        key: `generic:${snapshot.total}`,
        eventId: `generic:${snapshot.total}:${clampInteger(state.total, 0)}`,
        delta: unknownDelta,
        targetTotal: snapshot.total,
        text: unknownDelta === 1 ? 'Ny ulæst besked' : `${unknownDelta} nye ulæste beskeder`
      });
    }

    events = events.filter(event => !seen[event.eventId]);
    for (const event of events) seen[event.eventId] = observedAt;
    seen = rememberMessageRecords(seen, snapshot.records, observedAt);

    let pending = prunePendingMessageEvents(state.pending, snapshot.records, snapshot.total);
    pending = mergePendingEvents(pending, events);
    let lastPush = clampInteger(state.lastPush, 0);
    let sent = [];

    if (pending.length && Date.now() - lastPush > SUPPRESS_MS && takeChannelLock('msg')) {
      dispatchNotification('msg', 'tpPushEnableMsg', formatMessageNotification(pending));
      sent = pending;
      pending = [];
      lastPush = Date.now();
    }

    saveJson(ST_MSG_KEY, {
      initialized: true,
      total: snapshot.total,
      rawTotal: clampInteger(snapshot.rawTotal, snapshot.total),
      records: snapshot.records,
      pending,
      seen,
      lastPush
    });
    updateMessageBadge(snapshot.total);
    return { baseline: false, events, sent, pending };
  }

  function processInterestSnapshot(snapshot) {
    const state = { ...getDefaultInterestState(), ...loadJson(ST_INT_KEY, getDefaultInterestState()) };
    state.pairs = state.pairs && typeof state.pairs === 'object' ? state.pairs : {};
    state.pending = Array.isArray(state.pending) ? state.pending : [];

    if (!state.initialized) {
      saveJson(ST_INT_KEY, {
        initialized: true,
        total: snapshot.total,
        pairs: snapshot.pairs,
        pending: [],
        lastPush: 0
      });
      updateInterestBadge(snapshot.total);
      return { baseline: true, events: [] };
    }

    const events = diffInterestPairs(state.pairs, snapshot.pairs);
    let pending = prunePendingInterestEvents(state.pending, snapshot.pairs);
    pending = mergePendingEvents(pending, events);
    let lastPush = clampInteger(state.lastPush, 0);
    let sent = [];

    if (pending.length && Date.now() - lastPush > SUPPRESS_MS && takeChannelLock('int')) {
      dispatchNotification('int', 'tpPushEnableInt', formatInterestNotification(pending));
      sent = pending;
      pending = [];
      lastPush = Date.now();
    }

    saveJson(ST_INT_KEY, {
      initialized: true,
      total: snapshot.total,
      pairs: snapshot.pairs,
      pending,
      lastPush
    });
    updateInterestBadge(snapshot.total);
    return { baseline: false, events, sent, pending };
  }

  async function pollMessages() {
    if (!isLeader() || messagePollInFlight) return;
    messagePollInFlight = true;
    try {
      const snapshot = await fetchMessageSnapshot();
      const enriched = await refreshMessageEnrichmentIfNeeded(snapshot);
      if (!isLeader()) return;
      await withCrossTabProcessLock('message-state', async () => {
        if (!isLeader()) return;
        processMessageSnapshot(enriched);
      });
    } catch (error) {
      console.warn('[TP][ERR][MSG]', error);
    } finally {
      messagePollInFlight = false;
    }
  }

  async function pollInterest() {
    if (!isLeader() || interestPollInFlight) return;
    interestPollInFlight = true;
    try {
      const snapshot = await fetchInterestSnapshot();
      if (!isLeader()) return;
      await withCrossTabProcessLock('interest-state', async () => {
        if (!isLeader()) return;
        processInterestSnapshot(snapshot);
      });
    } catch (error) {
      console.warn('[TP][ERR][INT]', error);
    } finally {
      interestPollInFlight = false;
    }
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: options.url,
        headers: options.headers || {},
        data: options.data,
        anonymous: false,
        withCredentials: true,
        timeout: options.timeout || FETCH_TIMEOUT_MS,
        onload: response => response.status >= 200 && response.status < 300
          ? resolve(response)
          : reject(new Error('HTTP ' + response.status + ' - ' + (response.responseText || '').slice(0, 300))),
        onerror: reject,
        ontimeout: () => reject(new Error('Timeout'))
      });
    });
  }

  async function gmGET(url) {
    const response = await gmRequest({
      method: 'GET',
      url,
      headers: {
        'Accept': '*/*',
        'Referer': globalThis.location?.href || ORIGIN,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    return response.responseText;
  }

  function getUserKey() {
    try {
      return String(GM_getValue('tpUserKey') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function sendPushover(message, title = 'Temponizer') {
    const userKey = getUserKey();
    if (!PUSHOVER_TOKEN || !userKey) return;
    const safeTitle = truncateText(title, 80);
    const safeMessage = truncateText(message, 850);
    const body = [
      'token=' + encodeURIComponent(PUSHOVER_TOKEN),
      'user=' + encodeURIComponent(userKey),
      'title=' + encodeURIComponent(safeTitle),
      'message=' + encodeURIComponent(safeMessage)
    ].join('&');

    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.pushover.net/1/messages.json',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
      timeout: FETCH_TIMEOUT_MS,
      onload: response => {
        if (response.status < 200 || response.status >= 300) {
          console.warn('[TP][PUSHOVER] HTTP', response.status);
        }
      },
      onerror: error => console.warn('[TP][PUSHOVER] Netværksfejl', error),
      ontimeout: () => console.warn('[TP][PUSHOVER] Timeout')
    });
  }

  function showOsNotification(message, duration = 4500) {
    const safeMessage = truncateText(message, 260);
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification('Temponizer', { body: safeMessage });
        setTimeout(() => notification.close(), Math.min(duration, 6000));
      }
    } catch (_) {}
  }

  function showDomToast(message, duration = 4500) {
    const safeMessage = truncateText(message, 260);
    try {
      let element = document.getElementById('tpToast');
      if (!element) {
        element = document.createElement('div');
        element.id = 'tpToast';
        element.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483646',
          'background:#111', 'color:#fff', 'padding:10px 12px', 'border-radius:8px',
          'box-shadow:0 10px 30px rgba(0,0,0,.35)', 'font-size:13px',
          'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
          'max-width:360px', 'white-space:pre-line', 'opacity:0', 'transition:opacity .25s'
        ].join(';');
        document.body.appendChild(element);
        requestAnimationFrame(() => { element.style.opacity = '1'; });
      }
      element.textContent = safeMessage;
      clearTimeout(element._tpTimer);
      element._tpTimer = setTimeout(() => {
        element.style.opacity = '0';
        setTimeout(() => element.remove(), 250);
      }, duration);
    } catch (_) {}
  }

  function showToast(message, duration = 4500) {
    showOsNotification(message, duration);
    showDomToast(message, duration);
  }

  function removeIncomingCallCard() {
    const card = document.getElementById('tpIncomingCallCard');
    if (!card) return;
    clearTimeout(card._tpTimer);
    card.remove();
  }

  function showIncomingCallCard({ phone, matches = [], state = 'ready' }) {
    removeIncomingCallCard();
    const card = document.createElement('aside');
    card.id = 'tpIncomingCallCard';
    card.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:min(320px,calc(100vw - 32px))', 'overflow:hidden',
      'border:1px solid #aeb2b4', 'border-radius:3px', 'background:#fff', 'color:#333',
      'box-shadow:0 8px 24px rgba(30,35,38,.28)',
      'font:12px/1.3 sans-serif,Verdana,Arial,Helvetica,sans-serif', 'letter-spacing:0'
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:7px;padding:7px 8px;border-bottom:1px solid #c9ccce;background:#e9eaea';
    const icon = document.createElement('span');
    icon.textContent = '☎';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'font-size:15px;color:#3f6f85';
    const title = document.createElement('strong');
    title.textContent = 'Indgående opkald';
    title.style.cssText = 'font-size:12px;font-weight:600';
    const close = document.createElement('button');
    close.type = 'button';
    close.title = 'Luk';
    close.setAttribute('aria-label', 'Luk');
    close.textContent = '×';
    close.style.cssText = 'margin-left:auto;width:22px;height:22px;padding:0;border:0;background:transparent;color:#666;font:18px/20px Arial;cursor:pointer';
    close.addEventListener('click', removeIncomingCallCard);
    head.append(icon, title, close);

    const content = document.createElement('div');
    content.style.cssText = 'padding:9px';
    const formattedPhone = formatPhoneNumber(phone);
    if (state === 'loading') {
      content.textContent = 'Finder vikar for ' + formattedPhone + '…';
      content.style.color = '#666';
    } else if (state === 'login') {
      const message = document.createElement('strong');
      message.textContent = 'Log ind i Temponizer';
      message.style.cssText = 'display:block;font-size:13px;font-weight:600';
      const detail = document.createElement('span');
      detail.textContent = 'Nummeret kan først slås op efter login.';
      detail.style.cssText = 'display:block;margin-top:3px;color:#6a6a6a';
      content.append(message, detail);
    } else if (state === 'error') {
      const message = document.createElement('strong');
      message.textContent = 'Nummeropslag mislykkedes';
      message.style.cssText = 'display:block;font-size:13px;font-weight:600';
      const number = document.createElement('span');
      number.textContent = formattedPhone;
      number.style.cssText = 'display:block;margin-top:2px;color:#6a6a6a';
      content.append(message, number);
    } else if (!matches.length) {
      const name = document.createElement('strong');
      name.textContent = 'Nummeret blev ikke fundet';
      name.style.cssText = 'display:block;font-size:13px;font-weight:600';
      const number = document.createElement('span');
      number.textContent = formattedPhone;
      number.style.cssText = 'display:block;margin-top:2px;color:#6a6a6a';
      content.append(name, number);
    } else {
      const intro = document.createElement('div');
      intro.textContent = matches.length === 1 ? formattedPhone : matches.length + ' vikarer matcher ' + formattedPhone;
      intro.style.cssText = 'margin-bottom:6px;color:#6a6a6a;font-size:11px';
      content.appendChild(intro);
      for (const match of matches) {
        const link = document.createElement('a');
        link.href = match.profileUrl;
        link.style.cssText = 'display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 7px;border:1px solid #c6c9ca;background:#f8f8f8;color:#333;text-decoration:none';
        if (content.querySelector('a')) link.style.marginTop = '5px';
        const name = document.createElement('strong');
        name.textContent = match.name;
        name.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600';
        const action = document.createElement('span');
        action.textContent = 'Åbn profil ›';
        action.style.cssText = 'margin-left:auto;color:#276f91;white-space:nowrap;font-size:11px';
        link.append(name, action);
        content.appendChild(link);
      }
    }

    card.append(head, content);
    document.body.appendChild(card);
    if (state !== 'loading') {
      const duration = matches.length ? INCOMING_CALL_CARD_MS : 8000;
      card._tpTimer = setTimeout(removeIncomingCallCard, duration);
    }
    return card;
  }

  function showIncomingCallOsNotification(match, phone) {
    try {
      if (!match || !('Notification' in window) || Notification.permission !== 'granted') return;
      const notification = new Notification('Indgående opkald', {
        body: match.name + ' · ' + formatPhoneNumber(phone)
      });
      notification.onclick = () => {
        try { globalThis.focus(); } catch (_) {}
        globalThis.location.href = match.profileUrl;
        notification.close();
      };
      setTimeout(() => notification.close(), Math.min(INCOMING_CALL_CARD_MS, 30000));
    } catch (_) {}
  }

  async function claimIncomingCall(phone, eventId = phone) {
    return withCrossTabProcessLock('incoming-call', () => {
      const last = loadJson(INCOMING_CALL_LOCK_KEY, null);
      const time = now();
      const lastEventId = last?.eventId || last?.phone;
      if (lastEventId === eventId && time - clampInteger(last.ts, 0) < INCOMING_CALL_LOCK_MS) return false;
      saveJson(INCOMING_CALL_LOCK_KEY, { eventId, phone, ts: time });
      return true;
    });
  }

  async function handleIncomingCall(phone, eventId = phone) {
    const claimed = await claimIncomingCall(phone, eventId);
    if (!claimed) return;
    showIncomingCallCard({ phone, state: 'loading' });
    try {
      const matches = await fetchIncomingCallMatches(phone);
      showIncomingCallCard({ phone, matches });
      showIncomingCallOsNotification(matches[0], phone);
    } catch (error) {
      console.warn('[TP][CALL] Nummeropslag fejlede', error);
      showIncomingCallCard({ phone, state: error?.message === 'TP_LOGIN_REQUIRED' ? 'login' : 'error' });
    }
  }

  function initIncomingCallReceiver() {
    const phone = getIncomingCallNumberFromHash();
    if (!phone) return false;
    try {
      history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
    } catch (_) {}
    handleIncomingCall(phone);
    return true;
  }

  function incomingCallQueueListBaseUrl() {
    return TP_CALL_QUEUE.spSite.replace(/\/$/, '')
      + "/_api/web/lists/getbytitle('" + odataQuote(TP_CALL_QUEUE.listTitle) + "')";
  }

  function ensureIncomingCallQueueState() {
    const saved = loadJson(INCOMING_CALL_QUEUE_STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      return {
        lastId: clampInteger(saved.lastId, 0),
        initializedAt: clampInteger(saved.initializedAt, now()),
        ready: saved.ready === true
      };
    }
    const state = { lastId: 0, initializedAt: now(), ready: false };
    saveJson(INCOMING_CALL_QUEUE_STATE_KEY, state);
    return state;
  }

  async function getIncomingCallUserEmail() {
    if (incomingCallUserEmail) return incomingCallUserEmail;
    const response = await gmRequest({
      url: TP_CALL_QUEUE.spSite.replace(/\/$/, '') + '/_api/web/currentuser?$select=Email',
      headers: { 'Accept': 'application/json;odata=nometadata' }
    });
    const json = JSON.parse(response.responseText || '{}');
    const email = normalizeText(json.Email || json?.d?.Email).toLocaleLowerCase('da');
    if (!email || !email.includes('@')) throw new Error('SharePoint-brugerens e-mail mangler');
    incomingCallUserEmail = email;
    return email;
  }

  async function fetchIncomingCallQueueItems(email) {
    const filter = encodeURIComponent("RecipientEmail eq '" + odataQuote(email) + "'");
    const url = incomingCallQueueListBaseUrl()
      + '/items?$select=Id,CallerNumber,RecipientEmail,Created'
      + '&$filter=' + filter
      + '&$orderby=Id%20desc&$top=' + TP_CALL_QUEUE.batchSize;
    const response = await gmRequest({
      url,
      headers: { 'Accept': 'application/json;odata=nometadata' }
    });
    const json = JSON.parse(response.responseText || '{}');
    const rows = json.value || json?.d?.results;
    if (!Array.isArray(rows)) throw new Error('SharePoint-opkaldslisten kunne ikke laeses');
    return rows
      .map(row => ({
        id: clampInteger(row.Id, 0),
        phone: normalizePhoneNumber(row.CallerNumber),
        createdAt: Date.parse(row.Created || '') || 0
      }))
      .filter(row => row.id > 0 && row.phone);
  }

  function selectPendingIncomingCallRows(rows, state, referenceTime = now()) {
    const initialCutoff = clampInteger(state?.initializedAt, 0) - 2000;
    const recentCutoff = referenceTime - TP_CALL_QUEUE.notificationMaxAgeMs;
    return rows
      .filter(row => row.id > clampInteger(state?.lastId, 0))
      .filter(row => state?.ready === true || row.createdAt >= initialCutoff)
      .filter(row => row.createdAt >= recentCutoff)
      .sort((a, b) => a.id - b.id);
  }

  function notifyIncomingCallQueueError(error) {
    const time = now();
    if (time - incomingCallQueueErrorNotifiedAt < 60 * 60 * 1000) return;
    incomingCallQueueErrorNotifiedAt = time;
    console.warn('[TP][CALL] SharePoint-opkald kunne ikke hentes', error);
    showToast('IPnordic-opkald er midlertidigt afbrudt. Log ind paa SharePoint.');
  }

  async function pollIncomingCalls() {
    if (!isLeader() || incomingCallPollInFlight) return;
    incomingCallPollInFlight = true;
    try {
      const email = await getIncomingCallUserEmail();
      const rows = await fetchIncomingCallQueueItems(email);
      if (!isLeader()) return;

      await withCrossTabProcessLock('incoming-call-queue', async () => {
        if (!isLeader()) return;
        const state = ensureIncomingCallQueueState();
        const latestId = rows.reduce((highest, row) => Math.max(highest, row.id), state.lastId);
        const pending = selectPendingIncomingCallRows(rows, state);

        for (const row of pending) {
          await handleIncomingCall(row.phone, 'sharepoint:' + row.id);
        }
        saveJson(INCOMING_CALL_QUEUE_STATE_KEY, {
          lastId: latestId,
          initializedAt: state.initializedAt,
          ready: true
        });
      });
    } catch (error) {
      notifyIncomingCallQueueError(error);
    } finally {
      incomingCallPollInFlight = false;
    }
  }

  function broadcastToast(type, message) {
    try {
      localStorage.setItem(TOAST_EVT_KEY, JSON.stringify({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type,
        message,
        ts: Date.now()
      }));
    } catch (_) {}
  }

  function initToastBroadcast() {
    window.addEventListener('storage', event => {
      if (event.key === TOAST_EVT_KEY && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          const seenKey = 'tpToastSeen_' + data.id;
          if (sessionStorage.getItem(seenKey)) return;
          sessionStorage.setItem(seenKey, '1');
          if (!document.hidden) showDomToast(data.message);
        } catch (_) {}
      }
      if (event.key === ST_MSG_KEY && event.newValue) {
        try { updateMessageBadge(JSON.parse(event.newValue).total); } catch (_) {}
      }
      if (event.key === ST_INT_KEY && event.newValue) {
        try { updateInterestBadge(JSON.parse(event.newValue).total); } catch (_) {}
      }
    });
  }

  function odataQuote(value) {
    return String(value).replace(/'/g, "''");
  }

  function spListBaseUrl() {
    return TP_MAIL_PUSH.spSite.replace(/\/$/, '')
      + "/_api/web/lists/getbytitle('" + odataQuote(TP_MAIL_PUSH.listTitle) + "')";
  }

  function setLocalMailPushEnabled(enabled) {
    try { GM_setValue(TP_MAIL_PUSH.key, !!enabled); } catch (_) {}
    try { localStorage.setItem(TP_MAIL_PUSH.key, enabled ? 'true' : 'false'); } catch (_) {}
  }

  function getLocalMailPushEnabled() {
    try {
      const value = GM_getValue(TP_MAIL_PUSH.key, null);
      if (value === true || value === false) return value;
    } catch (_) {}
    try { return localStorage.getItem(TP_MAIL_PUSH.key) === 'true'; } catch (_) { return false; }
  }

  function paintMailPushUI(enabled, statusText, color, showLogin = false) {
    const checkbox = document.getElementById('tpEnableMail');
    const status = document.getElementById('tpMailStatus');
    const loginLink = document.getElementById('tpMailLoginLink');
    if (checkbox && typeof enabled === 'boolean') checkbox.checked = enabled;
    if (status) {
      status.textContent = statusText || (enabled ? 'til' : 'fra');
      status.style.color = color || (enabled ? '#0a7a35' : '#a33');
    }
    if (loginLink) loginLink.style.display = showLogin ? 'inline' : 'none';
  }

  async function getSharePointDigest() {
    const time = Date.now();
    if (tpSpDigestCache.value && tpSpDigestCache.expires > time) return tpSpDigestCache.value;
    const response = await gmRequest({
      method: 'POST',
      url: TP_MAIL_PUSH.spSite.replace(/\/$/, '') + '/_api/contextinfo',
      headers: { 'Accept': 'application/json;odata=verbose' }
    });
    const json = JSON.parse(response.responseText || '{}');
    const info = json?.d?.GetContextWebInformation || json?.GetContextWebInformation || json;
    const digest = info.FormDigestValue;
    const timeoutSeconds = Number(info.FormDigestTimeoutSeconds || 1500);
    if (!digest) throw new Error('SharePoint digest mangler');
    tpSpDigestCache = {
      value: digest,
      expires: time + Math.max(60, timeoutSeconds - 60) * 1000
    };
    return digest;
  }

  async function getSharePointListEntityType() {
    if (tpSpEntityTypeCache) return tpSpEntityTypeCache;
    const response = await gmRequest({
      url: spListBaseUrl() + '?$select=ListItemEntityTypeFullName',
      headers: { 'Accept': 'application/json;odata=verbose' }
    });
    const json = JSON.parse(response.responseText || '{}');
    const type = json?.d?.ListItemEntityTypeFullName || json?.ListItemEntityTypeFullName;
    if (!type) throw new Error('Kan ikke læse SharePoint list entity type');
    tpSpEntityTypeCache = type;
    return type;
  }

  async function getMailPushSetting() {
    const filter = encodeURIComponent("Title eq '" + odataQuote(TP_MAIL_PUSH.itemTitle) + "'");
    const url = spListBaseUrl() + '/items?$select=Id,Title,Enabled&$filter=' + filter + '&$top=1';
    const response = await gmRequest({
      url,
      headers: { 'Accept': 'application/json;odata=nometadata' }
    });
    const json = JSON.parse(response.responseText || '{}');
    const rows = json.value || json?.d?.results || [];
    if (!rows.length) throw new Error('Fandt ikke PushoverMail i TemponizerSettings');
    return { id: rows[0].Id, enabled: !!rows[0].Enabled };
  }

  async function setMailPushSetting(enabled) {
    const item = await getMailPushSetting();
    const digest = await getSharePointDigest();
    const entityType = await getSharePointListEntityType();
    await gmRequest({
      method: 'POST',
      url: spListBaseUrl() + '/items(' + item.id + ')',
      headers: {
        'Accept': 'application/json;odata=verbose',
        'Content-Type': 'application/json;odata=verbose',
        'X-RequestDigest': digest,
        'IF-MATCH': '*',
        'X-HTTP-Method': 'MERGE'
      },
      data: JSON.stringify({
        __metadata: { type: entityType },
        Enabled: !!enabled
      })
    });
    setLocalMailPushEnabled(enabled);
    paintMailPushUI(enabled, enabled ? 'til' : 'fra');
  }

  async function refreshMailPushSetting() {
    if (tpMailPushBusy || tpMailRefreshInFlight) return;
    if (!document.getElementById('tpEnableMail')) return;
    const generation = ++tpMailRefreshGeneration;
    tpMailRefreshInFlight = true;
    try {
      paintMailPushUI(undefined, 'synk…', '#888');
      const setting = await getMailPushSetting();
      if (generation !== tpMailRefreshGeneration || tpMailPushBusy) return;
      setLocalMailPushEnabled(setting.enabled);
      paintMailPushUI(setting.enabled, setting.enabled ? 'til' : 'fra');
    } catch (error) {
      if (generation === tpMailRefreshGeneration) {
        console.warn('[TP][MAIL] refresh error', error);
        paintMailPushUI(undefined, 'fejl', '#a33', true);
      }
    } finally {
      if (generation === tpMailRefreshGeneration) tpMailRefreshInFlight = false;
    }
  }

  function initMailPushControls(root) {
    const checkbox = root.querySelector('#tpEnableMail');
    if (!checkbox) return;
    checkbox.checked = getLocalMailPushEnabled();
    paintMailPushUI(checkbox.checked, 'synk…', '#888');

    checkbox.addEventListener('change', async () => {
      if (tpMailPushBusy) return;
      const wantOn = checkbox.checked;
      tpMailPushBusy = true;
      tpMailRefreshGeneration += 1;
      tpMailRefreshInFlight = false;
      checkbox.disabled = true;
      paintMailPushUI(wantOn, wantOn ? 'slår til…' : 'slår fra…', '#888');
      try {
        await setMailPushSetting(wantOn);
      } catch (error) {
        console.warn('[TP][MAIL] update error', error);
        checkbox.checked = !wantOn;
        paintMailPushUI(checkbox.checked, 'fejl', '#a33', true);
      } finally {
        checkbox.disabled = false;
        tpMailPushBusy = false;
        setTimeout(refreshMailPushSetting, 1200);
      }
    });

    refreshMailPushSetting();
    if (!tpMailPushTimer) {
      tpMailPushTimer = setInterval(refreshMailPushSetting, TP_MAIL_PUSH.pollMs);
    }
  }

  function loadPanelPosition(element) {
    const position = loadJson(POS_KEY, null);
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) {
      element.style.bottom = '12px';
      element.style.right = '8px';
      element.style.top = 'auto';
      element.style.left = 'auto';
      return;
    }
    element.style.left = Number(position.x) + 'px';
    element.style.top = Number(position.y) + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    requestAnimationFrame(clampPanelIntoView);
  }

  function injectUI() {
    if (document.getElementById('tpPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'tpPanel';
    panel.style.cssText = [
      'position:fixed', 'z-index:2147483645', 'background:#fff', 'border:1px solid #d7d7d7',
      'padding:8px', 'border-radius:8px', 'font-size:12px',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.15)', 'max-width:240px', 'min-width:170px',
      'line-height:1.25'
    ].join(';');

    panel.innerHTML =
      '<div id="tpHeader" style="cursor:move;display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
        '<div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">TP Notifikationer</div>' +
        '<div style="margin-left:auto;display:flex;align-items:center;gap:6px">' +
          '<div id="tpDragHint" style="font-size:10px;color:#888">træk</div>' +
          '<button id="tpGearBtn" type="button" title="Indstillinger" aria-label="Indstillinger" style="width:22px;height:22px;line-height:20px;text-align:center;background:#fff;border:1px solid #ccc;border-radius:50%;box-shadow:0 4px 12px rgba(0,0,0,.18);cursor:pointer;padding:0;user-select:none">⚙</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin:2px 0;white-space:nowrap">' +
        '<label style="display:flex;align-items:center;gap:6px;min-width:0"><input type="checkbox" id="tpEnableMsg"> <span>Besked</span></label>' +
        '<span id="tpMsgCountBadge" style="display:flex;align-items:center;justify-content:center;margin-left:auto;min-width:18px;text-align:center;padding:1px 6px;border-radius:999px;background:#f0f0f0;border:1px solid #e3e3e3;font-size:11px">0</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin:2px 0 6px;white-space:nowrap">' +
        '<label style="display:flex;align-items:center;gap:6px;min-width:0"><input type="checkbox" id="tpEnableInt"> <span>Interesse</span></label>' +
        '<span id="tpIntCountBadge" style="display:flex;align-items:center;justify-content:center;margin-left:auto;min-width:18px;text-align:center;padding:1px 6px;border-radius:999px;background:#f0f0f0;border:1px solid #e3e3e3;font-size:11px">0</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin:2px 0 6px;white-space:nowrap">' +
        '<label style="display:flex;align-items:center;gap:6px;min-width:0"><input type="checkbox" id="tpEnableMail"> <span>Mail</span></label>' +
        '<span id="tpMailStatus" style="margin-left:auto;font-size:10px;color:#888">…</span>' +
        '<a id="tpMailLoginLink" href="' + TP_MAIL_PUSH.loginUrl + '" target="_blank" rel="noopener noreferrer" style="display:none;font-size:10px;color:#1769aa;text-decoration:underline">Log ind</a>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin:0 0 2px">' +
        '<span id="tpSMSStatus" style="font-size:11px;color:#666">SMS: …</span>' +
        '<button id="tpSMSOneBtn" type="button" style="margin-left:auto;padding:4px 8px;font-size:11px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;flex:0 0 auto">Aktivér</button>' +
      '</div>';

    document.body.appendChild(panel);
    const gearButton = panel.querySelector('#tpGearBtn');
    let menu = null;

    function buildMenu() {
      if (menu) return menu;
      menu = document.createElement('div');
      menu.id = 'tpMenu';
      Object.assign(menu.style, {
        position: 'fixed',
        zIndex: 2147483647,
        background: '#fff',
        border: '1px solid #ccc',
        borderRadius: '8px',
        boxShadow: '0 10px 28px rgba(0,0,0,.20)',
        padding: '10px',
        width: '320px',
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: '70vh',
        overflow: 'auto',
        display: 'none'
      });

      menu.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px">Indstillinger</div>' +
        '<div style="margin-bottom:10px">' +
          '<div style="font-weight:600;margin-bottom:4px">Pushover USER-token</div>' +
          '<input id="tpUserKeyMenu" type="text" autocomplete="off" placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px">' +
          '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            '<button id="tpSaveUserKeyMenu" type="button" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Gem</button>' +
            '<a href="https://pushover.net/" target="_blank" rel="noopener" style="color:#06c;text-decoration:none">Guide</a>' +
          '</div>' +
        '</div>' +
        '<div style="border-top:1px solid #eee;margin:10px 0"></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button id="tpTestPushover" type="button" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Test Pushover</button>' +
          '<button id="tpCheckUpdate" type="button" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer">Tjek update</button>' +
        '</div>' +
        '<div style="margin-top:8px;font-size:11px;color:#666">Version: ' + TP_VERSION + '</div>';

      document.body.appendChild(menu);
      const input = menu.querySelector('#tpUserKeyMenu');
      input.value = getUserKey();
      menu.querySelector('#tpSaveUserKeyMenu').addEventListener('click', () => {
        GM_setValue('tpUserKey', String(input.value || '').trim());
        showToast('USER-token gemt.');
      });
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        GM_setValue('tpUserKey', String(input.value || '').trim());
        showToast('USER-token gemt.');
      });
      menu.querySelector('#tpTestPushover').addEventListener('click', () => {
        tpTestPushoverBoth();
        toggleMenu(false);
      });
      menu.querySelector('#tpCheckUpdate').addEventListener('click', async () => {
        try {
          const raw = await gmGET(SCRIPT_RAW_URL + '?t=' + Date.now());
          const match = raw.match(/@version\s+([0-9.]+)/);
          if (!match) {
            showToast('Kunne ikke læse remote version.');
            return;
          }
          const remote = match[1];
          const comparison = compareVersions(remote, TP_VERSION);
          if (comparison === 0) {
            showToast('Du kører allerede nyeste version (' + remote + ').');
          } else if (comparison > 0) {
            showToast('Ny version tilgængelig: ' + remote + ' (du kører ' + TP_VERSION + '). Åbner…');
            window.open(SCRIPT_RAW_URL, '_blank', 'noopener');
          } else {
            showToast('Din version ' + TP_VERSION + ' er nyere end den offentliggjorte ' + remote + '.');
          }
        } catch (error) {
          console.warn('[TP][UPDATE]', error);
          showToast('Update-tjek fejlede.');
        }
      });
      return menu;
    }

    function positionMenu(element) {
      const panelRect = panel.getBoundingClientRect();
      const width = Math.min(element.offsetWidth || 320, window.innerWidth - 16);
      const height = Math.min(element.offsetHeight || 260, Math.floor(window.innerHeight * .7));
      let top = panelRect.top - height - 10;
      let below = false;
      if (top < 8) {
        top = panelRect.bottom + 8;
        below = true;
      }
      let left = panelRect.right - width;
      if (left < 8) left = 8;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
      if (below && top + height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - 8 - height);
      }
      Object.assign(element.style, {
        left: left + 'px',
        top: top + 'px',
        right: 'auto',
        bottom: 'auto',
        display: 'block'
      });
    }

    function toggleMenu(show) {
      const element = buildMenu();
      if (show === false) {
        element.style.display = 'none';
        return;
      }
      element.style.display = element.style.display === 'block' ? 'none' : 'block';
      if (element.style.display !== 'block') return;
      element.style.visibility = 'hidden';
      positionMenu(element);
      element.style.visibility = 'visible';
      ensureFullyVisible(element);
      const input = element.querySelector('#tpUserKeyMenu');
      if (input) input.value = getUserKey();

      const outside = event => {
        if (element.style.display !== 'block') return cleanup();
        if (element.contains(event.target) || event.target === gearButton) return;
        element.style.display = 'none';
        cleanup();
      };
      const escape = event => {
        if (event.key !== 'Escape') return;
        element.style.display = 'none';
        cleanup();
      };
      function cleanup() {
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', escape, true);
      }
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', escape, true);
    }

    gearButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu();
    });

    const messageCheckbox = panel.querySelector('#tpEnableMsg');
    const interestCheckbox = panel.querySelector('#tpEnableInt');
    messageCheckbox.checked = localStorage.getItem('tpPushEnableMsg') === 'true';
    interestCheckbox.checked = localStorage.getItem('tpPushEnableInt') === 'true';
    messageCheckbox.addEventListener('change', () => {
      localStorage.setItem('tpPushEnableMsg', messageCheckbox.checked ? 'true' : 'false');
    });
    interestCheckbox.addEventListener('change', () => {
      localStorage.setItem('tpPushEnableInt', interestCheckbox.checked ? 'true' : 'false');
    });

    initMailPushControls(panel);
    makeDraggable(panel, '#tpHeader');
    loadPanelPosition(panel);
    initSMSControls(panel);

    const messageState = loadJson(ST_MSG_KEY, getDefaultMessageState());
    const interestState = loadJson(ST_INT_KEY, getDefaultInterestState());
    setBadge(panel.querySelector('#tpMsgCountBadge'), messageState.total);
    setBadge(panel.querySelector('#tpIntCountBadge'), interestState.total);
  }

  function makeDraggable(element, handleSelector) {
    const handle = handleSelector ? element.querySelector(handleSelector) : element;
    if (!handle) return;
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    let drag = null;

    handle.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      if (event.target?.closest?.('button,input,select,textarea,a')) return;
      const rect = element.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      event.preventDefault();
    });
    document.addEventListener('mousemove', event => {
      if (!drag) return;
      const x = Math.min(window.innerWidth - element.offsetWidth - 8, Math.max(8, event.clientX - drag.dx));
      const y = Math.min(window.innerHeight - element.offsetHeight - 8, Math.max(8, event.clientY - drag.dy));
      element.style.left = x + 'px';
      element.style.top = y + 'px';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      saveJson(POS_KEY, { x, y });
    });
    document.addEventListener('mouseup', () => { drag = null; });
    window.addEventListener('resize', clampPanelIntoView);
  }

  function clampPanelIntoView() {
    const panel = document.getElementById('tpPanel');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
    const x = Math.min(maxX, Math.max(8, rect.left));
    const y = Math.min(maxY, Math.max(8, rect.top));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    saveJson(POS_KEY, { x, y });
  }

  function ensureFullyVisible(element, margin = 8) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - rect.width);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - rect.height);
    }
    element.style.position = 'fixed';
    element.style.left = left + 'px';
    element.style.top = top + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }

  // SMS-blokken er bevidst bevaret tæt på den fungerende 7.11.9-version.
  function hasDisplayBlock(element) {
    if (!element) return false;
    const style = (element.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
    if (style.includes('display:none')) return false;
    if (style.includes('display:block')) return true;
    return false;
  }

  function parseSmsStatusFromDoc(doc) {
    const activeElement = doc.getElementById('sms_notifikation_aktiv');
    const inactiveElement = doc.getElementById('sms_notifikation_ikke_aktiv');
    const activeShown = hasDisplayBlock(activeElement);
    const inactiveShown = hasDisplayBlock(inactiveElement);
    const hasDeactivateLink = !!(
      doc.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]')
      || doc.querySelector('#sms_notifikation_aktiv a[href*="deactivate_cell_sms_notifikationer"]')
    );
    const hasActivateLink = !!(
      doc.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]')
      || doc.querySelector('#sms_notifikation_ikke_aktiv a[href*="activate_cell_sms_notifikationer"]')
    );
    let state = 'unknown';
    let phone = '';
    if (activeShown || (!inactiveShown && hasDeactivateLink && !hasActivateLink)) state = 'active';
    else if (inactiveShown || (!activeShown && hasActivateLink && !hasDeactivateLink)) state = 'inactive';
    const referenceText = state === 'active'
      ? (activeElement?.textContent || '')
      : (inactiveElement?.textContent || '');
    const match = referenceText.replace(/\u00a0/g, ' ').match(/\+?\d[\d\s]{5,}/);
    if (match) phone = match[0].replace(/\s+/g, '');
    return { state, phone };
  }

  function parseSmsStatusFromHTML(html) {
    return parseSmsStatusFromDoc(parseHtml(html));
  }

  async function fetchSmsStatusHTML() {
    return gmGET(SMS_SETTINGS_URL + '&t=' + Date.now());
  }

  async function getSmsStatus() {
    try {
      return parseSmsStatusFromHTML(await fetchSmsStatusHTML());
    } catch (_) {
      return { state: 'unknown' };
    }
  }

  function hardenSmsIframe(iframe) {
    try {
      const frameWindow = iframe.contentWindow;
      const frameDocument = iframe.contentDocument;
      if (!frameWindow || !frameDocument) return;
      frameWindow.open = () => null;
      frameWindow.alert = () => {};
      frameWindow.confirm = () => true;
      frameDocument.addEventListener('click', event => {
        const link = event.target.closest?.('a');
        if (!link) return;
        event.preventDefault();
        event.stopPropagation();
        return false;
      }, true);
    } catch (_) {}
  }

  async function ensureSmsFrameLoaded() {
    let iframe = document.getElementById('tpSmsFrame');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'tpSmsFrame';
      Object.assign(iframe.style, {
        position: 'fixed',
        left: '-10000px',
        top: '-10000px',
        width: '1px',
        height: '1px',
        opacity: '0',
        pointerEvents: 'none',
        border: '0'
      });
      document.body.appendChild(iframe);
    }
    const loadOnce = () => new Promise(resolve => {
      iframe.onload = () => {
        hardenSmsIframe(iframe);
        resolve();
      };
    });
    const wantUrl = SMS_SETTINGS_URL;
    if (iframe.src !== wantUrl) {
      iframe.src = wantUrl;
      await loadOnce();
    } else if (!iframe.contentWindow || !iframe.contentDocument || !iframe.contentDocument.body) {
      iframe.src = wantUrl;
      await loadOnce();
    } else {
      hardenSmsIframe(iframe);
    }
    return iframe;
  }

  function getIframeStatus(iframe) {
    try {
      return parseSmsStatusFromDoc(iframe.contentDocument);
    } catch (_) {
      return { state: 'unknown' };
    }
  }

  function invokeIframeAction(iframe, wantOn) {
    const frameWindow = iframe.contentWindow;
    const frameDocument = iframe.contentDocument;
    try {
      if (wantOn && typeof frameWindow.activate_cell_sms_notifikationer === 'function') {
        frameWindow.activate_cell_sms_notifikationer();
        return true;
      }
      if (!wantOn && typeof frameWindow.deactivate_cell_sms_notifikationer === 'function') {
        frameWindow.deactivate_cell_sms_notifikationer();
        return true;
      }
    } catch (_) {}
    try {
      const link = wantOn
        ? (frameDocument.querySelector('#sms_notifikation_ikke_aktiv a[onclick*="activate_cell_sms_notifikationer"]') || frameDocument.querySelector('#sms_notifikation_ikke_aktiv a'))
        : (frameDocument.querySelector('#sms_notifikation_aktiv a[onclick*="deactivate_cell_sms_notifikationer"]') || frameDocument.querySelector('#sms_notifikation_aktiv a'));
      if (link) {
        link.click();
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function toggleSmsInIframe(wantOn, timeoutMs = 15000, pollMs = 500) {
    const iframe = await ensureSmsFrameLoaded();
    const initialStatus = getIframeStatus(iframe);
    if ((wantOn && initialStatus.state === 'active') || (!wantOn && initialStatus.state === 'inactive')) {
      return initialStatus;
    }
    if (!invokeIframeAction(iframe, wantOn)) {
      throw new Error('Kan ikke udløse aktivering/deaktivering i iframe.');
    }
    const maybeReloaded = new Promise(resolve => {
      let done = false;
      iframe.addEventListener('load', () => {
        if (!done) {
          done = true;
          resolve();
        }
      }, { once: true });
      setTimeout(() => {
        if (!done) resolve();
      }, 1200);
    });
    await maybeReloaded;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = getIframeStatus(iframe);
      if (wantOn && status.state === 'active') return status;
      if (!wantOn && status.state === 'inactive') return status;
      await sleep(pollMs);
    }
    const reload = () => new Promise(resolve => {
      iframe.onload = () => resolve();
      iframe.src = SMS_SETTINGS_URL + '&ts=' + Date.now();
    });
    await reload();
    return getIframeStatus(iframe);
  }

  const sms = {
    _busy: false,
    _last: null,
    async refresh(callback) {
      const status = await getSmsStatus();
      this._last = status;
      if (callback) callback(status);
    },
    async setEnabled(wantOn, uiBusy, callback) {
      if (this._busy) return;
      this._busy = true;
      if (uiBusy) uiBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
      try {
        const status = await toggleSmsInIframe(wantOn, 15000, 500);
        this._last = status;
        if (callback) callback(status);
      } catch (error) {
        console.warn('[TP][SMS] setEnabled error', error);
        const status = await getSmsStatus();
        this._last = status;
        if (callback) callback(status);
      } finally {
        this._busy = false;
        if (uiBusy) uiBusy(false);
      }
    }
  };

  function initSMSControls(root) {
    const label = root.querySelector('#tpSMSStatus');
    const button = root.querySelector('#tpSMSOneBtn');
    function setBusy(on, text) {
      button.disabled = on;
      button.style.opacity = on ? .6 : 1;
      if (on && text) label.textContent = text;
    }
    function paint(status) {
      switch (status.state) {
        case 'active':
          button.textContent = 'Deaktiver';
          label.textContent = 'SMS: Aktiv' + (status.phone ? ' - ' + status.phone : '');
          label.style.color = '#0a7a35';
          break;
        case 'inactive':
          button.textContent = 'Aktivér';
          label.textContent = 'SMS: Ikke aktiv' + (status.phone ? ' - ' + status.phone : '');
          label.style.color = '#a33';
          break;
        default:
          button.textContent = 'Aktivér';
          label.textContent = 'SMS: Ukendt';
          label.style.color = '#666';
      }
    }
    button.addEventListener('click', async () => {
      const wantOn = sms._last?.state !== 'active';
      setBusy(true, wantOn ? 'aktiverer…' : 'deaktiverer…');
      await sms.setEnabled(wantOn, setBusy, paint);
    });
    (async () => {
      setBusy(true, 'indlæser…');
      await sms.refresh(paint);
      setBusy(false);
    })();
  }

  function tpTestPushoverBoth() {
    if (!getUserKey()) {
      showToast('Indsæt din USER-token i indstillingerne før test.');
      return;
    }
    const time = new Date().toLocaleTimeString();
    sendPushover('Besked-kanal OK - ' + time, '[TEST] Temponizer besked');
    setTimeout(() => sendPushover('Interesse-kanal OK - ' + time, '[TEST] Temponizer interesse'), 800);
    showToast('Sendte Pushover-test. Tjek Pushover.');
  }

  function migrateUserKeyToGM() {
    try {
      const gmValue = String(GM_getValue('tpUserKey') || '').trim();
      if (gmValue) return;
      const localValue = String(localStorage.getItem('tpUserKey') || '').trim();
      if (localValue) {
        GM_setValue('tpUserKey', localValue);
        localStorage.removeItem('tpUserKey');
      }
    } catch (_) {}
  }

  function injectWorkerHoverStyles() {
    if (document.getElementById('tpWorkerHoverStyles')) return;
    const style = document.createElement('style');
    style.id = 'tpWorkerHoverStyles';
    style.textContent = `
      .tp-worker-hover-image {
        cursor: help !important;
      }
      .tp-worker-hover-popover {
        position: fixed;
        z-index: 10030;
        display: none;
        width: 300px;
        overflow: hidden;
        border: 1px solid #aeb2b4;
        border-radius: 2px;
        background: #ffffff;
        color: #333333;
        box-shadow: 0 5px 13px rgba(30, 35, 38, 0.20);
        font: 11px/1.25 sans-serif, Verdana, Arial, Helvetica, sans-serif;
        letter-spacing: 0;
      }
      .tp-worker-hover-popover[data-open="true"] {
        display: block;
      }
      .tp-worker-hover-head {
        display: flex;
        min-height: 28px;
        align-items: center;
        gap: 6px;
        padding: 4px 7px;
        border-bottom: 1px solid #c9ccce;
        background: #e9eaea;
      }
      .tp-worker-hover-name {
        min-width: 0;
        overflow: hidden;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tp-worker-hover-period {
        margin-left: auto;
        color: #6a6a6a;
        white-space: nowrap;
      }
      .tp-worker-hover-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto 12px;
        min-height: 27px;
        align-items: center;
        gap: 6px;
        padding: 3px 7px;
        border-bottom: 1px solid #d8dadb;
        background: #ffffff;
        color: #333333 !important;
        text-decoration: none !important;
      }
      .tp-worker-hover-row:hover,
      .tp-worker-hover-row:focus-visible {
        background: #edf3f5;
      }
      .tp-worker-hover-label,
      .tp-worker-hover-value {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 5px;
      }
      .tp-worker-hover-value {
        justify-content: flex-end;
        color: #555b5e;
        white-space: nowrap;
      }
      .tp-worker-hover-value strong {
        font-weight: 600;
      }
      .tp-worker-hover-detail {
        color: #777c7e;
        font-size: 10px;
      }
      .tp-worker-hover-row-completed {
        grid-template-columns: minmax(0, 1fr) auto 12px;
        min-height: 36px;
      }
      .tp-worker-hover-counts {
        display: flex;
        align-items: stretch;
        color: #555b5e;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .tp-worker-hover-count {
        display: flex;
        min-width: 42px;
        flex-direction: column;
        align-items: flex-end;
        justify-content: center;
        line-height: 1.05;
      }
      .tp-worker-hover-count + .tp-worker-hover-count {
        min-width: 49px;
        margin-left: 7px;
        padding-left: 7px;
        border-left: 1px solid #d8dadb;
      }
      .tp-worker-hover-count strong {
        font-weight: 600;
      }
      .tp-worker-hover-count small {
        margin-top: 2px;
        color: #777c7e;
        font-size: 9px;
      }
      .tp-worker-hover-arrow {
        color: #888d90;
        font-size: 14px;
        text-align: right;
      }
      .tp-worker-hover-marker {
        flex: 0 0 8px;
        width: 8px;
        height: 8px;
        border: 1px solid rgba(0, 0, 0, 0.13);
      }
      .tp-worker-hover-marker-sick { background: ${WORKER_SICK_COLOR}; }
      .tp-worker-hover-marker-withdrawn { background: ${WORKER_WITHDRAWN_COLOR}; }
      .tp-worker-hover-pair {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .tp-worker-hover-pair .tp-worker-hover-row:first-child {
        border-right: 1px solid #d8dadb;
      }
      .tp-worker-hover-loading,
      .tp-worker-hover-error {
        padding: 11px 8px;
        color: #666666;
      }
      .tp-worker-hover-retry {
        margin-left: 5px;
        padding: 0;
        border: 0;
        background: transparent;
        color: #276f91;
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createWorkerHoverHead(name) {
    const head = document.createElement('div');
    head.className = 'tp-worker-hover-head';
    const nameElement = document.createElement('span');
    nameElement.className = 'tp-worker-hover-name';
    nameElement.textContent = name;
    const period = document.createElement('span');
    period.className = 'tp-worker-hover-period';
    period.textContent = 'Seneste 90 dage';
    head.append(nameElement, period);
    return head;
  }

  function createWorkerHoverRow({ label, value, detail = '', href, marker = '' }) {
    const link = document.createElement('a');
    link.className = 'tp-worker-hover-row';
    link.href = href;

    const labelElement = document.createElement('span');
    labelElement.className = 'tp-worker-hover-label';
    if (marker) {
      const markerElement = document.createElement('span');
      markerElement.className = 'tp-worker-hover-marker tp-worker-hover-marker-' + marker;
      markerElement.setAttribute('aria-hidden', 'true');
      labelElement.appendChild(markerElement);
    }
    labelElement.appendChild(document.createTextNode(label));

    const valueElement = document.createElement('span');
    valueElement.className = 'tp-worker-hover-value';
    const strong = document.createElement('strong');
    strong.textContent = value === null || value === undefined ? '–' : String(value);
    valueElement.appendChild(strong);
    if (detail) {
      const detailElement = document.createElement('span');
      detailElement.className = 'tp-worker-hover-detail';
      detailElement.textContent = detail;
      valueElement.appendChild(detailElement);
    }

    const arrow = document.createElement('span');
    arrow.className = 'tp-worker-hover-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    link.append(labelElement, valueElement, arrow);
    return link;
  }

  function createWorkerCompletedRow({ recentValue, totalValue, href }) {
    const link = document.createElement('a');
    link.className = 'tp-worker-hover-row tp-worker-hover-row-completed';
    link.href = href;

    const label = document.createElement('span');
    label.className = 'tp-worker-hover-label';
    label.textContent = 'Afholdte vagter';

    const counts = document.createElement('span');
    counts.className = 'tp-worker-hover-counts';
    for (const [value, caption] of [[recentValue, '90 dage'], [totalValue, 'I alt']]) {
      const count = document.createElement('span');
      count.className = 'tp-worker-hover-count';
      const strong = document.createElement('strong');
      strong.textContent = value === null || value === undefined ? '–' : String(value);
      const small = document.createElement('small');
      small.textContent = caption;
      count.append(strong, small);
      counts.appendChild(count);
    }

    const arrow = document.createElement('span');
    arrow.className = 'tp-worker-hover-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    link.append(label, counts, arrow);
    return link;
  }

  function renderWorkerHoverLoading(popover, context) {
    const loading = document.createElement('div');
    loading.className = 'tp-worker-hover-loading';
    loading.textContent = 'Henter vikaroverblik…';
    popover.replaceChildren(createWorkerHoverHead(context.name), loading);
  }

  function renderWorkerHoverData(popover, context, data) {
    const completed = createWorkerCompletedRow({
      recentValue: data.completedShifts,
      totalValue: data.totalCompletedShifts,
      href: buildWorkerProfileURL(context.workerId, '#vagter')
    });
    const sick = createWorkerHoverRow({
      label: 'Sygemeldinger',
      value: data.sickShifts,
      href: buildWorkerProfileURL(context.workerId, '#vagter,annullerede'),
      marker: 'sick'
    });
    const withdrawn = createWorkerHoverRow({
      label: 'Sprunget fra',
      value: data.withdrawnShifts,
      href: buildWorkerProfileURL(context.workerId, '#vagter,annullerede'),
      marker: 'withdrawn'
    });
    const pair = document.createElement('div');
    pair.className = 'tp-worker-hover-pair';
    pair.append(
      createWorkerHoverRow({
        label: 'Klager',
        value: data.complaints,
        href: buildWorkerProfileURL(context.workerId, '#klager')
      }),
      createWorkerHoverRow({
        label: 'Blokeringer',
        value: data.blockings,
        href: buildWorkerProfileURL(context.workerId, '#blokeringer')
      })
    );
    popover.replaceChildren(
      createWorkerHoverHead(context.name),
      completed,
      sick,
      withdrawn,
      pair
    );
  }

  function renderWorkerHoverError(popover, context, retry) {
    const error = document.createElement('div');
    error.className = 'tp-worker-hover-error';
    error.appendChild(document.createTextNode('Data kunne ikke hentes.'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tp-worker-hover-retry';
    button.textContent = 'Prøv igen';
    button.addEventListener('click', retry, { once: true });
    error.appendChild(button);
    popover.replaceChildren(createWorkerHoverHead(context.name), error);
  }

  function findWorkerHoverContext(image) {
    const row = image.closest(WORKER_ROW_SELECTOR);
    const workerId = row?.id.match(/^row_(\d+)$/)?.[1];
    if (!row || !workerId || !String(image.getAttribute('src') || '').includes('/vikarimages/' + workerId + '/')) return null;
    const profileLinks = Array.from(row.querySelectorAll('a[href*="page=showvikaroplysninger"][href*="vikar_id="]'));
    const nameLink = profileLinks.find(link => {
      const href = String(link.getAttribute('href') || '');
      const text = normalizeText(link.textContent);
      return href.startsWith('/index.php') && !href.includes('#') && text && !/^\d+$/.test(text);
    }) || profileLinks.find(link => {
      const text = normalizeText(link.textContent);
      return text && !/^\d+$/.test(text) && !/^(Kalender|Stamdata|Kommunikation|Log)$/i.test(text);
    });
    const name = normalizeText(nameLink?.textContent);
    return name ? { workerId, name } : null;
  }

  function positionWorkerHover(popover, image) {
    const imageRect = image.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const gap = 5;
    let left = imageRect.right + gap;
    if (left + popoverRect.width > window.innerWidth - gap) left = imageRect.left - popoverRect.width - gap;
    left = Math.max(gap, Math.min(left, window.innerWidth - popoverRect.width - gap));
    let top = imageRect.top;
    top = Math.max(gap, Math.min(top, window.innerHeight - popoverRect.height - gap));
    popover.style.left = Math.round(left) + 'px';
    popover.style.top = Math.round(top) + 'px';
  }

  function initWorkerProfileHover() {
    const page = new URL(globalThis.location.href).searchParams.get('page');
    if (page !== 'findvikar' || document.getElementById('tpWorkerHoverPopover')) return;
    injectWorkerHoverStyles();

    const popover = document.createElement('aside');
    popover.id = 'tpWorkerHoverPopover';
    popover.className = 'tp-worker-hover-popover';
    popover.setAttribute('aria-live', 'polite');
    popover.dataset.open = 'false';
    document.body.appendChild(popover);

    let activeImage = null;
    let activeContext = null;
    let hideTimer = null;
    let requestGeneration = 0;

    const cancelHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
    };
    const hideSoon = () => {
      cancelHide();
      hideTimer = setTimeout(() => {
        popover.dataset.open = 'false';
        activeImage = null;
        activeContext = null;
      }, WORKER_HOVER_HIDE_MS);
    };
    const loadActiveWorker = async () => {
      if (!activeImage || !activeContext) return;
      const generation = ++requestGeneration;
      renderWorkerHoverLoading(popover, activeContext);
      positionWorkerHover(popover, activeImage);
      try {
        const data = await getWorkerHoverData(activeContext.workerId);
        if (generation !== requestGeneration || !activeImage || !activeContext) return;
        renderWorkerHoverData(popover, activeContext, data);
        positionWorkerHover(popover, activeImage);
      } catch (error) {
        if (generation !== requestGeneration || !activeImage || !activeContext) return;
        console.warn('[TP][VIKARHOVER] Kunne ikke hente data', error);
        renderWorkerHoverError(popover, activeContext, loadActiveWorker);
        positionWorkerHover(popover, activeImage);
      }
    };
    const showForImage = image => {
      const context = findWorkerHoverContext(image);
      if (!context) return;
      cancelHide();
      activeImage = image;
      activeContext = context;
      popover.dataset.open = 'true';
      loadActiveWorker();
    };
    const decorate = (root = document) => {
      for (const row of root.querySelectorAll?.(WORKER_ROW_SELECTOR) || []) {
        const workerId = row.id.match(/^row_(\d+)$/)?.[1];
        if (!workerId) continue;
        const image = Array.from(row.querySelectorAll('img')).find(candidate =>
          String(candidate.getAttribute('src') || '').includes('/vikarimages/' + workerId + '/')
        );
        if (!image || image.dataset.tpWorkerHoverReady === 'true' || !findWorkerHoverContext(image)) continue;
        image.dataset.tpWorkerHoverReady = 'true';
        image.classList.add('tp-worker-hover-image');
        image.addEventListener('mouseenter', () => showForImage(image));
        image.addEventListener('mouseleave', hideSoon);
      }
    };

    popover.addEventListener('mouseenter', cancelHide);
    popover.addEventListener('mouseleave', hideSoon);
    window.addEventListener('scroll', () => {
      if (activeImage && popover.dataset.open === 'true') positionWorkerHover(popover, activeImage);
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (activeImage && popover.dataset.open === 'true') positionWorkerHover(popover, activeImage);
    });
    decorate();

    let decorateScheduled = false;
    const observer = new MutationObserver(() => {
      if (decorateScheduled) return;
      decorateScheduled = true;
      setTimeout(() => {
        decorateScheduled = false;
        decorate();
      }, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function initWorkerProfileDeepLinks() {
    const page = new URL(globalThis.location.href).searchParams.get('page');
    if (page !== 'showvikaroplysninger') return;
    const parts = globalThis.location.hash.replace(/^#/, '').split(',');
    if (parts[0] !== 'vagter' || !parts[1]) return;
    const allowedSubtabs = new Set(['loenudbetalt', 'annullerede']);
    const subtab = allowedSubtabs.has(parts[1]) ? parts[1] : '';
    if (!subtab) return;

    let attempts = 0;
    const openSubtab = () => {
      const target = document.querySelector('#' + subtab + '_link .sub_ver3tab_content');
      if (target) {
        target.click();
        return;
      }
      attempts += 1;
      if (attempts < 20) setTimeout(openSubtab, 100);
    };
    openSubtab();
  }

  function parseCallRegistrationTarget(onclickValue) {
    const match = String(onclickValue || '').match(
      /\bRingVikarOp\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/
    );
    if (!match) return null;
    return { vikarId: match[1], vagtId: match[2] };
  }

  function injectQuickNoAnswerStyles() {
    if (document.getElementById('tpQuickNoAnswerStyles')) return;
    const style = document.createElement('style');
    style.id = 'tpQuickNoAnswerStyles';
    style.textContent = `
      .tp-quick-no-answer-cell {
        position: relative !important;
        overflow: visible !important;
      }
      .tp-quick-no-answer-menu {
        position: absolute;
        left: calc(100% - 1px);
        top: 50%;
        right: auto;
        bottom: auto;
        z-index: 10020;
        display: block;
        min-width: 92px;
        padding: 3px;
        background: #ffffff;
        border: 1px solid #aeb8bf;
        border-radius: 4px;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translate(4px, -50%);
        transition: opacity 80ms ease, transform 80ms ease, visibility 80ms ease;
      }
      .tp-quick-no-answer-cell:hover > .tp-quick-no-answer-menu,
      .tp-quick-no-answer-cell.tp-quick-no-answer-open > .tp-quick-no-answer-menu,
      .tp-quick-no-answer-cell:focus-within > .tp-quick-no-answer-menu {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transform: translate(0, -50%);
      }
      .tp-quick-no-answer-button {
        display: block;
        width: 100%;
        height: 30px;
        margin: 0;
        padding: 0 10px;
        border: 0;
        border-radius: 3px;
        background: #ffffff;
        color: #20272b;
        font: 600 12px/30px Arial, sans-serif;
        letter-spacing: 0;
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
      }
      .tp-quick-no-answer-button:hover,
      .tp-quick-no-answer-button:focus-visible {
        background: #edf3f6;
        outline: 2px solid #287ca5;
        outline-offset: -2px;
      }
      .tp-quick-no-answer-button:disabled {
        color: #667177;
        cursor: wait;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function submitQuickNoAnswer(target, button) {
    const { vikarId, vagtId } = target;
    const formId = 'registreropkaldvagtid_' + vikarId;
    if (document.getElementById(formId)) {
      showToast('Luk den \u00e5bne telefonregistrering f\u00f8rst.');
      return;
    }

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : globalThis;
    if (typeof pageWindow.RegistrerOpkald !== 'function') {
      showToast('Hurtigregistrering er ikke tilg\u00e6ngelig p\u00e5 denne side.');
      return;
    }

    const phoneDiv = document.getElementById('phonediv_' + vikarId);
    if (!phoneDiv || button.disabled) return;

    const form = document.createElement('form');
    form.id = formId;
    form.hidden = true;
    form.dataset.tpQuickNoAnswer = 'true';

    const comment = document.createElement('textarea');
    comment.id = 'phonetext_' + vikarId;
    comment.name = 'phonetext';
    comment.value = QUICK_NO_ANSWER_TEXT;
    form.appendChild(comment);
    document.body.appendChild(form);

    button.disabled = true;
    button.textContent = 'Gemmer...';

    let completed = false;
    const phoneObserver = new MutationObserver(() => finish(true));
    const finish = success => {
      if (completed) return;
      completed = true;
      phoneObserver.disconnect();
      if (form.isConnected) form.remove();
      button.disabled = false;
      button.textContent = 'Intet svar';
      if (!success) showToast('Registreringen kunne ikke bekr\u00e6ftes. Pr\u00f8v igen via telefonikonet.');
    };

    phoneObserver.observe(phoneDiv, { childList: true, subtree: true });
    try {
      pageWindow.RegistrerOpkald(vagtId, vikarId);
      setTimeout(() => {
        if (form.isConnected) form.remove();
      }, 0);
      setTimeout(() => finish(false), 7000);
    } catch (_) {
      finish(false);
    }
  }

  function decorateQuickNoAnswerLinks(root = document) {
    const links = root.querySelectorAll?.(QUICK_NO_ANSWER_LINK_SELECTOR) || [];
    for (const link of links) {
      if (link.dataset.tpQuickNoAnswerReady === 'true') continue;
      const target = parseCallRegistrationTarget(link.getAttribute('onclick'));
      const cell = link.closest('td');
      if (!target || !cell) continue;

      link.dataset.tpQuickNoAnswerReady = 'true';
      cell.classList.add('tp-quick-no-answer-cell');
      if (cell.querySelector('.tp-quick-no-answer-menu')) continue;

      const menu = document.createElement('div');
      menu.className = 'tp-quick-no-answer-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Hurtig telefonregistrering');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tp-quick-no-answer-button';
      button.textContent = 'Intet svar';
      button.setAttribute('role', 'menuitem');
      button.addEventListener('mousedown', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        submitQuickNoAnswer(target, button);
      });

      menu.appendChild(button);
      cell.appendChild(menu);

      let hideTimer = null;
      const showMenu = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
        cell.classList.add('tp-quick-no-answer-open');
      };
      const hideMenuSoon = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          cell.classList.remove('tp-quick-no-answer-open');
        }, 50);
      };
      cell.addEventListener('mouseenter', showMenu);
      cell.addEventListener('mouseleave', hideMenuSoon);
      menu.addEventListener('mouseenter', showMenu);
      menu.addEventListener('mouseleave', hideMenuSoon);
      menu.addEventListener('focusin', showMenu);
      menu.addEventListener('focusout', hideMenuSoon);
    }
  }

  function initQuickNoAnswer() {
    injectQuickNoAnswerStyles();
    decorateQuickNoAnswerLinks();

    let decorateScheduled = false;
    const observer = new MutationObserver(() => {
      if (decorateScheduled) return;
      decorateScheduled = true;
      setTimeout(() => {
        decorateScheduled = false;
        decorateQuickNoAnswerLinks();
      }, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function startPolling() {
    ensureIncomingCallQueueState();
    heartbeatLeadership();
    pollMessages();
    pollInterest();
    pollIncomingCalls();

    setInterval(() => {
      const wasLeader = isLeader();
      const leaderNow = heartbeatLeadership();
      if (!wasLeader && leaderNow) {
        pollMessages();
        pollInterest();
        pollIncomingCalls();
      }
    }, HEARTBEAT_MS);
    setInterval(pollMessages, MESSAGE_POLL_MS);
    setInterval(pollInterest, INTEREST_POLL_MS);
    setInterval(pollIncomingCalls, TP_CALL_QUEUE.pollMs);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (isLeader()) writeLeadership();
        return;
      }
      tryBecomeLeader(true);
      pollMessages();
      pollInterest();
      pollIncomingCalls();
      refreshMailPushSetting();
    });

    window.addEventListener('beforeunload', () => {
      const leader = getLeader();
      if (leader?.id === TAB_ID) {
        try { localStorage.removeItem(LEADER_KEY); } catch (_) {}
      }
    });
  }

  function startRuntime() {
    if (initIncomingCallReceiver()) return;
    migrateUserKeyToGM();
    initToastBroadcast();
    injectUI();
    initWorkerProfileDeepLinks();
    initWorkerProfileHover();
    initQuickNoAnswer();
    startPolling();
  }

  const TEST_API = Object.freeze({
    TP_VERSION,
    parseNullableCount,
    parseMessageCounters,
    compareVersions,
    normalizeText,
    truncateText,
    parseMessageIndexHTML,
    parseSidebarPreviews,
    parseOpenThreadPreview,
    enrichMessageRecords,
    buildMessageRecordMap,
    messageRecordSignature,
    recordsToMap,
    countUnreadMessageThreads,
    isIncomingMessageRecord,
    countIncomingUnreadThreads,
    hasUnresolvedGeneralDirection,
    resolveMessageCounterTotal,
    messageEventId,
    pruneSeenMessageEvents,
    rememberMessageRecords,
    carryForwardMessageDetails,
    diffMessageThreads,
    mergePendingEvents,
    prunePendingMessageEvents,
    parseTopMenuMessageCount,
    stripCustomerNumber,
    parseInterestOverviewHTML,
    parseInterestDetailHTML,
    entriesToMap,
    diffInterestPairs,
    prunePendingInterestEvents,
    formatMessageNotification,
    formatInterestNotification,
    mapLimit,
    withLocalStorageMutex,
    withCrossTabProcessLock,
    takeChannelLock,
    parseSmsStatusFromHTML,
    parseCallRegistrationTarget,
    parseLabelCount,
    formatDanishDate,
    getWorkerHoverDateRange,
    parseDanishDate,
    normalizePhoneNumber,
    formatPhoneNumber,
    getIncomingCallNumberFromHash,
    parseIncomingCallSearchHTML,
    selectPendingIncomingCallRows,
    showIncomingCallCard,
    parseWorkerProfileHTML,
    parseWorkerStatsHTML,
    parseWorkerCancellationHTML,
    parseWorkerBlockingsHTML,
    buildWorkerProfileURL,
    initWorkerProfileHover,
    initWorkerProfileDeepLinks,
    fetchMessageSnapshot,
    refreshMessageEnrichmentIfNeeded,
    processMessageSnapshot,
    processInterestSnapshot,
    constants: Object.freeze({
      ST_MSG_KEY,
      ST_INT_KEY,
      SUPPRESS_MS,
      MESSAGE_POLL_MS,
      INTEREST_POLL_MS,
      INCOMING_CALL_POLL_MS,
      HEARTBEAT_MS,
      LEASE_MS,
      WORKER_HOVER_CACHE_MS,
      QUICK_NO_ANSWER_TEXT,
      MSG_GENERAL_LIST_URL: MSG_LIST_URLS.generel
    })
  });

  if (IS_TEST) {
    globalThis.__TP_TEST_API__ = TEST_API;
    return;
  }

  if (document.body) startRuntime();
  else window.addEventListener('DOMContentLoaded', startRuntime, { once: true });
})();

