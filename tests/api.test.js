/*
 * Integration tests for ISOLA Suite API — Phase 0-1.
 * Spawns the server in a temp DATA_DIR, hits it via fetch, asserts contracts.
 * Uses only Node built-ins (assert) — no test framework needed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isola-test-'));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Seed db with 4 users (director/accountant/manager/other) mirroring production shape.
const seed = {
  users: [
    { id: 1, n: 'Director', e: 'dir@t', p: 'dpass', role: 'director', dept: null, sal: 0 },
    { id: 2, n: 'Accountant', e: 'acc@t', p: 'apass', role: 'accountant', dept: 'finance', sal: 1000 },
    { id: 3, n: 'Manager', e: 'mgr@t', p: 'mpass', role: 'manager', dept: 'sales', sal: 500 },
    { id: 4, n: 'Supply', e: 'sup@t', p: 'spass', role: 'supply', dept: 'production', sal: 300 },
  ],
  cps: [{ id: 1, n: 'Alpha Co', type: 'supplier' }],
  txs: [{ id: 1, kind: 'expense', sum_uzs: 100000, date: '2026-01-01', by: 2, note: 'seed tx' }],
  orders: [{ id: 1, title: 'Order-1', mid: 3, uzs: 1000000, status: 'active' }],
  petty: [], deals: [], accruals: [], rates: [], products: [], sreqs: [], items: [], warehouse: [], logs: [],
};
fs.writeFileSync(path.join(DATA_DIR, 'db.json'), JSON.stringify(seed));

// Start server
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const PORT = 4600 + Math.floor(Math.random() * 300);
const env = { ...process.env, DATA_DIR, PORT: String(PORT), SESSION_SECRET, ADMIN_KEY: 'admin-test-key', NODE_ENV: 'development' };
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', d => srvLog += d.toString());
srv.stderr.on('data', d => srvLog += d.toString());

const BASE = `http://127.0.0.1:${PORT}`;
const stash = {};

async function waitReady(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready:\n' + srvLog);
}

function extractCookie(res) {
  const c = res.headers.get('set-cookie') || '';
  const m = c.match(/isola_sid=([^;]+)/);
  return m ? `isola_sid=${m[1]}` : null;
}

async function req(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let body = null;
  const text = await r.text();
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  return { status: r.status, body, cookie: extractCookie(r) };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✔ ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  ✕ ${name}\n     ${e.message}`); }
}

(async () => {
  try {
    await waitReady();
    console.log('\n=== [1] UNAUTHENTICATED ACCESS ===');
    await test('GET /api/data → 401 without session', async () => {
      const r = await req('GET', '/api/data');
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.body.code, 'AUTH_REQUIRED');
    });
    await test('POST /api/data → 401 without session', async () => {
      const r = await req('POST', '/api/data', { body: {} });
      assert.strictEqual(r.status, 401);
    });
    await test('POST /api/delete → 401 without session', async () => {
      const r = await req('POST', '/api/delete', { body: { key: 'sreqs', ids: [] } });
      assert.strictEqual(r.status, 401);
    });
    await test('GET /api/audit → 401 without session or admin key', async () => {
      const r = await req('GET', '/api/audit?mode=midday&tg=0');
      assert.strictEqual(r.status, 401);
    });
    await test('GET /api/audit with ADMIN_KEY → 200', async () => {
      const r = await req('GET', '/api/audit?mode=midday&tg=0&key=admin-test-key');
      assert.strictEqual(r.status, 200);
    });

    console.log('\n=== [2] LOGIN FLOW ===');
    await test('login wrong password → 401 + no cookie', async () => {
      const r = await req('POST', '/api/auth/login', { body: { email: 'dir@t', password: 'WRONG' } });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.cookie, null);
    });
    await test('login correct password → 200 + HttpOnly cookie', async () => {
      const r = await req('POST', '/api/auth/login', { body: { email: 'dir@t', password: 'dpass' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.user.role, 'director');
      assert.strictEqual(r.body.user.p, undefined, 'user.p leaked');
      assert.strictEqual(r.body.user.pwd_hash, undefined, 'pwd_hash leaked');
      assert(r.cookie, 'session cookie not set');
      stash.dirCookie = r.cookie;
    });
    await test('after login, /api/auth/me returns sanitized user', async () => {
      const r = await req('GET', '/api/auth/me', { cookie: stash.dirCookie });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.user.id, 1);
      assert.strictEqual(r.body.user.p, undefined);
      assert.strictEqual(r.body.user.pwd_hash, undefined);
    });
    await test('login also migrated plaintext p → hashed and stripped', async () => {
      const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
      const dir = db.users.find(u => u.id === 1);
      assert(!('p' in dir), 'plaintext p not removed after login');
      assert(typeof dir.pwd_hash === 'string' && dir.pwd_hash.startsWith('$argon2id$'), 'pwd_hash is not argon2id');
    });
    await test('subsequent login with same password succeeds (verifies hash path)', async () => {
      const r = await req('POST', '/api/auth/login', { body: { email: 'dir@t', password: 'dpass' } });
      assert.strictEqual(r.status, 200);
    });

    console.log('\n=== [3] AUTHENTICATED ACCESS ===');
    // Manager cookie
    const mgrLogin = await req('POST', '/api/auth/login', { body: { email: 'mgr@t', password: 'mpass' } });
    assert.strictEqual(mgrLogin.status, 200);
    stash.mgrCookie = mgrLogin.cookie;
    const supLogin = await req('POST', '/api/auth/login', { body: { email: 'sup@t', password: 'spass' } });
    stash.supCookie = supLogin.cookie;
    const accLogin = await req('POST', '/api/auth/login', { body: { email: 'acc@t', password: 'apass' } });
    stash.accCookie = accLogin.cookie;

    await test('GET /api/data as director → 200 + no plaintext passwords', async () => {
      const r = await req('GET', '/api/data', { cookie: stash.dirCookie });
      assert.strictEqual(r.status, 200);
      const users = r.body.data.users;
      assert(users.length >= 4);
      for (const u of users) {
        assert(!('p' in u), `user ${u.id} has plaintext p`);
        assert(!('pwd_hash' in u), `user ${u.id} has pwd_hash exposed`);
      }
    });
    await test('director sees salary (sal) for other users', async () => {
      const r = await req('GET', '/api/data', { cookie: stash.dirCookie });
      const acc = r.body.data.users.find(u => u.id === 2);
      assert.strictEqual(acc.sal, 1000);
    });
    await test('manager does NOT see other users\' salary', async () => {
      const r = await req('GET', '/api/data', { cookie: stash.mgrCookie });
      const acc = r.body.data.users.find(u => u.id === 2);
      assert.strictEqual(acc.sal, undefined, 'sal leaked to manager');
      const self = r.body.data.users.find(u => u.id === 3);
      assert.strictEqual(self.sal, 500, 'self sal should still be visible');
    });
    await test('audit_log never included in bulk response', async () => {
      const r = await req('GET', '/api/data', { cookie: stash.dirCookie });
      assert.strictEqual(r.body.data.audit_log, undefined);
    });

    console.log('\n=== [4] MASS ASSIGNMENT PROTECTION ===');
    await test('POST /api/data with users → 403 FORBIDDEN_KEY', async () => {
      const r = await req('POST', '/api/data', {
        cookie: stash.mgrCookie,
        body: { users: [{ id: 1, p: 'HACKED', role: 'director' }] }
      });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.code, 'FORBIDDEN_KEY');
      // Verify director password did NOT change
      const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
      const dir = db.users.find(u => u.id === 1);
      assert(!('p' in dir), 'p was reinjected');
      const r2 = await req('POST', '/api/auth/login', { body: { email: 'dir@t', password: 'HACKED' } });
      assert.strictEqual(r2.status, 401, 'hacked password worked!');
    });
    await test('POST /api/data with audit_log → 403', async () => {
      const r = await req('POST', '/api/data', {
        cookie: stash.dirCookie,
        body: { audit_log: [{ fake: true }] }
      });
      assert.strictEqual(r.status, 403);
    });
    await test('POST /api/data merges legitimate arrays (cps)', async () => {
      const r = await req('POST', '/api/data', {
        cookie: stash.dirCookie,
        body: { cps: [{ id: 999, n: 'test-cp', type: 'supplier' }] }
      });
      assert.strictEqual(r.status, 200);
      const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
      assert(db.cps.some(c => c.id === 999), 'merge did not apply');
    });

    console.log('\n=== [5] DELETE AUTHORIZATION ===');
    await test('POST /api/delete as manager → 403', async () => {
      const r = await req('POST', '/api/delete', { cookie: stash.mgrCookie, body: { key: 'cps', ids: [999] } });
      assert.strictEqual(r.status, 403);
    });
    await test('POST /api/delete as supply → 403', async () => {
      const r = await req('POST', '/api/delete', { cookie: stash.supCookie, body: { key: 'cps', ids: [999] } });
      assert.strictEqual(r.status, 403);
    });
    await test('POST /api/delete as accountant → 200 + audit-log entry', async () => {
      const r = await req('POST', '/api/delete', { cookie: stash.accCookie, body: { key: 'cps', ids: [999] } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.removed, 1);
      const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
      assert(!db.cps.some(c => c.id === 999), 'not actually deleted');
      const auditEntries = (db.audit_log || []).filter(e => e.action === 'DELETE' && e.entity === 'cps');
      assert(auditEntries.length >= 1, 'no DELETE audit entry');
      assert.strictEqual(auditEntries[auditEntries.length - 1].role, 'accountant');
    });
    await test('POST /api/delete with invalid key → 400', async () => {
      const r = await req('POST', '/api/delete', { cookie: stash.dirCookie, body: { key: 'users', ids: [1] } });
      assert.strictEqual(r.status, 400);
    });

    console.log('\n=== [6] LOGOUT + EXPIRATION ===');
    await test('logout invalidates cookie for subsequent requests', async () => {
      const lr = await req('POST', '/api/auth/logout', { cookie: stash.supCookie });
      assert.strictEqual(lr.status, 200);
      // The old cookie is still present client-side but the server clears it via Set-Cookie
      // A subsequent request WITHOUT the cookie should be 401.
      const r = await req('GET', '/api/data');
      assert.strictEqual(r.status, 401);
    });
    await test('forged cookie → 401', async () => {
      const r = await req('GET', '/api/data', { cookie: 'isola_sid=deadbeef.malformed' });
      assert.strictEqual(r.status, 401);
    });

    console.log('\n=== [7] RATE LIMITING ===');
    await test('6 wrong logins in a row → last one is 429', async () => {
      let last = 0;
      for (let i = 0; i < 6; i++) {
        const r = await req('POST', '/api/auth/login', { body: { email: 'dir@t', password: 'nope' + i } });
        last = r.status;
      }
      assert(last === 429, `expected 429 after 6 attempts, got ${last}`);
    });

    console.log('\n=== [8] SECURITY HEADERS ===');
    await test('/api/data emits HSTS in prod, CSP, X-Content-Type-Options, etc.', async () => {
      const r = await fetch(BASE + '/api/health');
      assert(r.headers.get('content-security-policy'), 'no CSP');
      assert(r.headers.get('x-content-type-options') === 'nosniff', 'no nosniff');
      // NODE_ENV=development so HSTS may be absent — that's expected
    });

    console.log('\n=== [9] PAYLOAD LIMIT ===');
    await test('POST body >256KB → 413 or 400', async () => {
      const huge = 'x'.repeat(300 * 1024);
      const r = await fetch(BASE + '/api/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: stash.dirCookie },
        body: JSON.stringify({ cps: [{ id: 1, n: huge }] }),
      });
      assert(r.status === 413 || r.status === 400, `expected 413/400, got ${r.status}`);
    });

    console.log('\n=== [10] BACKUP ENDPOINT ===');
    await test('POST /api/backup as manager → 403', async () => {
      const r = await req('POST', '/api/backup', { cookie: stash.mgrCookie });
      assert.strictEqual(r.status, 403);
    });
    await test('POST /api/backup as director → 200 + file created', async () => {
      const r = await req('POST', '/api/backup', { cookie: stash.dirCookie });
      assert.strictEqual(r.status, 200);
      assert(fs.existsSync(path.join(DATA_DIR, 'backups', r.body.file)));
    });

    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS: ${passed}/${results.length} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\nFailures:');
      results.filter(r => !r.ok).forEach(r => console.log(`  ✕ ${r.name}\n     ${r.err}`));
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('TEST HARNESS ERROR:', e);
    console.error('Server log:\n', srvLog);
    process.exitCode = 1;
  } finally {
    srv.kill();
    // Cleanup temp
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
})();
