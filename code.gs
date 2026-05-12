const SHEET_TIMEZONE = 'Asia/Jakarta';
const ACTION_TYPES = Object.freeze({ CHECK_IN: 'CHECK_IN', CHECK_OUT: 'CHECK_OUT', REGISTER: 'REGISTER', WALK_IN: 'WALK_IN' });
const MUTATION_ID_COLUMN = 14;
const PROCESSED_PROPERTY_KEY = 'vms_processed_sheet_mutation_ids';
const MAX_PROCESSED_IDS = 5000;
const MAX_RECENT_CACHE_IDS = 2000;
const LEDGER_SHEET_NAME = 'SYNC_LEDGER';
const STATE_SHEET_NAME = 'REG_STATE';
const MAX_EVENT_AGE = 1000 * 60 * 60 * 24;
const MAX_FUTURE_SKEW = 1000 * 60 * 10;
const GAS_SIGNATURE_SECRET_PROPERTY = 'VMS_GAS_HMAC_SECRET';
const SIGNATURE_MIGRATION_MODE_PROPERTY = 'VMS_SIGNATURE_MIGRATION_MODE';
const LOG_SHEET_PREFIX = 'VMS_LOG_';
const SHEET_STATUS_COLUMN = 12;
const SHEET_VERSION_COLUMN = 13;
const SHEET_MUTATION_SOURCE_COLUMN = 15;
const SHEET_REQUEST_FINGERPRINT_COLUMN = 16;
const SHEET_ACTIVITY_LOG_COLUMN = 17;

function getEventTimestamp() {
  return new Date().getTime();
}

// Backward-compatible alias only. Epoch timestamps are UTC/universal; WIB is applied only when formatting.
function getWIBTimestamp() {
  return getEventTimestamp();
}

function getWIBISO(input) {
  const date = input ? new Date(input) : new Date();
  return Utilities.formatDate(date, SHEET_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function formatWIB(input) {
  const date = input ? new Date(input) : new Date();
  return Utilities.formatDate(date, SHEET_TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
}

function normalizeAction(action) {
  const raw = String(action || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['IN', 'CHECKIN', 'CHECK_IN'].indexOf(raw) >= 0) return ACTION_TYPES.CHECK_IN;
  if (['OUT', 'CHECKOUT', 'CHECK_OUT'].indexOf(raw) >= 0) return ACTION_TYPES.CHECK_OUT;
  if (['REGISTER', 'REGISTRATION'].indexOf(raw) >= 0) return ACTION_TYPES.REGISTER;
  if (['WALK_IN', 'WALKIN', 'WALK_IN_CEPAT'].indexOf(raw) >= 0) return ACTION_TYPES.WALK_IN;
  console.warn(JSON.stringify({ type: 'INVALID_ACTION', raw: action, normalized: raw || 'UNKNOWN', updatedAt: getWIBISO() }));
  return raw || 'UNKNOWN';
}

function loadProcessedIds_() {
  const props = PropertiesService.getScriptProperties();
  try { return JSON.parse(props.getProperty(PROCESSED_PROPERTY_KEY) || '[]'); }
  catch (err) { return []; }
}

function saveProcessedIds_(ids) {
  const unique = Array.from(new Set(ids.filter(Boolean))).slice(-MAX_RECENT_CACHE_IDS);
  if (ids.length > unique.length) structuredLog_('CACHE_TRIMMED', { mutationId: '', mutationSource: 'gas', before: ids.length, after: unique.length });
  PropertiesService.getScriptProperties().setProperty(PROCESSED_PROPERTY_KEY, JSON.stringify(unique));
}

function structuredLog_(type, payload) {
  console.log(JSON.stringify(Object.assign({ type: type, updatedAt: getWIBISO() }, payload || {})));
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getExistingSheetMutationIds_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  return sheet.getRange(1, MUTATION_ID_COLUMN, lastRow, 1).getValues().flat().filter(Boolean).map(String);
}

function getOrCreateLedgerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LEDGER_SHEET_NAME);
    sheet.getRange(1, 1, 1, 6).setValues([['mutationId', 'eventTs', 'updatedAt', 'mutationSource', 'version', 'status']]);
  }
  return sheet;
}

