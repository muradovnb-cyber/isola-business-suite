#!/usr/bin/env python3
"""
ISOLA autonomous AI orchestrator — GitHub Actions edition.

One workflow run == one task, up to N attempts. All state persists to
GitHub (branch: ai/orchestrator-state) via files in
.github/ai/orchestrator/.

Env expected (from GitHub Actions Secrets + workflow):
  OPENAI_API_KEY          — OpenAI API key (mandatory)
  RUNNER_URL              — ai-runner URL (mandatory)
  RUNNER_TOKEN            — ai-runner bearer (mandatory)
  TELEGRAM_BOT_TOKEN      — optional (skip notify if missing)
  TELEGRAM_CHAT_ID        — optional
  GITHUB_TOKEN            — auto from Actions, used for state commits + PR diff
  GITHUB_REPOSITORY       — auto from Actions (owner/repo)
  TASK_ID                 — from workflow input
  TASK_TEXT               — from workflow input
  APPROVED_FOR_DEPLOY     — 'true' / 'false' (optional; default false)
  MAX_ATTEMPTS            — default 10

Exit codes:
  0 = DONE (approved or non-fatal terminal state)
  1 = FAILED (hard error, needs human)
  2 = BLOCKED (retry cap exceeded)
"""
from __future__ import annotations

import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# --------------------- config ---------------------
# In GitHub Actions, GITHUB_WORKSPACE is the checkout root; fall back to
# walking up from __file__ (parents[4] = repo root, since the script is
# at .github/ai/orchestrator/scripts/run_orchestrator.py — 4 levels deep).
REPO_ROOT = Path(os.environ.get("GITHUB_WORKSPACE") or Path(__file__).resolve().parents[4])
STATE_DIR = REPO_ROOT / ".github" / "ai" / "orchestrator"
EXEC_DIR = STATE_DIR / "executions"
REVIEW_DIR = STATE_DIR / "reviews"
REPORT_DIR = STATE_DIR / "reports"

OPENAI_API = "https://api.openai.com/v1/chat/completions"
ARCHITECT_MODEL = "gpt-4o-mini"
REVIEWER_MODEL = "gpt-4o"

MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "10"))

TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

# --------------------- utils ---------------------

def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def require_env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"FATAL: {name} not set")
    return v


def read_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def http_json(method: str, url: str, headers: dict | None = None, body: dict | None = None, timeout: int = 60) -> tuple[int, dict | str]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            code = r.status
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        code = e.code
        raw = e.read().decode(errors="replace") if e.fp else str(e)
    except Exception as e:
        return 0, f"transport error: {e}"
    try:
        return code, json.loads(raw)
    except json.JSONDecodeError:
        return code, raw


# --------------------- OpenAI helpers ---------------------

def _load_prompt(name: str) -> str:
    p = STATE_DIR / "prompts" / f"{name}.md"
    if not p.exists():
        sys.exit(f"FATAL: prompt not found: {p}")
    return p.read_text()


def call_openai_json(system_prompt: str, user_content: str, model: str, temperature: float, api_key: str) -> dict:
    code, body = http_json(
        "POST", OPENAI_API,
        headers={"Authorization": f"Bearer {api_key}"},
        body={
            "model": model,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=180,
    )
    if code != 200:
        raise RuntimeError(f"OpenAI {code}: {str(body)[:400]}")
    if not isinstance(body, dict) or "choices" not in body:
        raise RuntimeError(f"OpenAI unexpected response: {str(body)[:400]}")
    content = body["choices"][0]["message"]["content"]
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"OpenAI returned non-JSON: {e}\nContent: {content[:400]}")


def gpt_architect(task_id: str, task_text: str, attempt: int) -> dict:
    system = _load_prompt("architect")
    user = json.dumps({"taskId": task_id, "task_description": task_text, "attempt": attempt})
    key = require_env("OPENAI_API_KEY")
    return call_openai_json(system, user, ARCHITECT_MODEL, 0.2, key)


