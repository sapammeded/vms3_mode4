/**
 * VMS Append-Only Gateway for Google Apps Script
 * Architecture: frontend -> worker.js -> GAS -> Google Spreadsheet
 */

const SHEET_ID = '1ohvC84wtT4EP-rcrDbWZ1tKKMIWGjvxSu_JTTDIfvkA';
const SHEET_NAME = 'Log';
const GAS_VERSION = '1.0.13';

const HEADERS = [
  'Nama',
  'Perusahaan',
  'Tujuan',
  'PIC',
  'Start',
  'Exp',
  'Checkin',
  'Checkout',
  'REG',
  'Action',
  'LogTime',
  'Status',
  'Site',
  'Duration',
  'Kategori',
  'Dept',
  'Keterangan'
];

/**
 * HTTP POST entrypoint.
 * Compatibility gateway: supports legacy, append-only, and visitor-snapshot payloads.
 */
function doPost(e) {
  try {
    const parsed = parseAndValidatePayload_(e);
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ensureTargetSheetAndHeader_(spreadsheet);

    if (parsed.validateExpiry !== false) {
      validateExpiredVisitor_(parsed.basePayload);
    }

    const now = new Date();
    const rows = parsed.logs.map(function (log) {
      const logTime = log.logTime ? toDateOrNull_(log.logTime) : now;
      if (!logTime) {
        throw createHttpError_(400, 'Field logTime/time tidak dapat diparsing sebagai tanggal.');
      }
      return buildAppendRow_(log, logTime);
    });

    const appendResult = appendRowsSafely_(sheet, rows);
    const firstLog = parsed.logs[0] || {};
    const firstLogTime = firstLog.logTime ? toDateOrNull_(firstLog.logTime) : now;

    return jsonResponse_(200, {
      ok: true,
      message: 'APPEND_OK',
      sheet: sheet.getName(),
      rowNumber: appendResult.firstRow,
      reg: firstLog.reg || parsed.basePayload.reg,
      action: firstLog.action || parsed.basePayload.action,
      logTime: firstLogTime ? firstLogTime.toISOString() : now.toISOString(),
      rowsAppended: appendResult.count
    });
  } catch (err) {
    return handleError_(err);
  }
}

function parseAndValidatePayload_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (_) {
    throw createHttpError_(400, 'Body harus JSON valid.');
  }

  payload = clonePayload_(payload || {});
  const mode = String(payload.mode || '').trim().toLowerCase();

  if (mode === 'visitor-snapshot') {
    const visitors = payload.visitors && typeof payload.visitors === 'object' ? payload.visitors : {};
    const visitorLogs = Object.keys(visitors).map(function (key) {
      return normalizeVisitorSnapshot_(key, visitors[key], payload);
    }).filter(function (log) {
      return String(log.reg || '').trim() !== '';
    });

    return {
      basePayload: visitorLogs[0] || {},
      logs: visitorLogs,
      validateExpiry: false
    };
  }

  if (mode === 'append-only' || Object.prototype.hasOwnProperty.call(payload, 'logs')) {
    const sourceLogs = Array.isArray(payload.logs) ? payload.logs : [];
    const normalizedLogs = sourceLogs.map(function (item) {
      const log = normalizeWorkerLog_(item, payload);
      log.action = normalizeAction_(log.action);
      log.status = log.status ? String(log.status) : log.action;
      return log;
    }).filter(function (log) {
      return String(log.reg || '').trim() !== '' && String(log.action || '').trim() !== '';
    });

    return {
      basePayload: normalizedLogs[0] || {},
      logs: normalizedLogs,
      validateExpiry: normalizedLogs.length > 0
    };
  }

  const legacyPayload = normalizeWorkerLog_(payload || {}, payload || {});
  if (!String(legacyPayload.reg || '').trim() && !String(legacyPayload.action || '').trim()) {
    return {
      basePayload: {},
      logs: [],
      validateExpiry: false
    };
  }
  legacyPayload.action = normalizeAction_(legacyPayload.action);
  legacyPayload.status = legacyPayload.status ? String(legacyPayload.status) : legacyPayload.action;

  return {
    basePayload: legacyPayload,
    logs: String(legacyPayload.reg || '').trim() ? [legacyPayload] : [],
    validateExpiry: true
  };
}

