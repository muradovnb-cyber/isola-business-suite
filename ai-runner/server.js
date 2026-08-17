/*
 * ai-runner — the "Claude Code" node in the ISOLA orchestration pipeline.
 *
 * n8n calls this service via HTTP with a task spec (or a fix feedback).
 * The service:
 *   1. checks out main
 *   2. creates/reuses a branch  agent/<TASK_ID>
 *   3. invokes Claude Code CLI non-interactively with a fully-scoped prompt
 *   4. runs the repo's tests
 *   5. checks git diff + secrets
 *   6. commits, pushes, creates or updates a PR
 *   7. returns a structured JSON report
 *
 * It NEVER merges main and NEVER deploys to production.
 * A separate GitHub Actions step / n8n step is responsible for that,
 * and only after the GPT Reviewer has explicitly returned APPROVED_FOR_DEPLOY.
 */
const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const REPO_DIR = process.env.REPO_DIR || '/workspace/repo';
const REPO_URL = process.env.REPO_URL || 'https://github.com/muradovnb-cyber/isola-business-suite.git';
const REPO_SLUG = process.env.REPO_SLUG || 'muradovnb-cyber/isola-business-suite';
const RUNNER_TOKEN = (process.env.RUNNER_TOKEN || '').trim();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const GH_TOKEN = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '25', 10);

if (!RUNNER_TOKEN) { console.error('FATAL: RUNNER_TOKEN not set'); process.exit(1); }
if (!GH_TOKEN)     { console.error('FATAL: GH_TOKEN not set'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error('FATAL: ANTHROPIC_API_KEY not set'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '2mb' }));

function requireToken(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t || !crypto.timingSafeEqual(Buffer.from(t.padEnd(RUNNER_TOKEN.length)), Buffer.from(RUNNER_TOKEN.padEnd(t.length)))) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }
  next();
}

function sh(cmd, opts = {}) {
  const cwd = opts.cwd || REPO_DIR;
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}

function ensureRepo() {
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    fs.mkdirSync(REPO_DIR, { recursive: true });
    const url = REPO_URL.replace('https://', `https://x-access-token:${GH_TOKEN}@`);
    execSync(`git clone --depth 50 ${url} ${REPO_DIR}`, { stdio: 'inherit' });
    execSync(`git -C ${REPO_DIR} config user.name  "ISOLA AI Runner"`, { stdio: 'inherit' });
    execSync(`git -C ${REPO_DIR} config user.email "ai-runner@isola.local"`, { stdio: 'inherit' });
  }
  execSync(`git -C ${REPO_DIR} fetch --prune origin`, { stdio: 'inherit' });
  execSync(`git -C ${REPO_DIR} checkout main`, { stdio: 'inherit' });
  execSync(`git -C ${REPO_DIR} reset --hard origin/main`, { stdio: 'inherit' });
}

function checkoutBranch(taskId) {
  const branch = `agent/${taskId}`;
  const remote = sh(`git ls-remote --heads origin ${branch}`);
  if (remote.ok && remote.out.trim()) {
    execSync(`git -C ${REPO_DIR} checkout -B ${branch} origin/${branch}`, { stdio: 'inherit' });
  } else {
    execSync(`git -C ${REPO_DIR} checkout -B ${branch}`, { stdio: 'inherit' });
  }
  return branch;
}

function scanSecrets() {
  // Cheap grep-based secret scan. Not a substitute for gitleaks in CI.
  const patterns = [
    /sk-[A-Za-z0-9-]{20,}/g,          // OpenAI / Anthropic style
    /gh[pousr]_[A-Za-z0-9]{20,}/g,    // GitHub tokens
    /-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----/g,
    /AKIA[0-9A-Z]{16}/g,              // AWS access key
    /[A-Za-z0-9+/]{40,}=[^A-Za-z0-9+/=]/g,
  ];
  const diff = sh('git diff --cached');
  if (!diff.ok) return { ok: true, hits: [] };
  const hits = [];
  for (const re of patterns) {
    const m = diff.out.match(re);
    if (m) hits.push(...m.slice(0, 3));
  }
  return { ok: hits.length === 0, hits };
}

function runTests() {
  const pkg = path.join(REPO_DIR, 'package.json');
  if (!fs.existsSync(pkg)) return { ok: true, skipped: 'no package.json' };
  const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  if (!(p.scripts && p.scripts.test)) return { ok: true, skipped: 'no npm test script' };
  const r = sh('npm install --no-audit --no-fund --silent && npm test', { cwd: REPO_DIR });
  return { ok: r.ok, output: (r.out || '').slice(-6000), code: r.code };
}

