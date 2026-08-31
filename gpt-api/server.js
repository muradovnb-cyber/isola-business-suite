// gpt-orchestrator-api v0.1.0
//
// HTTPS bridge letting GPT (or any external LLM without a working GitHub App
// with write permissions) create ISOLA orchestrator tasks and read pipeline
// state without any owner-in-the-loop message relay.
//
// Runs as a separate Railway service under the same `isola-suite` project as
// `ai-runner`. Never touches production ISOLA. Never exposes secrets in
// responses. All writes are audit-logged to stdout (Railway captures them).
//
// Endpoints (see openapi.yaml + .github/ai/bridge/GPT_HANDOFF.md):
//   GET  /health
//   GET  /api/gpt/status
//   POST /api/gpt/tasks                 — create + auto-fire orchestrator
//   GET  /api/gpt/tasks                 — list task files on main
//   GET  /api/gpt/tasks/:id             — read one task + executions
//   POST /api/gpt/tasks/:id/run         — re-fire orchestrator
//   GET  /api/gpt/reports/:id           — read consolidated per-task report
//
// Auth: Bearer <GPT_ORCHESTRATOR_TOKEN>. Token is stored ONLY in Railway env,
// never in git. Missing token => 500 SERVICE_MISCONFIGURED on write endpoints.

'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// Draft 2020-12 needs the dedicated Ajv build.
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------- config ----------------------

const PORT             = parseInt(process.env.PORT || '3000', 10);
const GPT_TOKEN        = (process.env.GPT_ORCHESTRATOR_TOKEN || '').trim();
const GITHUB_PAT       = (process.env.GITHUB_PAT || '').trim();
const GITHUB_REPO      = (process.env.GITHUB_REPO || 'muradovnb-cyber/isola-business-suite').trim();
const STATE_BRANCH     = (process.env.STATE_BRANCH || 'ai/orchestrator-state').trim();
const MAX_ATTEMPTS_CAP = parseInt(process.env.MAX_ATTEMPTS_CAP || '10', 10);

const VERSION          = '0.1.0';
const AUDIT            = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

// ---------------------- schema ----------------------

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// ---------------------- helpers ----------------------

function requireGithubPat(res) {
  if (!GITHUB_PAT) {
    res.status(500).json({ error: 'SERVICE_MISCONFIGURED', detail: 'GITHUB_PAT not set in service env. Owner must configure it in Railway before write endpoints work.' });
    return false;
  }
  return true;
}

async function gh(method, pathOrUrl, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `gpt-orchestrator-api/${VERSION}`,
    ...(body ? { 'Content-Type': 'application/json' } : {})
  };
  // Only send Authorization when we have a real token. Sending an empty
  // Bearer header makes GitHub 401 even on public-repo read paths.
  if (GITHUB_PAT) headers['Authorization'] = `Bearer ${GITHUB_PAT}`;
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* raw text response */ }
  return { status: r.status, ok: r.ok, body: json, raw: text };
}

