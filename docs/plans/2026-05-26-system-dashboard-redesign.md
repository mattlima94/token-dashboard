# System Dashboard Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the markdown-rendered `/system` tab with a data-driven dashboard (Attention / Activity / Health) backed by a shared `agents_status.json` that also drives the Vercel-deployed agent org chart.

**Architecture:** `generate_dashboard.py` emits `agents_status.json` next to the existing `SYSTEM_DASHBOARD.md`. The token-dashboard server's `/api/system` endpoint prefers the JSON when present (markdown fallback retained for graceful degrade). A rewritten `web/routes/system.js` renders three sections of KPI cards + an org-shaped agent grid. The Vercel org chart fetches the same JSON same-origin to update session counts and freshness, deployed nightly via `vercel` CLI in cron.

**Tech Stack:** Python 3.9 stdlib (generator + server), vanilla JS (no build step), unittest (server tests), Vercel CLI (org-chart deploy).

**Spec:** `docs/specs/2026-05-26-system-dashboard-redesign.md`

---

## Cross-repo note

Three locations are touched:

| Location | Git? | Commits? |
|---|---|---|
| `~/dev/token-dashboard/` | yes (main branch) | yes — one commit per task |
| `/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts/` | **no** (Google Drive) | no commits; file changes auto-sync via Drive. Verify save with `ls -la` mtime. |
| `~/Desktop/mcl-agent-orgchart/` | **no** | no commits; deploys via `vercel deploy --prod` |

Throughout: `$MCL_BIZ` shorthand = `/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business`. Use the full path in actual commands.

---

## File Structure

**Created:**
- `$MCL_BIZ/infrastructure/scripts/test_generate_dashboard.py` — new unittest file for JSON emission

**Modified:**
- `$MCL_BIZ/infrastructure/scripts/generate_dashboard.py` — add `agents_status.json` emission alongside the existing `.md` write (Tasks 1–4)
- `~/dev/token-dashboard/token_dashboard/server.py` — extend `_resolve_system_dashboard_path` + `/api/system` handler to prefer JSON sidecar with markdown fallback (Task 5)
- `~/dev/token-dashboard/tests/test_server.py` — add tests for `/api/system` JSON / fallback / missing-both branches (Task 5)
- `~/dev/token-dashboard/web/routes/system.js` — full rewrite from markdown renderer to data-driven dashboard (Tasks 6–8)
- `~/dev/token-dashboard/web/style.css` — add styles for system-tab KPI cards, expand interaction, and org-shaped agent grid (Tasks 6–8)
- `~/Desktop/mcl-agent-orgchart/index.html` — fetch `./agents_status.json`, replace hardcoded session badges, add freshness coloring (Task 9)

**Setup (one-time, not a code change):**
- `~/Desktop/mcl-agent-orgchart/.vercel/project.json` — created by `vercel link` (Task 10)
- Cron entry updated to copy JSON + `vercel deploy` (Task 10)

---

## Task 1: Generator — freshness + tier-label helpers

Adds two pure helper functions to `generate_dashboard.py`. Both are pure (input → output) so tests are simple.

**Files:**
- Modify: `$MCL_BIZ/infrastructure/scripts/generate_dashboard.py`
- Create: `$MCL_BIZ/infrastructure/scripts/test_generate_dashboard.py`

- [ ] **Step 1: Create the test file with a failing test for `compute_freshness`**

Create `$MCL_BIZ/infrastructure/scripts/test_generate_dashboard.py`:

```python
import unittest
from datetime import datetime, timedelta, timezone

import generate_dashboard as gd


class FreshnessTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)

    def test_fresh_under_24h(self):
        self.assertEqual(gd.compute_freshness(self.now - timedelta(hours=5), self.now), "fresh")

    def test_stale_1_to_7_days(self):
        self.assertEqual(gd.compute_freshness(self.now - timedelta(days=3), self.now), "stale")

    def test_silent_over_7_days(self):
        self.assertEqual(gd.compute_freshness(self.now - timedelta(days=10), self.now), "silent")

    def test_never_when_none(self):
        self.assertEqual(gd.compute_freshness(None, self.now), "never")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard -v
```

Expected: 4 errors with `AttributeError: module 'generate_dashboard' has no attribute 'compute_freshness'`.

- [ ] **Step 3: Implement `compute_freshness` in `generate_dashboard.py`**

Add this function after `parse_ts` (~line 80) in `generate_dashboard.py`:

```python
def compute_freshness(last_run: datetime | None, now: datetime) -> str:
    """Bucket an agent's last run into a freshness label.

    Thresholds: <24h = fresh, 24h-7d = stale, >7d = silent, None = never.
    """
    if last_run is None:
        return "never"
    age = now - last_run
    if age < timedelta(hours=24):
        return "fresh"
    if age < timedelta(days=7):
        return "stale"
    return "silent"
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard -v
```

Expected: `OK` with 4 tests passing.

- [ ] **Step 5: Add a failing test for `tier_label`**

Append to `test_generate_dashboard.py`:

```python
class TierLabelTests(unittest.TestCase):
    def test_chair_when_role_is_chair(self):
        self.assertEqual(gd.tier_label({"role": "chair", "tier": 0}), "chair")

    def test_csuite_for_tier_1(self):
        self.assertEqual(gd.tier_label({"role": "executive", "tier": 1}), "csuite")
        self.assertEqual(gd.tier_label({"role": "auditor", "tier": 1}), "csuite")

    def test_venture_for_venture_roles(self):
        self.assertEqual(gd.tier_label({"role": "venture-director", "tier": 2}), "venture")
        self.assertEqual(gd.tier_label({"role": "venture-worker", "tier": 3}), "venture")
        self.assertEqual(gd.tier_label({"role": "venture-system", "tier": 3}), "venture")

    def test_infra_for_infra_roles(self):
        self.assertEqual(gd.tier_label({"role": "infrastructure-service", "tier": 3}), "infra")

    def test_director_for_director_roles(self):
        self.assertEqual(gd.tier_label({"role": "director", "tier": 2}), "director")
        self.assertEqual(gd.tier_label({"role": "director-executor", "tier": 2}), "director")
        self.assertEqual(gd.tier_label({"role": "specialist-architect", "tier": 2}), "director")

    def test_worker_for_worker_roles(self):
        self.assertEqual(gd.tier_label({"role": "worker", "tier": 3}), "worker")
        self.assertEqual(gd.tier_label({"role": "app", "tier": 3}), "worker")
```

- [ ] **Step 6: Run the new tests, verify they fail**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.TierLabelTests -v
```

Expected: 6 errors with `AttributeError: module 'generate_dashboard' has no attribute 'tier_label'`.

- [ ] **Step 7: Implement `tier_label` in `generate_dashboard.py`**

Add this function below `compute_freshness`:

```python
def tier_label(agent: dict) -> str:
    """Map a registry agent dict to a display tier label.

    Order matters: 'venture-*' and 'infrastructure-*' roles override tier numbers.
    """
    role = agent.get("role") or ""
    tier = agent.get("tier")
    if role == "chair":
        return "chair"
    if role.startswith("venture-"):
        return "venture"
    if role.startswith("infrastructure-"):
        return "infra"
    if tier == 1:
        return "csuite"
    if tier == 2:
        return "director"
    if tier == 3:
        return "worker"
    return "worker"  # safe default for unknown tier
```

- [ ] **Step 8: Run all tests, verify all pass**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard -v
```

Expected: `OK` with 10 tests passing.

- [ ] **Step 9: Save (no commit — MCL_Business is not a git repo)**

Confirm both files are saved:

```bash
ls -la "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts/generate_dashboard.py" \
       "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts/test_generate_dashboard.py"
```

Expected: both files exist with today's mtime. Google Drive will sync them.

---

## Task 2: Generator — `build_agents_list()` producing the per-agent records

Builds the `agents: [...]` array of `agents_status.json` from the registry + state.json files.

**Files:**
- Modify: `$MCL_BIZ/infrastructure/scripts/generate_dashboard.py`
- Modify: `$MCL_BIZ/infrastructure/scripts/test_generate_dashboard.py`

- [ ] **Step 1: Add a failing test for `build_agents_list`**

Append to `test_generate_dashboard.py`:

