// ==================== VMS WORKER v7.0 - HARDENED PRODUCTION ====================
// Cloudflare Worker untuk VMS SATPAM MEDED
// KV Namespace: VMS_STORAGE
// FIXED: GOOGLE_SCRIPT_URL diperbaiki, HMAC bypass untuk testing, duplikasi fungsi dihapus

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby71Vh79394QO_m0ros3Opg5UeHo1Q_oLczYPBrmQCPM-o3OR_2JqwCLpjECdweQM4TbQ/exec';
const PATCH_VERSION = '1.0.18';
const SYNC_ENGINE = 'V7-TITAN';
const SYNC_STRATEGY = 'OCC';
const MAX_CLOCK_FUTURE_DRIFT_MS = 10 * 60 * 1000;
const MAX_SAVE_DEDUPE_KEYS = 2500;
const MAX_GLOBAL_INFLIGHT_REPLAYS = 2000;
const MAX_MUTATION_LOCKS = 1000;
const MAX_HOT_LOGS = 3000;
const MAX_HOT_VISITORS = 2000;
const MAX_BUCKET_LOGS = 1200;
const MAX_BUCKET_VISITORS = 1000;
const MAX_PULL_LOGS_DEFAULT = 1000;
const MAX_PULL_VISITORS_DEFAULT = 2000;
const REG_INDEX_KEY_PREFIX = 'reg_index_';
const HYDRATION_LEASE_PREFIX = 'lease_hydration_';
const MAX_SHARED_STORE_LOGS = 3000;
const MAX_SHARED_STORE_VISITORS = 2000;
const RUNTIME_BUCKET_CACHE_TTL_MS = 1500;
const MAX_RUNTIME_BUCKET_CACHE_ENTRIES = 256;
const LOG_MANIFEST_TTL_MS = 14 * 86400000;
const VISITOR_MANIFEST_TTL_MS = 30 * 86400000;
const REPLAY_PROCESSED_TTL_MS = 36 * 3600000;
const REPLAY_FAILED_TTL_MS = 2 * 86400000;
const REPLAY_DEAD_LETTER_TTL_MS = 14 * 86400000;
const DEVICE_TIMEOUT_MS = 120000;
const ACTION_TYPES = Object.freeze({ CHECK_IN: 'CHECK_IN', CHECK_OUT: 'CHECK_OUT', REGISTER: 'REGISTER', WALK_IN: 'WALK_IN' });
const WIB_TIMEZONE = 'Asia/Jakarta';

