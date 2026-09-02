/*
 * ISOLA Suite — secure server v2
 * =================================
 * Adds: helmet, rate limiting, session-based auth (HttpOnly cookie),
 * Argon2id password hashing with lazy migration + immediate plaintext deletion,
 * server-side RBAC + field whitelisting, hourly automatic backups.
 *
 * Backward-compat surface for the current SPA:
 *   GET  /api/data      — still returns bulk snapshot, BUT
 *                          - requires session
 *                          - never contains user.p or user.pwd_hash
 *                          - user.sal only visible to director/accountant
 *   POST /api/data      — merge-by-id, but 'users' NOT mergeable through it
 *                          - requires session
 *   POST /api/delete    — requires session (director/accountant only)
 *   GET  /api/audit*    — requires session (director/accountant)
 *   POST /api/auth/login, /api/auth/logout, GET /api/auth/me — new
 *
 * Fresh endpoints for phase 2+ will replace /api/data with per-entity ones.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const argon2 = require('argon2');

const { buildAudit } = require('./audit');
const tg = require('./telegram');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const AUDIT_DIR = path.join(DATA_DIR, 'audits');
const SEED_FILE = path.join(__dirname, 'data.json');

const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
if (SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET env var must be set and be at least 32 chars long.');
  process.exit(1);
}
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const IS_PROD = process.env.NODE_ENV !== 'development';

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch (e) {}

// Seed on first boot only (never overwrites existing db)
if (!fs.existsSync(DB_FILE) && fs.existsSync(SEED_FILE)) {
  fs.copyFileSync(SEED_FILE, DB_FILE);
  console.log('[boot] Seeded ' + DB_FILE + ' from data.json');
}

// ==========================================================================
// APP
// ==========================================================================
const app = express();
app.set('trust proxy', 1); // required behind Railway proxy so req.ip is real
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Frontend uses inline scripts and inline styles heavily. Keep it working but restrict domains.
      'script-src': ["'self'", "'unsafe-inline'"],
      // Every button in index.html/hr.html uses onclick="..." — without this
      // directive helmet's default `script-src-attr 'none'` silently kills
      // every click handler in the UI (login button included).
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'font-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // PWA compat
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: IS_PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
}));
app.use(express.json({ limit: '256kb' })); // hard limit — was 8mb
app.use(cookieParser());

// --- CORS ---
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ==========================================================================
// STORAGE
// ==========================================================================
let writing = Promise.resolve();
function writeAtomic(data) {
  writing = writing.then(() => new Promise((resolve, reject) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data), (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DB_FILE, (err2) => err2 ? reject(err2) : resolve());
    });
  }));
  return writing;
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { return {}; }
}

let lock = Promise.resolve();
function withLock(fn) {
  lock = lock.then(fn, fn);
  return lock;
}

// ==========================================================================
// AUTOMATIC HOURLY BACKUPS
// ==========================================================================
// Retention: last 48 hourly + last 30 daily-at-01:07 (deterministic)
function backupNow(tag) {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `db-${tag}-${ts}.json`);
    fs.copyFileSync(DB_FILE, file);
    return file;
  } catch (e) { console.error('[backup] failed:', e.message); return null; }
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^db-.*\.json$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const hourly = files.filter(x => x.f.startsWith('db-hourly-')).slice(48);
    const daily = files.filter(x => x.f.startsWith('db-daily-')).slice(30);
    const manual = files.filter(x => x.f.startsWith('db-manual-')).slice(20);
    [...hourly, ...daily, ...manual].forEach(x => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch (_) {}
    });
  } catch (e) { console.error('[backup] prune failed:', e.message); }
}

// Cron: hourly at :07, daily at 01:07 Tashkent
const CRON_TZ = process.env.AUDIT_TZ || 'Asia/Tashkent';
cron.schedule('7 * * * *', () => { backupNow('hourly'); pruneBackups(); }, { timezone: CRON_TZ });
cron.schedule('7 1 * * *', () => { backupNow('daily'); pruneBackups(); }, { timezone: CRON_TZ });

// ==========================================================================
// AUTHENTICATION
// ==========================================================================
// Session cookie = base64url(payload).base64url(hmac).
// Payload: { uid, iat, exp } — signed with SESSION_SECRET (HMAC-SHA256).
// HttpOnly + Secure (in prod) + SameSite=Lax. 8h absolute lifetime.

const SESSION_COOKIE = 'isola_sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uDecode(s) {
  try {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (_) { return null; }
}
function sign(payloadStr) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest();
}
function makeToken(uid) {
  const now = Date.now();
  const payload = JSON.stringify({ uid, iat: now, exp: now + SESSION_TTL_MS });
  const p = b64u(payload);
  const sig = b64u(sign(p));
  return `${p}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const expected = b64u(sign(p));
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const json = b64uDecode(p);
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    if (!obj.uid || !obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch (_) { return null; }
}

function setSessionCookie(res, uid) {
  const t = makeToken(uid);
  res.cookie(SESSION_COOKIE, t, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

async function ensurePwdHash(user, plaintext) {
  // Called only after we've verified the plaintext matches (either via legacy p, or by hash).
  if (!user.pwd_hash) {
    user.pwd_hash = await argon2.hash(plaintext, { type: argon2.argon2id });
  }
  if ('p' in user) delete user.p; // requirement 6: remove plaintext immediately
}

async function verifyCredentials(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const db = readDB();
  const users = db.users || [];
  const u = users.find(x => (x.e || '').toLowerCase() === email.toLowerCase());
  if (!u) return null;
  let ok = false;
  if (u.pwd_hash) {
    try { ok = await argon2.verify(u.pwd_hash, password); } catch (_) { ok = false; }
  } else if (u.p && typeof u.p === 'string') {
    // legacy plaintext — one-shot migration on successful login
    ok = (u.p === password);
  }
  if (!ok) return null;
  // migrate immediately (requirement 6: hash + delete plaintext right after)
  if (!u.pwd_hash || 'p' in u) {
    await ensurePwdHash(u, password);
    await withLock(async () => {
      const cur = readDB();
      const cu = (cur.users || []).find(x => x.id === u.id);
      if (cu) { cu.pwd_hash = u.pwd_hash; if ('p' in cu) delete cu.p; }
      await writeAtomic(cur);
    });
  }
  return u;
}

function requireAuth(req, res, next) {
  const t = req.cookies && req.cookies[SESSION_COOKIE];
  const payload = verifyToken(t);
  if (!payload) return res.status(401).json({ ok: false, error: 'unauthenticated', code: 'AUTH_REQUIRED' });
  const db = readDB();
  const u = (db.users || []).find(x => x.id === payload.uid);
  if (!u) return res.status(401).json({ ok: false, error: 'unauthenticated', code: 'AUTH_REQUIRED' });
  req.user = u;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'forbidden', code: 'FORBIDDEN' });
    }
    next();
  };
}

// ==========================================================================
// RATE LIMITS
// ==========================================================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true, // only count failed attempts — brute-force protection, not legit users
  message: { ok: false, error: 'too many login attempts', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false,
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { ok: false, error: 'rate limited', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false,
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { ok: false, error: 'rate limited', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false,
});

// ==========================================================================
// AUDIT LOG (append-only)
// ==========================================================================
function logAudit(req, action, entity, entityId, before, after) {
  return withLock(async () => {
    const cur = readDB();
    if (!Array.isArray(cur.audit_log)) cur.audit_log = [];
    cur.audit_log.push({
      ts: new Date().toISOString(),
      uid: req.user ? req.user.id : null,
      name: req.user ? req.user.n : null,
      role: req.user ? req.user.role : null,
      action, entity, entityId,
      before: before || null, after: after || null,
      ip: req.ip, ua: (req.get('user-agent') || '').slice(0, 200),
    });
    if (cur.audit_log.length > 5000) cur.audit_log = cur.audit_log.slice(-5000);
    await writeAtomic(cur);
  }).catch(e => console.error('[audit] fail', e.message));
}

// ==========================================================================
// SANITIZERS
// ==========================================================================
// Strip fields the client must never see.
function sanitizeUser(u, viewer) {
  if (!u) return null;
  const isAdmin = viewer && (viewer.role === 'director' || viewer.role === 'accountant');
  const isSelf = viewer && viewer.id === u.id;
  const out = { id: u.id, n: u.n, e: u.e, role: u.role, dept: u.dept, ph: u.ph, dob: u.dob, start: u.start, photo: u.photo, tg: u.tg, instrs: u.instrs };
  if (isAdmin || isSelf) { out.sal = u.sal; out.comm = u.comm; }
  return out;
}
function sanitizeSnapshot(db, viewer) {
  const out = {};
  for (const k of Object.keys(db)) {
    if (k === 'users') out.users = (db.users || []).map(u => sanitizeUser(u, viewer));
    else if (k === 'audit_log') { /* never returned via bulk */ }
    else out[k] = db[k];
  }
  return out;
}

