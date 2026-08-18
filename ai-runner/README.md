# ai-runner

The **Claude Code** node in the ISOLA orchestration pipeline.
n8n calls this HTTP service; the service runs Claude Code CLI against a fresh
git checkout, commits, pushes, and opens/updates a PR.

## Contract

`POST /task`  · `Authorization: Bearer $RUNNER_TOKEN`

```json
{
  "taskId": "TASK-0042",
  "attempt": 1,
  "spec": {
    "task": "One-line title",
    "objective": "Longer prose describing what needs to happen.",
    "context": "Any background the model must know.",
    "files_to_inspect": ["server.js", "index.html"],
    "requirements": ["Rule 1", "Rule 2"],
    "acceptance_criteria": ["Criterion 1", "Criterion 2"],
    "tests_required": ["What tests to add/run"],
    "security_requirements": ["No secrets in code"],
    "do_not_change": ["public API shape", "existing tests"],
    "deployment_policy": "DEPLOY = forbidden without APPROVED_FOR_DEPLOY"
  },
  "feedback": {
    "problem": "(only on retry) what reviewer flagged",
    "why": "why it matters",
    "required_change": "what to change",
    "acceptance_criteria": "how the reviewer will re-check"
  }
}
```

Response:

```json
{
  "ok": true,
  "status": "READY_FOR_REVIEW",
  "runId": "…", "taskId": "…", "branch": "agent/TASK-0042",
  "commit": "abc1234…",
  "pr": {"number": 42, "url": "https://…"},
  "tests": {"ok": true, "output": "…"},
  "claudeReport": {"summary": "…", "files_touched": ["…"], "tests": "passed"}
}
```

`GET /health` → `{ ok: true, ts, model }` (no auth)

## Guarantees

- Never `git merge main`, never pushes to `main`.
- Never runs `railway up` / any deploy command.
- Refuses to commit if a trivial secret pattern (OpenAI/Anthropic/GitHub/AWS
  keys, RSA/OpenSSH private-key headers) is detected in the staged diff.
- Fresh `git reset --hard origin/main` before every task (no state leaks
  between runs).

## Required env vars

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code CLI backend |
| `GH_TOKEN` | PAT with `repo` + `workflow` scopes |
| `RUNNER_TOKEN` | Shared secret with n8n (`openssl rand -hex 32`) |

Optional: `REPO_URL`, `REPO_SLUG`, `CLAUDE_MODEL`, `MAX_TURNS`, `PORT`, `REPO_DIR`.

## Deploy to Railway

1. Create a **new** Railway service (do not mix with the ISOLA suite app).
2. Point it at this subdirectory (`ai-runner`).
3. Add a Volume mounted at `/workspace` (persistent git checkout).
4. Set the three required env vars above.
5. Deploy. `GET /health` must return `{ok:true}`.

## Local self-test

```bash
cd ai-runner
npm install
npm test
```

This validates the HTTP surface (auth + validation) without contacting
Anthropic or GitHub. End-to-end runs require live credentials and are done
by n8n or a manual `curl`.
