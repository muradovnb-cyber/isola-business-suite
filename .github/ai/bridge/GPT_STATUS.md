# GPT_STATUS.md — how GPT reads the live state

> Companion to [`GPT_HANDOFF.md`](GPT_HANDOFF.md). This file focuses only on the **read state** action.

## One canonical URL

```
https://raw.githubusercontent.com/muradovnb-cyber/isola-business-suite/ai/orchestrator-state/.github/ai/state/current.json
```

No auth required — public repo. HTTP `GET`, JSON body, ~500 B.

If the state branch does not exist yet (first-ever setup), the URL returns 404 — treat that as `status: IDLE` with everything else null.

## Payload

```jsonc
{
  "status":       "RUNNING",
  "current_task": "TASK-0042",
  "stage":        "implementing",
  "agent":        "claude-runner",
  "attempt":      1,
  "last_commit":  "e4a1c8fb…",
  "last_pr":      null,
  "last_review":  null,
  "blockers":     [],
  "next_action":  "runner attempt 1",
  "updated_at":   "2026-08-25T09:12:31Z"
}
```

Schema: [`.github/ai/state/schema.json`](../state/schema.json).

### `status` — enum

| Value | Meaning |
|---|---|
| `IDLE` | Nothing running. `current_task` is null. |
| `QUEUED` | Task file merged, dispatcher fired, workflow starting. |
| `RUNNING` | Claude Code is writing files or the architect is planning. |
| `REVIEW` | GPT Reviewer is evaluating the PR. |
| `FIXING` | Reviewer sent CHANGES_REQUIRED; Claude is re-running with feedback. |
| `PASSED` | Terminal. Reviewer APPROVED. PR open, waiting for human merge. |
| `BLOCKED` | Terminal. Retry cap hit or Reviewer said BLOCKED. `blockers[]` explains. |
| `FAILED` | Terminal. Runtime error (runner unreachable, OpenAI 5xx). Retryable. |

### `stage` — enum (or null when IDLE / terminal)

| Value | Meaning |
|---|---|
| `planning` | GPT Architect is generating the spec. |
| `implementing` | Claude Code is writing/patching files. |
| `testing` | The runner is executing `tests_required`. |
| `reviewer` | GPT Reviewer is inspecting the PR. |
| `done` | Set momentarily on terminal transition. |

### `agent` — enum (or null when IDLE)

`gpt-architect` | `claude-runner` | `gpt-reviewer`. Whoever is currently working.

### `attempt`

`0` when planning is still happening. `1..max_attempts` during runner/reviewer loop.

### `last_commit`

SHA of the most recent commit the runner pushed to `agent/<task_id>`. Null before the first successful runner attempt.

### `last_pr`

```jsonc
{ "number": 42, "url": "https://github.com/muradovnb-cyber/isola-business-suite/pull/42" }
```

Null before the runner opens a PR.

### `last_review`

```jsonc
{ "decision": "CHANGES_REQUIRED", "attempt": 1, "url": "https://…/reviews/TASK-0042__run-abc__attempt-1.json" }
```

Null before the first reviewer decision.

### `blockers`

Array of short human-readable strings, each describing a live blocker. Empty array = nothing blocking. Examples:

```json
["OpenAI 429 for 6h — key may be throttled",
 "PR #42 waiting for human merge",
 "Runner reports NO_CHANGES for attempt 3 — spec may be underspecified"]
```

GPT should read `blockers[]` **before** submitting a new task or a retry.

### `next_action`

A single short imperative sentence describing what the orchestrator will do next (`"runner attempt 2"`, `"gpt-reviewer"`, `"human merges PR when ready"`).

### `updated_at`

ISO-8601 UTC. If `status != IDLE` and `updated_at` is more than a few minutes old, the workflow has likely died — check `{api}/repos/…/actions/workflows/ai-orchestrator.yml/runs?per_page=1`.

## Complementary reads

- **More detail than the projection:** `.github/ai/orchestrator/CURRENT_STATUS.json` on the same branch (rich schema, sliding-window history).
- **Historical attempts:** list `.github/ai/orchestrator/executions/` for files starting with `<task_id>__`.
- **Reviewer decisions:** list `.github/ai/orchestrator/reviews/`.

## Freshness contract

- Every state transition writes `state/current.json` **before** the next transition begins.
- A single orchestrator run holds a `concurrency: ai-orchestrator-<task_id>` lock, so no two runs update the projection for the same task at the same time.
- Different tasks can run concurrently — read `current_task` to know which one the projection describes.
