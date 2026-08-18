# n8n GitHub state-write snippet

n8n needs to push JSON files into the `ai/orchestrator-state` branch on every state transition. Below is a **reusable HTTP Request node config** that does an idempotent upsert of a file. Add one instance per write point in the workflow.

## Node type
`n8n-nodes-base.httpRequest` v4.2 with `githubApi` predefined credential (the `GitHub — ISOLA` credential you already created).

## Node parameters

```jsonc
{
  "method": "PUT",
  "url": "=https://api.github.com/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/orchestrator/CURRENT_STATUS.json?ref=ai/orchestrator-state",
  "authentication": "predefinedCredentialType",
  "nodeCredentialType": "githubApi",
  "sendHeaders": true,
  "headerParameters": {
    "parameters": [
      { "name": "Accept", "value": "application/vnd.github+json" },
      { "name": "X-GitHub-Api-Version", "value": "2022-11-28" }
    ]
  },
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ (() => { const body = { message: 'ai-orchestrator: ' + $json.run_id + ' ' + $json.status, branch: 'ai/orchestrator-state', content: Buffer.from(JSON.stringify($json, null, 2)).toString('base64') }; return JSON.stringify(body); })() }}"
}
```

## For files that need `sha` (updating existing files)

GitHub's PUT contents endpoint requires the current file's `sha` when updating (not when creating). Two-step pattern:

**Step 1 — Get current SHA (allow 404):**
```jsonc
{
  "method": "GET",
  "url": "=https://api.github.com/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/orchestrator/CURRENT_STATUS.json?ref=ai/orchestrator-state",
  "authentication": "predefinedCredentialType",
  "nodeCredentialType": "githubApi",
  "options": { "response": { "response": { "neverError": true } } }
}
```

**Step 2 — PUT with optional SHA:**
```jsonc
{
  "method": "PUT",
  "url": "=https://api.github.com/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/orchestrator/CURRENT_STATUS.json",
  "authentication": "predefinedCredentialType",
  "nodeCredentialType": "githubApi",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ (() => { const state = $items('Merge Runner Result', 0, 0)[0].json; const prev = $json.sha ? { sha: $json.sha } : {}; const body = { message: 'ai-orchestrator: ' + state.run_id + ' ' + state.status, branch: 'ai/orchestrator-state', content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'), ...prev }; return JSON.stringify(body); })() }}"
}
```

## Append-only files (executions, reviews)

These are new files each time (unique filename `<task_id>__<run_id>__attempt-<N>.json`), so no SHA lookup needed — always POST-new:

```jsonc
{
  "method": "PUT",
  "url": "=https://api.github.com/repos/muradovnb-cyber/isola-business-suite/contents/.github/ai/orchestrator/executions/{{ $json.task_id }}__{{ $json.run_id }}__attempt-{{ $json.attempt }}.json",
  "authentication": "predefinedCredentialType",
  "nodeCredentialType": "githubApi",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ (() => { const body = { message: 'ai-orchestrator: exec ' + $json.task_id + ' ' + $json.run_id + ' attempt ' + $json.attempt, branch: 'ai/orchestrator-state', content: Buffer.from(JSON.stringify($json, null, 2)).toString('base64') }; return JSON.stringify(body); })() }}"
}
```

## Where each write goes in the workflow

| After node | File(s) written |
|---|---|
| Task State (init) | `CURRENT_TASK.json`, `CURRENT_STATUS.json` (status: PLANNING) |
| Merge Runner Result | `executions/<t>__<r>__attempt-<n>.json` + overwrite `CURRENT_STATUS.json` (status: WAITING_REVIEW / FAILED) |
| Merge Review | `reviews/<t>__<r>__attempt-<n>.json` + overwrite `CURRENT_STATUS.json` (status: APPROVED / CHANGES_REQUIRED) |
| Bump Attempt → Loop | overwrite `CURRENT_STATUS.json` (attempt+1, status: IMPLEMENTING) |
| Blocked (max retries) | overwrite `CURRENT_STATUS.json` (status: BLOCKED) |
| Final Report | overwrite `CURRENT_STATUS.json` (status: DONE) |

## Ensure the branch exists

The first write to `ai/orchestrator-state` needs the branch to exist. Create once from your terminal:

```bash
git fetch origin main
git branch ai/orchestrator-state origin/main
git push origin ai/orchestrator-state
```

After that, all state pushes land on this branch and never touch `main`.
