# Live Session Monitoring & Token-Management Reframe — Design Spec

**Date:** 2026-05-26
**Status:** Approved for planning
**Touches:** `~/dev/token-dashboard/` (server + frontend)

## Problem

The Overview tab leads with cost KPIs (Est. cost $1,243), but the user is on a Max subscription with <60% weekly usage — per-token cost has no decision relevance. Meanwhile, the questions they actually want answered ("is this session getting too heavy? is cache read ballooning? how much have I burned this week?") aren't surfaced anywhere.

There's no view of currently-running sessions either. A session might be 89 turns deep with a 3.2M cache-read total, but the only way to see that today is to drill into the Sessions tab and parse aggregates by hand.

## Goals

1. Surface live sessions at the top of the dashboard with their running totals.
2. Flag heaviness signals per session (turn count, cache-read size, input-share creep) so the user can decide when to compact or start fresh.
3. Reframe the Overview tab around token management — promote volume/usage signals, demote cost.
4. Extend the Sessions tab with a live filter and heaviness verdicts.

## Non-goals

- **Quota / limit bars.** Anthropic doesn't expose Max-plan quotas via API; `claude --print "/status"` returns "isn't available in this environment". Deferred — see §8.
- **Growth-rate tracking** for cache-read over time. Absolute total catches the same problem cheaply.
- **Alerts / notifications** when a session crosses heaviness thresholds. Visual flagging only.
- **Per-session compaction recommendations.** Just the verdict; the user decides.
- **Removing the historical KPI row.** It stays, dimmed.

## Architecture

```
Existing scanner → SQLite DB (messages, files tables)
                              │
                              ├──► /api/sessions (extended)  ──► Overview live row + Sessions tab
                              └──► /api/overview (unchanged)
       
Frontend polls POST /api/scan every 15s when Overview or Sessions tab is active.
Scanner finds new bytes → fires SSE 'scan' event → frontend re-renders.
```

One backend extension + two frontend tab edits. No new DB tables, no new dependencies.

## API contract — `/api/sessions` extension

Existing response is a list of session summaries. Add four fields per session:

```json
{
  "session_id": "tk-d4a1...",
  "project_slug": "token-dashboard",
  "project_name": "token-dashboard",
  "started": "2026-05-26T18:30:00Z",
  "tokens": 4_120_000,
  "is_live": true,
  "turns": 89,
  "cache_read_tokens": 3_200_000,
  "input_share": 0.68,
  "heaviness": "heavy"
}
```

Field definitions:

- `is_live`: JSONL file `mtime` is within the last `LIVE_THRESHOLD_SECONDS` (default 300 = 5 min). Already tracked by scanner in the `files` table — just compare to `now()`.
- `turns`: count of `messages` rows for this `session_id` where `type = 'user'`.
- `cache_read_tokens`: `SUM(cache_read_tokens)` for this session.
- `input_share`: `(input + cache_create_5m + cache_create_1h) / (input + output + cache_create_5m + cache_create_1h)`. Computed in Python after the SQL aggregate, not in the query (clearer).
- `heaviness`: one of `"heavy" | "healthy" | "closed"`, computed server-side:
  - `closed` if `is_live` is false
  - `heavy` if `turns > HEAVY_TURNS` (default 50) OR `cache_read_tokens > HEAVY_CACHE_TOKENS` (default 5_000_000) OR `input_share > HEAVY_INPUT_SHARE` (default 0.60)
  - `healthy` otherwise

Thresholds live as constants at the top of `token_dashboard/server.py` for now. If they need tuning, promote to `pricing.json` later.

## New endpoint — `/api/usage-volume`

Returns 24h / 7d / 30d token volumes for the new "usage" KPI row:

```json
{
  "buckets": [
    { "window": "24h", "tokens": 142_000_000, "sessions": 4, "turns": 89 },
    { "window": "7d",  "tokens": 1_400_000_000, "sessions": 142, "turns": 3219 },
    { "window": "30d", "tokens": 4_800_000_000, "sessions": 487, "turns": 11_402 }
  ]
}
```

`tokens` is billable total (input + output + cache_create), excluding cache_read (cache_read shown separately if needed). Computed via simple `SUM(...) WHERE timestamp >= ?` for each window.

## Frontend — Overview rewrite

Current top row: 7 KPI cards (Sessions / Turns / Input / Output / Cache read / Cache create / Est. cost).

New layout, top to bottom:

1. **Live now** (4 KPI cards, prominent — green outlined cards, pulsing dot):
   - `Sessions live` (count of `is_live === true`)
   - `Live cache R` (sum of cache_read_tokens across live sessions)
   - `Live turns` (sum of turns across live sessions)
   - `Heaviest in-share` (max `input_share` across live sessions, percentage)

2. **Heaviest live** (single card listing up to 3 live sessions, severity dot + name + verdict + age):
   - Severity dot color: amber if `heavy`, green if `healthy`
   - Click row → drill into Sessions tab session detail