function normalizeVisitorSnapshot_(key, visitor, envelope) {
  const data = visitor || {};
  const root = envelope || {};
  const parts = String(key || '').split('_');
  const siteFromKey = parts.length > 1 ? parts[0] : '';
  const regFromKey = parts.length > 1 ? parts.slice(1).join('_') : key;

  return {
    nama: firstNonEmpty_(data.nama, data.name, root.nama, ''),
    perusahaan: firstNonEmpty_(data.perusahaan, data.company, root.perusahaan, ''),
    tujuan: firstNonEmpty_(data.tujuan, data.purpose, root.tujuan, ''),
    pic: firstNonEmpty_(data.pic, root.pic, ''),
    start: firstNonEmpty_(data.start, data.startDate, root.start, ''),
    exp: firstNonEmpty_(data.exp, data.expDate, root.exp, ''),
    reg: firstNonEmpty_(data.reg, regFromKey, root.reg, ''),
    action: 'VISITOR-SNAPSHOT',
    site: firstNonEmpty_(data.site, root.site, siteFromKey, ''),
    logTime: new Date(Number(data.updatedAt || root.updatedAt || Date.now())).toISOString(),
    status: firstNonEmpty_(data.currentStatus, data.status, 'VISITOR-SNAPSHOT'),
    duration: '',
    kategori: firstNonEmpty_(data.kategori, data.category, root.kategori, ''),
    dept: firstNonEmpty_(data.dept, root.dept, ''),
    keterangan: firstNonEmpty_(data.keterangan, data.note, root.keterangan, ''),
    companyId: firstNonEmpty_(data.companyId, root.companyId, ''),
    licenseKey: firstNonEmpty_(data.licenseKey, root.licenseKey, ''),
    sequenceId: firstNonEmpty_(data.sequenceId, root.sequenceId, ''),
    deviceId: firstNonEmpty_(data.deviceId, root.deviceId, ''),
    persistedAt: firstNonEmpty_(data.persistedAt, data.updatedAt, root.updatedAt, '')
  };
}

function clonePayload_(payload) {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(payload);
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(payload || {}));
}

function normalizeWorkerLog_(logItem, envelope) {
  const log = logItem || {};
  const root = envelope || {};

  return {
    nama: firstNonEmpty_(log.nama, root.nama, log.visitorName, root.visitorName, ''),
    perusahaan: firstNonEmpty_(log.perusahaan, root.perusahaan, log.companyName, root.companyName, ''),
    tujuan: firstNonEmpty_(log.tujuan, root.tujuan, ''),
    pic: firstNonEmpty_(log.pic, root.pic, ''),
    start: firstNonEmpty_(log.start, root.start, ''),
    exp: firstNonEmpty_(log.exp, root.exp, ''),
    reg: firstNonEmpty_(log.reg, root.reg, ''),
    action: firstNonEmpty_(log.action, root.action, ''),
    site: firstNonEmpty_(log.site, root.site, ''),
    logTime: firstNonEmpty_(log.logTime, log.time, root.logTime, root.time, ''),
    status: firstNonEmpty_(log.status, root.status, ''),
    duration: firstNonEmpty_(log.duration, root.duration, ''),
    kategori: firstNonEmpty_(log.kategori, root.kategori, ''),
    dept: firstNonEmpty_(log.dept, root.dept, ''),
    keterangan: firstNonEmpty_(log.keterangan, root.keterangan, ''),
    companyId: firstNonEmpty_(log.companyId, root.companyId, ''),
    licenseKey: firstNonEmpty_(log.licenseKey, root.licenseKey, ''),
    sequenceId: firstNonEmpty_(log.sequenceId, root.sequenceId, ''),
    deviceId: firstNonEmpty_(log.deviceId, root.deviceId, ''),
    persistedAt: firstNonEmpty_(log.persistedAt, root.persistedAt, '')
  };
}

