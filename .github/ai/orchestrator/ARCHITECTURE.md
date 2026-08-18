# Orchestrator Architecture — GitHub-centric

```
                     ┌────────────────┐
   OWNER / cron ────►│   n8n Cloud    │  (workflow: ISOLA — AI Development Orchestrator)
                     └───────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
     ┌──────────────┐             ┌─────────────────┐
     │  OpenAI      │             │   GitHub API    │  ◄── state I/O
     │  Architect   │             │  (this repo)    │
     │  Reviewer    │             └─────────────────┘
     └──────┬───────┘                       ▲
            │                               │  every state transition
            ▼                               │
     ┌──────────────┐                       │
     │  ai-runner   │─── writes execution.json ─┘
     │  (Railway)   │
     │  Claude CLI  │
     └──────┬───────┘
            │
            ▼
     ┌──────────────┐
     │  GitHub PR   │  (branch: agent/<TASK_ID>)
     └──────┬───────┘
            │
            ▼
     ┌──────────────┐
     │  GPT Review  │─── writes review.json
     └──────┬───────┘
            │
    ┌───────┴───────┐
    │               │
APPROVED       CHANGES_REQUIRED
    │               │
    │               └─── feedback → next attempt (loop, ≤10)
    │
    ▼
approved_for_deploy?
    │
   yes → Railway deploy (guarded) → health check → DONE
    no → DONE
```

## GitHub is the source of truth

- **Configuration** lives in `main` (workflow.json, prompts, schemas, README, ARCHITECTURE).
- **Live state** lives on branch `ai/orchestrator-state`:
  - `CURRENT_STATUS.json` (overwritten)
  - `CURRENT_TASK.json` (overwritten)
  - `executions/*.json` (append-only)
  - `reviews/*.json` (append-only)
  - `reports/CURRENT_FOR_GPT.md` (overwritten each run)

Rationale: keep `main` clean of high-frequency state churn; keep `ai/orchestrator-state` easy to inspect and diff without polluting the code history.

## State transitions n8n writes

| At node | Transition | State write |
|---|---|---|
| Task State (webhook) | `IDLE → PLANNING` | overwrite CURRENT_TASK.json + CURRENT_STATUS.json |
| Merge Spec | `PLANNING → IMPLEMENTING` | overwrite CURRENT_STATUS.json |
| Merge Runner Result | `IMPLEMENTING → WAITING_REVIEW` (or `FAILED`) | overwrite CURRENT_STATUS.json + create executions/<t>__<r>__attempt-<n>.json |
| Merge Review | `WAITING_REVIEW → APPROVED | CHANGES_REQUIRED` | overwrite CURRENT_STATUS.json + create reviews/<t>__<r>__attempt-<n>.json |
| Bump Attempt → Loop | `CHANGES_REQUIRED → IMPLEMENTING (attempt+1)` | overwrite CURRENT_STATUS.json |
| Blocked (max retries) | `→ BLOCKED` | overwrite CURRENT_STATUS.json |
| Approved for Deploy? → Railway Deploy | `APPROVED → DEPLOYING → DONE|DEPLOY_FAILED` | overwrite CURRENT_STATUS.json |
| Final Report | `→ DONE` | overwrite CURRENT_STATUS.json |

Every write goes through GitHub's Contents API with a commit message `ai-orchestrator: <run_id> <status>` on branch `ai/orchestrator-state`.

## Crash recovery

If n8n crashes mid-run:
1. `CURRENT_STATUS.json` still holds the last known state (n8n writes at each transition).
2. When the workflow is retriggered with the same `run_id` (idempotency), n8n reads `CURRENT_STATUS.json`:
   - If `status = DONE|BLOCKED|IDLE` → treat as new run, generate fresh `run_id`.
   - If `status = WAITING_REVIEW` → skip Architect + Claude, jump straight to Fetch PR Diff + Reviewer.
   - If `status = CHANGES_REQUIRED` → skip Architect, re-run Claude with cached `feedback`.
   - If `status = IMPLEMENTING` → resume from Claude (ai-runner has its own idempotency by `run_id` — will return cached result if same request repeated).
3. Human operator can force-reset by editing `CURRENT_STATUS.json` and setting `status: IDLE` and pushing to `ai/orchestrator-state`.

The recovery logic lives in the first `Task State` code node of n8n workflow (see `workflow.json`).

## Never in this repo

- API keys (OpenAI, Anthropic, GitHub, Telegram) — n8n Credentials vault only.
- The RUNNER_TOKEN shared secret — Railway env only.
- Any user-visible secret pattern (`sk-…`, `ghp_…`, `AKIA…`, `-----BEGIN…KEY-----`, etc). CI blocks the push.