function getLedgerMutationIds_(ledgerSheet) {
  const lastRow = ledgerSheet.getLastRow();
  if (lastRow < 2) return [];
  return ledgerSheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().filter(Boolean).map(String);
}

function getLedgerMutationCache_(ledgerSheet) {
  // Optimization-only cache: Apps Script may evict globalThis at any time; SYNC_LEDGER remains authoritative.
  if (!globalThis.vmsLedgerMutationCache) {
    globalThis.vmsLedgerMutationCache = new Set(getLedgerMutationIds_(ledgerSheet));
  }
  return globalThis.vmsLedgerMutationCache;
}

function getDailyLogSheet_(eventTs) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const day = Utilities.formatDate(new Date(eventTs || getEventTimestamp()), SHEET_TIMEZONE, 'yyyy_MM_dd');
  const name = LOG_SHEET_PREFIX + day;
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function hydrateProcessedCache_(sheet, ledgerSheet) {
  let ids = Array.from(getLedgerMutationCache_(ledgerSheet));
  if (!ids.length) {
    structuredLog_('CACHE_RECOVERY_SCAN', { mutationId: '', mutationSource: 'gas', reason: 'ledger_empty' });
    ids = getExistingSheetMutationIds_(sheet);
  }
  saveProcessedIds_(ids);
  structuredLog_('CACHE_HYDRATED', { mutationId: '', mutationSource: 'gas', count: ids.length });
  return ids;
}

function getCachedProcessedSet_(sheet, ledgerSheet) {
  const ids = loadProcessedIds_();
  if (ids && ids.length) return new Set(ids.map(String));
  return new Set(hydrateProcessedCache_(sheet, ledgerSheet).map(String));
}

function hasLedgerMutation_(ledgerSheet, mutationId) {
  if (!mutationId) return false;
  const id = String(mutationId);
  const cached = loadProcessedIds_().map(String);
  if (cached.indexOf(id) >= 0) return true;
  return getLedgerMutationCache_(ledgerSheet).has(id);
}


function getOrCreateStateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(STATE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 5).setValues([['reg', 'latestVersion', 'updatedAt', 'mutationSource', 'lastMutationId']]);
  }
  return sheet;
}

function loadEntityStateMap_(stateSheet) {
  const lastRow = stateSheet.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;
  const rows = stateSheet.getRange(2, 1, lastRow - 1, 5).getValues();
  rows.forEach(function(row, idx) {
    const reg = String(row[0] || '').trim();
    if (!reg) return;
    map.set(reg, { row: idx + 2, reg: reg, latestVersion: Number(row[1] || 0), updatedAt: Number(row[2] || 0), mutationSource: String(row[3] || ''), lastMutationId: String(row[4] || '') });
  });
  return map;
}

function updateEntityState_(stateSheet, stateMap, logs) {
  logs.forEach(function(log) {
    const reg = String(log.reg || '').trim();
    if (!reg) return;
    const current = stateMap.get(reg);
    const row = [reg, Number(log.version || 1), Number(log.updatedAt || getEventTimestamp()), String(log.mutationSource || ''), String(log.mutationId || '')];
    if (current && current.row) {
      stateSheet.getRange(current.row, 1, 1, 5).setValues([row]);
    } else {
      stateSheet.getRange(stateSheet.getLastRow() + 1, 1, 1, 5).setValues([row]);
    }
    stateMap.set(reg, { row: current && current.row ? current.row : stateSheet.getLastRow(), reg: reg, latestVersion: row[1], updatedAt: row[2], mutationSource: row[3], lastMutationId: row[4] });
    structuredLog_('ENTITY_STATE_UPDATED', { mutationId: log.mutationId, mutationSource: log.mutationSource, reg: reg, version: row[1] });
  });
}

function validateEntityVersion_(log, stateMap) {
  const reg = String(log.reg || '').trim();
  const state = stateMap.get(reg);
  if (!state) return { ok: true, replay: false };
  const incomingVersion = Number(log.version || 0);
  const latestVersion = Number(state.latestVersion || 0);
  const incomingMutation = String(log.mutationId || '');
  const latestMutation = String(state.lastMutationId || '');
  if (incomingVersion < latestVersion) return { ok: false, replay: false, reason: 'VERSION_CONFLICT' };
  if (incomingVersion === latestVersion && incomingMutation !== latestMutation) return { ok: false, replay: false, reason: 'VERSION_CONFLICT' };
  if (incomingVersion === latestVersion && incomingMutation === latestMutation) return { ok: true, replay: true };
  return { ok: true, replay: false };
}