async function ghRaw(branch, filePath) {
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(branch)}/${filePath}`;
  const r = await fetch(url, { headers: { 'User-Agent': `gpt-orchestrator-api/${VERSION}` } });
  const text = await r.text();
  if (!r.ok) return { status: r.status, body: null };
  try { return { status: 200, body: JSON.parse(text) }; }
  catch { return { status: 200, body: text }; }
}

// ---------------------- app ----------------------

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '128kb' }));
app.set('trust proxy', 1);

// health is UNAUTHENTICATED — used by Railway healthcheck.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'gpt-orchestrator-api',
    version: VERSION,
    repo: GITHUB_REPO,
    state_branch: STATE_BRANCH,
    ts: Date.now(),
    configured: {
      gpt_token: Boolean(GPT_TOKEN),
      github_pat: Boolean(GITHUB_PAT)
    }
  });
});

// ---- auth middleware for /api/gpt/* ----

app.use('/api/gpt', (req, res, next) => {
  if (!GPT_TOKEN) {
    return res.status(500).json({ error: 'SERVICE_MISCONFIGURED', detail: 'GPT_ORCHESTRATOR_TOKEN not set on service.' });
  }
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'AUTH_REQUIRED', detail: 'Missing Authorization: Bearer <token>' });
  // constant-time compare
  const a = Buffer.from(m[1]); const b = Buffer.from(GPT_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'AUTH_INVALID' });
  }
  next();
});

// ---- rate limits per spec ----

const rlWrite = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'RATE_LIMITED', detail: '10 writes/min max' } });
const rlRead  = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'RATE_LIMITED', detail: '60 reads/min max' } });

// ============================================================
//                       READ endpoints
// ============================================================

// GET /api/gpt/status — live projection from ai/orchestrator-state
app.get('/api/gpt/status', rlRead, async (req, res) => {
  const [proj, richFallback] = await Promise.all([
    ghRaw(STATE_BRANCH, '.github/ai/state/current.json'),
    ghRaw(STATE_BRANCH, '.github/ai/orchestrator/CURRENT_STATUS.json')
  ]);
  if (proj.status === 200 && proj.body && typeof proj.body === 'object') {
    return res.json({ source: 'state/current.json', state: proj.body });
  }
  if (richFallback.status === 200 && richFallback.body) {
    // Server-side project the rich internal status into the v2.0 shape so
    // clients always get the same field names even before the first
    // bridge-v2.0 orchestrator run has populated state/current.json.
    const s = richFallback.body;
    const map = { PENDING:'QUEUED', PLANNING:'RUNNING', IMPLEMENTING:'RUNNING', TESTING:'RUNNING',
      WAITING_REVIEW:'REVIEW', CHANGES_REQUIRED:'FIXING', APPROVED:'PASSED', DEPLOYING:'PASSED',
      DONE:'PASSED', BLOCKED:'BLOCKED', FAILED:'FAILED', IDLE:'IDLE' };
    return res.json({
      source: 'orchestrator/CURRENT_STATUS.json (projected)',
      state: {
        status: map[s.status] || 'IDLE',
        current_task: s.task_id && s.task_id !== 'BOOTSTRAP' ? s.task_id : null,
        stage: null, agent: null,
        attempt: s.attempt || 0,
        last_commit: s.commit || null,
        last_pr: s.pr || null,
        last_review: s.review && ['APPROVED','CHANGES_REQUIRED','BLOCKED'].includes(s.review)
          ? { decision: s.review, attempt: s.attempt || 1 } : null,
        blockers: s.error ? [String(s.error).slice(0, 500)] : [],
        next_action: s.next_action || null,
        updated_at: s.updated_at
      }
    });
  }
  res.status(404).json({ error: 'STATE_NOT_FOUND', detail: 'No state files on the state branch yet. First orchestrator run under bridge v2.0 will populate them.' });
});

// GET /api/gpt/tasks — list task files on main
app.get('/api/gpt/tasks', rlRead, async (req, res) => {
  const r = await gh('GET', `/repos/${GITHUB_REPO}/contents/.github/ai/tasks?ref=main`);
  if (!r.ok) return res.status(r.status).json({ error: 'GH_UPSTREAM', status: r.status });
  const items = (r.body || []).filter(f => /^TASK-.+\.json$/.test(f.name || ''));
  const list = await Promise.all(items.map(async f => {
    const raw = await ghRaw('main', f.path);
    const t = raw.body && typeof raw.body === 'object' ? raw.body : null;
    return t ? {
      id: t.id, status: t.status, priority: t.priority || 'normal',
      objective: (t.objective || '').slice(0, 200),
      created_at: t.created_at, created_by: t.created_by, source: t.source,
      path: f.path
    } : { id: f.name.replace('.json',''), path: f.path, parse_error: true };
  }));
  res.json({ count: list.length, tasks: list });
});

// GET /api/gpt/tasks/:id
app.get('/api/gpt/tasks/:id', rlRead, async (req, res) => {
  const id = req.params.id;
  if (!/^TASK-[A-Za-z0-9_-]{1,72}$/.test(id)) return res.status(400).json({ error: 'INVALID_TASK_ID' });
  const task = await ghRaw('main', `.github/ai/tasks/${id}.json`);
  if (task.status === 404) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  // executions + reviews for this task
  const execIdx = await gh('GET', `/repos/${GITHUB_REPO}/contents/.github/ai/orchestrator/executions?ref=${encodeURIComponent(STATE_BRANCH)}`);
  const revIdx  = await gh('GET', `/repos/${GITHUB_REPO}/contents/.github/ai/orchestrator/reviews?ref=${encodeURIComponent(STATE_BRANCH)}`);
  const filter = (arr) => (Array.isArray(arr) ? arr : []).filter(f => f.name && f.name.startsWith(`${id}__`)).map(f => f.name);
  res.json({
    task: task.body,
    attempts: {
      executions: filter(execIdx.body),
      reviews:    filter(revIdx.body)
    }
  });
});

// GET /api/gpt/reports/:id — consolidated per-task report
app.get('/api/gpt/reports/:id', rlRead, async (req, res) => {
  const id = req.params.id;
  if (!/^TASK-[A-Za-z0-9_-]{1,72}$/.test(id)) return res.status(400).json({ error: 'INVALID_TASK_ID' });
  const r = await ghRaw(STATE_BRANCH, `.github/ai/reports/${id}.json`);
  if (r.status === 404) return res.status(404).json({ error: 'REPORT_NOT_FOUND', detail: 'No consolidated report yet — task may not have finished under bridge v2.0.' });
  res.json(r.body);
});

// ============================================================
//                       WRITE endpoints
// ============================================================

// POST /api/gpt/tasks — create task file on branch, open PR, fire orchestrator
app.post('/api/gpt/tasks', rlWrite, async (req, res) => {
  if (!requireGithubPat(res)) return;

  // 1. shape check
  const draft = req.body || {};
  if (typeof draft !== 'object' || Array.isArray(draft)) {
    return res.status(400).json({ error: 'INVALID_BODY' });
  }

  // Enforce server-side defaults BEFORE schema validation.
  const task = {
    status: 'QUEUED',
    priority: 'normal',
    source: draft.source || 'gpt-api',
    created_at: draft.created_at || new Date().toISOString(),
    created_by: draft.created_by || 'gpt-orchestrator-api',
    ...draft,
    // Server-side security overrides — GPT cannot escape these.
    deployment_policy: 'NO_DEPLOY',
    max_attempts: Math.min(parseInt(draft.max_attempts || MAX_ATTEMPTS_CAP, 10) || MAX_ATTEMPTS_CAP, MAX_ATTEMPTS_CAP)
  };
  // Client cannot override status here.
  task.status = 'QUEUED';
  task.deployment_policy = 'NO_DEPLOY';

  // 2. schema validate
  const ok = validate(task);
  if (!ok) {
    return res.status(400).json({ error: 'SCHEMA_INVALID', errors: validate.errors });
  }

  // 3. reject any secret-shape in serialized body
  const asText = JSON.stringify(task);
  const secretRe = /(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  if (secretRe.test(asText)) {
    AUDIT({ evt: 'REJECT_SECRET_LEAK', task_id: task.id });
    return res.status(400).json({ error: 'SECRET_SHAPE_DETECTED', detail: 'Refusing to write anything resembling a credential.' });
  }

  const taskId = task.id;
  const branch = `gpt/${taskId}`;
  const filePath = `.github/ai/tasks/${taskId}.json`;

  // 4. idempotency: does branch already exist?
  const existing = await gh('GET', `/repos/${GITHUB_REPO}/git/refs/heads/${branch}`);
  if (existing.status === 200) {
    return res.status(409).json({ error: 'TASK_ALREADY_EXISTS', detail: `Branch ${branch} already exists. Use POST /api/gpt/tasks/${taskId}/run to re-fire.` });
  }
  // Or: does task file already exist on main?
  const onMain = await gh('GET', `/repos/${GITHUB_REPO}/contents/${filePath}?ref=main`);
  if (onMain.status === 200) {
    return res.status(409).json({ error: 'TASK_ALREADY_EXISTS', detail: `Task file ${filePath} already on main.` });
  }

  // 5. get main sha
  const mainRef = await gh('GET', `/repos/${GITHUB_REPO}/git/refs/heads/main`);
  if (!mainRef.ok) return res.status(502).json({ error: 'GH_UPSTREAM', step: 'read main', status: mainRef.status });
  const mainSha = mainRef.body.object.sha;

  // 6. create branch
  const branchRes = await gh('POST', `/repos/${GITHUB_REPO}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: mainSha });
  if (!branchRes.ok) return res.status(502).json({ error: 'GH_UPSTREAM', step: 'create branch', status: branchRes.status, body: branchRes.body });

  // 7. commit task file
  const content = Buffer.from(JSON.stringify(task, null, 2) + '\n').toString('base64');
  const putRes = await gh('PUT', `/repos/${GITHUB_REPO}/contents/${filePath}`, {
    message: `gpt-api: enqueue ${taskId}`, branch, content
  });
  if (!putRes.ok) {
    // best-effort rollback of the branch
    await gh('DELETE', `/repos/${GITHUB_REPO}/git/refs/heads/${branch}`);
    return res.status(502).json({ error: 'GH_UPSTREAM', step: 'create file', status: putRes.status, body: putRes.body });
  }
  const commitSha = putRes.body.commit?.sha;

  // 8. open PR (audit trail)
  const prRes = await gh('POST', `/repos/${GITHUB_REPO}/pulls`, {
    title: `[gpt-api] ${taskId}: ${String(task.objective).slice(0, 60)}`,
    head: branch, base: 'main',
    body: `Auto-submitted by gpt-orchestrator-api on behalf of GPT.\n\n- id: \`${taskId}\`\n- source: \`${task.source}\`\n- max_attempts: ${task.max_attempts}\n- deployment_policy: \`NO_DEPLOY\`\n\nOrchestrator is being fired via \`repository_dispatch\` in parallel with this PR — do NOT merge to trigger; already running. Merge only when human review of the queue file is desired.`
  });
  const prNumber = prRes.ok ? prRes.body.number : null;
  const prUrl    = prRes.ok ? prRes.body.html_url : null;
  if (!prRes.ok) {
    AUDIT({ evt: 'PR_CREATE_FAILED', task_id: taskId, status: prRes.status });
  }

  // 9. fire orchestrator via repository_dispatch
  const dispRes = await gh('POST', `/repos/${GITHUB_REPO}/dispatches`, {
    event_type: 'isola-task',
    client_payload: {
      task_id: taskId,
      task: task.objective,
      max_attempts: String(task.max_attempts),
      approved_for_deploy: 'false',
      source: 'gpt-api'
    }
  });
  const fired = dispRes.status === 204;

  AUDIT({ evt: 'TASK_CREATED', task_id: taskId, branch, commit: commitSha, pr: prNumber, dispatch_fired: fired, dispatch_status: dispRes.status });

  res.status(201).json({
    task_id: taskId,
    branch,
    commit: commitSha,
    pr: prNumber ? { number: prNumber, url: prUrl } : null,
    dispatch_fired: fired,
    dispatch_status: dispRes.status,
    poll: {
      status: `/api/gpt/status`,
      report: `/api/gpt/reports/${taskId}`,
      task: `/api/gpt/tasks/${taskId}`
    }
  });
});

