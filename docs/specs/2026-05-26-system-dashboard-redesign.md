# System Dashboard Redesign — Design Spec

**Date:** 2026-05-26
**Status:** Approved for planning
**Touches:** `~/dev/token-dashboard/` · `$MCL_Business/infrastructure/scripts/generate_dashboard.py` · `~/Desktop/mcl-agent-orgchart/`

## Problem

The token dashboard's `/system` tab renders `SYSTEM_DASHBOARD.md` as raw markdown in a single card. The Overview tab next to it is a polished, data-driven dashboard (KPI cards, ECharts, drill-downs). The contrast is jarring: the system tab is the most operationally important view (it surfaces escalations, schema drift, agent staleness) but it presents that information as a wall of markdown where critical alerts sit at the bottom under "Flags," while massive cron entries and log tails dominate the middle.

Separately, the Vercel-deployed agent org chart at `~/Desktop/mcl-agent-orgchart/` hardcodes agent session counts (e.g., `"session 33"`) in HTML. It goes stale the moment an agent runs.

Both surfaces want the same underlying truth: which agents exist, how they're organized, and what state they're in.

## Goals

1. Replace the markdown-render approach with a structured, data-driven `/system` tab that matches the polish of the Overview tab.
2. Surface attention-worthy items (escalations, drift, staleness) at the top, with progressive disclosure for detail.
3. Make the agent health view echo the org chart hierarchy, so spatial position carries meaning (e.g., "Chief of Staff is the routing hub and it's amber").
4. Eliminate the org chart's hardcoded session data — drive both surfaces from one source of truth.

## Non-goals

- **Cost / Efficiency section.** The user is on a Max subscription with <60% weekly usage; per-token cost framing is not meaningful right now. Deferred — see §6.
- **Wholesale redesign of the other 7 tabs.** Overview, Prompts, Sessions, Projects, Skills, Tips, Settings are out of scope.
- **Replacing the markdown file.** `SYSTEM_DASHBOARD.md` stays — it's the human-readable terminal artifact. The new JSON sidecar is additive.

## Architecture

```
generate_dashboard.py
  ├──► SYSTEM_DASHBOARD.md                  (unchanged — humans, terminal)
  └──► agents_status.json    ──┐
                               ├──► token-dashboard /system tab    (compact, in-section)
                               └──► mcl-agent-orgchart (Vercel)    (full-page, rich)
```

**One source of truth, two renderers.** `agents_status.json` is the contract. Both the system tab Health section and the Vercel org chart consume it. Each renders for its own context:

- **System tab** — compact tiles, tuned to fit alongside Attention + Activity sections.
- **Vercel org chart** — full-page layout with autonomy phase bar, dormant/retired agents, division headers, callouts.

Decision: separate renderers (not iframe-embedded shared component). Rationale: the two contexts have genuinely different layout demands and iframe sizing is fragile. The discipline that keeps them in sync is the shared schema, not shared code.

## The `agents_status.json` contract

Emitted by `generate_dashboard.py` to the same directory as `SYSTEM_DASHBOARD.md`:

```json
{
  "generated_at": "2026-05-26T03:00:00Z",
  "attention": {
    "escalations": {
      "count": 3,
      "items": [
        { "from_agent": "compliance-agent", "subject": "MAA cross-check Q9 risk-accept", "filename": "esc_2026-05-23.md", "age": "3d" }
      ]
    },
    "schema_drift": {
      "count": 2,
      "items": [
        { "agent": "medstation-hr-agent", "missing": ["autonomy"], "malformed": ["autonomy"] },
        { "agent": "telegram-bridge", "missing": ["autonomy", "session_count"], "malformed": ["autonomy"] }
      ],
      "fix_hint": "Run migrate_agent_versions.py then re-run schema check."
    },
    "stale_agents": {
      "count": 4,
      "threshold_days": 3,
      "items": [
        { "agent": "hr-agent", "last_run_age": "5d 4h", "last_run_iso": "2026-05-20T22:00:00Z" }
      ]
    }
  },
  "activity": {
    "window_days": 7,
    "deliverables": {
      "count": 38,
      "by_agent": [
        { "agent": "medstation-strategy-director", "count": 3, "recent_titles": ["SD_Compass_Priming_Memo_2026-05-25.md", "SD_Saturday_Packet_2026-05-23.md"] }
      ]
    },
    "message_bus": { "inbox": 33, "outbox": 90, "watcher_age_min": 0 },
    "top_producer": { "agent": "medstation-strategy-director", "count": 3, "last_age": "10h" }
  },
  "agents": [
    {
      "name": "chief-of-staff",
      "tier": "csuite",
      "division": null,
      "emoji": "🧠",
      "display_name": "Chief of Staff",
      "phase": 1,
      "last_run_iso": "2026-05-24T21:00:00Z",
      "last_run_age": "1d 6h",
      "freshness": "stale",
      "sessions": 43,
      "open_items": 57,
      "deliverables_7d": 2,
      "schema_ok": true
    },
    ...
  ]
}
```

