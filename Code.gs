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

    const payload = parseAndValidatePayload_(e);
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ensureTargetSheetAndHeader_(spreadsheet);

    validateExpiredVisitor_(payload);

    const now = new Date();
    const logTime = payload.logTime ? toDateOrNull_(payload.logTime) : now;

    const row = buildAppendRow_(payload, logTime);
    const appendedRow = appendRowSafely_(sheet, row);

    return jsonResponse_(200, {
      ok: true,
      message: 'APPEND_OK',
      sheet: sheet.getName(),
      rowNumber: appendedRow,
      reg: payload.reg,
      action: payload.action,
      logTime: logTime.toISOString()
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

  const required = ['nama', 'perusahaan', 'tujuan', 'pic', 'start', 'exp', 'reg', 'action', 'site'];
  required.forEach(function (key) {
    if (payload[key] === undefined || payload[key] === null || String(payload[key]).trim() === '') {
      throw createHttpError_(400, 'Field wajib kosong: ' + key);
    }
  });

  const action = String(payload.action).trim().toUpperCase();
  if (action !== 'CHECK-IN' && action !== 'CHECK-OUT') {
    throw createHttpError_(400, 'action harus CHECK-IN atau CHECK-OUT.');
  }

  payload.action = action;
  payload.status = payload.status ? String(payload.status) : action;
  return payload;
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