// POST /api/gpt/tasks/:id/run — re-fire the orchestrator for an existing task
app.post('/api/gpt/tasks/:id/run', rlWrite, async (req, res) => {
  if (!requireGithubPat(res)) return;
  const id = req.params.id;
  if (!/^TASK-[A-Za-z0-9_-]{1,72}$/.test(id)) return res.status(400).json({ error: 'INVALID_TASK_ID' });

  // Check current state — if running, 409.
  const cur = await ghRaw(STATE_BRANCH, '.github/ai/state/current.json');
  if (cur.status === 200 && cur.body && cur.body.current_task === id) {
    const busy = ['QUEUED','RUNNING','REVIEW','FIXING'];
    if (busy.includes(cur.body.status)) {
      return res.status(409).json({ error: 'TASK_ALREADY_RUNNING', current: cur.body });
    }
  }

  // Look up task file (from main or from a gpt/ branch)
  let taskDoc = (await ghRaw('main', `.github/ai/tasks/${id}.json`)).body;
  if (!taskDoc) taskDoc = (await ghRaw(`gpt/${id}`, `.github/ai/tasks/${id}.json`)).body;
  if (!taskDoc || typeof taskDoc !== 'object') return res.status(404).json({ error: 'TASK_NOT_FOUND' });

  const dispRes = await gh('POST', `/repos/${GITHUB_REPO}/dispatches`, {
    event_type: 'isola-task',
    client_payload: {
      task_id: id,
      task: taskDoc.objective,
      max_attempts: String(taskDoc.max_attempts || MAX_ATTEMPTS_CAP),
      approved_for_deploy: 'false',
      source: 'gpt-api-rerun'
    }
  });
  const fired = dispRes.status === 204;
  AUDIT({ evt: 'TASK_RERUN', task_id: id, dispatch_fired: fired });
  res.json({ task_id: id, dispatch_fired: fired, dispatch_status: dispRes.status });
});

// ---------------------- error handler ----------------------

app.use((err, req, res, next) => {
  AUDIT({ evt: 'UNCAUGHT', msg: String(err && err.message || err) });
  res.status(500).json({ error: 'INTERNAL', detail: 'See service logs.' });
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.path }));

// ---------------------- boot ----------------------

app.listen(PORT, () => {
  AUDIT({ evt: 'BOOT', port: PORT, version: VERSION, repo: GITHUB_REPO, state_branch: STATE_BRANCH,
    configured: { gpt_token: Boolean(GPT_TOKEN), github_pat: Boolean(GITHUB_PAT) } });
});
