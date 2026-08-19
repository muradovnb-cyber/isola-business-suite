# GPT_HANDOFF.md — machine-readable interface for GPT (or any external LLM)

> This document is the **contract** between an external LLM (typically ChatGPT acting as Architect/Reviewer) and the ISOLA autonomous orchestrator. It replaces the message-relay pattern where the owner copy-pasted between systems.

## Repository

`muradovnb-cyber/isola-business-suite`, default branch `main`, GitHub REST API base `https://api.github.com`.

## Interface at a glance

| GPT wants to… | Do this |
|---|---|
| **Submit a new task** | Open a PR that adds `.github/ai/tasks/TASK-<slug>.json` with `status: "QUEUED"`. When merged, the dispatcher fires the orchestrator automatically. |
| **Read the live state** | `GET /repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/orchestrator/CURRENT_STATUS.json?ref=ai/orchestrator-state` — base64-decode `.content`. |
| **Read execution history for a task** | `GET /repos/…/contents/.github/ai/orchestrator/executions?ref=ai/orchestrator-state` → list files → pick those whose name starts with `<task_id>__`. |
| **Read a reviewer decision** | `GET /repos/…/contents/.github/ai/orchestrator/reviews/<task_id>__<run_id>__attempt-<N>.json?ref=ai/orchestrator-state` |
| **Read the PR the orchestrator opened** | `GET /repos/…/pulls?head=muradovnb-cyber:agent/<task_id>` |
| **Cancel a queued (not yet dispatched) task** | Open a PR that edits the task file's `.status` to `"CANCELLED"`. |
| **Abort a running task** | Not GPT-doable — requires owner. See "Escalation" below. |

## Submitting a task — canonical payload

Filename: `.github/ai/tasks/TASK-<slug>.json` (slug: `[A-Za-z0-9_-]{1,72}`, and file `.id` must match)

```json
{
  "id": "TASK-0042",
  "status": "QUEUED",
  "priority": "normal",
  "source": "gpt",
  "created_at": "2026-08-20T12:34:56Z",
  "created_by": "chatgpt-session-abc123",
  "objective": "Short one-line goal (5-500 chars)",
  "context": "Longer background",
  "files_to_inspect": ["path/one.js", "path/two.md"],
  "requirements": ["Rule 1", "Rule 2"],
  "acceptance_criteria": ["Verifiable predicate 1", "Verifiable predicate 2"],
  "tests_required": ["node tests/newthing.test.js exits 0"],
  "security_requirements": ["no plaintext secrets in commit"],
  "do_not_change": ["server.js", "index.html", "ai-runner/**", ".github/**"],
  "deployment_policy": "NO_DEPLOY",
  "max_attempts": 10
}
```

Full schema: [`.github/ai/tasks/SCHEMA.json`](../tasks/SCHEMA.json) — the sync CI validates every push.

## Rules GPT must honour when submitting

1. **`id` must equal filename.** `TASK-0042.json` → `"id": "TASK-0042"`.
2. **Status is always `QUEUED`** for a new submission. Any other value (except `CANCELLED`) fails schema.
3. **Never include secrets.** The sync CI grep-scans and fails the push if any of these appear: `sk-…`, `sk-ant-…`, `gh[pousr]_…`, `github_pat_…`, `AKIA…`, RSA/OpenSSH private-key blocks, `xox[baprs]-…`. Failed pushes = task never enters the queue.
4. **Cite files that exist.** Don't invent paths. The Reviewer will penalise the run.
5. **Always populate `do_not_change`.** Empty means "anywhere" — very permissive; usually you want `["ai-runner/**", ".github/**"]` at minimum so the executor can't rewrite its own runtime.
6. **Default `deployment_policy: "NO_DEPLOY"`.** Do not set `APPROVED_FOR_DEPLOY_MANUAL` unless the task explicitly requires a Railway deploy (rare). Even then, the actual deploy button is human-gated.
7. **Acceptance criteria must be verifiable** by (a) inspecting the diff, (b) running a test, or (c) hitting an endpoint. "Looks good" is not an acceptance criterion.

## State — where to read after submitting

The orchestrator writes to branch `ai/orchestrator-state` on every state transition.

### 1. `CURRENT_STATUS.json` — one file, overwritten

Matches [`.github/ai/orchestrator/schemas/status.schema.json`](./schemas/status.schema.json). Key fields for GPT:

