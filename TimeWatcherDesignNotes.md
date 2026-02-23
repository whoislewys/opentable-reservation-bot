# Time Watcher — Design Notes

## Purpose

**time-watcher** is a small app that repeatedly queries OpenTable availability for a given restaurant over a **short time window** (e.g. one day, one meal window). By observing when the set of available slots **changes**, we can infer when that restaurant “releases” new times (e.g. “they drop at 9:00 AM” or “they extend the window at noon”).

## Goals

- **Deduce release cadence**: Detect the time(s) of day when new slots appear or the slot set changes.
- **Low footprint**: Same restaurant config as the main bot (env vars); no booking, no locking—read-only availability checks.
- **Natural request pattern**: Jitter between requests so polling doesn’t look like a fixed-interval bot.

---

## Config (env vars, same as main.ts)

Read the restaurant and search window from the same env vars used by the bot:

| Var | Meaning | Example |
|-----|--------|--------|
| `VENUE_URL` | OpenTable restaurant URL | `https://www.opentable.com/r/le-veau-dor-new-york` |
| `DATE` | Date to check (YYYY-MM-DD or YYYY:MM:DD) | `2026-03-04` |
| `TIME_EARLIEST` | Start of window (HH:MM) | `12:00` |
| `TIME_LATEST` | End of window (HH:MM) | `20:30` |
| `PARTY_SIZE` | Party size for availability | `2` |
| `PHONE_NUMBER` | Used for one-time login to get cookies/CSRF | (same as bot) |

Optional env for watcher-specific behavior:

| Var | Meaning | Default |
|-----|--------|--------|
| `POLL_INTERVAL_MS` | Base delay between polls (before jitter) | e.g. `60000` (1 min) |
| `POLL_JITTER_MS` | Max random jitter added/subtracted from delay | e.g. `20000` (±20 s) |
| `DUMP_FILE` | Path for append-only request/response dump (optional) | e.g. `./time-watcher-dump.jsonl` |

---

## Request/Response Dump

The watcher should write **every** availability request and its full response to a single file in **append-only** fashion. Each line is one record (e.g. JSONL): timestamp (ISO), request body or summary, and full response body. This allows offline inspection and deduction of exactly when new availability appeared (e.g. by diffing consecutive responses or searching for the first occurrence of a new slot).

- **Format**: One JSON object per line (JSONL), e.g. `{"ts":"...","request":{...},"response":{...}}`.
- **Append-only**: Open file in append mode on each write; no rewriting of history.
- **Future**: This dump can be migrated to SQLite later (e.g. table `availability_polls` with `ts`, `request_json`, `response_json`) for querying, indexing, and deduplication without changing the append-only semantics.

---

## Availability Query Parameters (Getting the “Newest” Availability)

To ensure we observe when a restaurant **releases** new times (e.g. they open the next day or extend the bookable window), the query parameters must capture the **trailing edge** of availability, not just a fixed window.

**Strategy:**

1. **Wide initial window**: Query with a wide range (e.g. full day: `forwardMinutes` from midnight, or from `TIME_EARLIEST` to end of day) so we see all currently available slots.
2. **Find last available slot**: From the response, determine the latest slot (max `timeOffsetMinutes` or latest time) in the returned set.
3. **Next poll: query “from” that edge**: Use the last-available time as the **start** (or `backwardMinutes` / `time` anchor) for the next query so that any newly released slots **after** that time are included. Alternatively, always query with `forwardMinutes` large enough that the window extends past “end of day” or a known max (e.g. 22:00), so that when the restaurant releases more times, they fall inside our window.
4. **Fixed window is still useful**: For a short, fixed window (e.g. 12:00–20:30), we only detect changes *within* that window. To detect “they just opened 21:00 and 21:30,” we must either include 21:00+ in our window or use the “query from last available” approach so the next response includes the new tail.