// ==========================================================================
// AUTH ROUTES
// ==========================================================================
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ ok: false, error: 'invalid credentials', code: 'AUTH_INVALID' });
    }
    // uniform error message + tiny delay to blunt timing/enum attacks
    const u = await verifyCredentials(email, password);
    if (!u) {
      await new Promise(r => setTimeout(r, 350 + Math.floor(Math.random() * 250)));
      return res.status(401).json({ ok: false, error: 'invalid credentials', code: 'AUTH_INVALID' });
    }
    setSessionCookie(res, u.id);
    logAudit({ user: u, ip: req.ip, get: h => req.get(h) }, 'LOGIN', 'user', u.id);
    res.json({ ok: true, user: sanitizeUser(u, u) });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const t = req.cookies && req.cookies[SESSION_COOKIE];
  const p = verifyToken(t);
  if (p) {
    const db = readDB();
    const u = (db.users || []).find(x => x.id === p.uid);
    if (u) logAudit({ user: u, ip: req.ip, get: h => req.get(h) }, 'LOGOUT', 'user', u.id);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const t = req.cookies && req.cookies[SESSION_COOKIE];
  const payload = verifyToken(t);
  if (!payload) return res.json({ ok: true, user: null });
  const db = readDB();
  const u = (db.users || []).find(x => x.id === payload.uid);
  if (!u) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: sanitizeUser(u, u) });
});

