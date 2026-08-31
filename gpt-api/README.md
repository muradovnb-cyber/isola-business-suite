# gpt-orchestrator-api

HTTPS bridge letting GPT create ISOLA orchestrator tasks and read pipeline
state via a stable REST API, without any owner-in-the-loop message relay.

Runs as an isolated Railway service under the existing `isola-suite` project
(sibling to `ai-runner`). **Never** touches production ISOLA. **Never** writes
directly to `main` (uses `gpt/<task_id>` branches + PR + `repository_dispatch`).

## Endpoints

| Method | Path                        | Purpose                                 | Rate |
|--------|-----------------------------|-----------------------------------------|------|
| GET    | `/health`                   | Liveness, unauth                         | –    |
| GET    | `/api/gpt/status`           | Live state (bridge v2.0 projection)     | 60/m |
| GET    | `/api/gpt/tasks`            | List task files on `main`               | 60/m |
| GET    | `/api/gpt/tasks/:id`        | Read one task + attempt indexes         | 60/m |
| GET    | `/api/gpt/reports/:id`      | Read consolidated per-task final report | 60/m |
| POST   | `/api/gpt/tasks`            | Create task + open PR + fire orch       | 10/m |
| POST   | `/api/gpt/tasks/:id/run`    | Re-fire orchestrator                    | 10/m |

Auth: `Authorization: Bearer <GPT_ORCHESTRATOR_TOKEN>`.

## Environment

| Var                       | Required | Purpose                                                        |
|---------------------------|----------|----------------------------------------------------------------|
| `GPT_ORCHESTRATOR_TOKEN`  | yes      | Bearer token for `/api/gpt/*`. Random 32-byte hex.             |
| `GITHUB_PAT`              | yes      | Fine-grained PAT scoped to this repo: Contents RW, Pull requests RW, Actions RW, Metadata R. |
| `GITHUB_REPO`             | no       | Default `muradovnb-cyber/isola-business-suite`.                |
| `STATE_BRANCH`            | no       | Default `ai/orchestrator-state`.                               |
| `MAX_ATTEMPTS_CAP`        | no       | Hard cap on `max_attempts` (default 10).                       |
| `PORT`                    | no       | Railway sets this.                                             |

**No secret ever appears in git.**

## Server-side safety overrides

- `status` on every incoming task is forced to `QUEUED`.
- `deployment_policy` on every incoming task is forced to `NO_DEPLOY`.
- `max_attempts` is capped at `MAX_ATTEMPTS_CAP`.
- Secret-shape scan on the entire serialized payload — refuses with 400 on hit.

## Deploy

```bash
cd gpt-api
railway link --project isola-suite
railway up --service gpt-api
```

See `.github/ai/bridge/GPT_HANDOFF.md` for the full contract.
