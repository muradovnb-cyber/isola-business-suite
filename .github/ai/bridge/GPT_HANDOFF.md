# GPT_HANDOFF.md — machine-readable contract (v2.0)

> This document is the **contract** between an external LLM (typically ChatGPT
> acting as Architect/Reviewer) and the ISOLA autonomous orchestrator.
> It replaces the previous message-relay pattern where the owner copy-pasted
> results between systems.
>
> If any URL, path, or JSON field here disagrees with reality, **reality
> wins** — file a task to fix this document.

## 0. Identifiers

| Thing | Value |
|---|---|
| GitHub repo | `muradovnb-cyber/isola-business-suite` |
| Default branch | `main` |
| State branch (runtime, machine-written) | `ai/orchestrator-state` |
| GitHub REST API base | `https://api.github.com` |
| Raw content base (state branch) | `https://raw.githubusercontent.com/muradovnb-cyber/isola-business-suite/ai/orchestrator-state/` |
| Raw content base (main) | `https://raw.githubusercontent.com/muradovnb-cyber/isola-business-suite/main/` |
| Runner health | `https://ai-runner-production-4c3d.up.railway.app/health` |
| Production ISOLA (do not touch without approval) | `https://isola-suite-production.up.railway.app/` |
| Handoff contract version | **2.0** |

## 1. Interface at a glance

| GPT wants to… | Do this |
|---|---|
| **Submit a new task** | Open a PR against `main` that adds `.github/ai/tasks/TASK-<slug>.json` with `status: "QUEUED"`. On merge, the dispatcher fires the orchestrator automatically. |
| **Read the live state** | `GET {raw-state}/.github/ai/state/current.json` |
| **Read a per-task final report** | `GET {raw-state}/.github/ai/reports/TASK-<id>.json` |
| **Read attempt-by-attempt history** | `GET {api}/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/orchestrator/executions?ref=ai/orchestrator-state` |
| **Read a reviewer decision** | `GET {raw-state}/.github/ai/orchestrator/reviews/<task_id>__<run_id>__attempt-<N>.json` |
| **Find the PR the orchestrator opened** | `GET {api}/repos/muradovnb-cyber/isola-business-suite/pulls?head=muradovnb-cyber:agent/<task_id>` |
| **Get the diff for that PR** | `GET {api}/repos/…/pulls/<number>/files` (or `.diff` accept header on the PR URL) |
| **Cancel a queued (not yet dispatched) task** | Open a PR that changes the task file's `.status` from `"QUEUED"` to `"CANCELLED"`. |
| **Abort a running task** | Not GPT-doable — needs the owner. See §7. |

## 2. Submitting a task — canonical payload

Filename: `.github/ai/tasks/TASK-<slug>.json`
Slug pattern: `[A-Za-z0-9_-]{1,72}`. **`.id` must equal the filename stem** (`TASK-0042.json` → `"id": "TASK-0042"`); the dispatcher refuses mismatches.

```json
{
  "id": "TASK-0042",
  "status": "QUEUED",
  "priority": "normal",
  "source": "gpt",
  "created_at": "2026-08-20T12:34:56Z",
  "created_by": "chatgpt-session-abc123",
  "objective": "Short one-line goal (5–500 chars)",
  "context": "Longer background the executor should know",
  "files_to_inspect":     ["path/one.js", "path/two.md"],
  "requirements":         ["Rule 1", "Rule 2"],
  "acceptance_criteria":  ["Verifiable predicate 1", "Verifiable predicate 2"],
  "tests_required":       ["node tests/newthing.test.js exits 0"],
  "security_requirements":["no plaintext secrets in commit"],
  "do_not_change":        ["server.js", "index.html", "ai-runner/**", ".github/**"],
  "deployment_policy":    "NO_DEPLOY",
  "max_attempts": 10
}
```

Full schema (CI-enforced): [`.github/ai/tasks/SCHEMA.json`](../tasks/SCHEMA.json).

### Rules GPT must honour on every submission