// ==========================================================================
// DATA / DELETE (auth required + hardened)
// ==========================================================================
app.get('/api/data', readLimiter, requireAuth, (req, res) => {
  try {
    const db = readDB();
    const sanitized = sanitizeSnapshot(db, req.user);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, data: sanitized });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' });
  }
});

// Keys the bulk POST is allowed to touch. `users` is deliberately excluded
// to eliminate mass-assignment on roles/salary/hashes.
const ARRAY_KEYS = ['cps','txs','orders','petty','deals','accruals','rates','products','sreqs','items','warehouse','logs'];
// Fields the client is NEVER allowed to set on user records (Phase 2 will add per-user endpoints).
const USER_FORBIDDEN = new Set(['p', 'pwd_hash', 'role', 'sal', 'comm']);

function mergeById(current, incoming) {
  const map = new Map();
  if (Array.isArray(current)) for (const r of current) if (r && r.id != null) map.set(String(r.id), r);
  if (Array.isArray(incoming)) {
    for (const r of incoming) {
      if (!r || r.id == null) continue;
      if (r._deleted) { map.delete(String(r.id)); continue; }
      map.set(String(r.id), r);
    }
  }
  return Array.from(map.values());
}

app.post('/api/data', writeLimiter, requireAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: 'invalid payload', code: 'BAD_PAYLOAD' });
    }
    const incoming = req.body;
    // Reject any attempt to write forbidden top-level keys via bulk endpoint
    if ('users' in incoming || 'audit_log' in incoming) {
      logAudit(req, 'BLOCKED_WRITE', 'system', null, null, { blocked_keys: Object.keys(incoming).filter(k => k === 'users' || k === 'audit_log') });
      return res.status(403).json({ ok: false, error: 'users/audit_log must use dedicated endpoints', code: 'FORBIDDEN_KEY' });
    }
    await withLock(async () => {
      const current = readDB();
      const merged = { ...current };
      for (const k of Object.keys(incoming)) {
        if (ARRAY_KEYS.includes(k) && Array.isArray(incoming[k])) {
          merged[k] = mergeById(current[k] || [], incoming[k]);
        } else if (k === 'users' || k === 'audit_log') {
          // already rejected above
        } else if (Array.isArray(incoming[k])) {
          // unknown array key — ignore silently to avoid mass-assignment
          continue;
        } else {
          merged[k] = incoming[k];
        }
      }
      await writeAtomic(merged);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' });
  }
});

