#!/usr/bin/env tsx
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Config from env ──────────────────────────────────────────────────
const VENUE_URL = env("VENUE_URL");
const DATE = env("DATE").replace(/:/g, "-"); // YYYY-MM-DD
const TIME_EARLIEST = env("TIME_EARLIEST"); // HH:MM
const TIME_LATEST = env("TIME_LATEST");
const PARTY_SIZE = Number(env("PARTY_SIZE"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(__dirname, "..", "..", "packages", "skills", "puppeteer-core");

// Validate date is not in the past
const today = new Date();
today.setHours(0, 0, 0, 0);
const dateObj = new Date(DATE + "T00:00:00");
if (dateObj < today) {
  console.error(`✗ DATE ${DATE} is in the past (today is ${today.toISOString().slice(0, 10)}). Update your .env.`);
  process.exit(1);
}

function env(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
  return v;
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function promptLine(msg: string): Promise<string> {
  return (await rl.question(msg)).trim();
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

interface SlotLockResult {
  success: boolean;
  slotLockId: number;
}

// ── Helpers ──────────────────────────────────────────────────────────
function parseTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
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
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
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

// ── Service Object ───────────────────────────────────────────────────
class OpenTableReservationService {
  private cookie = "";
  private csrfToken = "";
  private restaurantId = 0;
  private correlationId = randomUUID();

  // 1. Launch browser
  startBrowser() {
    console.log("→ Starting Chrome");
    try {
      skill("start.js");
      // My local automation profile
      // skill("start.js", "--profile", "4");
    } catch {
      console.log("  (Chrome may already be running, continuing)");
    }
    sleep(2000);
    console.log("✓ Browser ready");
  }

  // 2. Log in via SMS verification
  async login() {
    const phone = env("PHONE_NUMBER");

    console.log("→ Navigating to OpenTable for login…");
    skill("nav.js", "https://www.opentable.com");
    sleep(3000);

    // Click "Sign in"
    console.log("→ Clicking 'Sign in'…");
    const signInResult = skill(
      "eval.js",
      `(function(){var btn=Array.from(document.querySelectorAll('button,a')).find(function(el){return /sign in/i.test(el.textContent||'');}); if(btn){btn.click(); return 'sign in clicked';} return 'sign in not found';})()`
    );
    console.log(`  ${signInResult}`);
    sleep(2000);

    // Fill phone number in auth iframe
    console.log(`→ Entering phone number…`);
    const phoneResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var input=iframe.contentDocument.querySelector('input#phoneNumber, input[type="tel"], input'); if(!input){return 'phone input missing';} var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(input,'${phone}'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return input.value;})()`
    );
    console.log(`  Phone filled: ${phoneResult}`);

    // Click Continue to send SMS
    console.log("→ Clicking Continue…");
    const contResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var btn=iframe.contentDocument.querySelector('button[type="submit"], button'); if(!btn){return 'continue button missing';} btn.click(); return 'continue clicked';})()`
    );
    console.log(`  ${contResult}`);
    sleep(2000);

    // Prompt user for verification code
    const code = await promptLine("Verification code: ");

    // Enter verification code
    console.log("→ Entering verification code…");
    const codeResult = skill(
      "eval.js",
      `(function(){var iframe=document.getElementById('authenticationModalIframe'); if(!iframe||!iframe.contentDocument){return 'auth iframe missing';} var input=iframe.contentDocument.querySelector('input'); if(!input){return 'code input missing';} var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(input,'${code}'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return input.value;})()`
    );
    console.log(`  Code entered: ${codeResult}`);

    // Click Continue to verify
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

    const ridStr = skill("eval.js", [
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
    ].join("\n"));

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

    // Parse cookies into name=value pairs
    const pairs: string[] = [];
    let currentName = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("name: ")) currentName = line.slice(6);
      if (line.startsWith("value: ")) pairs.push(`${currentName}=${line.slice(7)}`);
    }
    this.cookie = pairs.join("; ");

    // Extract CSRF token from page
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

  // 5. Query availability
  async queryAvailability(): Promise<AvailableSlot[]> {
    console.log(`→ Querying availability for ${DATE} party=${PARTY_SIZE}…`);

    const body = JSON.stringify({
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
        date: DATE,
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
    });

    const data = await fetchGql(
      "query",
      "RestaurantsAvailability",
      body,
      this.cookie,
      this.csrfToken,
      VENUE_URL,
      "rest-profile",
      "restprofilepage",
    );

    if (data.errors) {
      console.error("✗ Availability query failed:", JSON.stringify(data.errors));
      process.exit(1);
    }

    const slots: AvailableSlot[] = [];
    const days = data.data?.availability?.[0]?.availabilityDays ?? [];

    const earliestMin = parseTimeToMinutes(TIME_EARLIEST);
    const latestMin = parseTimeToMinutes(TIME_LATEST);

    for (const day of days) {
      for (const slot of day.slots ?? []) {
        if (
          slot.isAvailable &&
          slot.__typename === "AvailableSlot" &&
          slot.timeOffsetMinutes >= earliestMin &&
          slot.timeOffsetMinutes <= latestMin
        ) {
          slots.push(slot);
        }
      }
    }

    console.log(`✓ Found ${slots.length} available slots in time range`);
    for (const s of slots) {
      console.log(`  ${minutesToTime(s.timeOffsetMinutes)} — hash:${s.slotHash}`);
    }

    return slots;
  }

  // 6. Lock a slot
  async lockSlot(slot: AvailableSlot): Promise<SlotLockResult> {
    const dateTime = `${DATE}T${minutesToTime(slot.timeOffsetMinutes)}`;
    console.log(`→ Locking slot at ${dateTime}…`);

    const body = JSON.stringify({
      operationName: "BookDetailsStandardSlotLock",
      variables: {
        input: {
          restaurantId: this.restaurantId,
          seatingOption: "DEFAULT",
          reservationDateTime: dateTime,
          partySize: PARTY_SIZE,
          databaseRegion: "NA",
          slotHash: slot.slotHash,
          reservationType: "STANDARD",
          diningAreaId: 1,
        },
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "1100bf68905fd7cb1d4fd0f4504a4954aa28ec45fb22913fa977af8b06fd97fa",
        },
      },
    });

    const data = await fetchGql(
      "mutation",
      "BookDetailsStandardSlotLock",
      body,
      this.cookie,
      this.csrfToken,
      "https://www.opentable.com/booking/details",
      "booking",
      "network_details",
    );

    if (data.errors) {
      console.error("✗ Slot lock failed:", JSON.stringify(data.errors));
      process.exit(1);
    }

    const lock = data.data?.lockSlot;
    console.log(`✓ Slot locked: success=${lock?.success}, id=${lock?.slotLock?.slotLockId}`);
    return { success: lock?.success, slotLockId: lock?.slotLock?.slotLockId };
  }

  // 7. Build booking URL
  buildBookingUrl(slot: AvailableSlot): string {
    const dateTime = `${DATE}T${minutesToTime(slot.timeOffsetMinutes)}:00`;
    const params = new URLSearchParams({
      availabilityToken: slot.slotAvailabilityToken,
      correlationId: this.correlationId,
      creditCardRequired: "true",
      dateTime,
      partySize: String(PARTY_SIZE),
      points: String(slot.pointsValue),
      pointsType: slot.pointsType,
      resoAttribute: slot.attributes?.[0] ?? "default",
      rid: String(this.restaurantId),
      slotHash: slot.slotHash,
      isModify: "false",
      isMandatory: String(slot.isMandatory),
      cfe: "true",
      st: `${slot.type}?tc=unselected`,
    });

    return `https://www.opentable.com/booking/details?${params.toString()}`;
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     OpenTable Reservation Bot        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`  Date:  ${DATE}`);
  console.log(`  Time:  ${TIME_EARLIEST} – ${TIME_LATEST}`);
  console.log(`  Party: ${PARTY_SIZE}`);
  console.log(`  Venue: ${VENUE_URL}`);
  console.log();

  const svc = new OpenTableReservationService();

  // Step 1–2: Browser + Login
  svc.startBrowser();
  await svc.login();

  // Step 3: Navigate & extract restaurant ID
  svc.navigateAndExtractId();

  // Step 4: Copy cookies
  svc.copyCookies();

  // Step 5: Query availability
  const slots = await svc.queryAvailability();
  if (slots.length === 0) {
    console.log("✗ No available slots in the requested time range.");
    process.exit(0);
  }

  // TODO: In the future, we may want to try to lock ALL available slots in
  // parallel just in case the first one fails. For now, just pick the first.
  const chosen = slots[0];
  console.log(`\n→ Selected: ${minutesToTime(chosen.timeOffsetMinutes)}`);

  // Step 6: Lock slot
  await svc.lockSlot(chosen);

  // Step 7: Build booking URL
  const bookingUrl = svc.buildBookingUrl(chosen);
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║        Booking URL Ready!            ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(bookingUrl);

  // Open in browser
  console.log("\n→ Opening in browser…");
  skill("nav.js", bookingUrl);
  sleep(5000);

  // Step 8: Accept terms and complete reservation
  console.log("→ Accepting terms & conditions…");
  const tcResult = skill("eval.js", `(function(){ var cb = document.getElementById('tcAccepted'); if(!cb) return 'checkbox not found'; var label = cb.closest('label') || document.querySelector('label[for=tcAccepted]'); if(label){ label.click(); return 'label clicked'; } cb.click(); return 'checkbox clicked'; })()`);
  console.log(`  ${tcResult}`);

  sleep(1000);
  console.log("→ Clicking 'Complete Reservation'…");
  const resResult = skill("eval.js", `(function(){ var btn = document.getElementById('complete-reservation'); if(!btn) return 'button not found'; btn.click(); return 'reservation submitted'; })()`);
  console.log(`  ${resResult}`);

  console.log("✓ Done! Reservation submitted.");

  rl.close();
}

main();