function appendLedgerEntries_(ledgerSheet, logs) {
  const rows = logs.map(function(log) {
    return [log.mutationId, log.eventTs, log.updatedAt, log.mutationSource, log.version, 'APPENDED'];
  });
  if (rows.length) ledgerSheet.getRange(ledgerSheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
  const cache = getLedgerMutationCache_(ledgerSheet);
  rows.forEach(function(row) { cache.add(String(row[0])); structuredLog_('LEDGER_APPEND_SUCCESS', { mutationId: row[0], mutationSource: row[3], status: row[5] }); });
}

function hexHmacSha256_(message, secret) {
  const bytes = Utilities.computeHmacSha256Signature(message, secret);
  return bytes.map(function(b) { const v = b < 0 ? b + 256 : b; return ('0' + v.toString(16)).slice(-2); }).join('');
}

function verifyRequestSignature_(body) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty(GAS_SIGNATURE_SECRET_PROPERTY) || '';
  const migrationMode = props.getProperty(SIGNATURE_MIGRATION_MODE_PROPERTY) === 'true';
  const signature = String(body && (body.signature || body.vmsSignature || body.hmac || '') || '').trim().toLowerCase();
  if (!secret) return { ok: migrationMode, migration: migrationMode, reason: 'SECRET_NOT_CONFIGURED' };
  if (!signature) return { ok: migrationMode, migration: migrationMode, reason: 'SIGNATURE_MISSING' };
  const copy = Object.assign({}, body);
  delete copy.signature;
  delete copy.vmsSignature;
  delete copy.hmac;
  const expected = hexHmacSha256_(JSON.stringify(copy), secret).toLowerCase();
  const ok = signature.length === expected.length && signature.split('').reduce(function(acc, ch, i) { return acc | (ch.charCodeAt(0) ^ expected.charCodeAt(i)); }, 0) === 0;
  return { ok: ok, migration: false, reason: ok ? 'OK' : 'INVALID_SIGNATURE' };
}

function parseEventTimestamp_(value, fallback) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number(fallback || getEventTimestamp());
}

function normalizeMutation_(log, index) {
  const now = getEventTimestamp();
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, now);
  const prevVersion = Number(log.prevVersion || log.previousVersion || 0);
  const version = Math.max(1, Number(log.version || (prevVersion + 1)));
  return Object.assign({}, log, {
    action: normalizeAction(log.action),
    eventTs: eventTs,
    time: eventTs,
    updatedAt: Number(log.updatedAt || now),
    mutationSource: String(log.mutationSource || log.deviceId || log.source || 'gas_unknown'),
    version: version,
    mutationId: String(log.mutationId || '').trim()
  });
}

function validateReplayWindow_(log) {
  const now = getEventTimestamp();
  const eventTs = Number(log.eventTs || 0);
  if (!Number.isFinite(eventTs) || eventTs <= 0) return { ok: false, reason: 'STALE_EVENT' };
  if ((now - eventTs) > MAX_EVENT_AGE) return { ok: false, reason: 'STALE_EVENT' };
  if ((eventTs - now) > MAX_FUTURE_SKEW) return { ok: false, reason: 'STALE_EVENT' };
  return { ok: true };
}