app.post('/api/delete', writeLimiter, requireAuth, requireRole('director', 'accountant'), async (req, res) => {
  try {
    const { key, ids } = req.body || {};
    if (!ARRAY_KEYS.includes(key) || !Array.isArray(ids)) {
      return res.status(400).json({ ok: false, error: 'invalid payload', code: 'BAD_PAYLOAD' });
    }
    const idSet = new Set(ids.map(String));
    let removed = 0;
    let beforeSnapshot = [];
    await withLock(async () => {
      const current = readDB();
      beforeSnapshot = (current[key] || []).filter(r => idSet.has(String(r && r.id)));
      current[key] = (current[key] || []).filter(r => !idSet.has(String(r && r.id)));
      removed = beforeSnapshot.length;
      await writeAtomic(current);
    });
    if (removed > 0) await logAudit(req, 'DELETE', key, ids, beforeSnapshot, null);
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' });
  }
});

// ==========================================================================
// AUDIT REPORTS (director/accountant only, or ADMIN_KEY for cron pull)
// ==========================================================================
function auditAuth(req, res, next) {
  // Accept either session (director/accountant) or ADMIN_KEY header/query
  if (ADMIN_KEY && (req.get('x-admin-key') === ADMIN_KEY || req.query.key === ADMIN_KEY)) return next();
  const t = req.cookies && req.cookies[SESSION_COOKIE];
  const p = verifyToken(t);
  if (!p) return res.status(401).json({ ok: false, error: 'unauthenticated', code: 'AUTH_REQUIRED' });
  const db = readDB();
  const u = (db.users || []).find(x => x.id === p.uid);
  if (!u || (u.role !== 'director' && u.role !== 'accountant')) {
    return res.status(403).json({ ok: false, error: 'forbidden', code: 'FORBIDDEN' });
  }
  req.user = u;
  next();
}

async function runAudit(mode, opts = {}) {
  const db = readDB();
  const report = buildAudit(db, mode);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(AUDIT_DIR, `${ts}-${mode}.md`);
  try { fs.writeFileSync(file, report); } catch (_) {}
  let tgResult = null;
  if (tg.hasToken && !opts.skipTelegram) {
    try { tgResult = await tg.send(opts.chatId, report); }
    catch (e) { console.error('[tg]', e.message); tgResult = { error: e.message }; }
  }
  return { report, file, tgResult };
}

app.get('/api/audit', auditAuth, async (req, res) => {
  try {
    const mode = req.query.mode === 'eod' ? 'eod' : 'midday';
    const skipTelegram = req.query.tg === '0';
    const result = await runAudit(mode, { skipTelegram });
    res.type('text/markdown; charset=utf-8').send(result.report);
  } catch (e) { res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' }); }
});
app.get('/api/audit/list', auditAuth, (req, res) => {
  try {
    const files = fs.readdirSync(AUDIT_DIR).filter(f => f.endsWith('.md')).sort().reverse();
    res.json({ ok: true, files });
  } catch (e) { res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' }); }
});
app.get('/api/audit/file/:name', auditAuth, (req, res) => {
  try {
    const safe = path.basename(req.params.name);
    if (!/^[\w\-.:]+\.md$/.test(safe)) return res.status(400).send('bad name');
    const p = path.join(AUDIT_DIR, safe);
    if (!fs.existsSync(p)) return res.status(404).send('not found');
    res.type('text/markdown; charset=utf-8').send(fs.readFileSync(p, 'utf8'));
  } catch (e) { res.status(500).send('err'); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), tg: tg.hasToken }));

// ==========================================================================
// BANK SMS INTEGRATION (Asia Alliance Bank — AAB_UZ)
// ==========================================================================
// Flow:
//   iOS Shortcut → POST /api/bank/sms with { text } and X-Bank-Secret
//   → parse, insert draft tx (status:PENDING) → Telegram msg with buttons
//   Telegram webhook → POST /api/telegram/webhook with callback_query
//   → set tx.iid (expense) or tx.inc_cat (income), status:CATEGORIZED,
//     edit the Telegram card in place.
const bankSms = require('./bank-sms');
const BANK_SMS_SECRET = (process.env.BANK_SMS_SECRET || '').trim();
const TG_WEBHOOK_SECRET = (process.env.TG_WEBHOOK_SECRET || '').trim();

// Rate-limit the SMS endpoint separately so a runaway Shortcut can't drown us.
const smsLimiter = rateLimit({
  windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'too many SMS', code: 'RATE_LIMITED' },
});

function ipoolAsUZS(amount) { return { amt: amount, cur: 'UZS', rate: 1, uzs: amount }; }

