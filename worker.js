// ==================== VMS WORKER v3.0 - HARDENED PRODUCTION ====================
// Cloudflare Worker untuk VMS SAPAM MEDED
// KV Namespace: VMS_STORAGE

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxYkjSOy6JCuCf2yjGgWtubmA18E1J3MHB9Z1J_YCT59A5yvkneHAGJycHYsi9oN9WbWw/exec';
const PATCH_VERSION = '1.0.17';
const SYNC_ENGINE = 'V5-TITAN';
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
const RUNTIME_BUCKET_CACHE_TTL_MS = 1500;
const MAX_RUNTIME_BUCKET_CACHE_ENTRIES = 256;
const LOG_MANIFEST_TTL_MS = 14 * 86400000;
const VISITOR_MANIFEST_TTL_MS = 30 * 86400000;
const REPLAY_PROCESSED_TTL_MS = 36 * 3600000;
const REPLAY_FAILED_TTL_MS = 2 * 86400000;
const REPLAY_DEAD_LETTER_TTL_MS = 14 * 86400000;
const ACTION_TYPES = Object.freeze({ CHECK_IN: 'CHECK_IN', CHECK_OUT: 'CHECK_OUT', REGISTER: 'REGISTER', WALK_IN: 'WALK_IN' });
const WIB_TIMEZONE = 'Asia/Jakarta';

