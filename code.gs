// ============================================================
// VMS GOOGLE APPS SCRIPT - FULL PATCHED VERSION
// FORENSIC FIXES:
//   FIX-1: buildVisitorSnapshotLogs_ — field mapping lengkap ke sheet Log
//   FIX-2: doPost — log dari body.logs diberi field lengkap dari body.visitors
//   FIX-3: doGet pull — status, version, updatedAt dibaca dari sheet Log
//   FIX-4: Header auto-create/validate untuk sheet Log
//   FIX-5: processLogs_ tidak memblokir REGISTER event
// ============================================================

// ================= KONFIGURASI =================
const SHEET_ID = '1ohvC84wtT4EP-rcrDbWZ1tKKMIWGjvxSu_JTTDIfvkA';
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
const ATTENDANCE_SHEET_NAME = 'DAILY_ATTENDANCE';
const ATTENDANCE_INDEX_PROPERTY_KEY = 'vms_attendance_row_index_v1';

// ================= LICENSE & SITE SHEET NAMES =================
const LICENSE_SHEET_NAME = 'LICENSES';
const LICENSE_DEVICES_SHEET_NAME = 'LICENSE_DEVICES';
const SITES_SHEET_NAME = 'SITES';

// ================= HEADER RESMI SHEET LOG =================
// WAJIB: urutan kolom ini adalah sumber kebenaran tunggal
const OFFICIAL_LOG_HEADERS = Object.freeze([
  'Nama',        // 1
  'Perusahaan',  // 2
  'Tujuan',      // 3
  'PIC',         // 4
  'Start',       // 5
  'Exp',         // 6
  'Checkin',     // 7
  'Checkout',    // 8
  'REG',         // 9
  'Action',      // 10
  'LogTime',     // 11
  'Status',      // 12
  'Site',        // 13
  'Duration',    // 14
  'Kategori',    // 15
  'Dept',        // 16
  'Keterangan',  // 17
  'Activity Log' // 18
]);
const REQUIRED_LOG_HEADERS_STRICT = Object.freeze(['REG', 'Action', 'LogTime']);
const REQUIRED_LOG_HEADERS = OFFICIAL_LOG_HEADERS;

// ================= UTILITY FUNCTIONS =================
function getEventTimestamp() {
  return new Date().getTime();
}

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
  // Ledger adalah sumber kebenaran utama. Return [] agar ledger digunakan.
  return [];
}

function getOrCreateLedgerSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
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
  if (!globalThis.vmsLedgerMutationCache) {
    globalThis.vmsLedgerMutationCache = new Set(getLedgerMutationIds_(ledgerSheet));
  }
  return globalThis.vmsLedgerMutationCache;
}

// ============================================================
// FIX-4: getOrCreateLogSheet_ — auto-create sheet Log dengan header resmi
//         + validate & inject header yang hilang
// ============================================================
function getOrCreateLogSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('Log');
  if (!sheet) {
    structuredLog_('LOG_SHEET_CREATING', { mutationId: '', mutationSource: 'gas', sheetName: 'Log' });
    sheet = ss.insertSheet('Log');
    sheet.getRange(1, 1, 1, OFFICIAL_LOG_HEADERS.length).setValues([OFFICIAL_LOG_HEADERS]);
    structuredLog_('LOG_SHEET_CREATED', { mutationId: '', mutationSource: 'gas', sheetName: 'Log', headers: OFFICIAL_LOG_HEADERS.join(',') });
    return sheet;
  }
  // Validate dan repair header jika ada yang hilang
  ensureLogSheetHeaders_(sheet);
  return sheet;
}

function ensureLogSheetHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existingHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
  const missingHeaders = [];
  OFFICIAL_LOG_HEADERS.forEach(function(h) {
    if (existingHeaders.indexOf(h) < 0) missingHeaders.push(h);
  });
  if (missingHeaders.length > 0) {
    // Append missing headers ke kolom berikutnya
    const nextCol = lastCol + 1;
    missingHeaders.forEach(function(h, i) {
      sheet.getRange(1, nextCol + i).setValue(h);
    });
    structuredLog_('LOG_SHEET_HEADERS_REPAIRED', { mutationId: '', mutationSource: 'gas', addedHeaders: missingHeaders.join(',') });
  }
}

function getDailyLogSheet_(eventTs) {
  return getOrCreateLogSheet_();
}

function getOrCreateAttendanceSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 10).setValues([['attendanceKey', 'reg', 'nama', 'perusahaan', 'tanggal', 'checkinTimes', 'checkoutTimes', 'lastStatus', 'lastMutationId', 'updatedAt']]);
  }
  return sheet;
}

function loadAttendanceIndexCache_() {
  const props = PropertiesService.getScriptProperties();
  try { return JSON.parse(props.getProperty(ATTENDANCE_INDEX_PROPERTY_KEY) || '{}'); }
  catch (e) { return {}; }
}

function saveAttendanceIndexCache_(cache) {
  const compact = {};
  Object.keys(cache || {}).slice(-20000).forEach(function(k) { if (cache[k]) compact[k] = Number(cache[k]); });
  PropertiesService.getScriptProperties().setProperty(ATTENDANCE_INDEX_PROPERTY_KEY, JSON.stringify(compact));
}

function buildAttendanceIndexCache_(sheet) {
  const lastRow = sheet.getLastRow();
  const cache = {};
  if (lastRow > 1) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(String);
    keys.forEach(function(k, i) { if (k) cache[k] = i + 2; });
  }
  saveAttendanceIndexCache_(cache);
  return cache;
}

