# ISOLA AI Orchestrator — Architecture

## Data flow

```
                       ┌───────────────┐
                       │   OWNER       │
                       │  (or cron)    │
                       └──────┬────────┘
                              │ HTTP POST { task, taskId }
                              ▼
                      ┌────────────────┐
                      │   n8n Cloud    │  ── orchestration state
                      │   Webhook      │     (executions DB)
                      └───────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  GPT Architect  │  gpt-4o-mini, JSON output
                     │  (OpenAI)       │  → spec object
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  ai-runner      │  Express, Railway service
                     │  (Claude Code)  │  + git + gh + argon2 secrets
                     └────────┬────────┘   isolated /workspace/runs/<runId>/
                              │ commit + push + PR
                              ▼
                     ┌─────────────────┐
                     │  GitHub PR      │
                     └────────┬────────┘
                              │ diff + files + tests
                              ▼
                     ┌─────────────────┐
                     │  GPT Reviewer   │  gpt-4o, JSON output
                     │  (OpenAI)       │  → APPROVED | CHANGES_REQUIRED
                     └────────┬────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
                    ▼                    ▼
             APPROVED             CHANGES_REQUIRED
                    │                    │
                    │                    ▼
                    │           Bump attempt (n+1)
                    │                    │
                    │                    ▼
                    │              back to ai-runner
                    │              with feedback
                    │
                    ▼
          approved_for_deploy?
                    │
                    ├── false → DONE
                    │
                    └── true → Railway Deploy (guarded)
                                    │
                                    ▼
                            /api/health check
                                    │
                              ┌─────┴─────┐
                              ▼           ▼
                           OK / DONE   DEPLOY_FAILED
                                          │
                                          ▼
                                    Telegram alert
```

## Components

### 1. n8n Cloud (`nuriddinai.app.n8n.cloud`)
- Workflow: `ISOLA — AI Development Orchestrator` (18 nodes).
- Persists execution state per run in n8n's Executions DB.
- Retry cap: 10 attempts (`max_attempts` in Task State node).
- Sends Telegram notifications on state transitions.
- All secrets in n8n **Credentials** (not the workflow JSON).

### 2. GPT Architect (OpenAI, `gpt-4o-mini`)
- Turns human task into strict JSON spec.
- System prompt versioned in `.github/ai/gpt-architect-prompt.md`.
- Loaded into n8n as workflow variable `gpt_architect_prompt`.
- `temperature: 0.2`, `jsonOutput: true`.

### 3. ai-runner (Railway service, this repo `ai-runner/`)
- Node.js/Express HTTP wrapper around **Claude Code CLI** (`claude -p`).
- Never uses shell interpolation; all git/gh calls go through `spawnSync` with argv arrays.
- **Fresh isolated workspace per run** at `/workspace/runs/<runId>/`. No mutable shared state.
- Auth: shared `RUNNER_TOKEN` bearer with n8n.
- Rate limits: 20 auth failures / 15 min → 429; 30 tasks / min per IP; global inflight cap = 2.
- Idempotency: repeated POST with same `runId` returns cached response.
- Secret scan on staged diff blocks: OpenAI/Anthropic/GitHub/AWS/Slack keys, RSA/OpenSSH private keys.
- Tests run **before** commit; commit message and PR body carry the true test result.
- Never merges `main`; never runs any deploy command.

### 4. GPT Reviewer (OpenAI, `gpt-4o`)
- Reads spec + PR diff + files + test output + Claude report.
- Returns strict JSON: `{ decision: "APPROVED", approved_for_deploy: bool }` OR `{ decision: "CHANGES_REQUIRED", feedback: {…} }`.
- System prompt versioned in `.github/ai/gpt-reviewer-prompt.md`.
- `temperature: 0.1`, `jsonOutput: true`.

### 5. GitHub (`muradovnb-cyber/isola-business-suite`)
- Source of truth for code.
- Branch convention: `agent/<TASK_ID>`.
- PR body template: `SUMMARY / CHANGES / TESTS / SECURITY / NOTES / AUTOMATION POLICY`.
- Merge decision is **always human**.

### 6. Railway (guarded)
- Two services live in the Railway project `isola-suite`:
  1. `isola-suite` — the ISOLA Business Suite web app (unchanged by this PR).
  2. `ai-runner` — the executor service, NEW, deployed from the `ai-runner/` subdir with a mounted volume at `/workspace`.
- **Deploy node in n8n is a no-op placeholder by design.** Real production deploys require the Reviewer to explicitly return `approved_for_deploy: true` AND an operator to wire that node.

### 7. Telegram (`@isolashefbot`)
- Reuses existing bot from ISOLA suite; chat ID `63236216`.
- Notifications: `🟢 DONE`, `🟡 status changes`, `🔴 BLOCKED`.
- `continueOnFail: true` — Telegram outage never blocks the pipeline.
- Never emits secrets or PR bodies (only status + PR URL).

## State machine

```
PENDING → PLANNING → IMPLEMENTING → TESTING → WAITING_REVIEW ──┐
                                                               │
                                     ┌───── CHANGES_REQUIRED ◄─┤
                                     │                         │
                                     ▼                         │
                              (bump attempt)                   │
                                     │                         │
                                     └──── IMPLEMENTING ────►──┘
                                                               │
                                                    APPROVED ◄─┘
                                                       │
                                                       ▼
                                             approved_for_deploy?
                                              yes │       │ no
                                                  ▼       ▼
                                            DEPLOYING   DONE
                                                  │
                                            ┌─────┴─────┐
                                            ▼           ▼
                                         DONE      FAILED
                                                        │
                                                        ▼
                                                    BLOCKED
```

## Non-goals (Phase 2+)

- Server-side financial calculations (Phase 4 of the ISOLA plan).
- Postgres migration for the app DB (Phase 6, optional).
- Per-entity CRUD endpoints replacing bulk `/api/data` (Phase 3).
- Multi-tenant workflows (single-tenant by design).