3. **Usage volume** (3 KPI cards, neutral — replaces the old "Input/Output/Cache" trio):
   - `Tokens 24h` — billable volume in last 24h
   - `Tokens 7d` — billable volume in last 7d
   - `Tokens 30d` — billable volume in last 30d
   - Each card shows the bare number; no bar, no cap reference

4. **7d totals** (existing 4 KPI cards, dimmed at 50% opacity):
   - Sessions / Turns / Billable / Est. cost
   - Apply `.dim` class — visible but de-emphasized
   - Subtle line below: "Cost dimmed — on Max subscription; toggle in Settings to re-enable"

5. **Charts** (unchanged): daily work bars, by-model donut, by-project, by-tool, recent sessions table.

The range-tabs (7d/30d/90d/all) continue to apply to the totals + charts. Live row and Usage row ignore the range — they have their own implicit windows.

## Frontend — Sessions tab extension

Current Sessions tab: table of recent sessions. Add:

- **Filter chips at top:** `● live (N)` (green) and `all (N)`. Active chip highlighted. Default = `all`. Clicking `live` filters the table to `is_live === true`.
- **New `heavy?` column** at the right of the table. Shows:
  - `⚠ heavy · in-share 68%` (or whichever signal tripped — pick the most extreme) in amber
  - `✓ healthy` in green for live sessions below thresholds
  - `✓ closed` in muted for non-live (status, not concern)
- **Pulse dot** in the first column for live sessions (matches the live indicator everywhere else).

Sort retains current behavior (most recent first). The filter is purely visual on the existing list — no new API call needed since `is_live` is already in the response.

## Live refresh mechanism

Today: scanner runs on `POST /api/scan`. SSE fires a `scan` event on completion. Frontend re-renders on that event.

For live data: when the active route is `/overview` or `/sessions` (or `/sessions/<id>`), the frontend starts a `setInterval` that calls `POST /api/scan` every **15 seconds**. Existing SSE handler picks up the result and triggers re-render. When the user leaves those routes, `clearInterval` stops the polling.

Implementation: in `app.js`, on `hashchange`, check if the new route needs live data. If yes and no interval is running, start one. If no and an interval is running, clear it. One interval at a time, scoped to the relevant routes only.

15s is a balance: tight enough to feel live (most turns take >15s), loose enough not to thrash the scanner. Configurable as `LIVE_REFRESH_MS` constant in `app.js`.

## Settings — cost toggle

Add one row to the Settings tab: `[ ] Show cost framing` checkbox, default off for Max plan users. When off:
- Overview's "Est. cost" KPI is dimmed (`.dim` class).
- The "Cost dimmed" hint shows below the 7d totals row.

When on:
- Cost KPI renders at full opacity.
- Hint hidden.

Stored as `td.show_cost` in localStorage. Re-renders on toggle. No backend change.

## Deferred (re-add when feasible)

**Quota / limit bars** (24h / 7d / 30d "X% of limit" with progress bars). Reason: no programmatic way to learn Max-plan quotas — `claude --print "/status"` returns "isn't available in this environment"; no cached quota file in `~/.claude/`; no public Anthropic API for plan quotas.

Re-add triggers (any one):
- Anthropic ships a quota endpoint on the API
- Claude Code exposes `/status` data via a non-interactive command or a cached file (e.g., `~/.claude/quota_status.json` written periodically)
- User opts in to a manual-caps workflow despite the maintenance burden

When re-adding: extend `/api/usage-volume` with optional `limit` fields per bucket. Frontend renders a progress bar inside each Usage KPI card when `limit` is present.

## Out of scope (followups, not blockers)

- Growth-rate timeline for cache-read (e.g., "+850K cache reads in last 10 turns"). Requires per-turn timeline storage and a sparkline. Worth revisiting if "session got heavy fast" turns into a real diagnostic need.
- Heaviness alerting (notification when a live session crosses a threshold).
- Per-session compaction tips inline ("This session is 89 turns — consider /compact"). The Tips engine could grow a "running session" tip later.
- Cross-session aggregation of "live" (e.g., parallel sessions in different projects). The cards in §5.1 already aggregate; no extra view needed.

## Success criteria

1. Opening the Overview tab, you can see at a glance how many sessions are running, their combined cache-read total, and which one has the highest input share — without clicking anything.
2. The heaviest live session is named in the Overview within 3 seconds of being heavy (limited by 15s poll cadence plus scanner latency).
3. The Sessions tab's `live` filter shows exactly the sessions that wrote to disk in the last 5 minutes; the `heavy?` column verdict matches the thresholds in §4.
4. Cost framing can be toggled off in Settings without losing any cost data — the values are still computed, just visually de-emphasized.
5. No new third-party dependencies; vanilla JS + stdlib Python (respects existing convention).
6. No regression on existing token-dashboard tests; new tests cover `is_live`, `heaviness` enum, and `/api/usage-volume` bucket math.