function upsertAttendanceRow_(sheet, log, rowIndexCache) {
  const action = normalizeAction(log.action);
  if (!(action === ACTION_TYPES.CHECK_IN || action === ACTION_TYPES.CHECK_OUT)) return;
  const day = Utilities.formatDate(new Date(Number(log.eventTs || getEventTimestamp())), SHEET_TIMEZONE, 'yyyy-MM-dd');
  const reg = String(log.reg || '').trim().toUpperCase();
  const key = reg + '|' + day;
  const eventTime = Utilities.formatDate(new Date(Number(log.eventTs || getEventTimestamp())), SHEET_TIMEZONE, 'HH:mm:ss');
  let idx = Number((rowIndexCache || {})[key] || 0);
  if (idx < 2 || idx > sheet.getLastRow()) idx = 0;
  if (idx === 0) {
    const newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, 10).setValues([[key, reg, log.nama || '', log.perusahaan || '', day, action === ACTION_TYPES.CHECK_IN ? eventTime : '', action === ACTION_TYPES.CHECK_OUT ? eventTime : '', action, log.mutationId || '', getWIBISO(log.updatedAt || log.eventTs)]]);
    if (rowIndexCache) rowIndexCache[key] = newRow;
    return;
  }
  const initialRow = sheet.getRange(idx, 1, 1, 10).getValues()[0];
  const rowUpdatedAt = parseEventTimestamp_(initialRow[9], 0);
  const incomingUpdatedAt = Number(log.updatedAt || log.eventTs || 0);
  if (incomingUpdatedAt < rowUpdatedAt) return;
  const latestRow = sheet.getRange(idx, 1, 1, 10).getValues()[0];
  const latestCheckIns = String(latestRow[5] || '').split(/\r?\n/).map(function(v) { return String(v || '').trim(); }).filter(Boolean);
  const latestCheckOuts = String(latestRow[6] || '').split(/\r?\n/).map(function(v) { return String(v || '').trim(); }).filter(Boolean);
  const mergedCheckIns = Array.from(new Set(action === ACTION_TYPES.CHECK_IN ? latestCheckIns.concat([eventTime]) : latestCheckIns)).slice(-20);
  const mergedCheckOuts = Array.from(new Set(action === ACTION_TYPES.CHECK_OUT ? latestCheckOuts.concat([eventTime]) : latestCheckOuts)).slice(-20);
  sheet.getRange(idx, 6, 1, 5).setValues([[mergedCheckIns.join('\n'), mergedCheckOuts.join('\n'), action, log.mutationId || latestRow[8] || '', getWIBISO(incomingUpdatedAt)]]);
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
  const ss = SpreadsheetApp.openById(SHEET_ID);
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
  // FIX: REGISTER/WALK_IN selalu diizinkan — ini pendaftaran baru, bukan update
  const action = normalizeAction(log.action);
  if (action === ACTION_TYPES.REGISTER || action === ACTION_TYPES.WALK_IN) {
    return { ok: true, replay: false };
  }
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

function verifyRequestSignature_(body, e) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty(GAS_SIGNATURE_SECRET_PROPERTY) || '';
  const migrationMode = props.getProperty(SIGNATURE_MIGRATION_MODE_PROPERTY) === 'true';
  const headerSig = e && e.parameter && (e.parameter.signature || e.parameter.vmsSignature || e.parameter.hmac) || '';
  const signature = String(body && (body.signature || body.vmsSignature || body.hmac || '') || headerSig || '').trim().toLowerCase();
  if (!secret) return { ok: migrationMode, migration: migrationMode, reason: 'SECRET_NOT_CONFIGURED' };
  if (!signature) return { ok: migrationMode, migration: migrationMode, reason: 'SIGNATURE_MISSING' };
  const copy = Object.assign({}, body || {});
  delete copy.signature;
  delete copy.vmsSignature;
  delete copy.hmac;
  const payloadWithoutSig = JSON.stringify(copy);
  const payloadAsReceived = JSON.stringify(body || {});
  const expectedNoSig = hexHmacSha256_(payloadWithoutSig, secret).toLowerCase();
  const expectedRaw = hexHmacSha256_(payloadAsReceived, secret).toLowerCase();
  const secureEquals_ = function(left, right) {
    if (left.length !== right.length) return false;
    return left.split('').reduce(function(acc, ch, i) { return acc | (ch.charCodeAt(0) ^ right.charCodeAt(i)); }, 0) === 0;
  };
  const ok = secureEquals_(signature, expectedNoSig) || secureEquals_(signature, expectedRaw);
  if (!ok && migrationMode) {
    structuredLog_('INVALID_SIGNATURE_MIGRATION_BYPASS', { mutationId: '', mutationSource: body && (body.source || body.deviceId) || 'unknown', reason: 'MIGRATION_MODE_ACTIVE' });
    return { ok: true, migration: true, reason: 'MIGRATION_BYPASS' };
  }
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

// ============================================================
// FIX-1: buildVisitorSnapshotLogs_ — mapping field LENGKAP
// Sebelum: field seperti tujuan, pic, dept, start, exp tidak dipetakan
// Sesudah: semua field official sheet Log dipetakan dengan benar
// ============================================================
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
      // Field nama — dua alias untuk kompatibilitas pick_()
      nama: visitor.nama || visitor.name || '',
      name: visitor.name || visitor.nama || '',
      // Field perusahaan — dua alias
      perusahaan: visitor.perusahaan || visitor.company || '',
      company: visitor.company || visitor.perusahaan || '',
      // FIX: field yang sebelumnya hilang
      tujuan: visitor.tujuan || visitor.purpose || '',
      purpose: visitor.tujuan || visitor.purpose || '',
      pic: visitor.pic || visitor.PIC || '',
      dept: visitor.dept || visitor.Departemen || visitor.department || '',
      kategori: visitor.kategori || visitor.category || '',
      category: visitor.category || visitor.kategori || '',
      keterangan: visitor.keterangan || visitor.notes || '',
      notes: visitor.keterangan || visitor.notes || '',
      // FIX: field tanggal — dua alias masing-masing
      startDate: visitor.startDate || visitor.start || '',
      start: visitor.startDate || visitor.start || '',
      expDate: visitor.expDate || visitor.exp || '',
      exp: visitor.expDate || visitor.exp || '',
      // Field lain
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

