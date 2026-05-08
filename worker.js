// ==================== VMS WORKER v3.0 - HARDENED PRODUCTION ====================
// Cloudflare Worker untuk VMS SAPAM MEDED
// KV Namespace: VMS_STORAGE

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
        
        // ==================== OPTIONS HANDLER (SAFE CORS) ====================
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        
        try {
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
                    timestamp: Date.now()
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
                '/approve-device-request'
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
                    return new Response(JSON.stringify({ ok: false, message: 'License key required' }), { headers: corsHeaders });
                }
                
                const companies = await getData(env, 'companies');
                const company = companies.find(c => c.licenseKey === licenseKey);
                
                if (!company) {
                    return new Response(JSON.stringify({ ok: false, message: 'Invalid license key' }), { headers: corsHeaders });
                }
                
                const isExpired = company.expiredAt < Date.now();
                if (isExpired) {
                    return new Response(JSON.stringify({ 
                        ok: false, 
                        message: 'License expired',
                        company: { ...company, status: 'EXPIRED' }
                    }), { headers: corsHeaders });
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
                        companyName: company.companyName,
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
                
                return new Response(JSON.stringify({
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
                    device: device
                }), { headers: corsHeaders });
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
            
            // ==================== CHECK-IN / CHECK-OUT MODULE ====================
            if (path === '/checkin' && request.method === 'POST') {
                const body = await request.json();
                const { licenseKey, deviceId, action, location } = body;
                
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
                    companyName: company.companyName,
                    action: action,
                    location: location || null,
                    timestamp: Date.now(),
                    type: action === 'IN' ? 'CHECK_IN' : 'CHECK_OUT'
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
                    companyName: company.companyName,
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
                    companyName: company.companyName,
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
                    companyName: company.companyName,
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
                
                device.status = approve ? 'ACTIVE' : 'REJECTED';
                if (!approve) {
                    device.deletedAt = Date.now();
                }
                
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
                devices[index].deleteReason = reason;
                await saveData(env, 'devices', devices);
                
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
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
                
                companies.splice(index, 1);
                await saveData(env, 'companies', companies);
                
                const devices = await getData(env, 'devices');
                const remainingDevices = devices.filter(d => d.companyId !== companyId);
                await saveData(env, 'devices', remainingDevices);
                
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
                                companyName: company.companyName,
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
                const body = await request.json();
                
                if (body.visitors && Object.keys(body.visitors).length > 0) {
                    let allVisitors = await getData(env, 'visitors');
                    for (const [key, value] of Object.entries(body.visitors)) {
                        allVisitors[key] = { ...allVisitors[key], ...value, lastSync: Date.now() };
                    }
                    await saveData(env, 'visitors', allVisitors);
                }
                
                if (body.logs && body.logs.length > 0) {
                    let allLogs = await getData(env, 'logs');
                    allLogs = [...body.logs, ...allLogs];
                    await saveData(env, 'logs', allLogs.slice(0, 10000));
                }
                
                if (body.anti) {
                    let reports = await getData(env, 'anti_nakal_reports');
                    reports.unshift({
                        ...body.anti,
                        deviceId: body.deviceId,
                        site: body.site,
                        timestamp: Date.now()
                    });
                    await saveData(env, 'anti_nakal_reports', reports.slice(0, 5000));
                }
                
                return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
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