function buildClaudePrompt(spec, feedback) {
  const parts = [];
  parts.push('# TASK');
  parts.push(spec.task || '');
  if (spec.objective) parts.push(`\n## OBJECTIVE\n${spec.objective}`);
  if (spec.context) parts.push(`\n## CONTEXT\n${spec.context}`);
  if (Array.isArray(spec.files_to_inspect) && spec.files_to_inspect.length) parts.push(`\n## FILES_TO_INSPECT\n${spec.files_to_inspect.map(f => `- ${f}`).join('\n')}`);
  if (Array.isArray(spec.requirements) && spec.requirements.length) parts.push(`\n## REQUIREMENTS\n${spec.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  if (Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length) parts.push(`\n## ACCEPTANCE_CRITERIA\n${spec.acceptance_criteria.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  if (Array.isArray(spec.tests_required) && spec.tests_required.length) parts.push(`\n## TESTS_REQUIRED\n${spec.tests_required.map(t => `- ${t}`).join('\n')}`);
  if (Array.isArray(spec.security_requirements) && spec.security_requirements.length) parts.push(`\n## SECURITY_REQUIREMENTS\n${spec.security_requirements.map(r => `- ${r}`).join('\n')}`);
  if (Array.isArray(spec.do_not_change) && spec.do_not_change.length) parts.push(`\n## DO_NOT_CHANGE\n${spec.do_not_change.map(r => `- ${r}`).join('\n')}`);
  if (spec.deployment_policy) parts.push(`\n## DEPLOYMENT_POLICY\n${spec.deployment_policy}`);
  if (feedback) {
    parts.push('\n## PRIOR REVIEW FEEDBACK — ADDRESS THIS BEFORE ANYTHING ELSE\n');
    parts.push(`### PROBLEM\n${feedback.problem || ''}`);
    parts.push(`### WHY\n${feedback.why || ''}`);
    parts.push(`### REQUIRED_CHANGE\n${feedback.required_change || ''}`);
    parts.push(`### ACCEPTANCE_CRITERIA\n${feedback.acceptance_criteria || ''}`);
  }
  parts.push('\n## RULES OF ENGAGEMENT');
  parts.push([
    '- You are running non-interactively via `claude -p`. Print your final short report and exit.',
    '- The current working directory is a fresh git checkout of muradovnb-cyber/isola-business-suite.',
    '- You are on a task branch already; DO NOT switch branches, DO NOT touch `main`.',
    '- Edit files with Read/Edit/Write. Run tests with Bash (npm test).',
    '- DO NOT commit, push, merge, or open a PR — the runner does that after you finish.',
    '- DO NOT deploy anywhere.',
    '- DO NOT print API keys, tokens, or the contents of .env files.',
    '- When done, print a JSON block delimited by  ```json  ...  ```  with keys:',
    '  { "summary": string, "files_touched": string[], "tests": "passed"|"failed"|"skipped", "notes": string }',
  ].join('\n'));
  return parts.join('\n');
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--model', CLAUDE_MODEL, '--output-format', 'text', '--permission-mode', 'acceptEdits'];
    const proc = spawn(CLAUDE_BIN, args, { cwd: REPO_DIR, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    const to = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 25 * 60 * 1000);
    proc.on('close', code => { clearTimeout(to); resolve({ code, stdout, stderr }); });
    proc.on('error', err => { clearTimeout(to); resolve({ code: -1, stdout, stderr: (stderr + '\n' + err.message) }); });
  });
}

function parseClaudeReport(stdout) {
  const m = stdout.match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) return { summary: '(no structured report from Claude)', files_touched: [], tests: 'unknown', notes: stdout.slice(-2000) };
  try { return JSON.parse(m[1]); } catch (e) { return { summary: '(unparsable JSON report)', notes: m[1].slice(0, 2000) }; }
}

