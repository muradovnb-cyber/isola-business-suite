# GPT_REPORTS.md — how GPT reads per-task reports

> Companion to [`GPT_HANDOFF.md`](GPT_HANDOFF.md). This file focuses only on the **read report** action.

## Where reports live

Every orchestrator run writes exactly one consolidated report at the end:

```
{raw-state}/.github/ai/reports/TASK-<id>.json
```

where `{raw-state}` = `https://raw.githubusercontent.com/muradovnb-cyber/isola-business-suite/ai/orchestrator-state/`.

If the task was re-submitted (same `id`, fresh `run_id`), the report is **overwritten** with the latest run's summary. The full audit trail is preserved in `orchestrator/executions/` and `orchestrator/reviews/`.

## Report payload

Schema: [`.github/ai/reports/schema.json`](../reports/schema.json).

```json
{
  "task_id":  "TASK-0042",
  "run_id":   "run-abc123",
  "status":   "PASSED",
  "attempts": 2,
  "commit":   "e4a1c8fb…",
  "pr":       { "number": 42, "url": "https://github.com/muradovnb-cyber/isola-business-suite/pull/42" },
  "tests":    { "ok": true,  "skipped": false, "framework": "node-assert", "summary": "1 passed" },
  "review":   { "decision": "APPROVED", "attempt": 2, "approved_for_deploy": false, "summary": "…" },
  "changes":  ["scripts/foo.sh", "tests/foo.test.js"],
  "remaining_issues": [],
  "next_action":  "human merges PR #42",
  "started_at":   "2026-08-20T12:34:00Z",
  "finished_at":  "2026-08-20T12:37:00Z"
}
```

## Field guide

| Field | Type | Meaning |
|---|---|---|
| `task_id` | string | The `id` from the task file. |
| `run_id` | string | Random per-run identifier (`run-<12hex>`). Different every run of the same task. |
| `status` | enum | `PASSED` \| `BLOCKED` \| `FAILED`. Never `RUNNING` or `IDLE` — the report only exists once the run is terminal. |
| `attempts` | int | How many runner attempts happened. `1` on first-shot success. |
| `commit` | string \| null | Last agent commit SHA. Null if no commit made (e.g. `NO_CHANGES`). |
| `pr` | object \| null | `{number, url}`. Null if no PR was opened. |
| `tests` | object \| null | `{ok, skipped, framework, summary}` from the runner's test step. |
| `review` | object \| null | `{decision, attempt, approved_for_deploy, summary}` from the winning reviewer pass. |
| `changes` | string[] | Files touched, from the PR's `files` API. |
| `remaining_issues` | string[] | Non-blocking issues the reviewer flagged but did not require fixes for. Empty on clean approve. |
| `next_action` | string | What the human should do next (typically "merge PR", "investigate blockers", etc). |
| `started_at`, `finished_at` | ISO-8601 UTC | Run window. |

## Reading recipes

### One report — HTTP GET, no auth

```bash
curl -sS https://raw.githubusercontent.com/muradovnb-cyber/isola-business-suite/ai/orchestrator-state/.github/ai/reports/TASK-0042.json
```

### List every task that has a report

```bash
curl -sS \
  https://api.github.com/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/reports?ref=ai/orchestrator-state \
  | jq -r '.[] | select(.name | test("^TASK-.*\\.json$")) | .name'
```

### Diff between report and current state

Compare `reports/TASK-0042.json.status` (terminal) vs `state/current.json.status` (may already be `IDLE`, or running a newer task). The report is the historical snapshot; the state is live.

## When the report file is missing

- Task not merged yet → dispatcher never fired. Check `.github/ai/tasks/TASK-<id>.json` on `main`.
- Task merged but workflow errored before writing state → check `{api}/repos/…/actions/runs?event=workflow_dispatch` for a failed run, and inspect its logs.
- Task still running → check `state/current.json.current_task`.

## Attempt-level detail — when the report isn't enough

The report is a one-object summary. For per-attempt trace:

- `.github/ai/orchestrator/executions/<task_id>__<run_id>__attempt-<N>.json` — the runner's full return payload for that attempt (spec, diff stat, claudeReport, tests).
- `.github/ai/orchestrator/reviews/<task_id>__<run_id>__attempt-<N>.json` — the reviewer's decision for that attempt (including CHANGES_REQUIRED feedback that drove the retry).

Both directories are append-only on `ai/orchestrator-state`; nothing is ever deleted.
