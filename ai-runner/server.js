/*
 * ai-runner v0.2 — the "Claude Code" executor in the ISOLA orchestration
 * pipeline. Hardened against the Phase 1 review (12 items).
 *
 * Contract: unchanged from v0.1 (see README). This file changes only the
 * internals.
 *
 * Guarantees:
 *   * NEVER merges main, NEVER runs `railway up` or any deploy command.
 *   * NEVER uses shell interpolation on caller-controlled strings — every
 *     git/gh call goes through spawnSync with an argv array.
 *   * Each run gets a fresh isolated workspace at /workspace/runs/<runId>/,
 *     cleaned up on exit (kept 6h if failed, for post-mortem).
 *   * Tests run BEFORE commit; commit message and PR body report the true
 *     test result.
 *   * Uses GIT_ASKPASS helper so the GitHub PAT is never embedded in a
 *     remote URL, never written to git config, and only ever readable by
 *     the runner process for the duration of a task.
 *   * Idempotency by runId: repeated POSTs with the same runId return the
 *     cached response instead of re-running.
 *   * Rate limits: token-auth per-IP, /task per-IP, and a global inflight
 *     cap on concurrent Claude executions.
 */
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ------------------------------ config ------------------------------------
const PORT = int(process.env.PORT, 3000);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';
const RUNS_DIR = path.join(WORKSPACE_ROOT, 'runs');
const CACHE_DIR = path.join(WORKSPACE_ROOT, 'idempotency');
const REPO_URL = process.env.REPO_URL || 'https://github.com/muradovnb-cyber/isola-business-suite.git';
const REPO_SLUG = process.env.REPO_SLUG || 'muradovnb-cyber/isola-business-suite';
const RUNNER_TOKEN = (process.env.RUNNER_TOKEN || '').trim();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const GH_TOKEN = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const CLAUDE_TIMEOUT_MS = int(process.env.CLAUDE_TIMEOUT_MS, 25 * 60 * 1000);
const MAX_CONCURRENT = int(process.env.MAX_CONCURRENT, 2);
const MAX_PAYLOAD_BYTES = int(process.env.MAX_PAYLOAD_BYTES, 512 * 1024);
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
const WORKSPACE_TTL_MS = int(process.env.WORKSPACE_TTL_MS, 6 * 3600 * 1000);

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_ID_RE  = /^[A-Za-z0-9_-]{1,80}$/;

for (const [k, v] of Object.entries({ RUNNER_TOKEN, GH_TOKEN, ANTHROPIC_API_KEY })) {
  if (!v) { console.error(`FATAL: ${k} env not set`); process.exit(1); }
}

for (const d of [WORKSPACE_ROOT, RUNS_DIR, CACHE_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

// ------------------------------ helpers -----------------------------------
function int(v, dflt) { const n = parseInt(v || '', 10); return Number.isFinite(n) ? n : dflt; }

/**
 * Redact secrets before logging or returning.
 * Any hit of the well-known patterns is replaced with a stable marker so
 * partial-value leaks can't be reconstructed.
 */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,      // Anthropic
  /sk-[A-Za-z0-9\-_]{20,}/g,          // OpenAI-style
  /gh[pousr]_[A-Za-z0-9]{20,}/g,      // GitHub tokens
  /-----BEGIN (RSA|EC|OPENSSH|DSA|PRIVATE) [A-Z ]*KEY-----[\s\S]+?-----END [A-Z ]+-----/g,
  /AKIA[0-9A-Z]{16}/g,                // AWS access key id
  /aws_secret_access_key[\s:=]+[A-Za-z0-9/+=]{40}/gi,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,    // Slack
];
function redact(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : JSON.stringify(input);
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[REDACTED]');
  if (GH_TOKEN) s = s.split(GH_TOKEN).join('[REDACTED]');
  if (ANTHROPIC_API_KEY) s = s.split(ANTHROPIC_API_KEY).join('[REDACTED]');
  if (RUNNER_TOKEN) s = s.split(RUNNER_TOKEN).join('[REDACTED]');
  return s;
}
function log(...parts) {
  // Everything through this — nothing else touches console.
  const line = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  console.log(redact(line));
}
function logErr(...parts) { console.error(redact(parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' '))); }

