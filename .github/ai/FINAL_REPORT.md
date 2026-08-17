# ISOLA AI Orchestrator — Final Report

**Branch:** `ai/n8n-orchestrator`  · **PR:** #2  · **ai-runner:** v0.2.0

---

## ARCHITECTURE

See [`ARCHITECTURE.md`](./ARCHITECTURE.md). Owner → n8n → GPT Architect → ai-runner (Claude Code) → GitHub → GPT Reviewer → (loop or approve) → optional Railway deploy → Telegram.

## N8N

- File: [`n8n-workflow.json`](./n8n-workflow.json). 18 nodes, 17 connections. Parses.
- State machine: PENDING → PLANNING → IMPLEMENTING → TESTING → WAITING_REVIEW → CHANGES_REQUIRED → APPROVED → (DEPLOYING) → DONE / FAILED / BLOCKED.
- Retry cap: 10.
- Persistence: n8n Executions DB (per-run trace). Workflow variables hold prompt text + runner URL.
- Deploy node is a no-op placeholder — verified in the JSON: node `Railway Deploy (guarded)` returns `deploy: 'SKIPPED_BY_DESIGN'`.

## GPT

- Architect: `gpt-4o-mini`, temp 0.2, `jsonOutput: true`. Prompt in [`gpt-architect-prompt.md`](./gpt-architect-prompt.md).
- Reviewer: `gpt-4o`, temp 0.1, `jsonOutput: true`. Prompt in [`gpt-reviewer-prompt.md`](./gpt-reviewer-prompt.md).
- Both return strict JSON — machine-parseable, no free text.
- Prompts versioned in this repo; n8n workflow variables loaded from them.

## CLAUDE

- Runner: `ai-runner/` (Node.js 20-slim + git + gh + Claude Code CLI). Deploys as a separate Railway service.
- Uses `claude -p` non-interactively with `--permission-mode acceptEdits`.
- Timeouts: hard 25-min SIGKILL on Claude; 5-min on `npm install`; 10-min on `npm test`.
- Isolated `/workspace/runs/<runId>/` per run — no shared mutable state.

## GITHUB

- Source of truth for code.
- PAT scopes required: Contents R/W, Pull Requests R/W, Workflows R/W. Fine-grained, one repo.
- All changes go through PRs; `main` is human-merge-only.
- Branch convention: `agent/<TASK_ID>`.

## RAILWAY

- Two services in project `isola-suite`:
  - `isola-suite` (unchanged, currently running Phase 0-1 candidate).
  - `ai-runner` (NEW; to be provisioned by owner from `ai-runner/` subdir + `/workspace` volume).
- Deploy gate is a guarded no-op by default (see `SECURITY.md` §Deploy safety).

## TELEGRAM

- Reuses existing `TELEGRAM_BOT_TOKEN` / chat ID `63236216`.
- Notifications: 🟢 DONE / 🟡 status / 🔴 BLOCKED.
- `continueOnFail: true` — Telegram outage never blocks the pipeline.
- Never emits secrets or full PR bodies.

## SECURITY

Full model in [`SECURITY.md`](./SECURITY.md). Twelve Phase-1 hardening items — status:

| # | Item | Status | Where verified |
|---|---|---|---|
| 1 | Webhook authentication | ✔ | Runner: `requireToken` middleware + constant-time compare. Self-test [1] |
| 2 | taskId validation | ✔ | `TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/`, checked at HTTP + before `git checkout`. Self-test [2] (4 cases) |
| 3 | Command injection protection | ✔ | Every git/gh call via `spawnSync(bin, argv[], {shell:false})`. Zero `execSync`, zero `shell:true`. Self-test [9] |
| 4 | Secret redaction | ✔ | `redact()` scrubs Anthropic/OpenAI/GitHub/AWS/Slack/private-key patterns + own env values. Self-test [7] |
| 5 | Safe Git authentication | ✔ | `GIT_ASKPASS` helper script — token never embedded in URL, never in `git config`. Self-test [10] |
| 6 | Concurrent workspace isolation | ✔ | `/workspace/runs/<runId>/`, fresh clone per run, sweep hourly. Self-test [6] |
| 7 | Tests BEFORE commit | ✔ | Order is: stage → secret-scan → tests → commit-with-test-result-in-message → push. Verified in code review. |
| 8 | Claude failure handling | ✔ | Classified: `OK` / `TIMEOUT` / `NONZERO_EXIT` / `SIGNAL` / `SPAWN_ERROR` — all cached in idempotency store. |
| 9 | Retry safety | ✔ | Idempotency by `runId`: cached response returned for 24h; parallel same-`runId` calls coalesced. Self-test [5] |
| 10 | Runner rate limit | ✔ | 20 auth failures / 15min → 429; 30 tasks/min/IP → 429; global inflight cap 2 → 503. Self-tests [8] + [11] |
| 11 | Payload limits | ✔ | 512KB default (configurable). Malformed JSON → 400. Oversize → 413 `PAYLOAD_TOO_LARGE`. Self-test [3] |
| 12 | Crash recovery | ✔ | Boot-time + hourly workspace sweep of runs > 6h old. Idempotency lets naive retries be safe. |