def gpt_reviewer(spec: dict, pr: dict, tests: dict, claude_report: dict, files: list[dict], prior_feedback: dict | None) -> dict:
    system = _load_prompt("reviewer")
    payload = {
        "spec": spec,
        "pr": pr,
        "tests": tests,
        "claudeReport": claude_report,
        "files": files,
    }
    if prior_feedback:
        payload["prior_feedback"] = prior_feedback
    user = json.dumps(payload)[:60000]  # cap
    key = require_env("OPENAI_API_KEY")
    return call_openai_json(system, user, REVIEWER_MODEL, 0.1, key)


# --------------------- ai-runner client ---------------------

def call_runner(task_id: str, run_id: str, attempt: int, spec: dict, feedback: dict | None) -> dict:
    url = require_env("RUNNER_URL").rstrip("/") + "/task"
    token = require_env("RUNNER_TOKEN")
    body = {"taskId": task_id, "runId": run_id, "attempt": attempt, "spec": spec}
    if feedback:
        body["feedback"] = feedback
    code, resp = http_json(
        "POST", url,
        headers={"Authorization": f"Bearer {token}"},
        body=body,
        timeout=1800,
    )
    if code == 0:
        raise RuntimeError(f"runner unreachable: {resp}")
    if not isinstance(resp, dict):
        raise RuntimeError(f"runner returned non-JSON, code={code}: {str(resp)[:400]}")
    return resp


# --------------------- GitHub API ---------------------

def gh_get(path: str) -> tuple[int, dict | list | str]:
    tok = require_env("GITHUB_TOKEN")
    repo = require_env("GITHUB_REPOSITORY")
    url = f"https://api.github.com{path.replace('<repo>', repo)}"
    return http_json("GET", url, headers={
        "Authorization": f"Bearer {tok}",
        "X-GitHub-Api-Version": "2022-11-28",
    })


def get_pr_files(pr_number: int) -> list[dict]:
    code, body = gh_get(f"/repos/<repo>/pulls/{pr_number}/files")
    if code != 200 or not isinstance(body, list):
        return []
    # Trim each patch to keep prompt size sane
    out = []
    for f in body:
        out.append({
            "filename": f.get("filename"),
            "status": f.get("status"),
            "additions": f.get("additions"),
            "deletions": f.get("deletions"),
            "patch": (f.get("patch") or "")[:4000],
        })
    return out


# --------------------- Telegram ---------------------

def telegram_notify(text: str):
    tok = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not tok or not chat:
        return
    try:
        http_json("POST", f"https://api.telegram.org/bot{tok}/sendMessage",
                  body={"chat_id": chat, "text": text[:3900], "disable_web_page_preview": True},
                  timeout=15)
    except Exception as e:
        print(f"[telegram] {e}", file=sys.stderr)


# --------------------- State I/O ---------------------

def update_status(**fields):
    """Overwrite CURRENT_STATUS.json with the passed keys merged in."""
    path = STATE_DIR / "CURRENT_STATUS.json"
    cur = read_json(path, {})
    cur.update(fields)
    cur["updated_at"] = utcnow()
    hist = cur.get("history") or []
    hist.append({"ts": cur["updated_at"], "status": cur.get("status"), "note": fields.get("next_action") or ""})
    cur["history"] = hist[-100:]
    write_json(path, cur)


def write_execution(task_id: str, run_id: str, attempt: int, record: dict):
    fname = f"{task_id}__{run_id}__attempt-{attempt}.json"
    write_json(EXEC_DIR / fname, record)


def write_review(task_id: str, run_id: str, attempt: int, record: dict):
    fname = f"{task_id}__{run_id}__attempt-{attempt}.json"
    write_json(REVIEW_DIR / fname, record)


