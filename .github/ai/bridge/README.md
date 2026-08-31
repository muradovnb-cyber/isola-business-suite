# `.github/ai/bridge/` — GPT ↔ ISOLA AI Orchestrator interface

This directory is the **single technical entry point** for any external LLM (typically ChatGPT acting as Architect or Reviewer) that wants to drive the ISOLA autonomous-development loop.

**No human relays messages.** GPT reads and writes via GitHub only.

| File | Purpose |
|---|---|
| [`GPT_HANDOFF.md`](GPT_HANDOFF.md) | **Canonical contract.** Every URL, every field, every state transition. Start here. |
| [`GPT_TASKS.md`](GPT_TASKS.md) | How GPT submits a task. |
| [`GPT_STATUS.md`](GPT_STATUS.md) | How GPT reads the live state. |
| [`GPT_REPORTS.md`](GPT_REPORTS.md) | How GPT reads per-task reports. |

## Data layout (single source of truth)

```
.github/ai/
├── bridge/                       ← this directory (docs, on main)
├── tasks/                        ← GPT submits TASK-*.json here (on main)
│   ├── SCHEMA.json
│   └── TASK-<id>.json
├── state/                        ← live status projection (on ai/orchestrator-state)
│   ├── schema.json
│   └── current.json              ← always latest
├── reports/                      ← per-task consolidated report (on ai/orchestrator-state)
│   ├── schema.json
│   └── TASK-<id>.json            ← final result of the run
└── orchestrator/                 ← internal detail (executions/, reviews/, prompts/)
    ├── CURRENT_STATUS.json       ← rich internal state (still written; state/current.json is the GPT projection)
    ├── executions/
    ├── reviews/
    └── prompts/
```

## Ground rules

1. **GitHub is the only channel.** GPT does not talk to Railway, n8n, or the owner directly.
2. **Task files are immutable submissions.** Runtime state lives on the `ai/orchestrator-state` branch, not on `main`.
3. **No secrets in any file under `.github/ai/`.** The sync CI grep-scans and rejects any push containing an OpenAI/Anthropic/GitHub/AWS/SSH secret shape.
4. **Merges and Railway deploys stay human-gated.** Everything else runs on autopilot.