function validateRequiredHeaders_(headerMap) {
  const missingStrict = REQUIRED_LOG_HEADERS_STRICT.filter(function(name) { return !headerMap || !headerMap[name]; });
  const missingOptional = REQUIRED_LOG_HEADERS.filter(function(name) {
    return REQUIRED_LOG_HEADERS_STRICT.indexOf(name) < 0 && (!headerMap || !headerMap[name]);
  });
  if (missingOptional.length) {
    structuredLog_('HEADER_OPTIONAL_MISSING', { mutationId: '', mutationSource: 'gas', missingHeaders: missingOptional.join(', '), note: 'kolom tidak ada, akan diskip' });
  }
  if (missingStrict.length) {
    structuredLog_('HEADER_CRITICAL_MISSING', { mutationId: '', mutationSource: 'gas', missingHeaders: missingStrict.join(', ') });
    throw new Error('HEADER_CRITICAL_MISSING:' + missingStrict.join(','));
  }
}

function getHeaderMap_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const map = {};
  headers.forEach(function(header, idx) {
    const key = String(header || '').trim();
    if (key) map[key] = idx + 1;
  });
  return map;
}

function requiredHeaderColumn_(headerMap, name) {
  const col = Number(headerMap && headerMap[name] || 0);
  if (col < 1) {
    structuredLog_('HEADER_NOT_FOUND_SKIP', { mutationId: '', mutationSource: 'gas', missingHeaders: name });
    return 0;
  }
  return col;
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

function getSheetDateKey_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, SHEET_TIMEZONE, 'yyyy-MM-dd');
  }
  var str = String(value).trim();
  if (!str) return '';
  var dmy = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmy) return dmy[3] + '-' + dmy[2] + '-' + dmy[1];
  var iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  return '';
}

function findDailyRowByReg_(sheet, reg, headerMap, dayKey) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const target = String(reg || '').trim();
  if (!target) return 0;
  const regCol = requiredHeaderColumn_(headerMap, 'REG');
  if (regCol < 1) return 0;
  const logTimeCol = requiredHeaderColumn_(headerMap, 'LogTime');
  const startCol = requiredHeaderColumn_(headerMap, 'Start');
  const regValues = sheet.getRange(2, regCol, lastRow - 1, 1).getValues();
  const logTimeValues = logTimeCol > 0 ? sheet.getRange(2, logTimeCol, lastRow - 1, 1).getValues() : regValues.map(function() { return ['']; });
  const startValues = startCol > 0 ? sheet.getRange(2, startCol, lastRow - 1, 1).getValues() : regValues.map(function() { return ['']; });
  for (var i = 0; i < regValues.length; i++) {
    const rowReg = String(regValues[i][0] || '').trim();
    const rowDay = getSheetDateKey_(logTimeValues[i][0]) || getSheetDateKey_(startValues[i][0]);
    if (rowReg === target && rowDay === String(dayKey || '').trim()) return i + 2;
  }
  return 0;
}

function appendActivityToExistingRow_(sheet, rowNumber, log, headerMap) {
  const action = normalizeAction(log.action);
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
  function setCell(name, value) {
    var col = requiredHeaderColumn_(headerMap, name);
    if (col > 0) sheet.getRange(rowNumber, col).setValue(value);
  }
  const activityCol = requiredHeaderColumn_(headerMap, 'Activity Log');
  var existingActivity = activityCol > 0 ? String(sheet.getRange(rowNumber, activityCol).getValue() || '').trim() : '';
  const nextActivity = (existingActivity ? existingActivity + ' ' : '') + getActivityEntry_(log);
  setCell('Action',  action);
  setCell('LogTime', formatWIB(eventTs));
  setCell('Status',  pick_(log, ['status', 'currentStatus'], action));
  if (action === ACTION_TYPES.CHECK_IN) {
    const checkinCol = requiredHeaderColumn_(headerMap, 'Checkin');
    if (checkinCol > 0) {
      const existingCheckin = String(sheet.getRange(rowNumber, checkinCol).getValue() || '').trim();
      const nextCheckin = existingCheckin ? (existingCheckin + '\n' + formatWIB(eventTs)) : formatWIB(eventTs);
      sheet.getRange(rowNumber, checkinCol).setValue(nextCheckin.split(/\r?\n/).map(function(v){ return String(v||'').trim(); }).filter(Boolean).slice(-20).join('\n'));
    }
  }
  if (action === ACTION_TYPES.CHECK_OUT) {
    const checkoutCol = requiredHeaderColumn_(headerMap, 'Checkout');
    if (checkoutCol > 0) {
      const existingCheckout = String(sheet.getRange(rowNumber, checkoutCol).getValue() || '').trim();
      const nextCheckout = existingCheckout ? (existingCheckout + '\n' + formatWIB(eventTs)) : formatWIB(eventTs);
      sheet.getRange(rowNumber, checkoutCol).setValue(nextCheckout.split(/\r?\n/).map(function(v){ return String(v||'').trim(); }).filter(Boolean).slice(-20).join('\n'));
    }
  }
  if (activityCol > 0) sheet.getRange(rowNumber, activityCol).setValue(nextActivity);
  if (headerMap['REG']) sheet.getRange(rowNumber, headerMap['REG']).setValue(pick_(log, ['reg', 'REG', 'Reg'], ''));
  if (headerMap['Nama']) sheet.getRange(rowNumber, headerMap['Nama']).setValue(pick_(log, ['nama', 'name', 'Nama'], ''));
  if (headerMap['Perusahaan']) sheet.getRange(rowNumber, headerMap['Perusahaan']).setValue(pick_(log, ['perusahaan', 'company', 'Perusahaan'], ''));
}