```python
import json, os, tempfile
from pathlib import Path
from unittest.mock import patch


class BuildAgentsListTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)
        self.tmp = Path(tempfile.mkdtemp())
        # Minimal fake registry: 2 agents
        self.registry = {
            "agents": [
                {
                    "name": "chief-of-staff", "dir": "infrastructure/agents/chief-of-staff",
                    "tier": 1, "role": "executive", "division": "cross",
                    "status": "active",
                },
                {
                    "name": "hr-agent", "dir": "infrastructure/agents/hr-agent",
                    "tier": 2, "role": "director", "division": "business",
                    "status": "active",
                },
            ]
        }
        # Fake state.json for one agent only — second has no state file
        agent_dir = self.tmp / "infrastructure/agents/chief-of-staff"
        agent_dir.mkdir(parents=True)
        (agent_dir / "state.json").write_text(json.dumps({
            "last_run": "2026-05-25T06:00:00Z",
            "session_count": 43,
            "autonomy": {"phase": 1},
        }))

    def test_includes_chair_synthetic(self):
        agents = gd.build_agents_list(self.registry, self.tmp, self.now)
        names = [a["name"] for a in agents]
        self.assertEqual(names[0], "dr-lima")
        self.assertEqual(agents[0]["tier"], "chair")

    def test_agent_with_state_has_correct_freshness(self):
        agents = gd.build_agents_list(self.registry, self.tmp, self.now)
        cos = next(a for a in agents if a["name"] == "chief-of-staff")
        # 25th 06:00 to 26th 12:00 = 30 hours = stale
        self.assertEqual(cos["freshness"], "stale")
        self.assertEqual(cos["sessions"], 43)
        self.assertEqual(cos["phase"], 1)

    def test_agent_without_state_is_never(self):
        agents = gd.build_agents_list(self.registry, self.tmp, self.now)
        hr = next(a for a in agents if a["name"] == "hr-agent")
        self.assertEqual(hr["freshness"], "never")
        self.assertIsNone(hr["last_run_iso"])

    def test_tier_label_applied(self):
        agents = gd.build_agents_list(self.registry, self.tmp, self.now)
        cos = next(a for a in agents if a["name"] == "chief-of-staff")
        hr = next(a for a in agents if a["name"] == "hr-agent")
        self.assertEqual(cos["tier"], "csuite")
        self.assertEqual(hr["tier"], "director")

    def test_division_passed_through(self):
        agents = gd.build_agents_list(self.registry, self.tmp, self.now)
        cos = next(a for a in agents if a["name"] == "chief-of-staff")
        self.assertEqual(cos["division"], "cross")
```