function getEventTimestamp(){ return Date.now(); }
// Backward-compatible alias only. Epoch timestamps are UTC/universal; WIB is applied only when formatting.
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
        
        // ==================== CORS HEADERS ====================
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
        
        // ==================== OPTIONS HANDLER (SAFE CORS) ====================
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
            // ==================== AUTO INIT (ANTI LOOP) ====================
            if (!globalThis.__vms_init_done) {
                let adminsCheck = await getData(env, 'admins');
                if (!adminsCheck || adminsCheck.length === 0) {
                    await forceInit(env);
                }
                globalThis.__vms_init_done = true;
            }
            
            // ==================== FORCE INIT ENDPOINT ====================
            if (path === '/force-init' && request.method === 'POST') {
                await forceInit(env);
                return new Response(JSON.stringify({ ok: true, message: 'System initialized' }), { headers: corsHeaders });
            }
            
            // ==================== HEALTH CHECK ====================
            if (path === '/' && request.method === 'GET') {
                return new Response(JSON.stringify({ 
                    status: 'online', 
                    version: 'v3.0 Enterprise',
                    apiCompat: 1,
                    engine: SYNC_ENGINE,
                    syncStrategy: SYNC_STRATEGY,
                    timestamp: Date.now(),
                    uptimeMs: Date.now() - (globalThis.__vms_started_at || Date.now()),
                    degraded: (globalThis.__vms_metrics.saveFail > (globalThis.__vms_metrics.saveOk * 2 + 10)),
                    metrics: globalThis.__vms_metrics
                }), { headers: corsHeaders });
            }
            
            // ==================== LOGIN HANDLER (TOKEN INVALIDATION) ====================
            if (path === '/login' && request.method === 'POST') {
                const body = await request.json();
                const { username, password } = body;
                
                console.log(`[LOGIN] Attempt for username: ${username}`);
                
                let admins = await getData(env, 'admins');
                if (!admins || !Array.isArray(admins) || admins.length === 0) {
                    await forceInit(env);
                    admins = await getData(env, 'admins');
                }
                
                // FIX: invalidate old token before creating new one
                admins = admins.map(a => {
                    if (a.username === username) {
                        return { ...a, token: null };
                    }
                    return a;
                });
                await saveData(env, 'admins', admins);
                
                const admin = admins.find(a => a.username === username);
                
                if (!admin) {
                    globalThis.__vms_metrics.authFail++;
                    console.log(`[LOGIN] User not found: ${username}`);
                    return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { 
                        headers: corsHeaders, 
                        status: 401 
                    });
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
                    return new Response(JSON.stringify({ ok: false, error: 'Invalid password' }), { 
                        headers: corsHeaders, 
                        status: 401 
                    });
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
            
            // ==================== AUTH MIDDLEWARE (TOKEN NORMALIZATION) ====================
            const auth = await checkAuth(request.headers, env);
            
            // ==================== PROTECTED PATHS ====================
            const protectedPaths = [
                '/admin/stats', '/admin/companies', '/admin/devices', 
                '/admin/activity', '/admin/invoices', '/admin/device-requests',
                '/generate-license', '/renew-license', '/update-package',
                '/approve-device', '/delete-device', '/delete-company',
                '/mark-invoice-paid', '/admin/users', '/admin/add-user', 
                '/admin/delete-user', '/admin/settings', '/admin/company/',
                '/approve-device-request', '/retry-gas-sync'
            ];
            
            if (protectedPaths.some(p => path === p || path.startsWith('/admin/company/')) && !auth) {
                return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { 
                    headers: corsHeaders, 
                    status: 401 
                });
            }
            
            // ==================== LICENSE MODULE ====================
            // Endpoint: /validate-license
            if (path === '/validate-license' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceId, deviceName, meta } = body;
                
                if (!licenseKey) {
                    return json({ ok: false, message: 'License key required' });
                }
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                
                if (!company) {
                    return json({ ok: false, message: 'Invalid license key' });
                }
                
                const isExpired = company.expiredAt < Date.now();
                if (isExpired) {
                    return json({ 
                        ok: false, 
                        message: 'License expired',
                        company: { ...company, status: 'EXPIRED' }
                    });
                }
                
                const devices = await getData(env, 'devices');
                const deviceIndex = buildDeviceIndexes(devices);
                const companyDevices = getDevicesByLicense(deviceIndex, licenseKey).filter(d => d.status !== 'DELETED');
                const currentDeviceCount = companyDevices.length;
                
                let status = 'ACTIVE';
                if (currentDeviceCount >= company.maxDevices) {
                    status = 'PENDING_APPROVAL';
                }
                
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
                if (!licenseKey) {
                    return json({ ok: false, message: 'License key required' });
                }
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) {
                    return json({ ok: false, message: 'Invalid license key' });
                }
                const features = buildFeaturePolicy(company.package, company.maxDevices);
                return json({
                    ok: true,
                    licenseKey,
                    package: company.package,
                    features
                });
            }
            
            // ==================== CLIENT DEVICES SYNC ENDPOINT ====================
            if (path === '/client/devices' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey } = body;
                
                if (!licenseKey) {
                    return new Response(JSON.stringify({ ok: false, devices: [] }), { headers: corsHeaders });
                }
                
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
            
            if (path === '/sheet-append' && request.method === 'POST') {
                const body = await request.json();
                const rows = Array.isArray(body.logs) ? body.logs : [];
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
                    const pendingQueue = await getData(env, 'pending_gas_queue');
                    await saveData(env, 'pending_gas_queue', mergeGasQueueUnique(pendingQueue, gasLogs).slice(-getPendingQueueLimit('PRO')));
                }
                return new Response(JSON.stringify({ ...appendAck, syncStatus: appendAck.ok ? 'SYNCED' : 'PENDING_SYNC', invalidRows: invalidRows.length }), { headers: corsHeaders, status: appendAck.ok || !gasLogs.length ? 200 : 202 });
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
                if (!company) {
                    return new Response(JSON.stringify({ ok: false, message: 'Invalid license' }), { headers: corsHeaders });
                }
                
                const devices = await getData(env, 'devices');
                const device = getDeviceById(buildDeviceIndexes(devices), deviceId);
                if (!device) {
                    return new Response(JSON.stringify({ ok: false, message: 'Device not found' }), { headers: corsHeaders });
                }
                
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
                
                if (violationCount >= 5) {
                    deviceStatus = 'BANNED';
                } else if (violationCount >= 3) {
                    deviceStatus = 'SUSPENDED';
                }
                
                device.status = deviceStatus;
                await saveData(env, 'devices', devices);
                
                const activities = await getData(env, 'activities');
                activities.unshift({
                    id: generateId(),
                    ...violation,
                    type: 'VIOLATION_REPORTED'
                });
                await saveData(env, 'activities', activities.slice(0, 5000));
                
                return new Response(JSON.stringify({
                    ok: true,
                    violation: violation,
                    deviceStatus: deviceStatus,
                    violationCount: violationCount
                }), { headers: corsHeaders });
            }
            
            // ==================== DEVICE REQUEST MODULE ====================
            if (path === '/request-device' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceName, reason } = body;
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) {
                    return new Response(JSON.stringify({ ok: false, message: 'Invalid license' }), { headers: corsHeaders });
                }
                
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
                
                return new Response(JSON.stringify({
                    ok: true,
                    requestId: newRequest.id,
                    fee: fee,
                    message: fee > 0 ? `Fee Rp ${fee.toLocaleString()} akan ditagihkan` : 'Request sent, waiting approval'
                }), { headers: corsHeaders });
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
                    revenue: {
                        last30Days: sumPaidRevenue(invoices, last30Days)
                    }
                };
                
                return new Response(JSON.stringify(stats), { headers: corsHeaders });
            }
            
            // ==================== ADMIN COMPANY MODULE ====================
            if (path === '/admin/companies' && request.method === 'GET') {
                const companies = await getData(env, 'companies');
                return new Response(JSON.stringify(companies), { headers: corsHeaders });
            }
            
            if (path.startsWith('/admin/company/') && request.method === 'GET') {
                const companyId = path.split('/').pop();
                const companies = await getData(env, 'companies');
                const devices = await getData(env, 'devices');
                
                const company = companies.find(c => c.id === companyId);
                if (!company) {
                    return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { 
                        headers: corsHeaders, 
                        status: 404 
                    });
                }
                
                const companyDevices = getDevicesByCompany(buildDeviceIndexes(devices), companyId);
                const companyStatusCounts = countDeviceStatuses(companyDevices);
                
                return new Response(JSON.stringify({
                    ...company,
                    devices: companyDevices,
                    stats: {
                        totalDevices: companyDevices.length,
                        activeDevices: companyStatusCounts.ACTIVE || 0
                    }
                }), { headers: corsHeaders });
            }
            
            // ==================== ADMIN DEVICE MODULE ====================
            if (path === '/admin/devices' && request.method === 'GET') {
                await reconcileDeviceState(env);
                const devices = await getData(env, 'devices');
                return new Response(JSON.stringify(devices), { headers: corsHeaders });
            }
            
            // ==================== ADMIN ACTIVITY MODULE ====================
            if (path === '/admin/activity' && request.method === 'GET') {
                const urlParams = new URL(request.url).searchParams;
                const limit = parseInt(urlParams.get('limit') || '500');
                const activities = await getData(env, 'activities');
                return new Response(JSON.stringify(activities.slice(0, limit)), { headers: corsHeaders });
            }
            
            // ==================== ADMIN INVOICE MODULE ====================
            if (path === '/admin/invoices' && request.method === 'GET') {
                const invoices = await getData(env, 'invoices');
                return new Response(JSON.stringify(invoices), { headers: corsHeaders });
            }
            
            // ==================== ADMIN DEVICE REQUESTS MODULE ====================
            if (path === '/admin/device-requests' && request.method === 'GET') {
                const urlParams = new URL(request.url).searchParams;
                const status = urlParams.get('status');
                
                let requests = await getData(env, 'device_requests');
                if (status) {
                    requests = requests.filter(r => r.status === status);
                }
                
                return new Response(JSON.stringify(requests), { headers: corsHeaders });
            }
            
            // ==================== APPROVE DEVICE REQUEST MODULE ====================
            if (path === '/approve-device-request' && request.method === 'POST') {
                const body = await request.json();
                const { requestId, approve, notes } = body;
                
                const requests = await getData(env, 'device_requests');
                const request = requests.find(r => r.id === requestId);
                
                if (!request) {
                    return new Response(JSON.stringify({ ok: false, error: 'Request not found' }), { headers: corsHeaders });
                }
                
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
                
                return new Response(JSON.stringify({
                    ok: true,
                    invoiceId: invoice.id,
                    amount: request.fee,
                    request: request
                }), { headers: corsHeaders });
            }
            
            // ==================== GENERATE LICENSE MODULE ====================
            if (path === '/generate-license' && request.method === 'POST') {
                const body = await request.json();
                const { companyName, pic, phone, email, address, package: pkg, customMaxDevices, notes } = body;
                
                if (!companyName || !pic || !phone || !email) {
                    return new Response(JSON.stringify({ ok: false, error: 'Missing required fields' }), { headers: corsHeaders });
                }
                
                const licenseKey = 'VMS-' + generateId().toUpperCase().substring(0, 16);
                
                let maxDevices = customMaxDevices ? parseInt(customMaxDevices) : (pkg === 'PRO' ? 999 : (pkg === 'BASIC' ? 10 : 2));
                let expiredAt = Date.now();
                
                if (pkg === 'DEMO') {
                    expiredAt += 7 * 86400000;
                } else {
                    expiredAt += 30 * 86400000;
                }
                
                const newCompany = {
                    id: generateId(),
                    companyName: companyName,
                    licenseKey: licenseKey,
                    pic: pic,
                    phone: phone,
                    email: email,
                    address: address || '',
                    package: pkg,
                    maxDevices: maxDevices,
                    currentDevices: 0,
                    expiredAt: expiredAt,
                    status: 'ACTIVE',
                    createdAt: Date.now(),
                    notes: notes || ''
                };
                
                const companies = await getData(env, 'companies');
                companies.push(newCompany);
                await saveData(env, 'companies', companies);
                
                return new Response(JSON.stringify({
                    ok: true,
                    licenseKey: licenseKey,
                    company: newCompany
                }), { headers: corsHeaders });
            }
            
            // ==================== RENEW LICENSE MODULE ====================
            if (path === '/renew-license' && request.method === 'POST') {
                const body = await request.json();
                const { companyId, months, amount, paymentMethod } = body;
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === companyId);
                if (!company) {
                    return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders });
                }
                
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
            
            // ==================== UPDATE PACKAGE MODULE ====================
            if (path === '/update-package' && request.method === 'POST') {
                const body = await request.json();
                const { companyId, newPackage, customMaxDevices, notes } = body;
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === companyId);
                if (!company) {
                    return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders });
                }
                
                company.package = newPackage;
                if (customMaxDevices) {
                    company.maxDevices = parseInt(customMaxDevices);
                } else {
                    company.maxDevices = newPackage === 'PRO' ? 999 : 10;
                }
                company.packageUpdatedAt = Date.now();
                company.packageNotes = notes;
                
                await saveData(env, 'companies', companies);
                
                return new Response(JSON.stringify({ ok: true, company: company }), { headers: corsHeaders });
            }
            
            // ==================== APPROVE DEVICE MODULE ====================
            if (path === '/approve-device' && request.method === 'POST') {
                const body = await request.json();
                const { deviceId, approve } = body;
                
                const devices = await getData(env, 'devices');
                const device = getDeviceById(buildDeviceIndexes(devices), deviceId);
                if (!device) {
                    return new Response(JSON.stringify({ ok: false, error: 'Device not found' }), { headers: corsHeaders });
                }
                
                const oldStatus = device.status;
                const approvalTs = Date.now();
                device.status = approve ? 'ACTIVE' : 'REJECTED';
                device.version = Number(device.version || 0) + 1;
                device.updatedAt = approvalTs;
                if (approve) {
                    device.approvedAt = approvalTs;
                    device.lastSeen = approvalTs;
                }
                if (!approve) {
                    device.deletedAt = approvalTs;
                }
                console.log("DEVICE STATE FIX", { deviceId, oldStatus, newStatus: device.status });
                
                await saveData(env, 'devices', devices);
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === device.companyId);
                if (company && approve) {
                    company.currentDevices = countDevicesByCompany(devices, company.id, 'ACTIVE');
                    await saveData(env, 'companies', companies);
                }
                
                return new Response(JSON.stringify({ ok: true, device: device }), { headers: corsHeaders });
            }
            
            // ==================== DELETE DEVICE MODULE ====================
            if (path === '/delete-device' && request.method === 'POST') {
                const body = await request.json();
                const { deviceId, reason } = body;
                
                const devices = await getData(env, 'devices');
                const index = getDeviceIndexById(devices, deviceId);
                if (index === -1) {
                    return new Response(JSON.stringify({ ok: false, error: 'Device not found' }), { headers: corsHeaders });
                }
                
                const deleteTs = Date.now();
                devices[index].status = 'DELETED';
                devices[index].deletedAt = deleteTs;
                devices[index].version = Number(devices[index].version || 0) + 1;
                devices[index].updatedAt = deleteTs;
                devices[index].tombstone = true;
                devices[index].deleteReason = reason;
                await saveData(env, 'devices', devices);
                await reconcileDeviceState(env);
                
                return json({
                    ok: true,
                    device: devices[index],
                    deletedDeviceId: deviceId,
                    action: 'DELETE_DEVICE'
                });
            }
            
            // ==================== DELETE COMPANY MODULE ====================
            if (path === '/delete-company' && request.method === 'POST') {
                const body = await request.json();
                const { companyId } = body;
                
                const companies = await getData(env, 'companies');
                const index = companies.findIndex(c => c.id === companyId);
                if (index === -1) {
                    return new Response(JSON.stringify({ ok: false, error: 'Company not found' }), { headers: corsHeaders });
                }
                
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
            
            // ==================== MARK INVOICE PAID MODULE ====================
            if (path === '/mark-invoice-paid' && request.method === 'POST') {
                const body = await request.json();
                const { invoiceId, paymentMethod } = body;
                
                const invoices = await getData(env, 'invoices');
                const invoice = invoices.find(i => i.id === invoiceId);
                if (!invoice) {
                    return new Response(JSON.stringify({ ok: false, error: 'Invoice not found' }), { headers: corsHeaders });
                }
                
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
                const safeAdmins = admins.map(a => ({ username: a.username, role: a.role, lastLogin: a.lastLogin }));
                return new Response(JSON.stringify(safeAdmins), { headers: corsHeaders });
            }
            
            if (path === '/admin/add-user' && request.method === 'POST') {
                const body = await request.json();
                const { username, password, role } = body;
                
                if (!username || !password) {
                    return new Response(JSON.stringify({ ok: false, error: 'Username and password required' }), { headers: corsHeaders });
                }
                
                const admins = await getData(env, 'admins');
                if (admins.find(a => a.username === username)) {
                    return new Response(JSON.stringify({ ok: false, error: 'Username already exists' }), { headers: corsHeaders });
                }
                
                const hash = await sha256(password);
                admins.push({
                    id: generateId(),
                    username: username,
                    password: hash,
                    role: role || 'ADMIN',
                    createdAt: Date.now()
                });
                await saveData(env, 'admins', admins);
                
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            if (path === '/admin/delete-user' && request.method === 'POST') {
                const body = await request.json();
                const { username } = body;
                
                if (username === 'admin') {
                    return new Response(JSON.stringify({ ok: false, error: 'Cannot delete default admin' }), { headers: corsHeaders });
                }
                
                const admins = await getData(env, 'admins');
                const filtered = admins.filter(a => a.username !== username);
                await saveData(env, 'admins', filtered);
                
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            // ==================== ADMIN SETTINGS MODULE ====================
            if (path === '/admin/settings' && request.method === 'POST') {
                const body = await request.json();
                await saveData(env, 'settings', body);
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            if (path === '/admin/settings' && request.method === 'GET') {
                const settings = await getData(env, 'settings');
                return new Response(JSON.stringify(settings), { headers: corsHeaders });
            }
            
            // ==================== SYNC MODULE (FIELD DEVICE) ====================
            if (path === '/save' && request.method === 'POST') {
                const rawBody = await request.text();

                let body = {};

                try{
                    body = rawBody ? JSON.parse(rawBody) : {};
                }catch(parseErr){
                    globalThis.__vms_metrics.saveFail++;
                    console.log(JSON.stringify({ type:"INVALID_PAYLOAD", endpoint:"/save", reason:"invalid_json", updatedAt: Date.now() }));
                    return json({
                        ok:false,
                        error:"INVALID_JSON",
                        message:"Payload JSON tidak valid"
                    },400);
                }

                const visitors = (
                    body &&
                    typeof body.visitors === "object" &&
                    body.visitors !== null
                )
                ? clonePayloadSafe(body.visitors)
                : {};

                const logs = Array.isArray(body.logs)
                ? clonePayloadSafe(body.logs)
                : [];

                const meta = (
                    body &&
                    typeof body.meta === "object" &&
                    body.meta !== null
                )
                ? clonePayloadSafe(body.meta)
                : {};

                const anti = (
                    body &&
                    typeof body.anti === "object" &&
                    body.anti !== null
                )
                ? clonePayloadSafe(body.anti)
                : {};

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
                    // Operational stability mode: do not block valid saves only because
                    // replay governance previously marked the mutation as DEAD_LETTER.
                    // Basic replay dedupe below remains active for non-FAILED states.
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
                if (visitors && Object.keys(visitors).length > 0) {
                    // Cloudflare KV is not a transactional database. The legacy
                    // `visitors` hot cache is only a compatibility mirror; bucket
                    // storage is the primary sync source for save/pull convergence.
                    const visitorBucketCache = await preloadVisitorBucketsForKeys(env, licenseKey, Object.entries(visitors).map(([key, value]) => ({
                        key,
                        site: value?.site || body.site || String(key).split('_')[0] || 'SITE_A'
                    })));
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
                        const prevUpdated = Number(prev.updatedAt || 0);
                        const incomingUpdated = Number(normalizedVisitor?.updatedAt || 0);
                        const prevVersion = Number(prev.version || 0);
                        const incomingVersion = Number(normalizedVisitor?.version || 0);
                        const trustedIncomingVersion = isTrustedVersionCandidate(prevVersion, incomingVersion, trustedSyncDevice);
                        const accepted = shouldAcceptAuthoritativeMutation(prev, normalizedVisitor, trustedSyncDevice);
                        console.log("VISITOR CONFLICT", { key, prevUpdated, incomingUpdated, prevVersion, incomingVersion, trustedIncomingVersion, trustedSyncDevice, accepted, authority: 'bucket' });
                        if (!accepted) {
                            console.log(JSON.stringify({ type:"VISITOR_MUTATION_REJECTED", key: sanitizeText(key, 160), reason:"stale_or_untrusted_mutation", trustedSyncDevice, prevVersion, incomingVersion, authority: 'bucket', updatedAt: Date.now() }));
                            continue;
                        }
                        const mutationClock = buildAuthoritativeMutationClock(prev, normalizedVisitor, trustedSyncDevice, mutationId);
                        acceptedVisitors[key] = sanitizeVisitorEntity(stampAuthoritativeEntity({ ...sanitizeVisitorEntity(prev), ...normalizedVisitor, licenseKey, lastSync: mutationClock.updatedAt }, mutationClock, mutationId, body.deviceId || getWorkerOriginNode()));
                    }
                    if (Object.keys(acceptedVisitors).length) {
                        const visitorBucketOk = await appendVisitorsToBuckets(env, licenseKey, acceptedVisitors);
                        if (!visitorBucketOk) throw new Error('AUTHORITATIVE_VISITOR_BUCKET_SAVE_FAILED');
                        // Hot cache mirror must append/merge to avoid corrupt rolling snapshots.
                        // It remains non-authoritative and may be stale under KV eventual consistency.
                        const existingHotVisitors = await getData(env, 'visitors');
                        const hotVisitors = mergeHotVisitorMirror(existingHotVisitors, acceptedVisitors, MAX_HOT_VISITORS);
                        const hotVisitorsOk = await saveData(env, 'visitors', hotVisitors);
                        if (!hotVisitorsOk) console.warn('[VISITOR_HOT_CACHE] Legacy hot cache mirror failed; bucket storage remains authoritative');
                    }
                }
                
                if (Array.isArray(logs) && logs.length > 0) {
                    // Logs are appended to authoritative buckets directly. The
                    // legacy `logs` hot cache is never used for authoritative
                    // dedupe/merge because Cloudflare KV reads can be stale.
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
                    if (logs.length > maxIncomingLogs) {
                        console.log(JSON.stringify({ type:"LOG_BATCH_TRUNCATED", licenseKey, received: logs.length, processed: maxIncomingLogs, updatedAt: Date.now() }));
                    }
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
                                rejectedExpired.push({
                                    reg: log.reg,
                                    action: log.action,
                                    site,
                                    message: "BADGE VISITOR SUDAH EXPIRED. Silakan lakukan registrasi ulang."
                                });
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
                    if (appendOnly.length) {
                        const bucketOk = await appendLogsToBuckets(env, licenseKey, appendOnly);
                        if (!bucketOk) throw new Error('AUTHORITATIVE_LOG_BUCKET_SAVE_FAILED');
                        const hotLogMirror = appendOnly.map(item => ({ ...item, source: 'legacy_hot_cache' }));
                        // Hot cache mirror is append-style only; bucket logs remain authoritative.
                        const existingHotLogs = await getData(env, 'logs');
                        const mergedLogs = mergeHotLogMirror(existingHotLogs, hotLogMirror, MAX_HOT_LOGS);
                        const hotCacheOk = await saveData(env, 'logs', mergedLogs);
                        if (!hotCacheOk) console.warn('[LOG_HOT_CACHE] Legacy hot cache mirror failed; bucket storage remains authoritative');
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
                            const pendingQueue = await getData(env, 'pending_gas_queue');
                            const mergedQueue = mergeGasQueueUnique(pendingQueue, gasLogs);
                            const queueLimit = getPendingQueueLimit(company.package);
                            if (mergedQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: company.package, before: mergedQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                            await saveDataOrThrow(env, 'pending_gas_queue', mergedQueue.slice(-queueLimit));
                        }
                    }
                    if (rejectedExpired.length) {
                        let reports = await getData(env, 'anti_nakal_reports');
                        for (const rejected of rejectedExpired) {
                            const reportTs = Date.now();
                            reports.unshift({
                                type: "EXPIRED_VISITOR_BLOCKED",
                                ...rejected,
                                licenseKey,
                                deviceId: sanitizeText(body.deviceId, 120),
                                version: 1,
                                updatedAt: reportTs,
                                timestamp: reportTs
                            });
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
                            const pendingQueue = await getData(env, 'pending_gas_queue');
                            const mergedQueue = mergeGasQueueUnique(pendingQueue, visitorEvents.map(log => ({ ...log, gasReplayId: generateGasReplayId(log) })));
                            const queueLimit = getPendingQueueLimit(company.package);
                            await saveDataOrThrow(env, 'pending_gas_queue', mergedQueue.slice(-queueLimit));
                        }
                    }
                    await appendVisitorsToSheet(env, licenseKey, acceptedVisitors);
                }
                
                if (anti && Object.keys(anti).length > 0) {
                    let reports = await getData(env, 'anti_nakal_reports');
                    const antiTs = Date.now();
                    reports.unshift({
                        ...anti,
                        licenseKey,
                        deviceId: sanitizeText(body.deviceId, 120),
                        site: sanitizeText(body.site, 80),
                        version: Math.max(1, Number(anti.version || 0)),
                        updatedAt: Number(anti.updatedAt || antiTs),
                        timestamp: antiTs
                    });
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
                    if (replayId) {
                        await recordReplayFailure(env, replayId, licenseKey, body.deviceId || null, mutationErr);
                    }
                    throw mutationErr;
                } finally {
                    if (replayInFlightKey) {
                        globalThis.__vms_inflight_replays.delete(replayInFlightKey);
                    }
                }
                });
            }

            if (path === '/pull' && request.method === 'GET') {
                const licenseKey = url.searchParams.get('licenseKey') || "";
                const sinceRaw = url.searchParams.get('since') || "0";
                const siteFilter = url.searchParams.get('site') || "";
                const since = Number(sinceRaw) || 0;
                if (!licenseKey) {
                    return new Response(JSON.stringify({ ok: false, message: 'licenseKey required' }), { headers: corsHeaders, status: 400 });
                }
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company) {
                    return json({ ok: false, message: 'Invalid licenseKey' }, 403);
                }
                // Pull is intentionally bucket-only. The legacy hot visitor cache can lag
                // or regress under KV eventual consistency, so it is not merged here.
                const bucketVisitors = await getRecentVisitorBuckets(env, licenseKey, siteFilter, since, MAX_PULL_VISITORS_DEFAULT);
                const visitors = {};
                const MAX_PULL_VISITORS = MAX_PULL_VISITORS_DEFAULT;
                let visitorCount = 0;
                const appendPullVisitor = (key, v) => {
                    if (visitorCount >= MAX_PULL_VISITORS) return;
                    if (v?.licenseKey !== licenseKey) return;
                    if (siteFilter && !(key.startsWith(`${siteFilter}_`) || v?.site === siteFilter)) return;
                    if (Number(v?.updatedAt || 0) >= since || Number(v?.lastSync || 0) >= since){
                        const current = visitors[key];
                        if (shouldPreferEntity(current, v)) {
                            if (!current) visitorCount++;
                            visitors[key] = sanitizeVisitorForPull(v);
                        }
                    }
                };
                for (const [key, v] of Object.entries(bucketVisitors || {})) appendPullVisitor(key, v);
                const MAX_PULL_LOGS = MAX_PULL_LOGS_DEFAULT;
                // Pull is intentionally bucket-only. The legacy hot log cache remains a
                // best-effort write-through cache for compatibility, not a read source.
                const bucketLogs = await getRecentLogBuckets(env, licenseKey, since, MAX_PULL_LOGS * 3);
                const MAX_PULL_SCAN_LOGS = MAX_PULL_LOGS * 4;
                let scannedLogs = 0;
                const dedupeMap = new Map();
                const appendPullLog = (l) => {
                    if (scannedLogs >= MAX_PULL_SCAN_LOGS) return;
                    if (l?.licenseKey !== licenseKey) return;
                    if (siteFilter && l?.site !== siteFilter) return;
                    const logTs = Number(l?.persistedAt || l?.commitClock || 0) || Date.parse(l?.time || 0);
                    if (!(logTs >= since)) return;
                    scannedLogs++;
                    const nextLog = Object.assign({}, l, { sequenceId: l.sequenceId || generateSequenceId(licenseKey, Number(l?.persistedAt || Date.now())) });
                    const dedupeKey = nextLog.sequenceId || buildCanonicalLogKey(nextLog);
                    const current = dedupeMap.get(dedupeKey);
                    if (shouldPreferEntity(current, nextLog)) {
                        dedupeMap.set(dedupeKey, nextLog);
                    }
                    if (dedupeMap.size > MAX_PULL_LOGS * 2) {
                        evictOldestMapEntry(dedupeMap);
                    }
                };
                for (const l of bucketLogs) appendPullLog(l);
                const dedupedLogs = Array.from(dedupeMap.values())
                    .sort((a,b) => (Number(a?.persistedAt || 0) || Date.parse(a?.time || 0)) - (Number(b?.persistedAt || 0) || Date.parse(b?.time || 0)))
                    .slice(-MAX_PULL_LOGS);
                console.log("AUTHORITATIVE LOG SORT", { total: dedupedLogs.length });
                console.log('PULL DEDUPE', { before: scannedLogs, after: dedupedLogs.length, scanLimit: MAX_PULL_SCAN_LOGS });
                return new Response(JSON.stringify({ ok: true, visitors, logs: dedupedLogs, serverTs: Date.now() }), { headers: corsHeaders });
            }

            if (path === '/retry-gas-sync' && request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const companyPackage = body?.packageName || body?.package || 'PRO';
                const queueLimit = getPendingQueueLimit(companyPackage);
                const now = Date.now();
                const orphanThresholdMs = 60000;
                const rawProcessingQueue = await getData(env, 'processing_gas_queue');
                const normalizedProcessing = normalizeGasQueueEntries(rawProcessingQueue);
                const orphanEntries = [];
                const activeProcessingEntries = [];
                for (const entry of normalizedProcessing) {
                    if (Number.isFinite(entry.processingStartedAt) && (now - entry.processingStartedAt) > orphanThresholdMs) {
                        orphanEntries.push(entry);
                        continue;
                    }
                    activeProcessingEntries.push(entry);
                }

                let pendingQueue = await getData(env, 'pending_gas_queue');
                const normalizedPendingBase = normalizeGasQueueEntries(pendingQueue);
                pendingQueue = orphanEntries.length ? mergeGasQueueUnique(normalizedPendingBase, orphanEntries) : normalizedPendingBase;
                if (pendingQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: companyPackage, before: pendingQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                pendingQueue = pendingQueue.slice(-queueLimit);
                await saveData(env, 'pending_gas_queue', pendingQueue);
                await saveData(env, 'processing_gas_queue', activeProcessingEntries.slice(-queueLimit));

                if (!Array.isArray(pendingQueue) || pendingQueue.length === 0) {
                    return new Response(JSON.stringify({ ok: true, replayed: 0, remaining: 0, recoveredOrphans: orphanEntries.length }), { headers: corsHeaders });
                }
                const batchSize = Math.max(1, Math.min(1000, Number(body?.batchSize || 250)));
                const normalizedPending = normalizeGasQueueEntries(pendingQueue);
                const batch = [];
                const processingStartedAt = Date.now();
                for (let i = 0; i < Math.min(batchSize, normalizedPending.length); i++) {
                    batch.push(Object.assign({}, normalizedPending[i], { processingStartedAt }));
                }
                const remainingPending = normalizedPending.slice(batch.length);
                let processingQueue = await getData(env, 'processing_gas_queue');
                processingQueue = mergeGasQueueUnique(processingQueue, batch);
                await saveData(env, 'pending_gas_queue', remainingPending.slice(-queueLimit));
                await saveData(env, 'processing_gas_queue', processingQueue.slice(-queueLimit));
                const gasOk = await pushLogsToGoogleScript(batch, { hmacSecret: env.VMS_GAS_HMAC_SECRET || env.GAS_HMAC_SECRET || "" });
                console.log(JSON.stringify({ type: gasOk ? "PENDING_GAS_REPLAY_SENT" : "PENDING_GAS_REPLAY_FAILED", registerCount: batch.filter(log => normalizeAction(log.action) === ACTION_TYPES.REGISTER || normalizeAction(log.action) === ACTION_TYPES.WALK_IN).length, activityCount: batch.filter(log => normalizeAction(log.action) === ACTION_TYPES.CHECK_IN || normalizeAction(log.action) === ACTION_TYPES.CHECK_OUT).length, updatedAt:getWIBISO() }));
                if (!gasOk) {
                    processingQueue = await getData(env, 'processing_gas_queue');
                    const retryQueue = mergeGasQueueUnique(remainingPending, processingQueue);
                    if (retryQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: companyPackage, before: retryQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                    await saveData(env, 'pending_gas_queue', retryQueue.slice(-queueLimit));
                    await saveData(env, 'processing_gas_queue', []);
                    return new Response(JSON.stringify({ ok: false, replayed: 0, remaining: retryQueue.length }), { headers: corsHeaders, status: 502 });
                }
                processingQueue = await getData(env, 'processing_gas_queue');
                const processedIds = new Set(batch.map(log => log.gasReplayId).filter(Boolean));
                const remainingProcessing = normalizeGasQueueEntries(processingQueue).filter(log => !processedIds.has(log.gasReplayId));
                await saveData(env, 'processing_gas_queue', remainingProcessing.slice(-queueLimit));
                return new Response(JSON.stringify({ ok: true, replayed: batch.length, remaining: remainingPending.length }), { headers: corsHeaders });
            }
            
            // ==================== SYNC USERS MODULE ====================
            if (path === '/sync-users' && request.method === 'POST') {
                const body = await request.json();
                if (body.users && Array.isArray(body.users)) {
                    let serverUsers = await getData(env, 'users_from_clients');
                    for (const user of body.users) {
                        const existing = serverUsers.find(u => u.username === user.username);
                        if (!existing) {
                            serverUsers.push(user);
                        }
                    }
                    await saveData(env, 'users_from_clients', serverUsers);
                    return new Response(JSON.stringify({ ok: true, users: serverUsers }), { headers: corsHeaders });
                }
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
            }
            
            // ==================== CRON MODULE ====================
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
                
                if (updated) {
                    await saveData(env, 'companies', companies);
                }
                
                return new Response(JSON.stringify({ ok: true, updated: updated }), { headers: corsHeaders });
            }
            
            // ==================== 404 HANDLER ====================
            return new Response(JSON.stringify({ ok: false, error: 'Endpoint not found: ' + path }), { 
                status: 404, 
                headers: corsHeaders 
            });
            
        } catch (error) {
            console.error('Worker error:', error);
            return new Response(JSON.stringify({ ok: false, error: error.message }), { 
                status: 500, 
                headers: corsHeaders 
            });
        }
    }
};

