# ISOLA AI Orchestrator — one-time manual setup

**Updated for the actual state of `nuriddinai.app.n8n.cloud` (2026-08-17).**

n8n already has these credentials, so nothing to create for them:
- ✅ **OpenAI account** → used for both GPT Architect + GPT Reviewer
- ✅ **Anthropic account** (present but not used by this workflow — the runner talks to Anthropic directly)

What still requires physical owner action is listed below. Est. total time: **~10 minutes**.

---

## 1. Generate two secrets + one PAT

| # | Where | What | Store where |
|---|---|---|---|
| 1 | https://console.anthropic.com/settings/keys | **Reuse the existing "Anthropic account" key** you already put in n8n, or create a new one named `ISOLA_AI_RUNNER`. Copy the raw value. | Railway env `ANTHROPIC_API_KEY` on the **ai-runner** service (step 3) |
| 2 | https://github.com/settings/personal-access-tokens/new | Fine-grained PAT for `muradovnb-cyber/isola-business-suite`, scopes: **Contents R/W** + **Pull Requests R/W** + **Workflows R/W** | Railway env `GH_TOKEN` on ai-runner **and** paste into n8n → new GitHub credential (step 4) |
| 3 | terminal | `openssl rand -hex 32` — this is `RUNNER_TOKEN` (shared secret between n8n and ai-runner). Write it down once; you'll paste it into two places | Both: Railway env `RUNNER_TOKEN` (raw hex) **and** n8n → new HTTP Header Auth credential (step 4), header value `Bearer <that hex>` |

## 2. Provision `ai-runner` Railway service

Railway does not have a `service create` CLI, so this step is UI-only:

1. Railway dashboard → project **isola-suite** → **+ New Service** → **Deploy from GitHub repo** → pick `muradovnb-cyber/isola-business-suite`.
2. Service → Settings → **Root Directory** = `ai-runner`.
3. Service → Settings → **Volumes** → Add → mount path `/workspace`.
4. Service → Variables — paste the three from step 1:
   - `ANTHROPIC_API_KEY` = (secret #1)
   - `GH_TOKEN` = (PAT #2)
   - `RUNNER_TOKEN` = (hex #3, raw — NOT with `Bearer ` prefix)
   - `REPO_URL` = `https://github.com/muradovnb-cyber/isola-business-suite.git`
   - `REPO_SLUG` = `muradovnb-cyber/isola-business-suite`
5. Deploy. Wait for the health check to go green. Verify from your laptop:
   ```bash
   curl https://<ai-runner-service>.up.railway.app/health
   # → {"ok":true,"ts":...,"model":"claude-sonnet-4-5-...","version":"0.2.0",...}
   ```
6. Copy the Railway-generated public URL — you'll paste it into n8n Variables in step 5.

## 3. Import the workflow into n8n

1. Open https://nuriddinai.app.n8n.cloud
2. Open workflow **ISOLA — AI Development Orchestrator**.
3. Top-right menu → **Import from File** → pick `.github/ai/n8n-workflow.json` from this repo (raw file view on GitHub → Save As, or use the Import from URL option pointing to the raw file).
4. Confirm replacement of existing nodes.

## 4. Wire the two new n8n credentials

Only two credentials need to be **created** — the rest already exist.

| Credential to create | Type | Fields |
|---|---|---|
| `GitHub — ISOLA` | **GitHub API** | Access Token = (PAT #2 from step 1) |
| `AI Runner — Bearer` | **HTTP Header Auth** | Name = `Authorization`, Value = `Bearer <hex #3>` |

Then open the imported workflow and, for each node with a red "Credential missing" chip, pick the correct one from the dropdown:

| Node | Credential |
|---|---|
| **GPT Architect** | `OpenAI account` *(existing)* |
| **GPT Reviewer** | `OpenAI account` *(existing)* |
| **Fetch PR Diff** | `GitHub — ISOLA` *(new, from above)* |
| **Claude Code Executor (ai-runner)** | `AI Runner — Bearer` *(new, from above)* |
| **Telegram Notify (via HTTP)** | *(none — reads token from workflow variable, see step 5)* |

## 5. Set workflow variables

n8n → **Variables** → add:

| Variable | Value |
|---|---|
| `ai_runner_url` | Full URL from step 2.5 (no trailing slash) |
| `repo_slug` | `muradovnb-cyber/isola-business-suite` |
| `telegram_chat_id` | `63236216` |
| `telegram_bot_token` | Same token you already have in Railway for the ISOLA suite (`TELEGRAM_BOT_TOKEN`, starts with `8721938874:...`) |
| `gpt_architect_prompt` | Paste contents of `.github/ai/gpt-architect-prompt.md` |
| `gpt_reviewer_prompt` | Paste contents of `.github/ai/gpt-reviewer-prompt.md` |

## 6. Activate + smoke test

1. Toggle workflow **Active**.
2. Copy the **Production URL** of the Webhook trigger.
3. Fire TASK-0001:
   ```bash
   curl -X POST https://nuriddinai.app.n8n.cloud/webhook/isola-task \
     -H "Content-Type: application/json" \
     -d @tasks/TASK-0001.json
   ```
4. In n8n → Executions you should see: architect → runner → reviewer → APPROVED → PR appears on GitHub → Telegram 🟢.
5. Fire TASK-0002:
   ```bash
   curl -X POST https://nuriddinai.app.n8n.cloud/webhook/isola-task \
     -H "Content-Type: application/json" \
     -d @tasks/TASK-0002.json
   ```
   Expected: attempt 1 → CHANGES_REQUIRED → attempt 2 → APPROVED.

## 7. Deploy gate (leave alone unless you want auto-deploy)

The `Railway Deploy (guarded)` node is a deliberate no-op. To enable real
deploys later, replace its code with a Railway Deploy Trigger webhook call
— and only wire it to run when `approved_for_deploy === true`.

Until then, `APPROVED_FOR_DEPLOY` from the Reviewer is captured in the
final report but does not trigger anything automatically. This is by
design (rule #8 of the assignment).
