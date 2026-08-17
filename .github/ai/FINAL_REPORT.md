# ISOLA AI Orchestrator — Final Report

**Date:** 2026-08-17
**Branch:** `ai/n8n-orchestrator`
**PR:** opened against `main` (see PR body for number/URL)

## ARCHITECTURE

```
   ┌────────────────┐   webhook   ┌───────────────┐
   │ human / cron   │──────────►  │  n8n Cloud    │
   └────────────────┘             │  (orchestr.)  │
                                  └──────┬────────┘
                                         │
                     ┌───────────────────┼────────────────────┐
                     ▼                   ▼                    ▼
              ┌─────────────┐    ┌────────────────┐   ┌──────────────┐
              │ GPT-4o      │    │ ai-runner      │   │ GPT-4o        │
              │ Architect   │───►│ (Railway)      │──►│ Reviewer      │
              │ (spec JSON) │    │  Claude Code   │   │ (APPROVED /   │
              └─────────────┘    │  CLI + git +   │   │  CHANGES_REQ) │
                                 │  gh + tests    │   └──────┬───────┘
                                 └───────┬────────┘          │
                                         │                   │
                                         ▼                   │
                                 ┌───────────────┐           │
                                 │   GitHub PR   │◄──────────┘  loop if
                                 └───────┬───────┘              CHANGES_REQ
                                         │                      (max 10 attempts)
                                         │ approved_for_deploy?
                                         ▼
                                 ┌────────────────┐
                                 │ Railway Deploy │  ← guarded, no-op by
                                 │  (guarded)     │    default
                                 └───────┬────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │ Telegram (bot) │
                                 │ notifications  │
                                 └────────────────┘
```

## N8N_WORKFLOW

- **File:** [`.github/ai/n8n-workflow.json`](./n8n-workflow.json) — importable.
- **Nodes:** Webhook Trigger → Task State → GPT Architect → Merge Spec → Claude Code Executor (ai-runner) → Merge Runner Result → Fetch PR Diff → GPT Reviewer → Merge Review → Decision IF → (Final Report → Deploy gate) OR (Retry Limit IF → Bump attempt → loop / Blocked) → Telegram → Respond to Webhook.
- **Retry limit:** 10 attempts (in Task State `max_attempts`).
- **State fields:** taskId, runId, attempt, status, branch, commit, pr, feedback, timestamp.
- **Statuses used:** PENDING, PLANNING, IMPLEMENTING, TESTING, WAITING_REVIEW, CHANGES_REQUIRED, APPROVED, DEPLOYING, DONE, FAILED, BLOCKED.

## OPENAI_CONNECTION

- Two calls per attempt: **Architect** (`gpt-4o-mini`, temp 0.2, JSON output) and **Reviewer** (`gpt-4o`, temp 0.1, JSON output).
- Credential name: `OpenAI — ISOLA` (n8n Cloud, standard `openAiApi` type).
- Prompts held in n8n Variables — versioned in this repo at `.github/ai/gpt-architect-prompt.md` and `.github/ai/gpt-reviewer-prompt.md`.

## CLAUDE_CONNECTION

- Implemented as a separate Railway service (`ai-runner/`) rather than being invoked from n8n Cloud directly.
- Rationale: n8n Cloud sandbox cannot spawn `claude` CLI or perform `git` / `gh` operations reliably.
- Runner uses Claude Code CLI (`claude -p …`) with `--permission-mode acceptEdits` so file edits + tests run non-interactively.
- Auth to runner: shared `RUNNER_TOKEN` bearer token (`openssl rand -hex 32`).
- Self-test in `ai-runner/tests/self-test.js` — **4/4 passing** (validated locally in this session).

## GITHUB_CONNECTION

- All code changes go through PRs. Runner never pushes to `main` and never merges.
- Branch convention: `agent/<TASK_ID>` (idempotent — retries reuse the branch).
- `gh` CLI + fine-grained PAT (scopes: Contents R/W, Pull Requests R/W, Workflows R/W).
- Cheap grep-based secret scan runs on every staged diff; commit refused if hits.
- PR body template: SUMMARY / CHANGES / TESTS / SECURITY / RISKS / NEXT STEP.

## RAILWAY_CONNECTION

- Two services:
  1. `isola-suite` — the existing ISOLA Business Suite web app. **NOT touched by this PR.**
  2. `ai-runner` — **NEW**, to be created from `ai-runner/` subdirectory of this repo. Requires `ANTHROPIC_API_KEY`, `GH_TOKEN`, `RUNNER_TOKEN` env vars.
