#!/usr/bin/env node

import puppeteer from "puppeteer-core";

const urlArg = process.argv[2];
if (process.argv[2] && process.argv[2].startsWith("-")) {
	console.log("Usage: cookies.js [url]");
	console.log("");
	console.log("Examples:");
	console.log("  cookies.js                 # Current tab's URL cookies");
	console.log("  cookies.js https://site.tld # Cookies for a URL");
	process.exit(1);
}

const b = await puppeteer.connect({
	browserURL: "http://localhost:9222",
	defaultViewport: null,
});

const p = (await b.pages()).at(-1);

if (!p) {
	console.error("✗ No active tab found");
	process.exit(1);
}

const url = urlArg || p.url();
const cookies = await p.cookies(url);

if (cookies.length === 0) {
	console.log("No cookies found.");
	await b.disconnect();
	process.exit(0);
}

for (let i = 0; i < cookies.length; i++) {
	if (i > 0) console.log("");
	const c = cookies[i];
	console.log(`name: ${c.name}`);
	console.log(`value: ${c.value}`);
	console.log(`domain: ${c.domain}`);
	console.log(`path: ${c.path}`);
	console.log(`httpOnly: ${c.httpOnly}`);
	console.log(`secure: ${c.secure}`);
	console.log(`sameSite: ${c.sameSite}`);
	console.log(`expires: ${c.expires}`);
}

await b.disconnect();