async function upsertPR(branch, taskId, report, testsRes) {
  const title = `[ai:${taskId}] ${report.summary || 'automated change'}`.slice(0, 100);
  const bodyParts = [
    `**Task ID:** \`${taskId}\``,
    `**Runner:** ai-runner (autonomous)`,
    `**Model:** ${CLAUDE_MODEL}`,
    ``,
    `## Summary`,
    report.summary || '(none)',
    ``,
    `## Files touched`,
    (report.files_touched && report.files_touched.length) ? report.files_touched.map(f => `- \`${f}\``).join('\n') : '- (none)',
    ``,
    `## Tests`,
    `- Status: **${testsRes.ok ? 'passed' : (testsRes.skipped ? 'skipped' : 'failed')}**${testsRes.skipped ? ` (${testsRes.skipped})` : ''}`,
    testsRes.output ? '```\n' + testsRes.output.slice(-2000) + '\n```' : '',
    ``,
    `## Notes`,
    (report.notes || '(none)').slice(0, 1500),
    ``,
    `## Automation policy`,
    `- Do NOT merge automatically.`,
    `- Do NOT deploy without APPROVED_FOR_DEPLOY from GPT Reviewer.`,
  ];
  const body = bodyParts.join('\n');
  const existing = sh(`gh pr list --repo ${REPO_SLUG} --state open --head ${branch} --json number,url --jq '.[0]'`);
  let prUrl = '', prNumber = null;
  if (existing.ok && existing.out.trim()) {
    const j = JSON.parse(existing.out);
    prNumber = j.number;
    prUrl = j.url;
    fs.writeFileSync('/tmp/pr-body.md', body);
    sh(`gh pr edit ${prNumber} --repo ${REPO_SLUG} --title "${title.replace(/"/g, '\\"')}" --body-file /tmp/pr-body.md`);
  } else {
    fs.writeFileSync('/tmp/pr-body.md', body);
    const r = sh(`gh pr create --repo ${REPO_SLUG} --base main --head ${branch} --title "${title.replace(/"/g, '\\"')}" --body-file /tmp/pr-body.md`);
    if (r.ok) {
      prUrl = (r.out.match(/https:\S+/) || [''])[0];
      const n = prUrl.match(/\/pull\/(\d+)/);
      if (n) prNumber = parseInt(n[1], 10);
    }
  }
  return { prUrl, prNumber };
}

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), model: CLAUDE_MODEL }));

app.post('/task', requireToken, async (req, res) => {
  const t0 = Date.now();
  const { taskId, spec, feedback, attempt } = req.body || {};
  if (!taskId || !spec) return res.status(400).json({ ok: false, error: 'taskId + spec required' });
  const runId = crypto.randomBytes(4).toString('hex');
  console.log(`[run ${runId}] task=${taskId} attempt=${attempt || 1}`);
  try {
    // Set up gh auth from env once per process
    process.env.GH_TOKEN = GH_TOKEN;
    ensureRepo();
    const branch = checkoutBranch(taskId);

    // Ask Claude to do the work
    const prompt = buildClaudePrompt(spec, feedback);
    const claudeRes = await runClaude(prompt);
    const report = parseClaudeReport(claudeRes.stdout);

    // Stage everything Claude produced
    execSync('git add -A', { cwd: REPO_DIR });

    // Secret scan
    const secrets = scanSecrets();
    if (!secrets.ok) {
      execSync('git reset --hard HEAD', { cwd: REPO_DIR });
      return res.status(400).json({
        ok: false, status: 'FAILED', code: 'SECRET_LEAK',
        runId, taskId, branch, hits: secrets.hits, claudeReport: report,
      });
    }

    // Nothing to commit?
    const diffStat = sh('git diff --cached --shortstat');
    if (!diffStat.out) {
      return res.json({
        ok: true, status: 'NO_CHANGES', runId, taskId, branch,
        claudeReport: report, claude_exit: claudeRes.code,
        note: 'Claude produced no file changes.',
      });
    }

    // Tests (on staged tree — commit first so the runner sees changes)
    const msg = `[ai:${taskId}${attempt ? ` att${attempt}` : ''}] ${(report.summary || 'automated change').slice(0, 72)}`;
    fs.writeFileSync('/tmp/commit-msg.txt', msg + '\n\n' + JSON.stringify({ runId, attempt, claudeExit: claudeRes.code }, null, 2));
    execSync(`git commit --file /tmp/commit-msg.txt`, { cwd: REPO_DIR, stdio: 'inherit' });

    const tests = runTests();

    // Push (branch may or may not exist upstream)
    execSync(`git push -u origin ${branch}`, { cwd: REPO_DIR, stdio: 'inherit' });

    // PR upsert
    const { prUrl, prNumber } = await upsertPR(branch, taskId, report, tests);
    const commit = sh('git rev-parse HEAD').out;
    const shortDiff = sh('git diff --stat main...HEAD').out;

    return res.json({
      ok: true,
      status: tests.ok ? 'READY_FOR_REVIEW' : 'READY_FOR_REVIEW_TESTS_FAILED',
      runId, taskId, branch, commit,
      pr: { number: prNumber, url: prUrl },
      tests, claudeReport: report,
      diff_stat: shortDiff,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error(`[run ${runId}] FAIL`, e);
    return res.status(500).json({ ok: false, status: 'FAILED', runId, taskId, error: e.message.slice(0, 500) });
  }
});

app.listen(PORT, () => console.log(`ai-runner listening on :${PORT}  model=${CLAUDE_MODEL}  repo=${REPO_SLUG}`));