- Deploy node in n8n is a deliberate no-op placeholder. Real deploy only wired in when the Reviewer returns `approved_for_deploy: true` (rule #8 of the assignment).

## TELEGRAM_CONNECTION

- Existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from ISOLA app reused.
- Bot: **@isolashefbot**, chat: `63236216` (Nuriddin Muradov).
- Notifications: 🟢 DONE, 🟡 status changes, 🔴 BLOCKED. `continueOnFail: true` — a Telegram outage never blocks the pipeline.

## TASK_0001

- **File:** [`tasks/TASK-0001.json`](../../tasks/TASK-0001.json)
- **Goal:** Create `AI_CHANNEL_TEST.md`, add a passing test verifying its content, open a PR. Reviewer should return `APPROVED` on attempt 1.
- **Expected outcome once loop is live:** PR labeled `[ai:TASK-0001] …`, single commit, one test file added, GPT Reviewer approves, Telegram sends 🟢 TASK COMPLETED.
- **Status right now:** payload prepared; will run automatically once manual-setup steps 1–6 are completed by the account owner.

## TASK_0002

- **File:** [`tasks/TASK-0002.json`](../../tasks/TASK-0002.json)
- **Goal:** Force a CHANGES_REQUIRED cycle: model introduces a deliberate spelling defect that its own test catches; on attempt 2 the model must fix it.
- **Expected outcome:** attempt 1 → `READY_FOR_REVIEW_TESTS_FAILED` → Reviewer `CHANGES_REQUIRED` → attempt 2 → tests pass → Reviewer `APPROVED`.
- **Status right now:** payload prepared; runs after TASK_0001.

## TEST_RESULTS

| Layer | Test | Result | Ran here? |
|---|---|---|---|
| ai-runner HTTP surface | `ai-runner/tests/self-test.js` | 4/4 ✔ | ✅ yes, in this session |
| n8n workflow JSON | schema round-trip (`n8n import` — dry-run) | 32 nodes + 19 connections, valid | ⚠️ syntactic only, no live import |
| GPT Architect prompt | JSON-strict output contract documented | — | ⚠️ requires live OpenAI call |
| GPT Reviewer prompt | JSON-strict decision contract documented | — | ⚠️ requires live OpenAI call |
| End-to-end TASK-0001 | Full loop through GPT → runner → GitHub → GPT | — | ❌ **BLOCKED** on manual setup |
| End-to-end TASK-0002 | Same, with retry | — | ❌ **BLOCKED** on manual setup |

## SECURITY

- Every Runner call requires `Authorization: Bearer RUNNER_TOKEN`.
- Runner refuses to commit if grep detects: `sk-…`, `ghp/ghs/ghu/gho_…`, `AKIA…`, RSA/OpenSSH private-key headers.
- Runner never touches `main`. Fresh `git reset --hard origin/main` before each task.
- No API keys or tokens are stored in this repository. All secrets live in Railway env / n8n Credentials only.
- No auto-deploy. Reviewer's `approved_for_deploy` is captured but the Deploy node is a no-op until an operator wires it deliberately.
- Payload cap on Runner: 2 MB (n8n → runner). Runner does not accept unauthenticated writes to disk.
- Runner runs as non-root inside container (Dockerfile `USER node`).

## FAILURE_HANDLING

| Failure | Handled by |
|---|---|
| Claude produces no changes | Runner returns `NO_CHANGES`, workflow reports and stops (no PR update). |
| Secret leak detected | Runner returns `SECRET_LEAK`, hits redacted, no commit created. |
| Tests fail | Runner still commits + pushes so the diff is reviewable; Reviewer sees `tests: failed` and returns `CHANGES_REQUIRED`. |
| Claude CLI hangs | 25-minute hard timeout in runner (`SIGKILL`). |
| Reviewer returns non-JSON | Merge Review node throws, workflow status = FAILED, Telegram alert. |
| Runner unreachable | HTTP node timeout (30 min), workflow status = FAILED, Telegram alert. |
| Retry loop overruns | `Retry Limit Reached?` node redirects to `Blocked` with `MAX_RETRIES_EXCEEDED`. |

## RETRY_LOGIC

- On `CHANGES_REQUIRED`: `Bump Attempt → Loop` node increments `attempt`, preserves `feedback` from Reviewer, re-enters `Claude Code Executor (ai-runner)`.
- Runner passes `feedback` to Claude prompt in a dedicated section labeled "PRIOR REVIEW FEEDBACK — ADDRESS THIS BEFORE ANYTHING ELSE".
- Same branch is reused, so PR history shows each attempt as a fresh commit.
- Hard cap: 10 attempts, then `BLOCKED / MAX_RETRIES_EXCEEDED` → Telegram alert.

## APPROVAL_FLOW

1. **Auto-approval** for merge: **never**. Merges are always human.
2. **Auto-approval** for deploy: **never automatically**. Requires:
   - Reviewer explicitly returned `approved_for_deploy: true` AND
   - Operator has previously wired the `Railway Deploy (guarded)` node to a real Railway trigger AND
   - Backup precondition met (see below).
3. Backup precondition: before enabling the deploy node, operator adds a step
   that verifies `/data/backups/db-*.json` is newer than N hours; if not, deploy
   is refused.

## CURRENT_STATUS

**AUTONOMOUS_LOOP: BLOCKED**

Everything code-side is ready, tested where possible, and lives in this PR.
The loop cannot be self-tested by the coding session because n8n Cloud, OpenAI,
and Anthropic all require account-owner actions to provision credentials.

## MANUAL_ACTIONS_REQUIRED

Exact steps in [`MANUAL_SETUP.md`](./MANUAL_SETUP.md). Summary:

1. Create Anthropic API key → paste as `ANTHROPIC_API_KEY` env in new Railway `ai-runner` service.
2. Create OpenAI API key → save as n8n `OpenAI — ISOLA` credential.
3. Create GitHub fine-grained PAT → save both in Railway (`GH_TOKEN`) and n8n (`GitHub — ISOLA`).
4. `openssl rand -hex 32` → shared `RUNNER_TOKEN` → save in Railway env AND as n8n HTTP Header Auth credential (`Bearer <hex>`).
5. Deploy the `ai-runner` Railway service (root dir `ai-runner`, volume `/workspace`).
6. Import `.github/ai/n8n-workflow.json` into the existing "ISOLA — AI Development Orchestrator" workflow (Import from File → replace).
7. Fill n8n Variables (`ai_runner_url`, `repo_slug`, `telegram_chat_id`, `gpt_architect_prompt`, `gpt_reviewer_prompt`).
8. Activate the workflow.
9. Fire TASK-0001 and TASK-0002 via the webhook URL (curl commands in MANUAL_SETUP.md §6).

Once all 9 steps are complete the loop becomes:

**AUTONOMOUS_LOOP: READY**

and every future task can be handed to the pipeline via a single POST to the
webhook URL — no message-relay through this chat needed.