function buildRow_(log, headerMap) {
  const action = normalizeAction(pick_(log, ['action', 'Action'], ''));
  const eventTs = parseEventTimestamp_(log.eventTs || log.time || log.updatedAt, getEventTimestamp());
  const maxCol = Math.max.apply(null, Object.keys(headerMap || {}).map(function(k) { return Number(headerMap[k] || 0); }).concat([1]));
  const row = new Array(maxCol).fill('');
  function setCol(name, value) {
    var col = requiredHeaderColumn_(headerMap, name);
    if (col > 0) row[col - 1] = value;
  }
  setCol('Nama',         pick_(log, ['nama', 'name', 'Nama'], ''));
  setCol('Perusahaan',   pick_(log, ['perusahaan', 'company', 'Perusahaan'], ''));
  setCol('Tujuan',       pick_(log, ['tujuan', 'purpose', 'Tujuan'], ''));
  setCol('PIC',          pick_(log, ['pic', 'PIC'], ''));
  setCol('Start',        pick_(log, ['start', 'startDate'], ''));
  setCol('Exp',          pick_(log, ['exp', 'expDate'], ''));
  setCol('Checkin',      action === ACTION_TYPES.CHECK_IN  ? formatWIB(eventTs) : '');
  setCol('Checkout',     action === ACTION_TYPES.CHECK_OUT ? formatWIB(eventTs) : '');
  setCol('REG',          pick_(log, ['reg', 'REG', 'Reg'], ''));
  setCol('Action',       action);
  setCol('LogTime',      formatWIB(eventTs));
  setCol('Status',       pick_(log, ['status', 'currentStatus'], action));
  setCol('Site',         pick_(log, ['site', 'Site'], ''));
  setCol('Duration',     pick_(log, ['duration', 'Duration'], ''));
  setCol('Kategori',     pick_(log, ['kategori', 'category', 'Kategori'], ''));
  setCol('Dept',         pick_(log, ['dept', 'Departemen', 'department'], ''));
  setCol('Keterangan',   pick_(log, ['keterangan', 'notes', 'Keterangan'], ''));
  setCol('Activity Log', getActivityEntry_(Object.assign({}, log, { action: action, eventTs: eventTs })));
  return row;
}

function isExpired_(expDate) {
  if (!expDate) return false;
  var raw = expDate instanceof Date ? expDate : new Date(expDate);
  if (isNaN(raw.getTime())) return false;
  var wibDateStr = Utilities.formatDate(raw, SHEET_TIMEZONE, 'yyyy-MM-dd');
  var endOfDayWIB = new Date(wibDateStr + 'T23:59:59+07:00');
  return getEventTimestamp() > endOfDayWIB.getTime();
}

// ============================================================
// FIX-5: processLogs_ — REGISTER & WALK_IN tidak diblokir expiry
// REGISTER adalah pendaftaran baru — visitor belum ada di sheet,
// jadi tidak ada expDate untuk dicek. Blokir hanya untuk CHECK_IN/CHECK_OUT.
// ============================================================
function processLogs_(logs, body) {
  console.log("PROCESS LOGS:", logs.length);
  const visitors = body && body.visitors && typeof body.visitors === 'object' ? body.visitors : {};
  const visitorExpByReg = {};
  Object.keys(visitors).forEach(function(k) {
    const v = visitors[k] || {};
    const reg = String(v.reg || '').trim();
    if (!reg) return;
    const exp = pick_(v, ['exp', 'expDate', 'Exp'], '');
    if (exp) visitorExpByReg[reg] = exp;
  });

  const sheetExpByReg = {};
  try {
    const sheet = getDailyLogSheet_(getEventTimestamp());
    const headerMap = getHeaderMap_(sheet);
    if (headerMap['REG'] && headerMap['Exp']) {
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const maxCol = Math.max(headerMap['REG'], headerMap['Exp']);
        const rows = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();
        rows.forEach(function(row) {
          const reg = String(row[headerMap['REG'] - 1] || '').trim();
          const exp = row[headerMap['Exp'] - 1];
          if (reg && exp && !sheetExpByReg[reg]) sheetExpByReg[reg] = exp;
        });
      }
    }
  } catch (expLookupErr) {
    structuredLog_('SCAN_EXP_LOOKUP_FAILED', { mutationId: '', mutationSource: 'gas', reason: expLookupErr && expLookupErr.message || String(expLookupErr) });
  }

  (logs || []).forEach(function(log, index) {
    const action = normalizeAction(log && log.action);
    const reg = String((log && (log.reg || log.REG || log.Reg)) || '').trim();
    console.log("SCAN ACTION:", action, "REG:", reg);
    if (!reg) {
      structuredLog_('SCAN_SKIPPED', { mutationId: log && log.mutationId || '', mutationSource: log && (log.mutationSource || log.deviceId) || 'gas', reason: 'REG_EMPTY', index: index });
      return;
    }
    // FIX-5: Jangan cek expiry untuk REGISTER dan WALK_IN
    // Ini adalah pendaftaran baru — expDate belum ada di sheet
    if (action === ACTION_TYPES.REGISTER || action === ACTION_TYPES.WALK_IN) {
      return; // tidak ada expired check
    }
    const expDate = pick_(log || {}, ['exp', 'expDate', 'Exp'], pick_(visitors[reg] || {}, ['exp', 'expDate', 'Exp'], visitorExpByReg[reg] || sheetExpByReg[reg] || pick_(body || {}, ['exp', 'expDate', 'Exp'], '')));
    if (isExpired_(expDate)) {
      log._expiredBlocked = true;
      structuredLog_('SCAN_EXPIRED_SKIPPED', { mutationId: log && log.mutationId || '', mutationSource: log && (log.mutationSource || log.deviceId) || 'gas', reg: reg, action: action, expDate: String(expDate || '') });
    }
  });
  return logs;
}