function buildVisitorSnapshotLogs_(visitors) {
  const now = getEventTimestamp();
  return Object.entries(visitors || {}).map(function(entry) {
    const key = entry[0];
    const visitor = entry[1] || {};
    const keyParts = String(key || '').split('_');
    const reg = visitor.reg || keyParts.slice(1).join('_') || visitor.id || '';
    const action = normalizeAction(visitor.sourceAction || visitor.action || (String(visitor.nama || visitor.name || '').indexOf('WALK-IN') === 0 ? 'WALK_IN' : 'REGISTER'));
    const eventTs = Number(visitor.eventTs || visitor.updatedAt || now);
    return {
      reg: reg,
      nama: visitor.nama || visitor.name || '',
      name: visitor.name || visitor.nama || '',
      perusahaan: visitor.perusahaan || visitor.company || '',
      company: visitor.company || visitor.perusahaan || '',
      action: action,
      eventTs: eventTs,
      time: eventTs,
      updatedAt: Number(visitor.updatedAt || eventTs),
      mutationSource: visitor.mutationSource || visitor.deviceId || visitor.source || 'visitor_snapshot',
      version: Number(visitor.version || 1),
      mutationId: String(visitor.mutationId || visitor.lastMutationId || ('visitor_' + reg + '_' + eventTs)).trim(),
      requestFingerprint: visitor.requestFingerprint || [visitor.mutationId || '', reg, visitor.deviceId || '', eventTs].join('|'),
      site: visitor.site || keyParts[0] || '',
      deviceId: visitor.deviceId || '',
      kategori: visitor.kategori || visitor.category || '',
      pic: visitor.pic || '',
      start: visitor.start || visitor.startDate || '',
      exp: visitor.exp || visitor.expDate || '',
      status: visitor.currentStatus || action
    };
  }).filter(function(log) { return log.reg && log.mutationId; });
}

function pick_(obj, keys, fallback) {
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function getActivityActionLabel_(action) {
  const normalized = normalizeAction(action);
  if (normalized === ACTION_TYPES.CHECK_IN) return 'IN';
  if (normalized === ACTION_TYPES.CHECK_OUT) return 'OUT';
  if (normalized === ACTION_TYPES.WALK_IN) return 'WALK_IN';
  return normalized;
}

function getActivityEntry_(log) {
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
  const hhmm = Utilities.formatDate(new Date(eventTs), SHEET_TIMEZONE, 'HH:mm');
  return '[' + hhmm + ' ' + getActivityActionLabel_(log.action) + ']';
}

function getDailyKey_(log) {
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
  return Utilities.formatDate(new Date(eventTs), SHEET_TIMEZONE, 'yyyy-MM-dd');
}

function findDailyRowByReg_(sheet, reg) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return 0;
  const target = String(reg || '').trim();
  if (!target) return 0;
  const values = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === target) return i + 1;
  }
  return 0;
}

function appendActivityToExistingRow_(sheet, rowNumber, log) {
  const action = normalizeAction(log.action);
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
  const existingActivity = String(sheet.getRange(rowNumber, SHEET_ACTIVITY_LOG_COLUMN).getValue() || '').trim();
  const nextActivity = (existingActivity ? existingActivity + ' ' : '') + getActivityEntry_(log);
  sheet.getRange(rowNumber, 4).setValue(action);
  sheet.getRange(rowNumber, 5).setValue(formatWIB(eventTs));
  sheet.getRange(rowNumber, SHEET_STATUS_COLUMN).setValue(pick_(log, ['status', 'currentStatus'], action));
  sheet.getRange(rowNumber, SHEET_VERSION_COLUMN).setValue(pick_(log, ['version'], 1));
  sheet.getRange(rowNumber, MUTATION_ID_COLUMN).setValue(pick_(log, ['mutationId'], ''));
  sheet.getRange(rowNumber, SHEET_MUTATION_SOURCE_COLUMN).setValue(pick_(log, ['mutationSource'], ''));
  sheet.getRange(rowNumber, SHEET_REQUEST_FINGERPRINT_COLUMN).setValue(pick_(log, ['requestFingerprint'], ''));
  sheet.getRange(rowNumber, SHEET_ACTIVITY_LOG_COLUMN).setValue(nextActivity);
}