**Recommendation**: Document in code whether the watcher is in “fixed window” mode (user’s `TIME_EARLIEST`–`TIME_LATEST`) or “trailing edge” mode (query wide, then optionally narrow to “from last slot” on subsequent polls). For release detection, prefer a wide or trailing-edge query so new slots at the end of the bookable range are not missed.

---

## High-Level Flow

1. **Bootstrap (one-time)**  
   - Validate env (date not in past, etc.).  
   - Start browser (same puppeteer-core skills as bot), log in via SMS if needed, navigate to `VENUE_URL`, extract `restaurantId`, then copy cookies and CSRF token.  
   - Option: support reusing an existing browser session / cookie file later to skip login.

2. **Polling loop**  
   - Call the same **RestaurantsAvailability** GQL query as the bot (same variables: date, party size, time window; see *Availability Query Parameters* above for capturing newest availability).  
   - If `DUMP_FILE` is set, append one JSONL record (timestamp, request, full response) to that file.  
   - Normalize response into a **fingerprint** of the current availability:
     - e.g. sorted list of `(timeOffsetMinutes, slotHash)` for slots in `[TIME_EARLIEST, TIME_LATEST]`, or a sorted list of slot hashes, or a hash of that list.  
   - Compare fingerprint to **previous** fingerprint:
     - If **unchanged**: log nothing (or a brief “no change” at debug level).  
     - If **changed**: log **“Release detected at &lt;ISO timestamp&gt;”** and optionally diff (e.g. “+3 slots”, “slots at 18:00, 18:30 added”).  
   - Store current fingerprint as previous for next iteration.

3. **Jitter**  
   - After each request, wait `POLL_INTERVAL_MS + random(-POLL_JITTER_MS, +POLL_JITTER_MS)` (clamped to a min delay, e.g. 10 s) before the next poll.  
   - This makes request spacing less regular and more human-like.

4. **Run until stopped**  
   - Loop until process is killed (e.g. Ctrl+C). Optionally support a `--duration` or `MAX_POLLS` to stop after a set time or count.

---

## Detection Logic

- **Slot set change**: Any change in the set of available slot identifiers (e.g. slot hashes or time+hash) in the configured window counts as a “release” event.  
- **Optional**: Emit structured output (e.g. JSON lines) for later analysis:  
  `{"ts":"2026-02-22T14:32:00.000Z","event":"release","previousCount":5,"currentCount":8,"added":["18:00","18:30","19:00"]}`  

---

## Implementation Notes

- **Reuse bot patterns**: Same `fetchGql`, same RestaurantsAvailability request body and parsing (filter by `TIME_EARLIEST` / `TIME_LATEST`), same puppeteer-core skill calls for start, nav, login, cookies, eval (restaurantId, CSRF).  
- **Shared code**: Initially the watcher can live in `apps/time-watcher` and duplicate or require the minimal pieces (env parsing, fetchGql, availability parsing). A shared `packages/opentable-client` (or similar) can be introduced later to avoid duplication.  
- **Logging**: Console is enough for v1; timestamps in UTC make it easy to correlate with “real” release times.  
- **Errors**: On GQL errors or network failures, log and retry after the same jittered delay instead of exiting (with optional max retries or backoff).

---

## Out of Scope (for now)

- No booking, no slot locking.  
- Persistence is append-only dump file only; migration to SQLite for querying/analysis can be done later.  
- No notification (e.g. Slack/email) on release; can add once the detection is stable.

---

## File Layout

- `apps/time-watcher/package.json` — script `start` runs the watcher (e.g. `tsx main.ts` or `bun main.ts`).  
- `apps/time-watcher/main.ts` — entry: env, bootstrap (browser + auth + cookie copy), then loop: query → append request/response to dump file (if `DUMP_FILE` set) → fingerprint → compare → log if changed → sleep with jitter.  
- `apps/time-watcher/.env.example` — same vars as bot plus optional `POLL_INTERVAL_MS`, `POLL_JITTER_MS`, `DUMP_FILE`.
