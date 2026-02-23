#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
let url = null;
let waitMs = 8000;
let reload = false;
let newTab = false;
let match = null;
let filter = "availability";
let outFile = null;
let includeBody = false;
let clickAvailability = false;

for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === "--ms") {
		const next = args[i + 1];
		if (!next) {
			console.error("Missing value for --ms");
			process.exit(1);
		}
		const parsed = Number(next);
		if (!Number.isFinite(parsed) || parsed < 0) {
			console.error(`Invalid --ms value: ${next}`);
			process.exit(1);
		}
		waitMs = parsed;
		i += 1;
		continue;
	}
	if (arg === "--reload") {
		reload = true;
		continue;
	}
	if (arg === "--new") {
		newTab = true;
		continue;
	}
	if (arg === "--match") {
		const next = args[i + 1];
		if (!next) {
			console.error("Missing value for --match");
			process.exit(1);
		}
		match = next;
		i += 1;
		continue;
	}
	if (arg === "--filter") {
		const next = args[i + 1];
		if (!next) {
			console.error("Missing value for --filter");
			process.exit(1);
		}
		filter = next;
		i += 1;
		continue;
	}
	if (arg === "--out") {
		const next = args[i + 1];
		if (!next) {
			console.error("Missing value for --out");
			process.exit(1);
		}
		outFile = next;
		i += 1;
		continue;
	}
	if (arg === "--include-body") {
		includeBody = true;
		continue;
	}
	if (arg === "--click-availability") {
		clickAvailability = true;
		continue;
	}
	if (!url) {
		url = arg;
		continue;
	}
}

if (args.includes("--help") || args.includes("-h")) {
	console.log(
		"Usage: netlog.js [url] [--new] [--reload] [--ms N] [--match str] [--filter str] [--out file] [--include-body] [--click-availability]",
	);
	console.log("");
	console.log("Examples:");
	console.log("  netlog.js --filter availability --ms 12000");
	console.log("  netlog.js https://example.com --new --filter availability");
	console.log("  netlog.js --match opentable --filter availability --out /tmp/avail.json");
	console.log("  netlog.js --match opentable --click-availability --ms 15000");
	process.exit(0);
}

const browser = await puppeteer.connect({
	browserURL: "http://localhost:9222",
	defaultViewport: null,
});

let page = null;
const pages = await browser.pages();
if (match) {
	page = pages.find((p) => p.url().includes(match)) || null;
}
if (!page && (newTab || url)) {
	page = await browser.newPage();
}
if (!page) {
	page = pages.at(-1) || null;
}

if (!page) {
	console.error("No active page found. Use --new or pass a URL.");
	await browser.disconnect();
	process.exit(1);
}

if (url) {
	await page.goto(url, { waitUntil: "domcontentloaded" });
}
if (reload) {
	await page.reload({ waitUntil: "domcontentloaded" });
}

if (clickAvailability) {
	const result = await page.evaluate(() => {
		const selectors = [
			"button:has-text(\"View full availability\")",
			"[data-test=\"multi-day-availability-button\"]",
			"[data-test=\"availability-button\"]",
		];

		const matchTextSelector = (sel) => {
			const m = sel.match(/button:has-text\\(\"(.+)\"\\)/);
			if (!m) return null;
			const text = m[1];
			return (
				Array.from(document.querySelectorAll("button")).find((b) => {
					return b.textContent && b.textContent.trim().includes(text);
				}) || null
			);
		};

		const findElement = (sel) => {
			if (sel.includes(":has-text(")) {
				return matchTextSelector(sel);
			}
			return document.querySelector(sel);
		};

		const clickElement = (el) => {
			if (!el) return false;
			el.scrollIntoView({ block: "center" });
			el.click();
			return true;
		};

		document.body && document.body.click && document.body.click();

		for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt += 1) {
			window.scrollBy(0, 800);
			for (let i = 0; i < selectors.length; i += 1) {
				const sel = selectors[i];
				const el = findElement(sel);
				if (el) {
					return { clicked: clickElement(el), selector: sel, attempt: scrollAttempt };
				}
			}
		}
		return { clicked: false, selector: null };
	});

	if (result?.clicked) {
		console.log(`[click] ${result.selector} (attempt ${result.attempt})`);
	} else {
		console.log("[click] availability button not found");
	}
}

const filterLower = filter ? filter.toLowerCase() : "";
const entries = [];

const shouldRecord = (urlToCheck) => {
	if (!filterLower) return true;
	return String(urlToCheck).toLowerCase().includes(filterLower);
};

page.on("request", (req) => {
	const urlToCheck = req.url();
	if (!shouldRecord(urlToCheck)) return;
	entries.push({
		type: "request",
		method: req.method(),
		url: urlToCheck,
		resourceType: req.resourceType(),
		headers: req.headers(),
		postData: req.postData() || null,
	});
	console.log(`[req] ${req.method()} ${urlToCheck}`);
});

page.on("response", async (res) => {
	const urlToCheck = res.url();
	if (!shouldRecord(urlToCheck)) return;
	const entry = {
		type: "response",
		status: res.status(),
		statusText: res.statusText(),
		url: urlToCheck,
		headers: res.headers(),
	};
	if (includeBody) {
		try {
			entry.body = await res.text();
		} catch (err) {
			entry.body = `<<failed to read body: ${err.message}>>`;
		}
	}
	entries.push(entry);
	console.log(`[res] ${res.status()} ${urlToCheck}`);
});

await new Promise((r) => setTimeout(r, waitMs));

if (outFile) {
	writeFileSync(outFile, JSON.stringify(entries, null, 2), "utf8");
	console.log(`Saved ${entries.length} entries to ${outFile}`);
} else if (entries.length === 0) {
	console.log("No matching network entries captured.");
}

await browser.disconnect();