## STATE_MACHINE

Fields per run (n8n state):
- `taskId`, `runId`, `attempt`, `status`, `branch`, `commit`, `pr` (number + url), `tests`, `feedback`, `timestamp`, `max_attempts`.

Status transitions handled by nodes: `Task State` (init) → `Merge Spec` → `Merge Runner Result` → `Merge Review` → `Decision IF` / `Retry Limit IF` / `Final Report` / `Blocked` / `Approved for Deploy`.

## RETRY

- Cap: 10 attempts. On breach → `BLOCKED / MAX_RETRIES_EXCEEDED` → Telegram.
- Between attempts, Reviewer's `feedback` is forwarded to Claude prompt in a dedicated "PRIOR REVIEW FEEDBACK — ADDRESS THIS BEFORE ANYTHING ELSE" section.
- Same PR reused across attempts (upsert by branch head).

## RECOVERY

| Failure | Detected by | Handled by |
|---|---|---|
| Claude timeout | 25-min SIGKILL | Returns `status: "TIMEOUT"` — reviewer sees it |
| npm install / test fail | Non-zero exit | Runner still commits + pushes; PR shows `TESTS_FAILED`; reviewer routes to CHANGES_REQUIRED |
| GitHub push fails | Non-zero `git push` exit | Workspace kept, returns `PUSH_FAILED` — operator investigates |
| Secret detected | Grep on staged diff | `git reset --hard HEAD`, returns `SECRET_LEAK` with truncated hits |
| Runner crash mid-task | Process supervisor (Railway) | Idempotency cache means naive retry returns cached FAILED; operator uses fresh runId to actually retry |
| n8n execution dropped | n8n retention | Executions history retained per plan |
| Duplicate task submission | runId idempotency | Cached response served with `idempotent: true` |
| Parallel same-runId POSTs | in-memory coalescer | Second call awaits first, receives same result with `coalesced: true` |

## TASK-0001

- Payload: [`tasks/TASK-0001.json`](../../tasks/TASK-0001.json)
- Purpose: prove the channel end-to-end.
- Expected trace: Architect → Runner → PR created with `AI_CHANNEL_TEST.md` + test → Reviewer APPROVED → Telegram 🟢 → DONE. No merge. No deploy.

## TASK-0002

- Payload: [`tasks/TASK-0002.json`](../../tasks/TASK-0002.json)
- Purpose: prove the retry-loop end-to-end.
- Expected trace: attempt 1 → tests fail (deliberate typo) → Reviewer CHANGES_REQUIRED with feedback → Runner attempt 2 → tests pass → Reviewer APPROVED → DONE. No merge. No deploy.

## TEST_RESULTS

| Layer | Test | Result |
|---|---|---|
| ai-runner v0.2 HTTP + code-shape | `ai-runner/tests/self-test.js` | **20/20 ✔** (covers all 12 hardening items) |
| n8n workflow JSON | schema parse | 18 nodes / 17 connections valid |
| Prompts | strict-JSON contract documented | ok |
| Task payloads | JSON parse | ok |
| End-to-end TASK-0001 | live run through n8n | **NOT PERFORMED** — blocked on manual setup |
| End-to-end TASK-0002 | live run with retry | **NOT PERFORMED** — blocked on manual setup |

## PRODUCTION_SAFETY