def write_report_for_gpt(task_id: str, spec: dict | None, runner_res: dict | None, prior_review: dict | None):
    out = [
        f"# CURRENT_FOR_GPT.md",
        f"",
        f"_Autogenerated by orchestrator run at {utcnow()}_",
        f"",
        f"## Task",
        f"- **id:** `{task_id}`",
        f"- **text:** {(read_json(STATE_DIR / 'CURRENT_TASK.json', {}) or {}).get('task','(unknown)')}",
        f"",
        f"## Architect spec",
        f"```json\n{json.dumps(spec, ensure_ascii=False, indent=2) if spec else 'null'}\n```",
        f"",
        f"## Claude run result",
        f"```json\n{json.dumps(runner_res, ensure_ascii=False, indent=2) if runner_res else 'null'}\n```",
        f"",
    ]
    if prior_review:
        out += [
            f"## Prior review",
            f"```json\n{json.dumps(prior_review, ensure_ascii=False, indent=2)}\n```",
        ]
    write_json_or_text(REPORT_DIR / "CURRENT_FOR_GPT.md", "\n".join(out), text=True)


def write_json_or_text(path: Path, content, text=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if text:
        path.write_text(content)
    else:
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n")


# --------------------- Main orchestration ---------------------

def main():
    task_id = require_env("TASK_ID")
    task_text = require_env("TASK_TEXT")
    if not TASK_ID_RE.match(task_id):
        sys.exit("FATAL: TASK_ID does not match ^[A-Za-z0-9_-]{1,80}$")
    approved_for_deploy = os.environ.get("APPROVED_FOR_DEPLOY", "").lower() == "true"

    run_id = "run-" + secrets.token_hex(6)
    print(f"→ task={task_id} run={run_id} max_attempts={MAX_ATTEMPTS}")
    telegram_notify(f"🟡 TASK_STARTED {task_id} (run {run_id})")

    write_json(STATE_DIR / "CURRENT_TASK.json", {
        "task_id": task_id, "task": task_text, "description": task_text,
        "submitted_at": utcnow(), "submitted_by": "github-actions", "priority": "normal",
    })
    update_status(task_id=task_id, run_id=run_id, status="PLANNING",
                  attempt=0, max_attempts=MAX_ATTEMPTS,
                  branch=f"agent/{task_id}", commit=None, pr=None,
                  tests=None, review="PENDING", deployment="NOT_REQUESTED",
                  started_at=utcnow(),
                  next_action="architect")

    # -------- Architect (once per task; feedback carries fixes) --------
    print("→ GPT Architect")
    try:
        spec = gpt_architect(task_id, task_text, attempt=1)
    except Exception as e:
        msg = str(e)[:400]
        update_status(status="FAILED", error=msg, next_action="fix architect call")
        telegram_notify(f"🔴 BLOCKED at ARCHITECT: {msg}")
        sys.exit(f"architect: {msg}")
    print(f"→ spec.objective: {(spec.get('objective') or '')[:80]}")

    feedback = None
    prior_review = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        update_status(status="IMPLEMENTING", attempt=attempt, next_action=f"runner attempt {attempt}")
        telegram_notify(f"🟡 CLAUDE_STARTED {task_id} attempt {attempt}")
        print(f"→ ai-runner attempt {attempt}")
        try:
            runner_res = call_runner(task_id, run_id, attempt, spec, feedback)
        except Exception as e:
            msg = str(e)[:400]
            update_status(status="FAILED", error=msg, next_action="runner unreachable — check Railway service")
            telegram_notify(f"🔴 RUNNER_UNREACHABLE {task_id}: {msg}")
            sys.exit(f"runner: {msg}")

        runner_status = runner_res.get("status", "UNKNOWN")
        print(f"→ runner returned: {runner_status}")

        write_execution(task_id, run_id, attempt, {
            "task_id": task_id, "run_id": run_id, "attempt": attempt,
            "status": runner_status,
            "started_at": utcnow(),
            "finished_at": utcnow(),
            "duration_ms": runner_res.get("duration_ms"),
            "branch": runner_res.get("branch"),
            "commit": runner_res.get("commit"),
            "pr": runner_res.get("pr"),
            "spec": spec,
            "claude_status": runner_res.get("claude_status"),
            "claude_report": runner_res.get("claudeReport"),
            "tests": runner_res.get("tests"),
            "diff_stat": runner_res.get("diff_stat"),
            "review_run_id": None,
            "feedback": feedback,
            "error": runner_res.get("error"),
        })

        if runner_status in ("SECRET_LEAK", "FAILED", "PUSH_FAILED", "COMMIT_FAILED"):
            update_status(status="FAILED", error=f"runner {runner_status}", next_action="inspect executions/*.json")
            telegram_notify(f"🔴 RUNNER_{runner_status} {task_id}")
            sys.exit(f"runner status {runner_status}")

        if runner_status == "NO_CHANGES":
            update_status(status="BLOCKED", error="Claude produced no changes", next_action="revise task text")
            telegram_notify(f"🔴 NO_CHANGES {task_id}")
            sys.exit(2)

        pr = runner_res.get("pr") or {}
        pr_number = pr.get("number")
        pr_url = pr.get("url")

        update_status(status="WAITING_REVIEW",
                      branch=runner_res.get("branch"), commit=runner_res.get("commit"),
                      pr={"number": pr_number, "url": pr_url},
                      tests="PASS" if (runner_res.get("tests") or {}).get("ok") else ("SKIPPED" if (runner_res.get("tests") or {}).get("skipped") else "FAIL"),
                      review="PENDING", next_action="gpt-reviewer")

        # Reviewer
        files = get_pr_files(pr_number) if pr_number else []
        write_report_for_gpt(task_id, spec, runner_res, prior_review)
        try:
            review = gpt_reviewer(spec, pr, runner_res.get("tests") or {}, runner_res.get("claudeReport") or {}, files, prior_feedback=feedback)
        except Exception as e:
            msg = str(e)[:400]
            update_status(status="FAILED", error=msg, next_action="reviewer call failed")
            telegram_notify(f"🔴 REVIEWER_FAILED {task_id}: {msg}")
            sys.exit(f"reviewer: {msg}")

        decision = str(review.get("decision", "")).upper()
        write_review(task_id, run_id, attempt, {
            "task_id": task_id, "run_id": run_id, "attempt": attempt,
            "decision": decision if decision in ("APPROVED","CHANGES_REQUIRED","BLOCKED") else "BLOCKED",
            "approved_for_deploy": bool(review.get("approved_for_deploy")),
            "created_at": utcnow(),
            "reviewer": f"{REVIEWER_MODEL}@0.1",
            "summary": review.get("summary"),
            "feedback": review.get("feedback"),
        })
        prior_review = review

        if decision == "APPROVED":
            update_status(status="APPROVED", review="APPROVED", next_action=("deploy" if (approved_for_deploy and review.get("approved_for_deploy")) else "human merge"))
            telegram_notify(f"🟢 APPROVED {task_id} — PR {pr_url}")
            # deploy gate
            if approved_for_deploy and review.get("approved_for_deploy"):
                update_status(status="DEPLOYING", deployment="PENDING", next_action="railway deploy (guarded)")
                telegram_notify(f"⚠ APPROVED_FOR_DEPLOY {task_id} — deploy step is manual by design; enable it explicitly in workflow.")
            update_status(status="DONE", next_action="human merges PR when ready")
            telegram_notify(f"🟢 DONE {task_id}")
            print("→ APPROVED, exiting 0")
            return 0

        if decision == "CHANGES_REQUIRED":
            fb = review.get("feedback") or {}
            update_status(status="CHANGES_REQUIRED", review="CHANGES_REQUIRED", next_action=f"runner retry attempt {attempt+1}")
            telegram_notify(f"🟡 CHANGES_REQUIRED {task_id} attempt {attempt} → retry")
            feedback = fb
            print(f"→ CHANGES_REQUIRED: {(fb.get('problem') or '')[:120]}")
            continue

        # BLOCKED from reviewer explicitly
        update_status(status="BLOCKED", review="BLOCKED", error=review.get("summary"), next_action="human decision")
        telegram_notify(f"🔴 REVIEWER_BLOCKED {task_id}")
        sys.exit(2)

    # Retry cap
    update_status(status="BLOCKED", error="MAX_RETRIES_EXCEEDED", next_action="human decision")
    telegram_notify(f"🔴 MAX_RETRIES_EXCEEDED {task_id} after {MAX_ATTEMPTS} attempts")
    sys.exit(2)


if __name__ == "__main__":
    main()