- [ ] **Step 2: Run the new tests, verify they fail**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.BuildAgentsListTests -v
```

Expected: 5 errors with `AttributeError: module 'generate_dashboard' has no attribute 'build_agents_list'`.

- [ ] **Step 3: Add a `format_age` helper**

Add this function to `generate_dashboard.py` (place near `compute_freshness`):

```python
def format_age(last_run: datetime | None, now: datetime) -> str:
    """Format last-run age as a short human string: '5h', '2d 3h', '36d'."""
    if last_run is None:
        return "never"
    delta = now - last_run
    total_min = int(delta.total_seconds() // 60)
    if total_min < 60:
        return f"{total_min}m"
    total_hr = total_min // 60
    if total_hr < 24:
        return f"{total_hr}h"
    days = total_hr // 24
    hours = total_hr % 24
    return f"{days}d {hours}h" if hours else f"{days}d"
```

- [ ] **Step 4: Implement `build_agents_list`**

Add this function below `tier_label`:

```python
def build_agents_list(registry: dict, projects_root: Path, now: datetime) -> list[dict]:
    """Build the agents[] section of agents_status.json from the registry.

    Prepends a synthetic 'chair' entry for Dr. Lima (the human-in-the-loop).
    """
    out: list[dict] = [{
        "name": "dr-lima",
        "display_name": "Dr. Lima",
        "tier": "chair",
        "division": "cross",
        "role": "chair",
        "status": "active",
        "phase": None,
        "last_run_iso": now.isoformat(),
        "last_run_age": "human",
        "freshness": "fresh",
        "sessions": None,
        "open_items": None,
        "schema_ok": True,
    }]
    for a in registry.get("agents", []):
        state_path = projects_root / a["dir"] / "state.json"
        state = read_state(state_path) or {}
        last_run_str = state.get("last_run")
        last_run_dt = parse_ts(last_run_str)
        autonomy = state.get("autonomy") or {}
        out.append({
            "name": a["name"],
            "display_name": a["name"],  # generator could pretty-print later
            "tier": tier_label(a),
            "division": a.get("division", "cross"),
            "role": a.get("role"),
            "status": a.get("status", "active"),
            "phase": autonomy.get("phase") if isinstance(autonomy, dict) else None,
            "last_run_iso": last_run_dt.isoformat() if last_run_dt else None,
            "last_run_age": format_age(last_run_dt, now),
            "freshness": compute_freshness(last_run_dt, now),
            "sessions": state.get("session_count"),
            "open_items": state.get("open_items_count"),
            "schema_ok": "_error" not in state,
        })
    return out
```

- [ ] **Step 5: Run the tests, verify all pass**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard -v
```

Expected: `OK` with 15 tests passing.

- [ ] **Step 6: Save (no commit)**

```bash
ls -la "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts/generate_dashboard.py"
```

Expected: file exists, today's mtime.

---

## Task 3: Generator — `build_attention()` and `build_activity()` sections

Builds the `attention` (escalations, schema_drift, stale_agents) and `activity` (deliverables, message_bus, top_producer) sections.

**Files:**
- Modify: `$MCL_BIZ/infrastructure/scripts/generate_dashboard.py`
- Modify: `$MCL_BIZ/infrastructure/scripts/test_generate_dashboard.py`

- [ ] **Step 1: Add a failing test for `build_attention`**

Append to `test_generate_dashboard.py`:

```python
class BuildAttentionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)

    def _agents(self, fresh=10, stale=3, silent=2):
        agents = []
        for i in range(fresh):
            agents.append({"name": f"f{i}", "freshness": "fresh", "last_run_age": "5h",
                           "last_run_iso": "2026-05-26T07:00:00Z", "schema_ok": True})
        for i in range(stale):
            agents.append({"name": f"s{i}", "freshness": "stale", "last_run_age": "3d 2h",
                           "last_run_iso": "2026-05-23T10:00:00Z", "schema_ok": True})
        for i in range(silent):
            agents.append({"name": f"x{i}", "freshness": "silent", "last_run_age": "10d",
                           "last_run_iso": "2026-05-16T12:00:00Z", "schema_ok": True})
        return agents

    def test_stale_count_excludes_fresh(self):
        att = gd.build_attention(self._agents(), escalations_dir=None, drift_items=[])
        # stale + silent both count against "stale_agents" (no run in >3 days... actually >24h includes stale)
        # We use "stale_agents" = freshness in {stale, silent}; threshold_days=3 means count = silent only? Or both?
        # Decision: stale_agents.count = agents with freshness in {stale, silent} (i.e., > 24h since run)
        self.assertEqual(att["stale_agents"]["count"], 5)
        names = [it["agent"] for it in att["stale_agents"]["items"]]
        self.assertNotIn("f0", names)

    def test_schema_drift_passthrough(self):
        drift = [{"agent": "telegram-bridge", "missing": ["autonomy"], "malformed": ["autonomy"]}]
        att = gd.build_attention(self._agents(), escalations_dir=None, drift_items=drift)
        self.assertEqual(att["schema_drift"]["count"], 1)
        self.assertEqual(att["schema_drift"]["items"], drift)
        self.assertIn("fix_hint", att["schema_drift"])

    def test_escalations_zero_when_dir_missing(self):
        att = gd.build_attention(self._agents(), escalations_dir=None, drift_items=[])
        self.assertEqual(att["escalations"]["count"], 0)
        self.assertEqual(att["escalations"]["items"], [])

    def test_escalations_counts_files(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "esc_2026-05-23.md").write_text("# Q9 risk-accept")
        (tmp / "esc_2026-05-25.md").write_text("# memo")
        (tmp / "ignored.txt").write_text("not an esc")
        att = gd.build_attention(self._agents(), escalations_dir=tmp, drift_items=[])
        self.assertEqual(att["escalations"]["count"], 2)
```

- [ ] **Step 2: Run the new tests, verify they fail**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.BuildAttentionTests -v
```

Expected: 4 errors with `AttributeError: module 'generate_dashboard' has no attribute 'build_attention'`.

- [ ] **Step 3: Implement `build_attention`**

Add to `generate_dashboard.py`:

```python
def build_attention(agents: list[dict], escalations_dir: Path | None, drift_items: list[dict]) -> dict:
    """Build the 'attention' section: escalations, schema_drift, stale_agents."""
    # Escalations: count *.md files in the escalations dir
    esc_items: list[dict] = []
    esc_count = 0
    if escalations_dir and escalations_dir.is_dir():
        for f in sorted(escalations_dir.glob("*.md")):
            esc_count += 1
            esc_items.append({
                "filename": f.name,
                "subject": f.stem.replace("_", " "),
                "from_agent": None,  # filled in by caller if a sidecar is present
            })

    # Stale agents: anything not fresh and not 'never' (i.e., known last_run >24h ago)
    stale_items = [
        {"agent": a["name"], "last_run_age": a["last_run_age"], "last_run_iso": a["last_run_iso"]}
        for a in agents if a["freshness"] in ("stale", "silent")
    ]

    return {
        "escalations": {"count": esc_count, "items": esc_items},
        "schema_drift": {
            "count": len(drift_items),
            "items": drift_items,
            "fix_hint": "Run migrate_agent_versions.py then re-run schema check.",
        },
        "stale_agents": {
            "count": len(stale_items),
            "threshold_days": 1,
            "items": stale_items,
        },
    }
```

- [ ] **Step 4: Run the tests, verify they pass**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.BuildAttentionTests -v
```

Expected: `OK` with 4 tests passing.

- [ ] **Step 5: Add a failing test for `build_activity`**

Append to `test_generate_dashboard.py`:

```python
class BuildActivityTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)
        self.tmp = Path(tempfile.mkdtemp())

    def test_empty_when_no_deliverables_dir(self):
        act = gd.build_activity(deliverables_by_agent={}, bus_counts={"inbox": 0, "outbox": 0, "watcher_age_min": None})
        self.assertEqual(act["window_days"], 7)
        self.assertEqual(act["deliverables"]["count"], 0)
        self.assertIsNone(act["top_producer"])

    def test_top_producer_is_highest_count(self):
        deliverables = {
            "agent-a": [("doc1.md", "5h")],
            "agent-b": [("doc2.md", "1h"), ("doc3.md", "3h"), ("doc4.md", "1d")],
            "agent-c": [("doc5.md", "12h"), ("doc6.md", "2d")],
        }
        act = gd.build_activity(deliverables_by_agent=deliverables,
                                bus_counts={"inbox": 5, "outbox": 12, "watcher_age_min": 2})
        self.assertEqual(act["deliverables"]["count"], 6)
        self.assertEqual(act["top_producer"]["agent"], "agent-b")
        self.assertEqual(act["top_producer"]["count"], 3)
        self.assertEqual(act["top_producer"]["last_age"], "1h")
        self.assertEqual(act["message_bus"]["inbox"], 5)
```

- [ ] **Step 6: Run the test, verify it fails**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.BuildActivityTests -v
```

Expected: 2 errors with `AttributeError: module 'generate_dashboard' has no attribute 'build_activity'`.

- [ ] **Step 7: Implement `build_activity`**

Add to `generate_dashboard.py`:

```python
def build_activity(deliverables_by_agent: dict[str, list[tuple[str, str]]],
                   bus_counts: dict) -> dict:
    """Build the 'activity' section: deliverables, message_bus, top_producer.

    deliverables_by_agent: {agent_name: [(title, age_str), ...]}
                          List ordered most-recent-first per agent.
    bus_counts: {inbox: int, outbox: int, watcher_age_min: int | None}
    """
    by_agent = []
    total = 0
    for name, items in deliverables_by_agent.items():
        by_agent.append({
            "agent": name,
            "count": len(items),
            "recent_titles": [t for t, _age in items[:3]],
        })
        total += len(items)
    by_agent.sort(key=lambda r: r["count"], reverse=True)

    top = None
    if by_agent:
        top_name = by_agent[0]["agent"]
        top_count = by_agent[0]["count"]
        top_last_age = deliverables_by_agent[top_name][0][1] if deliverables_by_agent[top_name] else None
        top = {"agent": top_name, "count": top_count, "last_age": top_last_age}

    return {
        "window_days": 7,
        "deliverables": {"count": total, "by_agent": by_agent},
        "message_bus": bus_counts,
        "top_producer": top,
    }
```

- [ ] **Step 8: Run all tests, verify all pass**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard -v
```

Expected: `OK` with 21 tests passing.

- [ ] **Step 9: Save (no commit)**

---

## Task 4: Generator — wire `emit_status_json()` into `main()` with atomic write

Existing `generate_dashboard.py` has a `main()` (or top-level code) that writes the `.md` file. Add a JSON write step that uses the helpers from Tasks 1–3. The function reads from real registry / state / escalations / deliverables data already gathered by the existing markdown generator — extract the in-memory data and pass it to the new helpers.

**Files:**
- Modify: `$MCL_BIZ/infrastructure/scripts/generate_dashboard.py`
- Modify: `$MCL_BIZ/infrastructure/scripts/test_generate_dashboard.py`

- [ ] **Step 1: Read the existing `main()` (or equivalent) in `generate_dashboard.py` to identify the data variables already computed**

```bash
grep -n "if __name__\|def main\|OUTPUT\|escalations\|deliverables\|drift" "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts/generate_dashboard.py" | head -30
```

Read the relevant section (likely lines 400–586). Note which local variables in `main()` hold: the registry data, the drift list, escalations directory path, deliverables per agent, message-bus counts.

- [ ] **Step 2: Add a failing test for `emit_status_json` (end-to-end JSON write)**

Append to `test_generate_dashboard.py`:

```python
class EmitStatusJsonTests(unittest.TestCase):
    def test_atomic_write_creates_valid_json(self):
        tmp = Path(tempfile.mkdtemp())
        out_path = tmp / "agents_status.json"
        payload = {
            "generated_at": "2026-05-26T03:00:00Z",
            "attention": {"escalations": {"count": 0, "items": []}},
            "agents": [],
        }
        gd.emit_status_json(out_path, payload)
        # File exists and parses as JSON
        self.assertTrue(out_path.is_file())
        loaded = json.loads(out_path.read_text())
        self.assertEqual(loaded["generated_at"], "2026-05-26T03:00:00Z")
        # No leftover temp file
        leftovers = [p for p in tmp.iterdir() if p.name.startswith(".") or p.suffix == ".tmp"]
        self.assertEqual(leftovers, [])
```

- [ ] **Step 3: Run the test, verify it fails**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.EmitStatusJsonTests -v
```

Expected: 1 error with `AttributeError: module 'generate_dashboard' has no attribute 'emit_status_json'`.

- [ ] **Step 4: Implement `emit_status_json` with atomic write**

Add to `generate_dashboard.py`:

```python
def emit_status_json(out_path: Path, payload: dict) -> None:
    """Write JSON atomically: write to a sibling temp file then rename."""
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str))
    tmp.replace(out_path)  # atomic on POSIX
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard.EmitStatusJsonTests -v
```

Expected: `OK` with 1 test passing.

- [ ] **Step 6: Wire JSON emission into `main()`**

Locate the existing markdown-write line in `generate_dashboard.py` (near the bottom, writing to `OUTPUT`). Immediately after the `.md` write, add:

```python
# JSON sidecar — same directory as the .md, consumed by token-dashboard /system tab and Vercel org chart.
STATUS_JSON = ROOT / "agents_status.json"
try:
    import agent_registry
    registry = agent_registry.load()
except Exception as e:
    registry = {"agents": []}
    print(f"[warn] could not load agent registry: {e}")

now = datetime.now(timezone.utc)
agents_list = build_agents_list(registry, ROOT.parent, now)

# Reuse already-gathered data from the markdown pass. Variable names below assume
# the existing main() exposes these — if not, factor the relevant computation
# into a helper and call it from both the markdown and JSON paths.
status_payload = {
    "generated_at": now.isoformat(),
    "attention": build_attention(
        agents_list,
        escalations_dir=BUS_DIR / "escalations" if (BUS_DIR / "escalations").is_dir() else None,
        drift_items=drift_items,  # list[dict] already computed for the markdown drift section
    ),
    "activity": build_activity(
        deliverables_by_agent=deliverables_by_agent,  # dict already built for the markdown deliverables section
        bus_counts={
            "inbox": inbox_count,    # already computed
            "outbox": outbox_count,  # already computed
            "watcher_age_min": watcher_age_min,  # already computed
        },
    ),
    "agents": agents_list,
}
emit_status_json(STATUS_JSON, status_payload)
print(f"[ok] wrote {STATUS_JSON}")
```

If the variables `drift_items`, `deliverables_by_agent`, `inbox_count`, `outbox_count`, `watcher_age_min` don't exist with these names in the current `main()`, rename them in this snippet to match what's actually there. The shapes are:
- `drift_items`: `list[dict]` like `[{"agent": "...", "missing": [...], "malformed": [...]}]`
- `deliverables_by_agent`: `dict[str, list[tuple[str, str]]]` like `{"cfo-agent": [("CFO_Doc_2026-05-25.md", "1d")]}`
- `inbox_count`, `outbox_count`: `int`
- `watcher_age_min`: `int | None` (minutes since the watcher sentinel was touched)

- [ ] **Step 7: Run the script end-to-end against real data**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business" \
  && python3 infrastructure/scripts/generate_dashboard.py
```

