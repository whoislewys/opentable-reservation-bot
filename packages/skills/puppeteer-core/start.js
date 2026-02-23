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

// Resolve Chrome/Chromium executable (VPS-friendly: use CHROME_PATH or CHROMIUM_PATH)
function getChromePath() {
	const envPath = process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
	if (envPath) return envPath;
	if (isDarwin) return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	if (isLinux) {
		for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
			if (existsSync(p)) return p;
		}
		try {
			return execSync("which chromium chromium-browser google-chrome 2>/dev/null", { encoding: "utf8" }).trim().split("\n")[0] || null;
		} catch {
			return null;
		}
	}
	return null;
}

// Function to get available Chrome profiles (macOS only)
function getProfiles() {
	const chromeDir = "/Users/machine/Library/Application Support/Google/Chrome";
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
		console.error("Could not read Chrome profiles:", e.message);
		return [];
	}
}

// Handle --list-profiles: just print and exit (macOS only)
if (listProfiles) {
	if (!isDarwin) {
		console.error("--list-profiles is only supported on macOS");
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

// Resolve profile selection (--profile is macOS-only)
let selectedProfile = null;
if (useProfile) {
	if (!isDarwin) {
		console.error("--profile is only supported on macOS. On VPS/Linux use a fresh profile.");
		process.exit(1);
	}
	if (profileArg) {
		const profiles = getProfiles();
		const num = parseInt(profileArg, 10);
		if (!isNaN(num) && num >= 1 && num <= profiles.length) {
			selectedProfile = profiles[num - 1];
		} else {
			selectedProfile = profiles.find((p) => p.dir === profileArg);
			if (!selectedProfile) {
				console.error(`Profile not found: ${profileArg}`);
				console.error("Use --list-profiles to see available profiles");
				process.exit(1);
			}
		}
		console.log(`Using profile: ${selectedProfile.name}`);
	} else {
		selectedProfile = { dir: "Default", name: "Default" };
	}
}

const chromePath = getChromePath();
if (!chromePath) {
	console.error("Chrome/Chromium not found. Set CHROME_PATH or CHROMIUM_PATH, or install Chrome.");
	process.exit(1);
}

// Kill existing Chrome only on macOS (avoid killing system browsers on Linux)
if (isDarwin) {
	try {
		execSync("killall 'Google Chrome'", { stdio: "ignore" });
	} catch {}
	await new Promise((r) => setTimeout(r, 1000));
}

// On Linux without a display: start Xvfb so Chrome runs as a real (non-headless) browser with real dimensions.
// OpenTable blocks headless and zero-size windows; Xvfb gives a real 1920x1080 "screen".
let xvfbProcess = null;
const xvfbDisplay = process.env.XVFB_DISPLAY || "99";
const xvfbSize = process.env.XVFB_SIZE || "1920x1080x24";
if (isLinux && !process.env.DISPLAY) {
	try {
		xvfbProcess = spawn("Xvfb", [`:${xvfbDisplay}`, "-screen", "0", xvfbSize, "-ac"], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, DISPLAY: `:${xvfbDisplay}` },
		});
		xvfbProcess.unref();
		await new Promise((r) => setTimeout(r, 500));
	} catch (e) {
		console.error("Xvfb not found. Install with: apt install xvfb (Debian/Ubuntu) or yum install xorg-x11-server-Xvfb (RHEL)");
		process.exit(1);
	}
}

// Setup profile directory
execSync("mkdir -p ~/.cache/scraping", { stdio: "ignore" });

if (useProfile && isDarwin) {
	execSync(
		'rsync -a --delete "/Users/machine/Library/Application Support/Google/Chrome/" ~/.cache/scraping/',
		{ stdio: "pipe" },
	);
}

// Build Chrome arguments. Do NOT use --headless; use a real window (Xvfb on VPS provides the display).
const chromeArgs = [
	"--remote-debugging-port=9222",
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	`--user-data-dir=${process.env["HOME"]}/.cache/scraping`,
];

if (isLinux) {
	chromeArgs.push("--window-size=1920,1080");
}

if (selectedProfile) {
	chromeArgs.push(`--profile-directory=${selectedProfile.dir}`);
}

const spawnEnv = { ...process.env };
if (isLinux && !process.env.DISPLAY) spawnEnv.DISPLAY = `:${xvfbDisplay}`;

// Start Chrome in background (detached so Node can exit)
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