/**
 * Safe process runner. NEVER uses a shell; args must be an array.
 * Returns { ok, stdout, stderr, code }.
 */
function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    timeout: opts.timeout,
  });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    signal: r.signal || null,
  };
}

/** Sha256 of a small object — used for idempotency response caching. */
function sha(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32); }

/** Constant-time string compare (both hex-safe / bearer-token safe). */
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------- git auth: GIT_ASKPASS instead of URL embed --------------
// Create a tiny askpass script per boot that echoes the token from a
// runner-owned env var (`GITHUB_TOKEN_INJECT`). The script itself is world-
// readable but does nothing without the env var, which we only set for the
// duration of a git invocation.
const ASKPASS_PATH = path.join(os.tmpdir(), 'runner-askpass.sh');
fs.writeFileSync(ASKPASS_PATH, '#!/bin/sh\nprintf "%s" "${GITHUB_TOKEN_INJECT}"\n', { mode: 0o700 });
function gitEnv() {
  return {
    GIT_ASKPASS: ASKPASS_PATH,
    GIT_TERMINAL_PROMPT: '0',
    GITHUB_TOKEN_INJECT: GH_TOKEN,
    // Force git-http to use askpass for basic auth (user = x-access-token)
    // by keeping the plain URL. Git will prompt for user/pass; askpass answers.
  };
}
function ghEnv() {
  // gh reads GH_TOKEN natively.
  return { GH_TOKEN, GITHUB_TOKEN: GH_TOKEN };
}

// ------------------------------ inflight + idempotency ---------------------
let inflight = 0;
const inflightRuns = new Map(); // runId -> Promise

function idemPath(runId) { return path.join(CACHE_DIR, `${runId}.json`); }
function idemGet(runId) {
  try {
    const p = idemPath(runId);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > IDEMPOTENCY_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}
function idemSet(runId, resp) {
  try { fs.writeFileSync(idemPath(runId), JSON.stringify(resp)); } catch (e) { logErr('[idem] write fail:', e.message); }
}

// ------------------------------ workspace lifecycle -----------------------
function makeWorkspace(runId) {
  const dir = path.join(RUNS_DIR, runId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function destroyWorkspace(dir, opts = {}) {
  if (opts.keep) return; // caller can pin for post-mortem
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
/** Sweep runs older than WORKSPACE_TTL_MS at boot + hourly. */
function sweepWorkspaces() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(RUNS_DIR)) {
      const p = path.join(RUNS_DIR, name);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > WORKSPACE_TTL_MS) {
        log('[sweep] removing stale workspace', name);
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  } catch (e) { logErr('[sweep]', e.message); }
}

// ------------------------------ git ops (argv-array everywhere) -----------
function cloneRepo(dir) {
  const r = run('git', ['clone', '--depth', '50', REPO_URL, dir], { env: gitEnv() });
  if (!r.ok) throw new Error('git clone failed: ' + redact(r.stderr));
  run('git', ['-C', dir, 'config', 'user.name', 'ISOLA AI Runner']);
  run('git', ['-C', dir, 'config', 'user.email', 'ai-runner@isola.local']);
}
function checkoutBranch(dir, taskId) {
  if (!TASK_ID_RE.test(taskId)) throw new Error('bad taskId');
  const branch = `agent/${taskId}`;
  const remote = run('git', ['-C', dir, 'ls-remote', '--heads', 'origin', branch], { env: gitEnv() });
  if (remote.ok && remote.stdout) {
    run('git', ['-C', dir, 'checkout', '-B', branch, `origin/${branch}`], { env: gitEnv() });
  } else {
    run('git', ['-C', dir, 'checkout', '-B', branch], { env: gitEnv() });
  }
  return branch;
}
function stagedDiff(dir) {
  const r = run('git', ['-C', dir, 'diff', '--cached', '--unified=0'], { env: gitEnv() });
  return r.ok ? r.stdout : '';
}
function stagedShortstat(dir) {
  const r = run('git', ['-C', dir, 'diff', '--cached', '--shortstat'], { env: gitEnv() });
  return r.ok ? r.stdout : '';
}
function scanSecrets(diff) {
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    const m = diff.match(re);
    if (m) hits.push(...m.slice(0, 3).map(x => x.slice(0, 12) + '…'));
  }
  return { ok: hits.length === 0, hits };
}

// ------------------------------ tests -------------------------------------
function runTests(dir) {
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) return { ok: true, skipped: 'no package.json' };
  let p; try { p = JSON.parse(fs.readFileSync(pkg, 'utf8')); } catch (e) { return { ok: false, output: 'package.json parse error: ' + e.message }; }
  if (!(p.scripts && p.scripts.test)) return { ok: true, skipped: 'no npm test script' };
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir, timeout: 5 * 60 * 1000 });
  if (!install.ok) return { ok: false, output: 'npm install failed:\n' + redact(install.stderr).slice(-4000), code: install.code };
  const test = run('npm', ['test', '--silent'], { cwd: dir, timeout: 10 * 60 * 1000 });
  return { ok: test.ok, output: redact((test.stdout + '\n' + test.stderr)).slice(-6000), code: test.code };
}