Expected: exits 0, prints `[ok] wrote .../agents_status.json`, both `SYSTEM_DASHBOARD.md` and `agents_status.json` updated in `infrastructure/`.

- [ ] **Step 8: Validate the produced JSON**

```bash
python3 -c "
import json
d = json.load(open('/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/agents_status.json'))
assert 'generated_at' in d
assert 'attention' in d
assert 'activity' in d
assert isinstance(d['agents'], list) and len(d['agents']) >= 20
assert d['agents'][0]['name'] == 'dr-lima'
assert d['agents'][0]['tier'] == 'chair'
print('OK — agents:', len(d['agents']),
      '· stale:', d['attention']['stale_agents']['count'],
      '· deliverables:', d['activity']['deliverables']['count'])
"
```

Expected: prints `OK — agents: NN · stale: N · deliverables: NN`.

- [ ] **Step 9: Re-run all generator tests**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard -v
```

Expected: `OK` with 22 tests passing.

- [ ] **Step 10: Save (no commit)**

---

## Task 5: Server — `/api/system` prefers JSON, falls back to markdown

Backend change in token-dashboard: when `agents_status.json` is present next to `SYSTEM_DASHBOARD.md`, return its parsed contents. When only the `.md` exists, return the markdown (existing behavior, marked as `fallback: "markdown"`). When neither exists, return the existing `configured: false` shape.

**Files:**
- Modify: `~/dev/token-dashboard/token_dashboard/server.py:56–71, 165–182`
- Modify: `~/dev/token-dashboard/tests/test_server.py`

- [ ] **Step 1: Add failing tests for the three branches**

Append to `~/dev/token-dashboard/tests/test_server.py` (inside class `ServerTests`):

```python
    def test_system_returns_json_when_present(self):
        import json as _json
        tmpdir = tempfile.mkdtemp()
        md_path = os.path.join(tmpdir, "SYSTEM_DASHBOARD.md")
        json_path = os.path.join(tmpdir, "agents_status.json")
        open(md_path, "w").write("# legacy")
        _json.dump({"generated_at": "2026-05-26T03:00:00Z", "agents": [{"name": "x"}]},
                   open(json_path, "w"))
        os.environ["SYSTEM_DASHBOARD_MD"] = md_path
        try:
            body = json.loads(self._get("/api/system"))
        finally:
            del os.environ["SYSTEM_DASHBOARD_MD"]
        self.assertTrue(body["configured"])
        self.assertEqual(body.get("fallback"), None)
        self.assertEqual(body["data"]["generated_at"], "2026-05-26T03:00:00Z")
        self.assertEqual(body["data"]["agents"][0]["name"], "x")

    def test_system_falls_back_to_markdown_when_no_json(self):
        tmpdir = tempfile.mkdtemp()
        md_path = os.path.join(tmpdir, "SYSTEM_DASHBOARD.md")
        open(md_path, "w").write("# legacy heading\n\nbody text")
        os.environ["SYSTEM_DASHBOARD_MD"] = md_path
        try:
            body = json.loads(self._get("/api/system"))
        finally:
            del os.environ["SYSTEM_DASHBOARD_MD"]
        self.assertTrue(body["configured"])
        self.assertEqual(body["fallback"], "markdown")
        self.assertIn("legacy heading", body["markdown"])

    def test_system_unconfigured_when_neither_exists(self):
        os.environ["SYSTEM_DASHBOARD_MD"] = "/nonexistent/path.md"
        try:
            body = json.loads(self._get("/api/system"))
        finally:
            del os.environ["SYSTEM_DASHBOARD_MD"]
        self.assertFalse(body["configured"])
```

- [ ] **Step 2: Run the new tests, verify they fail**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_server.ServerTests.test_system_returns_json_when_present tests.test_server.ServerTests.test_system_falls_back_to_markdown_when_no_json tests.test_server.ServerTests.test_system_unconfigured_when_neither_exists -v
```

Expected: 3 failures — at minimum `KeyError: 'data'` for the JSON case and `KeyError: 'fallback'` for the fallback case.

- [ ] **Step 3: Extend `_resolve_system_dashboard_path` to also resolve the JSON sidecar**

Replace the function at `token_dashboard/server.py:56-71` with:

```python
def _resolve_system_dashboard_path() -> Path | None:
    """Resolve the configured system dashboard markdown file.

    Order: SYSTEM_DASHBOARD_MD env → $PROJECTS/infrastructure/SYSTEM_DASHBOARD.md.
    Returns None if unset or the file does not exist.
    """
    raw = os.environ.get("SYSTEM_DASHBOARD_MD")
    if not raw:
        proj = os.environ.get("PROJECTS")
        if proj:
            raw = str(Path(proj) / "infrastructure" / "SYSTEM_DASHBOARD.md")
    if not raw:
        return None
    p = Path(raw).expanduser()
    return p if p.is_file() else None


def _resolve_status_json_path() -> Path | None:
    """Resolve agents_status.json — assumed to sit next to SYSTEM_DASHBOARD.md."""
    md = _resolve_system_dashboard_path()
    if md is None:
        # Allow JSON to exist even if .md doesn't — check the env-derived dir directly.
        raw = os.environ.get("SYSTEM_DASHBOARD_MD")
        if not raw:
            proj = os.environ.get("PROJECTS")
            if proj:
                raw = str(Path(proj) / "infrastructure" / "SYSTEM_DASHBOARD.md")
        if not raw:
            return None
        candidate = Path(raw).expanduser().parent / "agents_status.json"
    else:
        candidate = md.parent / "agents_status.json"
    return candidate if candidate.is_file() else None
```

- [ ] **Step 4: Rewrite the `/api/system` handler in `server.py:165–182`**

Replace the block starting `if path == "/api/system":` with:

```python
            if path == "/api/system":
                json_path = _resolve_status_json_path()
                md_path = _resolve_system_dashboard_path()

                if json_path is not None:
                    try:
                        data = json.loads(json_path.read_text(encoding="utf-8"))
                        mtime = json_path.stat().st_mtime
                    except (OSError, json.JSONDecodeError) as e:
                        return _send_json(self, {
                            "configured": True, "path": str(json_path), "error": str(e),
                        })
                    return _send_json(self, {
                        "configured": True,
                        "path": str(json_path),
                        "mtime": mtime,
                        "data": data,
                    })

                if md_path is not None:
                    try:
                        md = md_path.read_text(encoding="utf-8")
                        mtime = md_path.stat().st_mtime
                    except OSError as e:
                        return _send_json(self, {
                            "configured": True, "path": str(md_path), "error": str(e),
                        })
                    return _send_json(self, {
                        "configured": True,
                        "path": str(md_path),
                        "mtime": mtime,
                        "fallback": "markdown",
                        "markdown": md,
                    })

                return _send_json(self, {
                    "configured": False,
                    "hint": "Set SYSTEM_DASHBOARD_MD (or $PROJECTS) to point at a SYSTEM_DASHBOARD.md file. agents_status.json may sit alongside it.",
                })
```

- [ ] **Step 5: Run the new tests, verify they pass**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_server.ServerTests.test_system_returns_json_when_present tests.test_server.ServerTests.test_system_falls_back_to_markdown_when_no_json tests.test_server.ServerTests.test_system_unconfigured_when_neither_exists -v
```

Expected: `OK` with 3 tests passing.

- [ ] **Step 6: Run the full token-dashboard test suite to check no regressions**

```bash
cd ~/dev/token-dashboard && python3 -m unittest discover tests
```

Expected: `OK` with 71 tests passing (was 68 + 3 new).

- [ ] **Step 7: Commit**

```bash
cd ~/dev/token-dashboard && git add token_dashboard/server.py tests/test_server.py && git commit -m "$(cat <<'EOF'
feat(system): prefer agents_status.json sidecar with markdown fallback

The /api/system endpoint now reads agents_status.json (next to the
existing SYSTEM_DASHBOARD.md) when present and returns its parsed
contents as {data: ...}. Falls back to the markdown rendering path
when the JSON is absent, so the system tab degrades gracefully during
the generator rollout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend — rewrite `system.js` skeleton + Attention section

Begins the system-tab rewrite. Keeps the markdown render path as a fallback render mode for when the API returns `fallback: "markdown"`. Wires up the three section containers and implements only the Attention KPI cards with click-to-expand.