**Schema notes:**
- `tier` (label) ∈ `chair | csuite | director | venture | worker | infra` — derived from registry numeric `tier` (1/2/3) + `role` field. The Chair (Dr. Lima) is synthetic — not in registry; injected by the generator.
- `division` ∈ `personal | business | cross` — matches the registry value verbatim. Renderers map `cross` to the c-suite row (above the division split).
- `freshness` ∈ `fresh | stale | silent | never` (thresholds: <24h / 1–7d / >7d / never run) — pre-computed server-side so renderers don't disagree
- `last_run_age` is a pre-formatted display string; `last_run_iso` is the canonical timestamp
- Renderers MUST treat unknown enum values as if absent (forward-compat: adding new tiers or freshness levels won't break clients)

## Frontend — `/system` tab redesign

Replaces `web/routes/system.js`. Three sections, in this order:

### 1. Attention

KPI-card grid (3 cards in current data; expandable). Each card has compact face + click-to-expand inline detail.

- **Escalations** — count + "in message bus"
- **Schema drift** — count + "agents with malformed state.json"; expanded view lists each affected agent with what's missing/malformed and a one-line fix hint
- **Stale agents** — count + "no run in >3 days"; expanded view lists agents with last-run timestamps

Card UX:
- Default: closed; chevron `▸` hints at expandability
- Click: card expands inline, `grid-column: 1 / -1` so it spans the row; chevron rotates to `▾`
- Click again or click another card: collapse / swap (only one expanded at a time)
- Severity color on the value (red/amber/green/blue)

### 2. Activity · last 7 days

Same KPI-card pattern, 3 cards:
- **Deliverables shipped** — count + "across N agents"; expanded shows per-agent list with most recent doc titles
- **Message bus throughput** — `inbox in / outbox out` + watcher freshness; expanded shows recent message titles
- **Top producer** — agent name + count + last-shipped age; expanded shows that agent's recent deliverables

### 3. Health · N agents, by org tier

Single card containing an org-shaped agent grid:

- **Layout:** Chair (top, 1 tile) → C-suite (1 row) → divided into Personal / Business columns → workers/ventures within each division → Infra (bottom row)
- **Tile:** ~72px min-width, ~9–10px font. Shows: emoji + name, last-run age, optional badges (open count, phase 2)
- **Visual encoding:**
  - Background tint = freshness (green/amber/red/grey)
  - Border color = tier (gold/purple/blue/pink/green/grey)
  - Status dot inside tile with `box-shadow` glow (stronger glow for silent agents — purely static, no animation)
- **Interactions:**
  - Hover: tooltip with full agent name, last-run absolute time, open-items count
  - Click: navigate to `#/sessions?agent=<name>` (filtered sessions view for that agent) — out of scope to build the filter; the link target can be a stub
- **Legend:** freshness swatches + tier swatches, single row, at the bottom of the card

## Frontend — Vercel org chart (`~/Desktop/mcl-agent-orgchart/`)

Minimal change: replace hardcoded session badges (`"Phase 1 · session 33"`) with values fetched from `agents_status.json`.

- Fetch URL: same-origin `./agents_status.json` (the file is git-pushed into the org-chart repo and deployed alongside the HTML — see §5). No CORS, no auth.
- Fallback: if fetch fails, render with whatever values are in the HTML (current behavior) so the page never breaks
- Add a "last refreshed" footer pulled from `agents_status.generated_at`
- Add freshness coloring on each existing node (subtle — left border accent, not a full restyle) so the standalone page also surfaces stale agents

## Data sync — getting `agents_status.json` to the Vercel page

The org chart is a static Vercel deploy. `~/Desktop/mcl-agent-orgchart/` is **not a git repo** — deploys are manual via the `vercel` CLI (v51.7.0 installed at `/opt/homebrew/bin/vercel`). `agents_status.json` is regenerated nightly by a local cron job. To bridge: extend the existing `0 23 * * *` cron entry that runs `generate_dashboard.py` to also copy the JSON and run a Vercel production deploy.

Sketch:
```bash
python3 $PROJECTS/infrastructure/scripts/generate_dashboard.py
cp $PROJECTS/infrastructure/agents_status.json ~/Desktop/mcl-agent-orgchart/
cd ~/Desktop/mcl-agent-orgchart && vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

Requires: one-time `vercel link` in the org-chart dir (creates `.vercel/project.json` mapping the dir to the existing Vercel project) plus a `VERCEL_TOKEN` available to the cron environment. Both are captured as setup steps in the plan.

Alternative considered: convert the dir to a git repo + connect to Vercel for auto-deploy on push. Rejected for v1 — adds the burden of managing a third git repo for one JSON file. The CLI deploy is one extra line in the cron and reuses the existing Vercel project.

## Backend — token dashboard server

Add new endpoint to `token_dashboard/server.py`:

- **`GET /api/system`** (replaces current markdown-passthrough behavior)
  - Reads `agents_status.json` from the same directory as `SYSTEM_DASHBOARD.md` (resolved via existing `SYSTEM_DASHBOARD_MD` / `PROJECTS` env precedence — JSON sits next to the .md)
  - Returns the JSON directly, plus `{ "source_path": ..., "mtime": ... }` metadata
  - If JSON is missing but `.md` exists: return `{ "configured": true, "fallback": "markdown", "markdown": "...", "mtime": ... }` so the frontend can fall back to the existing markdown renderer (graceful degrade during the transition)
  - If neither exists: same `{ "configured": false, "hint": "..." }` shape the current endpoint uses

The existing markdown-rendering code in `web/routes/system.js` is preserved as a fallback render path for the `fallback: "markdown"` case.

## Generator — `generate_dashboard.py`

Add a new emission step alongside the existing `.md` write:

- Build a Python dict matching the schema in §3
- Serialize to `agents_status.json` next to `SYSTEM_DASHBOARD.md` (atomic write: write to temp, rename)
- Compute `freshness` server-side per the §3 thresholds — never delegate to renderers
- Compute org `tier` and `division` from the existing agent registry (the data is already there to produce the markdown table)

The `.md` emission is unchanged.

## Deferred (re-add later)

**Efficiency section** — token spend, cost per deliverable, Opus→Sonnet right-size $-savings, repeat-file signals framed as cost. Reason: user is on Max subscription with <60% weekly usage; per-token cost has no decision relevance. Re-add trigger: switching to API pay-as-you-go billing, or adopting a hybrid where some agents bill per-token. When re-adding, slot it as the 4th section (after Health). The relevant data is already in the Token Dashboard tables — query `/api/overview` and `/api/by-model` rather than duplicating in `agents_status.json`.

## Out of scope (followups, not blockers)

- Filtered sessions view for a specific agent (the `#/sessions?agent=<name>` link target). Currently sessions tab doesn't support filtering.
- Real-time refresh of `/system` over SSE (currently SSE only fires on token scanner events, not on `agents_status.json` change). Polling on tab-focus is sufficient for v1.
- Mobile layout polish for the org-shaped Health grid (current design assumes >900px width).
- Audit log of what changed since last generation (could be a future "what's new since yesterday" callout).

## Success criteria

1. Opening the `/system` tab, the three most important items in `attention` are visible above the fold without scrolling.
2. Clicking any Attention or Activity card expands inline with detail — no modal, no page navigation.
3. The Health section visually echoes the org chart's tier hierarchy, with each agent's freshness immediately readable.
4. The Vercel org chart's session badges update within 24h of an agent running (nightly cron).
5. If `agents_status.json` is missing, the system tab still renders something useful (markdown fallback or empty-state hint).
6. No new third-party dependencies — vanilla JS, stdlib Python only (respects token-dashboard's existing convention).