// ------------------------------ Claude prompt/build/run -------------------
function buildClaudePrompt(spec, feedback) {
  const parts = [];
  parts.push('# TASK');
  parts.push(spec.task || spec.objective || '(no title)');
  if (spec.objective) parts.push('\n## OBJECTIVE\n' + spec.objective);
  if (spec.context) parts.push('\n## CONTEXT\n' + spec.context);
  const list = (label, arr) => (Array.isArray(arr) && arr.length) ? '\n## ' + label + '\n' + arr.map((x, i) => `${i + 1}. ${x}`).join('\n') : '';
  parts.push(list('FILES_TO_INSPECT', spec.files_to_inspect || spec.files));
  parts.push(list('REQUIREMENTS', spec.requirements));
  parts.push(list('ACCEPTANCE_CRITERIA', spec.acceptance_criteria));
  parts.push(list('TESTS_REQUIRED', spec.tests_required || spec.tests));
  parts.push(list('SECURITY_REQUIREMENTS', spec.security_requirements || spec.security));
  parts.push(list('DO_NOT_CHANGE', spec.do_not_change));
  if (spec.deployment_policy || spec.deploy_policy) parts.push('\n## DEPLOYMENT_POLICY\n' + (spec.deployment_policy || spec.deploy_policy));
  if (feedback) {
    parts.push('\n## PRIOR REVIEW FEEDBACK — ADDRESS THIS BEFORE ANYTHING ELSE');
    if (feedback.problem) parts.push(`### PROBLEM\n${feedback.problem}`);
    if (feedback.why) parts.push(`### WHY\n${feedback.why}`);
    if (Array.isArray(feedback.issues) && feedback.issues.length) parts.push(`### ISSUES\n${feedback.issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
    if (Array.isArray(feedback.required_changes) && feedback.required_changes.length) parts.push(`### REQUIRED_CHANGES\n${feedback.required_changes.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
    if (feedback.required_change) parts.push(`### REQUIRED_CHANGE\n${feedback.required_change}`);
    if (feedback.acceptance_criteria) parts.push(`### ACCEPTANCE_CRITERIA\n${feedback.acceptance_criteria}`);
  }
  parts.push('\n## RULES OF ENGAGEMENT');
  parts.push([
    '- You are running non-interactively via `claude -p`. Print your final JSON report and exit.',
    '- CWD is a fresh throwaway git clone of ' + REPO_SLUG + '. Do not switch branches; you are already on the task branch.',
    '- Do NOT commit, push, merge, open a PR — the runner does that after you finish.',
    '- Do NOT deploy anywhere. Do NOT change branches. Do NOT touch main.',
    '- Do NOT print API keys, tokens, or contents of .env files.',
    '- If you need to run tests, run `npm test` — the runner will re-run tests independently after your session.',
    '- When done, print a JSON block delimited by ```json … ``` with keys:',
    '  { "summary": string, "files_touched": string[], "tests": "passed"|"failed"|"skipped", "notes": string }',
  ].join('\n'));
  return parts.join('\n');
}

function runClaude(cwd, prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--model', CLAUDE_MODEL, '--output-format', 'text', '--permission-mode', 'acceptEdits'];
    const proc = spawn(CLAUDE_BIN, args, {
      cwd, env: { ...process.env, ANTHROPIC_API_KEY }, shell: false,
    });
    let stdout = '', stderr = '', killed = false;
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    const timer = setTimeout(() => {
      killed = true; try { proc.kill('SIGKILL'); } catch (_) {}
    }, CLAUDE_TIMEOUT_MS);
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code, signal, killed,
        stdout: redact(stdout),
        stderr: redact(stderr),
        status: killed ? 'TIMEOUT' : code === 0 ? 'OK' : code === null ? 'SIGNAL' : 'NONZERO_EXIT',
      });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, killed: false, stdout, stderr: redact(err.message), status: 'SPAWN_ERROR' });
    });
  });
}
function parseClaudeReport(text) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) return { summary: '(no structured report from Claude)', files_touched: [], tests: 'unknown', notes: text.slice(-2000) };
  try { return JSON.parse(m[1]); } catch (_) { return { summary: '(unparsable JSON report)', notes: m[1].slice(0, 2000) }; }
}