app.post('/api/bank/sms', smsLimiter, async (req, res) => {
  try {
    if (!BANK_SMS_SECRET) return res.status(500).json({ ok: false, error: 'BANK_SMS_SECRET not set', code: 'MISCONFIGURED' });
    const provided = (req.get('x-bank-secret') || req.body?.secret || '').trim();
    if (provided.length !== BANK_SMS_SECRET.length ||
        !require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(BANK_SMS_SECRET))) {
      return res.status(401).json({ ok: false, error: 'auth', code: 'AUTH_INVALID' });
    }
    const text = String(req.body?.text || '').slice(0, 2000);
    if (!text) return res.status(400).json({ ok: false, error: 'no text', code: 'BAD_REQUEST' });

    const parsed = bankSms.parseAAB(text);
    if (!parsed) return res.json({ ok: true, ignored: true, reason: 'not a tx SMS (OTP or unknown)' });
    if (parsed.amount == null) return res.status(400).json({ ok: false, error: 'could not parse amount', code: 'PARSE_FAIL' });

    // Dedup + insert under the lock so a race-storm of duplicate SMS never
    // creates two rows.
    const result = await withLock(async () => {
      const db = readDB();
      db.txs = db.txs || [];
      const dup = db.txs.find((t) => t.sms_hash === parsed.hash);
      if (dup) return { ok: true, duplicate: true, tx_id: dup.id };

      const nextId = 1 + (db.txs.reduce((m, t) => Math.max(m, +t.id || 0), 0));
      const tx = {
        id: nextId,
        date: bankSms.today(),
        type: parsed.type,                     // 'income' | 'expense'
        acc: 'bank',
        iid: null,                             // set on categorization (expense)
        inc_cat: null,                         // set on categorization (income)
        cpid: null,
        oid: null,
        amt: parsed.amount, cur: 'UZS', rate: 1, uzs: parsed.amount,
        note: [parsed.counterparty, parsed.purpose].filter(Boolean).join(' — '),
        by: 0,                                 // 0 = bot/system
        debt: false,
        // bank-sms metadata
        status: 'PENDING',
        source: 'sms-aab',
        sms_hash: parsed.hash,
        sms_meta: {
          counterparty: parsed.counterparty,
          purpose: parsed.purpose,
          op_code: parsed.opCode,
          balance_after: parsed.balance,
        },
        tg_msg_id: null,
        tg_chat_id: null,
      };
      db.txs.push(tx);
      await writeAtomic(db);
      return { ok: true, tx };
    });

    if (result.duplicate) return res.json(result);

    // Send Telegram card with inline keyboard. Best-effort — a Telegram
    // outage should not prevent the SMS from being recorded.
    const tx = result.tx;
    try {
      const card = bankSms.buildPendingCard(parsed, tx.id);
      const kb   = bankSms.buildKeyboard(tx.id, parsed.type === 'income');
      const sent = await tg.sendWithButtons(null, card, kb);
      if (sent && sent.ok) {
        await withLock(async () => {
          const db2 = readDB();
          const t2 = (db2.txs || []).find((x) => x.id === tx.id);
          if (t2) { t2.tg_msg_id = sent.message_id; t2.tg_chat_id = sent.chat_id; await writeAtomic(db2); }
        });
      }
    } catch (e) {
      console.error('[bank-sms] telegram send failed:', e.message);
    }

    res.status(201).json({ ok: true, tx_id: tx.id, type: tx.type, amount: tx.amt });
  } catch (e) {
    console.error('[bank-sms] fail:', e.message);
    res.status(500).json({ ok: false, error: 'internal', code: 'INTERNAL' });
  }
});

