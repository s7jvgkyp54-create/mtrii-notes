#!/bin/sh
set -eu
WORKSPACE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$WORKSPACE_DIR"
# :8081 is QA-only — a revive must never inherit a stale built-output preview.
node scripts/preview.mjs stop || true
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
if command -v cmd.exe >/dev/null 2>&1; then
  MSYS2_ARG_CONV_EXCL="*" cmd.exe /d /s /c "npm run dev" >>"$WORKSPACE_DIR/.grok/app-startup.log" 2>&1 &
else
  npm run dev >>"$WORKSPACE_DIR/.grok/app-startup.log" 2>&1 &
fi