// ==================== KV STORAGE LAYER ====================

async function forceInit(env) {
    console.log('[FORCE_INIT] Starting initialization...');
    
    try {
        // Test KV access first
        const testKey = '__vms_test__';
        await env.VMS_STORAGE.put(testKey, 'test');
        const testVal = await env.VMS_STORAGE.get(testKey);
        console.log(`[FORCE_INIT] KV test: ${testVal === 'test' ? 'OK' : 'FAILED'}`);
        
        // ========== INIT ADMINS ==========
        let admins = await getData(env, 'admins');
        
        if (!admins || admins.length === 0) {
            console.log('[FORCE_INIT] No admins found, creating default...');
            
            const defaultHash = await sha256('123456');
            console.log(`[FORCE_INIT] Default admin hash: ${defaultHash.substring(0, 20)}...`);
            
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
                if (!admin.token) {
                    admin.token = null;
                    needsSave = true;
                }
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
        
        // ========== INIT SETTINGS ==========
        let settings = await getData(env, 'settings');
        if (!settings || Object.keys(settings).length === 0) {
            console.log('[FORCE_INIT] Creating default settings...');
            settings = {
                pricing: {
                    BASIC: { price: 500000, maxDevices: 10, extraDeviceFee: 50000 },
                    PRO: { price: 2000000, maxDevices: 999, extraDeviceFee: 0 }
                },
                general: { 
                    tax: 11,
                    company: "VMS System",
                    version: "3.0"
                }
            };
            await saveData(env, 'settings', settings);
            console.log('[FORCE_INIT] Default settings created');
        }
        
        // ========== INIT EMPTY COLLECTIONS ==========
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

// ==================== KV GET DATA ====================
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
        const itemCount = Array.isArray(parsed) ? parsed.length + ' items' : Object.keys(parsed).length + ' keys';
        console.log(`[GET_DATA] Retrieved "${key}": ${itemCount}`);
        return parsed;
        
    } catch (e) {
        console.error(`[GET_DATA] Error for key "${key}":`, e);
        return getDefaultData(key);
    }
}

// ==================== KV SAVE DATA ====================

async function saveDataIfChangedFromJson(env, key, originalJson, nextData) {
    const nextJson = JSON.stringify(nextData || (Array.isArray(nextData) ? [] : {}));
    if (nextJson === originalJson) {
        console.log(`[SAVE_DATA] Reconcile no-op skip for "${key}": unchanged`);
        return true;
    }
    return saveData(env, key, nextData);
}

async function saveData(env, key, data) {
    try {
        if (!env || !env.VMS_STORAGE) {
            console.error(`[SAVE_DATA] KV Storage not available for key: ${key}`);
            return false;
        }
        
        const jsonString = JSON.stringify(data);
        const fingerprint = await stablePayloadFingerprint(jsonString);
        if (!globalThis.__vms_kv_write_fingerprints) {
            globalThis.__vms_kv_write_fingerprints = new Map();
        }
        if (globalThis.__vms_kv_write_fingerprints.get(key) === fingerprint) {
            const confirmedIdentical = await confirmExistingPayloadFingerprint(env, key, fingerprint);
            if (confirmedIdentical) {
                console.log(`[SAVE_DATA] Skipped confirmed identical payload for "${key}": ${jsonString.length} bytes`);
                return true;
            }
            console.warn(`[SAVE_DATA] Fingerprint cache stale for "${key}"; rewriting payload to avoid cross-isolate skip race`);
        }
        await env.VMS_STORAGE.put(key, jsonString);
        if (key === 'devices') invalidateDeviceIndexCache();
        globalThis.__vms_kv_write_fingerprints.set(key, fingerprint);
        pruneFingerprintCache();
        const itemCount = Array.isArray(data) ? data.length + ' items' : Object.keys(data || {}).length + ' keys';
        console.log(`[SAVE_DATA] Saved "${key}": ${jsonString.length} bytes, ${itemCount}`);
        return true;
        
    } catch (e) {
        console.error(`[SAVE_DATA] Error for key "${key}":`, e);
        return false;
    }
}


async function saveDataOrThrow(env, key, data) {
    const maxAttempts = 3;
    let lastOk = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        lastOk = await saveData(env, key, data);
        if (lastOk) return true;
        if (attempt < maxAttempts) {
            const backoffMs = 50 * Math.pow(2, attempt - 1);
            console.warn(`[SAVE_DATA] Retry ${attempt}/${maxAttempts - 1} for key "${key}" after ${backoffMs}ms`);
            await sleep(backoffMs);
        }
    }
    throw new Error(`AUTHORITATIVE_SAVE_FAILED:${key}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function sanitizeText(value, max = 120) {
    const normalized = String(value || '').normalize('NFC');
    try {
        const unicodeControlPattern = new RegExp('\\p{C}', 'gu');
        return normalized
            .replace(unicodeControlPattern, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max);
    } catch (regexErr) {
        console.warn('[SANITIZE] Unicode property escape unsupported, using control-char fallback:', regexErr?.message || regexErr);
        return normalized
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max);
    }
}

function clonePayloadSafe(value) {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
    } catch (cloneErr) {
        console.warn('[CLONE] structuredClone failed, falling back to bounded clone:', cloneErr?.message || cloneErr);
    }
    const stats = { truncatedArrays: 0, truncatedObjects: 0, depthTruncations: 0 };
    const cloned = boundedClone(value || (Array.isArray(value) ? [] : {}), 0, stats);
    if (stats.truncatedArrays || stats.truncatedObjects || stats.depthTruncations) {
        console.warn('[CLONE] Bounded clone truncated payload', { ...stats, updatedAt: Date.now() });
    }
    return cloned;
}

function boundedClone(value, depth = 0, stats = { truncatedArrays: 0, truncatedObjects: 0, depthTruncations: 0 }) {
    if (value === null || typeof value !== 'object') return value;
    if (depth > 6) {
        stats.depthTruncations++;
        return null;
    }
    if (Array.isArray(value)) {
        const arr = [];
        const limit = Math.min(value.length, 2000);
        if (value.length > limit) stats.truncatedArrays++;
        for (let i = 0; i < limit; i++) arr.push(boundedClone(value[i], depth + 1, stats));
        return arr;
    }
    const out = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
        if (count++ >= 5000) {
            stats.truncatedObjects++;
            break;
        }
        out[key] = boundedClone(item, depth + 1, stats);
    }
    return out;
}



const VISITOR_STORAGE_WHITELIST = new Set([
    'id', 'reg', 'name', 'nama', 'company', 'perusahaan', 'category', 'kategori', 'purpose', 'tujuan',
    'checkIn', 'checkOut', 'start', 'startDate', 'exp', 'expDate', 'pic', 'dept', 'note', 'keterangan',
    'site', 'licenseKey', 'companyId', 'companyName', 'version', 'updatedAt', 'lastSync', 'firstSeen', 'lastSeen',
    'mutationId', 'lastMutationId', 'commitClock', 'mutationEpoch', 'writeEpoch', 'mutationSource', 'source'
]);

const LOG_STORAGE_WHITELIST = new Set([
    'id', 'reg', 'action', 'time', 'logTime', 'site', 'deviceId', 'deviceName', 'location',
    'sequenceId', 'gasReplayId', 'licenseKey', 'companyId', 'companyName', 'version', 'updatedAt', 'persistedAt',
    'mutationId', 'lastMutationId', 'commitClock', 'mutationEpoch', 'writeEpoch', 'mutationSource', 'source', 'bucketKey'
]);

function sanitizeWhitelistedEntity(raw = {}, whitelist = new Set(), maxString = 500) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, value] of Object.entries(raw)) {
        if (!whitelist.has(key)) continue;
        if (value === undefined) continue;
        if (typeof value === 'string') out[key] = sanitizeText(value, maxString);
        else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0;
        else if (typeof value === 'boolean' || value === null) out[key] = value;
        else if (Array.isArray(value)) out[key] = value.slice(0, 50).map(item => typeof item === 'string' ? sanitizeText(item, 200) : boundedClone(item, 0));
        else out[key] = boundedClone(value, 0);
    }
    return out;
}

function sanitizeVisitorEntity(raw = {}) {
    return sanitizeWhitelistedEntity(raw, VISITOR_STORAGE_WHITELIST, 500);
}

function sanitizeLogEntity(raw = {}) {
    return sanitizeWhitelistedEntity(raw, LOG_STORAGE_WHITELIST, 500);
}

function buildAuthoritativeMutationClock(previous = {}, incoming = {}, trustedDevice = false, mutationId = '') {
    const now = Date.now();
    const prevVersion = Math.max(0, Number(previous.version || 0));
    const incomingVersion = Math.max(0, Number(incoming.version || 0));
    const prevEpoch = Math.max(0, Number(previous.mutationEpoch || previous.writeEpoch || previous.updatedAt || 0));
    const rawIncomingEpoch = Math.max(0, Number(incoming.mutationEpoch || incoming.writeEpoch || incoming.updatedAt || 0));
    const incomingEpoch = clampIncomingClock(rawIncomingEpoch, now, mutationId || incoming.mutationId || incoming.lastMutationId || '');
    const prevCommitClock = Math.max(0, Number(previous.commitClock || previous.updatedAt || previous.persistedAt || 0));
    const rawIncomingCommitClock = Math.max(0, Number(incoming.commitClock || incoming.updatedAt || incoming.persistedAt || 0));
    const incomingCommitClock = clampIncomingClock(rawIncomingCommitClock, now, mutationId || incoming.mutationId || incoming.lastMutationId || '');
    const maxTrustedJump = trustedDevice ? 50 : 5;
    const trustedIncomingVersion = incomingVersion > prevVersion && incomingVersion <= prevVersion + maxTrustedJump
        ? incomingVersion
        : 0;
    const nextVersion = Math.max(1, trustedIncomingVersion || prevVersion + 1);
    const commitClock = Math.max(now, prevCommitClock + 1, incomingCommitClock);
    const mutationEpoch = Math.max(commitClock, prevEpoch + 1, incomingEpoch);
    return {
        version: nextVersion,
        updatedAt: commitClock,
        commitClock,
        mutationEpoch,
        lastMutationId: sanitizeText(mutationId || incoming.mutationId || incoming.lastMutationId || previous.lastMutationId || '', 180)
    };
}



function shouldAcceptAuthoritativeMutation(previous = {}, incoming = {}, trustedDevice = false) {
    if (!previous || Object.keys(previous).length === 0) return true;
    const now = Date.now();
    const prevVersion = Math.max(0, Number(previous.version || 0));
    const incomingVersion = Math.max(0, Number(incoming.version || 0));
    if (!isTrustedVersionCandidate(prevVersion, incomingVersion, trustedDevice)) return false;
    const prevEpoch = Math.max(0, Number(previous.mutationEpoch || previous.writeEpoch || previous.updatedAt || 0));
    const rawIncomingEpoch = Math.max(0, Number(incoming.mutationEpoch || incoming.writeEpoch || incoming.updatedAt || 0));
    const incomingEpoch = clampIncomingClock(rawIncomingEpoch, now, incoming.mutationId || incoming.lastMutationId || '');
    if (incomingEpoch && prevEpoch && incomingEpoch < prevEpoch) return false;
    const prevCommitClock = Math.max(0, Number(previous.commitClock || previous.updatedAt || previous.persistedAt || 0));
    const rawIncomingCommitClock = Math.max(0, Number(incoming.commitClock || incoming.updatedAt || incoming.persistedAt || 0));
    const incomingCommitClock = clampIncomingClock(rawIncomingCommitClock, now, incoming.mutationId || incoming.lastMutationId || '');
    if (incomingCommitClock && prevCommitClock && incomingCommitClock < prevCommitClock) return false;
    return incomingVersion > prevVersion || incomingEpoch >= prevEpoch || incomingCommitClock >= prevCommitClock;
}

function stampAuthoritativeEntity(entity = {}, clock = {}, mutationId = '', mutationSource = '') {
    const commitClock = Number(clock.commitClock || clock.updatedAt || Date.now());
    return {
        ...entity,
        version: Math.max(1, Number(clock.version || entity.version || 1)),
        updatedAt: commitClock,
        commitClock,
        mutationEpoch: Number(clock.mutationEpoch || commitClock),
        lastMutationId: sanitizeText(clock.lastMutationId || mutationId || entity.lastMutationId || '', 180),
        mutationId: sanitizeText(mutationId || entity.mutationId || '', 180),
        writeEpoch: Number(clock.mutationEpoch || commitClock),
        mutationSource: sanitizeText(mutationSource || entity.mutationSource || getWorkerOriginNode(), 120)
    };
}

function pruneHotVisitors(visitors, limit = MAX_HOT_VISITORS) {
    if (!visitors || typeof visitors !== 'object' || Array.isArray(visitors)) return {};
    const entries = Object.entries(visitors);
    if (entries.length <= limit) return visitors;
    entries.sort((a, b) => Number(b[1]?.updatedAt || b[1]?.lastSync || 0) - Number(a[1]?.updatedAt || a[1]?.lastSync || 0));
    return Object.fromEntries(entries.slice(0, limit));
}

function pruneHotLogs(logs, limit = MAX_HOT_LOGS) {
    if (!Array.isArray(logs)) return [];
    if (logs.length <= limit) return logs;
    // Root logs are maintained append-only; keep the newest append window without O(N log N) resorting.
    return logs.slice(-limit);
}

function mergeHotVisitorMirror(existingHotVisitors, incomingVisitors, limit = MAX_HOT_VISITORS) {
    const merged = {};
    if (existingHotVisitors && typeof existingHotVisitors === 'object' && !Array.isArray(existingHotVisitors)) {
        for (const [key, visitor] of Object.entries(existingHotVisitors)) merged[key] = sanitizeVisitorEntity(visitor);
    }
    for (const [key, visitor] of Object.entries(incomingVisitors || {})) {
        const candidate = sanitizeVisitorEntity({ ...visitor, source: 'legacy_hot_cache' });
        if (shouldPreferEntity(merged[key], candidate)) merged[key] = candidate;
    }
    return pruneHotVisitors(merged, limit);
}

function mergeHotLogMirror(existingHotLogs, incomingLogs, limit = MAX_HOT_LOGS) {
    const byDedupeKey = new Map();
    const keyIndex = new Map();
    if (Array.isArray(existingHotLogs)) {
        for (const log of existingHotLogs) upsertLogDedupeCandidate(byDedupeKey, keyIndex, log);
    }
    for (const log of (Array.isArray(incomingLogs) ? incomingLogs : [])) upsertLogDedupeCandidate(byDedupeKey, keyIndex, log);
    const merged = Array.from(byDedupeKey.values())
        .sort((a, b) => (Number(a?.persistedAt || 0) || Date.parse(a?.time || 0)) - (Number(b?.persistedAt || 0) || Date.parse(b?.time || 0)));
    return pruneHotLogs(merged, limit);
}

async function stablePayloadFingerprint(jsonString = '') {
    const bytes = new TextEncoder().encode(String(jsonString));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pruneFingerprintCache() {
    const cache = globalThis.__vms_kv_write_fingerprints;
    if (!cache || cache.size <= 512) return;
    for (const key of Array.from(cache.keys()).slice(0, cache.size - 512)) cache.delete(key);
}


async function confirmExistingPayloadFingerprint(env, key, fingerprint) {
    try {
        if (!env?.VMS_STORAGE?.get) return false;
        const existing = await env.VMS_STORAGE.get(key);
        if (typeof existing !== 'string') return false;
        return (await stablePayloadFingerprint(existing)) === fingerprint;
    } catch (err) {
        console.warn(`[SAVE_DATA] Could not confirm fingerprint for "${key}":`, err?.message || err);
        return false;
    }
}

function clampIncomingClock(rawClock, now = Date.now(), mutationId = '') {
    const safeClock = Number(rawClock || 0);
    if (!Number.isFinite(safeClock) || safeClock <= 0) return 0;
    if (safeClock > now + MAX_CLOCK_FUTURE_DRIFT_MS) {
        console.warn('[MUTATION_CLOCK] Future clock quarantined', { mutationId: sanitizeText(mutationId, 180), rawClock: safeClock, now, maxFutureDriftMs: MAX_CLOCK_FUTURE_DRIFT_MS });
        return 0;
    }
    return safeClock;
}

function getSourcePriority(entity = {}) {
    const source = String(entity?.source || '').toLowerCase();
    if (source === 'bucket_authoritative') return 4;
    if (entity?.replayId || entity?.gasReplayId) return 3;
    if (source === 'legacy_hot_cache') return 2;
    return 1;
}

function shouldPreferEntity(current, incoming) {
    if (!current) return true;
    const currentPriority = getSourcePriority(current);
    const incomingPriority = getSourcePriority(incoming);
    if (incomingPriority !== currentPriority) return incomingPriority > currentPriority;
    return isIncomingEntityNewer(current, incoming);
}

function evictOldestMapEntry(map) {
    if (!map || typeof map.entries !== 'function' || map.size === 0) return;
    let oldestKey;
    let oldestTs = Infinity;
    for (const [key, value] of map.entries()) {
        const ts = Number(value?.persistedAt || value?.commitClock || value?.updatedAt || 0) || Date.parse(value?.time || 0) || 0;
        if (ts < oldestTs) {
            oldestTs = ts;
            oldestKey = key;
        }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
}

function rememberCappedSet(set, value, maxSize = MAX_SAVE_DEDUPE_KEYS) {
    set.add(value);
    if (set.size > maxSize) {
        const oldest = set.values().next().value;
        set.delete(oldest);
    }
}

function getMutationIdsFromRows(rows) {
    const ids = new Set();
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const id = sanitizeText(row?.mutationId || row?.lastMutationId || '', 180);
        if (id) ids.add(id);
        if (ids.size >= 32) break;
    }
    return Array.from(ids);
}

async function persistBucketCommitMarkers(env, mutationIds, marker = {}) {
    if (!Array.isArray(mutationIds) || mutationIds.length === 0) return;
    const now = Date.now();
    await limitedMap(mutationIds, 4, async mutationId => {
        const key = `bucket_commit_${sanitizeText(mutationId, 180)}`;
        const existing = await getData(env, key);
        const history = Array.isArray(existing?.history) ? existing.history.slice(-8) : [];
        history.push({ status: marker.status, type: marker.type, updatedAt: now, touchedBuckets: marker.touchedBuckets || [] });
        const payload = {
            mutationId,
            type: marker.type,
            status: marker.status,
            licenseKey: marker.licenseKey,
            buckets: marker.buckets || [],
            touchedBuckets: marker.touchedBuckets || [],
            updatedAt: now,
            incomplete: marker.status === 'INCOMPLETE',
            history
        };
        await saveData(env, key, payload);
    });
}

function pruneMapToMax(map, maxSize) {
    if (!map || typeof map.keys !== 'function' || map.size <= maxSize) return;
    for (const key of map.keys()) {
        map.delete(key);
        if (map.size <= maxSize) break;
    }
}

function pruneInflightReplayCache() {
    pruneMapToMax(globalThis.__vms_inflight_replays, MAX_GLOBAL_INFLIGHT_REPLAYS);
}

function pruneRuntimeBucketCache(now = Date.now()) {
    const cache = globalThis.__vms_runtime_bucket_cache;
    if (!cache || typeof cache.entries !== 'function') return;
    for (const [key, entry] of cache.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= now) cache.delete(key);
    }
    pruneMapToMax(cache, MAX_RUNTIME_BUCKET_CACHE_ENTRIES);
}

function setRuntimeBucketCache(key, value, ttlMs = RUNTIME_BUCKET_CACHE_TTL_MS) {
    const cache = globalThis.__vms_runtime_bucket_cache;
    if (!cache || !key) return;
    cache.set(key, { value: clonePayloadSafe(value), expiresAt: Date.now() + ttlMs });
    pruneRuntimeBucketCache();
}

async function getRuntimeCachedBucketData(env, key, ttlMs = RUNTIME_BUCKET_CACHE_TTL_MS) {
    // Short-lived isolate cache is an optimization only. KV buckets remain the
    // authoritative storage and stale runtime cache must never decide writes.
    const cache = globalThis.__vms_runtime_bucket_cache;
    const now = Date.now();
    const cached = cache?.get(key);
    if (cached && Number(cached.expiresAt || 0) > now) return clonePayloadSafe(cached.value);
    const value = await getData(env, key);
    setRuntimeBucketCache(key, value, ttlMs);
    return value;
}

function isTrustedVersionCandidate(prevVersion, incomingVersion, trustedDevice = false) {
    // Temporarily trust all version candidates. Previous jump-limit checks caused
    // version poisoning: otherwise valid device mutations were rejected before
    // they could reach the authoritative KV buckets.
    return true;
}

function normalizeReplayEntries(entries, nowTs = Date.now()) {
    if (!Array.isArray(entries)) return [];
    const normalized = [];
    for (const item of entries) {
        if (typeof item === "string") {
            normalized.push(buildReplayEntry({ id: item, ts: nowTs, status: 'PROCESSED' }));
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        const ts = Number(item.ts || item.updatedAt || nowTs);
        normalized.push(buildReplayEntry({ ...item, id: sanitizeText(item.id, 180), ts }));
    }
    return pruneReplayEntries(normalized, nowTs);
}


async function recordReplayFailure(env, replayId, licenseKey, deviceId, error) {
    try {
        const failedAt = Date.now();
        const normalizedReplay = await loadReplayGovernanceEntries(env, replayId, failedAt);
        const previous = getReplayGovernanceState(normalizedReplay, replayId);
        const retryCount = Number(previous?.retryCount || 0) + 1;
        const status = retryCount >= getReplayMaxRetry() ? 'DEAD_LETTER' : 'FAILED';
        const withoutCurrent = normalizedReplay.filter(x => x.id !== replayId);
        withoutCurrent.push(buildReplayEntry({
            id: replayId,
            ts: failedAt,
            licenseKey,
            deviceId,
            status,
            retryCount,
            error: sanitizeText(error?.message || 'mutation_failed', 240)
        }));
        await persistReplayGovernanceEntries(env, replayId, withoutCurrent, failedAt, false);
    } catch (replayErr) {
        console.error('[REPLAY] Failed to record failed replay state:', replayErr?.message || replayErr);
    }
}



function buildReplayEntry(entry = {}) {
    const ts = Number(entry.ts || entry.updatedAt || Date.now());
    const status = String(entry.status || 'PROCESSED').toUpperCase();
    const commitClock = Math.max(ts, Number(entry.commitClock || entry.commitTs || entry.updatedAt || ts));
    const mutationEpoch = Math.max(commitClock, Number(entry.mutationEpoch || entry.writeEpoch || commitClock));
    const finalizedAt = status === 'DEAD_LETTER' ? Math.max(commitClock, Number(entry.finalizedAt || entry.tombstoneClock || commitClock)) : Number(entry.finalizedAt || 0);
    const tombstoneClock = status === 'DEAD_LETTER' ? Math.max(finalizedAt, Number(entry.tombstoneClock || finalizedAt)) : Number(entry.tombstoneClock || 0);
    return {
        ...entry,
        id: sanitizeText(entry.id, 180),
        ts,
        version: Math.max(1, Number(entry.version || 0)),
        updatedAt: commitClock,
        commitClock,
        mutationEpoch,
        writeEpoch: mutationEpoch,
        lastMutationId: sanitizeText(entry.lastMutationId || entry.mutationId || entry.id || '', 180),
        mutationId: sanitizeText(entry.mutationId || entry.id || '', 180),
        mutationSource: sanitizeText(entry.mutationSource || entry.deviceId || getWorkerOriginNode(), 120),
        finalizedAt,
        tombstoneClock,
        final: status === 'DEAD_LETTER' || !!entry.final,
        commitTs: Number(entry.commitTs || commitClock),
        logicalClock: Number(entry.logicalClock || entry.commitTs || commitClock),
        originNode: sanitizeText(entry.originNode || getWorkerOriginNode(), 80),
        status,
        retryCount: Math.max(0, Number(entry.retryCount || 0)),
        maxRetry: getReplayMaxRetry()
    };
}

function getReplayGovernanceState(entries, replayId) {
    if (!replayId || !Array.isArray(entries)) return null;
    let latest = null;
    for (const entry of entries) {
        if (!entry || entry.id !== replayId) continue;
        if (!latest || compareReplayEntries(entry, latest) >= 0) {
            latest = entry;
        }
    }
    return latest;
}

function getReplayMaxRetry() {
    return 5;
}

function pruneReplayEntries(entries, nowTs = Date.now()) {
    if (!Array.isArray(entries)) return [];
    const ttlByStatus = { PROCESSED: REPLAY_PROCESSED_TTL_MS, FAILED: REPLAY_FAILED_TTL_MS, DEAD_LETTER: REPLAY_DEAD_LETTER_TTL_MS };
    const byId = new Map();
    for (const raw of entries) {
        if (!raw || !raw.id) continue;
        const entry = buildReplayEntry(raw);
        const ttl = ttlByStatus[entry.status] || ttlByStatus.PROCESSED;
        const age = nowTs - Number(entry.ts || nowTs);
        if (age > ttl && entry.status !== 'DEAD_LETTER') continue;
        const current = byId.get(entry.id);
        if (!current || compareReplayEntries(entry, current) >= 0) {
            byId.set(entry.id, entry);
        }
    }
    const retained = Array.from(byId.values()).sort((a, b) => Number(a.updatedAt || a.ts || 0) - Number(b.updatedAt || b.ts || 0));
    const deadLetters = retained.filter(entry => entry.status === 'DEAD_LETTER').slice(-500);
    const failed = retained.filter(entry => entry.status === 'FAILED').slice(-300);
    const processed = retained.filter(entry => entry.status === 'PROCESSED').slice(-700);
    return [...processed, ...failed, ...deadLetters].sort(compareReplayEntries).slice(-1200);
}


async function loadReplayGovernanceEntries(env, replayId, nowTs = Date.now()) {
    const central = normalizeReplayEntries(await getData(env, 'processed_replays'), nowTs);
    if (!replayId) return central;
    const bucket = normalizeReplayEntries(await getData(env, getReplayBucketKey(replayId)), nowTs);
    const merged = [];
    for (const item of central) merged.push(item);
    for (const item of bucket) merged.push(item);
    return pruneReplayEntries(merged, nowTs);
}

async function persistReplayGovernanceEntries(env, replayId, entries, nowTs = Date.now(), critical = false) {
    const pruned = pruneReplayEntries(entries, nowTs);
    const central = pruneReplayEntries(pruned, nowTs).slice(-400);
    if (critical) {
        await saveDataOrThrow(env, 'processed_replays', central);
    } else {
        await saveData(env, 'processed_replays', central);
    }
    if (!replayId) return;
    const bucketKey = getReplayBucketKey(replayId);
    const existingBucket = normalizeReplayEntries(await getData(env, bucketKey), nowTs);
    const mergedBucket = [];
    for (const item of existingBucket) mergedBucket.push(item);
    for (const item of pruned) {
        if (item.id === replayId) mergedBucket.push(item);
    }
    const bucketPayload = pruneReplayEntries(mergedBucket, nowTs).slice(-220);
    const bucketOk = await saveData(env, bucketKey, bucketPayload);
    if (!bucketOk) {
        console.warn(`[REPLAY_BUCKET] Failed to save ${bucketKey}; central replay registry remains authoritative`);
    }
}

function getReplayBucketKey(replayId) {
    const clean = sanitizeText(replayId || 'unknown', 180);
    return `processed_replays_b${String(hashToShard(clean, 16)).padStart(2, '0')}`;
}


async function safeAppendLogBucket(env, bucketKey, bucketLogs) {
    const existing = await getData(env, bucketKey);
    const byDedupeKey = new Map();
    const keyIndex = new Map();
    if (Array.isArray(existing)) {
        for (const rawLog of existing) upsertLogDedupeCandidate(byDedupeKey, keyIndex, rawLog);
    }
    for (const rawLog of bucketLogs) upsertLogDedupeCandidate(byDedupeKey, keyIndex, rawLog);
    const next = Array.from(byDedupeKey.values()).sort((a, b) => Number(a?.persistedAt || 0) - Number(b?.persistedAt || 0));
    if (next.length > MAX_BUCKET_LOGS) throw new Error('BUCKET_FULL_RETRY_NEW_SHARD');
    await saveDataOrThrow(env, bucketKey, next);
    setRuntimeBucketCache(bucketKey, next);
    await verifyLogBucketWrite(env, bucketKey, bucketLogs);
    return true;
}

async function safeAppendVisitorBucket(env, bucketKey, entries) {
    const existing = await getData(env, bucketKey);
    const next = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? sanitizeVisitorBucket(existing) : {};
    for (const [key, rawVisitor] of Object.entries(entries || {})) {
        const visitor = sanitizeVisitorEntity(rawVisitor);
        const current = next[key];
        if (shouldPreferEntity(current, visitor)) next[key] = visitor;
    }
    const keys = Object.keys(next);
    if (keys.length > MAX_BUCKET_VISITORS) throw new Error('VISITOR_BUCKET_FULL_RETRY_NEW_SHARD');
    await saveDataOrThrow(env, bucketKey, next);
    setRuntimeBucketCache(bucketKey, next);
    await verifyVisitorBucketWrite(env, bucketKey, entries);
    return true;
}

function sanitizeVisitorBucket(bucket = {}) {
    const out = {};
    for (const [key, visitor] of Object.entries(bucket || {})) out[key] = sanitizeVisitorEntity(visitor);
    return out;
}

async function verifyLogBucketWrite(env, bucketKey, bucketLogs) {
    const verifyRows = await getData(env, bucketKey);
    if (!Array.isArray(verifyRows)) throw new Error(`BUCKET_VERIFY_FAILED:${bucketKey}`);
    const verifyKeys = new Set();
    for (const row of verifyRows) {
        for (const key of getLogDedupeKeys(row)) verifyKeys.add(key);
    }
    for (const log of bucketLogs || []) {
        const hasAnyKey = getLogDedupeKeys(log).some(key => verifyKeys.has(key));
        if (!hasAnyKey) throw new Error(`BUCKET_VERIFY_MISSING_LOG:${bucketKey}`);
    }
}

async function verifyVisitorBucketWrite(env, bucketKey, entries) {
    const verifyRows = await getData(env, bucketKey);
    if (!verifyRows || typeof verifyRows !== 'object' || Array.isArray(verifyRows)) throw new Error(`VISITOR_BUCKET_VERIFY_FAILED:${bucketKey}`);
    for (const key of Object.keys(entries || {})) {
        if (!verifyRows[key]) throw new Error(`VISITOR_BUCKET_VERIFY_MISSING:${bucketKey}:${sanitizeText(key, 80)}`);
    }
}

async function appendLogsToBuckets(env, licenseKey, logs) {
    if (!Array.isArray(logs) || logs.length === 0) return true;
    const grouped = new Map();
    for (const log of logs) {
        const bucketKey = getLogBucketKey(licenseKey, Number(log.persistedAt || Date.now()), buildCanonicalLogKey(log));
        if (!grouped.has(bucketKey)) grouped.set(bucketKey, []);
        grouped.get(bucketKey).push(sanitizeLogEntity({ ...log, source: 'bucket_authoritative', bucketKey }));
    }
    const touchedBuckets = [];
    const mutationIds = getMutationIdsFromRows(logs);
    await persistBucketCommitMarkers(env, mutationIds, { type: 'LOG_BUCKET_COMMIT', status: 'STARTED', licenseKey, buckets: Array.from(grouped.keys()) });
    try {
        const results = await limitedMap(Array.from(grouped.entries()), 6, async ([bucketKey, bucketLogs]) => {
            const saved = await safeAppendLogBucket(env, bucketKey, bucketLogs);
            if (saved) touchedBuckets.push(bucketKey);
            return saved;
        });
        const allCommitted = results.every(Boolean);
        if (!allCommitted) {
            await persistBucketCommitMarkers(env, mutationIds, { type: 'LOG_BUCKET_COMMIT', status: 'INCOMPLETE', licenseKey, buckets: Array.from(grouped.keys()), touchedBuckets });
            return false;
        }
        await updateLogBucketManifest(env, licenseKey, touchedBuckets);
        await persistBucketCommitMarkers(env, mutationIds, { type: 'LOG_BUCKET_COMMIT', status: 'COMMITTED', licenseKey, buckets: Array.from(grouped.keys()), touchedBuckets });
        return true;
    } catch (err) {
        await persistBucketCommitMarkers(env, mutationIds, { type: 'LOG_BUCKET_COMMIT', status: 'INCOMPLETE', licenseKey, buckets: Array.from(grouped.keys()), touchedBuckets, error: sanitizeText(err?.message || err, 240) });
        throw err;
    }
}

async function getRecentLogBuckets(env, licenseKey, since = 0, maxRows = MAX_PULL_LOGS_DEFAULT * 3) {
    const keys = await getRecentLogBucketKeys(env, licenseKey, since);
    const merged = [];
    const bucketRows = await limitedMap(keys, 6, key => getRuntimeCachedBucketData(env, key));
    for (const rows of bucketRows) {
        if (!Array.isArray(rows)) continue;
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (!row) continue;
            merged.push(row);
            if (merged.length >= maxRows) return merged;
        }
    }
    return merged;
}

async function getRecentLogBucketKeys(env, licenseKey, since = 0) {
    const manifest = await getData(env, getLogBucketManifestKey(licenseKey));
    const sinceTs = Number(since || 0);
    const activeDayStart = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    if (Array.isArray(manifest) && manifest.length) {
        return manifest
            .filter(item => item?.key && (!sinceTs || Number(item.updatedAt || 0) >= sinceTs || Number(item.dayStart || 0) >= sinceTs - 86400000 || Number(item.dayStart || 0) >= activeDayStart))
            .sort((a, b) => {
                const dayDelta = Number(b.dayStart || 0) - Number(a.dayStart || 0);
                if (dayDelta) return dayDelta;
                return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
            })
            .map(item => item.key)
            .slice(0, 32);
    }
    const now = Date.now();
    const fallbackKeys = [];
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
        const dayTs = now - dayOffset * 86400000;
        for (let shard = 15; shard >= 0; shard--) fallbackKeys.push(getLogBucketKeyForShard(licenseKey, dayTs, shard));
        fallbackKeys.push(getLegacyLogBucketKey(licenseKey, dayTs));
    }
    return fallbackKeys;
}


async function loadManifestOccMeta(env, manifestKey) {
    const meta = await getData(env, `${manifestKey}_meta`);
    return (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : { version: 0, updatedAt: 0 };
}

function mergeManifestForDirectWrite(latestManifest, nextManifest, manifestType = '') {
    if (!Array.isArray(nextManifest)) return nextManifest;
    const now = Date.now();
    const ttl = String(manifestType).includes('VISITOR') ? VISITOR_MANIFEST_TTL_MS : LOG_MANIFEST_TTL_MS;
    const limit = String(manifestType).includes('VISITOR') ? 256 : 96;
    const byKey = new Map();
    const add = (item) => {
        if (!item?.key) return;
        const updatedAt = Number(item.updatedAt || 0);
        const dayStart = Number(item.dayStart || getLogBucketDayStart(item.key) || 0);
        const active = updatedAt >= now - ttl || dayStart >= now - ttl;
        if (!active) return;
        const current = byKey.get(item.key);
        if (!current || Number(item.updatedAt || 0) >= Number(current.updatedAt || 0)) byKey.set(item.key, item);
    };
    if (Array.isArray(latestManifest)) {
        for (const item of latestManifest) add(item);
    }
    for (const item of nextManifest) add(item);
    return Array.from(byKey.values())
        .sort((a, b) => Number(Boolean(a.retiredAt)) - Number(Boolean(b.retiredAt)) || Number(b.dayStart || 0) - Number(a.dayStart || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, limit);
}

async function saveManifestWithOCC(env, manifestKey, nextManifest, parentMeta, manifestType) {
    // Cloudflare KV is eventually consistent and does not provide transactional
    // compare-and-swap semantics. Treat the manifest as a best-effort bucket
    // index and write it directly instead of rejecting on observed meta drift.
    const latestMeta = await loadManifestOccMeta(env, manifestKey);
    const latestManifest = await getData(env, manifestKey);
    const mergedManifest = mergeManifestForDirectWrite(latestManifest, nextManifest, manifestType);
    const now = Date.now();
    const nextMeta = {
        version: Math.max(Number(latestMeta?.version || 0), Number(parentMeta?.version || 0)) + 1,
        updatedAt: now,
        engine: SYNC_ENGINE,
        syncStrategy: 'DIRECT_KV_MANIFEST_WRITE',
        manifestType
    };
    await saveDataOrThrow(env, manifestKey, mergedManifest);
    await saveDataOrThrow(env, `${manifestKey}_meta`, nextMeta);
    return nextMeta;
}

async function updateLogBucketManifest(env, licenseKey, bucketKeys) {
    const manifestKey = getLogBucketManifestKey(licenseKey);
    const parentMeta = await loadManifestOccMeta(env, manifestKey);
    const now = Date.now();
    const existing = await getData(env, manifestKey);
    const byKey = new Map();
    if (Array.isArray(existing)) {
        for (const item of existing) {
            if (!item?.key) continue;
            const dayStart = Number(item.dayStart || getLogBucketDayStart(item.key));
            const isActive = dayStart >= now - LOG_MANIFEST_TTL_MS || Number(item.updatedAt || 0) >= now - LOG_MANIFEST_TTL_MS;
            if (isActive) byKey.set(item.key, { ...item, dayStart, retiredAt: item.retiredAt || null });
            else if (!item.retiredAt) byKey.set(item.key, { ...item, dayStart, retiredAt: now, cleanupMarker: 'STALE_LOG_BUCKET_RETIRED' });
        }
    }
    for (const key of bucketKeys) {
        byKey.set(key, { key, updatedAt: now, dayStart: getLogBucketDayStart(key), retiredAt: null });
    }
    const next = Array.from(byKey.values())
        .sort((a, b) => Number(Boolean(a.retiredAt)) - Number(Boolean(b.retiredAt)) || Number(b.dayStart || 0) - Number(a.dayStart || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 96);
    await saveManifestWithOCC(env, manifestKey, next, parentMeta, 'LOG_BUCKET_MANIFEST');
    return true;
}

function getLogBucketManifestKey(licenseKey) {
    return `logs_manifest_${sanitizeText(licenseKey || 'unknown', 80) || 'unknown'}`;
}

function getLogBucketDayStart(bucketKey) {
    const match = String(bucketKey || '').match(/_(\d{8})_s\d{2}$/);
    if (!match) return 0;
    const y = match[1].slice(0, 4);
    const m = match[1].slice(4, 6);
    const d = match[1].slice(6, 8);
    return Date.parse(`${y}-${m}-${d}T00:00:00.000Z`) || 0;
}

function getLogBucketKey(licenseKey, timestampMs = Date.now(), shardSeed = '') {
    const cleanLicense = sanitizeText(licenseKey || 'unknown', 80) || 'unknown';
    const day = new Date(Number(timestampMs || Date.now())).toISOString().slice(0, 10).replace(/-/g, '');
    const shard = hashToShard(shardSeed || `${cleanLicense}:${day}`, 16);
    return `logs_${cleanLicense}_${day}_s${String(shard).padStart(2, '0')}`;
}

function getLogBucketKeyForShard(licenseKey, timestampMs = Date.now(), shard = 0) {
    const cleanLicense = sanitizeText(licenseKey || 'unknown', 80) || 'unknown';
    const day = new Date(Number(timestampMs || Date.now())).toISOString().slice(0, 10).replace(/-/g, '');
    return `logs_${cleanLicense}_${day}_s${String(Math.max(0, Math.min(15, Number(shard) || 0))).padStart(2, '0')}`;
}

function getLegacyLogBucketKey(licenseKey, timestampMs = Date.now()) {
    const cleanLicense = sanitizeText(licenseKey || 'unknown', 80) || 'unknown';
    const day = new Date(Number(timestampMs || Date.now())).toISOString().slice(0, 10).replace(/-/g, '');
    return `logs_${cleanLicense}_${day}`;
}

async function getRecentVisitorBuckets(env, licenseKey, siteFilter = '', since = 0, maxVisitors = MAX_PULL_VISITORS_DEFAULT) {
    const manifest = await getData(env, getVisitorBucketManifestKey(licenseKey));
    const sinceTs = Number(since || 0);
    const keyEntries = [];
    if (Array.isArray(manifest) && manifest.length) {
        for (const item of manifest) {
            if (!item?.key) continue;
            if (siteFilter && item.site !== siteFilter) continue;
            if (sinceTs && Number(item.updatedAt || 0) < sinceTs - 86400000) continue;
            keyEntries.push(item);
        }
    }
    const selectedKeys = keyEntries
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .map(item => item.key)
        .slice(0, 64);
    const rows = await limitedMap(selectedKeys, 6, key => getRuntimeCachedBucketData(env, key));
    const visitors = {};
    let visitorCount = 0;
    for (const bucket of rows) {
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
        for (const [key, visitor] of Object.entries(bucket)) {
            if (visitorCount >= maxVisitors && !visitors[key]) continue;
            const authoritativeVisitor = { ...visitor, source: 'bucket_authoritative' };
            const current = visitors[key];
            if (shouldPreferEntity(current, authoritativeVisitor)) {
                if (!current) visitorCount++;
                visitors[key] = authoritativeVisitor;
            }
        }
    }
    return visitors;
}

async function updateVisitorBucketManifest(env, licenseKey, bucketKeys) {
    const manifestKey = getVisitorBucketManifestKey(licenseKey);
    const parentMeta = await loadManifestOccMeta(env, manifestKey);
    const now = Date.now();
    const existing = await getData(env, manifestKey);
    const byKey = new Map();
    if (Array.isArray(existing)) {
        for (const item of existing) {
            if (!item?.key) continue;
            if (Number(item.updatedAt || 0) >= now - VISITOR_MANIFEST_TTL_MS) byKey.set(item.key, { ...item, retiredAt: item.retiredAt || null });
            else if (!item.retiredAt) byKey.set(item.key, { ...item, retiredAt: now, cleanupMarker: 'STALE_VISITOR_BUCKET_RETIRED' });
        }
    }
    for (const key of bucketKeys) {
        byKey.set(key, { key, site: getVisitorBucketSite(key), updatedAt: now, retiredAt: null });
    }
    const next = Array.from(byKey.values())
        .sort((a, b) => Number(Boolean(a.retiredAt)) - Number(Boolean(b.retiredAt)) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 256);
    await saveManifestWithOCC(env, manifestKey, next, parentMeta, 'VISITOR_BUCKET_MANIFEST');
    return true;
}

function getVisitorBucketManifestKey(licenseKey) {
    return `visitors_manifest_${sanitizeText(licenseKey || 'unknown', 80) || 'unknown'}`;
}

function getVisitorBucketSite(bucketKey) {
    const parts = String(bucketKey || '').split('_');
    return parts.length >= 3 ? parts.slice(2, -1).join('_') || '' : '';
}

async function preloadVisitorBucketsForKeys(env, licenseKey, visitorRefs = []) {
    // Batch bucket lookup within one request lifecycle. This reduces KV reads
    // without making memory cache authoritative.
    const bucketKeys = new Set();
    for (const ref of visitorRefs || []) {
        const key = sanitizeText(ref?.key || '', 180);
        if (!key) continue;
        const site = sanitizeText(ref?.site || String(key).split('_')[0] || 'SITE_A', 80) || 'SITE_A';
        bucketKeys.add(getVisitorBucketKey(licenseKey, site, key));
    }
    const cache = new Map();
    const keys = Array.from(bucketKeys).slice(0, 128);
    const rows = await limitedMap(keys, 6, async key => [key, await getData(env, key)]);
    for (const [key, bucket] of rows) {
        cache.set(key, (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) ? sanitizeVisitorBucket(bucket) : {});
    }
    return cache;
}

async function getVisitorFromAuthoritativeBucket(env, licenseKey, visitorKey, site = '', requestBucketCache = null) {
    // Cloudflare KV is eventually consistent and not transactional; never use the
    // legacy `visitors` hot cache as authoritative state on save. Visitor buckets
    // are the primary sync source, while hot cache writes are compatibility-only.
    const resolvedSite = sanitizeText(site || String(visitorKey || '').split('_')[0] || 'SITE_A', 80) || 'SITE_A';
    const bucketKey = getVisitorBucketKey(licenseKey, resolvedSite, visitorKey);
    const bucket = requestBucketCache?.has(bucketKey) ? requestBucketCache.get(bucketKey) : await getData(env, bucketKey);
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return {};
    return sanitizeVisitorEntity(bucket[visitorKey] || {});
}

async function appendVisitorsToBuckets(env, licenseKey, visitors) {
    if (!visitors || typeof visitors !== 'object' || Object.keys(visitors).length === 0) return true;
    const grouped = new Map();
    for (const [key, visitor] of Object.entries(visitors)) {
        const site = sanitizeText(visitor?.site || String(key).split('_')[0] || 'SITE_A', 80) || 'SITE_A';
        const bucketKey = getVisitorBucketKey(licenseKey || visitor?.licenseKey || 'unknown', site, key);
        if (!grouped.has(bucketKey)) grouped.set(bucketKey, {});
        grouped.get(bucketKey)[key] = sanitizeVisitorEntity({ ...visitor, source: 'bucket_authoritative' });
    }
    const touchedBuckets = [];
    const mutationIds = getMutationIdsFromRows(Object.values(visitors));
    await persistBucketCommitMarkers(env, mutationIds, { type: 'VISITOR_BUCKET_COMMIT', status: 'STARTED', licenseKey, buckets: Array.from(grouped.keys()) });
    try {
        const results = await limitedMap(Array.from(grouped.entries()), 6, async ([bucketKey, entries]) => {
            const saved = await safeAppendVisitorBucket(env, bucketKey, entries);
            if (saved) touchedBuckets.push(bucketKey);
            return saved;
        });
        const allCommitted = results.every(Boolean);
        if (!allCommitted) {
            await persistBucketCommitMarkers(env, mutationIds, { type: 'VISITOR_BUCKET_COMMIT', status: 'INCOMPLETE', licenseKey, buckets: Array.from(grouped.keys()), touchedBuckets });
            return false;
        }
        await updateVisitorBucketManifest(env, licenseKey, touchedBuckets);
        await persistBucketCommitMarkers(env, mutationIds, { type: 'VISITOR_BUCKET_COMMIT', status: 'COMMITTED', licenseKey, buckets: Array.from(grouped.keys()), touchedBuckets });
        return true;
    } catch (err) {
        await persistBucketCommitMarkers(env, mutationIds, { type: 'VISITOR_BUCKET_COMMIT', status: 'INCOMPLETE', licenseKey, buckets: Array.from(grouped.keys()), touchedBuckets, error: sanitizeText(err?.message || err, 240) });
        throw err;
    }
}


function buildLogBucketDedupeKey(log) {
    return log?.gasReplayId || log?.sequenceId || buildCanonicalLogKey(log);
}

function getLogDedupeKeys(log) {
    const keys = [];
    const gasReplayId = sanitizeText(log?.gasReplayId || '', 220);
    const sequenceId = sanitizeText(log?.sequenceId || '', 220);
    const canonical = buildCanonicalLogKey(log);
    if (gasReplayId) keys.push(`gas:${gasReplayId}`);
    if (sequenceId) keys.push(`seq:${sequenceId}`);
    if (canonical) keys.push(`canonical:${canonical}`);
    if (!keys.length) keys.push(`fallback:${buildLogBucketDedupeKey(log)}`);
    return keys;
}

function upsertLogDedupeCandidate(byDedupeKey, keyIndex, rawLog) {
    if (!rawLog) return;
    const log = sanitizeLogEntity(rawLog);
    const keys = getLogDedupeKeys(log);
    let primaryKey = null;
    let current = null;
    for (const key of keys) {
        const indexedKey = keyIndex.get(key);
        if (indexedKey && byDedupeKey.has(indexedKey)) {
            primaryKey = indexedKey;
            current = byDedupeKey.get(indexedKey);
            break;
        }
    }
    if (!primaryKey) primaryKey = keys[0];
    if (!current || shouldPreferEntity(current, log)) byDedupeKey.set(primaryKey, log);
    for (const key of keys) keyIndex.set(key, primaryKey);
}

function isIncomingEntityNewer(current = {}, incoming = {}) {
    const currentCommit = Number(current.commitClock || current.updatedAt || current.persistedAt || current.timestamp || 0);
    const incomingCommit = Number(incoming.commitClock || incoming.updatedAt || incoming.persistedAt || incoming.timestamp || 0);
    if (incomingCommit !== currentCommit) return incomingCommit > currentCommit;
    const currentEpoch = Number(current.mutationEpoch || current.writeEpoch || 0);
    const incomingEpoch = Number(incoming.mutationEpoch || incoming.writeEpoch || 0);
    if (incomingEpoch !== currentEpoch) return incomingEpoch > currentEpoch;
    const currentVersion = Number(current.version || 0);
    const incomingVersion = Number(incoming.version || 0);
    if (incomingVersion !== currentVersion) return incomingVersion > currentVersion;
    const currentMutation = String(current.lastMutationId || current.mutationId || '');
    const incomingMutation = String(incoming.lastMutationId || incoming.mutationId || '');
    if (incomingMutation !== currentMutation) return incomingMutation >= currentMutation;
    const currentSeq = String(current.sequenceId || current.gasReplayId || '');
    const incomingSeq = String(incoming.sequenceId || incoming.gasReplayId || '');
    return incomingSeq >= currentSeq;
}

function getVisitorBucketKey(licenseKey, site, visitorKey) {
    const cleanLicense = sanitizeText(licenseKey || 'unknown', 80) || 'unknown';
    const cleanSite = sanitizeText(site || 'SITE_A', 80) || 'SITE_A';
    const shard = hashToShard(visitorKey || `${cleanLicense}:${cleanSite}`, 16);
    return `visitors_${cleanLicense}_${cleanSite}_s${String(shard).padStart(2, '0')}`;
}

function compareReplayEntries(a, b) {
    const aFinal = a?.status === 'DEAD_LETTER' || a?.final ? 1 : 0;
    const bFinal = b?.status === 'DEAD_LETTER' || b?.final ? 1 : 0;
    if (aFinal !== bFinal) return aFinal - bFinal;
    const aTombstone = Number(a?.tombstoneClock || a?.finalizedAt || 0);
    const bTombstone = Number(b?.tombstoneClock || b?.finalizedAt || 0);
    if (aTombstone !== bTombstone) return aTombstone - bTombstone;
    const aClock = Number(a?.logicalClock || a?.commitTs || a?.updatedAt || a?.ts || 0);
    const bClock = Number(b?.logicalClock || b?.commitTs || b?.updatedAt || b?.ts || 0);
    if (aClock !== bClock) return aClock - bClock;
    const aCommit = Number(a?.commitTs || a?.updatedAt || a?.ts || 0);
    const bCommit = Number(b?.commitTs || b?.updatedAt || b?.ts || 0);
    if (aCommit !== bCommit) return aCommit - bCommit;
    return String(a?.originNode || '').localeCompare(String(b?.originNode || ''));
}

function getWorkerOriginNode() {
    if (!globalThis.__vms_origin_node) {
        globalThis.__vms_origin_node = `worker-${crypto.randomUUID().slice(0, 12)}`;
    }
    return globalThis.__vms_origin_node;
}

function hashToShard(value, shardCount = 16) {
    const clean = String(value || 'unknown');
    let hash = 0;
    for (let i = 0; i < clean.length; i++) hash = ((hash * 31) + clean.charCodeAt(i)) >>> 0;
    return hash % shardCount;
}

async function limitedMap(items, limit, mapper) {
    const source = Array.isArray(items) ? items : [];
    const concurrency = Math.max(1, Math.min(Number(limit || 4), 8));
    const results = new Array(source.length);
    let cursor = 0;
    async function worker() {
        while (cursor < source.length) {
            const index = cursor++;
            try {
                results[index] = await mapper(source[index], index);
            } catch (err) {
                console.warn('[LIMITED_MAP] Task failed:', err?.message || err);
                results[index] = null;
            }
        }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, source.length); i++) workers.push(worker());
    await Promise.allSettled(workers);
    return results;
}

function generateMutationId(licenseKey, deviceId) {
    return `${sanitizeText(licenseKey || 'unknown', 80)}:${sanitizeText(deviceId || getWorkerOriginNode(), 80)}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}



function summarizeCompanies(companies, now = Date.now()) {
    const summary = { total: Array.isArray(companies) ? companies.length : 0, active: 0, byPackage: { DEMO: 0, BASIC: 0, PRO: 0 } };
    if (!Array.isArray(companies)) return summary;
    for (const company of companies) {
        if (!company) continue;
        if (Number(company.expiredAt || 0) > now) summary.active++;
        const pkg = String(company.package || '').toUpperCase();
        if (Object.prototype.hasOwnProperty.call(summary.byPackage, pkg)) summary.byPackage[pkg]++;
    }
    return summary;
}

function summarizeViolations(activities, now = Date.now(), last30Days = now - 30 * 86400000) {
    const summary = { total: 0, last7Days: 0, last30Days: 0 };
    if (!Array.isArray(activities)) return summary;
    const last7Days = now - 7 * 86400000;
    for (const activity of activities) {
        if (activity?.type !== 'VIOLATION_REPORTED') continue;
        summary.total++;
        const ts = Number(activity.timestamp || 0);
        if (ts > last7Days) summary.last7Days++;
        if (ts > last30Days) summary.last30Days++;
    }
    return summary;
}

function sumPaidRevenue(invoices, sinceTs = 0) {
    if (!Array.isArray(invoices)) return 0;
    let total = 0;
    for (const invoice of invoices) {
        if (invoice?.status === 'PAID' && Number(invoice.paidAt || 0) > sinceTs) total += Number(invoice.amount || 0);
    }
    return total;
}

function buildDeviceIndexes(devices) {
    const source = Array.isArray(devices) ? devices : [];
    if (globalThis.__vms_device_index_cache?.source === source) {
        return globalThis.__vms_device_index_cache.index;
    }
    const index = {
        byDeviceId: new Map(),
        byDeviceLicense: new Map(),
        byCompanyId: new Map(),
        byLicenseKey: new Map(),
        statusCounts: Object.create(null)
    };
    try {
        for (let i = 0; i < source.length; i++) {
            const device = source[i];
            if (!device || typeof device !== 'object') continue;
            const deviceId = String(device.deviceId || '');
            const licenseKey = String(device.licenseKey || '');
            const companyId = String(device.companyId || '');
            const status = String(device.status || 'UNKNOWN').toUpperCase();
            if (deviceId && !index.byDeviceId.has(deviceId)) index.byDeviceId.set(deviceId, device);
            if (deviceId && licenseKey) index.byDeviceLicense.set(`${licenseKey}\u0000${deviceId}`, device);
            if (companyId) pushIndexArray(index.byCompanyId, companyId, device);
            if (licenseKey) pushIndexArray(index.byLicenseKey, licenseKey, device);
            index.statusCounts[status] = (index.statusCounts[status] || 0) + 1;
        }
        globalThis.__vms_device_index_cache = { source, index, builtAt: Date.now(), size: source.length };
        return index;
    } catch (err) {
        console.warn('[DEVICE_INDEX] Falling back to direct array scans:', err?.message || err);
        return { ...index, fallback: source };
    }
}

function pushIndexArray(map, key, value) {
    const cleanKey = String(key || '');
    if (!cleanKey) return;
    const existing = map.get(cleanKey);
    if (existing) existing.push(value);
    else map.set(cleanKey, [value]);
}

function invalidateDeviceIndexCache() {
    globalThis.__vms_device_index_cache = null;
}

function getDeviceByLicense(index, deviceId, licenseKey) {
    const key = `${licenseKey}\u0000${deviceId}`;
    return index?.byDeviceLicense?.get(key) || (Array.isArray(index?.fallback) ? index.fallback.find(d => d?.deviceId === deviceId && d?.licenseKey === licenseKey) : null);
}

function getDeviceById(index, deviceId) {
    return index?.byDeviceId?.get(String(deviceId || '')) || (Array.isArray(index?.fallback) ? index.fallback.find(d => d?.deviceId === deviceId) : null);
}

function getDeviceIndexById(devices, deviceId) {
    if (!Array.isArray(devices)) return -1;
    const indexedDevice = getDeviceById(buildDeviceIndexes(devices), deviceId);
    if (!indexedDevice) return -1;
    return devices.indexOf(indexedDevice);
}

function getDevicesByLicense(index, licenseKey) {
    return index?.byLicenseKey?.get(String(licenseKey || '')) || (Array.isArray(index?.fallback) ? index.fallback.filter(d => d?.licenseKey === licenseKey) : []);
}

function getDevicesByCompany(index, companyId) {
    return index?.byCompanyId?.get(String(companyId || '')) || (Array.isArray(index?.fallback) ? index.fallback.filter(d => d?.companyId === companyId) : []);
}

function getDeviceStatusCounts(index) {
    return index?.statusCounts || Object.create(null);
}

function countDeviceStatuses(devices) {
    const counts = Object.create(null);
    if (!Array.isArray(devices)) return counts;
    for (const device of devices) {
        const status = String(device?.status || 'UNKNOWN').toUpperCase();
        counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
}

function countDevicesByLicense(devices, licenseKey, status = '') {
    const rows = getDevicesByLicense(buildDeviceIndexes(devices), licenseKey);
    if (!status) return rows.length;
    const target = String(status).toUpperCase();
    let count = 0;
    for (const device of rows) if (String(device?.status || '').toUpperCase() === target) count++;
    return count;
}

function countDevicesByCompany(devices, companyId, status = '') {
    const rows = getDevicesByCompany(buildDeviceIndexes(devices), companyId);
    if (!status) return rows.length;
    const target = String(status).toUpperCase();
    let count = 0;
    for (const device of rows) if (String(device?.status || '').toUpperCase() === target) count++;
    return count;
}

function countOnlineDevices(devices, now = Date.now()) {
    if (!Array.isArray(devices)) return 0;
    let count = 0;
    for (const device of devices) {
        if (device?.status === 'ACTIVE' && (now - Number(device.lastSeen || 0)) < 5 * 60000) count++;
    }
    return count;
}

async function isTrustedSyncDevice(env, licenseKey, deviceId) {
    if (!licenseKey || !deviceId) return false;
    const devices = await getData(env, 'devices');
    const device = getDeviceByLicense(buildDeviceIndexes(devices), deviceId, licenseKey);
    return !!device && device.status !== 'DELETED' && ['ACTIVE', 'PENDING_APPROVAL', 'SUSPENDED'].includes(String(device.status || '').toUpperCase());
}

async function withMutationLock(lockKey, mutationFn) {
    if (!globalThis.__vms_mutation_locks) {
        globalThis.__vms_mutation_locks = new Map();
    }
    pruneMutationLocks();
    const previousRecord = globalThis.__vms_mutation_locks.get(lockKey);
    const previous = previousRecord?.tail || Promise.resolve();
    const now = Date.now();
    const staleLockMs = 30000;
    const previousIsStale = previousRecord && !previousRecord.settled && (now - Number(previousRecord.startedAt || now)) > staleLockMs;
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    const record = { tail, startedAt: now, settled: false, recoveredFromStale: !!previousIsStale };
    globalThis.__vms_mutation_locks.set(lockKey, record);
    pruneMapToMax(globalThis.__vms_mutation_locks, MAX_MUTATION_LOCKS);
    if (previousIsStale) {
        console.log(JSON.stringify({ type:"MUTATION_LOCK_STALE_RECOVERY", lockKey: sanitizeText(lockKey, 200), staleMs: now - Number(previousRecord.startedAt || now), warning:"possible_double_execution", updatedAt: now }));
        await Promise.race([
            previous.catch(() => undefined),
            new Promise(resolve => setTimeout(resolve, 250))
        ]);
    } else {
        await previous.catch(() => undefined);
    }
    try {
        return await mutationFn();
    } finally {
        record.settled = true;
        release();
        if (globalThis.__vms_mutation_locks.get(lockKey) === record) {
            globalThis.__vms_mutation_locks.delete(lockKey);
        }
    }
}

function pruneMutationLocks() {
    const locks = globalThis.__vms_mutation_locks;
    if (!locks || typeof locks.entries !== 'function') return;
    const now = Date.now();
    const maxSettledLockAgeMs = 60000;
    for (const [key, record] of locks.entries()) {
        if (!record || (record.settled && (now - Number(record.startedAt || now)) > maxSettledLockAgeMs)) {
            locks.delete(key);
        }
    }
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
    if (!normalizedLogs.length) return { ok:true, ack:true, rowsAppended:0, mutationIds:[], skippedMutationIds:[], ackMutationIds:[] };
    const result = await pushLogsToGoogleScript(clonePayloadSafe(normalizedLogs), { detailed:true, hmacSecret: env?.VMS_GAS_HMAC_SECRET || env?.GAS_HMAC_SECRET || '' });
    const expectedIds = normalizedLogs.map(log => String(log.mutationId)).filter(Boolean);
    const expectedFingerprints = normalizedLogs.map(log => String(log.requestFingerprint || '')).filter(Boolean);
    const ackIds = new Set([...(result.mutationIds || []), ...(result.skippedMutationIds || []), ...(result.ackMutationIds || [])].map(String));
    const ackFingerprints = new Set([...(result.requestFingerprints || []), ...(result.ackFingerprints || [])].map(String));
    const exactAck = expectedIds.every(id => ackIds.has(id)) && Number(result.ackCount || ackIds.size) === expectedIds.length && expectedFingerprints.every(fp => ackFingerprints.has(fp));
    if(!exactAck) console.log(JSON.stringify({ type:"GAS_ACK_MISMATCH", expectedIds, result, updatedAt:getWIBISO() }));
    return { ...result, ok: !!(result.ok && result.ack && exactAck), exactAck, expectedMutationIds: expectedIds };
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
            reg,
            nama: sanitizeText(visitor?.nama || visitor?.name || '', 160),
            name: sanitizeText(visitor?.name || visitor?.nama || '', 160),
            perusahaan: sanitizeText(visitor?.perusahaan || visitor?.company || '', 160),
            company: sanitizeText(visitor?.company || visitor?.perusahaan || '', 160),
            tujuan: sanitizeText(visitor?.tujuan || visitor?.purpose || '', 200),
            purpose: sanitizeText(visitor?.purpose || visitor?.tujuan || '', 200),
            kategori: sanitizeText(visitor?.kategori || visitor?.category || 'UMUM', 80),
            pic: sanitizeText(visitor?.pic || visitor?.PIC || '', 120),
            start: sanitizeText(visitor?.start || visitor?.startDate || '', 80),
            exp: sanitizeText(visitor?.exp || visitor?.expDate || '', 80),
            status: sanitizeText(visitor?.currentStatus || visitor?.status || action, 80),
            action,
            eventTs,
            time: eventTs,
            logTime: visitor?.logTime || getWIBISO(eventTs),
            site: sanitizeText(visitor?.site || keyParts[0] || body.site || 'SITE_A', 80),
            deviceId: sanitizeText(visitor?.deviceId || body.deviceId || '', 120),
            licenseKey,
            companyId: company?.id || '',
            companyName: sanitizeText(company?.companyName || '', 120),
            version: Math.max(1, Number(visitor?.version || 1)),
            updatedAt: Number(visitor?.updatedAt || eventTs),
            updatedAtWIB: visitor?.updatedAtWIB || getWIBISO(visitor?.updatedAt || eventTs),
            mutationId,
            mutationSource: sanitizeText(visitor?.mutationSource || visitor?.deviceId || body.deviceId || getWorkerOriginNode(), 160),
            requestFingerprint: sanitizeText(visitor?.requestFingerprint || [mutationId, reg, visitor?.deviceId || body.deviceId || '', eventTs].join('|'), 240),
            sequenceId: visitor?.sequenceId || mutationId,
            persistedAt: Number(visitor?.persistedAt || getEventTimestamp()),
            syncStatus: 'PENDING_SYNC'
        }, visitor?.mutationSource || body.deviceId || getWorkerOriginNode()));
    }).filter(log => log.reg && isSheetAppendAction(log.action) && log.mutationId);
}