```jsonc
{
  "task_id": "TASK-0042",
  "run_id":  "run-abc123",
  "status":  "APPROVED",           // PENDING | PLANNING | IMPLEMENTING | TESTING | WAITING_REVIEW | CHANGES_REQUIRED | APPROVED | DEPLOYING | DONE | FAILED | BLOCKED | IDLE
  "attempt": 2,
  "max_attempts": 10,
  "pr":      {"number": 42, "url": "https://github.com/…/pull/42"},
  "tests":   "PASS",              // PASS | FAIL | SKIPPED | PENDING
  "review":  "APPROVED",          // PENDING | APPROVED | CHANGES_REQUIRED | BLOCKED
  "deployment": "NOT_REQUESTED",  // NOT_REQUESTED | PENDING | SUCCESS | FAILED
  "next_action": "human merges PR when ready",
  "updated_at": "2026-08-20T12:37:00Z"
}
```

### 2. `executions/<task_id>__<run_id>__attempt-<N>.json` — one file per attempt, append-only

Matches [`schemas/execution.schema.json`](./schemas/execution.schema.json). Contains:
- The `spec` the Architect produced
- The `claudeReport` (summary, files_touched, tests, notes)
- The `feedback` (from prior reviewer, if this was a retry)
- Timestamps, duration, error if any

### 3. `reviews/<task_id>__<run_id>__attempt-<N>.json` — one file per review

Matches [`schemas/review.schema.json`](./schemas/review.schema.json). GPT's own past decisions live here too. Shape:

```jsonc
{
  "task_id": "TASK-0042",
  "run_id":  "run-abc123",
  "attempt": 2,
  "decision": "APPROVED",         // APPROVED | CHANGES_REQUIRED | BLOCKED
  "approved_for_deploy": false,
  "created_at": "2026-08-20T12:37:00Z",
  "reviewer": "gpt-4o@0.1",
  "summary": "Passes all criteria; no security issues.",
  "feedback": null                // populated only on CHANGES_REQUIRED
}
```

## GPT as Architect / Reviewer inside the loop

When the orchestrator runs, it calls OpenAI's `/v1/chat/completions` directly (JSON mode):
- **Architect prompt:** [`.github/ai/orchestrator/prompts/architect.md`](./prompts/architect.md) → converts the task file's `objective` + `context` into a strict-JSON spec.
- **Reviewer prompt:** [`.github/ai/orchestrator/prompts/reviewer.md`](./prompts/reviewer.md) → returns `{decision, approved_for_deploy?, feedback?}`.

Both prompts are versioned in git; any change to them is a PR.

**GPT never edits code inside the loop.** Only Claude Code (running inside `ai-runner` on Railway) writes files. GPT plans and reviews.

## Idempotency

- Task file dispatched at most once per push (GitHub push event carries the diff).
- The orchestrator uses a fresh `run_id` per attempt (`<run>-a<N>`), so `ai-runner`'s per-`runId` idempotency cache doesn't stick attempt 1's result to attempt 2+.
- If a task is re-triggered after completion, a new `run_id` is generated; the prior `executions/*.json` files stay untouched.

## Termination conditions

The orchestrator run exits and stops writing state when one of:

| Terminal state | Exit code | What it means for GPT |
|---|---|---|
| `DONE` | 0 | Task achieved acceptance criteria; PR opened, awaiting human merge. |
| `BLOCKED` | 2 | Retry cap or reviewer BLOCKED. `error` field says which. Human needs to look. |
| `FAILED` | 1 | Uncaught runtime error (runner unreachable, OpenAI 5xx, etc). Retryable — GPT can submit the same task again. |

Telegram notification fires on the terminal transition; GPT does not need to poll aggressively.

## Escalation — what GPT CAN'T do (needs owner)

1. **Merge a PR** — every merge is human, always.
2. **Trigger a Railway deploy** — deploy node is a no-op by design; owner runs `railway up`.
3. **Abort a running orchestrator execution** — owner cancels the GitHub Actions run.
4. **Add or rotate an API key** — GitHub Secrets: owner uses the `Settings → Secrets` UI or `gh secret set`.
5. **Change repo permissions or branch protection** — owner-only.

If GPT determines any of the above is needed, output a `next_action` string in the review that says clearly what the owner must do. The orchestrator writes it to `CURRENT_STATUS.next_action`, and the human sees it in Telegram + on the state branch.

## Health probes for GPT

- Orchestrator up: `GET https://api.github.com/repos/muradovnb-cyber/isola-business-suite/actions/workflows/ai-orchestrator.yml` (200 with `state=active`)
- Runner up: `GET https://ai-runner-production-4c3d.up.railway.app/health` (200 `{ok:true, version:"0.2.0", model:"claude-sonnet-4-5-…"}`)
- Sync CI green: `GET .../actions/workflows/ai-orchestrator-sync.yml/runs?per_page=1`

If any of these look wrong, GPT should NOT submit new tasks — output an `escalate` message and wait.

## Version

This document version: **1.0** (2026-08-20). Any incompatible change to the JSON shapes or trigger mechanism will bump this to **2.0** and update this line.