**Files:**
- Modify: `~/dev/token-dashboard/web/routes/system.js` (full rewrite, ~200 lines)
- Modify: `~/dev/token-dashboard/web/style.css` (append system-tab styles)

No JS test framework — verification is loading the tab in a browser.

- [ ] **Step 1: Add system-tab CSS to `web/style.css`**

Append to `~/dev/token-dashboard/web/style.css`:

```css
/* system tab — data-driven dashboard */
.sys-section-h {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.08em; font-weight: 600;
  margin: 22px 0 10px;
}
.sys-section-h:first-child { margin-top: 0; }
.sys-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 900px) { .sys-grid-3 { grid-template-columns: 1fr; } }

.sys-card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 14px; cursor: pointer; position: relative;
  transition: border-color 120ms;
}
.sys-card:hover { border-color: var(--border-2); }
.sys-card.expanded { grid-column: 1 / -1; cursor: default; border-color: var(--border-2); }
.sys-card .chev {
  position: absolute; top: 12px; right: 12px;
  color: var(--muted-2); font-size: 11px;
  transition: transform 120ms;
}
.sys-card.expanded .chev { transform: rotate(90deg); }
.sys-card .l {
  font-size: 10px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.06em; font-weight: 600;
}
.sys-card .v {
  font-family: var(--mono); font-size: 22px;
  font-variant-numeric: tabular-nums; line-height: 1.1;
  margin-top: 4px;
}
.sys-card .sub { color: var(--muted-2); font-size: 11px; margin-top: 3px; }
.sys-card .v.red   { color: var(--bad); }
.sys-card .v.amber { color: var(--warn); }
.sys-card .v.green { color: var(--good); }
.sys-card .v.blue  { color: var(--accent); }

.sys-detail {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.sys-detail .di {
  padding: 6px 0; border-bottom: 1px dashed var(--border);
  display: flex; gap: 8px; align-items: center;
}
.sys-detail .di:last-child { border-bottom: 0; }
.sys-detail .di .dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}
.sys-detail .di .meta {
  font-family: var(--mono); font-size: 11px; color: var(--muted); margin-left: auto;
}
.sys-detail .di .dot.amber { background: var(--warn); }
.sys-detail .di .dot.red   { background: var(--bad); }
.sys-detail .di .dot.green { background: var(--good); }
.sys-detail .fix-hint {
  margin-top: 10px; font-size: 12px; color: var(--muted);
}
```

- [ ] **Step 2: Rewrite `web/routes/system.js`**

Replace the entire contents of `~/dev/token-dashboard/web/routes/system.js` with:

```javascript
// system.js — data-driven dashboard rendering agents_status.json.
// Falls back to the legacy markdown renderer when the API returns fallback: "markdown".
import { api, fmt } from '/web/app.js';

function ageLabel(mtime) {
  const min = Math.round(Date.now() / 1000 - mtime) / 60;
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

function attentionCards(attention) {
  const esc = attention.escalations || { count: 0, items: [] };
  const drift = attention.schema_drift || { count: 0, items: [], fix_hint: '' };
  const stale = attention.stale_agents || { count: 0, items: [] };

  const cards = [
    {
      id: 'escalations',
      label: 'Escalations',
      value: esc.count,
      sub: 'in message bus',
      sev: esc.count > 0 ? 'red' : 'green',
      detail: esc.items.length ? `
        <div class="sys-detail">
          ${esc.items.map(it => `
            <div class="di">
              <span class="dot red"></span>
              <span>${fmt.htmlSafe(it.subject || it.filename)}</span>
              <span class="meta">${fmt.htmlSafe(it.from_agent || '')}</span>
            </div>`).join('')}
        </div>` : '',
    },
    {
      id: 'drift',
      label: 'Schema drift',
      value: drift.count,
      sub: 'agents with malformed state.json',
      sev: drift.count > 0 ? 'amber' : 'green',
      detail: drift.items.length ? `
        <div class="sys-detail">
          ${drift.items.map(it => `
            <div class="di">
              <span class="dot amber"></span>
              <span><code>${fmt.htmlSafe(it.agent)}</code> — missing
                ${(it.missing || []).map(m => `<code>${fmt.htmlSafe(m)}</code>`).join(', ') || '<em>none</em>'}${
                (it.malformed || []).length ? `; malformed ${(it.malformed || []).map(m => `<code>${fmt.htmlSafe(m)}</code>`).join(', ')}` : ''
              }</span>
            </div>`).join('')}
          ${drift.fix_hint ? `<div class="fix-hint">Fix: ${fmt.htmlSafe(drift.fix_hint)}</div>` : ''}
        </div>` : '',
    },
    {
      id: 'stale',
      label: 'Stale agents',
      value: stale.count,
      sub: `no run in >${stale.threshold_days || 1} day(s)`,
      sev: stale.count > 0 ? 'amber' : 'green',
      detail: stale.items.length ? `
        <div class="sys-detail">
          ${stale.items.map(it => `
            <div class="di">
              <span class="dot amber"></span>
              <span><code>${fmt.htmlSafe(it.agent)}</code></span>
              <span class="meta">${fmt.htmlSafe(it.last_run_age)}</span>
            </div>`).join('')}
        </div>` : '',
    },
  ];

  return cards.map(c => `
    <div class="sys-card" data-card="${c.id}">
      ${c.detail ? '<div class="chev">▸</div>' : ''}
      <div class="l">${c.label}</div>
      <div class="v ${c.sev}">${fmt.int(c.value)}</div>
      <div class="sub">${c.sub}</div>
      ${c.detail}
    </div>
  `).join('');
}

function wireCardExpansion(root) {
  root.querySelectorAll('.sys-card').forEach(card => {
    if (!card.querySelector('.sys-detail')) return; // no detail = not expandable
    card.addEventListener('click', () => {
      const wasExpanded = card.classList.contains('expanded');
      root.querySelectorAll('.sys-card.expanded').forEach(c => c.classList.remove('expanded'));
      if (!wasExpanded) card.classList.add('expanded');
    });
  });
}

function renderLegacyMarkdown(root, body) {
  // Minimal fallback — keep the inline markdown renderer simple while we still serve old data.
  const text = body.markdown || '';
  root.innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 12px">System Dashboard <span class="muted" style="font-size:12px;font-weight:400">— markdown fallback</span></h2>
      <p class="muted" style="font-size:12px;margin:-4px 0 12px">
        <code>${fmt.htmlSafe(body.path || '')}</code> · regenerated ${ageLabel(body.mtime)}
      </p>
      <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:12px;border-radius:6px;border:1px solid var(--border)">${fmt.htmlSafe(text)}</pre>
    </div>`;
}

