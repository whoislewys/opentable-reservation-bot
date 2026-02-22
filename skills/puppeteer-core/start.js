#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { platform } from "node:os";
import puppeteer from "puppeteer-core";

const isDarwin = platform() === "darwin";
const isLinux = platform() === "linux";

const listProfiles = process.argv[2] === "--list-profiles";
const useProfile = process.argv[2] === "--profile";
const profileArg = useProfile ? process.argv[3] : null; // optional: number or profile dir name

/** Resolve Chrome/Chromium executable. VPS: set CHROME_PATH or CHROMIUM_PATH if needed. */
function getChromePath() {
	if (process.env["CHROME_PATH"]) return process.env["CHROME_PATH"];
	if (process.env["CHROMIUM_PATH"]) return process.env["CHROMIUM_PATH"];
	if (isDarwin) {
		return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	}
	if (isLinux) {
		const candidates = [
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
		];
		for (const c of candidates) {
			if (existsSync(c)) return c;
		}
		console.error("Chrome/Chromium not found. Install or set CHROME_PATH / CHROMIUM_PATH.");
		process.exit(1);
	}
	console.error("Unsupported platform for Chrome");
	process.exit(1);
}

// Function to get available Chrome profiles (macOS only; used for --profile copy)
function getProfiles() {
	if (!isDarwin) return [];
	const chromeDir = `${process.env["HOME"]}/Library/Application Support/Google/Chrome`;
	const localStatePath = `${chromeDir}/Local State`;
	try {
		const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
		const profilesInfo = localState.profile?.info_cache || {};
		return Object.entries(profilesInfo).map(([dir, info]) => ({
			dir,
			name: info.name || dir,
			email: info.user_name || "",
		}));
	} catch (e) {
		return [];
	}
}

// Handle --list-profiles: just print and exit (macOS only)
if (listProfiles) {
	if (!isDarwin) {
		console.error("--list-profiles is only available on macOS (profile copy from local Chrome).");
		process.exit(1);
	}
	const profiles = getProfiles();
	if (profiles.length === 0) {
		console.error("No Chrome profiles found");
		process.exit(1);
	}
	console.log("Available Chrome profiles:");
	profiles.forEach((p, i) => {
		const email = p.email ? ` (${p.email})` : "";
		console.log(`  ${i + 1}. ${p.name}${email} [${p.dir}]`);
	});
	process.exit(0);
}

if (process.argv[2] && process.argv[2] !== "--profile") {
	console.log("Usage: start.js [--profile [NUM|DIR]] [--list-profiles]");
	console.log("");
	console.log("Options:");
	console.log("  --profile [NUM|DIR]  Copy Chrome profile (default: Default profile)");
	console.log("                       NUM: profile number from --list-profiles");
	console.log("                       DIR: profile directory name (e.g., 'Profile 1')");
	console.log("  --list-profiles      List available Chrome profiles and exit");
	console.log("");
	console.log("Examples:");
	console.log("  start.js                    # Start with fresh profile");
	console.log("  start.js --profile          # Start with Default profile");
	console.log("  start.js --profile 2        # Start with profile #2");
	console.log("  start.js --profile 'Profile 1'  # Start with 'Profile 1'");
	console.log("  start.js --list-profiles    # List available profiles");
	process.exit(1);
}

// Resolve profile selection
let selectedProfile = null;
if (useProfile) {
	if (profileArg) {
		const profiles = getProfiles();
		const num = parseInt(profileArg, 10);
		if (!isNaN(num) && num >= 1 && num <= profiles.length) {
			// Numeric selection
			selectedProfile = profiles[num - 1];
		} else {
			// Try to match by directory name
			selectedProfile = profiles.find((p) => p.dir === profileArg);
			if (!selectedProfile) {
				console.error(`Profile not found: ${profileArg}`);
				console.error("Use --list-profiles to see available profiles");
				process.exit(1);
			}
		}
		console.log(`Using profile: ${selectedProfile.name}`);
	} else {
		// Default to "Default" profile
		selectedProfile = { dir: "Default", name: "Default" };
	}
}

// Kill existing Chrome/Chromium on the debugging port so we can bind
try {
	if (isDarwin) execSync("killall 'Google Chrome'", { stdio: "ignore" });
	else execSync("pkill -f 'chromium.*9222' || pkill -f 'chrome.*9222' || true", { stdio: "ignore" });
} catch {}

// Wait a bit for processes to fully die
await new Promise((r) => setTimeout(r, 1000));

// Setup profile directory
const userDataDir = `${process.env["HOME"]}/.cache/scraping`;
execSync(`mkdir -p "${userDataDir}"`, { stdio: "ignore" });

if (useProfile && isDarwin) {
	// Sync profile with rsync (macOS only; much faster on subsequent runs)
	const chromeDir = `${process.env["HOME"]}/Library/Application Support/Google/Chrome`;
	execSync(`rsync -a --delete "${chromeDir}/" "${userDataDir}/"`, { stdio: "pipe" });
}

// Build Chrome arguments. Never use --headless: OpenTable blocks headless / zero-size windows.
const chromeArgs = [
	"--remote-debugging-port=9222",
	`--user-data-dir=${userDataDir}`,
	// Real window size so sites (e.g. OpenTable) don't block "zero size" or headless
	"--window-size=1920,1080",
	// Reduce automation detection
	"--disable-blink-features=AutomationControlled",
	"--no-first-run",
	"--no-default-browser-check",
];
// VPS/container: often needed when running as root or in Docker
if (process.env["CHROME_NO_SANDBOX"] === "1") {
	chromeArgs.push("--no-sandbox", "--disable-setuid-sandbox");
}

if (selectedProfile) {
	chromeArgs.push(`--profile-directory=${selectedProfile.dir}`);
}

const chromePath = getChromePath();
const spawnEnv = { ...process.env };
// VPS: use virtual display (Xvfb). Start Xvfb first, e.g. Xvfb :99 -screen 0 1920x1080x24 &
if (isLinux && !spawnEnv["DISPLAY"]) {
	spawnEnv["DISPLAY"] = ":99";
}

// Start Chrome in background (detached so Node can exit). Headed browser, not headless.
spawn(chromePath, chromeArgs, {
	detached: true,
	stdio: "ignore",
	env: spawnEnv,
}).unref();

// Wait for Chrome to be ready by attempting to connect
let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({
			browserURL: "http://localhost:9222",
			defaultViewport: null,
		});
		await browser.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error("✗ Failed to connect to Chrome");
	process.exit(1);
}

const profileMsg = selectedProfile ? ` with profile "${selectedProfile.name}"` : "";
console.log(`✓ Chrome started on :9222${profileMsg}`);
