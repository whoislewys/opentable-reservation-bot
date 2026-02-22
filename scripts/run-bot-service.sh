#!/bin/bash
# Run OpenTable bot on a VPS: start Xvfb, then Chrome (start.js), then main.ts.
# Usage: ./scripts/run-bot-service.sh
# Or run under systemd with WorkingDirectory set to repo root.
set -e
cd "$(dirname "$0")/.."
export DISPLAY=:99
export XVFB_DISPLAY=99
Xvfb :99 -screen 0 1920x1080x24 -ac &
XVFB_PID=$!
sleep 2
node skills/puppeteer-core/start.js
sleep 2
exec pnpm exec tsx main.ts
