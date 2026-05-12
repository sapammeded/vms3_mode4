import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { buildCanonicalLogKey, buildGoogleScriptPayload, extractAuthToken, getLicenseStorageKey, normalizeAction } from '../worker.js';

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

test('getLicenseStorageKey is scoped only by license key', () => {
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
  assert.equal(payload.logs[0].time, new Date(1710000000000).toISOString());
  assert.equal(payload.logs[0].mutationId, 'mut-1');
  assert.ok(payload.logs[0].requestFingerprint.includes('mut-1'));
});


test('buildCanonicalLogKey preserves numeric millisecond timestamps for dedupe', () => {
  assert.equal(
    buildCanonicalLogKey({ reg: 'REG-1', action: 'CHECK_IN', time: 1710000000000, site: 'SITE_A' }),
    'REG-1|CHECK_IN|1710000000|SITE_A'
  );
  assert.equal(
    buildCanonicalLogKey({ reg: 'REG-1', action: 'CHECK_IN', time: '1710000000000', site: 'SITE_A' }),
    'REG-1|CHECK_IN|1710000000|SITE_A'
  );
});


class MemoryKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value) {
    this.store.set(key, String(value));
  }
}

test('pull returns license-wide visitors even when a device passes a site log filter and high since cursor', async () => {
  const licenseKey = 'LIC-SHARED';
  const now = Date.now();
  const env = {
    VMS_STORAGE: new MemoryKV({
      admins: [{ username: 'admin', token: 'token', lastLogin: now }],
      companies: [{ id: 'company-1', licenseKey, companyName: 'Shared Co', package: 'PRO', expiredAt: now + 86400000 }],
      [`visitors_manifest_${licenseKey}`]: [
        { key: `visitors_${licenseKey}_SITE_A_s00`, site: 'SITE_A', updatedAt: now },
        { key: `visitors_${licenseKey}_SITE_B_s00`, site: 'SITE_B', updatedAt: now }
      ],
      [`visitors_${licenseKey}_SITE_A_s00`]: {
        'SITE_A_REG-1': { reg: 'REG-1', nama: 'Visitor A', site: 'SITE_A', licenseKey, updatedAt: now, version: 1 }
      },
      [`visitors_${licenseKey}_SITE_B_s00`]: {
        'SITE_B_REG-2': { reg: 'REG-2', nama: 'Visitor B', site: 'SITE_B', licenseKey, updatedAt: now, version: 1 }
      }
    })
  };

  const res = await worker.fetch(new Request(`https://example.test/pull?licenseKey=${licenseKey}&since=${now + 60000}&site=SITE_B`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.visitors['SITE_A_REG-1'].nama, 'Visitor A');
  assert.equal(body.visitors['SITE_B_REG-2'].nama, 'Visitor B');
});