function appendRowsIdempotent_(logs) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  structuredLog_('LOCK_ACQUIRED', { mutationId: '', mutationSource: 'gas', lock: 'sheet_append' });
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const legacySheet = ss.getSheetByName('Log') || ss.getSheets()[0];
    const ledgerSheet = getOrCreateLedgerSheet_();
    const stateSheet = getOrCreateStateSheet_();
    const attendanceSheet = getOrCreateAttendanceSheet_();
    let attendanceIndexCache = loadAttendanceIndexCache_();
    if (!Object.keys(attendanceIndexCache).length) attendanceIndexCache = buildAttendanceIndexCache_(attendanceSheet);
    const stateMap = loadEntityStateMap_(stateSheet);
    const seen = getCachedProcessedSet_(legacySheet, ledgerSheet);
    const ledgerLogs = [];
    const mutationIds = [];
    const skippedMutationIds = [];
    const staleMutationIds = [];
    const versionRejectedMutationIds = [];
    const requestFingerprints = [];
    const dailyRowCache = {};
    // FIX-4: gunakan getOrCreateLogSheet_ agar sheet Log auto-create jika belum ada
    const appendSheet = getOrCreateLogSheet_();
    const headerMap = getHeaderMap_(appendSheet);
    validateRequiredHeaders_(headerMap);
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
        const reg = String(log.reg || '').trim();
        const action = normalizeAction(log.action);

        // FIX: Untuk REGISTER/WALK_IN, selalu buat baris baru (bukan update existing).
        // Untuk CHECK_IN/CHECK_OUT, cari baris existing berdasarkan REG + hari.
        let rowNumber = 0;
        if (action === ACTION_TYPES.CHECK_IN || action === ACTION_TYPES.CHECK_OUT) {
          const dailyKey = getDailyKey_(log) + '|' + reg;
          rowNumber = dailyRowCache[dailyKey] || findDailyRowByReg_(appendSheet, reg, headerMap, getDailyKey_(log));
          if (rowNumber) dailyRowCache[dailyKey] = rowNumber;
        }

        if (rowNumber) {
          appendActivityToExistingRow_(appendSheet, rowNumber, log, headerMap);
          upsertAttendanceRow_(attendanceSheet, log, attendanceIndexCache);
          rowsUpdated++;
          structuredLog_('DAILY_ACTIVITY_UPDATED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: reg, row: rowNumber, day: getDailyKey_(log), activity: getActivityEntry_(log) });
        } else {
          const row = buildRow_(log, headerMap);
          const newRow = appendSheet.getLastRow() + 1;
          appendSheet.getRange(newRow, 1, 1, row.length).setValues([row]);
          if (action === ACTION_TYPES.CHECK_IN || action === ACTION_TYPES.CHECK_OUT) {
            const dailyKey2 = getDailyKey_(log) + '|' + reg;
            dailyRowCache[dailyKey2] = newRow;
          }
          upsertAttendanceRow_(attendanceSheet, log, attendanceIndexCache);
          rowsAppended++;
          structuredLog_('DAILY_ACTIVITY_ROW_CREATED', { mutationId: mutationId, mutationSource: log.mutationSource, reg: reg, row: newRow, day: getDailyKey_(log), action: action, activity: getActivityEntry_(log) });
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
    saveAttendanceIndexCache_(attendanceIndexCache);
    return { rowsAppended: rowsAppended, rowsUpdated: rowsUpdated, mutationIds: mutationIds, skippedMutationIds: skippedMutationIds, staleMutationIds: staleMutationIds, staleCount: staleMutationIds.length, versionRejectedMutationIds: versionRejectedMutationIds, versionRejectedCount: versionRejectedMutationIds.length, requestFingerprints: requestFingerprints };
  } finally {
    structuredLog_('LOCK_RELEASED', { mutationId: '', mutationSource: 'gas', lock: 'sheet_append' });
    lock.releaseLock();
  }
}

// ============================================================
// LICENSE & DYNAMIC SITES MANAGEMENT
// ============================================================

function getOrCreateLicenseSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(LICENSE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LICENSE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 8).setValues([[
      'licenseKey', 'package', 'maxVisitors', 'maxDevices',
      'maxScansPerDay', 'expiredAt', 'isActive', 'createdAt'
    ]]);
    sheet.getRange(2, 1, 1, 8).setValues([[
      'PRO-KEY-2025', 'PRO', 999999, 999999, 999999,
      new Date(2026, 11, 31), 'TRUE', new Date()
    ]]);
    sheet.getRange(3, 1, 1, 8).setValues([[
      'DEMO', 'DEMO', 5, 1, 10,
      new Date(2024, 11, 31), 'TRUE', new Date()
    ]]);
  }
  return sheet;
}

function getOrCreateDeviceSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(LICENSE_DEVICES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LICENSE_DEVICES_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['licenseKey', 'deviceId', 'registeredAt', 'lastSeen']]);
  }
  return sheet;
}

function getOrCreateSitesSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SITES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SITES_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['siteId', 'siteName', 'isActive', 'createdAt']]);
    sheet.getRange(2, 1, 1, 4).setValues([['SITE_A', '🏭 SITE A', 'TRUE', new Date()]]);
    sheet.getRange(3, 1, 1, 4).setValues([['SITE_B', '🏢 SITE B', 'TRUE', new Date()]]);
    sheet.getRange(4, 1, 1, 4).setValues([['SITE_C', '🏬 SITE C', 'TRUE', new Date()]]);
  }
  return sheet;
}

function getActiveSites_() {
  const sheet = getOrCreateSitesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [['SITE_A', '🏭 SITE A']];
  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const sites = [];
  for (let i = 0; i < data.length; i++) {
    const isActive = String(data[i][2] || 'TRUE').toUpperCase() === 'TRUE';
    if (isActive) sites.push([String(data[i][0] || ''), String(data[i][1] || '')]);
  }
  return sites;
}

function manageSite_(action, siteId, newSiteName) {
  const sheet = getOrCreateSitesSheet_();
  const lastRow = sheet.getLastRow();
  if (action === 'ADD') {
    if (lastRow >= 2) {
      const existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < existing.length; i++) {
        if (String(existing[i][0] || '') === siteId) return { ok: false, error: 'Site ID already exists' };
      }
    }
    const newRow = lastRow + 1;
    sheet.getRange(newRow, 1, 1, 4).setValues([[siteId, newSiteName, 'TRUE', new Date()]]);
    return { ok: true, message: 'Site added' };
  }
  if (action === 'RENAME') {
    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0] || '') === siteId) {
          sheet.getRange(i + 2, 2).setValue(newSiteName);
          return { ok: true, message: 'Site renamed' };
        }
      }
    }
    return { ok: false, error: 'Site not found' };
  }
  if (action === 'DELETE') {
    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0] || '') === siteId) {
          sheet.getRange(i + 2, 3).setValue('FALSE');
          return { ok: true, message: 'Site deleted' };
        }
      }
    }
    return { ok: false, error: 'Site not found' };
  }
  return { ok: false, error: 'Invalid action' };
}