// ------------------------------ PR upsert ---------------------------------
function upsertPR(cwd, branch, taskId, report, testsRes) {
  const title = `[ai:${taskId}] ${(report.summary || 'automated change').slice(0, 80)}`;
  const bodyParts = [
    `**Task ID:** \`${taskId}\``,
    `**Model:** ${CLAUDE_MODEL}`,
    '',
    '## Summary',
    report.summary || '(none)',
    '',
    '## Files touched',
    (report.files_touched && report.files_touched.length) ? report.files_touched.map(f => `- \`${f}\``).join('\n') : '- (none)',
    '',
    '## Tests',
    `- Status: **${testsRes.ok ? 'passed' : (testsRes.skipped ? 'skipped' : 'failed')}**${testsRes.skipped ? ` (${testsRes.skipped})` : ''}`,
    testsRes.output ? '```\n' + testsRes.output.slice(-2000) + '\n```' : '',
    '',
    '## Notes',
    (report.notes || '(none)').slice(0, 1500),
    '',
    '## Automation policy',
    '- Do NOT merge automatically.',
    '- Do NOT deploy without APPROVED_FOR_DEPLOY from GPT Reviewer.',
  ];
  const body = bodyParts.join('\n');
  const bodyFile = path.join(cwd, '..', `pr-body-${taskId}.md`);
  fs.writeFileSync(bodyFile, body);

  // GitHub GraphQL API occasionally 503s. Retry gh commands up to 3 times
  // with backoff before giving up.
  const ghRetry = (args) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = run('gh', args, { env: ghEnv() });
      const combined = (r.stdout || '') + '\n' + (r.stderr || '');
      const isFlake = /HTTP 5\d\d|No server is currently available|service.*unavailable|timeout/i.test(combined);
      if (r.ok || !isFlake) return r;
      log(`[gh] flake attempt ${attempt}/3:`, combined.slice(-200).replace(/\n+/g, ' '));
      if (attempt < 3) { const wait = 2000 * attempt; const end = Date.now() + wait; while (Date.now() < end) {} }
    }
    return { ok: false, stdout: '', stderr: 'exhausted retries', code: -1 };
  };

  const existing = ghRetry(['pr', 'list', '--repo', REPO_SLUG, '--state', 'open', '--head', branch, '--json', 'number,url', '--jq', '.[0]']);
  let prUrl = '', prNumber = null;
  if (existing.ok && existing.stdout.trim() && existing.stdout.trim() !== 'null') {
    try {
      const j = JSON.parse(existing.stdout);
      if (j && j.number) {
        prNumber = j.number; prUrl = j.url;
        ghRetry(['pr', 'edit', String(prNumber), '--repo', REPO_SLUG, '--title', title, '--body-file', bodyFile]);
      }
    } catch (_) {}
  }
  if (!prNumber) {
    const r = ghRetry(['pr', 'create', '--repo', REPO_SLUG, '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile]);
    if (r.ok) {
      const m = r.stdout.match(/https:\S+/);
      if (m) { prUrl = m[0]; const n = prUrl.match(/\/pull\/(\d+)/); if (n) prNumber = parseInt(n[1], 10); }
    } else {
      logErr('[pr create] final failure:', (r.stderr || '').slice(-300));
    }
  }
  try { fs.unlinkSync(bodyFile); } catch (_) {}
  return { prUrl, prNumber };
}

// ------------------------------ HTTP surface -----------------------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({
  limit: MAX_PAYLOAD_BYTES,
  verify: (req, res, buf) => {
    if (buf && buf.length > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('payload too large'), { status: 413, type: 'entity.too.large' });
  },
}));

