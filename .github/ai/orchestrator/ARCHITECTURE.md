# Orchestrator Architecture — GitHub-centric (v2.0)

```
   TASK FILE MERGED TO main          state on ai/orchestrator-state
   ────────────────────────          ────────────────────────────────
                                     .github/ai/state/current.json      ← GPT reads
   .github/ai/tasks/TASK-XXX.json    .github/ai/reports/TASK-XXX.json   ← GPT reads
             │                                       ▲
             │  ai-task-dispatch.yml                 │
             ▼                                       │
   ┌───────────────────────┐                         │
   │   ai-orchestrator.yml │  ← GitHub Actions       │
   │  (Python script)      │                         │
   └───────┬───────────────┘                         │
           │                                         │
           │  OpenAI /v1/chat/completions            │
           ├──► GPT Architect ────────────► spec ────┤
           │                                         │
           │  HTTP POST /jobs                        │
           ├──► ai-runner (Railway) ──► Claude CLI ──┤
           │                                         │
           │  OpenAI /v1/chat/completions            │
           └──► GPT Reviewer ────────► decision ─────┤
                                                     │
                                       loop / done ──┘
```

## Pieces

| Component | Where | Purpose |
|---|---|---|
| Task queue | `.github/ai/tasks/TASK-*.json` on `main` | GPT (or a human) submits work here. |
| Dispatcher | `.github/workflows/ai-task-dispatch.yml` | Fires on push to `main` touching `tasks/`; kicks off orchestrator per QUEUED file. |
| Orchestrator | `.github/workflows/ai-orchestrator.yml` + `scripts/run_orchestrator.py` | One workflow run = one task, up to N attempts. Calls Architect → Runner → Reviewer in a loop. |
| Runner | `ai-runner-production-4c3d.up.railway.app` (Node.js + Claude Code CLI in Docker) | Executes the spec in an isolated workspace, pushes an `agent/<task_id>` branch, opens a PR. |
| Live state (GPT-facing) | `.github/ai/state/current.json` on `ai/orchestrator-state` | Simplified projection — see [`../bridge/GPT_HANDOFF.md`](../bridge/GPT_HANDOFF.md). |
| Live state (internal) | `.github/ai/orchestrator/CURRENT_STATUS.json` on `ai/orchestrator-state` | Rich schema with per-attempt history. |
| Per-attempt history | `.github/ai/orchestrator/executions/`, `reviews/` on `ai/orchestrator-state` | Append-only audit trail. |
| Per-task final report | `.github/ai/reports/TASK-*.json` on `ai/orchestrator-state` | One consolidated summary per task, overwritten on re-run. |
| CI validation | `.github/workflows/ai-orchestrator-sync.yml` | JSON schema + secret scan on every push to `.github/ai/**`. |

## Runtime

GitHub Actions is **the** runtime. There is no n8n path any more — the historic `workflow.json` and `N8N_GITHUB_WRITE_SNIPPET.md` were removed in the bridge-v2.0 PR. The `ai/n8n-orchestrator` branch and its PR are historical artefacts and should be closed without merge.

## Deployment gates (human-only)

1. Merging any PR that the orchestrator opens (`agent/*` branches).
2. Deploying ISOLA to Railway production (`railway up` or the Railway UI).
3. Rotating any secret (`OPENAI_API_KEY`, `RUNNER_TOKEN`, `TELEGRAM_*`, etc).

Everything else runs on autopilot.
