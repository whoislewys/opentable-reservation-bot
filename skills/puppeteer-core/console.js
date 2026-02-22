#!/usr/bin/env node

import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
let url = null;
let waitMs = 3000;
let reload = false;
let newTab = false;
let match = null;

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
	if (!url) {
		url = arg;
		continue;
	}
}

if (args.includes("--help") || args.includes("-h")) {
	console.log("Usage: console.js [url] [--new] [--reload] [--ms N] [--match str]");
	console.log("");
	console.log("Examples:");
	console.log("  console.js");
	console.log("  console.js --ms 5000");
	console.log("  console.js --reload --ms 3000");
	console.log("  console.js https://example.com --new --ms 4000");
	console.log("  console.js --match localhost:6969 --reload");
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

const entries = [];
const pushEntry = (type, text, location) => {
	const loc = location?.url
		? `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`
		: null;
	entries.push({
		type,
		text,
		location: loc,
	});
};

page.on("console", (msg) => {
	pushEntry(msg.type(), msg.text(), msg.location());
});
page.on("pageerror", (err) => {
	pushEntry("pageerror", err?.message || String(err));
});
page.on("error", (err) => {
	pushEntry("error", err?.message || String(err));
});

const targetUrl = url;
if (targetUrl) {
	await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
}
if (reload) {
	await page.reload({ waitUntil: "domcontentloaded" });
}

await new Promise((r) => setTimeout(r, waitMs));

if (entries.length === 0) {
	console.log("No console output captured.");
} else {
	console.log(`Page: ${page.url()}`);
	for (const entry of entries) {
		const loc = entry.location ? ` (${entry.location})` : "";
		console.log(`[${entry.type}] ${entry.text}${loc}`);
	}
}

await browser.disconnect();
