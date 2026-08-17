# ISOLA AI Orchestrator — Operations

## Firing a task

```bash
curl -X POST https://nuriddinai.app.n8n.cloud/webhook/isola-task \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK-1234",
    "task":   "Human-readable description of what to build/fix"
  }'
```

n8n responds with the final report object (or the last state if the loop
hit `BLOCKED`). All state transitions are visible in n8n → Executions.

## Monitoring

| Where | What |
|---|---|
| n8n → Executions | Per-run trace: which node ran, inputs, outputs, timings, errors |
| GitHub → `agent/*` branches | Every run leaves a branch; every attempt leaves a commit |
| GitHub → PR list | Every task has exactly one PR that gets updated across retries |
| Telegram (`@isolashefbot`) | Green/yellow/red status pings |
| Railway → `ai-runner` service | Runtime logs (with secrets redacted) |
| `ai-runner` `/health` | Liveness, current inflight count, model version |

## Common operator actions

### Merge an APPROVED PR

Fully manual on purpose:

```bash
gh pr merge <PR-number> --repo muradovnb-cyber/isola-business-suite --squash
```

Prefer `--squash` so the branch's per-attempt commit history collapses into
one merge commit on `main`.

### Cancel a stuck run

Retry cap is 10 attempts. If a run is misbehaving before that:

1. n8n → Executions → find the run → **Stop**.
2. Close the PR on GitHub (do not merge).
3. Delete the branch: `gh api -X DELETE /repos/muradovnb-cyber/isola-business-suite/git/refs/heads/agent/<TASK_ID>`.

### Rotate a secret

Any of `RUNNER_TOKEN` / `GH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`:

1. Generate a new value in the source (n8n / Railway / GitHub / OpenAI / Anthropic).
2. Update it wherever it's stored (Railway env for the runner, n8n Credentials for OpenAI/GitHub/Telegram/HTTP Header Auth).
3. Restart the Railway `ai-runner` service (change any env var → auto-restart).
4. Revoke the old value.
5. Never write secrets into this repository or into a Telegram message.

### Deploy from an APPROVED PR (manual, guarded)

Even when the Reviewer returns `approved_for_deploy: true`, real deploys
are still gated. Preflight:

```bash
# 1. Backup precondition
ls -la /data/backups/db-*.json  # via `railway ssh` on isola-suite
# there must be at least one snapshot < N hours old

# 2. CI green + PR approved by a human
gh pr view <PR> --repo muradovnb-cyber/isola-business-suite

# 3. Merge (still manual)
gh pr merge <PR> --repo muradovnb-cyber/isola-business-suite --squash

# 4. Deploy
railway link --project a1d79dc0-0d4f-4323-b4d7-d4fd9755383f --environment production --service isola-suite
railway up --detach

# 5. Health check
curl -sf https://isola-suite-production.up.railway.app/api/health
```

If step 5 fails: **stop**, do not roll forward. Restore the previous
`db.json` from `/data/backups/` and redeploy the previous commit.

### Kill switch (emergency)

Immediately disables the whole loop:

- n8n → open the workflow → toggle **Active → Inactive**.
- Any in-flight run continues to completion but no new runs start.

To also block already-queued executions: rotate `RUNNER_TOKEN` in Railway.
The runner will 401 all subsequent n8n calls.

## Change management

- Prompts (`.github/ai/gpt-*-prompt.md`) are source of truth. Any change
  in n8n Variables must be reflected in these files by the same PR.
- Workflow structure (`n8n-workflow.json`) is source of truth. Import into
  n8n replaces nodes; **manual edits inside n8n Cloud must be exported back
  to this file** to avoid drift.
- ai-runner is versioned via `ai-runner/package.json` semver (`0.2.0`, etc).
- Breaking changes to the runner contract are shipped in a `runner/vN`
  branch with the workflow's `Claude Code Executor` HTTP Request node
  updated to point at the new URL, so old and new coexist for a window.

## Backups

- ISOLA app: automatic hourly + daily on Railway volume `/data/backups/`.
- ai-runner: no persistent state to back up; workspaces are throwaway.
- n8n workflow JSON: **committed in this repo** (`.github/ai/n8n-workflow.json`)
  — the file IS the backup.
- n8n Executions history: n8n Cloud retains it per plan; no additional
  action needed.