// Telegram webhook. Optional secret via secret_token header (setWebhook
// registers this — Telegram then sends it as X-Telegram-Bot-Api-Secret-Token).
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    if (TG_WEBHOOK_SECRET) {
      const provided = req.get('x-telegram-bot-api-secret-token') || '';
      if (provided !== TG_WEBHOOK_SECRET) return res.status(401).end();
    }
    const update = req.body || {};
    const cq = update.callback_query;
    if (!cq) return res.status(200).json({ ok: true });

    const data = String(cq.data || '');
    const m = data.match(/^bs:cat:(\d+):(.+)$/);
    if (!m) {
      await tg.answerCallbackQuery(cq.id, 'Неизвестное действие');
      return res.status(200).json({ ok: true });
    }
    const txId = parseInt(m[1], 10);
    const catCode = m[2];

    const outcome = await withLock(async () => {
      const db = readDB();
      const tx = (db.txs || []).find((t) => t.id === txId);
      if (!tx) return { ok: false, reason: 'not found' };
      // Only tolerate this callback against a bank-sms-created tx that is
      // still awaiting a category. This guards against callbacks with
      // spoofed data pointing at unrelated (or already-final) rows.
      if (tx.source !== 'sms-aab') return { ok: false, reason: 'wrong source' };
      if (tx.status === 'CATEGORIZED') return { ok: true, tx, already: true };
      if (tx.status !== 'PENDING') return { ok: false, reason: 'wrong status' };

      const isIncome = tx.type === 'income';
      // Validate catCode against the appropriate list — reject cross-type.
      const validList = isIncome ? bankSms.INCOME_CATS : bankSms.EXPENSE_CATS;
      const wantId = isIncome ? String(catCode) : parseInt(catCode, 10);
      if (!validList.some((c) => c.id === wantId)) return { ok: false, reason: 'unknown category' };

      if (isIncome) tx.inc_cat = catCode;
      else tx.iid = parseInt(catCode, 10);
      tx.status = 'CATEGORIZED';
      tx.categorized_at = new Date().toISOString();
      tx.categorized_by = cq.from ? (cq.from.username || String(cq.from.id)) : 'telegram';
      await writeAtomic(db);
      return { ok: true, tx, isIncome };
    });

    if (!outcome.ok) {
      await tg.answerCallbackQuery(cq.id, 'Транзакция не найдена');
      return res.status(200).json({ ok: true });
    }

    const catName = bankSms.catNameById(outcome.tx.type === 'income', catCode);
    await tg.answerCallbackQuery(cq.id, outcome.already ? 'Уже отмечено' : `→ ${catName}`);

    // Edit the original card in place, removing buttons and adding checkmark.
    if (cq.message && cq.message.chat && cq.message.message_id) {
      const parsedShape = {
        type: outcome.tx.type,
        amount: outcome.tx.amt,
        counterparty: outcome.tx.sms_meta && outcome.tx.sms_meta.counterparty,
        purpose: outcome.tx.sms_meta && outcome.tx.sms_meta.purpose,
      };
      const newText = bankSms.buildCategorizedCard(parsedShape, catName, outcome.tx.categorized_by);
      await tg.editMessageText(cq.message.chat.id, cq.message.message_id, newText, [], {});
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[tg-webhook] fail:', e.message);
    res.status(200).json({ ok: false, error: 'internal' });
  }
});

// Trigger a manual backup (director only, useful before risky ops)
app.post('/api/backup', writeLimiter, requireAuth, requireRole('director'), (req, res) => {
  const f = backupNow('manual');
  if (!f) return res.status(500).json({ ok: false, error: 'backup failed', code: 'INTERNAL' });
  pruneBackups();
  res.json({ ok: true, file: path.basename(f) });
});

// ==========================================================================
// STATIC + FALLBACK
// ==========================================================================
app.use(express.static(__dirname, { extensions: ['html'], maxAge: 0 }));

// Anything else that starts with /api/* but wasn't matched → structured 404
app.use('/api/', (req, res) => res.status(404).json({ ok: false, error: 'not found', code: 'NOT_FOUND' }));

// Generic safe error handler — never leaks stack traces
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // body-parser payload-too-large
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ ok: false, error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid json', code: 'BAD_JSON' });
  }
  console.error('[err]', err && err.message);
  res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' });
});

// ==========================================================================
// SCHEDULED AUDITS
// ==========================================================================
cron.schedule('0 13 * * *', () => { runAudit('midday').catch(e => console.error('[cron midday]', e.message)); }, { timezone: CRON_TZ });
cron.schedule('0 20 * * *', () => { runAudit('eod').catch(e => console.error('[cron eod]', e.message)); }, { timezone: CRON_TZ });

// Do an initial startup backup so we have at least one snapshot
setTimeout(() => { backupNow('boot'); pruneBackups(); }, 5000);

app.listen(PORT, () => {
  console.log(`ISOLA secure server listening on ${PORT}`);
  console.log(`  data: ${DATA_DIR}   backups: ${BACKUP_DIR}   audits: ${AUDIT_DIR}`);
  console.log(`  cron tz: ${CRON_TZ}   telegram: ${tg.hasToken ? 'enabled' : 'DISABLED'}   admin-key: ${ADMIN_KEY ? 'set' : 'unset'}`);
  console.log(`  cors origins: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(', ') : '(same-origin only)'}`);
});
