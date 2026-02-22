---
name: puppeteer-core
description: Minimal Chrome DevTools Protocol tools for browser automation and scraping. Use when you need to start Chrome, navigate pages, execute JavaScript, take screenshots, or interactively pick DOM elements.
source: ["https://docs.factory.ai/guides/skills/browser", "https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/"]
---

# Browser Tools

Minimal CDP tools for collaborative site exploration and scraping.

**IMPORTANT**: All scripts are located in `~/.local/share/llms/skills/puppeteer-core` and must be called with full paths.

## Start Chrome

```bash
~/.local/share/llms/skills/puppeteer-core/start.js              # Fresh profile
~/.local/share/llms/skills/puppeteer-core/start.js --profile    # Copy your profile (cookies, logins)
~/.local/share/llms/skills/puppeteer-core/start.js --profile 4  # Copy a specific profile (use ./start.js --list-profiles to see available profiles)
```

Starts Chrome on `:9222` with remote debugging enabled.

## Navigate

```bash
~/.local/share/llms/skills/puppeteer-core/nav.js https://example.com
~/.local/share/llms/skills/puppeteer-core/nav.js https://example.com --new
```

Navigate current tab or open a new tab.

## Evaluate JavaScript

npm install --prefix .factory/skills/browser puppeteer-core, then chmod +x .factory/skills/browser/*.js

```bash
~/.local/share/llms/skills/puppeteer-core/eval.js "document.title"
~/.local/share/llms/skills/puppeteer-core/eval.js "document.querySelectorAll('a').length"
```

Execute JavaScript in the active tab (async context).

## Screenshot

```bash
~/.local/share/llms/skills/puppeteer-core/screenshot.js
```

Screenshot current viewport, returns temp file path.

## Pick Elements

```bash
~/.local/share/llms/skills/puppeteer-core/pick.js "Click the submit button"
```

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish.

## Cookies

```bash
~/.local/share/llms/skills/puppeteer-core/cookies.js
~/.local/share/llms/skills/puppeteer-core/cookies.js https://example.com
```

List HTTP-only and regular cookies for the current tab (or a specific URL).

## Network Logging

```bash
~/.local/share/llms/skills/puppeteer-core/netlog.js --filter availability --ms 12000
~/.local/share/llms/skills/puppeteer-core/netlog.js --match opentable --click-availability --ms 15000
~/.local/share/llms/skills/puppeteer-core/netlog.js --match opentable --filter availability --out /tmp/availability.json --include-body
```

Record network requests/responses in the active tab (or a specific URL). Use `--filter` to only capture availability calls and `--out` to dump the results to a file.
