// خادم الأسئلة المباشرة — Node.js بدون إطار عمل، مكتبة واحدة فقط (qrcode)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';       // مفتاح التحكم (حذف / تثبيت سؤال)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // اختياري: رابط الموقع الدائم
const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_LEN = 300;
const MAX_QUESTIONS = 500;
const COOLDOWN_MS = 5000;

let state = { questions: [], featured: null };
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state), () => {});
  }, 500);
}

// ---- البث المباشر (SSE) ----
const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
  save();
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---- أدوات ----
const lastPost = new Map();
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const real = Buffer.from(ADMIN_KEY);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > 4096) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function origin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/qr.svg') {
      const svg = await QRCode.toString(origin(req) + '/', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      return res.end(svg);
    }

    if (p === '/api/info') return json(res, 200, { url: origin(req) + '/', adminEnabled: !!ADMIN_KEY });

    if (p === '/api/questions' && req.method === 'POST') {
      const ip = clientIp(req), now = Date.now();
      if (now - (lastPost.get(ip) || 0) < COOLDOWN_MS) return json(res, 429, { error: 'استنى ثواني قبل ما ترسل سؤال ثاني' });
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, MAX_LEN);
      const name = String(body.name || '').trim().slice(0, 40);
      if (text.length < 2) return json(res, 400, { error: 'اكتب سؤالك أولاً' });
      lastPost.set(ip, now);
      state.questions.push({ id: crypto.randomUUID(), text, name, ts: now });
      if (state.questions.length > MAX_QUESTIONS) state.questions.shift();
      broadcast();
      return json(res, 201, { ok: true });
    }

    if (p === '/api/feature' && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 401, { error: 'غير مصرح' });
      const body = await readBody(req);
      state.featured = body.id && state.questions.some(q => q.id === body.id) ? body.id : null;
      broadcast();
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/questions/') && req.method === 'DELETE') {
      if (!isAdmin(req)) return json(res, 401, { error: 'غير مصرح' });
      const id = p.split('/').pop();
      state.questions = state.questions.filter(q => q.id !== id);
      if (state.featured === id) state.featured = null;
      broadcast();
      return json(res, 200, { ok: true });
    }

    // ---- الملفات الثابتة ----
    let file = p === '/' ? '/index.html' : p === '/screen' ? '/screen.html' : p;
    const full = path.normalize(path.join(__dirname, 'public', file));
    if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('الصفحة غير موجودة'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 400, { error: 'طلب غير صالح' });
  }
});

server.listen(PORT, () => {
  console.log(`الخادم شغال على المنفذ ${PORT}`);
  if (!ADMIN_KEY) console.log('تنبيه: ADMIN_KEY غير مضبوط — أزرار الحذف والتثبيت معطّلة.');
});