function visitorSnapshotFingerprint(visitor) {
    return `${Number(visitor?.updatedAt || 0)}|${Number(visitor?.version || 0)}|${visitor?.mutationSource || ''}`;
}

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

    if(!Object.keys(changedVisitors).length) {
        console.log(JSON.stringify({ type:"VISITOR_SNAPSHOT_SKIP", licenseKey, reason:"unchanged", updatedAt: Date.now() }));
        return true;
    }

    const ok = await pushVisitorsToGoogleScript(clonePayloadSafe(changedVisitors), { hmacSecret: env?.VMS_GAS_HMAC_SECRET || env?.GAS_HMAC_SECRET || '' });
    if(ok) {
        // PRUNE STATE: Prevent KV Bloating
        const MAX_SNAPSHOT_STATE = 50000;
        const entries = Object.entries(nextState);
        const prunedState = entries.length > MAX_SNAPSHOT_STATE
            ? Object.fromEntries(entries.sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0)).slice(0, MAX_SNAPSHOT_STATE))
            : nextState;
        await saveData(env, stateKey, prunedState);
    }
    return ok;
}

async function pushVisitorsToGoogleScript(visitors, options = {}) {
    const timeoutMs = 9000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const payload = {
            source: 'vms-worker',
            mode: 'visitor-snapshot',
            version: PATCH_VERSION,
            updatedAt: Date.now(),
            visitors
        };
        const headers = { 'Content-Type': 'application/json' };
        let requestBody = JSON.stringify(payload);
        if (options.hmacSecret) {
            const signature = await hmacSha256Hex(requestBody, options.hmacSecret);
            headers['x-vms-signature'] = signature;
            requestBody = JSON.stringify({ ...payload, signature });
        }
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
        if (error?.name === 'AbortError') {
            console.error('[GAS] Visitor append timed out after ms:', timeoutMs);
            console.log(JSON.stringify({ type:"GAS_FAIL", mode:"visitor-snapshot", reason:"timeout", timeoutMs, updatedAt: Date.now() }));
            return false;
        }
        console.error('[GAS] Visitor append request error:', error);
        console.log(JSON.stringify({ type:"GAS_FAIL", mode:"visitor-snapshot", reason:error?.message || "request_error", updatedAt: Date.now() }));
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function hmacSha256Hex(message, secret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pushLogsToGoogleScript(logs, options = {}) {
    const detailed = !!options.detailed;
    const timeoutMs = 9000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const fail = (extra = {}) => detailed ? { ok:false, ack:false, rowsAppended:0, mutationIds:[], skippedMutationIds:[], ackMutationIds:[], ...extra } : false;
    try {
        const payload = {
            source: 'vms-worker',
            mode: 'append-only',
            version: PATCH_VERSION,
            updatedAt: getEventTimestamp(),
            updatedAtWIB: getWIBISO(),
            logs: logs.map(log => {
                const eventTs = Number(log.eventTs || (typeof log.time === 'number' ? log.time : 0) || log.updatedAt || Date.parse(log.time || log.logTime || 0) || getEventTimestamp());
                return { ...log, eventTs, time:eventTs, action: normalizeAction(log.action), logTime: log.logTime || getWIBISO(eventTs), syncStatus: log.syncStatus || 'PENDING_SYNC' };
            })
        };
        const headers = { 'Content-Type': 'application/json' };
        let requestBody = JSON.stringify(payload);
        if (options.hmacSecret) {
            const signature = await hmacSha256Hex(requestBody, options.hmacSecret);
            headers['x-vms-signature'] = signature;
            requestBody = JSON.stringify({ ...payload, signature });
        }
        const res = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: controller.signal
        });
        const result = await res.json().catch(() => null);
        if (!res.ok || result?.ok === false || result?.ack !== true) {
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

function getPendingQueueLimit(packageName) {
    const pkg = String(packageName || 'DEMO').toUpperCase();
    if (pkg === 'PRO' || pkg === 'FULL') return 15000;
    if (pkg === 'BASIC') return 5000;
    return 1000;
}

function buildCanonicalLogKey(log) {
    const reg = sanitizeText(log?.reg, 80);
    const action = sanitizeText(log?.action, 40);
    const site = sanitizeText(log?.site, 80);
    const ts = Math.floor((Date.parse(log?.time || log?.logTime || 0) || Number(log?.persistedAt || 0) || 0) / 1000);
    return `${reg}|${action}|${ts}|${site}`;
}

function sanitizeVisitorForPull(visitor) {
    const safe = clonePayloadSafe(visitor || {});
    delete safe.foto;
    delete safe.photo;
    delete safe.base64;
    delete safe.blob;
    delete safe.image;
    delete safe.thumbnail;
    delete safe.thumbnailBase64;
    return safe;
}

function generateSequenceId(licenseKey, timestampMs = Date.now()) {
    if (!globalThis.__vms_sequence_counter) {
        globalThis.__vms_sequence_counter = 0;
    }
    globalThis.__vms_sequence_counter = (globalThis.__vms_sequence_counter + 1) % 1000000;
    const counter = String(globalThis.__vms_sequence_counter).padStart(6, '0');
    return `${licenseKey}-${timestampMs}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

function generateGasReplayId(log) {
    if (log && log.sequenceId) return `gas-${log.sequenceId}`;
    return `gas-${crypto.randomUUID()}`;
}

async function reconcileDeviceState(env) {
    const nowTs = Date.now();
    if(globalThis.__reconcileInFlight){
        return;
    }
    if(globalThis.__lastReconcile && (nowTs - globalThis.__lastReconcile) < 300000){
        return;
    }
    globalThis.__reconcileInFlight = true;
    try {
    const now = Date.now();
    const stalePendingMs = 24 * 60 * 60 * 1000;
    const staleDeletedMs = 30 * 86400000;
    let devices = await getData(env, 'devices');
    let companies = await getData(env, 'companies');
    let requests = await getData(env, 'device_requests');
    let invoices = await getData(env, 'invoices');
    const originalDevicesJson = JSON.stringify(devices || []);
    const originalCompaniesJson = JSON.stringify(companies || []);
    const originalRequestsJson = JSON.stringify(requests || []);
    const originalInvoicesJson = JSON.stringify(invoices || []);
    const companyIds = new Set((companies || []).map(c => c.id));

    const bestByDeviceId = new Map();
    for (const d of (devices || [])) {
        if(!d || !d.deviceId) continue;
        const cur = bestByDeviceId.get(d.deviceId);
        if(!cur){ bestByDeviceId.set(d.deviceId, d); continue; }
        if(cur.status !== 'ACTIVE' && d.status === 'ACTIVE') bestByDeviceId.set(d.deviceId, d);
    }
    devices = Array.from(bestByDeviceId.values()).filter(d => {
        if (!d) return false;
        if (!companyIds.has(d.companyId)) return false;
        if (d.status === 'DELETED' && Number(d.deletedAt || 0) > 0 && (now - Number(d.deletedAt)) > staleDeletedMs) return false;
        if (d.status === 'PENDING_APPROVAL' && Number(d.firstSeen || now) > 0 && (now - Number(d.firstSeen || now)) > stalePendingMs) return false;
        return true;
    });

    requests = (requests || []).filter(r => r && companyIds.has(r.companyId) && !((r.status === 'PENDING' || r.status === 'WAITING_PAYMENT') && (now - Number(r.requestedAt || now)) > stalePendingMs));
    invoices = (invoices || []).filter(i => i && companyIds.has(i.companyId));
    const deletedDeviceIds = new Set(devices.filter(d => d.status === 'DELETED').map(d => d.deviceId));
    requests = requests.filter(r => !deletedDeviceIds.has(r.deviceId));
    console.log("ZOMBIE CLEANUP", { requests: requests.length, invoices: invoices.length });

    const deviceIndex = buildDeviceIndexes(devices);
    for (const company of companies) {
        const companyDevices = getDevicesByCompany(deviceIndex, company.id);
        const statusCounts = countDeviceStatuses(companyDevices);
        company.approvedDevices = (statusCounts.ACTIVE || 0) + (statusCounts.SUSPENDED || 0) + (statusCounts.BANNED || 0);
        company.activeDevices = countOnlineDevices(companyDevices, now);
        company.activeOnlineDevices = company.activeDevices;
        company.pendingDevices = statusCounts.PENDING_APPROVAL || 0;
        company.suspendedDevices = statusCounts.SUSPENDED || 0;
        company.deletedDevices = statusCounts.DELETED || 0;
        company.currentDevices = statusCounts.ACTIVE || 0;
        company.onlineDevices = company.activeDevices;
    }

    await saveDataIfChangedFromJson(env, 'devices', originalDevicesJson, devices);
    await saveDataIfChangedFromJson(env, 'companies', originalCompaniesJson, companies);
    await saveDataIfChangedFromJson(env, 'device_requests', originalRequestsJson, requests);
    await saveDataIfChangedFromJson(env, 'invoices', originalInvoicesJson, invoices);
    console.log('DEVICE RECONCILE', { devices: devices.length, companies: companies.length, requests: requests.length, invoices: invoices.length });
    } finally {
        globalThis.__lastReconcile = Date.now();
        globalThis.__reconcileInFlight = false;
    }
}

function normalizeGasQueueEntries(queue) {
    if (!Array.isArray(queue)) return [];
    const normalized = [];
    for (const item of queue) {
        if (!item || typeof item !== 'object') continue;
        const action = normalizeAction(item.action);
        if(!isSheetAppendAction(action)) {
            console.log(JSON.stringify({ type:"PENDING_GAS_QUEUE_REJECT", action:item.action || '', normalizedAction:action, reg:item.reg || '', updatedAt:getWIBISO() }));
            continue;
        }
        const persistedAt = Number(item.persistedAt || Date.now());
        const updatedAt = Number(item.updatedAt || persistedAt);
        const version = Math.max(1, Number(item.version || 0));
        const sequenceId = item.sequenceId || item.mutationId || generateSequenceId(item.licenseKey || 'unknown', persistedAt);
        const gasReplayId = item.gasReplayId || generateGasReplayId({ ...item, sequenceId });
        normalized.push({ ...item, action, version, updatedAt, persistedAt, sequenceId, gasReplayId });
    }
    return dedupGasQueueByReplayId(normalized);
}

function dedupGasQueueByReplayId(queue) {
    const seen = new Set();
    const deduped = [];
    for (const item of queue) {
        if (!item?.gasReplayId) continue;
        if (seen.has(item.gasReplayId)) continue;
        seen.add(item.gasReplayId);
        deduped.push(item);
    }
    return deduped;
}

function mergeGasQueueUnique(baseQueue, incomingQueue) {
    const merged = [];
    for (const item of normalizeGasQueueEntries(baseQueue)) merged.push(item);
    for (const item of normalizeGasQueueEntries(incomingQueue)) merged.push(item);
    return dedupGasQueueByReplayId(merged);
}

// ==================== DEFAULT DATA ====================
function getDefaultData(key) {
    const defaults = {
        companies: [],
        devices: [],
        activities: [],
        invoices: [],
        device_requests: [],
        admins: [],
        visitors: {},
        logs: [],
        anti_nakal_reports: [],
        users_from_clients: [],
        processed_replays: [],
        pending_gas_queue: [],
        processing_gas_queue: [],
        gas_visitor_snapshot_state: {},
        settings: {
            pricing: {
                BASIC: { price: 500000, maxDevices: 10, extraDeviceFee: 50000 },
                PRO: { price: 2000000, maxDevices: 999, extraDeviceFee: 0 }
            },
            general: { tax: 11 }
        }
    };
    
    if (defaults[key] !== undefined) {
        return defaults[key];
    }
    
    return key === 'visitors' ? {} : [];
}

// ==================== AUTH CHECK (TOKEN NORMALIZATION) ====================
async function checkAuth(headers, env) {
    // FIX: normalize token from multiple header formats
    let token = headers.get('x-token');
    
    if (!token) {
        const authHeader = headers.get('authorization') || headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }
    
    if (!token) return null;
    
    const admins = await getData(env, 'admins');
    const admin = admins.find(a => a.token === token);
    
    if (admin && admin.lastLogin && (Date.now() - admin.lastLogin) < 24 * 3600000) {
        return { username: admin.username, role: admin.role, id: admin.id };
    }
    
    return null;
}

function buildFeaturePolicy(pkg, maxDevices) {
    const packageName = String(pkg || 'DEMO').toUpperCase();
    const isPro = packageName === 'PRO' || packageName === 'FULL';
    const isBasic = packageName === 'BASIC';
    const isDemo = !isPro && !isBasic;
    return {
        version: PATCH_VERSION,
        updatedAt: Date.now(),
        package: packageName,
        licenseScopedSync: true,
        realtimeSync: isPro || isBasic,
        spreadsheetAutoSync: isPro || isBasic,
        unlimitedSites: isPro,
        allowSiteRename: isPro || isBasic,
        staticSitesOnly: isDemo,
        staticSites: ['SITE_A', 'SITE_B', 'SITE_C'],
        maxDevices: Number(maxDevices) || (isBasic ? 5 : 5),
        unlimitedDevices: isPro,
        basicRenameSlots: isBasic ? 2 : 0,
        unlimitedScannerLogs: true,
        appendOnlyScannerLogs: true
    };
}

// ==================== UTILITY FUNCTIONS ====================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}
