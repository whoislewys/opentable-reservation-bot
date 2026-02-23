# OpenTable Reservation Bot

Two tools for OpenTable: a **reservation bot** that books a slot, and a **time watcher** that monitors the booking horizon to detect when a restaurant releases new future dates.

## Setup

1. Ensure you have a credit card added to OpenTable already! Most restaurants require this for reservation. To check if you have a card added, or to add one, go here: https://www.opentable.com/user/profile/payments

2. Copy the example env and fill in your details:

```bash
cp .env.example .env
vim .env
```

3. Install dependencies:

```bash
pnpm install
```

---

## Reservation Bot

Books a reservation for a specific date and time window.

### Config

Set these in `apps/bot/.env` (or source the root `.env`):

| Var | Example |
|-----|---------|
| `VENUE_URL` | `https://www.opentable.com/r/le-veau-dor-new-york` |
| `DATE` | `2026:03:04` |
| `TIME_EARLIEST` | `12:00` |
| `TIME_LATEST` | `20:30` |
| `PARTY_SIZE` | `2` |
| `PHONE_NUMBER` | `5551234567` |

### Run

```bash
source .env && pnpm run start:reservation-bot
```

### Flow

1. Opens Chrome
2. Logs in via SMS verification (you'll be prompted for the code)
3. Navigates to the restaurant page and extracts the restaurant ID
4. Copies session cookies from the browser
5. Queries available time slots within your time range
6. Picks first available slot
7. Locks the selected slot via GraphQL mutation
8. Opens the booking details page, accepts terms, and submits the reservation
    > (Reservation not available through graphql api, and REST API requires official OpenTable partnership to get API token to use. So, use browser to navigate to reservation url and submit form to complete reservation. Requires user having card added to opentable before hand.)

---

## Time Watcher

Monitors the **trailing edge of a restaurant's booking window** to detect exactly when they release new future dates. Instead of watching a single date for slot changes, it repeatedly queries availability for dates N days from today (e.g. 11–15 days out). When a date transitions from "no availability" to "has slots," that's a release event.

### Why

Popular restaurants release reservations on a rolling basis (e.g. "14 days out at 9 AM"). The watcher discovers that cadence by polling and recording exactly when new dates appear.

### Config

Set these in `apps/time-watcher/.env`:

| Var | Meaning | Default |
|-----|---------|---------|
| `VENUE_URL` | OpenTable restaurant URL | *(required)* |
| `PARTY_SIZE` | Party size for queries | *(required)* |
| `PHONE_NUMBER` | For one-time SMS login | *(required)* |
| `LOOKAHEAD_START` | First day offset from today | `11` |
| `LOOKAHEAD_END` | Last day offset from today | `15` |
| `POLL_INTERVAL_MS` | Base delay between polls (ms) | `60000` |
| `POLL_JITTER_MS` | Random jitter ± added to delay (ms) | `20000` |
| `DUMP_FILE` | Append-only JSONL of every request/response | *(optional)* |
| `MAX_POLLS` | Stop after N polls (omit = run forever) | *(optional)* |

### Run

```bash
cd apps/time-watcher && source .env && cd ../.. && pnpm run start:time-watcher
```

### How it works

1. **Bootstrap**: Launches Chrome, logs in (or detects existing session), navigates to the venue to extract `restaurantId`, copies cookies & CSRF token.
2. **Poll loop**: For each cycle, queries the OpenTable `RestaurantsAvailability` GraphQL endpoint once per date in the lookahead range (e.g. today+11 through today+15), with small random gaps between requests.
3. **Dump**: Every request and full response is appended as JSONL to `DUMP_FILE` (if set) for offline analysis.
4. **Detection**: Compares each date's slot set against the previous poll:
   - **`🔔 RELEASE`** — a date went from 0 slots → N slots (restaurant just opened that date)
   - **`∆` change** — slot count changed on an already-open date
   - **`🆕` new date** — a date entered the lookahead window (e.g. after midnight rollover)
   - No output on unchanged dates (quiet by default)
5. **Jitter**: Sleeps `POLL_INTERVAL_MS ± random(POLL_JITTER_MS)` (min 10s) between cycles for a natural request pattern.
6. **Runs until stopped** (Ctrl+C) or `MAX_POLLS` reached.

### Example output

```
╔══════════════════════════════════════════════╗
║      OpenTable Time Watcher (Horizon)       ║
╚══════════════════════════════════════════════╝
  Venue:     https://www.opentable.com/r/le-veau-dor-new-york
  Party:     2
  Watching:  2026-03-06 (+11d), 2026-03-07 (+12d), 2026-03-08 (+13d), 2026-03-09 (+14d), 2026-03-10 (+15d)

[2026-02-23T05:12:26Z] ━━━ Poll #1 ━━━
[2026-02-23T05:12:36Z]   📅 2026-03-06 (today+11): 2 slots
[2026-02-23T05:12:36Z]       11:30
[2026-02-23T05:12:36Z]       11:45
[2026-02-23T05:12:36Z]   📅 2026-03-07 (today+12): no availability
[2026-02-23T05:12:36Z]   📅 2026-03-08 (today+13): no availability
[2026-02-23T05:12:36Z] Baseline established.

[2026-02-23T06:45:12Z] ━━━ Poll #47 ━━━
[2026-02-23T06:45:18Z]   🔔 RELEASE: 2026-03-07 (today+12) — 5 NEW slots appeared!
[2026-02-23T06:45:18Z]       12:00
[2026-02-23T06:45:18Z]       12:30
[2026-02-23T06:45:18Z]       17:30
[2026-02-23T06:45:18Z]       18:00
[2026-02-23T06:45:18Z]       18:30
```

### Dump file format

Each line in the JSONL dump is one request/response pair:

```json
{"ts":"2026-02-23T05:12:27.123Z","date":"2026-03-06","request":{...},"response":{...}}
```

---

## Project structure

```
apps/
  bot/              Reservation bot
    main.ts
    .env
  time-watcher/     Booking horizon watcher
    main.ts
    .env
packages/
  skills/
    puppeteer-core/ Shared browser automation scripts
```
