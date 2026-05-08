/**
 * VMS Append-Only Gateway for Google Apps Script
 * Architecture: frontend -> worker.js -> GAS -> Google Spreadsheet
 */

const SHEET_ID = '1ohvC84wtT4EP-rcrDbWZ1tKKMIWGjvxSu_JTTDIfvkA';
const SHEET_NAME = 'Log';

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
 * Strict append-only gateway: every accepted event appends one new row.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const parsed = parseAndValidatePayload_(e);
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ensureTargetSheetAndHeader_(spreadsheet);

    validateExpiredVisitor_(parsed.basePayload);

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
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {
      // no-op
    }
  }
}

function parseAndValidatePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw createHttpError_(400, 'Request body kosong atau tidak valid.');
  }

  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (_) {
    throw createHttpError_(400, 'Body harus JSON valid.');
  }

  const hasLogsArray = payload && Object.prototype.hasOwnProperty.call(payload, 'logs');

  if (hasLogsArray) {
    if (!Array.isArray(payload.logs) || payload.logs.length === 0) {
      throw createHttpError_(400, 'Field logs harus array dan tidak boleh kosong.');
    }

    const normalizedLogs = payload.logs.map(function (item) {
      const log = normalizeWorkerLog_(item, payload);
      validateRequiredFields_(log, ['nama', 'perusahaan', 'tujuan', 'pic', 'start', 'exp', 'reg', 'action', 'site']);
      log.action = normalizeAction_(log.action);
      log.status = log.status ? String(log.status) : log.action;
      return log;
    });

    return {
      basePayload: normalizedLogs[0],
      logs: normalizedLogs
    };
  }

  const legacyPayload = payload || {};
  validateRequiredFields_(legacyPayload, ['nama', 'perusahaan', 'tujuan', 'pic', 'start', 'exp', 'reg', 'action', 'site']);

  legacyPayload.action = normalizeAction_(legacyPayload.action);
  legacyPayload.status = legacyPayload.status ? String(legacyPayload.status) : legacyPayload.action;

  return {
    basePayload: legacyPayload,
    logs: [legacyPayload]
  };
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
  const normalized = String(action || '').trim().toUpperCase();
  if (normalized !== 'CHECK-IN' && normalized !== 'CHECK-OUT') {
    throw createHttpError_(400, 'action harus CHECK-IN atau CHECK-OUT.');
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
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }

  return sheet;
}

function validateExpiredVisitor_(payload) {
  const expDate = toDateOrNull_(payload.exp);
  if (!expDate) {
    throw createHttpError_(400, 'Field exp tidak dapat diparsing sebagai tanggal.');
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
  const action = payload.action;
  const checkin = action === 'CHECK-IN' ? logTime.toISOString() : '';
  const checkout = action === 'CHECK-OUT' ? logTime.toISOString() : '';

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
    throw createHttpError_(400, 'Tidak ada data log untuk di-append.');
  }

  if (rowsValues.length === 1) {
    const onlyRow = appendRowSafely_(sheet, rowsValues[0]);
    return { firstRow: onlyRow, count: 1 };
  }

  const nextRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(nextRow, 1, rowsValues.length, HEADERS.length).setValues(rowsValues);
  SpreadsheetApp.flush();

  return { firstRow: nextRow, count: rowsValues.length };
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
  return ContentService
    .createTextOutput(JSON.stringify({ status: status, data: payload }))
    .setMimeType(ContentService.MimeType.JSON);
}