function firstNonEmpty_() {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    return value;
  }
  return '';
}

function validateRequiredFields_(payload, required) {
  required.forEach(function (key) {
    if (payload[key] === undefined || payload[key] === null || String(payload[key]).trim() === '') {
      throw createHttpError_(400, 'Field wajib kosong: ' + key);
    }
  });
}

function normalizeAction_(action) {
  const normalized = String(action || '').trim().toUpperCase().replace(/_/g, '-');
  if (normalized === 'VISITOR-SNAPSHOT') {
    return normalized;
  }
  if (normalized !== 'CHECK-IN' && normalized !== 'CHECK-OUT') {
    throw createHttpError_(400, 'action harus CHECK-IN, CHECK-OUT, atau VISITOR-SNAPSHOT.');
  }
  return normalized;
}

function ensureTargetSheetAndHeader_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < HEADERS.length) {
    sheet.insertColumnsAfter(maxColumns, HEADERS.length - maxColumns);
  }

  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const isEmpty = firstRow.every(function (v) { return String(v).trim() === ''; });

  if (isEmpty) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return sheet;
  }

  const isHeaderDifferent = HEADERS.some(function (header, idx) {
    return String(firstRow[idx] || '').trim() !== header;
  });

  if (isHeaderDifferent) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }

  return sheet;
}

function validateExpiredVisitor_(payload) {
  if (!payload || !payload.exp) {
    return;
  }
  const expDate = toDateOrNull_(payload.exp);
  if (!expDate) {
    return;
  }

  const now = new Date();
  if (expDate.getTime() < now.getTime()) {
    throw createHttpError_(400, 'BADGE VISITOR SUDAH EXPIRED. Silakan lakukan registrasi ulang.');
  }
}

function toDateOrNull_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function buildAppendRow_(payload, logTime) {
  const normalizedAction = String(payload.action || '')
    .replace(/_/g, '-')
    .toUpperCase();

  const action = normalizedAction;

  const checkin =
    action === 'CHECK-IN'
      ? logTime.toISOString()
      : '';

  const checkout =
    action === 'CHECK-OUT'
      ? logTime.toISOString()
      : '';

  return [
    String(payload.nama || ''),
    String(payload.perusahaan || ''),
    String(payload.tujuan || ''),
    String(payload.pic || ''),
    String(payload.start || ''),
    String(payload.exp || ''),
    checkin,
    checkout,
    String(payload.reg || ''),
    action,
    logTime.toISOString(),
    String(payload.status || action),
    String(payload.site || ''),
    String(payload.duration || ''),
    String(payload.kategori || ''),
    String(payload.dept || ''),
    String(payload.keterangan || '')
  ];
}

function appendRowsSafely_(sheet, rowsValues) {
  if (!rowsValues || rowsValues.length === 0) {
    return { firstRow: 0, count: 0 };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    if (rowsValues.length === 1) {
      const onlyRow = appendRowSafely_(sheet, rowsValues[0]);
      return { firstRow: onlyRow, count: 1 };
    }

    const nextRow = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(nextRow, 1, rowsValues.length, HEADERS.length).setValues(rowsValues);
    SpreadsheetApp.flush();

    return { firstRow: nextRow, count: rowsValues.length };
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {
      // no-op
    }
  }
}

function appendRowSafely_(sheet, rowValues) {
  const nextRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(nextRow, 1, 1, HEADERS.length).setValues([rowValues]);
  SpreadsheetApp.flush();
  return nextRow;
}

function createHttpError_(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

function handleError_(err) {
  const status = err && err.httpStatus ? err.httpStatus : 500;
  const message = err && err.message ? err.message : 'Internal server error.';

  return jsonResponse_(status, {
    ok: false,
    status: status,
    error: message
  });
}

function jsonResponse_(status, payload) {
  const result = {
    ok: payload && Object.prototype.hasOwnProperty.call(payload, 'ok') ? payload.ok : status < 400,
    status: status,
    version: GAS_VERSION,
    updatedAt: Date.now(),
    data: payload || {}
  };

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
