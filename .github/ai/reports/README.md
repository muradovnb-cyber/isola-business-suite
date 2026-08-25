# `.github/ai/reports/`

Per-task consolidated reports written by the orchestrator at the end of every
run. One file per task, overwritten on re-runs.

**On `main`:** this directory is empty except for `README.md` + `schema.json`.

**On `ai/orchestrator-state`:** filled with `TASK-<id>.json` files.

Read shape and read recipes: [`../bridge/GPT_REPORTS.md`](../bridge/GPT_REPORTS.md).
Schema: [`schema.json`](schema.json).