1. **`id` must equal filename** (see above).
2. **`status` is always `"QUEUED"`** for a new submission. The only other legal value is `"CANCELLED"`.
3. **Never include secrets.** The sync CI grep-scans and rejects any push whose diff contains: `sk-…`, `sk-ant-…`, `gh[pousr]_…`, `github_pat_…`, `AKIA…`, RSA/OpenSSH private-key blocks, `xox[baprs]-…`. Rejected push = task never enters the queue.
4. **Cite files that exist.** Do not invent paths — the Reviewer penalises the run.
5. **Always populate `do_not_change`.** At minimum: `["ai-runner/**", ".github/**"]`.
6. **Default `deployment_policy: "NO_DEPLOY"`.** Only override for tasks that genuinely require a Railway deploy — even then the deploy step is human-gated.
7. **Acceptance criteria must be checkable** by (a) inspecting the diff, (b) running a test, or (c) hitting an endpoint. "Looks good" is not an acceptance criterion.

## 3. Reading the live state

### 3.1 The GPT projection — `.github/ai/state/current.json` (recommended)

Written on `ai/orchestrator-state` on every state transition. Overwritten in place; there is only one file.

```jsonc
{
  "status":       "APPROVED",              // IDLE | QUEUED | RUNNING | REVIEW | FIXING | PASSED | BLOCKED | FAILED
  "current_task": "TASK-0042",             // null when IDLE
  "stage":        "reviewer",              // planning | implementing | testing | reviewer | done | null
  "agent":        "gpt-reviewer",          // gpt-architect | claude-runner | gpt-reviewer | null
  "attempt":      2,
  "last_commit":  "3c8ebfd…",              // sha of the latest agent commit for this task
  "last_pr":      { "number": 42, "url": "https://github.com/muradovnb-cyber/isola-business-suite/pull/42" },
  "last_review":  { "decision": "APPROVED", "attempt": 2, "url": "…/reviews/TASK-0042__run-abc__attempt-2.json" },
  "blockers":     [],                      // free-form strings describing what still needs a human
  "next_action":  "human merges PR when ready",
  "updated_at":   "2026-08-20T12:37:00Z"
}
```

Schema: [`.github/ai/state/schema.json`](../state/schema.json).

The 8 legal `status` values map cleanly onto the state machine in §4.

### 3.2 The rich internal state — `.github/ai/orchestrator/CURRENT_STATUS.json`

Same purpose, more fields (per-attempt review/deploy sub-status, error strings, sliding-window history). GPT can read it when the projection is not detailed enough. Schema: [`.github/ai/orchestrator/schemas/status.schema.json`](../orchestrator/schemas/status.schema.json).

### 3.3 Blockers list

`state/current.json.blockers` is an **array of short strings** — each one describing something that presently blocks progress and cannot be resolved by another automated attempt. Examples: `"OpenAI 429 for 6h — key may be throttled"`, `"PR #42 waiting for human merge"`.

An empty array (`[]`) means nothing is blocking. GPT should read this **before** submitting a new task.

## 4. State machine

```
                    QUEUED  ─────► RUNNING ─────► REVIEW ─────► PASSED   (terminal, exit 0)
                       │              │             │
                       │              │             └──► FIXING ──► RUNNING (retry, ≤ max_attempts)
                       │              │
                       │              └────────────► FAILED   (terminal, exit 1)
                       │
                       └── CANCELLED (never entered pipeline)
                                                    │
                                                    └───► BLOCKED (terminal, exit 2)
                                                          — retry cap OR reviewer BLOCKED
                                                          — needs a human decision

Idle case: status = IDLE, current_task = null.
```

## 5. Per-task consolidated report

Written once, at the end of the run, to
`{raw-state}/.github/ai/reports/TASK-<id>.json`. Schema: [`.github/ai/reports/schema.json`](../reports/schema.json). Shape:

```json
{
  "task_id":  "TASK-0042",
  "run_id":   "run-abc123",
  "status":   "PASSED",
  "attempts": 2,
  "commit":   "e4a1c8f…",
  "pr":       { "number": 42, "url": "https://github.com/muradovnb-cyber/isola-business-suite/pull/42" },
  "tests":    { "ok": true, "skipped": false, "framework": "node-assert", "summary": "1 passed" },
  "review":   { "decision": "APPROVED", "attempt": 2, "approved_for_deploy": false },
  "changes":  ["scripts/foo.sh", "tests/foo.test.js"],
  "remaining_issues": [],
  "next_action": "human merges PR #42",
  "started_at":  "2026-08-20T12:34:00Z",
  "finished_at": "2026-08-20T12:37:00Z"
}
```

If GPT wants attempt-by-attempt granularity, it walks
`.github/ai/orchestrator/executions/<task_id>__*.json` and
`.github/ai/orchestrator/reviews/<task_id>__*.json`.