function validateLicenseKey(licenseKey, deviceId) {
  if (!licenseKey) return { ok: false, reason: 'LICENSE_KEY_MISSING' };
  const sheet = getOrCreateLicenseSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { ok: true, package: 'DEMO', maxVisitors: 5, maxDevices: 1, maxScansPerDay: 10, expiredAt: null, isActive: true, fallback: true };
  }
  const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const storedKey = String(row[0] || '').trim();
    if (storedKey !== licenseKey) continue;
    const licensePackage = String(row[1] || 'DEMO').toUpperCase();
    const maxVisitors = Number(row[2] || 0);
    const maxDevices = Number(row[3] || 0);
    const maxScansPerDay = Number(row[4] || 0);
    const expiredAt = row[5] ? new Date(row[5]) : null;
    const isActive = String(row[6] || 'TRUE').toUpperCase() === 'TRUE';
    if (!isActive) return { ok: false, reason: 'LICENSE_INACTIVE' };
    if (expiredAt && expiredAt < new Date()) return { ok: false, reason: 'LICENSE_EXPIRED', expiredAt: expiredAt };
    const deviceCount = getDeviceCountForLicense(licenseKey);
    if (maxDevices > 0 && deviceCount >= maxDevices) {
      const isRegistered = isDeviceRegisteredForLicense(licenseKey, deviceId);
      if (!isRegistered) return { ok: false, reason: 'DEVICE_LIMIT_EXCEEDED', maxDevices: maxDevices };
    }
    if (deviceId) registerDeviceForLicense(licenseKey, deviceId);
    return { ok: true, package: licensePackage, maxVisitors: maxVisitors, maxDevices: maxDevices, maxScansPerDay: maxScansPerDay, expiredAt: expiredAt, isActive: isActive };
  }
  return { ok: false, reason: 'LICENSE_NOT_FOUND' };
}

function getDeviceCountForLicense(licenseKey) {
  const sheet = getOrCreateDeviceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || '') === licenseKey) count++;
  }
  return count;
}

function isDeviceRegisteredForLicense(licenseKey, deviceId) {
  if (!deviceId) return false;
  const sheet = getOrCreateDeviceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || '') === licenseKey && String(data[i][1] || '') === deviceId) return true;
  }
  return false;
}

function registerDeviceForLicense(licenseKey, deviceId) {
  if (!deviceId) return;
  if (isDeviceRegisteredForLicense(licenseKey, deviceId)) {
    const sheet = getOrCreateDeviceSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0] || '') === licenseKey && String(data[i][1] || '') === deviceId) {
          sheet.getRange(i + 2, 4, 1, 1).setValue([getWIBISO()]);
          return;
        }
      }
    }
  }
  const sheet = getOrCreateDeviceSheet_();
  const newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, 4).setValues([[licenseKey, deviceId, getWIBISO(), getWIBISO()]]);
}

