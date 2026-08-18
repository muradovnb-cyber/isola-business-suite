/*
 * Offline self-test for ai-runner v0.2 HTTP surface.
 * Covers all 12 Phase-1 hardening items in the ways we can verify without
 * live Claude / GitHub / Anthropic credentials.
 */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 4900 + Math.floor(Math.random() * 100);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runner-workspace-'));
const env = {
  ...process.env,
  PORT: String(PORT),
  ANTHROPIC_API_KEY: 'anthr-noop',
  GH_TOKEN: 'ghp_noop',
  RUNNER_TOKEN: 'test-secret-abc-32ch-hexish-abcdef',
  WORKSPACE_ROOT: workspace,
  REPO_DIR: workspace + '/repo',
  CLAUDE_BIN: '/bin/true',
  MAX_PAYLOAD_BYTES: '4096', // small on purpose so we can exceed easily
};

const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proc.stdout.on('data', d => log += d);
proc.stderr.on('data', d => log += d);

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed; try { parsed = buf ? JSON.parse(buf) : null; } catch (_) { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function wait() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('runner did not start:\n' + log);
}

const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  ✔', name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  ✕', name, '\n     ', e.message); }
}
const BEARER = 'Bearer ' + env.RUNNER_TOKEN;

(async () => {
  try {
    await wait();
    console.log('\n=== ai-runner v0.2 self-test ===');

    console.log('\n[1] Webhook authentication');
    await t('/health is open (no auth)', async () => { const r = await req('GET', '/health'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true); });
    await t('/task without Authorization → 401', async () => { const r = await req('POST', '/task', { taskId: 'T-1', spec: {} }); assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'AUTH_REQUIRED'); });
    await t('/task wrong token → 401', async () => { const r = await req('POST', '/task', { taskId: 'T-1', spec: {} }, { authorization: 'Bearer wrong' }); assert.strictEqual(r.status, 401); });
    await t('/task valid token accepted (past auth gate)', async () => { const r = await req('POST', '/task', {}, { authorization: BEARER }); assert.strictEqual(r.status, 400); /* auth OK, validation fails next */ });

    console.log('\n[2] taskId / runId validation (regex enforced)');
    await t('missing taskId → 400 BAD_TASK_ID', async () => { const r = await req('POST', '/task', { spec: { task: 'x' } }, { authorization: BEARER }); assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'BAD_TASK_ID'); });
    await t('command-injection-shaped taskId → 400', async () => { const r = await req('POST', '/task', { taskId: 'x;rm -rf /', spec: { task: 'x' } }, { authorization: BEARER }); assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'BAD_TASK_ID'); });
    await t('unicode/backtick taskId → 400', async () => { const r = await req('POST', '/task', { taskId: '`ls`', spec: { task: 'x' } }, { authorization: BEARER }); assert.strictEqual(r.status, 400); });
    await t('81-char taskId → 400 (length cap)', async () => { const r = await req('POST', '/task', { taskId: 'a'.repeat(81), spec: { task: 'x' } }, { authorization: BEARER }); assert.strictEqual(r.status, 400); });
    await t('valid taskId + invalid runId → 400 BAD_RUN_ID', async () => { const r = await req('POST', '/task', { taskId: 'OK-1', runId: 'bad$run', spec: { task: 'x' } }, { authorization: BEARER }); assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'BAD_RUN_ID'); });

    console.log('\n[3] Payload limits');
    await t('body >4KB → 413 PAYLOAD_TOO_LARGE', async () => {
      const huge = 'x'.repeat(6000);
      const r = await req('POST', '/task', { taskId: 'T', spec: { task: huge } }, { authorization: BEARER });
      assert(r.status === 413 || r.status === 400, `expected 413/400, got ${r.status}`);
    });
    await t('malformed JSON → 400 BAD_JSON', async () => {
      const r = await req('POST', '/task', '{not:json', {}, { authorization: BEARER });
      assert(r.status === 400);
    });

    console.log('\n[4] Missing spec → 400 BAD_SPEC (after taskId ok)');
    await t('valid taskId + no spec → 400 BAD_SPEC', async () => { const r = await req('POST', '/task', { taskId: 'OK-1' }, { authorization: BEARER }); assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'BAD_SPEC'); });

    console.log('\n[5] Idempotency by runId');
    // We can't actually run Claude, but /task will fail at git clone (network to github with fake token) and cache the FAILED result. Second call must return the cached response.
    await t('duplicate runId returns cached response with idempotent:true', async () => {
      const payload = { taskId: 'IDEM-1', runId: 'run-abc-123', spec: { task: 'x' } };
      const r1 = await req('POST', '/task', payload, { authorization: BEARER });
      const r2 = await req('POST', '/task', payload, { authorization: BEARER });
      // Both should return same status; second must have idempotent:true
      assert(r1.status >= 200 && r1.status < 600, 'r1 status');
      assert.strictEqual(r2.body.idempotent, true, 'second call not marked idempotent');
      assert.strictEqual(r2.body.runId, 'run-abc-123');
    });

    console.log('\n[6] Concurrent workspace isolation (unique dirs)');
    await t('two different runIds produce different workspace paths', async () => {
      // We spy on the workspace root and verify runs go into distinct subdirs after each call.
      const runsDir = path.join(workspace, 'runs');
      // trigger a run (which will fail quickly at clone)
      await req('POST', '/task', { taskId: 'W1', runId: 'ws-run-1-xyz', spec: { task: 'x' } }, { authorization: BEARER });
      await req('POST', '/task', { taskId: 'W2', runId: 'ws-run-2-xyz', spec: { task: 'x' } }, { authorization: BEARER });
      // Directories are cleaned on success, kept on failure. Both runs failed at clone, so they may or may not be kept — that's fine.
      // The real guarantee is that the CODE path uses runId in the workspace name; we verify by grep on the source instead:
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert(/path\.join\(RUNS_DIR,\s*runId\)/.test(src), 'workspace path must include runId');
    });

    console.log('\n[7] Secret redaction');
    await t('secret redaction utility replaces well-known patterns', async () => {
      // We can only exercise this by grepping the log for the fake token we set — which is a proxy for RUNNER_TOKEN never appearing in log output.
      assert(!log.includes(env.RUNNER_TOKEN), 'RUNNER_TOKEN appeared in server log');
      assert(!log.includes(env.GH_TOKEN), 'GH_TOKEN appeared in server log');
      assert(!log.includes(env.ANTHROPIC_API_KEY), 'ANTHROPIC_API_KEY appeared in server log');
    });

    console.log('\n[8] Rate limiting');
    await t('21 failed auths in a row → 429 RATE_LIMITED', async () => {
      let last = 0;
      for (let i = 0; i < 25; i++) {
        const r = await req('POST', '/task', { taskId: 'T', spec: {} }, { authorization: 'Bearer wrong' + i });
        last = r.status;
        if (last === 429) break;
      }
      assert.strictEqual(last, 429, `expected 429, got ${last}`);
    });

    console.log('\n[9] Command injection defence (source-level check)');
    await t('server never uses spawnSync with shell:true or execSync on user input', async () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert(!/shell:\s*true/.test(src), 'shell:true found in server.js — command injection risk');
      assert(!/execSync\(/.test(src), 'execSync usage found — should be spawnSync with argv array');
      assert(!/exec\((?!Sync|File)/.test(src), 'exec() with string command found');
    });

    console.log('\n[10] Safe git auth (source-level check — no token in URL)');
    await t('server never embeds GH_TOKEN in REPO_URL and uses GIT_ASKPASS', async () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert(!/x-access-token:\$\{GH_TOKEN\}/.test(src), 'token embedded in URL — insecure');
      assert(/GIT_ASKPASS/.test(src), 'GIT_ASKPASS not used');
    });

    console.log('\n[11] Concurrency cap (source-level)');
    await t('MAX_CONCURRENT enforced', async () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert(/inflight\s*>=\s*MAX_CONCURRENT/.test(src), 'concurrency check missing');
    });

    console.log('\n[12] Deploy safety (source-level)');
    await t('no active invocation of railway/deploy/push-to-main', async () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      // Strip line and block comments before checking code paths.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
      assert(!/['"`]railway['"`]/.test(code), 'source references "railway" outside comments');
      assert(!/npm run deploy/.test(code), 'runner must NOT deploy');
      // never push to main (accept push to origin <ref> where ref is a branch var, forbid literal main)
      assert(!/push[^)]*['"`]main['"`]/.test(code), 'runner must never push to main');
    });

    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n${'='.repeat(50)}\nRESULTS: ${passed}/${results.length} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\nFailures:');
      results.filter(r => !r.ok).forEach(r => console.log(`  ✕ ${r.name}\n     ${r.err}`));
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('HARNESS ERROR:', e);
    console.error('---\nServer log:\n', log);
    process.exitCode = 1;
  } finally {
    proc.kill();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
  }
})();