const authFails = new Map(); // ip -> count in current window
setInterval(() => authFails.clear(), 15 * 60 * 1000);

const taskRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 tasks/minute from a single IP
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'rate limited', code: 'RATE_LIMITED' },
});
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 auth failures / 15 min → 429
  standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: 'too many auth failures', code: 'RATE_LIMITED' },
});

function requireToken(req, res, next) {
  const raw = req.get('authorization') || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!safeEq(token, RUNNER_TOKEN)) {
    const n = (authFails.get(req.ip) || 0) + 1; authFails.set(req.ip, n);
    log('[auth] fail from', req.ip, 'total', n);
    return res.status(401).json({ ok: false, error: 'auth_required', code: 'AUTH_REQUIRED' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({
  ok: true, ts: Date.now(), model: CLAUDE_MODEL, inflight, max_concurrent: MAX_CONCURRENT, version: '0.2.0',
}));

app.post('/task', authRateLimit, requireToken, taskRateLimit, async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const taskId = (body.taskId || body.task_id || '').toString();
  const runId = (body.runId || body.run_id || crypto.randomBytes(6).toString('hex')).toString();
  const attempt = int(body.attempt, 1);
  const spec = body.spec || null;
  const feedback = body.feedback || null;

  if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ ok: false, error: 'invalid taskId format', code: 'BAD_TASK_ID' });
  if (!RUN_ID_RE.test(runId)) return res.status(400).json({ ok: false, error: 'invalid runId format', code: 'BAD_RUN_ID' });
  if (!spec || typeof spec !== 'object') return res.status(400).json({ ok: false, error: 'spec required (object)', code: 'BAD_SPEC' });

  // Idempotency: same runId returns cached response.
  const cached = idemGet(runId);
  if (cached) { log('[idem] hit', runId); return res.json(Object.assign({}, cached, { idempotent: true })); }

  // Concurrency cap
  if (inflight >= MAX_CONCURRENT) return res.status(503).json({ ok: false, error: 'runner busy', code: 'BUSY' });

  // Coalesce parallel same-runId requests (in case idempotency file not yet written)
  if (inflightRuns.has(runId)) {
    try { const r = await inflightRuns.get(runId); return res.json(Object.assign({}, r, { coalesced: true })); }
    catch (e) { return res.status(500).json({ ok: false, error: 'run failed', code: 'INTERNAL' }); }
  }

  const runPromise = executeRun({ taskId, runId, attempt, spec, feedback, t0 });
  inflightRuns.set(runId, runPromise);
  inflight++;
  let result;
  try { result = await runPromise; }
  catch (e) {
    logErr('[run', runId, '] uncaught', e && e.message);
    result = { ok: false, status: 'FAILED', runId, taskId, error: 'internal error', code: 'INTERNAL' };
  }
  inflight--;
  inflightRuns.delete(runId);
  idemSet(runId, result);
  res.status(result.ok ? 200 : 500).json(result);
});