export default async function (root) {
  const body = await api('/api/system');

  if (!body.configured) {
    root.innerHTML = `
      <div class="card">
        <h2>System Dashboard</h2>
        <p class="muted">${fmt.htmlSafe(body.hint || 'Not configured.')}</p>
      </div>`;
    return;
  }
  if (body.error) {
    root.innerHTML = `
      <div class="card">
        <h2>System Dashboard</h2>
        <p class="muted">Failed to read <code>${fmt.htmlSafe(body.path)}</code>: ${fmt.htmlSafe(body.error)}</p>
      </div>`;
    return;
  }
  if (body.fallback === 'markdown') {
    return renderLegacyMarkdown(root, body);
  }

  const data = body.data;
  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">System Dashboard</h2>
      <span class="muted" style="font-size:12px">regenerated ${ageLabel(body.mtime)}</span>
    </div>

    <div class="sys-section-h">Attention</div>
    <div class="sys-grid-3" id="sys-attention">${attentionCards(data.attention || {})}</div>
  `;

  wireCardExpansion(document.getElementById('sys-attention'));
}
```

- [ ] **Step 3: Start the dashboard locally and verify**

```bash
cd ~/dev/token-dashboard && python3 cli.py dashboard --no-open
```

Wait for `Serving on http://127.0.0.1:8080`. In a browser, open `http://127.0.0.1:8080/#/system`.

Expected:
- Header reads "System Dashboard — regenerated Xm ago"
- Three KPI cards in a row: Escalations / Schema drift / Stale agents
- Numeric values with severity colors (red/amber/green)
- Clicking a card with detail expands it inline; chevron rotates; only one expanded at a time

If only the markdown fallback shows, verify the generator ran in Task 4 and `agents_status.json` exists alongside `SYSTEM_DASHBOARD.md`.

Stop the server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
cd ~/dev/token-dashboard && git add web/routes/system.js web/style.css && git commit -m "$(cat <<'EOF'
feat(system): rewrite system tab to render agents_status.json — Attention section

Replaces the markdown-passthrough renderer with a data-driven dashboard.
Adds KPI cards for Escalations / Schema drift / Stale agents with
click-to-expand inline detail. Markdown fallback preserved for when
the JSON sidecar is missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend — Activity section

Adds the second section (Deliverables shipped / Message bus throughput / Top producer) with the same card pattern.

**Files:**
- Modify: `~/dev/token-dashboard/web/routes/system.js`

- [ ] **Step 1: Add `activityCards()` to `system.js`**

In `~/dev/token-dashboard/web/routes/system.js`, add this function below `attentionCards`:

```javascript
function activityCards(activity) {
  const d = activity.deliverables || { count: 0, by_agent: [] };
  const bus = activity.message_bus || { inbox: 0, outbox: 0, watcher_age_min: null };
  const top = activity.top_producer;

  const cards = [
    {
      id: 'deliverables',
      label: `Deliverables shipped (${activity.window_days || 7}d)`,
      valueHtml: fmt.int(d.count),
      sub: `across ${(d.by_agent || []).length} agents`,
      sev: '',
      detail: d.by_agent && d.by_agent.length ? `
        <div class="sys-detail">
          ${d.by_agent.slice(0, 10).map(r => `
            <div class="di">
              <span class="dot green"></span>
              <span><code>${fmt.htmlSafe(r.agent)}</code>
                ${(r.recent_titles || []).slice(0, 2).map(t => `<span class="meta" style="margin-left:8px">${fmt.htmlSafe(fmt.short(t, 50))}</span>`).join('')}
              </span>
              <span class="meta">${r.count} doc${r.count === 1 ? '' : 's'}</span>
            </div>`).join('')}
        </div>` : '',
    },
    {
      id: 'bus',
      label: 'Message bus throughput',
      valueHtml: `${fmt.int(bus.inbox)}<span style="font-size:13px;color:var(--muted)"> in / </span>${fmt.int(bus.outbox)}<span style="font-size:13px;color:var(--muted)"> out</span>`,
      sub: bus.watcher_age_min == null ? 'watcher status unknown'
           : bus.watcher_age_min < 5 ? `watcher ${bus.watcher_age_min}m ago`
           : `watcher ${bus.watcher_age_min}m ago — check`,
      sev: bus.watcher_age_min != null && bus.watcher_age_min > 60 ? 'amber' : '',
      detail: '',
    },
    {
      id: 'top',
      label: 'Top producer',
      valueHtml: top ? `<span style="font-size:14px">${fmt.htmlSafe(top.agent)}</span>` : '<span style="font-size:14px;color:var(--muted)">—</span>',
      sub: top ? `${top.count} doc${top.count === 1 ? '' : 's'} · last ${top.last_age || '—'} ago` : 'no deliverables this window',
      sev: '',
      detail: '',
    },
  ];

  return cards.map(c => `
    <div class="sys-card" data-card="${c.id}">
      ${c.detail ? '<div class="chev">▸</div>' : ''}
      <div class="l">${c.label}</div>
      <div class="v ${c.sev}">${c.valueHtml}</div>
      <div class="sub">${c.sub}</div>
      ${c.detail}
    </div>
  `).join('');
}
```

- [ ] **Step 2: Render the Activity section in the default export**

In `~/dev/token-dashboard/web/routes/system.js`, find the existing `root.innerHTML = ...` template and append the Activity section. Change:

```javascript
    <div class="sys-section-h">Attention</div>
    <div class="sys-grid-3" id="sys-attention">${attentionCards(data.attention || {})}</div>
  `;

  wireCardExpansion(document.getElementById('sys-attention'));
```

to:

```javascript
    <div class="sys-section-h">Attention</div>
    <div class="sys-grid-3" id="sys-attention">${attentionCards(data.attention || {})}</div>

    <div class="sys-section-h">Activity · last ${(data.activity || {}).window_days || 7} days</div>
    <div class="sys-grid-3" id="sys-activity">${activityCards(data.activity || {})}</div>
  `;

  wireCardExpansion(document.getElementById('sys-attention'));
  wireCardExpansion(document.getElementById('sys-activity'));
```

- [ ] **Step 3: Verify in browser**

```bash
cd ~/dev/token-dashboard && python3 cli.py dashboard --no-open
```

Open `http://127.0.0.1:8080/#/system`.

Expected:
- Attention section unchanged
- Below it, "Activity · last 7 days" with three cards (Deliverables / Message bus / Top producer)
- Deliverables card expands to show per-agent breakdown

Ctrl-C the server.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/token-dashboard && git add web/routes/system.js && git commit -m "$(cat <<'EOF'
feat(system): add Activity section to system tab

Adds three cards (Deliverables shipped / Message bus throughput / Top
producer) below Attention, using the same expandable-card pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend — Health section with org-shaped agent grid

Final frontend section. Renders `data.agents[]` arranged by tier (chair → c-suite → divisions → infra), each tile colored by freshness and bordered by tier. Hover shows full agent info.

**Files:**
- Modify: `~/dev/token-dashboard/web/routes/system.js`
- Modify: `~/dev/token-dashboard/web/style.css`

- [ ] **Step 1: Append org-grid CSS to `web/style.css`**

```css
/* org-shaped health grid */
.sys-org { padding: 4px; }
.sys-org-row {
  display: flex; justify-content: center; gap: 8px;
  flex-wrap: wrap; margin-bottom: 6px;
}
.sys-org-conn {
  width: 1px; height: 12px; background: var(--border); margin: 0 auto 6px;
}
.sys-org-divs {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
  margin-top: 8px;
}
@media (max-width: 900px) { .sys-org-divs { grid-template-columns: 1fr; } }
.sys-org-div {
  border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; background: var(--bg);
}
.sys-org-div-h {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  margin-bottom: 6px; text-align: center; font-weight: 600;
}
.sys-org-div-personal .sys-org-div-h { color: #60a5fa; }
.sys-org-div-business .sys-org-div-h { color: #f472b6; }

.sys-ag {
  display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 5px 8px; border-radius: 5px;
  border: 1.5px solid var(--border-2);
  min-width: 78px; cursor: pointer;
  transition: transform 80ms, box-shadow 80ms;
  font-size: 10px; line-height: 1.2;
  text-decoration: none; color: var(--text);
}
.sys-ag:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.4); text-decoration: none; }
.sys-ag .nm { font-weight: 600; font-size: 10px; white-space: nowrap; }
.sys-ag .ts { font-family: var(--mono); font-size: 9px; color: var(--muted); }
.sys-ag .dot { width: 6px; height: 6px; border-radius: 50%; margin-bottom: 1px; }

/* freshness backgrounds + dots */
.sys-ag.fresh  { background: rgba(63,182,139,.10); }
.sys-ag.fresh  .dot { background: var(--good);  box-shadow: 0 0 5px var(--good); }
.sys-ag.stale  { background: rgba(232,162,59,.10); }
.sys-ag.stale  .dot { background: var(--warn);  box-shadow: 0 0 5px var(--warn); }
.sys-ag.silent { background: rgba(229,72,77,.12); }
.sys-ag.silent .dot { background: var(--bad);   box-shadow: 0 0 8px var(--bad); }
.sys-ag.never  { background: rgba(90,101,115,.10); }
.sys-ag.never  .dot { background: var(--muted-2); }

/* tier borders */
.sys-ag.tier-chair    { border-color: #ffd700; }
.sys-ag.tier-csuite   { border-color: #7b68ee; }
.sys-ag.tier-director { border-color: #3b82f6; }
.sys-ag.tier-venture  { border-color: #f472b6; }
.sys-ag.tier-worker   { border-color: #22c55e; }
.sys-ag.tier-infra    { border-color: #94a3b8; }

.sys-org-legend {
  display: flex; gap: 14px; flex-wrap: wrap;
  font-size: 10px; color: var(--muted);
  margin-top: 14px; padding-top: 12px;
  border-top: 1px solid var(--border);
}
.sys-org-legend .sw {
  display: inline-block; width: 8px; height: 8px;
  border-radius: 50%; vertical-align: middle; margin-right: 5px;
}
.sys-org-legend .ts-box {
  display: inline-block; width: 14px; height: 10px;
  border: 1.5px solid; border-radius: 3px;
  vertical-align: middle; margin-right: 5px;
}
```

- [ ] **Step 2: Add `healthGrid()` rendering function to `system.js`**

Add to `~/dev/token-dashboard/web/routes/system.js`, below `activityCards`:

```javascript
function agentTile(a) {
  const tier = a.tier || 'worker';
  const fresh = a.freshness || 'never';
  const title = `${a.display_name || a.name}\nrole: ${a.role || '?'}\nlast run: ${a.last_run_age || 'never'}${a.last_run_iso ? ` (${a.last_run_iso})` : ''}${a.open_items != null ? `\nopen items: ${a.open_items}` : ''}`;
  const meta = [a.last_run_age, a.open_items != null ? `${a.open_items} open` : null, a.phase ? `p${a.phase}` : null]
    .filter(Boolean).join(' · ');
  // Link to a per-agent filtered sessions view (stub target — sessions filter is a followup)
  return `
    <a href="#/sessions?agent=${encodeURIComponent(a.name)}"
       class="sys-ag tier-${tier} ${fresh}" title="${fmt.htmlSafe(title)}">
      <div class="dot"></div>
      <div class="nm">${fmt.htmlSafe(a.display_name || a.name)}</div>
      <div class="ts">${fmt.htmlSafe(meta || '—')}</div>
    </a>`;
}

function healthGrid(agents) {
  const byTierDiv = {
    chair: [],
    csuite: [],
    personal: [], // directors + workers in personal
    business: [], // directors + workers + ventures in business
    infra: [],
  };
  for (const a of agents) {
    if (a.tier === 'chair') byTierDiv.chair.push(a);
    else if (a.tier === 'csuite') byTierDiv.csuite.push(a);
    else if (a.tier === 'infra') byTierDiv.infra.push(a);
    else if (a.division === 'personal') byTierDiv.personal.push(a);
    else if (a.division === 'business' || a.tier === 'venture') byTierDiv.business.push(a);
    else byTierDiv.csuite.push(a); // 'cross' division non-c-suite → c-suite row
  }

  const row = list => list.map(agentTile).join('');

  return `
    <div class="sys-org">
      <div class="sys-org-row">${row(byTierDiv.chair)}</div>
      ${byTierDiv.chair.length && byTierDiv.csuite.length ? '<div class="sys-org-conn"></div>' : ''}
      <div class="sys-org-row">${row(byTierDiv.csuite)}</div>

      ${(byTierDiv.personal.length || byTierDiv.business.length) ? '<div class="sys-org-conn"></div>' : ''}
      <div class="sys-org-divs">
        <div class="sys-org-div sys-org-div-personal">
          <div class="sys-org-div-h">Personal Division</div>
          <div class="sys-org-row">${row(byTierDiv.personal)}</div>
        </div>
        <div class="sys-org-div sys-org-div-business">
          <div class="sys-org-div-h">Business Division</div>
          <div class="sys-org-row">${row(byTierDiv.business)}</div>
        </div>
      </div>

      ${byTierDiv.infra.length ? `
        <div class="sys-org-conn"></div>
        <div class="sys-org-row">${row(byTierDiv.infra)}</div>` : ''}

      <div class="sys-org-legend">
        <span><span class="sw" style="background:var(--good)"></span>fresh (&lt;24h)</span>
        <span><span class="sw" style="background:var(--warn)"></span>stale (1–7d)</span>
        <span><span class="sw" style="background:var(--bad)"></span>silent (&gt;7d)</span>
        <span><span class="sw" style="background:var(--muted-2)"></span>never</span>
        <span style="margin-left:auto"><span class="ts-box" style="border-color:#ffd700"></span>chair</span>
        <span><span class="ts-box" style="border-color:#7b68ee"></span>c-suite</span>
        <span><span class="ts-box" style="border-color:#3b82f6"></span>director</span>
        <span><span class="ts-box" style="border-color:#f472b6"></span>venture</span>
        <span><span class="ts-box" style="border-color:#22c55e"></span>worker</span>
      </div>
    </div>`;
}
```

- [ ] **Step 3: Render the Health section in the default export**

In `~/dev/token-dashboard/web/routes/system.js`, replace the `root.innerHTML = ...` template again, adding the Health section after Activity:

```javascript
  const agents = data.agents || [];
  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">System Dashboard</h2>
      <span class="muted" style="font-size:12px">regenerated ${ageLabel(body.mtime)}</span>
    </div>

    <div class="sys-section-h">Attention</div>
    <div class="sys-grid-3" id="sys-attention">${attentionCards(data.attention || {})}</div>

    <div class="sys-section-h">Activity · last ${(data.activity || {}).window_days || 7} days</div>
    <div class="sys-grid-3" id="sys-activity">${activityCards(data.activity || {})}</div>

    <div class="sys-section-h">Health · ${agents.length} agents, by org tier</div>
    <div class="card" style="cursor:default">${healthGrid(agents)}</div>
  `;

  wireCardExpansion(document.getElementById('sys-attention'));
  wireCardExpansion(document.getElementById('sys-activity'));
```

- [ ] **Step 4: Verify in browser**

```bash
cd ~/dev/token-dashboard && python3 cli.py dashboard --no-open
```

Open `http://127.0.0.1:8080/#/system`.

Expected:
- Three sections: Attention, Activity, Health
- Health renders Dr. Lima at top → CoS + Master Auditor row → two divisions side by side (Personal | Business) → Telegram bridge below
- Tiles colored by freshness, bordered by tier
- Hover shows tooltip with role + last run + open items
- Legend at the bottom shows freshness + tier swatches
- On a screen <900px wide, divisions stack vertically

Ctrl-C the server.

- [ ] **Step 5: Run the full token-dashboard test suite (sanity check no backend regression)**

```bash
cd ~/dev/token-dashboard && python3 -m unittest discover tests
```

Expected: 71 tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/dev/token-dashboard && git add web/routes/system.js web/style.css && git commit -m "$(cat <<'EOF'
feat(system): add Health section with org-shaped agent grid

Renders agents_status.json's agents[] as a tier-organized grid: Chair
on top, C-suite below, then Personal and Business divisions side by
side, Infra at bottom. Tile background = freshness (green/amber/red/grey);
border = tier. Hover surfaces role + open items + absolute last-run time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Vercel org chart — fetch `agents_status.json` + apply session counts + freshness

Update the standalone org chart at `~/Desktop/mcl-agent-orgchart/index.html` to fetch the same JSON contract and replace hardcoded session badges. Adds a subtle freshness border-accent on each existing node.

**Files:**
- Modify: `~/Desktop/mcl-agent-orgchart/index.html`

- [ ] **Step 1: Copy a current `agents_status.json` next to the HTML for local testing**

```bash
cp "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/agents_status.json" \
   ~/Desktop/mcl-agent-orgchart/agents_status.json
```

- [ ] **Step 2: Add a `data-agent` attribute to each agent node in the HTML**

The HTML has hardcoded nodes like:

```html
<div class="node tier-c-suite">
  <div class="title">🧠 Chief of Staff</div>
  ...
  <div class="session-badge">Phase 1 · session 33</div>
  ...
</div>
```

For each agent node (search for `<div class="node tier-...` blocks), add a `data-agent="<registry-name>"` attribute to the outer div. Example:

```html
<div class="node tier-c-suite" data-agent="chief-of-staff">
```

Use the registry names: `chief-of-staff`, `master-auditor`, `personal-secretary`, `financial-advisor`, `health-coach`, `professional-guide`, `real-estate-director`, `cfo-agent`, `chief-marketing-agent`, `compliance-agent`, `hr-agent`, `mso-buildout-agent`, `medstation-analytics-architect`, `medstation-strategy-director`, `medstaff-agent`, `medstation-hr-agent`, `sba-deal-agent`, `real-estate-agent`, `telegram-bridge`.

Confirm the file still parses by opening it in a browser — layout should be unchanged.

- [ ] **Step 3: Add freshness-accent CSS to the `<style>` block**

In `~/Desktop/mcl-agent-orgchart/index.html`, append to the existing `<style>...</style>` block (just before `</style>`):

```css
  /* Freshness accent — overlays the tier border with a left-side color band */
  .node[data-fresh="fresh"]  { box-shadow: inset 4px 0 0 0 #22c55e; }
  .node[data-fresh="stale"]  { box-shadow: inset 4px 0 0 0 #f59e0b; }
  .node[data-fresh="silent"] { box-shadow: inset 4px 0 0 0 #ef4444; }
  .node[data-fresh="never"]  { box-shadow: inset 4px 0 0 0 #71717a; }
  .agents-status-footer {
    text-align: center; margin: 20px 0 -10px;
    font-size: 11px; color: #666;
  }
  .agents-status-footer.stale-warn { color: #fcd34d; }
```

- [ ] **Step 4: Add the fetch + apply script before `</body>`**

In `~/Desktop/mcl-agent-orgchart/index.html`, just before `</body>`, add:

```html
<script>
(async () => {
  let data;
  try {
    const r = await fetch('./agents_status.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    console.warn('[orgchart] live status unavailable, using hardcoded values:', e.message);
    return;
  }

  const byName = Object.fromEntries((data.agents || []).map(a => [a.name, a]));
  for (const node of document.querySelectorAll('[data-agent]')) {
    const name = node.dataset.agent;
    const a = byName[name];
    if (!a) continue;
    node.setAttribute('data-fresh', a.freshness || 'never');
    // Replace the session badge text if present
    const badge = node.querySelector('.session-badge, .phase2-badge');
    if (badge && a.sessions != null) {
      const phase = a.phase != null ? `Phase ${a.phase}` : 'Phase ?';
      badge.textContent = `${phase} · session ${a.sessions}`;
    }
    // Update status line if present
    const status = node.querySelector('.status');
    if (status && a.last_run_age) {
      status.textContent = `last run ${a.last_run_age}${a.open_items != null ? ` · ${a.open_items} open` : ''}`;
    }
  }

  // Footer with regen age
  const genIso = data.generated_at;
  if (genIso) {
    const ageMs = Date.now() - new Date(genIso).getTime();
    const ageHr = Math.round(ageMs / 3600000);
    const ageStr = ageHr < 24 ? `${ageHr}h ago` : `${Math.round(ageHr / 24)}d ago`;
    const footer = document.createElement('div');
    footer.className = 'agents-status-footer' + (ageHr > 36 ? ' stale-warn' : '');
    footer.textContent = `Live status · agents_status.json refreshed ${ageStr}`;
    document.body.appendChild(footer);
  }
})();
</script>
```

- [ ] **Step 5: Verify locally by opening the HTML in a browser**

```bash
open ~/Desktop/mcl-agent-orgchart/index.html
```

Expected:
- Layout unchanged from before
- Each node now has a colored left-edge accent (green/amber/red/grey) per freshness
- Session badges read actual current counts (e.g., "Phase 1 · session 43" for chief-of-staff if that's the current count in `agents_status.json`)
- A new line at the bottom: "Live status · agents_status.json refreshed Xh ago"
- Open DevTools console — should NOT show the "[orgchart] live status unavailable" warning. If it does, check that `agents_status.json` exists in the same directory.

- [ ] **Step 6: Save (no commit — not a git repo). The actual deploy happens in Task 10.**

```bash
ls -la ~/Desktop/mcl-agent-orgchart/index.html ~/Desktop/mcl-agent-orgchart/agents_status.json
```

Expected: both files exist with today's mtime.

---

## Task 10: Cron + Vercel deploy — one-time setup + cron entry update

Wires the production deploy pipeline. One-time `vercel link` to map the local dir to the existing Vercel project, then update the existing `0 23 * * *` cron entry that runs `generate_dashboard.py` to also copy the JSON to the org-chart dir and run `vercel deploy --prod`.

**Files:**
- Modify: user's crontab (`crontab -e`)
- Create: `~/Desktop/mcl-agent-orgchart/.vercel/project.json` (auto-generated by `vercel link`)
- Create: `$MCL_BIZ/infrastructure/scripts/.vercel_token` (or use env in cron) — token storage

**This task involves an interactive step (vercel login) and a shared resource (cron). Recommend executing these steps with the user.**

- [ ] **Step 1: Confirm Vercel CLI is available and you're logged in**

```bash
vercel --version
vercel whoami
```

Expected: prints CLI version (≥51.x) and the user's Vercel account email/handle. If `whoami` errors with "not authenticated":

```bash
vercel login
```

(Interactive — user authenticates in browser.)

- [ ] **Step 2: One-time link of the org-chart dir to its Vercel project**

```bash
cd ~/Desktop/mcl-agent-orgchart && vercel link
```

Interactive prompts: pick the user's scope, then "Link to existing project? Yes" and choose the existing `mcl-agent-orgchart` project (or whatever it's named in Vercel). This creates `~/Desktop/mcl-agent-orgchart/.vercel/project.json`.

Verify:

```bash
cat ~/Desktop/mcl-agent-orgchart/.vercel/project.json
```

Expected: JSON with `projectId` and `orgId` fields.

- [ ] **Step 3: Create or locate a Vercel deploy token**

```bash
echo "Visit https://vercel.com/account/tokens to create a token if you don't have one."
echo "Save the token value securely."
```

User creates token in browser, then stores it. Recommend writing to a file readable only by the user:

```bash
read -s -p "Paste Vercel token: " VTOK
echo "$VTOK" > ~/.vercel_token
chmod 600 ~/.vercel_token
unset VTOK
```

- [ ] **Step 4: Test the deploy command manually**

```bash
cd ~/Desktop/mcl-agent-orgchart && \
  vercel deploy --prod --yes --token "$(cat ~/.vercel_token)"
```

Expected: outputs "Production: https://..." URL. Visit that URL in a browser — should show the org chart with live status and the footer line "Live status · agents_status.json refreshed ...".

- [ ] **Step 5: Update the cron entry**

```bash
crontab -l | grep generate_dashboard
```

Expected: one line like `0 23 * * * source ~/.zshrc && python3 "$PROJECTS/infrastructure/scripts/generate_dashboard.py" >> ...`

Replace that single cron entry with this multi-step version. Open the crontab:

```bash
crontab -e
```

Find the `generate_dashboard.py` line and change it to (preserve whatever log redirection the existing line uses — shown as `>> $LOG 2>&1`):

```cron
0 23 * * * source ~/.zshrc && python3 "$PROJECTS/infrastructure/scripts/generate_dashboard.py" && cp "$PROJECTS/infrastructure/agents_status.json" "$HOME/Desktop/mcl-agent-orgchart/agents_status.json" && cd "$HOME/Desktop/mcl-agent-orgchart" && /opt/homebrew/bin/vercel deploy --prod --yes --token "$(cat $HOME/.vercel_token)" >> $LOG 2>&1
```

Save and exit (`:wq` in vim, Ctrl-X then Y in nano).

Verify the entry was saved:

```bash
crontab -l | grep generate_dashboard
```

Expected: shows the new multi-step entry.

- [ ] **Step 6: Run the whole chain manually to confirm it works end-to-end**

```bash
source ~/.zshrc && \
  python3 "$PROJECTS/infrastructure/scripts/generate_dashboard.py" && \
  cp "$PROJECTS/infrastructure/agents_status.json" "$HOME/Desktop/mcl-agent-orgchart/agents_status.json" && \
  cd "$HOME/Desktop/mcl-agent-orgchart" && \
  /opt/homebrew/bin/vercel deploy --prod --yes --token "$(cat $HOME/.vercel_token)"
```

Expected: dashboard regenerates, JSON copies, Vercel deploys, prints production URL. Visit URL — confirm freshness coloring + footer line update timestamp matches now.

- [ ] **Step 7: No commit needed — crontab and the org-chart dir are not git-tracked. Verify final state:**

```bash
crontab -l | grep generate_dashboard
ls ~/Desktop/mcl-agent-orgchart/.vercel/
test -r ~/.vercel_token && echo "token file present (chmod $(stat -f %p ~/.vercel_token))"
```

Expected: cron entry shows full chain, `.vercel/project.json` exists, token file readable only by user (`100600`).

---

## Final verification

After all 10 tasks land:

- [ ] **A. End-to-end run on real data**

```bash
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business" \
  && python3 infrastructure/scripts/generate_dashboard.py
cd ~/dev/token-dashboard && python3 cli.py dashboard --no-open
```

Visit `http://127.0.0.1:8080/#/system`. Confirm all three sections render with real data.

- [ ] **B. All tests green**

```bash
cd ~/dev/token-dashboard && python3 -m unittest discover tests
cd "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/scripts" \
  && python3 -m unittest test_generate_dashboard
```

Expected: 71 token-dashboard tests pass; 22 generator tests pass.

- [ ] **C. Markdown fallback still works**

Temporarily rename the JSON file and reload the system tab:

```bash
mv "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/agents_status.json" \
   "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/agents_status.json.bak"
```

Reload the page. Expected: falls back to the old markdown rendering with a "markdown fallback" label.

Restore:

```bash
mv "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/agents_status.json.bak" \
   "/Users/mcl-admin/My Drive (drlima@mclhconsulting.com)/MCL_Business/infrastructure/agents_status.json"
```

- [ ] **D. Vercel chart updated**

Visit the production URL. Confirm the footer says "refreshed Xm/h ago" with a recent time.

- [ ] **E. Success criteria checklist (from spec)**

1. Top three Attention items visible above the fold ✓
2. Cards expand inline, no modal ✓
3. Health section echoes org chart hierarchy ✓
4. Vercel org chart updates within 24h of agent run (via nightly cron) ✓
5. System tab still renders with JSON missing (markdown fallback) ✓
6. No new third-party deps (stdlib + vanilla JS) ✓
