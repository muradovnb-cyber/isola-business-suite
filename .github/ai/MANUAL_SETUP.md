# ISOLA AI Orchestrator — one-time manual setup

Everything code-side is in this PR. Below is the physical work only the account
owner can do (n8n Cloud UI, Anthropic Console, OpenAI Platform, Railway UI).
Estimated total time: **~15 minutes**.

## 1. Generate the three API keys and one shared secret

| # | Where | What | Store where |
|---|---|---|---|
| 1 | https://console.anthropic.com/settings/keys | Create key `ISOLA_AI_RUNNER` | Railway env `ANTHROPIC_API_KEY` on the **ai-runner** service |
| 2 | https://platform.openai.com/api-keys | Create key `ISOLA_ORCHESTRATOR` | n8n Cloud → Credentials → OpenAI |
| 3 | https://github.com/settings/personal-access-tokens/new | Fine-grained PAT for `muradovnb-cyber/isola-business-suite`, scopes: **Contents R/W** + **Pull Requests R/W** + **Workflows R/W** | Railway env `GH_TOKEN` on ai-runner + n8n Cloud → Credentials → GitHub |
| 4 | terminal | `openssl rand -hex 32` | Both: Railway env `RUNNER_TOKEN` **and** n8n Cloud → Credentials → HTTP Header Auth (header name `Authorization`, value `Bearer <that hex>`) |

## 2. Deploy ai-runner to Railway

1. Railway dashboard → project **isola-suite** → **+ New Service** → **Deploy from GitHub repo** → pick `muradovnb-cyber/isola-business-suite`.
2. Service → Settings → **Root Directory** = `ai-runner`.
3. Service → Settings → **Volumes** → Add → mount path `/workspace`.
4. Service → Variables:
   - `ANTHROPIC_API_KEY` = (key #1)
   - `GH_TOKEN` = (key #3)
   - `RUNNER_TOKEN` = (secret #4, raw hex — NOT with `Bearer ` prefix)
   - `REPO_URL` = `https://github.com/muradovnb-cyber/isola-business-suite.git`
   - `REPO_SLUG` = `muradovnb-cyber/isola-business-suite`
5. Deploy. Wait for green. Verify:
   ```bash
   curl https://<ai-runner-service>.up.railway.app/health
   # → {"ok":true,"ts":...,"model":"claude-sonnet-4-5-..."}
   ```

## 3. Import the n8n workflow

1. Open https://nuriddinai.app.n8n.cloud
2. Open workflow **ISOLA — AI Development Orchestrator**.
3. Menu (top right) → **Import from File** → select `.github/ai/n8n-workflow.json` from this repo (or paste JSON).
4. Confirm replacement of existing nodes.

## 4. Wire n8n credentials

In n8n Cloud → **Credentials** → **+ Add** three items:

| Credential name | Type | Fields |
|---|---|---|
| `OpenAI — ISOLA` | OpenAI API | API Key = (key #2) |
| `GitHub — ISOLA` | GitHub API | Access Token = (key #3) |
| `Telegram — ISOLA` | Telegram | Access Token = (existing `TELEGRAM_BOT_TOKEN`, same one the suite already uses) |
| `AI Runner — Bearer` | HTTP Header Auth | Name = `Authorization`, Value = `Bearer <secret #4>` |

Then open the imported workflow, click each node with a red "Credential missing" chip and pick the right credential from the dropdown.

## 5. Set workflow variables

n8n → **Variables** (Settings → Variables in Cloud) → add:

| Variable | Value |
|---|---|
| `ai_runner_url` | `https://<ai-runner-service>.up.railway.app` (no trailing slash) |
| `repo_slug` | `muradovnb-cyber/isola-business-suite` |
| `telegram_chat_id` | `63236216` (same as ISOLA suite) |
| `gpt_architect_prompt` | Paste contents of `.github/ai/gpt-architect-prompt.md` |
| `gpt_reviewer_prompt` | Paste contents of `.github/ai/gpt-reviewer-prompt.md` |

## 6. Activate + smoke test

1. Toggle workflow **Active**.
2. Copy the **Production URL** of the Webhook trigger (top of the workflow).
3. Kick TASK-0001:
   ```bash
   curl -X POST https://nuriddinai.app.n8n.cloud/webhook/isola-task \
     -H "Content-Type: application/json" \
     -d @tasks/TASK-0001.json
   ```
4. Watch n8n → Executions. You should see: architect → runner → reviewer → APPROVED → PR created on GitHub.
5. Kick TASK-0002 (intentional bug scenario) the same way. You should see: architect → runner → reviewer CHANGES_REQUIRED → runner (attempt 2) → reviewer APPROVED.

## 7. Deploy gate

The `Railway Deploy (guarded)` node is intentionally a no-op placeholder. To
enable real deploys later, replace its code with a Railway Deploy Trigger
webhook call — and only wire it to run when `approved_for_deploy === true`.

Until then, `APPROVED_FOR_DEPLOY` from the Reviewer is captured in the final
report but does not trigger anything automatically. This is by design (rule #8
of the task).