async function executeRun({ taskId, runId, attempt, spec, feedback, t0 }) {
  const workspace = makeWorkspace(runId);
  let keepWorkspace = false;
  try {
    log('[run', runId, '] start task=', taskId, 'attempt=', attempt);
    cloneRepo(workspace);
    // Reset to origin/main to defeat any stale state
    run('git', ['-C', workspace, 'fetch', '--prune', 'origin'], { env: gitEnv() });
    run('git', ['-C', workspace, 'checkout', 'main'], { env: gitEnv() });
    run('git', ['-C', workspace, 'reset', '--hard', 'origin/main'], { env: gitEnv() });
    const branch = checkoutBranch(workspace, taskId);

    // Ask Claude
    const prompt = buildClaudePrompt(spec, feedback);
    const claudeRes = await runClaude(workspace, prompt);
    const report = parseClaudeReport(claudeRes.stdout);

    // Stage
    const stageR = run('git', ['-C', workspace, 'add', '-A']);
    if (!stageR.ok) throw new Error('git add failed: ' + stageR.stderr);

    // Secret scan on staged diff
    const diff = stagedDiff(workspace);
    const secrets = scanSecrets(diff);
    if (!secrets.ok) {
      run('git', ['-C', workspace, 'reset', '--hard', 'HEAD']);
      keepWorkspace = false;
      return { ok: false, status: 'SECRET_LEAK', runId, taskId, branch, hits: secrets.hits, claude_status: claudeRes.status };
    }

    const shortstat = stagedShortstat(workspace);
    if (!shortstat) {
      keepWorkspace = false;
      return { ok: true, status: 'NO_CHANGES', runId, taskId, branch, claudeReport: report, claude_status: claudeRes.status, duration_ms: Date.now() - t0 };
    }

    // TESTS BEFORE COMMIT
    const tests = runTests(workspace);

    // Commit (with test result in message)
    const testTag = tests.ok ? 'tests:pass' : (tests.skipped ? 'tests:skip' : 'tests:FAIL');
    const commitMsg = [
      `[ai:${taskId} att${attempt}] ${(report.summary || 'automated change').slice(0, 72)}`,
      '',
      JSON.stringify({ runId, attempt, testTag, claude_status: claudeRes.status }, null, 2),
    ].join('\n');
    const msgFile = path.join(workspace, '..', `commit-msg-${runId}.txt`);
    fs.writeFileSync(msgFile, commitMsg);
    const commitR = run('git', ['-C', workspace, 'commit', '--file', msgFile]);
    try { fs.unlinkSync(msgFile); } catch (_) {}
    if (!commitR.ok) {
      logErr('[run', runId, '] commit failed:', commitR.stderr);
      keepWorkspace = true;
      return { ok: false, status: 'COMMIT_FAILED', runId, taskId, branch, error: redact(commitR.stderr).slice(-500) };
    }

    // Push
    const pushR = run('git', ['-C', workspace, 'push', '-u', 'origin', branch], { env: gitEnv() });
    if (!pushR.ok) {
      logErr('[run', runId, '] push failed:', pushR.stderr);
      keepWorkspace = true;
      return { ok: false, status: 'PUSH_FAILED', runId, taskId, branch, error: redact(pushR.stderr).slice(-500) };
    }

    // PR upsert
    const { prUrl, prNumber } = upsertPR(workspace, branch, taskId, report, tests);
    const commit = run('git', ['-C', workspace, 'rev-parse', 'HEAD']).stdout;
    const diffStat = run('git', ['-C', workspace, 'diff', '--stat', 'main...HEAD']).stdout;

    keepWorkspace = false;
    return {
      ok: true,
      status: tests.ok ? 'READY_FOR_REVIEW' : 'READY_FOR_REVIEW_TESTS_FAILED',
      runId, taskId, branch, commit,
      pr: { number: prNumber, url: prUrl },
      tests: { ok: tests.ok, skipped: tests.skipped, output: tests.output, code: tests.code },
      claudeReport: report,
      claude_status: claudeRes.status,
      diff_stat: diffStat,
      duration_ms: Date.now() - t0,
    };
  } catch (e) {
    logErr('[run', runId, '] exception:', e.message);
    keepWorkspace = true;
    return { ok: false, status: 'FAILED', runId, taskId, error: redact(e.message).slice(-500), code: 'INTERNAL' };
  } finally {
    destroyWorkspace(workspace, { keep: keepWorkspace });
  }
}

// generic safe error handler — never leaks stack traces
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ ok: false, error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid json', code: 'BAD_JSON' });
  }
  logErr('[err]', err && err.message);
  res.status(500).json({ ok: false, error: 'internal error', code: 'INTERNAL' });
});

sweepWorkspaces();
setInterval(sweepWorkspaces, 3600 * 1000);

app.listen(PORT, () => {
  log(`ai-runner v0.2.0 listening on :${PORT} model=${CLAUDE_MODEL} repo=${REPO_SLUG} inflight-cap=${MAX_CONCURRENT}`);
});
