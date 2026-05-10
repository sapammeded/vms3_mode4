// ==================== VMS WORKER v3.0 - HARDENED PRODUCTION ====================
// Cloudflare Worker untuk VMS SAPAM MEDED
// KV Namespace: VMS_STORAGE

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzQQr4hZKbSEeiW4h0q6H_HPOqODBuZbQfZm_hjIl0F551eK2WrXnpDO9_Qk31sp8-Y9w/exec';
const PATCH_VERSION = '1.0.13';

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
                const companyDevices = devices.filter(d => d.licenseKey === licenseKey && d.status !== 'DELETED');
                const currentDeviceCount = companyDevices.length;
                
                let status = 'ACTIVE';
                if (currentDeviceCount >= company.maxDevices) {
                    status = 'PENDING_APPROVAL';
                }
                
                let device = devices.find(d => d.deviceId === deviceId && d.licenseKey === licenseKey);
                if (device) {
                    device.lastSeen = Date.now();
                    device.deviceName = deviceName || device.deviceName;
                    device.meta = meta;
                } else {
                    device = {
                        deviceId: deviceId,
                        deviceName: deviceName || deviceId,
                        licenseKey: licenseKey,
                        companyId: company.id,
                        companyName: sanitizeText(company.companyName, 120),
                        status: status,
                        firstSeen: Date.now(),
                        lastSeen: Date.now(),
                        meta: meta,
                        violations: [],
                        sessions: []
                    };
                    devices.push(device);
                }
                
                await saveData(env, 'devices', devices);
                
                company.currentDevices = devices.filter(d => d.licenseKey === licenseKey && d.status === 'ACTIVE').length;
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
                const companyDevices = devices.filter(d => d.licenseKey === licenseKey && d.status !== 'DELETED');
                
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
                let device = devices.find(d => d.deviceId === deviceId && d.licenseKey === licenseKey);
                if (device && device.status !== 'DELETED') {
                    device.lastSeen = Date.now();
                    device.deviceName = deviceName || device.deviceName;
                    device.meta = meta || device.meta;
                    if (device.status === 'PENDING_APPROVAL' && (Date.now() - Number(device.firstSeen || Date.now())) > 30 * 86400000) {
                        device.status = 'SUSPENDED';
                    }
                    await saveData(env, 'devices', devices);
                }
                console.log('DEVICE HEARTBEAT', { deviceId, licenseKey, status: device?.status || 'UNKNOWN' });
                return new Response(JSON.stringify({ ok: true, device }), { headers: corsHeaders });
            }
            
            // ==================== CHECK-IN / CHECK-OUT MODULE ====================
            if (path === '/checkin' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceId, action, location } = body;
                const normalizedAction = (action === 'OUT' ? 'OUT' : 'IN');
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                if (!company || company.expiredAt < Date.now()) {
                    return new Response(JSON.stringify({ ok: false, message: 'License invalid or expired' }), { headers: corsHeaders });
                }
                
                const devices = await getData(env, 'devices');
                const device = devices.find(d => d.deviceId === deviceId && d.licenseKey === licenseKey);
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
                    timestamp: Date.now(),
                    type: normalizedAction === 'IN' ? 'CHECK_IN' : 'CHECK_OUT'
                };
                activities.unshift(activity);
                await saveData(env, 'activities', activities.slice(0, 5000));
                
                device.lastSeen = Date.now();
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
                const device = devices.find(d => d.deviceId === deviceId);
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
                
                const stats = {
                    companies: {
                        total: companies.length,
                        active: companies.filter(c => c.expiredAt > now).length,
                        byPackage: {
                            DEMO: companies.filter(c => c.package === 'DEMO').length,
                            BASIC: companies.filter(c => c.package === 'BASIC').length,
                            PRO: companies.filter(c => c.package === 'PRO').length
                        }
                    },
                    devices: {
                        total: devices.length,
                        active: devices.filter(d => d.status === 'ACTIVE').length,
                        pending: devices.filter(d => d.status === 'PENDING_APPROVAL').length,
                        suspended: devices.filter(d => d.status === 'SUSPENDED').length,
                        banned: devices.filter(d => d.status === 'BANNED').length
                    },
                    violations: {
                        total: activities.filter(a => a.type === 'VIOLATION_REPORTED').length,
                        last7Days: activities.filter(a => a.type === 'VIOLATION_REPORTED' && a.timestamp > now - 7 * 86400000).length,
                        last30Days: activities.filter(a => a.type === 'VIOLATION_REPORTED' && a.timestamp > last30Days).length
                    },
                    revenue: {
                        last30Days: invoices.filter(i => i.status === 'PAID' && i.paidAt > last30Days).reduce((sum, i) => sum + i.amount, 0)
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
                
                const companyDevices = devices.filter(d => d.companyId === companyId);
                
                return new Response(JSON.stringify({
                    ...company,
                    devices: companyDevices,
                    stats: {
                        totalDevices: companyDevices.length,
                        activeDevices: companyDevices.filter(d => d.status === 'ACTIVE').length
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
                const device = devices.find(d => d.deviceId === deviceId);
                if (!device) {
                    return new Response(JSON.stringify({ ok: false, error: 'Device not found' }), { headers: corsHeaders });
                }
                
                const oldStatus = device.status;
                device.status = approve ? 'ACTIVE' : 'REJECTED';
                if (approve) {
                    device.approvedAt = Date.now();
                    device.lastSeen = Date.now();
                }
                if (!approve) {
                    device.deletedAt = Date.now();
                }
                console.log("DEVICE STATE FIX", { deviceId, oldStatus, newStatus: device.status });
                
                await saveData(env, 'devices', devices);
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.id === device.companyId);
                if (company && approve) {
                    company.currentDevices = devices.filter(d => d.companyId === company.id && d.status === 'ACTIVE').length;
                    await saveData(env, 'companies', companies);
                }
                
                return new Response(JSON.stringify({ ok: true, device: device }), { headers: corsHeaders });
            }
            
            // ==================== DELETE DEVICE MODULE ====================
            if (path === '/delete-device' && request.method === 'POST') {
                const body = await request.json();
                const { deviceId, reason } = body;
                
                const devices = await getData(env, 'devices');
                const index = devices.findIndex(d => d.deviceId === deviceId);
                if (index === -1) {
                    return new Response(JSON.stringify({ ok: false, error: 'Device not found' }), { headers: corsHeaders });
                }
                
                devices[index].status = 'DELETED';
                devices[index].deletedAt = Date.now();
                devices[index].version = Number(devices[index].version || 0) + 1;
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
                            
                            company.currentDevices = devices.filter(d => d.companyId === company.id && d.status === 'ACTIVE').length;
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
                const replayId = body.replayId || null;
                if (replayId) {
                    const replayKeys = await getData(env, 'processed_replays');
                    const nowTs = Date.now();
                    const normalizedReplay = (replayKeys || []).map(x => typeof x === "string" ? { id:x, ts:nowTs } : x).filter(x => (nowTs - Number(x.ts || nowTs)) < 3 * 86400000);
                    if (normalizedReplay.some(x => x.id === replayId)) {
                        globalThis.__vms_metrics.dedupReplay++;
                        console.log(JSON.stringify({ type:"REPLAY_DETECTED", replayId: sanitizeText(replayId, 180), licenseKey, updatedAt: Date.now() }));
                        return json({ ok: true, dedup: true });
                    }
                    normalizedReplay.push({ id: replayId, ts: nowTs });
                    await saveData(env, 'processed_replays', normalizedReplay.slice(-5000));
                }
                if (company.expiredAt < Date.now()) {
                    globalThis.__vms_metrics.saveFail++;
                    return json({ ok: false, message: 'License expired' }, 403);
                }
                
                const acceptedVisitors = {};
                if (visitors && Object.keys(visitors).length > 0) {
                    let allVisitors = await getData(env, 'visitors');
                    for (const [key, value] of Object.entries(visitors)) {
                        if (!value || typeof value !== 'object') continue;
                        const normalizedVisitor = {
                            ...value,
                            nama: value.nama || value.name || "",
                            perusahaan: value.perusahaan || value.company || "",
                            kategori: value.kategori || value.category || "UMUM",
                            tujuan: value.tujuan || value.purpose || "",
                            start: value.start || value.startDate || "",
                            exp: value.exp || value.expDate || "",
                            pic: value.pic || "",
                            dept: value.dept || "",
                            keterangan: value.keterangan || value.note || ""
                        };
                        const prev = allVisitors[key] || {};
                        const prevUpdated = Number(prev.updatedAt || 0);
                        const incomingUpdated = Number(normalizedVisitor?.updatedAt || 0);
                        const prevVersion = Number(prev.version || 0);
                        const incomingVersion = Number(normalizedVisitor?.version || 0);
                        const accepted = incomingVersion > prevVersion || (incomingVersion === prevVersion && incomingUpdated >= prevUpdated);
                        console.log("VISITOR CONFLICT", { key, prevUpdated, incomingUpdated, prevVersion, incomingVersion, accepted });
                        if (!accepted) continue;
                        allVisitors[key] = { ...prev, ...normalizedVisitor, licenseKey, lastSync: Date.now() };
                        acceptedVisitors[key] = { ...allVisitors[key] };
                    }
                    await saveData(env, 'visitors', allVisitors);
                }
                
                if (Array.isArray(logs) && logs.length > 0) {
                    let allLogs = await getData(env, 'logs');
                    const allVisitors = await getData(env, 'visitors');
                    const normalizedLogs = logs
                        .filter(l => l && l.reg && l.action && (l.time || l.logTime))
                        .map(l => {
                            const logTime = l.time || l.logTime;
                            const normalizedTime = typeof logTime === "string" ? logTime : new Date(logTime).toISOString();
                            return {
                                ...l,
                                time: normalizedTime,
                                logTime: normalizedTime,
                                sequenceId: l.sequenceId || null,
                                licenseKey,
                                companyId: company.id,
                                companyName: sanitizeText(company.companyName, 120)
                            };
                        });
                    globalThis.__vms_metrics.malformedLogs += Math.max(0, logs.length - normalizedLogs.length);
                    const seen = new Set(allLogs.slice(0, 7000).map(l => l.sequenceId || `${l.licenseKey}|${l.reg}|${l.action}|${l.time}|${l.site || ''}|${l.deviceId || ''}`));
                    const logicalSeen = new Set(allLogs.slice(0, 7000).map(l => buildCanonicalLogKey(l)));
                    const appendOnly = [];
                    const rejectedExpired = [];
                    for (const log of normalizedLogs) {
                        const site = log.site || body.site || 'SITE_A';
                        const visitorKey = `${site}_${log.reg}`;
                        const visitor = allVisitors[visitorKey];
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
                        seen.add(k);
                        logicalSeen.add(lk);
                        const persistedAt = Date.now();
                        const sequenceId = log.sequenceId || generateSequenceId(licenseKey, persistedAt);
                        appendOnly.push({ ...log, persistedAt, sequenceId });
                    }
                    // Avoid array cloning for high-frequency logging
                    for (const item of appendOnly) {
                        allLogs.push(item);
                    }
                    if (allLogs.length > 10000) {
                        allLogs = allLogs.slice(-10000);
                    }
                    await saveData(env, 'logs', allLogs);
                    if (appendOnly.length) {
                        const gasLogs = appendOnly.map(log => ({
                            ...log,
                            licenseKey,
                            companyId: company.id,
                            companyName: sanitizeText(company.companyName, 120),
                            site: sanitizeText(log.site || body.site || 'SITE_A', 80),
                            deviceId: sanitizeText(log.deviceId || body.deviceId || '', 120) || null,
                            persistedAt: log.persistedAt,
                            sequenceId: log.sequenceId,
                            gasReplayId: generateGasReplayId(log)
                        }));
                        const gasOk = await appendLogsToSheet(gasLogs);
                        if (!gasOk) {
                            const pendingQueue = await getData(env, 'pending_gas_queue');
                            const mergedQueue = mergeGasQueueUnique(pendingQueue, gasLogs);
                            const queueLimit = getPendingQueueLimit(company.package);
                            if (mergedQueue.length > queueLimit) console.log(JSON.stringify({ type:"QUEUE_OVERFLOW", queue:"pending_gas_queue", package: company.package, before: mergedQueue.length, limit: queueLimit, updatedAt: Date.now() }));
                            await saveData(env, 'pending_gas_queue', mergedQueue.slice(-queueLimit));
                        }
                    }
                    if (rejectedExpired.length) {
                        let reports = await getData(env, 'anti_nakal_reports');
                        for (const rejected of rejectedExpired) {
                            reports.unshift({
                                type: "EXPIRED_VISITOR_BLOCKED",
                                ...rejected,
                                licenseKey,
                                deviceId: sanitizeText(body.deviceId, 120),
                                timestamp: Date.now()
                            });
                        }
                        await saveData(env, 'anti_nakal_reports', reports.slice(0, 5000));
                    }
                }

                if(visitors && Object.keys(acceptedVisitors).length > 0){
                    await appendVisitorsToSheet(env, licenseKey, acceptedVisitors);
                }
                
                if (anti && Object.keys(anti).length > 0) {
                    let reports = await getData(env, 'anti_nakal_reports');
                    reports.unshift({
                        ...anti,
                        licenseKey,
                        deviceId: sanitizeText(body.deviceId, 120),
                        site: sanitizeText(body.site, 80),
                        timestamp: Date.now()
                    });
                    await saveData(env, 'anti_nakal_reports', reports.slice(0, 5000));
                }
                globalThis.__vms_metrics.saveOk++;
                globalThis.__vms_metrics.lastSaveAt = Date.now();
                
                return json({ ok: true, saved: { visitors: Object.keys(acceptedVisitors).length, logs: Array.isArray(logs) ? logs.length : 0, anti: !!Object.keys(anti).length, meta: !!Object.keys(meta).length } });
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
                const allVisitors = await getData(env, 'visitors');
                const visitors = {};
                const MAX_PULL_VISITORS = 2000;
                let visitorCount = 0;
                for (const [key, v] of Object.entries(allVisitors || {})) {
                    if (v?.licenseKey !== licenseKey) continue;
                    if (Number(v?.updatedAt || 0) >= since || Number(v?.lastSync || 0) >= since){
                        visitors[key] = sanitizeVisitorForPull(v);
                        visitorCount++;
                        if(visitorCount >= MAX_PULL_VISITORS) break;
                    }
                }
                const MAX_PULL_LOGS = 1000;
                const allLogs = await getData(env, 'logs');
                const logs = (allLogs || [])
                    .filter(l => l?.licenseKey === licenseKey)
                    .filter(l => !siteFilter || l?.site === siteFilter)
                    .filter(l => Number(l?.persistedAt || 0) >= since || Number(l?.time ? Date.parse(l.time) : 0) >= since)
                    .sort((a,b) => (Number(a?.persistedAt || 0) || Date.parse(a?.time || 0)) - (Number(b?.persistedAt || 0) || Date.parse(b?.time || 0)))
                    .map(l => ({ ...l, sequenceId: l.sequenceId || generateSequenceId(licenseKey, Number(l?.persistedAt || Date.now())) }));
                const dedupeMap = new Map();
                logs.forEach(l => {
                    dedupeMap.set(l.sequenceId || buildCanonicalLogKey(l), l);
                });
                const dedupedLogs = Array.from(dedupeMap.values()).slice(-MAX_PULL_LOGS);
                console.log("AUTHORITATIVE LOG SORT", { total: dedupedLogs.length });
                console.log('PULL DEDUPE', { before: logs.length, after: dedupedLogs.length });
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
                const batch = normalizedPending.slice(0, batchSize).map(log => ({ ...log, processingStartedAt: Date.now() }));
                const remainingPending = normalizedPending.slice(batch.length);
                let processingQueue = await getData(env, 'processing_gas_queue');
                processingQueue = mergeGasQueueUnique(processingQueue, batch);
                await saveData(env, 'pending_gas_queue', remainingPending.slice(-queueLimit));
                await saveData(env, 'processing_gas_queue', processingQueue.slice(-queueLimit));
                const gasOk = await pushLogsToGoogleScript(batch);
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
async function saveData(env, key, data) {
    try {
        if (!env || !env.VMS_STORAGE) {
            console.error(`[SAVE_DATA] KV Storage not available for key: ${key}`);
            return false;
        }
        
        const jsonString = JSON.stringify(data);
        await env.VMS_STORAGE.put(key, jsonString);
        const itemCount = Array.isArray(data) ? data.length + ' items' : Object.keys(data).length + ' keys';
        console.log(`[SAVE_DATA] Saved "${key}": ${jsonString.length} bytes, ${itemCount}`);
        return true;
        
    } catch (e) {
        console.error(`[SAVE_DATA] Error for key "${key}":`, e);
        return false;
    }
}


function sanitizeText(value, max = 120) {
    return String(value || '').replace(/[^\w\-.:@ ]/g, '').slice(0, max);
}

function clonePayloadSafe(value) {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
    } catch (cloneErr) {
        console.warn('[CLONE] structuredClone failed, falling back to JSON clone:', cloneErr?.message || cloneErr);
    }
    return JSON.parse(JSON.stringify(value || (Array.isArray(value) ? [] : {})));
}

async function appendLogsToSheet(logs) {
    if(!Array.isArray(logs) || logs.length === 0) return true;
    return pushLogsToGoogleScript(clonePayloadSafe(logs));
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

    const ok = await pushVisitorsToGoogleScript(clonePayloadSafe(changedVisitors));
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

async function pushVisitorsToGoogleScript(visitors) {
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
        const res = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
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

async function pushLogsToGoogleScript(logs) {
    const timeoutMs = 9000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const payload = {
            source: 'vms-worker',
            mode: 'append-only',
            version: PATCH_VERSION,
            updatedAt: Date.now(),
            logs
        };
        const res = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        const result = await res.json().catch(() => null);
        if (!res.ok || result?.ok === false) {
            globalThis.__vms_metrics.gasFail++;
            globalThis.__vms_metrics.lastGasFailAt = Date.now();
            console.error('[GAS] Append logical failure:', { status: res.status, result });
            console.log(JSON.stringify({ type:"GAS_FAIL", mode:"append-only", status: res.status, result, updatedAt: Date.now() }));
            return false;
        }
        return true;
    } catch (error) {
        globalThis.__vms_metrics.gasFail++;
        globalThis.__vms_metrics.lastGasFailAt = Date.now();
        if (error?.name === 'AbortError') {
            console.error('[GAS] Append timed out after ms:', timeoutMs);
            console.log(JSON.stringify({ type:"GAS_FAIL", mode:"append-only", reason:"timeout", timeoutMs, updatedAt: Date.now() }));
            return false;
        }
        console.error('[GAS] Append request error:', error);
        console.log(JSON.stringify({ type:"GAS_FAIL", mode:"append-only", reason:error?.message || "request_error", updatedAt: Date.now() }));
        return false;
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
    const ts = Math.floor((Number(log?.persistedAt || 0) || Date.parse(log?.time || log?.logTime || 0) || 0) / 1000);
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

    for (const company of companies) {
        const companyDevices = devices.filter(d => d.companyId === company.id);
        company.approvedDevices = companyDevices.filter(d => d.status === 'ACTIVE' || d.status === 'SUSPENDED' || d.status === 'BANNED').length;
        company.activeDevices = companyDevices.filter(d => d.status === 'ACTIVE' && (now - Number(d.lastSeen || 0)) < 5 * 60000).length;
        company.activeOnlineDevices = company.activeDevices;
        company.pendingDevices = companyDevices.filter(d => d.status === 'PENDING_APPROVAL').length;
        company.suspendedDevices = companyDevices.filter(d => d.status === 'SUSPENDED').length;
        company.deletedDevices = companyDevices.filter(d => d.status === 'DELETED').length;
        company.currentDevices = companyDevices.filter(d => d.status === 'ACTIVE').length;
        company.onlineDevices = company.activeDevices;
    }

    await saveData(env, 'devices', devices);
    await saveData(env, 'companies', companies);
    await saveData(env, 'device_requests', requests);
    await saveData(env, 'invoices', invoices);
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
        const persistedAt = Number(item.persistedAt || Date.now());
        const sequenceId = item.sequenceId || generateSequenceId(item.licenseKey || 'unknown', persistedAt);
        const gasReplayId = item.gasReplayId || generateGasReplayId({ sequenceId });
        normalized.push({ ...item, persistedAt, sequenceId, gasReplayId });
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
    return dedupGasQueueByReplayId([
        ...normalizeGasQueueEntries(baseQueue),
        ...normalizeGasQueueEntries(incomingQueue)
    ]);
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
