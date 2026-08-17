/*
 * Offline self-test for ai-runner/server.js
 *
 * We cannot fully exercise Claude Code / GitHub / Anthropic from here without
 * live credentials. This test verifies:
 *   - The module loads only when required env vars are present.
 *   - /health responds without auth.
 *   - /task rejects requests without RUNNER_TOKEN.
 *   - /task validates payload shape.
 *
 * That's enough to catch structural regressions in CI.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 4900 + Math.floor(Math.random() * 100);
const env = {
  ...process.env,
  PORT: String(PORT),
  ANTHROPIC_API_KEY: 'test-noop',
  GH_TOKEN: 'test-noop',
  RUNNER_TOKEN: 'test-secret-abc',
  REPO_DIR: '/tmp/isola-runner-selftest-repo',
  CLAUDE_BIN: '/bin/true',
};

const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proc.stdout.on('data', d => log += d);
proc.stderr.on('data', d => log += d);

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function wait() {
  for (let i = 0; i < 30; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('runner did not start:\n' + log);
}

const results = [];
async function t(name, fn) { try { await fn(); results.push({ name, ok: true }); console.log('  ✔', name); } catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  ✕', name, '\n     ', e.message); } }

(async () => {
  try {
    await wait();
    console.log('\n=== ai-runner self-test ===');
    await t('/health returns 200 without auth', async () => {
      const r = await req('GET', '/health');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ok, true);
    });
    await t('/task without Authorization → 401', async () => {
      const r = await req('POST', '/task', { taskId: 'x', spec: { task: 'noop' } });
      assert.strictEqual(r.status, 401);
    });
    await t('/task with wrong token → 401', async () => {
      const r = await req('POST', '/task', { taskId: 'x', spec: { task: 'noop' } }, { authorization: 'Bearer wrong' });
      assert.strictEqual(r.status, 401);
    });
    await t('/task with valid token but no taskId → 400', async () => {
      const r = await req('POST', '/task', {}, { authorization: 'Bearer test-secret-abc' });
      assert.strictEqual(r.status, 400);
    });

    const passed = results.filter(r => r.ok).length;
    console.log(`\nRESULTS: ${passed}/${results.length} passed`);
    if (passed < results.length) process.exitCode = 1;
  } catch (e) {
    console.error('HARNESS ERROR:', e); console.error(log); process.exitCode = 1;
  } finally {
    proc.kill();
  }
})();
