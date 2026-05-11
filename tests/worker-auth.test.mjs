import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGoogleScriptPayload, extractAuthToken, getLicenseStorageKey, normalizeAction } from '../worker.js';

test('extractAuthToken prefers x-token when present', () => {
  const headers = new Headers({
    'x-token': ' direct-token ',
    authorization: 'Bearer bearer-token'
  });

  assert.equal(extractAuthToken(headers), 'direct-token');
});

test('extractAuthToken accepts Bearer scheme case-insensitively', () => {
  assert.equal(extractAuthToken(new Headers({ authorization: 'bearer abc123' })), 'abc123');
  assert.equal(extractAuthToken(new Headers({ authorization: 'BEARER xyz789' })), 'xyz789');
});

test('extractAuthToken accepts flexible whitespace after Bearer', () => {
  assert.equal(extractAuthToken(new Headers({ authorization: 'Bearer    spaced-token  ' })), 'spaced-token');
});

test('extractAuthToken rejects unsupported auth schemes', () => {
  assert.equal(extractAuthToken(new Headers({ authorization: 'Basic abc123' })), null);
});

test('normalizeAction keeps scanner and registration actions canonical', () => {
  assert.equal(normalizeAction('check-in'), 'CHECK_IN');
  assert.equal(normalizeAction('walk in cepat'), 'WALK_IN');
  assert.equal(normalizeAction('registration'), 'REGISTER');
});

test('getLicenseStorageKey is shared by license and ignores device identity', () => {
  assert.equal(getLicenseStorageKey('LIC-001'), 'VMS_DATA_LIC-001');
  assert.equal(getLicenseStorageKey('LIC-001'), getLicenseStorageKey('LIC-001'));
  assert.notEqual(getLicenseStorageKey('LIC-001'), getLicenseStorageKey('LIC-002'));
});

test('buildGoogleScriptPayload matches GAS append-only contract', () => {
  const payload = buildGoogleScriptPayload('append-only', {
    logs: [{
      reg: 'REG-1',
      action: 'check in',
      time: 1710000000000,
      deviceId: 'dev-a',
      mutationId: 'mut-1'
    }]
  });

  assert.equal(payload.source, 'vms-worker');
  assert.equal(payload.mode, 'append-only');
  assert.equal(payload.expectedCount, 1);
  assert.equal(payload.logs.length, 1);
  assert.equal(payload.logs[0].action, 'CHECK_IN');
  assert.equal(payload.logs[0].eventTs, 1710000000000);
  assert.equal(payload.logs[0].mutationId, 'mut-1');
  assert.ok(payload.logs[0].requestFingerprint.includes('mut-1'));
});
