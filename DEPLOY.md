# Deploying on a VPS

OpenTable blocks **headless** browsers and **zero-size** (or very small) windows. To run reliably on a VPS you need a **real** Chrome/Chromium with a **real window size**, driven by a virtual display.

## How it works

- **No `--headless`**: Chrome runs as a normal (non-headless) process.
- **Xvfb** (X virtual framebuffer): On Linux without a real display, `start.js` starts Xvfb with a **1920×1080** virtual screen. Chrome draws to that “display,” so the window has real dimensions and passes site checks.
- **Puppeteer** connects to Chrome via `--remote-debugging-port=9222` and controls it as usual.

So on a VPS you get: real Chrome + real viewport size, without a physical monitor.

## VPS requirements

- **OS**: Linux (e.g. Debian, Ubuntu).
- **Node**: v18+ (or Bun; project uses `tsx` for `main.ts`).
- **Chrome or Chromium**: Must be a real build (not headless-only).
- **Xvfb**: For virtual display when no DISPLAY is set.

## 1. Install dependencies (Debian/Ubuntu)

```bash
# Chrome (stable) – pick one
sudo apt-get update
sudo apt-get install -y wget gnupg
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-linux-signing-key.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-key.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable

# Or Chromium
# sudo apt-get install -y chromium-browser

# Virtual display (required so Chrome has a “real” window)
sudo apt-get install -y xvfb

# Node.js (using asdf version manager)
# Install asdf if not already installed: https://asdf-vm.com/guide/getting-started.html
git clone https://github.com/asdf-vm/asdf.git ~/.asdf --branch v0.13.1
. "$HOME/.asdf/asdf.sh"
echo -e '\n. "$HOME/.asdf/asdf.sh"' >> ~/.bashrc  # Add to shell profile

# Install Node.js plugin and latest Node 20
asdf plugin-add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf install nodejs 20.0.0       # Or latest 20.x: asdf install nodejs latest:20
asdf global nodejs 20.0.0        # Or asdf global nodejs latest:20

# Optionally verify
node -v

# pnpm (install globally)
npm install -g pnpm

# bun (install script)
npm install -g bun
# After installation, you may need to add bun to your PATH (follow the printed instructions)
# Example for bash:
# export PATH="$HOME/.bun/bin:$PATH"
```

## 2. Project and env

```bash
cd /path/to/v3-handroll
pnpm install
cp .env.example .env
# Edit .env: VENUE_URL, DATE, TIME_*, PARTY_SIZE, PHONE_NUMBER, etc.
```

## 3. Run on the VPS

**Option A – Let `start.js` start Xvfb (recommended)**  
If `DISPLAY` is not set, `start.js` will start Xvfb and then Chrome:

```bash
node skills/puppeteer-core/start.js
# Chrome is now on :9222 with a 1920x1080 virtual display

# In another terminal (or after in the same session):
source .env && bun main.ts
```

**Option B – Use `xvfb-run` yourself**  
You can run the whole session under Xvfb:

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" node skills/puppeteer-core/start.js
pnpm exec tsx main.ts
```

Optional env overrides (in `start.js`):

- `CHROME_PATH` or `CHROMIUM_PATH`: path to Chrome/Chromium binary.
- `XVFB_DISPLAY`: display number (default `99`).
- `XVFB_SIZE`: virtual screen size (default `1920x1080x24`).

## 4. One-shot script (start + main)

Example wrapper so one command starts Chrome then the bot:

```bash
#!/bin/bash
set -e
cd /path/to/v3-handroll
node skills/puppeteer-core/start.js
exec pnpm exec tsx main.ts
```

Run with `xvfb-run` if you didn’t let `start.js` start Xvfb:

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" ./run-bot.sh
```

## 5. systemd (optional)

Use a wrapper script so one service starts Xvfb, Chrome, then the bot:

**`scripts/run-bot-service.sh`** (create in repo):

```bash
#!/bin/bash
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
# Optional: trap "kill $XVFB_PID" EXIT to stop Xvfb when main exits
```

**`/etc/systemd/system/opentable-bot.service`**:

```ini
[Unit]
Description=OpenTable bot (Chrome + main)
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/v3-handroll
ExecStart=/path/to/v3-handroll/scripts/run-bot-service.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
chmod +x /path/to/v3-handroll/scripts/run-bot-service.sh
sudo systemctl daemon-reload
sudo systemctl enable opentable-bot
sudo systemctl start opentable-bot
```

## Summary

| Item | Purpose |
|------|--------|
| **No headless** | OpenTable blocks headless; we use a real Chrome process. |
| **Xvfb** | Provides a virtual 1920×1080 display so the window has real size. |
| **`--window-size=1920,1080`** | Ensures Chrome uses that size on Linux. |
| **CHROME_PATH / CHROMIUM_PATH** | Use a specific Chrome/Chromium binary on the VPS. |

With this, the bot runs on a VPS with a real browser and real window dimensions, so OpenTable does not block it for being headless or zero-size.