Verified this session:
- ✅ No `railway up` performed against the `isola-suite` production service.
- ✅ No POST against production `/api/data` or `/api/delete`.
- ✅ Production `db.json` unchanged (backup taken pre-work, sha256 recorded in PR #1).
- ✅ `main` branch of ISOLA repo unchanged; work isolated in `ai/n8n-orchestrator`.
- ✅ ISOLA Suite Phase 0-1 PR (#1) is unaffected — this PR does not touch `server.js`, `index.html`, or any suite file.
- ✅ Runner code contains **zero** invocations of Railway CLI, `npm run deploy`, or pushes to `main` — enforced by self-test [12].
- ✅ Deploy node in n8n JSON is a no-op — enforced by workflow definition + guarded by `approved_for_deploy` upstream.

## CURRENT_STATUS

**`AUTONOMOUS_LOOP: BLOCKED`**

Every code-side and doc-side deliverable is complete, tested where possible,
and lives in PR #2. The loop physically cannot self-test end-to-end from a
coding session because three credential-hop things cannot be created by
anyone but the account owner:

## MANUAL_ACTIONS_REQUIRED

Only these — nothing else:

1. **OpenAI API key** — https://platform.openai.com/api-keys → create → paste directly into n8n Cloud → Credentials → OpenAI. **Never send the key through this chat.** ⚠ An earlier key was leaked in this thread; if it hasn't been rotated yet, delete it first.

2. **Anthropic API key** — https://console.anthropic.com/settings/keys → create → paste directly into Railway service `ai-runner` → Variables → `ANTHROPIC_API_KEY`.

3. **GitHub fine-grained PAT** — https://github.com/settings/personal-access-tokens/new → repo `muradovnb-cyber/isola-business-suite`, scopes: Contents R/W + Pull Requests R/W + Workflows R/W → paste into (a) Railway ai-runner env `GH_TOKEN`, (b) n8n Credentials → GitHub.

4. **`openssl rand -hex 32`** → shared `RUNNER_TOKEN` → paste into (a) Railway ai-runner env `RUNNER_TOKEN` (raw hex), (b) n8n Credentials → HTTP Header Auth, header name `Authorization`, value `Bearer <hex>`.

5. **Provision Railway service `ai-runner`** — Railway dashboard → project `isola-suite` → + New Service → Deploy from GitHub → this repo → Root Directory `ai-runner` → Add Volume mount `/workspace`. Set the three env vars above.

6. **Import workflow into n8n** — open [nuriddinai.app.n8n.cloud](https://nuriddinai.app.n8n.cloud) → workflow "ISOLA — AI Development Orchestrator" → Import from File → pick `.github/ai/n8n-workflow.json`. Wire the credentials (OpenAI, GitHub, Telegram, HTTP Header Auth). Fill workflow variables (`ai_runner_url`, `repo_slug`, `telegram_chat_id`, `gpt_architect_prompt`, `gpt_reviewer_prompt`). Activate.

7. **Kick TASK-0001**:
   ```bash
   curl -X POST https://nuriddinai.app.n8n.cloud/webhook/isola-task \
     -H "Content-Type: application/json" \
     -d @tasks/TASK-0001.json
   ```
   Expected: PR appears from `agent/TASK-0001`, Reviewer approves, Telegram 🟢. No merge. No deploy.

8. **Kick TASK-0002** (retry-loop demo):
   ```bash
   curl -X POST https://nuriddinai.app.n8n.cloud/webhook/isola-task \
     -H "Content-Type: application/json" \
     -d @tasks/TASK-0002.json
   ```
   Expected: attempt 1 fails tests → CHANGES_REQUIRED → attempt 2 passes → APPROVED.

Once TASK-0001 and TASK-0002 pass through the pipeline **without owner
intervention between steps**, this file will be updated with:

**`AUTONOMOUS_LOOP: READY`**

and every subsequent task becomes a single POST to the webhook. No message
relay through this chat is needed.

---

## Why not `READY` right now

The pipeline requires four credentials that can only be created by the
account owner (n8n / OpenAI / Anthropic / GitHub PAT). Nothing else is
missing.

Once the owner does the 8 steps in `MANUAL_ACTIONS_REQUIRED` (est. 15
minutes), the loop is operational and self-sufficient.
