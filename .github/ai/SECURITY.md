# ISOLA AI Orchestrator — Security Model

## Trust boundaries

```
[owner browser / cron]  ─(HTTPS)─►  [n8n Cloud]   ─(HTTPS + Bearer)─►  [ai-runner]  ─(shell)─►  [git/gh/claude]
                                        │                                    │
                                        ├─(HTTPS)─►  [OpenAI API]            └─(HTTPS)─►  [Anthropic API]
                                        └─(HTTPS)─►  [Telegram API]
```

Every arrow is HTTPS. Every ingress hop authenticates the caller:

| Hop | Auth |
|---|---|
| owner → n8n webhook | Public webhook path; task payload is code-authoritative not identity-authoritative. Consider adding a webhook signature in Phase 2 if the URL leaks. |
| n8n → ai-runner | `Authorization: Bearer $RUNNER_TOKEN` (32-hex, shared secret) |
| ai-runner → GitHub | Fine-grained PAT via `GIT_ASKPASS` helper (never embedded in URL) |
| ai-runner → Anthropic | `ANTHROPIC_API_KEY` env var — process-only, never logged |
| n8n → OpenAI | Native `openAiApi` credential in n8n vault |
| n8n → Telegram | Native `telegramApi` credential in n8n vault |

## Secret handling — invariants

1. **No secret ever lives in this repository.** All in Railway env or n8n Credentials.
2. **No secret ever appears in n8n workflow JSON.** Credentials are referenced by name/type.
3. **No secret ever appears in a log line.** `redact()` in `ai-runner/server.js` strips:
   - `sk-ant-…` (Anthropic)
   - `sk-…` (OpenAI-style)
   - `gh[pousr]_…` (GitHub tokens)
   - `AKIA…` + `aws_secret_access_key…` (AWS)
   - `xox[baprs]-…` (Slack)
   - RSA/EC/OpenSSH `PRIVATE KEY` blocks
   - the process's own known env-var values (belt & suspenders)
4. **No secret ever gets committed.** Pre-commit grep-based scan aborts with `SECRET_LEAK` if any of the above patterns appear in the staged diff.
5. **No secret ever gets sent to Telegram.** The Telegram node's message template is a fixed short string (status + task id + PR URL). PR bodies are NOT forwarded.
6. **No secret ever gets sent to GPT.** The Reviewer prompt receives only: task spec, PR diff (which was secret-scanned), file list, test output, Claude report. Nothing else.

## Command-injection defence

- Every `git` and `gh` call in `ai-runner/server.js` goes through `spawnSync(bin, argvArray, { shell: false })`. There is no `execSync`, no `exec()`, no `shell: true` anywhere.
- Input validation happens BEFORE any spawn:
  - `taskId` must match `^[A-Za-z0-9_-]{1,80}$`
  - `runId` must match `^[A-Za-z0-9_-]{1,80}$`
  - `spec` must be a plain object
  - Payload capped at 512 KB (`MAX_PAYLOAD_BYTES`), body-parser rejects with 413 on overflow
- Regex guards are enforced BOTH at input (via HTTP handler) and at code path (`checkoutBranch` re-validates before constructing `agent/<taskId>`).

## Workspace isolation

- Every task run gets a fresh `/workspace/runs/<runId>/` — brand-new clone, no shared state with prior/concurrent runs.
- On success: workspace destroyed immediately.
- On failure: workspace kept for **up to 6 hours** (`WORKSPACE_TTL_MS`) for post-mortem, then automatically swept.
- Hourly sweep also runs on `setInterval` to catch missed cleanups.
- Concurrent runs cap: `MAX_CONCURRENT = 2` (default); 3rd concurrent request → `503 BUSY`.

## Rate limits

| Endpoint | Rule |
|---|---|
| `/task` (auth failures) | 20 failed bearer attempts / IP / 15 min → 429 |
| `/task` (successful) | 30 requests / IP / min → 429 |
| Concurrency | Global inflight ≤ 2 → 503 while busy |
| Idempotency | Same `runId` returns cached response for 24 h |

## Deploy safety

- Runner **never** calls `railway up`, `railway link`, or any Railway command.
- Runner **never** pushes to `main` (guarded by test + code review).
- Runner **never** merges anything.
- n8n `Railway Deploy (guarded)` node is a **no-op placeholder** — it exists so the workflow is visually complete, but the code path returns `deploy: 'SKIPPED_BY_DESIGN'`.
- Enabling real deploys requires an operator to:
  1. Replace the placeholder body with an actual Railway deploy trigger call, AND
  2. Wire it to only fire when `approved_for_deploy === true` from Reviewer, AND
  3. Add a backup-freshness precondition (`/data/backups/db-*.json` mtime < N hours).

## Failure containment

| Failure | Blast radius |
|---|---|
| Claude produces malicious output | Stopped at secret scan / test failure; no push if tests fail (`READY_FOR_REVIEW_TESTS_FAILED` — reviewer sees failing tests) |
| Someone steals `RUNNER_TOKEN` | Can trigger tasks; each task still creates only a PR (never merges/deploys). Rotate token, restart runner. |
| Someone steals `GH_TOKEN` | Can push branches / open PRs. PAT is fine-grained (Contents R/W + PR R/W + Workflows R/W) — cannot delete repo, cannot access other repos. Rotate. |
| Someone steals `OPENAI_API_KEY` | Costs money. Cannot escalate. Rotate. |
| Someone steals `ANTHROPIC_API_KEY` | Same. |
| n8n Cloud outage | No new runs. In-flight runs continue on the runner but fail at `Fetch PR Diff` when n8n restarts and drops execution. |
| Runner crash mid-task | Workspace retained for 6h; run marked `FAILED`; PR (if any) is left in whatever state it was; operator investigates. Idempotency cache means a naive retry with same `runId` returns the cached FAILED response — operator issues a fresh `runId` to actually retry. |

## Threat model — what this system is NOT

- Not a defence against a compromised OpenAI/Anthropic account (they can generate arbitrary code + reviews).
- Not a defence against an insider with write access to `main` (they can bypass the runner entirely).
- Not a defence against a compromised Railway account (they can flip env vars).
- Not a replacement for human code review before production deploy.

## Reporting

If you discover a secret in a log / PR / Telegram message / repo: **rotate first, investigate second**. Contact @mnb0088.