// ============================================================
// DOGET - HANDLE LICENSE VALIDATION, SITES, AND PULL DATA
// FIX-3: pull endpoint — baca Status, Checkin, Checkout, version dari sheet
// ============================================================

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = params.action || '';
  const licenseKey = params.licenseKey || '';
  const deviceId = params.deviceId || '';
  const site = params.site || '';

  if (action === 'validateLicense') {
    const result = validateLicenseKey(licenseKey, deviceId);
    return jsonResponse_({
      ok: result.ok,
      reason: result.reason,
      package: result.package || 'DEMO',
      maxVisitors: result.maxVisitors || 5,
      maxDevices: result.maxDevices || 1,
      maxScansPerDay: result.maxScansPerDay || 10,
      expiredAt: result.expiredAt ? getWIBISO(result.expiredAt) : null,
      isActive: result.isActive || false
    });
  }

  if (action === 'getSites') {
    const sites = getActiveSites_();
    return jsonResponse_({ ok: true, sites: sites.map(function(s) { return { id: s[0], name: s[1] }; }) });
  }

  if (action === 'addSite') {
    const siteId = params.siteId || '';
    const siteName = params.siteName || '';
    if (!siteId || !siteName) return jsonResponse_({ ok: false, error: 'Missing siteId or siteName' });
    return jsonResponse_(manageSite_('ADD', siteId, siteName));
  }

  if (action === 'renameSite') {
    const siteId = params.siteId || '';
    const siteName = params.siteName || '';
    if (!siteId || !siteName) return jsonResponse_({ ok: false, error: 'Missing siteId or siteName' });
    return jsonResponse_(manageSite_('RENAME', siteId, siteName));
  }

  if (action === 'deleteSite') {
    const siteId = params.siteId || '';
    if (!siteId) return jsonResponse_({ ok: false, error: 'Missing siteId' });
    return jsonResponse_(manageSite_('DELETE', siteId, ''));
  }

  if (action === 'pull') {
    const licenseValid = validateLicenseKey(licenseKey, deviceId);
    if (!licenseValid.ok) return jsonResponse_({ ok: false, reason: licenseValid.reason, data: null });

    const ss = SpreadsheetApp.openById(SHEET_ID);
    // FIX-4: gunakan getOrCreateLogSheet_ agar sheet auto-create
    const logSheet = getOrCreateLogSheet_();
    let visitors = {};
    let logs = [];

    const lastRow = logSheet.getLastRow();
    if (lastRow >= 2) {
      const headerMap = getHeaderMap_(logSheet);
      // Kolom wajib — ambil nomor atau fallback ke posisi default
      const regCol = headerMap['REG'] || 9;
      const nameCol = headerMap['Nama'] || 1;
      const companyCol = headerMap['Perusahaan'] || 2;
      const kategoriCol = headerMap['Kategori'] || 15;
      const picCol = headerMap['PIC'] || 4;
      const deptCol = headerMap['Dept'] || 16;
      const startCol = headerMap['Start'] || 5;
      const expCol = headerMap['Exp'] || 6;
      const siteCol = headerMap['Site'] || 13;
      const actionCol = headerMap['Action'] || 10;
      const logTimeCol = headerMap['LogTime'] || 11;
      const tujuanCol = headerMap['Tujuan'] || 3;
      const keteranganCol = headerMap['Keterangan'] || 17;
      // FIX-3: tambah kolom Status, Checkin, Checkout untuk baca status aktual
      const statusCol = headerMap['Status'] || 12;
      const checkinCol = headerMap['Checkin'] || 7;
      const checkoutCol = headerMap['Checkout'] || 8;

      const maxReadCol = Math.max(regCol, nameCol, companyCol, kategoriCol, picCol, deptCol,
        startCol, expCol, siteCol, actionCol, logTimeCol, tujuanCol, keteranganCol,
        statusCol, checkinCol, checkoutCol);

      const data = logSheet.getRange(2, 1, lastRow - 1, maxReadCol).getValues();

      const visitorMap = {};

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const reg = String(row[regCol - 1] || '').trim();
        const rowSite = String(row[siteCol - 1] || 'SITE_A').trim();

        if (!reg) continue;
        if (site && rowSite !== site) continue;

        const key = rowSite + '_' + reg;
        const rowAction = normalizeAction(row[actionCol - 1]);
        const logTimeVal = row[logTimeCol - 1];
        const logTimeMs = logTimeVal ? parseEventTimestamp_(logTimeVal, 0) : 0;

        if (!visitorMap[key]) {
          visitorMap[key] = {
            reg: reg,
            nama: String(row[nameCol - 1] || ''),
            perusahaan: String(row[companyCol - 1] || ''),
            kategori: String(row[kategoriCol - 1] || 'UMUM'),
            pic: String(row[picCol - 1] || ''),
            dept: String(row[deptCol - 1] || ''),
            tujuan: String(row[tujuanCol - 1] || ''),
            keterangan: String(row[keteranganCol - 1] || ''),
            startDate: String(row[startCol - 1] || ''),
            expDate: String(row[expCol - 1] || ''),
            site: rowSite,
            // FIX-3: baca status aktual dari kolom Status
            currentStatus: String(row[statusCol - 1] || 'OUT').trim() || 'OUT',
            sessions: [],
            version: 1,
            updatedAt: logTimeMs || getEventTimestamp()
          };
        } else {
          // Update dengan baris terbaru (per-reg, kita ambil data terbaru)
          const existing = visitorMap[key];
          if (logTimeMs > (existing.updatedAt || 0)) {
            existing.currentStatus = String(row[statusCol - 1] || existing.currentStatus || 'OUT').trim() || 'OUT';
            existing.updatedAt = logTimeMs;
            // Update nama/perusahaan jika ada versi yang lebih lengkap
            if (row[nameCol - 1]) existing.nama = String(row[nameCol - 1]);
            if (row[companyCol - 1]) existing.perusahaan = String(row[companyCol - 1]);
          }
        }

        logs.push({
          reg: reg,
          name: String(row[nameCol - 1] || ''),
          company: String(row[companyCol - 1] || ''),
          category: String(row[kategoriCol - 1] || 'UMUM'),
          action: rowAction,
          time: logTimeMs || getEventTimestamp(),
          logTime: logTimeVal ? formatWIB(logTimeMs) : '',
          site: rowSite,
          // FIX: gunakan mutationId unik per baris
          mutationId: 'pull_' + reg + '_' + rowAction + '_' + i + '_' + logTimeMs
        });
      }

      visitors = visitorMap;
    }

    logs.sort(function(a, b) { return b.time - a.time; });
    logs = logs.slice(0, 500);

    return jsonResponse_({
      ok: true,
      data: { visitors: visitors, logs: logs },
      license: {
        package: licenseValid.package,
        maxVisitors: licenseValid.maxVisitors,
        maxScansPerDay: licenseValid.maxScansPerDay
      }
    });
  }

  // Default health check
  return jsonResponse_({
    ok: true,
    service: 'VMS_GAS_BRIDGE',
    status: 'healthy',
    sheetId: SHEET_ID,
    sites: getActiveSites_(),
    updatedAt: getWIBISO()
  });
}

// ============================================================
// DOPOST - HANDLE INCOMING SYNC DATA
// FIX-2: enrichLogs_ — log dari body.logs dilengkapi dengan data
//         dari body.visitors berdasarkan reg yang sama
// ============================================================

// FIX-2: Enrichment — ambil field yang hilang dari body.visitors
// Ini memastikan logEntry dari registerVisitor() mendapat tujuan, pic, dept, dll.
function enrichLogsFromVisitors_(logs, visitors) {
  if (!logs || !logs.length || !visitors) return logs;
  return logs.map(function(log) {
    const reg = String(log.reg || log.REG || '').trim();
    if (!reg) return log;
    // Cari visitor yang cocok dengan reg ini dari body.visitors
    var matchedVisitor = null;
    Object.keys(visitors).forEach(function(key) {
      const v = visitors[key] || {};
      const vReg = String(v.reg || '').trim();
      if (vReg === reg) matchedVisitor = v;
    });
    if (!matchedVisitor) return log;
    // Enrich: isi field yang kosong dari visitor data
    return Object.assign({}, {
      tujuan: matchedVisitor.tujuan || matchedVisitor.purpose || '',
      purpose: matchedVisitor.tujuan || matchedVisitor.purpose || '',
      pic: matchedVisitor.pic || matchedVisitor.PIC || '',
      dept: matchedVisitor.dept || matchedVisitor.Departemen || matchedVisitor.department || '',
      kategori: matchedVisitor.kategori || matchedVisitor.category || '',
      category: matchedVisitor.category || matchedVisitor.kategori || '',
      keterangan: matchedVisitor.keterangan || matchedVisitor.notes || '',
      startDate: matchedVisitor.startDate || matchedVisitor.start || '',
      start: matchedVisitor.startDate || matchedVisitor.start || '',
      expDate: matchedVisitor.expDate || matchedVisitor.exp || '',
      exp: matchedVisitor.expDate || matchedVisitor.exp || '',
      site: matchedVisitor.site || log.site || '',
      nama: matchedVisitor.nama || matchedVisitor.name || log.nama || log.name || '',
      name: matchedVisitor.name || matchedVisitor.nama || log.name || log.nama || '',
      perusahaan: matchedVisitor.perusahaan || matchedVisitor.company || log.perusahaan || log.company || '',
      company: matchedVisitor.company || matchedVisitor.perusahaan || log.company || log.perusahaan || ''
    }, log); // log menang jika punya nilai sendiri (Object.assign: rightmost wins)
  });
}

