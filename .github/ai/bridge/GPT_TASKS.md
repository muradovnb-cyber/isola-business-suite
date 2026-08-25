# GPT_TASKS.md — how GPT submits a task

> Companion to [`GPT_HANDOFF.md`](GPT_HANDOFF.md). This file focuses only on the **submit** action.

## The channel

Task submission is a **git commit on `main`** that adds a JSON file under `.github/ai/tasks/`. Two accepted delivery mechanisms:

| Mechanism | When |
|---|---|
| **PR merge** (recommended) | Default. Preserves review trail. |
| **Direct push to `main`** | Only when the owner has authorised GPT with push access — never assume this. |

On merge, `.github/workflows/ai-task-dispatch.yml` sees the new file, validates it against `.github/ai/tasks/SCHEMA.json`, verifies `id == filename`, and invokes `ai-orchestrator.yml` for every file with `status: "QUEUED"`.

## Submission recipe

1. **Pick an ID.** Look at existing files with `GET {api}/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/tasks?ref=main`. Pick the next free `TASK-NNNN`. If it feels natural, use a descriptive suffix (`TASK-0042-audit-cache`).
2. **Write the payload** per [`SCHEMA.json`](../tasks/SCHEMA.json). Keep it small — one goal per task.
3. **Ensure `id` matches filename** (dispatcher enforces this).
4. **Open a PR** targeting `main` that adds just this file. Do not bundle other changes.
5. **Wait for `ai-orchestrator-sync.yml` (CI) to pass** — this validates schema and scans for secrets. If red, fix and push; if green, request owner merge (or wait for auto-merge if configured for GPT tasks).
6. **After merge, poll `state/current.json`** (§3 of the handoff). Status will transition to `RUNNING` within ~15 seconds.

## Example — minimal valid task

```json
{
  "id": "TASK-0100",
  "status": "QUEUED",
  "priority": "normal",
  "source": "gpt",
  "created_at": "2026-08-25T09:00:00Z",
  "created_by": "chatgpt-session-xyz",
  "objective": "Add a /version endpoint to server.js returning package.json.version as JSON.",
  "context": "Downstream health checks want a lightweight version probe without touching /health.",
  "files_to_inspect": ["server.js", "package.json"],
  "requirements": [
    "GET /version returns 200 with body {\"version\":\"<x.y.z>\"}",
    "No new dependencies",
    "Must not require auth"
  ],
  "acceptance_criteria": [
    "curl -s http://localhost:3000/version | jq -e '.version' returns a non-empty string",
    "Endpoint mounted before any auth middleware",
    "Content-Type is application/json"
  ],
  "tests_required": ["node tests/version.test.js exits 0"],
  "security_requirements": ["Response body contains only the version string, no environment data"],
  "do_not_change": ["ai-runner/**", ".github/**", "index.html", "hr.html"],
  "deployment_policy": "NO_DEPLOY",
  "max_attempts": 5
}
```

## Cancelling a task before dispatch

Between the time the PR merges and the dispatcher fires (~10-30s), and thereafter until the workflow starts running, cancellation is possible by editing the task file's `.status` from `"QUEUED"` to `"CANCELLED"` in another PR. The dispatcher re-reads the file at run time; a CANCELLED file is skipped.

After the orchestrator has already picked the task up (i.e. `state/current.json.status != IDLE` and `current_task == "TASK-XXXX"`), cancellation requires the owner to abort the GitHub Actions run.

## Anti-patterns (rejected)

- ❌ Bundling multiple task files in one PR (validator is per-file, but reviewers can't reason about the batch).
- ❌ Editing the task file after `status` has left `QUEUED`. Task files are immutable submissions; runtime state lives on `ai/orchestrator-state`.
- ❌ Setting `deployment_policy: "APPROVED_FOR_DEPLOY_MANUAL"` for anything except an explicit deploy task.
- ❌ Putting URLs to third-party issue trackers or secret-shaped strings in `context`. The grep-based secret scan is unforgiving.
- ❌ Naming a task after a person or a private detail. IDs and content are public via the repo.
