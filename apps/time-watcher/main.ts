#!/usr/bin/env tsx
/**
 * time-watcher — detects when a restaurant releases NEW FUTURE DATES
 * by polling availability for dates at the trailing edge of the booking
 * window (e.g. 11–15 days out). When a date that previously had zero
 * availability suddenly has slots, that's a release event.
 *
 * Read-only: no booking, no slot locking.
 */
import { execSync, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Config from env ──────────────────────────────────────────────────
const VENUE_URL = env("VENUE_URL");
const PARTY_SIZE = Number(env("PARTY_SIZE"));

// How far out to look (days from today). We query each date in this range.
const LOOKAHEAD_START = Number(optionalEnv("LOOKAHEAD_START") ?? "11");
const LOOKAHEAD_END = Number(optionalEnv("LOOKAHEAD_END") ?? "15");

// Watcher-specific config (optional)
const POLL_INTERVAL_MS = Number(optionalEnv("POLL_INTERVAL_MS") ?? "60000");
const POLL_JITTER_MS = Number(optionalEnv("POLL_JITTER_MS") ?? "20000");
const DUMP_FILE = optionalEnv("DUMP_FILE") ?? null;
const MAX_POLLS = optionalEnv("MAX_POLLS") ? Number(optionalEnv("MAX_POLLS")) : null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(__dirname, "..", "..", "packages", "skills", "puppeteer-core");

// ── Env helpers ──────────────────────────────────────────────────────
function env(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
  return v;
}

function optionalEnv(k: string): string | undefined {
  return process.env[k] || undefined;
}

/** Run a puppeteer skill script (cwd = SKILLS so node_modules resolve) */
function skill(script: string, ...args: string[]): string {
  return execFileSync("node", ["--no-warnings", script, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    cwd: SKILLS,
  }).trim();
}

function sleep(ms: number) {
  execSync(`sleep ${ms / 1000}`);
}

// ── Types ────────────────────────────────────────────────────────────
interface AvailableSlot {
  isAvailable: boolean;
  timeOffsetMinutes: number;
  slotHash: string;
  pointsType: string;
  pointsValue: number;
  slotAvailabilityToken: string;
  attributes: string[];
  isMandatory: boolean;
  type: string;
  __typename: string;
}

/** Per-date availability snapshot */
interface DateSnapshot {
  date: string; // YYYY-MM-DD
  daysOut: number; // days from today
  slotCount: number;
  slots: { time: string; hash: string }[];
}

// ── Helpers ──────────────────────────────────────────────────────────
function minutesToTime(mins: number): string {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function logTs(msg: string) {
  console.log(`[${nowISO()}] ${msg}`);
}

/** Compute YYYY-MM-DD for today + N days (local time). */
function futureDateStr(daysFromNow: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysFromNow);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function fetchGql(
  optype: string,
  opname: string,
  body: string,
  cookie: string,
  csrf: string,
  referer: string,
  pageGroup: string,
  pageType: string,
): Promise<any> {
  const url = `https://www.opentable.com/dapi/fe/gql?optype=${optype}&opname=${opname}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "accept": "*/*",
      "content-type": "application/json",
      "cookie": cookie,
      "origin": "https://www.opentable.com",
      "referer": referer,
      "ot-page-group": pageGroup,
      "ot-page-type": pageType,
      "x-csrf-token": csrf,
      "x-query-timeout": "5500",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      "sec-ch-ua":
        '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
    body,
  });

  return res.json();
}

/**
 * Build a compact fingerprint for a set of DateSnapshots.
 * Format: "YYYY-MM-DD:count:hash1,hash2,...|YYYY-MM-DD:..." (sorted by date).
 * Dates with 0 slots are included as "YYYY-MM-DD:0".
 */
function buildMultiDateFingerprint(snapshots: DateSnapshot[]): string {
  return snapshots
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => {
      if (s.slotCount === 0) return `${s.date}:0`;
      const hashes = s.slots.map((sl) => sl.hash).sort().join(",");
      return `${s.date}:${s.slotCount}:${hashes}`;
    })
    .join("|");
}

function hashFingerprint(fp: string): string {
  return createHash("sha256").update(fp).digest("hex").slice(0, 16);
}

/**
 * Compute jittered delay: base ± random jitter, clamped to min 10s.
 */
function jitteredDelay(): number {
  const jitter = (Math.random() * 2 - 1) * POLL_JITTER_MS;
  return Math.max(10_000, POLL_INTERVAL_MS + jitter);
}

/**
 * Append a JSONL record to the dump file.
 */
function appendDump(record: object) {
  if (!DUMP_FILE) return;
  try {
    appendFileSync(DUMP_FILE, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    logTs(`⚠ Failed to write to dump file: ${err}`);
  }
}

// ── Service ──────────────────────────────────────────────────────────
class TimeWatcherService {
  private cookie = "";
  private csrfToken = "";
  private restaurantId = 0;
  private correlationId = randomUUID();

  // 1. Launch browser
  startBrowser() {
    console.log("→ Starting Chrome");
    try {
      skill("start.js");
    } catch {
      console.log("  (Chrome may already be running, continuing)");
    }
    sleep(2000);
    console.log("✓ Browser ready");
  }

  // 2. Log in via SMS verification (skipped if already signed in)
  async login() {
    const phone = env("PHONE_NUMBER");

    console.log("→ Navigating to OpenTable…");
    skill("nav.js", "https://www.opentable.com");
    sleep(3000);

    // Check if already signed in (look for avatar / account icon instead of "Sign in" button)
    const alreadyLoggedIn = skill(
      "eval.js",
      `(function(){var btn=Array.from(document.querySelectorAll('button,a')).find(function(el){return /sign in/i.test(el.textContent||'');}); return btn ? 'no' : 'yes';})()`
    );

    if (alreadyLoggedIn === "yes") {
      console.log("✓ Already signed in — skipping login");
      return;
    }

    console.log("→ Clicking 'Sign in'…");
    const signInResult = skill(
      "eval.js",
      `(function(){var btn=Array.from(document.querySelectorAll('button,a')).find(function(el){return /sign in/i.test(el.textContent||'');}); if(btn){btn.click(); return 'sign in clicked';} return 'sign in not found';})()`
    );
    console.log(`  ${signInResult}`);
    sleep(2000);

    console.log(`→ Entering phone number…`);
    const phoneResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var input=iframe.contentDocument.querySelector('input#phoneNumber, input[type="tel"], input'); if(!input){return 'phone input missing';} var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(input,'${phone}'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return input.value;})()`
    );
    console.log(`  Phone filled: ${phoneResult}`);

    console.log("→ Clicking Continue…");
    const contResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var btn=iframe.contentDocument.querySelector('button[type="submit"], button'); if(!btn){return 'continue button missing';} btn.click(); return 'continue clicked';})()`
    );
    console.log(`  ${contResult}`);
    sleep(2000);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question("Verification code: ")).trim();
    rl.close();

    console.log("→ Entering verification code…");
    const codeResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var input=iframe.contentDocument.querySelector('input'); if(!input){return 'code input missing';} var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(input,'${code}'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return input.value;})()`
    );
    console.log(`  Code entered: ${codeResult}`);

    console.log("→ Verifying…");
    const verifyResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var btn=iframe.contentDocument.querySelector('button[type="submit"], button'); if(!btn){return 'continue button missing';} btn.click(); return 'verification clicked';})()`
    );
    console.log(`  ${verifyResult}`);
    sleep(2000);

    console.log("✓ Login complete");
  }

  // 3. Navigate to venue URL, extract restaurant ID
  navigateAndExtractId() {
    console.log(`→ Navigating to ${VENUE_URL}…`);
    skill("nav.js", VENUE_URL);
    sleep(3000);

    const ridStr = skill(
      "eval.js",
      [
        `(function(){`,
        `  var rid=null;`,
        `  var apollo=window.__APOLLO_STATE__;`,
        `  if(apollo){`,
        `    var entries=Object.entries(apollo);`,
        `    for(var i=0;i<entries.length;i++){`,
        `      var key=entries[i][0], val=entries[i][1];`,
        `      if(val && typeof val==='object'){`,
        `        if(typeof val.restaurantId==='number' && val.restaurantId>0){rid=val.restaurantId; break;}`,
        `        if(key.indexOf('Restaurant:')===0 && typeof val.id==='number' && val.id>0){rid=val.id; break;}`,
        `      }`,
        `    }`,
        `  }`,
        `  if(!rid){`,
        `    var html=document.documentElement && document.documentElement.innerHTML || '';`,
        `    var re=/"restaurantId"\\s*:\\s*(\\d+)/g;`,
        `    var m;`,
        `    while((m=re.exec(html))!==null){if(Number(m[1])>0){rid=Number(m[1]); break;}}`,
        `    if(!rid){`,
        `      var m2=html.match(/"rid"\\s*:\\s*(\\d+)/);`,
        `      if(m2 && Number(m2[1])>0){rid=Number(m2[1]);}`,
        `    }`,
        `  }`,
        `  return rid || null;`,
        `})()`,
      ].join("\n"),
    );

    const rid = parseInt(ridStr, 10);
    if (!rid) {
      console.error("✗ Could not extract restaurant ID from page");
      process.exit(1);
    }
    this.restaurantId = rid;
    console.log(`✓ Restaurant ID: ${this.restaurantId}`);
  }

  // 4. Copy cookies & CSRF token from browser
  copyCookies() {
    console.log("→ Extracting cookies from browser…");
    const raw = skill("cookies.js", "https://www.opentable.com");

    const pairs: string[] = [];
    let currentName = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("name: ")) currentName = line.slice(6);
      if (line.startsWith("value: ")) pairs.push(`${currentName}=${line.slice(7)}`);
    }
    this.cookie = pairs.join("; ");

    let csrf = "";
    try {
      csrf = skill(
        "eval.js",
        `document.cookie.match(/csrf[^=]*=([^;]+)/)?.[1] || document.querySelector('meta[name=csrf-token]')?.content || ''`,
      );
    } catch {}
    this.csrfToken = csrf || randomUUID();

    console.log(`✓ Cookie length: ${this.cookie.length} chars`);
    console.log(`✓ CSRF token: ${this.csrfToken}`);
  }

  // 5. Query availability for a single date.
  //    Returns parsed slots (all available, full day) + raw request/response.
  async queryDateAvailability(date: string): Promise<{
    slots: AvailableSlot[];
    requestBody: object;
    responseBody: any;
  }> {
    const requestBody = {
      operationName: "RestaurantsAvailability",
      variables: {
        onlyPop: false,
        forwardDays: 0,
        requireTimes: false,
        requireTypes: ["Standard", "Experience"],
        privilegedAccess: [
          "UberOneDiningProgram",
          "VisaDiningProgram",
          "VisaEventsProgram",
          "ChaseDiningProgram",
        ],
        restaurantIds: [this.restaurantId],
        date,
        time: "00:00",
        partySize: PARTY_SIZE,
        databaseRegion: "NA",
        restaurantAvailabilityTokens: [],
        loyaltyRedemptionTiers: [],
        correlationId: this.correlationId,
        forwardMinutes: 1440,
        backwardMinutes: 0,
        forwardTimeslots: 50,
        backwardTimeslots: 0,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "b2d05a06151b3cb21d9dfce4f021303eeba288fac347068b29c1cb66badc46af",
        },
      },
    };

    const body = JSON.stringify(requestBody);

    const responseBody = await fetchGql(
      "query",
      "RestaurantsAvailability",
      body,
      this.cookie,
      this.csrfToken,
      VENUE_URL,
      "rest-profile",
      "restprofilepage",
    );

    const slots: AvailableSlot[] = [];
    const days = responseBody.data?.availability?.[0]?.availabilityDays ?? [];

    for (const day of days) {
      for (const slot of day.slots ?? []) {
        if (slot.isAvailable && slot.__typename === "AvailableSlot") {
          slots.push(slot);
        }
      }
    }

    return { slots, requestBody, responseBody };
  }

  /**
   * Query all lookahead dates and return snapshots.
   * Queries are made sequentially with a small random gap (1–3s) between
   * them so the request pattern looks organic.
   */
  async queryAllDates(): Promise<{
    snapshots: DateSnapshot[];
    rawResults: { date: string; requestBody: object; responseBody: any }[];
  }> {
    const snapshots: DateSnapshot[] = [];
    const rawResults: { date: string; requestBody: object; responseBody: any }[] = [];

    for (let d = LOOKAHEAD_START; d <= LOOKAHEAD_END; d++) {
      const date = futureDateStr(d);

      const { slots, requestBody, responseBody } = await this.queryDateAvailability(date);

      rawResults.push({ date, requestBody, responseBody });

      snapshots.push({
        date,
        daysOut: d,
        slotCount: slots.length,
        slots: slots.map((s) => ({
          time: minutesToTime(s.timeOffsetMinutes),
          hash: s.slotHash,
        })),
      });

      // Small organic gap between per-date requests (skip after last)
      if (d < LOOKAHEAD_END) {
        const gap = 1000 + Math.random() * 2000;
        sleep(gap);
      }
    }

    return { snapshots, rawResults };
  }

  // ── Polling loop ─────────────────────────────────────────────────
  async runPollingLoop() {
    // Map of date → previous DateSnapshot (keyed by YYYY-MM-DD)
    let previousByDate: Map<string, DateSnapshot> = new Map();
    let firstPoll = true;
    let pollCount = 0;

    logTs("Starting polling loop — watching booking horizon");
    logTs(`  Lookahead: today+${LOOKAHEAD_START} through today+${LOOKAHEAD_END}`);
    logTs(`  Poll interval: ${POLL_INTERVAL_MS}ms ± ${POLL_JITTER_MS}ms jitter`);
    if (DUMP_FILE) logTs(`  Dump file: ${DUMP_FILE}`);
    if (MAX_POLLS) logTs(`  Max polls: ${MAX_POLLS}`);
    console.log();

    // Graceful shutdown
    let running = true;
    const shutdown = () => {
      logTs("Received shutdown signal, stopping after current poll…");
      running = false;
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    while (running) {
      pollCount++;
      if (MAX_POLLS && pollCount > MAX_POLLS) {
        logTs(`Reached MAX_POLLS (${MAX_POLLS}), exiting.`);
        break;
      }

      try {
        const ts = nowISO();
        logTs(`━━━ Poll #${pollCount} ━━━`);

        // Compute which dates we're querying this cycle
        const dateList: string[] = [];
        for (let d = LOOKAHEAD_START; d <= LOOKAHEAD_END; d++) {
          dateList.push(futureDateStr(d));
        }
        logTs(`Querying dates: ${dateList.join(", ")}`);

        const { snapshots, rawResults } = await this.queryAllDates();

        // Dump every request/response
        for (const r of rawResults) {
          appendDump({ ts, date: r.date, request: r.requestBody, response: r.responseBody });
        }

        // ── Per-date comparison ──
        for (const snap of snapshots) {
          const prev = previousByDate.get(snap.date);
          const label = `${snap.date} (today+${snap.daysOut})`;

          if (firstPoll) {
            // Baseline
            if (snap.slotCount > 0) {
              logTs(`  📅 ${label}: ${snap.slotCount} slots`);
              for (const sl of snap.slots) {
                logTs(`      ${sl.time}`);
              }
            } else {
              logTs(`  📅 ${label}: no availability`);
            }
          } else if (!prev) {
            // Date wasn't in previous set (e.g. dates shifted overnight)
            if (snap.slotCount > 0) {
              logTs(`  🆕 ${label}: NEW DATE entered lookahead window with ${snap.slotCount} slots`);
              for (const sl of snap.slots) {
                logTs(`      ${sl.time}`);
              }
            } else {
              logTs(`  📅 ${label}: entered lookahead window (no availability yet)`);
            }
          } else if (prev.slotCount === 0 && snap.slotCount > 0) {
            // ═══════════════════════════════════════════════════
            // THIS IS THE KEY EVENT: date went from 0 → N slots
            // The restaurant just released this date.
            // ═══════════════════════════════════════════════════
            logTs(`  🔔 RELEASE: ${label} — ${snap.slotCount} NEW slots appeared!`);
            for (const sl of snap.slots) {
              logTs(`      ${sl.time}`);
            }
            const event = {
              ts,
              event: "date-release",
              date: snap.date,
              daysOut: snap.daysOut,
              slotCount: snap.slotCount,
              slots: snap.slots.map((s) => s.time),
            };
            console.log(JSON.stringify(event));
          } else if (snap.slotCount !== prev.slotCount) {
            // Slot count changed on an already-open date (slots added/removed)
            const prevTimes = new Set(prev.slots.map((s) => s.time));
            const currTimes = new Set(snap.slots.map((s) => s.time));
            const added = snap.slots.filter((s) => !prevTimes.has(s.time)).map((s) => s.time);
            const removed = prev.slots.filter((s) => !currTimes.has(s.time)).map((s) => s.time);

            logTs(`  ∆ ${label}: ${prev.slotCount} → ${snap.slotCount} slots`);
            if (added.length) logTs(`      + ${added.join(", ")}`);
            if (removed.length) logTs(`      − ${removed.join(", ")}`);
          }
          // else: unchanged — silent
        }

        if (firstPoll) {
          logTs("Baseline established.");
          firstPoll = false;
        }

        // Store snapshots for next comparison
        const newMap = new Map<string, DateSnapshot>();
        for (const snap of snapshots) {
          newMap.set(snap.date, snap);
        }
        previousByDate = newMap;

      } catch (err: any) {
        logTs(`⚠ Error during poll: ${err.message ?? err}`);
      }

      if (!running) break;

      const delay = jitteredDelay();
      logTs(`Sleeping ${(delay / 1000).toFixed(1)}s…`);
      console.log();
      sleep(delay);
    }

    logTs("Polling loop ended.");
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  // Compute the lookahead dates for display
  const datePreviews: string[] = [];
  for (let d = LOOKAHEAD_START; d <= LOOKAHEAD_END; d++) {
    datePreviews.push(`${futureDateStr(d)} (+${d}d)`);
  }

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║      OpenTable Time Watcher (Horizon)       ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Venue:     ${VENUE_URL}`);
  console.log(`  Party:     ${PARTY_SIZE}`);
  console.log(`  Watching:  ${datePreviews.join(", ")}`);
  console.log(`  Interval:  ${POLL_INTERVAL_MS}ms ± ${POLL_JITTER_MS}ms`);
  if (DUMP_FILE) console.log(`  Dump:      ${DUMP_FILE}`);
  console.log();

  const svc = new TimeWatcherService();

  // Step 1–2: Browser + Login
  svc.startBrowser();
  await svc.login();

  // Step 3: Navigate & extract restaurant ID
  svc.navigateAndExtractId();

  // Step 4: Copy cookies & CSRF
  svc.copyCookies();

  // Step 5: Start polling loop (runs until killed)
  await svc.runPollingLoop();
}

main();