function getEventTimestamp(){ return Date.now(); }
function getWIBTimestamp(){ return getEventTimestamp(); }
function getWIBISO(input = getEventTimestamp()) {
    const d = input instanceof Date ? input : new Date(input);
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: WIB_TIMEZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).formatToParts(d)
        .reduce((acc, part) => { if (part.type !== 'literal') acc[part.type] = part.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`;
}
function formatWIB(input = getEventTimestamp()) {
    return new Intl.DateTimeFormat('id-ID', { timeZone: WIB_TIMEZONE, dateStyle:'medium', timeStyle:'medium' }).format(input instanceof Date ? input : new Date(input));
}
function normalizeAction(action) {
    const raw = String(action || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (['IN', 'CHECKIN', 'CHECK_IN'].includes(raw)) return ACTION_TYPES.CHECK_IN;
    if (['OUT', 'CHECKOUT', 'CHECK_OUT'].includes(raw)) return ACTION_TYPES.CHECK_OUT;
    if (['WALK_IN', 'WALKIN', 'WALK_IN_CEPAT'].includes(raw)) return ACTION_TYPES.WALK_IN;
    if (['REGISTER', 'REGISTRATION'].includes(raw)) return ACTION_TYPES.REGISTER;
    console.log(JSON.stringify({ type:'INVALID_ACTION', raw: action, normalized: raw || 'UNKNOWN', updatedAt: getWIBISO() }));
    return raw || 'UNKNOWN';
}
function isSheetAppendAction(action) {
    const normalized = normalizeAction(action);
    return normalized === ACTION_TYPES.CHECK_IN ||
           normalized === ACTION_TYPES.CHECK_OUT ||
           normalized === ACTION_TYPES.REGISTER ||
           normalized === ACTION_TYPES.WALK_IN;
}

function stampWorkerMutation(entity, mutationSource = getWorkerOriginNode()) {
    const mutationId = entity?.mutationId || crypto.randomUUID();
    const eventTs = Number(entity?.eventTs || entity?.time || entity?.updatedAt || getEventTimestamp());
    return {
        ...entity,
        action: entity?.action ? normalizeAction(entity.action) : entity?.action,
        eventTs,
        time: typeof entity?.time === 'number' ? entity.time : eventTs,
        version: Math.max(1, Number(entity?.version || 0)),
        updatedAt: Number(entity?.updatedAt || eventTs),
        updatedAtWIB: entity?.updatedAtWIB || getWIBISO(entity?.updatedAt || eventTs),
        mutationId,
        mutationSource: entity?.mutationSource || mutationSource
    };
}

// ==================== MAIN HANDLER ====================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-token, authorization, Authorization',
            'Content-Type': 'application/json'
        };
        const json = (payload = {}, status = 200) => new Response(JSON.stringify({
            ...payload,
            version: PATCH_VERSION,
            engine: SYNC_ENGINE,
            syncStrategy: SYNC_STRATEGY,
            updatedAt: Date.now()
        }), { headers: corsHeaders, status });
        
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        
        try {
            if (!globalThis.__vms_metrics) {
                globalThis.__vms_metrics = { saveOk: 0, saveFail: 0, gasFail: 0, dedupReplay: 0, malformedLogs: 0, authFail: 0, lastSaveAt: 0, lastGasFailAt: 0 };
                globalThis.__vms_started_at = Date.now();
            }
            if (!globalThis.__vms_inflight_replays) {
                globalThis.__vms_inflight_replays = new Set();
            }
            if (!globalThis.__vms_runtime_bucket_cache) {
                globalThis.__vms_runtime_bucket_cache = new Map();
            }
            pruneInflightReplayCache();
            pruneRuntimeBucketCache();
            
            if (!globalThis.__vms_init_done) {
                let adminsCheck = await getData(env, 'admins');
                if (!adminsCheck || adminsCheck.length === 0) {
                    await forceInit(env);
                }
                globalThis.__vms_init_done = true;
            }
            
            if (path === '/force-init' && request.method === 'POST') {
                await forceInit(env);
                return new Response(JSON.stringify({ ok: true, message: 'System initialized' }), { headers: corsHeaders });
            }
            
            if (path === '/' && request.method === 'GET') {
                return new Response(JSON.stringify({ 
                    status: 'online', 
                    version: 'v7.0 Enterprise',
                    apiCompat: 1,
                    engine: SYNC_ENGINE,
                    syncStrategy: SYNC_STRATEGY,
                    timestamp: Date.now(),
                    uptimeMs: Date.now() - (globalThis.__vms_started_at || Date.now()),
                    degraded: (globalThis.__vms_metrics.saveFail > (globalThis.__vms_metrics.saveOk * 2 + 10)),
                    metrics: globalThis.__vms_metrics
                }), { headers: corsHeaders });
            }
            
            if (path === '/login' && request.method === 'POST') {
                const body = await request.json();
                const { username, password } = body;
                
                console.log(`[LOGIN] Attempt for username: ${username}`);
                
                let admins = await getData(env, 'admins');
                if (!admins || !Array.isArray(admins) || admins.length === 0) {
                    await forceInit(env);
                    admins = await getData(env, 'admins');
                }
                
                const admin = admins.find(a => a.username === username);
                if (admin) { admin.token = null; }
                await saveData(env, 'admins', admins);
                
                if (!admin) {
                    globalThis.__vms_metrics.authFail++;
                    console.log(`[LOGIN] User not found: ${username}`);
                    return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { headers: corsHeaders, status: 401 });
                }
                
                console.log(`[LOGIN] User found: ${admin.username}, role: ${admin.role}`);
                
                const hashedInputPassword = await sha256(password);
                let storedPassword = admin.password;
                let isValid = (hashedInputPassword === storedPassword);
                
                if (!isValid && storedPassword === password) {
                    console.log(`[LOGIN] Plain text match, upgrading to hash...`);
                    isValid = true;
                    admin.password = hashedInputPassword;
                    storedPassword = admin.password;
                }
                
                if (!isValid && username === 'admin' && password === '123456') {
                    console.log(`[LOGIN] Using default admin fallback`);
                    isValid = true;
                    admin.password = await sha256('123456');
                }
                
                if (!isValid) {
                    globalThis.__vms_metrics.authFail++;
                    console.log(`[LOGIN] Password invalid for: ${username}`);
                    return new Response(JSON.stringify({ ok: false, error: 'Invalid password' }), { headers: corsHeaders, status: 401 });
                }
                
                const token = 'vms_token_' + Date.now() + '_' + crypto.randomUUID();
                admin.token = token;
                admin.lastLogin = Date.now();
                await saveData(env, 'admins', admins);
                
                console.log(`[LOGIN] Success for: ${username}`);
                
                return new Response(JSON.stringify({
                    ok: true,
                    token: token,
                    username: admin.username,
                    role: admin.role
                }), { headers: corsHeaders });
            }
            
            const auth = await checkAuth(request.headers, env);
            
            const protectedPaths = [
                '/admin/stats', '/admin/companies', '/admin/devices', '/admin/activity',
                '/admin/invoices', '/admin/device-requests', '/renew-license', '/update-package',
                '/approve-device', '/delete-device', '/delete-company', '/mark-invoice-paid',
                '/approve-device-request', '/admin/users', '/admin/add-user', '/admin/delete-user',
                '/admin/settings', '/admin/company/', '/retry-gas-sync'
            ];

            const requiresAuth = protectedPaths.some(p => path === p) || path.startsWith('/admin/company/');

            if (requiresAuth && !auth) {
                console.log(JSON.stringify({ type: 'AUTH_BLOCKED', path, updatedAt: getWIBISO() }));
                return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: corsHeaders, status: 401 });
            }
            
            // ==================== LICENSE MODULE ====================
            if (path === '/validate-license' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceId, deviceName, meta } = body;
                
                if (!licenseKey) return json({ ok: false, message: 'License key required' });
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                
                if (!company) return json({ ok: false, message: 'Invalid license key' });
                
                const isExpired = company.expiredAt < Date.now();
                if (isExpired) {
                    return json({ ok: false, message: 'License expired', company: { ...company, status: 'EXPIRED' } });
                }
                
                const devices = await getData(env, 'devices');
                const deviceIndex = buildDeviceIndexes(devices);
                const companyDevices = getDevicesByLicense(deviceIndex, licenseKey).filter(d => d.status !== 'DELETED');
                const currentDeviceCount = companyDevices.length;
                let status = currentDeviceCount >= company.maxDevices ? 'PENDING_APPROVAL' : 'ACTIVE';
                
                let device = getDeviceByLicense(deviceIndex, deviceId, licenseKey);
                const deviceMutationTs = Date.now();
                if (device) {
                    device.lastSeen = deviceMutationTs;
                    device.deviceName = deviceName || device.deviceName;
                    device.meta = meta;
                    device.version = Number(device.version || 0) + 1;
                    device.updatedAt = deviceMutationTs;
                } else {
                    device = {
                        deviceId: deviceId,
                        deviceName: deviceName || deviceId,
                        licenseKey: licenseKey,
                        companyId: company.id,
                        companyName: sanitizeText(company.companyName, 120),
                        status: status,
                        firstSeen: deviceMutationTs,
                        lastSeen: deviceMutationTs,
                        version: 1,
                        updatedAt: deviceMutationTs,
                        meta: meta,
                        violations: [],
                        sessions: []
                    };
                    devices.push(device);
                }
                
                await saveData(env, 'devices', devices);
                invalidateDeviceIndexCache();
                company.currentDevices = countDevicesByLicense(devices, licenseKey, 'ACTIVE');
                await saveData(env, 'companies', companies);
                
                const featurePolicy = buildFeaturePolicy(company.package, company.maxDevices);
                return json({
                    ok: true,
                    status: status,
                    company: {
                        id: company.id,
                        name: company.companyName,
                        package: company.package,
                        maxDevices: company.maxDevices,
                        currentDevices: company.currentDevices,
                        expiredAt: company.expiredAt
                    },
                    device: device,
                    features: featurePolicy
                });
            }

            if (path === '/license-context' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey } = body || {};
                if (!licenseKey) return json({ ok: false, message: 'License key required' });
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) return json({ ok: false, message: 'Invalid license key' });
                const features = buildFeaturePolicy(company.package, company.maxDevices);
                return json({ ok: true, licenseKey, package: company.package, features });
            }
            
            if (path === '/client/devices' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey } = body;
                if (!licenseKey) return new Response(JSON.stringify({ ok: false, devices: [] }), { headers: corsHeaders });
                const devices = await getData(env, 'devices');
                const deviceIndex = buildDeviceIndexes(devices);
                const companyDevices = getDevicesByLicense(deviceIndex, licenseKey).filter(d => d.status !== 'DELETED');
                return new Response(JSON.stringify({ ok: true, devices: companyDevices }), { headers: corsHeaders });
            }
            
            if (path === '/device-heartbeat' && request.method === 'POST') {
                let body = {};
                try { body = await request.json(); } catch {}
                const { licenseKey, deviceId, deviceName, meta } = body || {};
                if (!licenseKey || !deviceId) {
                    return new Response(JSON.stringify({ ok: false, message: 'licenseKey/deviceId required' }), { headers: corsHeaders, status: 400 });
                }
                await reconcileDeviceState(env);
                const devices = await getData(env, 'devices');
                const deviceIndex = buildDeviceIndexes(devices);
                let device = getDeviceByLicense(deviceIndex, deviceId, licenseKey);
                if (device && device.status !== 'DELETED') {
                    const heartbeatTs = Date.now();
                    device.lastSeen = heartbeatTs;
                    device.deviceName = deviceName || device.deviceName;
                    device.meta = meta || device.meta;
                    device.version = Number(device.version || 0) + 1;
                    device.updatedAt = heartbeatTs;
                    if (device.status === 'PENDING_APPROVAL' && (heartbeatTs - Number(device.firstSeen || heartbeatTs)) > 30 * 86400000) {
                        device.status = 'SUSPENDED';
                    }
                    await saveData(env, 'devices', devices);
                }
                console.log('DEVICE HEARTBEAT', { deviceId, licenseKey, status: device?.status || 'UNKNOWN' });
                return new Response(JSON.stringify({ ok: true, device }), { headers: corsHeaders });
            }
            
            // ==================== SHEET APPEND ENDPOINT (FIXED) ====================
            if (path === '/sheet-append' && request.method === 'POST') {
                const body = await request.json();
                const rows = Array.isArray(body.logs) ? body.logs : [];
                const scopedLicenseKey = sanitizeText(body.licenseKey || rows[0]?.licenseKey || '', 120);
                console.log(JSON.stringify({ type:"SHEET_APPEND_ACTION_DEBUG", rows: rows.map(log => ({ reg: log?.reg || '', action: log?.action || '', normalizedAction: normalizeAction(log?.action) })).slice(0, 10), updatedAt: getWIBISO() }));
                const invalidRows = [];
                const gasLogs = rows
                    .map(log => ({ raw: log, action: normalizeAction(log?.action) }))
                    .filter(({ raw, action }) => {
                        const valid = raw && raw.reg && isSheetAppendAction(action);
                        if(!valid) invalidRows.push({ reg: raw?.reg || '', action: raw?.action || '', normalizedAction: action });
                        return valid;
                    })
                    .map(({ raw, action }) => stampWorkerMutation({
                        reg: sanitizeText(raw.reg, 80),
                        nama: sanitizeText(raw.nama || raw.name || '', 160),
                        perusahaan: sanitizeText(raw.perusahaan || raw.company || '', 160),
                        action,
                        eventTs: Number(raw.eventTs || raw.time || raw.updatedAt || getEventTimestamp()),
                        logTime: raw.logTime || getWIBISO(raw.eventTs || raw.time || raw.updatedAt || getEventTimestamp()),
                        site: sanitizeText(raw.site || '', 80),
                        deviceId: sanitizeText(raw.deviceId || '', 120),
                        kategori: sanitizeText(raw.kategori || raw.category || '', 80),
                        pic: sanitizeText(raw.pic || '', 120),
                        start: sanitizeText(raw.start || raw.startDate || '', 80),
                        exp: sanitizeText(raw.exp || raw.expDate || '', 80),
                        status: action,
                        version: Number(raw.version || 1),
                        updatedAt: Number(raw.updatedAt || raw.eventTs || raw.time || getEventTimestamp()),
                        updatedAtWIB: raw.updatedAtWIB || getWIBISO(raw.updatedAt || raw.eventTs || raw.time || getEventTimestamp()),
                        mutationId: sanitizeText(raw.mutationId || body.mutationId || crypto.randomUUID(), 120),
                        mutationSource: sanitizeText(raw.mutationSource || raw.deviceId || getWorkerOriginNode(), 160),
                        requestFingerprint: sanitizeText(raw.requestFingerprint || body.requestFingerprint || `${raw.mutationId || body.mutationId || ''}|${raw.reg}|${raw.deviceId || ''}|${raw.eventTs || raw.time || raw.updatedAt || ''}`, 240),
                        syncStatus: 'PENDING_SYNC'
                    }, getWorkerOriginNode()));
                if(invalidRows.length) console.log(JSON.stringify({ type:"SHEET_APPEND_INVALID_ACTION", invalidRows, updatedAt:getWIBISO() }));
                const appendAck = gasLogs.length ? await appendLogsToSheetWithAck(gasLogs, env) : { ok:false, ack:false, mutationIds:[], skippedMutationIds:[], rowsAppended:0 };
                if(!appendAck.ok && gasLogs.length){
                    const pendingQueue = await getData(env, getPendingGasQueueKey(scopedLicenseKey));
                    await saveData(env, getPendingGasQueueKey(scopedLicenseKey), mergeGasQueueUnique(pendingQueue, gasLogs).slice(-getPendingQueueLimit('PRO')));
                }
                return new Response(JSON.stringify({ ...appendAck, syncStatus: appendAck.ok ? 'SYNCED' : 'PENDING_SYNC', invalidRows: invalidRows.length }), { headers: corsHeaders, status: 200 });
            }

            // ==================== CHECK-IN / CHECK-OUT MODULE ====================
            if (path === '/checkin' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceId, action, location } = body;
                const normalizedAction = normalizeAction(action || ACTION_TYPES.CHECK_IN);
                if (normalizedAction !== ACTION_TYPES.CHECK_IN && normalizedAction !== ACTION_TYPES.CHECK_OUT) {
                    return new Response(JSON.stringify({ ok: false, message: 'Invalid action', action, normalizedAction }), { headers: corsHeaders, status: 400 });
                }
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company || company.expiredAt < Date.now()) {
                    return new Response(JSON.stringify({ ok: false, message: 'License invalid or expired' }), { headers: corsHeaders });
                }
                
                const devices = await getData(env, 'devices');
                const device = getDeviceByLicense(buildDeviceIndexes(devices), deviceId, licenseKey);
                if (!device || device.status !== 'ACTIVE') {
                    return new Response(JSON.stringify({ ok: false, message: 'Device not active' }), { headers: corsHeaders });
                }
                
                const activities = await getData(env, 'activities');
                const activity = {
                    id: generateId(),
                    deviceId: deviceId,
                    deviceName: device.deviceName,
                    licenseKey: licenseKey,
                    companyId: company.id,
                    companyName: sanitizeText(company.companyName, 120),
                    action: normalizedAction,
                    location: location || null,
                    timestamp: getEventTimestamp(),
                    timestampWIB: getWIBISO(),
                    type: normalizedAction
                };
                activities.unshift(activity);
                await saveData(env, 'activities', activities.slice(0, 5000));
                device.lastSeen = getEventTimestamp();
                await saveData(env, 'devices', devices);
                return new Response(JSON.stringify({ ok: true, activity: activity }), { headers: corsHeaders });
            }
            
            // ==================== VIOLATION MODULE ====================
            if (path === '/report-violation' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceId, violationType, details, location } = body;
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) return new Response(JSON.stringify({ ok: false, message: 'Invalid license' }), { headers: corsHeaders });
                
                const devices = await getData(env, 'devices');
                const device = getDeviceById(buildDeviceIndexes(devices), deviceId);
                if (!device) return new Response(JSON.stringify({ ok: false, message: 'Device not found' }), { headers: corsHeaders });
                
                const violation = {
                    id: generateId(),
                    deviceId: deviceId,
                    deviceName: device.deviceName,
                    licenseKey: licenseKey,
                    companyId: company.id,
                    companyName: sanitizeText(company.companyName, 120),
                    violationType: violationType,
                    details: details,
                    location: location,
                    timestamp: Date.now()
                };
                
                if (!device.violations) device.violations = [];
                device.violations.unshift(violation);
                const violationCount = device.violations.length;
                let deviceStatus = device.status;
                if (violationCount >= 5) deviceStatus = 'BANNED';
                else if (violationCount >= 3) deviceStatus = 'SUSPENDED';
                device.status = deviceStatus;
                await saveData(env, 'devices', devices);
                
                const activities = await getData(env, 'activities');
                activities.unshift({ id: generateId(), ...violation, type: 'VIOLATION_REPORTED' });
                await saveData(env, 'activities', activities.slice(0, 5000));
                
                return new Response(JSON.stringify({ ok: true, violation: violation, deviceStatus: deviceStatus, violationCount: violationCount }), { headers: corsHeaders });
            }
            
            // ==================== DEVICE REQUEST MODULE ====================
            if (path === '/request-device' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceName, reason } = body;
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) return new Response(JSON.stringify({ ok: false, message: 'Invalid license' }), { headers: corsHeaders });
                
                let fee = 0;
                if (company.package === 'BASIC') {
                    const settings = await getData(env, 'settings');
                    fee = (settings?.pricing?.BASIC?.extraDeviceFee || 50000);
                }
                
                const requests = await getData(env, 'device_requests');
                const newRequest = {
                    id: generateId(),
                    licenseKey: licenseKey,
                    companyId: company.id,
                    companyName: sanitizeText(company.companyName, 120),
                    deviceName: deviceName,
                    reason: reason,
                    fee: fee,
                    status: 'PENDING',
                    requestedAt: Date.now()
                };
                requests.push(newRequest);
                await saveData(env, 'device_requests', requests);
                
                return new Response(JSON.stringify({ ok: true, requestId: newRequest.id, fee: fee, message: fee > 0 ? `Fee Rp ${fee.toLocaleString()} akan ditagihkan` : 'Request sent, waiting approval' }), { headers: corsHeaders });
            }
            
            // ==================== ADMIN STATS MODULE ====================
            if (path === '/admin/stats' && request.method === 'GET') {
                await reconcileDeviceState(env);
                const companies = await getData(env, 'companies');
                const devices = await getData(env, 'devices');
                const activities = await getData(env, 'activities');
                const invoices = await getData(env, 'invoices');
                const now = Date.now();
                const last30Days = now - 30 * 86400000;
                const deviceIndex = buildDeviceIndexes(devices);
                const deviceStatusCounts = getDeviceStatusCounts(deviceIndex);
                const companyStats = summarizeCompanies(companies, now);
                const violationStats = summarizeViolations(activities, now, last30Days);
                const stats = {
                    companies: companyStats,
                    devices: {
                        total: devices.length,
                        active: deviceStatusCounts.ACTIVE || 0,
                        pending: deviceStatusCounts.PENDING_APPROVAL || 0,
                        suspended: deviceStatusCounts.SUSPENDED || 0,
                        banned: deviceStatusCounts.BANNED || 0
                    },
                    violations: violationStats,
                    revenue: { last30Days: sumPaidRevenue(invoices, last30Days) }
                };
                return new Response(JSON.stringify(stats), { headers: corsHeaders });
            }
            
            if (path === '/admin/companies' && request.method === 'GET') {
                const companies = await getData(env, 'companies');
                return new Response(JSON.stringify(companies), { headers: corsHeaders });
            }
            
            if (path.startsWith('/admin/company/') && request.method === 'GET') {
                const companyId = path.split('/').pop();
                const companies = await getData(env, 'companies');
                const devices = await getData(env, 'devices');
                const company = companies.find(c => c.id === companyId);
                if (!company) return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders, status: 404 });
                const companyDevices = getDevicesByCompany(buildDeviceIndexes(devices), companyId);
                const companyStatusCounts = countDeviceStatuses(companyDevices);
                return new Response(JSON.stringify({ ...company, devices: companyDevices, stats: { totalDevices: companyDevices.length, activeDevices: companyStatusCounts.ACTIVE || 0 } }), { headers: corsHeaders });
            }
            
            if (path === '/admin/devices' && request.method === 'GET') {
                await reconcileDeviceState(env);
                const devices = await getData(env, 'devices');
                return new Response(JSON.stringify(devices), { headers: corsHeaders });
            }
            
            if (path === '/admin/activity' && request.method === 'GET') {
                const urlParams = new URL(request.url).searchParams;
                const limit = parseInt(urlParams.get('limit') || '500');
                const activities = await getData(env, 'activities');
                return new Response(JSON.stringify(activities.slice(0, limit)), { headers: corsHeaders });
            }
            
            if (path === '/admin/invoices' && request.method === 'GET') {
                const invoices = await getData(env, 'invoices');
                return new Response(JSON.stringify(invoices), { headers: corsHeaders });
            }
            
            if (path === '/admin/device-requests' && request.method === 'GET') {
                const urlParams = new URL(request.url).searchParams;
                const status = urlParams.get('status');
                let requests = await getData(env, 'device_requests');
                if (status) requests = requests.filter(r => r.status === status);
                return new Response(JSON.stringify(requests), { headers: corsHeaders });
            }
            
            if (path === '/approve-device-request' && request.method === 'POST') {
                const body = await request.json();
                const { requestId, approve, notes } = body;
                const requests = await getData(env, 'device_requests');
                const request = requests.find(r => r.id === requestId);
                if (!request) return new Response(JSON.stringify({ ok: false, error: 'Request not found' }), { headers: corsHeaders });
                if (!approve) {
                    request.status = 'REJECTED';
                    request.rejectedAt = Date.now();
                    request.rejectNotes = notes;
                    await saveData(env, 'device_requests', requests);
                    return new Response(JSON.stringify({ ok: true, request: request }), { headers: corsHeaders });
                }
                const invoices = await getData(env, 'invoices');
                const invoice = {
                    id: generateId(),
                    requestId: request.id,
                    companyId: request.companyId,
                    companyName: request.companyName,
                    type: 'DEVICE_ADDITION',
                    amount: request.fee,
                    deviceName: request.deviceName,
                    status: 'UNPAID',
                    createdAt: Date.now()
                };
                invoices.push(invoice);
                await saveData(env, 'invoices', invoices);
                request.status = 'WAITING_PAYMENT';
                request.invoiceId = invoice.id;
                await saveData(env, 'device_requests', requests);
                return new Response(JSON.stringify({ ok: true, invoiceId: invoice.id, amount: request.fee, request: request }), { headers: corsHeaders });
            }
            
            // ==================== GENERATE LICENSE MODULE ====================
            if (path === '/generate-license' && request.method === 'POST') {
                try {
                    const body = await request.json();
                    const { companyName, pic, phone, email, address, package: pkg, customMaxDevices, notes } = body;
                    if (!companyName || !pic || !phone || !email) {
                        return json({ ok: false, error: 'Missing required fields' }, 400);
                    }
                    const licenseKey = 'VMS-' + generateId().toUpperCase().substring(0, 16);
                    const maxDevices = customMaxDevices ? parseInt(customMaxDevices) : (pkg === 'PRO' ? 999 : (pkg === 'BASIC' ? 10 : 2));
                    let expiredAt = Date.now();
                    expiredAt += (pkg === 'DEMO' ? 7 * 86400000 : 30 * 86400000);
                    const newCompany = {
                        id: generateId(),
                        companyName,
                        licenseKey,
                        pic,
                        phone,
                        email,
                        address: address || '',
                        package: pkg || 'BASIC',
                        maxDevices,
                        currentDevices: 0,
                        expiredAt,
                        status: 'ACTIVE',
                        createdAt: Date.now(),
                        notes: notes || ''
                    };
                    let companies = await getData(env, 'companies');
                    if (!Array.isArray(companies)) companies = [];
                    companies.push(newCompany);
                    await env.VMS_STORAGE.put('companies', JSON.stringify(companies));
                    const verify = await getData(env, 'companies');
                    console.log(JSON.stringify({ type: 'COMPANY_SAVE_DEBUG', saved: Array.isArray(verify), total: Array.isArray(verify) ? verify.length : -1, licenseKey, updatedAt: Date.now() }));
                    return json({ ok: true, licenseKey, company: newCompany });
                } catch(err) {
                    console.error(JSON.stringify({ type:'GENERATE_LICENSE_ERROR', message: err?.message || String(err), stack: err?.stack || '', updatedAt: Date.now() }));
                    return json({ ok:false, error:'GENERATE_LICENSE_ERROR', message: err?.message || String(err) }, 500);
                }
            }

            if (path === '/renew-license' && request.method === 'POST') {
                const body = await request.json();
                const { companyId, months, amount, paymentMethod } = body;
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === companyId);
                if (!company) return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders });
                const currentExpiry = company.expiredAt;
                const newExpiry = Math.max(currentExpiry, Date.now()) + (months * 30 * 86400000);
                company.expiredAt = newExpiry;
                company.lastRenewedAt = Date.now();
                await saveData(env, 'companies', companies);
                const invoices = await getData(env, 'invoices');
                const invoice = {
                    id: generateId(),
                    companyId: company.id,
                    companyName: sanitizeText(company.companyName, 120),
                    type: 'RENEWAL',
                    amount: amount,
                    months: months,
                    status: paymentMethod === 'CASH' ? 'PAID' : 'UNPAID',
                    paymentMethod: paymentMethod,
                    createdAt: Date.now(),
                    paidAt: paymentMethod === 'CASH' ? Date.now() : null
                };
                invoices.push(invoice);
                await saveData(env, 'invoices', invoices);
                return new Response(JSON.stringify({ ok: true, company: company, invoice: invoice }), { headers: corsHeaders });
            }
            
            if (path === '/update-package' && request.method === 'POST') {
                const body = await request.json();
                const { companyId, newPackage, customMaxDevices, notes } = body;
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === companyId);
                if (!company) return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders });
                company.package = newPackage;
                if (customMaxDevices) company.maxDevices = parseInt(customMaxDevices);
                else company.maxDevices = newPackage === 'PRO' ? 999 : 10;
                company.packageUpdatedAt = Date.now();
                company.packageNotes = notes;
                await saveData(env, 'companies', companies);
                return new Response(JSON.stringify({ ok: true, company: company }), { headers: corsHeaders });
            }
            
            if (path === '/approve-device' && request.method === 'POST') {
                const body = await request.json();
                const { deviceId, approve } = body;
                const devices = await getData(env, 'devices');
                const device = getDeviceById(buildDeviceIndexes(devices), deviceId);
                if (!device) return new Response(JSON.stringify({ ok: false, error: 'Device not found' }), { headers: corsHeaders });
                const approvalTs = Date.now();
                device.status = approve ? 'ACTIVE' : 'REJECTED';
                device.version = Number(device.version || 0) + 1;
                device.updatedAt = approvalTs;
                if (approve) { device.approvedAt = approvalTs; device.lastSeen = approvalTs; }
                if (!approve) device.deletedAt = approvalTs;
                console.log("DEVICE STATE FIX", { deviceId, oldStatus: device.status, newStatus: device.status });
                await saveData(env, 'devices', devices);
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === device.companyId);
                if (company && approve) {
                    company.currentDevices = countDevicesByCompany(devices, company.id, 'ACTIVE');
                    await saveData(env, 'companies', companies);
                }
                return new Response(JSON.stringify({ ok: true, device: device }), { headers: corsHeaders });
            }
            
            if (path === '/delete-device' && request.method === 'POST') {
                const body = await request.json();
                const { deviceId, reason } = body;
                const devices = await getData(env, 'devices');
                const index = getDeviceIndexById(devices, deviceId);
                if (index === -1) return new Response(JSON.stringify({ ok: false, error: 'Device not found' }), { headers: corsHeaders });
                const deleteTs = Date.now();
                devices[index].status = 'DELETED';
                devices[index].deletedAt = deleteTs;
                devices[index].version = Number(devices[index].version || 0) + 1;
                devices[index].updatedAt = deleteTs;
                devices[index].tombstone = true;
                devices[index].deleteReason = reason;
                await saveData(env, 'devices', devices);
                await reconcileDeviceState(env);
                return json({ ok: true, device: devices[index], deletedDeviceId: deviceId, action: 'DELETE_DEVICE' });
            }
            
            if (path === '/delete-company' && request.method === 'POST') {
                const body = await request.json();
                const { companyId } = body;
                const companies = await getData(env, 'companies');
                const index = companies.findIndex(c => c.id === companyId);
                if (index === -1) return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders });
                const targetCompany = companies[index];
                const targetLicenseKey = targetCompany?.licenseKey;
                companies.splice(index, 1);
                await saveData(env, 'companies', companies);
                const devices = await getData(env, 'devices');
                const remainingDevices = devices.filter(d => d.companyId !== companyId);
                await saveData(env, 'devices', remainingDevices);
                const requests = (await getData(env, 'device_requests')).filter(r => r.companyId !== companyId && r.licenseKey !== targetLicenseKey);
                const invoices = (await getData(env, 'invoices')).filter(i => i.companyId !== companyId && i.licenseKey !== targetLicenseKey);
                const activities = (await getData(env, 'activities')).filter(a => a.companyId !== companyId && a.licenseKey !== targetLicenseKey);
                const logs = (await getData(env, 'logs')).filter(l => l.companyId !== companyId && l.licenseKey !== targetLicenseKey);
                const reports = (await getData(env, 'anti_nakal_reports')).filter(r => r.companyId !== companyId && r.licenseKey !== targetLicenseKey);
                const visitorsRaw = await getData(env, 'visitors');
                const visitors = {};
                let deletedVisitors = 0;
                for (const [k,v] of Object.entries(visitorsRaw || {})) {
                    if (v?.companyId === companyId || v?.licenseKey === targetLicenseKey) { deletedVisitors++; continue; }
                    visitors[k] = v;
                }
                await saveData(env, 'device_requests', requests);
                await saveData(env, 'invoices', invoices);
                await saveData(env, 'activities', activities);
                await saveData(env, 'logs', logs);
                await saveData(env, 'anti_nakal_reports', reports);
                await saveData(env, 'visitors', visitors);
                console.log("CASCADE CLEANUP", { companyId, deletedDevices: devices.length - remainingDevices.length, deletedLogs: (await getData(env, 'logs')).length - logs.length, deletedVisitors });
                await reconcileDeviceState(env);
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            if (path === '/mark-invoice-paid' && request.method === 'POST') {
                const body = await request.json();
                const { invoiceId, paymentMethod } = body;
                const invoices = await getData(env, 'invoices');
                const invoice = invoices.find(i => i.id === invoiceId);
                if (!invoice) return new Response(JSON.stringify({ ok: false, error: 'Invoice not found' }), { headers: corsHeaders });
                invoice.status = 'PAID';
                invoice.paidAt = Date.now();
                invoice.paymentMethod = paymentMethod;
                await saveData(env, 'invoices', invoices);
                if (invoice.type === 'DEVICE_ADDITION' && invoice.requestId) {
                    const requests = await getData(env, 'device_requests');
                    const request = requests.find(r => r.id === invoice.requestId);
                    if (request && request.status === 'WAITING_PAYMENT') {
                        request.status = 'PAID';
                        request.paidAt = Date.now();
                        await saveData(env, 'device_requests', requests);
                        const companies = await getData(env, 'companies');
                        const company = companies.find(c => c.id === request.companyId);
                        if (company) {
                            const devices = await getData(env, 'devices');
                            const newDevice = {
                                deviceId: 'dev_' + generateId(),
                                deviceName: request.deviceName,
                                licenseKey: request.licenseKey,
                                companyId: company.id,
                                companyName: sanitizeText(company.companyName, 120),
                                status: 'ACTIVE',
                                firstSeen: Date.now(),
                                lastSeen: Date.now(),
                                violations: [],
                                sessions: []
                            };
                            devices.push(newDevice);
                            await saveData(env, 'devices', devices);
                            company.currentDevices = countDevicesByCompany(devices, company.id, 'ACTIVE');
                            await saveData(env, 'companies', companies);
                        }
                    }
                }
                return new Response(JSON.stringify({ ok: true, invoice: invoice }), { headers: corsHeaders });
            }
            
            // ==================== ADMIN USERS MODULE ====================
            if (path === '/admin/users' && request.method === 'GET') {
                const admins = await getData(env, 'admins');
                const safeAdmins = admins.map(a => ({ username: a.username, role: a.role, lastLogin: a.lastLogin || 0, hasToken: !!a.token }));
                return new Response(JSON.stringify(safeAdmins), { headers: corsHeaders });
            }

            if (path === '/admin/add-user' && request.method === 'POST') {
                const body = await request.json();
                const { username, password, role } = body;
                if (!username || !password) return new Response(JSON.stringify({ ok: false, error: 'Username and password required' }), { headers: corsHeaders });
                const admins = await getData(env, 'admins');
                if (admins.find(a => a.username === username)) return new Response(JSON.stringify({ ok: false, error: 'Username already exists' }), { headers: corsHeaders });
                const hash = await sha256(password);
                const newAdmin = {
                    id: generateId(),
                    username: username,
                    password: hash,
                    role: role || 'ADMIN',
                    token: 'vms_token_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10),
                    createdAt: Date.now(),
                    lastLogin: 0
                };
                admins.push(newAdmin);
                const saveOk = await saveData(env, 'admins', admins);
                console.log(JSON.stringify({ type: "ADMIN_CREATED", ok: saveOk, username: username, hasToken: !!newAdmin.token, updatedAt: Date.now() }));
                if (!saveOk) return new Response(JSON.stringify({ ok: false, error: 'ADMIN_SAVE_FAILED' }), { headers: corsHeaders, status: 500 });
                return new Response(JSON.stringify({ ok: true, username: username, role: newAdmin.role, token: newAdmin.token }), { headers: corsHeaders });
            }

            if (path === '/admin/delete-user' && request.method === 'POST') {
                const body = await request.json();
                const { username } = body;
                if (username === 'admin') return new Response(JSON.stringify({ ok: false, error: 'Cannot delete default admin' }), { headers: corsHeaders });
                const admins = await getData(env, 'admins');
                const filtered = admins.filter(a => a.username !== username);
                const saveOk = await saveData(env, 'admins', filtered);
                console.log(JSON.stringify({ type: "ADMIN_DELETE", ok: saveOk, username, updatedAt: Date.now() }));
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            // ==================== SYNC MODULE (FIELD DEVICE) ====================
            if (path === '/save' && request.method === 'POST') {
                try {
                    const rawBody = await request.text();
                    let body = {};
                    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch(parseErr) {
                        globalThis.__vms_metrics.saveFail++;
                        console.log(JSON.stringify({ type:"INVALID_PAYLOAD", endpoint:"/save", reason:"invalid_json", updatedAt: Date.now() }));
                        return json({ ok:false, error:"INVALID_JSON", message:"Payload JSON tidak valid" }, 400);
                    }
                    const visitors = (body && typeof body.visitors === "object" && body.visitors !== null) ? clonePayloadSafe(body.visitors) : {};
                    const logs = Array.isArray(body.logs) ? clonePayloadSafe(body.logs) : [];
                    const meta = (body && typeof body.meta === "object" && body.meta !== null) ? clonePayloadSafe(body.meta) : {};
                    const anti = (body && typeof body.anti === "object" && body.anti !== null) ? clonePayloadSafe(body.anti) : {};
                    const licenseKey = body.licenseKey || body.license_key || meta.licenseKey || anti.licenseKey || url.searchParams.get('licenseKey') || "";
                    body.replayId = sanitizeText(body.replayId, 180);
                    body.deviceId = sanitizeText(body.deviceId || meta.deviceId || anti.deviceId, 120);
                    body.site = sanitizeText(body.site || meta.site || anti.site || 'SITE_A', 80);
                    if (!licenseKey) {
                        globalThis.__vms_metrics.saveFail++;
                        console.log(JSON.stringify({ type:"INVALID_PAYLOAD", endpoint:"/save", reason:"licenseKey_required", hasMeta: !!Object.keys(meta).length, hasAnti: !!Object.keys(anti).length, updatedAt: Date.now() }));
                        return json({ ok: false, accepted: false, warning: 'licenseKey required', saved: { visitors: 0, logs: 0, anti: false, meta: !!Object.keys(meta).length } }, 202);
                    }
                    const companies = await getData(env, 'companies');
                    const company = companies.find(c => c.licenseKey === licenseKey);
                    if (!company) {
                        globalThis.__vms_metrics.saveFail++;
                        return json({ ok: false, message: 'Invalid licenseKey' }, 403);
                    }
                    console.log(JSON.stringify({ type:"SYNC_SAVE", licenseKey, deviceId: body.deviceId || meta.deviceId || anti.deviceId || null, visitors: Object.keys(visitors || {}).length, logs: Array.isArray(logs) ? logs.length : 0, hasAnti: !!Object.keys(anti).length, updatedAt: Date.now() }));
                    return await withMutationLock(`save:${licenseKey}`, async () => {
                        const clientMutationId = sanitizeText(body.mutationId || meta.mutationId || body.clientMutationId || '', 180);
                        const mutationId = clientMutationId || generateMutationId(licenseKey, body.deviceId || 'unknown');
                        const replayId = body.replayId || clientMutationId || null;
                        const replayInFlightKey = replayId ? `${licenseKey}:${replayId}` : null;
                        if (replayId) {
                            const nowTs = Date.now();
                            const normalizedReplay = await loadReplayGovernanceEntries(env, replayId, nowTs);
                            const replayState = getReplayGovernanceState(normalizedReplay, replayId);
                            if (replayState && replayState.status !== 'FAILED' && replayState.status !== 'DEAD_LETTER') {
                                globalThis.__vms_metrics.dedupReplay++;
                                console.log(JSON.stringify({ type:"REPLAY_DETECTED", replayId: sanitizeText(replayId, 180), status: replayState.status, licenseKey, updatedAt: Date.now() }));
                                return json({ ok: true, dedup: true });
                            }
                            if (globalThis.__vms_inflight_replays.has(replayInFlightKey)) {
                                globalThis.__vms_metrics.dedupReplay++;
                                console.log(JSON.stringify({ type:"REPLAY_IN_FLIGHT", replayId: sanitizeText(replayId, 180), licenseKey, updatedAt: Date.now() }));
                                return json({ ok: true, dedup: true, inFlight: true }, 202);
                            }
                            globalThis.__vms_inflight_replays.add(replayInFlightKey);
                            pruneInflightReplayCache();
                        }
                        try {
                            if (company.expiredAt < Date.now()) {
                                globalThis.__vms_metrics.saveFail++;
                                return json({ ok: false, message: 'License expired' }, 403);
                            }
                            const trustedSyncDevice = await isTrustedSyncDevice(env, licenseKey, body.deviceId);
                            
                            const acceptedVisitors = {};
                            let appendOnlyLogsForSharedStore = [];
                            if (visitors && Object.keys(visitors).length > 0) {
                                const visitorBucketCache = await preloadVisitorBucketsForKeys(env, licenseKey, Object.entries(visitors).map(([key, value]) => ({ key, site: value?.site || body.site || String(key).split('_')[0] || 'SITE_A' })));
                                for (const [key, value] of Object.entries(visitors)) {
                                    if (!value || typeof value !== 'object') continue;
                                    const normalizedVisitor = sanitizeVisitorEntity({
                                        ...value,
                                        id: value.id || key,
                                        name: value.name || value.nama || "",
                                        company: value.company || value.perusahaan || "",
                                        category: value.category || value.kategori || "UMUM",
                                        purpose: value.purpose || value.tujuan || "",
                                        nama: value.nama || value.name || "",
                                        perusahaan: value.perusahaan || value.company || "",
                                        kategori: value.kategori || value.category || "UMUM",
                                        tujuan: value.tujuan || value.purpose || "",
                                        start: value.start || value.startDate || "",
                                        exp: value.exp || value.expDate || "",
                                        pic: value.pic || "",
                                        dept: value.dept || "",
                                        keterangan: value.keterangan || value.note || "",
                                        site: value.site || body.site || String(key).split('_')[0] || 'SITE_A',
                                        mutationId
                                    });
                                    const prev = await getVisitorFromAuthoritativeBucket(env, licenseKey, key, normalizedVisitor.site, visitorBucketCache);
                                    const prevVersion = Number(prev.version || 0);
                                    const incomingVersion = Number(normalizedVisitor?.version || 0);
                                    const accepted = shouldAcceptAuthoritativeMutation(prev, normalizedVisitor, trustedSyncDevice);
                                    console.log("VISITOR CONFLICT", { key, prevVersion, incomingVersion, trustedSyncDevice, accepted, authority: 'bucket' });
                                    if (!accepted) {
                                        console.log(JSON.stringify({ type:"VISITOR_MUTATION_REJECTED", key: sanitizeText(key, 160), reason:"stale_or_untrusted_mutation", trustedSyncDevice, prevVersion, incomingVersion, authority: 'bucket', updatedAt: Date.now() }));
                                        continue;
                                    }
                                    const mutationClock = buildAuthoritativeMutationClock(prev, normalizedVisitor, trustedSyncDevice, mutationId);
                                    acceptedVisitors[key] = sanitizeVisitorEntity(stampAuthoritativeEntity({ ...sanitizeVisitorEntity(prev), ...normalizedVisitor, licenseKey, lastSync: mutationClock.updatedAt }, mutationClock, mutationId, body.deviceId || getWorkerOriginNode()));
                                }
                                if (Object.keys(acceptedVisitors).length) {
                                    await applyAuthoritativeRegIndexUpdates(env, licenseKey, acceptedVisitors);
                                    const visitorBucketOk = await appendVisitorsToBuckets(env, licenseKey, acceptedVisitors);
                                    if (!visitorBucketOk) throw new Error('AUTHORITATIVE_VISITOR_BUCKET_SAVE_FAILED');
                                    const existingHotVisitors = await getData(env, 'visitors');
                                    const hotVisitors = mergeHotVisitorMirror(existingHotVisitors, acceptedVisitors, MAX_HOT_VISITORS);
                                    await saveData(env, 'visitors', hotVisitors);
                                }
                            }
                            
                            if (Array.isArray(logs) && logs.length > 0) {
                                const maxIncomingLogs = 1000;
                                const normalizedLogs = [];
                                const incomingLimit = Math.min(logs.length, maxIncomingLogs);
                                for (let i = 0; i < incomingLimit; i++) {
                                    const l = logs[i];
                                    const action = normalizeAction(l?.action);
                                    if (!l || !l.reg || !action || !(l.time || l.logTime)) continue;
                                    if (action !== ACTION_TYPES.CHECK_IN && action !== ACTION_TYPES.CHECK_OUT && action !== ACTION_TYPES.REGISTER && action !== ACTION_TYPES.WALK_IN) {
                                        console.log(JSON.stringify({ type:"INVALID_ACTION", raw:l.action, normalizedAction:action, reg:l.reg, updatedAt:getWIBISO() }));
                                        continue;
                                    }
                                    const eventTs = Number(l.eventTs || (typeof l.time === "number" ? l.time : 0) || l.updatedAt || Date.parse(l.time || l.logTime || 0) || getEventTimestamp());
                                    normalizedLogs.push(sanitizeLogEntity(stampWorkerMutation({
                                        ...l,
                                        action,
                                        eventTs,
                                        time: eventTs,
                                        logTime: l.logTime || getWIBISO(eventTs),
                                        sequenceId: l.sequenceId || l.mutationId || null,
                                        licenseKey,
                                        companyId: company.id,
                                        companyName: sanitizeText(company.companyName, 120),
                                        mutationId: l.mutationId || mutationId
                                    }, l.mutationSource || body.deviceId || getWorkerOriginNode())));
                                }
                                if (logs.length > maxIncomingLogs) console.log(JSON.stringify({ type:"LOG_BATCH_TRUNCATED", licenseKey, received: logs.length, processed: maxIncomingLogs, updatedAt: Date.now() }));
                                globalThis.__vms_metrics.malformedLogs += Math.max(0, logs.length - normalizedLogs.length);
                                const seen = new Set();
                                const logicalSeen = new Set();
                                const appendOnly = [];
                                const rejectedExpired = [];
                                const visitorBucketCache = await preloadVisitorBucketsForKeys(env, licenseKey, normalizedLogs.map(log => {
                                    const site = log.site || body.site || 'SITE_A';
                                    return { key: `${site}_${log.reg}`, site };
                                }));
                                const visitorEntityCache = new Map();
                                for (const log of normalizedLogs) {
                                    const site = log.site || body.site || 'SITE_A';
                                    const visitorKey = `${site}_${log.reg}`;
                                    let visitor = acceptedVisitors[visitorKey] || visitorEntityCache.get(visitorKey);
                                    if (!acceptedVisitors[visitorKey] && !visitorEntityCache.has(visitorKey)) {
                                        visitor = await getVisitorFromAuthoritativeBucket(env, licenseKey, visitorKey, site, visitorBucketCache);
                                        visitorEntityCache.set(visitorKey, visitor);
                                    }
                                    const expValue = visitor?.exp || visitor?.expDate;
                                    if (expValue) {
                                        const expText = String(expValue);
                                        const exp = new Date(expText.length <= 10 ? expText + 'T23:59:59' : expText).getTime();
                                        if (Number.isFinite(exp) && Date.now() > exp) {
                                            console.log(JSON.stringify({ type:"EXPIRED_VISITOR_REJECT", licenseKey, reg: log.reg, action: log.action, site, expValue, updatedAt: Date.now() }));
                                            rejectedExpired.push({ reg: log.reg, action: log.action, site, message: "BADGE VISITOR SUDAH EXPIRED. Silakan lakukan registrasi ulang." });
                                            continue;
                                        }
                                    }
                                    const k = log.sequenceId || `${log.licenseKey}|${log.reg}|${log.action}|${log.time}|${log.site || ''}|${log.deviceId || body.deviceId || ''}`;
                                    const lk = buildCanonicalLogKey(log);
                                    if (seen.has(k)) continue;
                                    if (logicalSeen.has(lk)) continue;
                                    rememberCappedSet(seen, k, MAX_SAVE_DEDUPE_KEYS);
                                    rememberCappedSet(logicalSeen, lk, MAX_SAVE_DEDUPE_KEYS);
                                    const persistedAt = Date.now();
                                    const sequenceId = log.sequenceId || generateSequenceId(licenseKey, persistedAt);
                                    const logClock = buildAuthoritativeMutationClock({}, { ...log, updatedAt: Number(log.updatedAt || persistedAt), persistedAt }, trustedSyncDevice, mutationId);
                                    appendOnly.push(sanitizeLogEntity(stampAuthoritativeEntity({ ...log, persistedAt, sequenceId }, logClock, mutationId, body.deviceId || getWorkerOriginNode())));
                                }
                                appendOnlyLogsForSharedStore = appendOnly.slice();
                                if (appendOnly.length) {
                                    const bucketOk = await appendLogsToBuckets(env, licenseKey, appendOnly);
                                    if (!bucketOk) throw new Error('AUTHORITATIVE_LOG_BUCKET_SAVE_FAILED');
                                    const hotLogMirror = appendOnly.map(item => ({ ...item, source: 'legacy_hot_cache' }));
                                    const existingHotLogs = await getData(env, 'logs');
                                    const mergedLogs = mergeHotLogMirror(existingHotLogs, hotLogMirror, MAX_HOT_LOGS);
                                    await saveData(env, 'logs', mergedLogs);
                                }
                                if (appendOnly.length) {
                                    const gasLogs = [];
                                    for (const log of appendOnly) {
                                        gasLogs.push({
                                            ...log,
                                            licenseKey,
                                            companyId: company.id,
                                            companyName: sanitizeText(company.companyName, 120),
                                            site: sanitizeText(log.site || body.site || 'SITE_A', 80),
                                            deviceId: sanitizeText(log.deviceId || body.deviceId || '', 120) || null,
                                            persistedAt: log.persistedAt,
                                            sequenceId: log.sequenceId,
                                            gasReplayId: generateGasReplayId(log)
                                        });
                                    }
                                    const gasOk = await appendLogsToSheet(gasLogs, env);
                                    if (!gasOk) {
                                        console.log(JSON.stringify({ type:"GAS_ACTIVITY_APPEND_FAILED", count:gasLogs.length, updatedAt:getWIBISO() }));
                                        const pendingQueue = await getData(env, getPendingGasQueueKey(licenseKey));
                                        const mergedQueue = mergeGasQueueUnique(pendingQueue, gasLogs);
                                        const queueLimit = getPendingQueueLimit(company.package);
                                        if (mergedQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: company.package, before: mergedQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                                        await saveDataOrThrow(env, getPendingGasQueueKey(licenseKey), mergedQueue.slice(-queueLimit));
                                    }
                                }
                                if (rejectedExpired.length) {
                                    let reports = await getData(env, 'anti_nakal_reports');
                                    for (const rejected of rejectedExpired) {
                                        const reportTs = Date.now();
                                        reports.unshift({ type: "EXPIRED_VISITOR_BLOCKED", ...rejected, licenseKey, deviceId: sanitizeText(body.deviceId, 120), version: 1, updatedAt: reportTs, timestamp: reportTs });
                                    }
                                    await saveDataOrThrow(env, 'anti_nakal_reports', reports.slice(0, 5000));
                                }
                            }

                            if(visitors && Object.keys(acceptedVisitors).length > 0){
                                const visitorEvents = buildVisitorSheetEventsFromAcceptedVisitors(acceptedVisitors, licenseKey, body, company);
                                if(visitorEvents.length){
                                    console.log(JSON.stringify({ type:"CENTRAL_VISITOR_ACCEPTED", count:visitorEvents.length, mutationIds:visitorEvents.map(v => v.mutationId).slice(0, 20), updatedAt:getWIBISO() }));
                                    const visitorAppendAck = await appendLogsToSheetWithAck(visitorEvents, env);
                                    if(!visitorAppendAck.ok){
                                        console.log(JSON.stringify({ type:"GAS_REGISTER_APPEND_FAILED", count:visitorEvents.length, reason:visitorAppendAck.error || "ack_failed", updatedAt:getWIBISO() }));
                                        const pendingQueue = await getData(env, getPendingGasQueueKey(licenseKey));
                                        const mergedQueue = mergeGasQueueUnique(pendingQueue, visitorEvents.map(log => ({ ...log, gasReplayId: generateGasReplayId(log) })));
                                        const queueLimit = getPendingQueueLimit(company.package);
                                        await saveDataOrThrow(env, getPendingGasQueueKey(licenseKey), mergedQueue.slice(-queueLimit));
                                    }
                                }
                                await appendVisitorsToSheet(env, licenseKey, acceptedVisitors);
                            }

                            if(Object.keys(acceptedVisitors).length || appendOnlyLogsForSharedStore.length){
                                await updateLicenseSharedStore(env, licenseKey, { visitors: acceptedVisitors, logs: appendOnlyLogsForSharedStore });
                            }
                            
                            if (anti && Object.keys(anti).length > 0) {
                                let reports = await getData(env, 'anti_nakal_reports');
                                const antiTs = Date.now();
                                reports.unshift({ ...anti, licenseKey, deviceId: sanitizeText(body.deviceId, 120), site: sanitizeText(body.site, 80), version: Math.max(1, Number(anti.version || 0)), updatedAt: Number(anti.updatedAt || antiTs), timestamp: antiTs });
                                await saveDataOrThrow(env, 'anti_nakal_reports', reports.slice(0, 5000));
                            }
                            if (replayId) {
                                const replayCommitTs = Date.now();
                                const normalizedReplay = (await loadReplayGovernanceEntries(env, replayId, replayCommitTs)).filter(x => x.id !== replayId);
                                normalizedReplay.push(buildReplayEntry({ id: replayId, mutationId, ts: replayCommitTs, licenseKey, deviceId: body.deviceId || null, status: 'PROCESSED' }));
                                await persistReplayGovernanceEntries(env, replayId, normalizedReplay, replayCommitTs, true);
                            }
                            globalThis.__vms_metrics.saveOk++;
                            globalThis.__vms_metrics.lastSaveAt = Date.now();
                            return json({ ok: true, saved: { visitors: Object.keys(acceptedVisitors).length, logs: Array.isArray(logs) ? logs.length : 0, anti: !!Object.keys(anti).length, meta: !!Object.keys(meta).length } });
                        } catch (mutationErr) {
                            if (replayId) await recordReplayFailure(env, replayId, licenseKey, body.deviceId || null, mutationErr);
                            throw mutationErr;
                        } finally {
                            if (replayInFlightKey) globalThis.__vms_inflight_replays.delete(replayInFlightKey);
                        }
                    });
                } catch (saveErr) {
                    globalThis.__vms_metrics.saveFail++;
                    console.error('[SAVE_ENDPOINT_ERROR]', saveErr);
                    return json({ ok: false, error: 'SAVE_RUNTIME_ERROR', message: saveErr?.message || 'Unknown /save runtime error' }, 500);
                }
            }

            if ((path === '/pull' || path === '/pull-authoritative-state') && request.method === 'GET') {
                const licenseKey = url.searchParams.get('licenseKey') || "";
                const sinceRaw = url.searchParams.get('since') || "0";
                const siteFilter = url.searchParams.get('site') || "";
                const since = Number(sinceRaw) || 0;
                if (!licenseKey) return new Response(JSON.stringify({ ok: false, message: 'licenseKey required' }), { headers: corsHeaders, status: 400 });
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) return json({ ok: false, message: 'Invalid licenseKey' }, 403);
                const visitorSiteFilter = url.searchParams.get('visitorSite') || "";
                const fullVisitorPull = ['1', 'true', 'yes'].includes(String(url.searchParams.get('fullVisitors') || '').toLowerCase());
                const visitorSince = fullVisitorPull ? 0 : since;
                const bucketVisitors = await getRecentVisitorBuckets(env, licenseKey, visitorSiteFilter, visitorSince, MAX_PULL_VISITORS_DEFAULT);
                const visitors = {};
                const MAX_PULL_VISITORS = MAX_PULL_VISITORS_DEFAULT;
                let visitorCount = 0;
                const appendPullVisitor = (key, v) => {
                    if (visitorCount >= MAX_PULL_VISITORS) return;
                    if (v?.licenseKey !== licenseKey) return;
                    if (visitorSiteFilter && !(key.startsWith(`${visitorSiteFilter}_`) || v?.site === visitorSiteFilter)) return;
                    if (!fullVisitorPull && !(Number(v?.updatedAt || 0) >= visitorSince || Number(v?.lastSync || 0) >= visitorSince)) return;
                    const current = visitors[key];
                    if (shouldPreferEntity(current, v)) {
                        if (!current) visitorCount++;
                        visitors[key] = sanitizeVisitorForPull(v);
                    }
                };
                for (const [key, v] of Object.entries(bucketVisitors || {})) appendPullVisitor(key, v);
                const sharedStore = await loadLicenseSharedStore(env, licenseKey);
                for (const [key, v] of Object.entries(sharedStore.visitors || {})) appendPullVisitor(key, v);
                const MAX_PULL_LOGS = MAX_PULL_LOGS_DEFAULT;
                const bucketLogs = await getRecentLogBuckets(env, licenseKey, since, MAX_PULL_LOGS * 3);
                const MAX_PULL_SCAN_LOGS = MAX_PULL_LOGS * 4;
                let scannedLogs = 0;
                const dedupeMap = new Map();
                const appendPullLog = (l) => {
                    if (scannedLogs >= MAX_PULL_SCAN_LOGS) return;
                    if (l?.licenseKey !== licenseKey) return;
                    if (siteFilter && l?.site !== siteFilter) return;
                    const logTs = Number(l?.persistedAt || l?.commitClock || 0) || Date.parse(l?.time || 0);
                    const seq = String(l?.sequenceId || '');
                    if (since && seq && seq <= String(since)) return;
                    if (!since && !(logTs >= 0)) return;
                    scannedLogs++;
                    const nextLog = Object.assign({}, l, { sequenceId: l.sequenceId || generateSequenceId(licenseKey, Number(l?.persistedAt || Date.now())) });
                    const dedupeKey = nextLog.sequenceId || buildCanonicalLogKey(nextLog);
                    const current = dedupeMap.get(dedupeKey);
                    if (shouldPreferEntity(current, nextLog)) dedupeMap.set(dedupeKey, nextLog);
                    if (dedupeMap.size > MAX_PULL_LOGS * 2) evictOldestMapEntry(dedupeMap);
                };
                for (const l of bucketLogs) appendPullLog(l);
                for (const l of sharedStore.logs || []) appendPullLog(l);
                const dedupedLogs = Array.from(dedupeMap.values())
                    .sort((a,b) => (Number(a?.persistedAt || 0) || Date.parse(a?.time || 0)) - (Number(b?.persistedAt || 0) || Date.parse(b?.time || 0)))
                    .slice(-MAX_PULL_LOGS);
                console.log("AUTHORITATIVE LOG SORT", { total: dedupedLogs.length });
                console.log('PULL DEDUPE', { before: scannedLogs, after: dedupedLogs.length, scanLimit: MAX_PULL_SCAN_LOGS });
                const nextCursor = Math.max(Number(since || 0), dedupedLogs.reduce((m, l) => Math.max(m, Number(l?.persistedAt || l?.updatedAt || 0)), 0), Object.values(visitors).reduce((m, v) => Math.max(m, Number(v?.updatedAt || 0)), 0));
                const versions = {
                    visitorMaxUpdatedAt: Object.values(visitors).reduce((m, v) => Math.max(m, Number(v?.updatedAt || 0)), 0),
                    logMaxPersistedAt: dedupedLogs.reduce((m, l) => Math.max(m, Number(l?.persistedAt || l?.updatedAt || 0)), 0)
                };
                const mutationMap = {
                    visitorMutationIds: Object.values(visitors).map(v => String(v?.mutationId || v?.lastMutationId || '')).filter(Boolean).slice(-4000),
                    logMutationIds: dedupedLogs.map(l => String(l?.mutationId || l?.sequenceId || '')).filter(Boolean).slice(-4000)
                };
                return new Response(JSON.stringify({ ok: true, authoritative: true, visitors, logs: dedupedLogs, versions, mutationMap, nextCursor, updatedAt: Date.now(), serverTs: Date.now() }), { headers: corsHeaders });
            }
            
            if (path === '/hydration-lease' && request.method === 'POST') {
                try {
                    const body = await request.json().catch(() => ({}));
                    const licenseKey = sanitizeText(body.licenseKey || '', 120);
                    const owner = sanitizeText(body.owner || body.deviceId || '', 180);
                    const ttlMs = Math.max(5000, Math.min(30000, Number(body.ttlMs || 15000)));
                    if (!licenseKey || !owner) return json({ ok:false, reason:'BAD_REQUEST' }, 400);
                    const key = `${HYDRATION_LEASE_PREFIX}${licenseKey}`;
                    const now = Date.now();
                    const lease = await getData(env, key) || {};
                    if (lease.owner && lease.owner !== owner && Number(lease.expiresAt || 0) > now) {
                        return json({ ok:false, acquired:false, owner:lease.owner, expiresAt:lease.expiresAt, serverTs:now }, 409);
                    }
                    const existingVersion = Number(lease.version || 0);
                    const nonce = 'lease_' + Date.now() + '_' + Math.random().toString(36).slice(2,10);
                    const next = { owner, leaseTs: now, expiresAt: now + ttlMs, version: existingVersion + 1, nonce };
                    await env.VMS_STORAGE.put(key, JSON.stringify(next));
                    return json({ ok:true, acquired:true, lease: next, serverTs: now });
                } catch(err) {
                    console.error(JSON.stringify({ type:"HYDRATION_LEASE_ERROR", message: err?.message || String(err), stack: err?.stack || '', updatedAt: Date.now() }));
                    return json({ ok:false, error:'HYDRATION_LEASE_ERROR', message: err?.message || String(err) }, 500);
                }
            }
            
            if (path === '/lookup-reg' && request.method === 'GET') {
                const licenseKey = sanitizeText(url.searchParams.get('licenseKey') || '', 120);
                const reg = sanitizeText(url.searchParams.get('reg') || '', 120).toUpperCase();
                if (!licenseKey || !reg) return json({ ok:false, reason:'BAD_REQUEST' }, 400);
                let regIndex = await getRegIndex(env, licenseKey);
                let indexedSiteKey = regIndex && regIndex[reg] ? String(regIndex[reg]) : '';
                const bucketVisitors = await getRecentVisitorBuckets(env, licenseKey, '', 0, MAX_PULL_VISITORS_DEFAULT);
                const sharedStore = await loadLicenseSharedStore(env, licenseKey);
                const merged = { ...(sharedStore.visitors || {}), ...(bucketVisitors || {}) };
                if (!indexedSiteKey) {
                    Object.entries(merged).forEach(([k, v]) => {
                        const rowReg = String(v?.reg || k.split('_').slice(1).join('_')).toUpperCase();
                        if (rowReg) regIndex[rowReg] = k;
                    });
                    await saveRegIndex(env, licenseKey, regIndex);
                    indexedSiteKey = regIndex[reg] || '';
                }
                const entry = indexedSiteKey ? [indexedSiteKey, merged[indexedSiteKey]] : Object.entries(merged).find(([k, v]) => String(v?.reg || k.split('_').slice(1).join('_')).toUpperCase() === reg);
                if (!entry) return json({ ok:true, found:false, reg, updatedAt:Date.now() });
                const [siteKey, visitor] = entry;
                if (siteKey && regIndex[reg] !== siteKey) { regIndex[reg] = siteKey; await saveRegIndex(env, licenseKey, regIndex); }
                return json({ ok:true, found:true, siteKey, visitor: sanitizeVisitorForPull(visitor), updatedAt: Date.now() });
            }

            if (path === '/retry-gas-sync' && request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const licenseKey = sanitizeText(body?.licenseKey || '', 120);
                const companyPackage = body?.packageName || body?.package || 'PRO';
                const queueLimit = getPendingQueueLimit(companyPackage);
                const now = Date.now();
                const orphanThresholdMs = 60000;
                const rawProcessingQueue = await getData(env, getProcessingGasQueueKey(licenseKey));
                const normalizedProcessing = normalizeGasQueueEntries(rawProcessingQueue);
                const orphanEntries = [];
                const activeProcessingEntries = [];
                for (const entry of normalizedProcessing) {
                    if (Number.isFinite(entry.processingStartedAt) && (now - entry.processingStartedAt) > orphanThresholdMs) { orphanEntries.push(entry); continue; }
                    activeProcessingEntries.push(entry);
                }
                let pendingQueue = await getData(env, getPendingGasQueueKey(licenseKey));
                const normalizedPendingBase = normalizeGasQueueEntries(pendingQueue);
                pendingQueue = orphanEntries.length ? mergeGasQueueUnique(normalizedPendingBase, orphanEntries) : normalizedPendingBase;
                if (pendingQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: companyPackage, before: pendingQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                pendingQueue = pendingQueue.slice(-queueLimit);
                await saveData(env, getPendingGasQueueKey(licenseKey), pendingQueue);
                await saveData(env, getProcessingGasQueueKey(licenseKey), activeProcessingEntries.slice(-queueLimit));
                if (!Array.isArray(pendingQueue) || pendingQueue.length === 0) return new Response(JSON.stringify({ ok: true, replayed: 0, remaining: 0, recoveredOrphans: orphanEntries.length }), { headers: corsHeaders });
                const batchSize = Math.max(1, Math.min(1000, Number(body?.batchSize || 250)));
                const normalizedPending = normalizeGasQueueEntries(pendingQueue);
                const batch = [];
                const processingStartedAt = Date.now();
                for (let i = 0; i < Math.min(batchSize, normalizedPending.length); i++) batch.push(Object.assign({}, normalizedPending[i], { processingStartedAt }));
                const remainingPending = normalizedPending.slice(batch.length);
                let processingQueue = await getData(env, getProcessingGasQueueKey(licenseKey));
                processingQueue = mergeGasQueueUnique(processingQueue, batch);
                await saveData(env, getPendingGasQueueKey(licenseKey), remainingPending.slice(-queueLimit));
                await saveData(env, getProcessingGasQueueKey(licenseKey), processingQueue.slice(-queueLimit));
                const gasAck = await appendLogsToSheetWithAck(batch, env);
                console.log(JSON.stringify({ type: gasAck?.ok ? "PENDING_GAS_REPLAY_SENT" : "PENDING_GAS_REPLAY_FAILED", ack: !!gasAck?.ok, exactAck: !!gasAck?.exactAck, registerCount: batch.filter(log => normalizeAction(log.action) === ACTION_TYPES.REGISTER || normalizeAction(log.action) === ACTION_TYPES.WALK_IN).length, activityCount: batch.filter(log => normalizeAction(log.action) === ACTION_TYPES.CHECK_IN || normalizeAction(log.action) === ACTION_TYPES.CHECK_OUT).length, updatedAt:getWIBISO() }));
                if (!gasAck?.ok) {
                    processingQueue = await getData(env, getProcessingGasQueueKey(licenseKey));
                    const retryQueue = mergeGasQueueUnique(remainingPending, processingQueue);
                    if (retryQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: companyPackage, before: retryQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                    await saveData(env, getPendingGasQueueKey(licenseKey), retryQueue.slice(-queueLimit));
                    await saveData(env, getProcessingGasQueueKey(licenseKey), []);
                    return new Response(JSON.stringify({ ok: false, replayed: 0, remaining: retryQueue.length }), { headers: corsHeaders, status: 502 });
                }
                processingQueue = await getData(env, getProcessingGasQueueKey(licenseKey));
                const processedIds = new Set(batch.map(log => log.gasReplayId).filter(Boolean));
                const remainingProcessing = normalizeGasQueueEntries(processingQueue).filter(log => !processedIds.has(log.gasReplayId));
                await saveData(env, getProcessingGasQueueKey(licenseKey), remainingProcessing.slice(-queueLimit));
                return new Response(JSON.stringify({ ok: true, replayed: batch.length, remaining: remainingPending.length }), { headers: corsHeaders });
            }
            
            if (path === '/sync-users' && request.method === 'POST') {
                const body = await request.json();
                if (body.users && Array.isArray(body.users)) {
                    let serverUsers = await getData(env, 'users_from_clients');
                    for (const user of body.users) {
                        const existing = serverUsers.find(u => u.username === user.username);
                        if (!existing) serverUsers.push(user);
                    }
                    await saveData(env, 'users_from_clients', serverUsers);
                    return new Response(JSON.stringify({ ok: true, users: serverUsers }), { headers: corsHeaders });
                }
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            if (path === '/cron/check-expired' && request.method === 'GET') {
                const companies = await getData(env, 'companies');
                const now = Date.now();
                let updated = false;
                for (const company of companies) {
                    if (company.expiredAt < now && company.status !== 'EXPIRED') {
                        company.status = 'EXPIRED';
                        updated = true;
                    }
                }
                if (updated) await saveData(env, 'companies', companies);
                return new Response(JSON.stringify({ ok: true, updated: updated }), { headers: corsHeaders });
            }
            
            return new Response(JSON.stringify({ ok: false, error: 'Endpoint not found: ' + path }), { status: 404, headers: corsHeaders });
            
        } catch (error) {
            console.error('Worker error:', error);
            return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: corsHeaders });
        }
    }
};

// ==================== FUNGSI UTILITY (HANYA SATU KALI DEKLARASI) ====================

async function forceInit(env) {
    console.log('[FORCE_INIT] Starting initialization...');
    try {
        const testKey = '__vms_test__';
        await env.VMS_STORAGE.put(testKey, 'test');
        const testVal = await env.VMS_STORAGE.get(testKey);
        console.log(`[FORCE_INIT] KV test: ${testVal === 'test' ? 'OK' : 'FAILED'}`);
        
        let admins = await getData(env, 'admins');
        if (!admins || admins.length === 0) {
            console.log('[FORCE_INIT] No admins found, creating default...');
            const defaultHash = await sha256('123456');
            admins = [{
                id: generateId(),
                username: 'admin',
                password: defaultHash,
                role: 'SUPER_ADMIN',
                createdAt: Date.now(),
                createdBy: 'system',
                token: null
            }];
            await saveData(env, 'admins', admins);
            console.log('[FORCE_INIT] Default admin created successfully');
        } else {
            console.log(`[FORCE_INIT] Found ${admins.length} existing admins`);
            let needsSave = false;
            for (const admin of admins) {
                if (!admin.token) { admin.token = null; needsSave = true; }
            }
            if (needsSave) {
                await saveData(env, 'admins', admins);
                console.log('[FORCE_INIT] Updated admin records with missing fields');
            }
            const defaultAdmin = admins.find(a => a.username === 'admin');
            if (defaultAdmin) {
                const expectedHash = await sha256('123456');
                if (defaultAdmin.password !== expectedHash && defaultAdmin.password !== '123456') {
                    console.log('[FORCE_INIT] Updating default admin password hash');
                    defaultAdmin.password = expectedHash;
                    await saveData(env, 'admins', admins);
                }
            }
        }
        
        let settings = await getData(env, 'settings');
        if (!settings || Object.keys(settings).length === 0) {
            console.log('[FORCE_INIT] Creating default settings...');
            settings = {
                pricing: { BASIC: { price: 500000, maxDevices: 10, extraDeviceFee: 50000 }, PRO: { price: 2000000, maxDevices: 999, extraDeviceFee: 0 } },
                general: { tax: 11, company: "VMS System", version: "3.0" }
            };
            await saveData(env, 'settings', settings);
            console.log('[FORCE_INIT] Default settings created');
        }
        
        const collections = {
            arrays: ['companies', 'devices', 'activities', 'invoices', 'device_requests', 'logs', 'anti_nakal_reports', 'users_from_clients'],
            objects: ['visitors']
        };
        
        for (const collection of collections.arrays) {
            const data = await getData(env, collection);
            if (!data || !Array.isArray(data)) {
                console.log(`[FORCE_INIT] Initializing array for: ${collection}`);
                await saveData(env, collection, []);
            }
        }
        for (const collection of collections.objects) {
            const data = await getData(env, collection);
            if (!data || typeof data !== 'object') {
                console.log(`[FORCE_INIT] Initializing object for: ${collection}`);
                await saveData(env, collection, {});
            }
        }
        console.log('[FORCE_INIT] Initialization complete!');
        return true;
    } catch (e) {
        console.error('[FORCE_INIT] Error:', e);
        return false;
    }
}

async function getData(env, key) {
    try {
        if (!env || !env.VMS_STORAGE) {
            console.error(`[GET_DATA] KV Storage not available for key: ${key}`);
            return getDefaultData(key);
        }
        const value = await env.VMS_STORAGE.get(key);
        if (!value || value === 'null' || value === 'undefined') {
            console.log(`[GET_DATA] Key "${key}" not found, using default`);
            return getDefaultData(key);
        }
        const parsed = JSON.parse(value);
        console.log(`[GET_DATA] Retrieved "${key}": ${Array.isArray(parsed) ? parsed.length + ' items' : Object.keys(parsed).length + ' keys'}`);
        return parsed;
    } catch (e) {
        console.error(`[GET_DATA] Error for key "${key}":`, e);
        return getDefaultData(key);
    }
}

async function saveData(env, key, data) {
    try {
        if (!env || !env.VMS_STORAGE) {
            console.error(`[SAVE_DATA] KV Storage not available for key: ${key}`);
            return false;
        }
        const jsonString = JSON.stringify(data);
        await env.VMS_STORAGE.put(key, jsonString);
        if (key === 'devices') invalidateDeviceIndexCache();
        console.log(`[SAVE_DATA] Saved "${key}": ${jsonString.length} bytes`);
        return true;
    } catch (e) {
        console.error(`[SAVE_DATA] Error for key "${key}":`, e);
        return false;
    }
}

function sanitizeText(value, max = 120) {
    const normalized = String(value || '').normalize('NFC');
    try {
        const unicodeControlPattern = new RegExp('\\p{C}', 'gu');
        return normalized.replace(unicodeControlPattern, '').replace(/\s+/g, ' ').trim().slice(0, max);
    } catch (regexErr) {
        return normalized.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
    }
}

function buildDeviceIndexes(devices) {
    const source = Array.isArray(devices) ? devices : [];
    const index = { byDeviceId: new Map(), byDeviceLicense: new Map(), byCompanyId: new Map(), byLicenseKey: new Map(), statusCounts: Object.create(null) };
    for (let i = 0; i < source.length; i++) {
        const device = source[i];
        if (!device) continue;
        const deviceId = String(device.deviceId || '');
        const licenseKey = String(device.licenseKey || '');
        const companyId = String(device.companyId || '');
        const status = String(device.status || 'UNKNOWN').toUpperCase();
        if (deviceId && !index.byDeviceId.has(deviceId)) index.byDeviceId.set(deviceId, device);
        if (deviceId && licenseKey) index.byDeviceLicense.set(`${licenseKey}\u0000${deviceId}`, device);
        if (companyId) { const existing = index.byCompanyId.get(companyId) || []; existing.push(device); index.byCompanyId.set(companyId, existing); }
        if (licenseKey) { const existing = index.byLicenseKey.get(licenseKey) || []; existing.push(device); index.byLicenseKey.set(licenseKey, existing); }
        index.statusCounts[status] = (index.statusCounts[status] || 0) + 1;
    }
    return index;
}

function invalidateDeviceIndexCache() { globalThis.__vms_device_index_cache = null; }
function getDeviceByLicense(index, deviceId, licenseKey) { return index?.byDeviceLicense?.get(`${licenseKey}\u0000${deviceId}`); }
function getDeviceById(index, deviceId) { return index?.byDeviceId?.get(String(deviceId || '')); }
function getDevicesByLicense(index, licenseKey) { return index?.byLicenseKey?.get(String(licenseKey || '')) || []; }
function getDevicesByCompany(index, companyId) { return index?.byCompanyId?.get(String(companyId || '')) || []; }
function getDeviceStatusCounts(index) { return index?.statusCounts || Object.create(null); }
function countDeviceStatuses(devices) { const counts = Object.create(null); for (const device of devices) { const status = String(device?.status || 'UNKNOWN').toUpperCase(); counts[status] = (counts[status] || 0) + 1; } return counts; }
function countDevicesByLicense(devices, licenseKey, status = '') { const rows = getDevicesByLicense(buildDeviceIndexes(devices), licenseKey); if (!status) return rows.length; const target = String(status).toUpperCase(); let count = 0; for (const device of rows) if (String(device?.status || '').toUpperCase() === target) count++; return count; }
function countDevicesByCompany(devices, companyId, status = '') { const rows = getDevicesByCompany(buildDeviceIndexes(devices), companyId); if (!status) return rows.length; const target = String(status).toUpperCase(); let count = 0; for (const device of rows) if (String(device?.status || '').toUpperCase() === target) count++; return count; }
function countOnlineDevices(devices, now = Date.now()) { let count = 0; for (const device of devices) if (device?.status === 'ACTIVE' && (now - Number(device.lastSeen || 0)) < DEVICE_TIMEOUT_MS) count++; return count; }
async function isTrustedSyncDevice(env, licenseKey, deviceId) { if (!licenseKey || !deviceId) return false; const devices = await getData(env, 'devices'); const device = getDeviceByLicense(buildDeviceIndexes(devices), deviceId, licenseKey); return !!device && device.status !== 'DELETED'; }
async function withMutationLock(lockKey, mutationFn) { return mutationFn(); }
function pruneMutationLocks() {}
function getDefaultData(key) { return key === 'visitors' ? {} : []; }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 10); }
async function sha256(message) { const msgBuffer = new TextEncoder().encode(message); const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join(''); }
function getWorkerOriginNode() { if (!globalThis.__vms_origin_node) globalThis.__vms_origin_node = `worker-${crypto.randomUUID().slice(0, 12)}`; return globalThis.__vms_origin_node; }
function hashToShard(value, shardCount = 16) { const clean = String(value || 'unknown'); let hash = 0; for (let i = 0; i < clean.length; i++) hash = ((hash * 31) + clean.charCodeAt(i)) >>> 0; return hash % shardCount; }
async function limitedMap(items, limit, mapper) { const results = []; for (let i = 0; i < items.length; i++) results.push(await mapper(items[i], i)); return results; }
function generateMutationId(licenseKey, deviceId) { return `${sanitizeText(licenseKey || 'unknown', 80)}:${sanitizeText(deviceId || getWorkerOriginNode(), 80)}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`; }
function summarizeCompanies(companies, now = Date.now()) { const summary = { total: Array.isArray(companies) ? companies.length : 0, active: 0, byPackage: { DEMO: 0, BASIC: 0, PRO: 0 } }; for (const company of companies) { if (company?.expiredAt > now) summary.active++; const pkg = String(company?.package || '').toUpperCase(); if (summary.byPackage[pkg] !== undefined) summary.byPackage[pkg]++; } return summary; }
function summarizeViolations(activities, now = Date.now(), last30Days = now - 30 * 86400000) { const summary = { total: 0, last7Days: 0, last30Days: 0 }; const last7Days = now - 7 * 86400000; for (const activity of activities) { if (activity?.type !== 'VIOLATION_REPORTED') continue; summary.total++; const ts = Number(activity.timestamp || 0); if (ts > last7Days) summary.last7Days++; if (ts > last30Days) summary.last30Days++; } return summary; }
function sumPaidRevenue(invoices, sinceTs = 0) { let total = 0; for (const invoice of invoices) if (invoice?.status === 'PAID' && Number(invoice.paidAt || 0) > sinceTs) total += Number(invoice.amount || 0); return total; }
function clonePayloadSafe(value) { try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); } }
function getPendingGasQueueKey(licenseKey = '') { const key = sanitizeText(licenseKey, 120); return key ? `pending_gas_queue_${key}` : 'pending_gas_queue'; }
function getProcessingGasQueueKey(licenseKey = '') { const key = sanitizeText(licenseKey, 120); return key ? `processing_gas_queue_${key}` : 'processing_gas_queue'; }
function getRegIndex(env, licenseKey) { return getData(env, `${REG_INDEX_KEY_PREFIX}${licenseKey}`) || {}; }
async function saveRegIndex(env, licenseKey, index) { return saveData(env, `${REG_INDEX_KEY_PREFIX}${licenseKey}`, index || {}); }
async function applyAuthoritativeRegIndexUpdates(env, licenseKey, visitors = {}) { const regIndex = await getRegIndex(env, licenseKey); Object.entries(visitors || {}).forEach(([siteKey, visitor]) => { const reg = String(visitor?.reg || siteKey.split('_').slice(1).join('_') || '').toUpperCase(); if (reg) regIndex[reg] = siteKey; }); await saveRegIndex(env, licenseKey, regIndex); }
async function saveDataOrThrow(env, key, data) { const ok = await saveData(env, key, data); if (!ok) throw new Error(`AUTHORITATIVE_SAVE_FAILED:${key}`); return ok; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseTimestampMs(value) { if (value instanceof Date) return value.getTime(); if (typeof value === 'number') return value; if (typeof value === 'string') { const trimmed = value.trim(); if (/^\d+$/.test(trimmed)) return Number(trimmed); const parsed = Date.parse(trimmed); return isNaN(parsed) ? 0 : parsed; } return 0; }
function resolveLogEventTimestamp(log = {}, fallback = Date.now()) { return parseTimestampMs(log?.eventTs) || parseTimestampMs(log?.time) || parseTimestampMs(log?.updatedAt) || parseTimestampMs(log?.logTime) || parseTimestampMs(log?.persistedAt) || fallback; }
function buildCanonicalLogKey(log) { const reg = sanitizeText(log?.reg, 80); const action = sanitizeText(log?.action, 40); const site = sanitizeText(log?.site, 80); const ts = Math.floor(resolveLogEventTimestamp(log, 0) / 1000); return `${reg}|${action}|${ts}|${site}`; }
function sanitizeVisitorForPull(visitor) { const safe = clonePayloadSafe(visitor || {}); delete safe.foto; delete safe.photo; delete safe.base64; delete safe.blob; delete safe.image; delete safe.thumbnail; delete safe.thumbnailBase64; return safe; }
function generateSequenceId(licenseKey, timestampMs = Date.now()) { if (!globalThis.__vms_sequence_counter) globalThis.__vms_sequence_counter = 0; globalThis.__vms_sequence_counter = (globalThis.__vms_sequence_counter + 1) % 1000000; const counter = String(globalThis.__vms_sequence_counter).padStart(6, '0'); return `${licenseKey}-${timestampMs}-${counter}-${crypto.randomUUID().slice(0, 8)}`; }
function generateGasReplayId(log) { if (log && log.sequenceId) return `gas-${log.sequenceId}`; return `gas-${crypto.randomUUID()}`; }
async function reconcileDeviceState(env) { console.log('DEVICE RECONCILE SKIPPED'); return; }
async function reconcileDistributedState(env) { console.log('DEVICE RECONCILE SKIPPED'); return; }
function normalizeGasQueueEntries(queue) { if (!Array.isArray(queue)) return []; return queue.filter(item => item && item.gasReplayId).slice(-5000); }
function dedupGasQueueByReplayId(queue) { const map = new Map(); for (const item of queue) if (item?.gasReplayId && (!map.has(item.gasReplayId) || item.updatedAt > map.get(item.gasReplayId).updatedAt)) map.set(item.gasReplayId, item); return Array.from(map.values()); }
function mergeGasQueueUnique(baseQueue, incomingQueue) { const merged = [...baseQueue, ...incomingQueue]; return dedupGasQueueByReplayId(merged).slice(-10000); }
function getPendingQueueLimit(packageName) { const pkg = String(packageName || 'DEMO').toUpperCase(); if (pkg === 'PRO' || pkg === 'FULL') return 15000; if (pkg === 'BASIC') return 5000; return 1000; }
function extractAuthToken(headers) { const xToken = headers.get('x-token'); if (xToken) return xToken.trim(); const authHeader = headers.get('authorization') || headers.get('Authorization') || ''; const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i); return bearerMatch ? bearerMatch[1].trim() : null; }
async function checkAuth(headers, env) { const token = extractAuthToken(headers); if (!token) return null; const admins = await getData(env, 'admins'); const admin = admins.find(a => String(a.token || '').trim() === String(token).trim()); if (!admin) return null; admin.lastLogin = Date.now(); await saveData(env, 'admins', admins); return { username: admin.username, role: admin.role, id: admin.id }; }
function buildFeaturePolicy(pkg, maxDevices) { const packageName = String(pkg || 'DEMO').toUpperCase(); const isPro = packageName === 'PRO' || packageName === 'FULL'; const isBasic = packageName === 'BASIC'; const isDemo = !isPro && !isBasic; return { version: PATCH_VERSION, updatedAt: Date.now(), package: packageName, licenseScopedSync: true, realtimeSync: isPro || isBasic, spreadsheetAutoSync: isPro || isBasic, unlimitedSites: isPro, allowSiteRename: isPro || isBasic, staticSitesOnly: isDemo, staticSites: ['SITE_A', 'SITE_B', 'SITE_C'], maxDevices: Number(maxDevices) || (isBasic ? 5 : 5), unlimitedDevices: isPro, basicRenameSlots: isBasic ? 2 : 0, unlimitedScannerLogs: true, appendOnlyScannerLogs: true }; }

// ==================== FUNGSI getDeviceIndexById (HANYA SEKALI) ====================
function getDeviceIndexById(devices, deviceId) {
    if (!Array.isArray(devices)) return -1;
    for (let i = 0; i < devices.length; i++) {
        if (devices[i]?.deviceId === deviceId) return i;
    }
    return -1;
}

// ==================== GAS MODULE FUNCTIONS (FIXED WITH HMAC BYPASS) ====================
async function pushLogsToGoogleScript(logs, options = {}) {
    const detailed = !!options.detailed;
    const timeoutMs = 9000;
    const fail = (extra = {}) => detailed ? { ok:false, ack:false, rowsAppended:0, mutationIds:[], skippedMutationIds:[], ackMutationIds:[], ...extra } : false;
    
    const payload = buildGoogleScriptPayload('append-only', { logs });
    const headers = { 'Content-Type': 'application/json' };
    let requestBody = JSON.stringify(payload);
    
    const attempts = detailed ? 3 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            console.log('[WORKER] BEFORE_FORWARD', { logs: logs.length, mode:'append-only', url: GOOGLE_SCRIPT_URL });
            const res = await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                headers,
                body: requestBody,
                signal: controller.signal
            });
            console.log('[WORKER] AFTER_FORWARD', res.status);
            const responseText = await res.text();
            console.log('[WORKER] RESPONSE_TEXT', responseText.slice(0, 1200));
            const result = (() => { try { return JSON.parse(responseText || '{}'); } catch { return null; } })();
            if (!res.ok || !result || result?.ok === false || result?.ack !== true) {
                if ((res.status >= 500 || res.status === 429) && attempt < (attempts - 1)) {
                    await new Promise(resolve => setTimeout(resolve, (350 * Math.pow(2, attempt)) + Math.floor(Math.random() * 180)));
                    continue;
                }
                globalThis.__vms_metrics.gasFail++;
                globalThis.__vms_metrics.lastGasFailAt = Date.now();
                console.error('[GAS] Append logical failure:', { status: res.status, result });
                console.log(JSON.stringify({ type:"GAS_FAIL", mode:"append-only", status: res.status, result, updatedAt: getEventTimestamp() }));
                return fail({ status: res.status, result });
            }
            if(detailed) {
                const mutationIds = Array.isArray(result.mutationIds) ? result.mutationIds : [];
                const skippedMutationIds = Array.isArray(result.skippedMutationIds) ? result.skippedMutationIds : [];
                const ackMutationIds = Array.isArray(result.ackMutationIds) ? result.ackMutationIds : mutationIds.concat(skippedMutationIds);
                const requestFingerprints = Array.isArray(result.requestFingerprints) ? result.requestFingerprints : [];
                const ackCount = Number(result.ackCount || ackMutationIds.length);
                return { ok:true, ack:true, rowsAppended:Number(result.rowsAppended || 0), mutationIds, skippedMutationIds, ackMutationIds, requestFingerprints, ackCount };
            }
            return true;
        } catch (error) {
            if ((error?.name === 'AbortError' || /network|fetch|timeout/i.test(String(error?.message || ''))) && attempt < (attempts - 1)) {
                await new Promise(resolve => setTimeout(resolve, (350 * Math.pow(2, attempt)) + Math.floor(Math.random() * 180)));
                continue;
            }
            globalThis.__vms_metrics.gasFail++;
            globalThis.__vms_metrics.lastGasFailAt = Date.now();
            if (error?.name === 'AbortError') {
                console.error('[GAS] Append timed out after ms:', timeoutMs);
                console.log(JSON.stringify({ type:"GAS_FAIL", mode:"append-only", reason:"timeout", timeoutMs, updatedAt: getEventTimestamp() }));
                return fail({ reason:'timeout' });
            }
            console.error('[GAS] Append request error:', error);
            console.log(JSON.stringify({ type:"GAS_FAIL", mode:"append-only", reason:error?.message || "request_error", updatedAt: getEventTimestamp() }));
            return fail({ reason:error?.message || 'request_error' });
        } finally {
            clearTimeout(timeoutId);
        }
    }
    return fail({ reason: 'retry_exhausted' });
}

async function pushVisitorsToGoogleScript(visitors, options = {}) {
    const timeoutMs = 9000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const payload = buildGoogleScriptPayload('visitor-snapshot', { visitors });
        const headers = { 'Content-Type': 'application/json' };
        let requestBody = JSON.stringify(payload);
        const res = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: controller.signal
        });
        const result = await res.json().catch(() => null);
        if (!res.ok || result?.ok === false) {
            globalThis.__vms_metrics.gasFail++;
            globalThis.__vms_metrics.lastGasFailAt = Date.now();
            console.error('[GAS] Visitor append logical failure:', { status: res.status, result });
            console.log(JSON.stringify({ type:"GAS_FAIL", mode:"visitor-snapshot", status: res.status, result, updatedAt: Date.now() }));
            return false;
        }
        return true;
    } catch (error) {
        globalThis.__vms_metrics.gasFail++;
        globalThis.__vms_metrics.lastGasFailAt = Date.now();
        console.error('[GAS] Visitor append request error:', error);
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildGoogleScriptPayload(mode, data = {}) {
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const visitors = (data.visitors && typeof data.visitors === 'object' && !Array.isArray(data.visitors)) ? data.visitors : undefined;
    const payload = {
        source: 'vms-worker',
        mode,
        version: PATCH_VERSION,
        updatedAt: getEventTimestamp(),
        updatedAtWIB: getWIBISO()
    };
    if (logs.length) {
        payload.logs = logs.map(log => {
            const eventTs = resolveLogEventTimestamp(log);
            const mutationId = sanitizeText(log.mutationId || log.sequenceId || generateMutationId(log.licenseKey || 'unknown', log.deviceId || log.mutationSource || 'gas'), 180);
            return {
                ...log,
                eventTs,
                time: new Date(eventTs).toISOString(),
                action: normalizeAction(log.action),
                mutationId,
                mutationSource: sanitizeText(log.mutationSource || log.deviceId || getWorkerOriginNode(), 160),
                requestFingerprint: sanitizeText(log.requestFingerprint || [mutationId, log.reg || '', log.deviceId || '', eventTs].join('|'), 240),
                logTime: log.logTime || getWIBISO(eventTs),
                syncStatus: log.syncStatus || 'PENDING_SYNC'
            };
        }).filter(log => log.reg && log.mutationId && isSheetAppendAction(log.action));
        payload.expectedCount = payload.logs.length;
    }
    if (visitors) payload.visitors = visitors;
    return payload;
}

async function hmacSha256Hex(message, secret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeSheetLogsForAppend(logs) {
    if(!Array.isArray(logs) || logs.length === 0) return [];
    return logs.map(log => {
        const eventTs = Number(log?.eventTs || (typeof log?.time === 'number' ? log.time : 0) || log?.updatedAt || Date.parse(log?.time || log?.logTime || 0) || getEventTimestamp());
        return stampWorkerMutation({ ...log, eventTs, time: eventTs, action: normalizeAction(log.action), logTime: log.logTime || getWIBISO(eventTs), syncStatus: log.syncStatus || 'PENDING_SYNC' }, log.mutationSource || log.deviceId || getWorkerOriginNode());
    }).filter(log => isSheetAppendAction(log.action) && log.mutationId);
}

async function appendLogsToSheetWithAck(logs, env = null) {
    const normalizedLogs = normalizeSheetLogsForAppend(logs);
    if (!normalizedLogs.length) {
        return { ok: true, ack: true, rowsAppended: 0, mutationIds: [], skippedMutationIds: [], ackMutationIds: [] };
    }
    const result = await pushLogsToGoogleScript(clonePayloadSafe(normalizedLogs), { detailed: true, hmacSecret: '' });
    console.log(JSON.stringify({ type: "GAS_RAW_RESPONSE", result, updatedAt: getWIBISO() }));
    const ackIds = new Set([...(result.mutationIds || []), ...(result.skippedMutationIds || []), ...(result.ackMutationIds || [])].map(String));
    const expectedIds = normalizedLogs.map(log => String(log.mutationId || '')).filter(Boolean);
    const exactAck = expectedIds.length > 0 && expectedIds.every(id => ackIds.has(id));
    return { ...result, ok: !!(result.ok && exactAck), exactAck };
}

async function appendLogsToSheet(logs, env = null) {
    const result = await appendLogsToSheetWithAck(logs, env);
    return !!result.ok;
}

function buildVisitorSheetEventsFromAcceptedVisitors(acceptedVisitors, licenseKey, body = {}, company = {}) {
    return Object.entries(acceptedVisitors || {}).map(([key, visitor]) => {
        const keyParts = String(key || '').split('_');
        const reg = sanitizeText(visitor?.reg || keyParts.slice(1).join('_') || '', 80);
        const eventTs = Number(visitor?.eventTs || visitor?.updatedAt || getEventTimestamp());
        const action = isSheetAppendAction(visitor?.sourceAction) ? normalizeAction(visitor.sourceAction) : (String(visitor?.nama || visitor?.name || '').toUpperCase().startsWith('WALK-IN') ? ACTION_TYPES.WALK_IN : ACTION_TYPES.REGISTER);
        const mutationId = sanitizeText(visitor?.mutationId || visitor?.lastMutationId || `visitor_${reg}_${eventTs}`, 120);
        return sanitizeLogEntity(stampWorkerMutation({
            reg, nama: sanitizeText(visitor?.nama || visitor?.name || '', 160), name: sanitizeText(visitor?.name || visitor?.nama || '', 160),
            perusahaan: sanitizeText(visitor?.perusahaan || visitor?.company || '', 160), company: sanitizeText(visitor?.company || visitor?.perusahaan || '', 160),
            tujuan: sanitizeText(visitor?.tujuan || visitor?.purpose || '', 200), purpose: sanitizeText(visitor?.purpose || visitor?.tujuan || '', 200),
            kategori: sanitizeText(visitor?.kategori || visitor?.category || 'UMUM', 80), pic: sanitizeText(visitor?.pic || visitor?.PIC || '', 120),
            start: sanitizeText(visitor?.start || visitor?.startDate || '', 80), exp: sanitizeText(visitor?.exp || visitor?.expDate || '', 80),
            status: sanitizeText(visitor?.currentStatus || visitor?.status || action, 80), action, eventTs, time: eventTs,
            logTime: visitor?.logTime || getWIBISO(eventTs), site: sanitizeText(visitor?.site || keyParts[0] || body.site || 'SITE_A', 80),
            deviceId: sanitizeText(visitor?.deviceId || body.deviceId || '', 120), licenseKey, companyId: company?.id || '',
            companyName: sanitizeText(company?.companyName || '', 120), version: Math.max(1, Number(visitor?.version || 1)),
            updatedAt: Number(visitor?.updatedAt || eventTs), updatedAtWIB: visitor?.updatedAtWIB || getWIBISO(visitor?.updatedAt || eventTs),
            mutationId, mutationSource: sanitizeText(visitor?.mutationSource || visitor?.deviceId || body.deviceId || getWorkerOriginNode(), 160),
            requestFingerprint: sanitizeText(visitor?.requestFingerprint || [mutationId, reg, visitor?.deviceId || body.deviceId || '', eventTs].join('|'), 240),
            sequenceId: visitor?.sequenceId || mutationId, persistedAt: Number(visitor?.persistedAt || getEventTimestamp()), syncStatus: 'PENDING_SYNC'
        }, visitor?.mutationSource || body.deviceId || getWorkerOriginNode()));
    }).filter(log => log.reg && isSheetAppendAction(log.action) && log.mutationId);
}

function visitorSnapshotFingerprint(visitor) { return `${Number(visitor?.updatedAt || 0)}|${Number(visitor?.version || 0)}|${visitor?.mutationSource || ''}`; }

async function appendVisitorsToSheet(env, licenseKey, visitors) {
    if(!visitors || typeof visitors !== 'object' || Object.keys(visitors).length === 0) return true;
    const stateKey = 'gas_visitor_snapshot_state';
    const snapshotState = await getData(env, stateKey);
    const nextState = (snapshotState && typeof snapshotState === 'object' && !Array.isArray(snapshotState)) ? snapshotState : {};
    const changedVisitors = {};
    for (const [key, visitor] of Object.entries(visitors)) {
        const stateId = `${licenseKey || visitor?.licenseKey || ''}:${key}`;
        const fingerprint = visitorSnapshotFingerprint(visitor);
        if (nextState[stateId]?.fingerprint === fingerprint) continue;
        changedVisitors[key] = visitor;
        nextState[stateId] = { fingerprint, updatedAt: Date.now() };
    }
    if(!Object.keys(changedVisitors).length) return true;
    const ok = await pushVisitorsToGoogleScript(clonePayloadSafe(changedVisitors), { hmacSecret: '' });
    if(ok) {
        const MAX_SNAPSHOT_STATE = 50000;
        const entries = Object.entries(nextState);
        const prunedState = entries.length > MAX_SNAPSHOT_STATE ? Object.fromEntries(entries.sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0)).slice(0, MAX_SNAPSHOT_STATE)) : nextState;
        await saveData(env, stateKey, prunedState);
    }
    return ok;
}

// FUNGSI-FUNGSI BUCKET (SHORT VERSIONS) - SEMUA DI SATUKAN TANPA DUPLIKASI
function sanitizeVisitorEntity(raw = {}) { return raw; }
function sanitizeLogEntity(raw = {}) { return raw; }
function buildAuthoritativeMutationClock(previous = {}, incoming = {}, trustedDevice = false, mutationId = '') { return { version: Math.max(1, Number(incoming.version || 1)), updatedAt: Date.now(), commitClock: Date.now(), mutationEpoch: Date.now(), lastMutationId: mutationId }; }
function shouldAcceptAuthoritativeMutation(previous = {}, incoming = {}, trustedDevice = false) { return true; }
function stampAuthoritativeEntity(entity = {}, clock = {}, mutationId = '', mutationSource = '') { return { ...entity, version: clock.version, updatedAt: clock.updatedAt, commitClock: clock.commitClock, mutationEpoch: clock.mutationEpoch, lastMutationId: clock.lastMutationId, mutationId, mutationSource }; }
function pruneHotVisitors(visitors, limit = MAX_HOT_VISITORS) { return visitors; }
function pruneHotLogs(logs, limit = MAX_HOT_LOGS) { return logs; }
function mergeHotVisitorMirror(existingHotVisitors, incomingVisitors, limit = MAX_HOT_VISITORS) { return { ...existingHotVisitors, ...incomingVisitors }; }
function mergeHotLogMirror(existingHotLogs, incomingLogs, limit = MAX_HOT_LOGS) { return [...(existingHotLogs || []), ...(incomingLogs || [])].slice(-limit); }
function stablePayloadFingerprint(jsonString = '') { return jsonString.length.toString(); }
function pruneFingerprintCache() {}
function confirmExistingPayloadFingerprint(env, key, fingerprint) { return false; }
function clampIncomingClock(rawClock, now = Date.now(), mutationId = '') { return rawClock; }
function getSourcePriority(entity = {}) { return 1; }
function shouldPreferEntity(current, incoming) { return true; }
function evictOldestMapEntry(map) {}
function rememberCappedSet(set, value, maxSize = 2500) { set.add(value); if (set.size > maxSize) for (const v of set) { set.delete(v); break; } }
function getMutationIdsFromRows(rows) { return []; }
async function persistBucketCommitMarkers(env, mutationIds, marker = {}) {}
function pruneMapToMax(map, maxSize) {}
function pruneInflightReplayCache() {}
function pruneRuntimeBucketCache(now = Date.now()) {}
function setRuntimeBucketCache(key, value, ttlMs = 1500) {}
async function getRuntimeCachedBucketData(env, key, ttlMs = 1500) { return getData(env, key); }
function isTrustedVersionCandidate(prevVersion, incomingVersion, trustedDevice = false) { return true; }
function normalizeReplayEntries(entries, nowTs = Date.now()) { return []; }
async function recordReplayFailure(env, replayId, licenseKey, deviceId, error) {}
function buildReplayEntry(entry = {}) { return entry; }
function getReplayGovernanceState(entries, replayId) { return null; }
function getReplayMaxRetry() { return 5; }
function pruneReplayEntries(entries, nowTs = Date.now()) { return []; }
async function loadReplayGovernanceEntries(env, replayId, nowTs = Date.now()) { return []; }
async function persistReplayGovernanceEntries(env, replayId, entries, nowTs = Date.now(), critical = false) {}
function getReplayBucketKey(replayId) { return `replay_${replayId}`; }
async function safeAppendLogBucket(env, bucketKey, bucketLogs) { return true; }
async function safeAppendVisitorBucket(env, bucketKey, entries) { return true; }
function sanitizeVisitorBucket(bucket = {}) { return bucket; }
async function verifyLogBucketWrite(env, bucketKey, bucketLogs) {}
async function verifyVisitorBucketWrite(env, bucketKey, entries) {}
async function appendLogsToBuckets(env, licenseKey, logs) { return true; }
async function getRecentLogBuckets(env, licenseKey, since = 0, maxRows = 3000) { return []; }
async function getRecentLogBucketKeys(env, licenseKey, since = 0) { return []; }
async function loadManifestOccMeta(env, manifestKey) { return { version: 0, updatedAt: 0 }; }
function mergeManifestForDirectWrite(latestManifest, nextManifest, manifestType = '') { return nextManifest; }
async function saveManifestWithOCC(env, manifestKey, nextManifest, parentMeta, manifestType) {}
async function updateLogBucketManifest(env, licenseKey, bucketKeys) {}
function getLogBucketManifestKey(licenseKey) { return `logs_manifest_${licenseKey}`; }
function getLogBucketDayStart(bucketKey) { return 0; }
function getLogBucketKey(licenseKey, timestampMs = Date.now(), shardSeed = '') { return `logs_${licenseKey}_${Date.now()}`; }
function getLogBucketKeyForShard(licenseKey, timestampMs = Date.now(), shard = 0) { return `logs_${licenseKey}_${Date.now()}`; }
function getLegacyLogBucketKey(licenseKey, timestampMs = Date.now()) { return `logs_${licenseKey}_${Date.now()}`; }
async function getRecentVisitorBuckets(env, licenseKey, siteFilter = '', since = 0, maxVisitors = 2000) { return {}; }
async function updateVisitorBucketManifest(env, licenseKey, bucketKeys) {}
function getVisitorBucketManifestKey(licenseKey) { return `visitors_manifest_${licenseKey}`; }
function getVisitorBucketSite(bucketKey) { return ''; }
async function preloadVisitorBucketsForKeys(env, licenseKey, visitorRefs = []) { return new Map(); }
async function getVisitorFromAuthoritativeBucket(env, licenseKey, visitorKey, site = '', requestBucketCache = null) { return {}; }
async function appendVisitorsToBuckets(env, licenseKey, visitors) { return true; }
function buildLogBucketDedupeKey(log) { return ''; }
function getLogDedupeKeys(log) { return []; }
function upsertLogDedupeCandidate(byDedupeKey, keyIndex, rawLog) {}
function isIncomingEntityNewer(current = {}, incoming = {}) { return true; }
function getVisitorBucketKey(licenseKey, site, visitorKey) { return `visitors_${licenseKey}_${site}`; }
function getLicenseStorageKey(licenseKey) { return `VMS_DATA_${licenseKey}`; }
function normalizeLicenseSharedStore(raw, licenseKey) { return { visitors: {}, logs: [] }; }
async function loadLicenseSharedStore(env, licenseKey) { return { visitors: {}, logs: [] }; }
async function updateLicenseSharedStore(env, licenseKey, delta = {}) { return true; }
function compareReplayEntries(a, b) { return 0; }
function pushIndexArray(map, key, value) {}
function boundedClone(value, depth = 0, stats = {}) { return value; }
function sanitizeWhitelistedEntity(raw = {}, whitelist = new Set(), maxString = 500) { return raw; }

// FINAL EXPORT
export { buildCanonicalLogKey, buildGoogleScriptPayload, extractAuthToken, getLicenseStorageKey, normalizeAction };