function buildRow_(log) {
  const action = normalizeAction(pick_(log, ['action', 'Action'], ''));
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
  return [
    pick_(log, ['reg', 'REG', 'Reg'], ''),
    pick_(log, ['nama', 'name', 'Nama'], ''),
    pick_(log, ['perusahaan', 'company', 'Perusahaan'], ''),
    action,
    formatWIB(eventTs),
    pick_(log, ['site', 'Site'], ''),
    pick_(log, ['deviceId', 'deviceID', 'DeviceId'], ''),
    pick_(log, ['kategori', 'category', 'Kategori'], ''),
    pick_(log, ['pic', 'PIC'], ''),
    pick_(log, ['start', 'startDate'], ''),
    pick_(log, ['exp', 'expDate'], ''),
    pick_(log, ['status', 'currentStatus'], action),
    pick_(log, ['version'], 1),
    pick_(log, ['mutationId'], ''),
    pick_(log, ['mutationSource'], ''),
    pick_(log, ['requestFingerprint'], ''),
    getActivityEntry_(Object.assign({}, log, { action: action, eventTs: eventTs }))
  ];
}

function appendRowsIdempotent_(logs) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  structuredLog_('LOCK_ACQUIRED', { mutationId: '', mutationSource: 'gas', lock: 'sheet_append' });
  try {
    const legacySheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const ledgerSheet = getOrCreateLedgerSheet_();
    const stateSheet = getOrCreateStateSheet_();
    const stateMap = loadEntityStateMap_(stateSheet);
    const seen = getCachedProcessedSet_(legacySheet, ledgerSheet);
    const ledgerLogs = [];
    const mutationIds = [];
    const skippedMutationIds = [];
    const staleMutationIds = [];
    const versionRejectedMutationIds = [];
    const requestFingerprints = [];
    const dailyRowCache = {};
    let rowsAppended = 0;
    let rowsUpdated = 0;

    logs.forEach(function(inputLog, index) {
      try {
        const log = normalizeMutation_(inputLog, index);
        const mutationId = String(log.mutationId || '').trim();
        if (!mutationId) {
          structuredLog_('MUTATION_MAPPING_SKIPPED', { mutationId: '', mutationSource: 'gas', reason: 'mutationId_missing', index: index });
          return;
        }
        const replay = validateReplayWindow_(log);
        if (!replay.ok) {
          staleMutationIds.push(mutationId);
          structuredLog_('STALE_EVENT_SKIPPED', { mutationId: mutationId, mutationSource: log.mutationSource, eventTs: log.eventTs });
          return;
        }
        if (seen.has(mutationId) || hasLedgerMutation_(ledgerSheet, mutationId)) {
          skippedMutationIds.push(mutationId);
          requestFingerprints.push(log.requestFingerprint || '');
          seen.add(mutationId);
          structuredLog_('DUPLICATE_MUTATION_SKIPPED', { mutationId: mutationId, mutationSource: log.mutationSource });
          return;
        }
        const versionCheck = validateEntityVersion_(log, stateMap);
        if (!versionCheck.ok) {
          versionRejectedMutationIds.push(mutationId);
          structuredLog_('VERSION_CONFLICT_REJECTED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: log.reg, version: log.version });
          return;
        }
        if (versionCheck.replay) {
          skippedMutationIds.push(mutationId);
          requestFingerprints.push(log.requestFingerprint || '');
          seen.add(mutationId);
          structuredLog_('VERSION_REPLAY_ACCEPTED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: log.reg, version: log.version });
          return;
        }

        const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
        const appendSheet = getDailyLogSheet_(eventTs);
        const reg = String(log.reg || '').trim();
        const dailyKey = getDailyKey_(log) + '|' + reg;
        let rowNumber = dailyRowCache[dailyKey] || findDailyRowByReg_(appendSheet, reg);

        if (rowNumber) {
          appendActivityToExistingRow_(appendSheet, rowNumber, log);
          rowsUpdated++;
          structuredLog_('DAILY_ACTIVITY_UPDATED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: reg, row: rowNumber, day: getDailyKey_(log), activity: getActivityEntry_(log) });
        } else {
          const row = buildRow_(log);
          rowNumber = appendSheet.getLastRow() + 1;
          appendSheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
          dailyRowCache[dailyKey] = rowNumber;
          rowsAppended++;
          structuredLog_('DAILY_ACTIVITY_ROW_CREATED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: reg, row: rowNumber, day: getDailyKey_(log), activity: getActivityEntry_(log) });
        }

        ledgerLogs.push(log);
        mutationIds.push(mutationId);
        requestFingerprints.push(log.requestFingerprint || '');
        seen.add(mutationId);
        structuredLog_(String(log.action).replace(/[^A-Z_]/g, '') + '_APPENDED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: log.reg });
      } catch (rowErr) {
        structuredLog_('MUTATION_MAPPING_ERROR', { mutationId: inputLog && inputLog.mutationId || '', mutationSource: inputLog && (inputLog.mutationSource || inputLog.deviceId) || 'gas', index: index, reason: rowErr && rowErr.message || String(rowErr) });
      }
    });

    if (ledgerLogs.length) {
      appendLedgerEntries_(ledgerSheet, ledgerLogs);
      updateEntityState_(stateSheet, stateMap, ledgerLogs);
    }
    saveProcessedIds_(Array.from(seen));
    return { rowsAppended: rowsAppended, rowsUpdated: rowsUpdated, mutationIds: mutationIds, skippedMutationIds: skippedMutationIds, staleMutationIds: staleMutationIds, staleCount: staleMutationIds.length, versionRejectedMutationIds: versionRejectedMutationIds, versionRejectedCount: versionRejectedMutationIds.length, requestFingerprints: requestFingerprints };
  } finally {
    structuredLog_('LOCK_RELEASED', { mutationId: '', mutationSource: 'gas', lock: 'sheet_append' });
    lock.releaseLock();
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const auth = verifyRequestSignature_(body);
    if (!auth.ok) {
      structuredLog_('INVALID_SIGNATURE_REJECTED', { mutationId: '', mutationSource: body.source || 'unknown', reason: auth.reason });
      return jsonResponse_({ ok: false, ack: false, reason: 'INVALID_SIGNATURE', mutationIds: [], skippedMutationIds: [], ackMutationIds: [], updatedAt: getWIBISO() });
    }
    const logs = Array.isArray(body.logs) ? body.logs : [];
    const visitorLogs = body && body.visitors && typeof body.visitors === 'object' ? buildVisitorSnapshotLogs_(body.visitors) : [];
    const normalized = [];
    logs.concat(visitorLogs).forEach(function(log, index) {
      try {
        const mapped = normalizeMutation_(Object.assign({}, log, { action: normalizeAction(log && log.action) }), index);
        if (mapped.reg && mapped.mutationId && (mapped.action === ACTION_TYPES.CHECK_IN || mapped.action === ACTION_TYPES.CHECK_OUT || mapped.action === ACTION_TYPES.REGISTER || mapped.action === ACTION_TYPES.WALK_IN)) {
          normalized.push(mapped);
        } else {
          structuredLog_('GAS_LOG_MAPPING_SKIPPED', { mutationId: mapped.mutationId || '', mutationSource: mapped.mutationSource || 'gas', reg: mapped.reg || '', action: mapped.action || '', index: index });
        }
      } catch (mapErr) {
        structuredLog_('GAS_LOG_MAPPING_ERROR', { mutationId: log && log.mutationId || '', mutationSource: log && (log.mutationSource || log.deviceId) || 'gas', index: index, reason: mapErr && mapErr.message || String(mapErr) });
      }
    });
    const result = appendRowsIdempotent_(normalized);
    const ackIds = result.mutationIds.concat(result.skippedMutationIds);
    return jsonResponse_({ ok: true, ack: true, rowsAppended: result.rowsAppended, rowsUpdated: result.rowsUpdated || 0, mutationIds: result.mutationIds, skippedMutationIds: result.skippedMutationIds, staleMutationIds: result.staleMutationIds || [], staleCount: result.staleCount || 0, versionRejectedMutationIds: result.versionRejectedMutationIds || [], versionRejectedCount: result.versionRejectedCount || 0, ackMutationIds: ackIds, requestFingerprints: result.requestFingerprints || [], ackCount: ackIds.length, updatedAt: getWIBISO() });
  } catch (err) {
    console.error(JSON.stringify({ type: 'GAS_APPEND_FAIL', reason: err && err.message || String(err), updatedAt: getWIBISO() }));
    return jsonResponse_({ ok: false, ack: false, mutationIds: [], skippedMutationIds: [], staleMutationIds: [], staleCount: 0, versionRejectedMutationIds: [], versionRejectedCount: 0, ackMutationIds: [], error: err && err.message || String(err), updatedAt: getWIBISO() });
  }
}
