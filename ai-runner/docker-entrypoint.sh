#!/bin/sh
# Ensure the persistent volume exists and is writable by the process.
# Runs as root — the ai-runner is a single-tenant internal tool behind a
# bearer token; not exposed to arbitrary users.
set -e
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/workspace}"
mkdir -p "$WORKSPACE_ROOT/runs" "$WORKSPACE_ROOT/idempotency"
exec tini -- node server.js
