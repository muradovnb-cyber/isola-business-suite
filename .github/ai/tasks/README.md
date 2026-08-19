# .github/ai/tasks/ — File-based task queue

This directory is the **queue** the AI orchestrator dispatches from. Each `TASK-XXXX.json` file is one immutable submission. GPT (or a human) submits a task by opening a PR that adds a new file here. When the PR merges to `main`, GitHub Actions picks it up and hands it to the orchestrator.

## Contract

- **One file per task.** Filename must be `TASK-<slug>.json`, and the file's `.id` field must match the filename (`TASK-<slug>`).
- **Task files are immutable.** Never edit an existing file to change its status. Runtime state (RUNNING → REVIEW → PASSED/BLOCKED/…) lives in `.github/ai/orchestrator/CURRENT_STATUS.json` on the `ai/orchestrator-state` branch.
- **Only two statuses in the task file itself:** `QUEUED` (dispatch it) and `CANCELLED` (skip it).
- **Schema:** `.github/ai/tasks/SCHEMA.json`. The `.github/workflows/ai-orchestrator-sync.yml` CI validates every task on push.

## How dispatch works

1. Someone (owner or GPT) opens a PR adding `TASK-XXXX.json`.
2. Human reviews the PR (spam gate — the task queue is world-writable via PRs otherwise).
3. Merge to `main`.
4. `.github/workflows/ai-task-dispatch.yml` fires on push, scans the diff for new/modified `TASK-*.json` files with `status: "QUEUED"`, and calls the orchestrator (`ai-orchestrator.yml`) with the task's fields.
5. `ai-orchestrator.yml` runs the full loop: GPT Architect → Claude Code (ai-runner) → GitHub PR → GPT Reviewer → APPROVED/CHANGES_REQUIRED → retry up to `max_attempts`.
6. All state transitions are written to `.github/ai/orchestrator/` on the `ai/orchestrator-state` branch.

## Where results appear

| Signal | Where |
|---|---|
| Live status of the currently-executing task | [`.github/ai/orchestrator/CURRENT_STATUS.json`](../orchestrator/CURRENT_STATUS.json) on branch `ai/orchestrator-state` |
| Per-attempt history | `.github/ai/orchestrator/executions/<task_id>__<run_id>__attempt-N.json` |
| GPT Reviewer decisions | `.github/ai/orchestrator/reviews/<task_id>__<run_id>__attempt-N.json` |
| The actual code change | A PR on GitHub from branch `agent/<task_id>` |
| Owner notifications | Telegram (`@isolashefbot`, chat `63236216`) — 🟢 done, 🟡 status changes, 🔴 blocked |

## Minimal task example

```json
{
  "id": "TASK-1234",
  "status": "QUEUED",
  "priority": "normal",
  "source": "owner",
  "created_at": "2026-08-20T10:00:00Z",
  "created_by": "muradovnb-cyber",
  "objective": "One-line description of what to build/fix",
  "context": "Longer background if needed",
  "acceptance_criteria": [
    "AI_FOO.md exists at repo root with exact content 'foo'",
    "tests/foo.test.js passes when run via `node tests/foo.test.js`"
  ],
  "do_not_change": ["server.js", "index.html", "ai-runner/**"],
  "deployment_policy": "NO_DEPLOY",
  "max_attempts": 10
}
```

## Ground rules

- **Never put secrets in a task file.** CI scans and rejects on push.
- **Never mark a task PASSED/BLOCKED here.** That happens on the state branch, atomically, per attempt.
- **Cancel by editing to `CANCELLED`.** The dispatcher will skip it. This does not stop a task already in flight; contact the operator to abort a running orchestrator run.
- **File a bug against the orchestrator, not against this queue.** If the same task is dispatched twice, that's an orchestrator idempotency bug — the queue is just a set of files.

## GPT integration

GPT can create task files by opening a PR against `main`. See [`../orchestrator/GPT_HANDOFF.md`](../orchestrator/GPT_HANDOFF.md) for the machine-readable interface: what fields to fill, how to name the file, how to poll state, how to interpret the final result.