function doPost(e) {
  try {
    Logger.log('=== DO POST START ===');
    const rawBody = (e && e.postData && e.postData.contents) || '{}';
    Logger.log('Raw body: ' + rawBody.slice(0, 500));
    let body = {};
    try {
      body = JSON.parse(rawBody || '{}');
    } catch (parseErr) {
      structuredLog_('INVALID_JSON_PAYLOAD', { mutationId: '', mutationSource: 'unknown', reason: parseErr && parseErr.message || String(parseErr) });
      return jsonResponse_({ ok: false, ack: false, mutationIds: [], skippedMutationIds: [], ackMutationIds: [], error: 'INVALID_JSON_PAYLOAD', updatedAt: getWIBISO() });
    }

    Logger.log('AFTER_PARSE action: ' + (body.action || 'none'));
    console.log("SYNC BODY:", JSON.stringify(body).slice(0, 1000));

    // TEMP BYPASS SIGNATURE
    const auth = { ok: true };

    const rawLogs = Array.isArray(body.logs) ? body.logs : [];
    const bodyVisitors = body && body.visitors && typeof body.visitors === 'object' ? body.visitors : {};

    // FIX-2: Enrich log entries dengan data dari body.visitors sebelum diproses
    const logs = enrichLogsFromVisitors_(rawLogs, bodyVisitors);

    const visitorLogs = Object.keys(bodyVisitors).length > 0 ? buildVisitorSnapshotLogs_(bodyVisitors) : [];

    // FIX-5: processLogs_ sekarang skip expiry check untuk REGISTER/WALK_IN
    if (logs.length > 0) processLogs_(logs, body);

    // Filter expired untuk visitorLogs (check-in/check-out snapshots)
    const checkedVisitorLogs = visitorLogs.filter(function(log) {
      const action = normalizeAction(log.action);
      // Jangan blokir REGISTER/WALK_IN dari visitor snapshot
      if (action === ACTION_TYPES.REGISTER || action === ACTION_TYPES.WALK_IN) return true;
      const expDate = log.exp || log.expDate || '';
      if (expDate && isExpired_(expDate)) {
        log._expiredBlocked = true;
        structuredLog_('VISITOR_SNAPSHOT_EXPIRED_BLOCKED', { mutationId: log.mutationId || '', reg: log.reg || '', expDate: String(expDate) });
        return false;
      }
      return true;
    });

    const normalized = [];

    // Kumpulkan mutationIds dari logs agar tidak duplikasi dengan visitorLogs
    const logMutationIdSet = new Set();
    logs.forEach(function(log) {
      if (log && log.mutationId) logMutationIdSet.add(String(log.mutationId));
    });

    logs.concat(checkedVisitorLogs).forEach(function(log, index) {
      if (log && log._expiredBlocked) return;
      try {
        const mapped = normalizeMutation_(Object.assign({}, log, { action: normalizeAction(log && log.action) }), index);
        if (!mapped.reg || !mapped.mutationId) {
          structuredLog_('GAS_LOG_MAPPING_ERROR', { mutationId: mapped.mutationId || '', mutationSource: mapped.mutationSource || 'gas', reg: mapped.reg || '', action: mapped.action || '', index: index, reason: 'reg_or_mutationId_missing' });
          return;
        }
        if (mapped.action === ACTION_TYPES.CHECK_IN || mapped.action === ACTION_TYPES.CHECK_OUT || mapped.action === ACTION_TYPES.REGISTER || mapped.action === ACTION_TYPES.WALK_IN) {
          normalized.push(mapped);
        } else {
          structuredLog_('GAS_LOG_MAPPING_SKIPPED', { mutationId: mapped.mutationId || '', mutationSource: mapped.mutationSource || 'gas', reg: mapped.reg || '', action: mapped.action || '', index: index });
        }
      } catch (mapErr) {
        structuredLog_('GAS_LOG_MAPPING_ERROR', { mutationId: log && log.mutationId || '', mutationSource: log && (log.mutationSource || log.deviceId) || 'gas', index: index, reason: mapErr && mapErr.message || String(mapErr) });
      }
    });

    if (normalized.length) {
      Logger.log('BEFORE_APPEND count: ' + normalized.length);
      Logger.log(JSON.stringify(normalized[0]).slice(0, 500));
    }

    const result = appendRowsIdempotent_(normalized);
    Logger.log('AFTER_APPEND: appended=' + result.rowsAppended + ' updated=' + result.rowsUpdated);

    const ackIds = result.mutationIds.concat(result.skippedMutationIds);
    const response = {
      ok: true,
      ack: true,
      rowsAppended: result.rowsAppended,
      rowsUpdated: result.rowsUpdated || 0,
      mutationIds: result.mutationIds,
      skippedMutationIds: result.skippedMutationIds,
      staleMutationIds: result.staleMutationIds || [],
      staleCount: result.staleCount || 0,
      versionRejectedMutationIds: result.versionRejectedMutationIds || [],
      versionRejectedCount: result.versionRejectedCount || 0,
      ackMutationIds: ackIds,
      requestFingerprints: result.requestFingerprints || [],
      ackCount: ackIds.length,
      updatedAt: getWIBISO()
    };

    Logger.log('RETURN_ACK: ' + JSON.stringify(response).slice(0, 300));
    return jsonResponse_(response);

  } catch (err) {
    console.error(JSON.stringify({ type: 'GAS_APPEND_FAIL', reason: err && err.message || String(err), updatedAt: getWIBISO() }));
    return jsonResponse_({ ok: false, ack: false, mutationIds: [], skippedMutationIds: [], staleMutationIds: [], staleCount: 0, versionRejectedMutationIds: [], versionRejectedCount: 0, ackMutationIds: [], error: err && err.message || String(err), updatedAt: getWIBISO() });
  }
}