## 6. GPT as Architect / Reviewer inside the loop

When the orchestrator runs, it calls OpenAI `/v1/chat/completions` directly (JSON mode):

- **Architect** prompt: [`.github/ai/orchestrator/prompts/architect.md`](../orchestrator/prompts/architect.md) — receives the task file's `objective` + `context`, returns a strict-JSON spec.
- **Reviewer** prompt: [`.github/ai/orchestrator/prompts/reviewer.md`](../orchestrator/prompts/reviewer.md) — receives spec + PR diff + Claude report + tests, returns `{decision, approved_for_deploy?, feedback?}`.

Both prompts are versioned in git; any change to them is a PR.

**GPT never edits application code inside the loop.** Only Claude Code (running in `ai-runner` on Railway) writes files. GPT plans and reviews.

## 7. Escalation — what GPT cannot do (owner only)

| Action | Why owner-only |
|---|---|
| Merge a PR | Rule: every merge is human, always. |
| Trigger a Railway production deploy | The deploy step is a no-op by design; owner runs `railway up`. |
| Abort a running orchestrator execution | Cancels the GitHub Actions run — UI-only. |
| Add or rotate an API key (OpenAI, Anthropic, RUNNER_TOKEN, TELEGRAM_*, RAILWAY_*) | GitHub Secrets: owner uses `Settings → Secrets` or `gh secret set`. |
| Change repo permissions or branch protection | Owner-only. |
| Force-push to `ai/orchestrator-state` (history is append-only) | Owner-only, and normally never. |

If GPT determines any of the above is needed, it must:

1. Add a concise entry to the reviewer output's `feedback.escalation` field, or
2. If reviewing a submitted task pre-dispatch: mention it in the task's `context`.

The orchestrator writes it to `state/current.json.blockers` and Telegram-notifies the owner.

## 8. Idempotency guarantees

- **Per-push-once dispatch.** GitHub's push event includes only the diff, so a task file that hasn't changed is not re-dispatched.
- **Per-attempt unique `run_id`.** The orchestrator generates `<run>-a<N>` per attempt so ai-runner's per-`runId` idempotency cache doesn't return stale results.
- **Re-triggering a completed task.** Editing an existing task file's non-`status` fields on `main` re-fires the dispatcher; a fresh `run_id` is generated and prior `executions/*.json` files stay untouched.

## 9. Termination

The orchestrator run exits and stops writing state when it hits one of:

| Terminal | Exit | Projection `status` | What GPT should do |
|---|---|---|---|
| Success | 0 | `PASSED` | Read the report, submit next task if appropriate. |
| Retry cap | 2 | `BLOCKED` | Read `blockers[]` + `next_action`. Do not retry the same task without changing it. |
| Runtime error | 1 | `FAILED` | Read `blockers[]`. Safe to resubmit if root cause is transient (OpenAI 5xx, network). |

A Telegram notification fires on every terminal transition; GPT does not need to poll aggressively.

## 10. Health probes

| Check | URL | Expected |
|---|---|---|
| Orchestrator workflow enabled | `{api}/repos/muradovnb-cyber/isola-business-suite/actions/workflows/ai-orchestrator.yml` | HTTP 200, `state=active` |
| Dispatcher workflow enabled | `{api}/repos/…/actions/workflows/ai-task-dispatch.yml` | HTTP 200, `state=active` |
| Sync CI green | `{api}/repos/…/actions/workflows/ai-orchestrator-sync.yml/runs?per_page=1` | latest `conclusion=success` |
| Runner reachable | `https://ai-runner-production-4c3d.up.railway.app/health` | HTTP 200, `{ok:true, version, model}` |
| State projection fresh | `{raw-state}/.github/ai/state/current.json` `updated_at` | within last 24h if `status != IDLE`; any age otherwise |

If any of the above look wrong, GPT should **not submit new tasks** — instead
add an `escalation` note to the next reviewer output and wait for the owner.

## 11. Versioning of this document

This document version: **2.0** (2026-08-25).

Any incompatible change to the JSON shapes, paths, or trigger mechanism bumps this to **3.0** and updates this line. Additive-only changes (new optional fields) bump to **2.x**.

The old v1.0 stub at `.github/ai/orchestrator/GPT_HANDOFF.md` now redirects here.
