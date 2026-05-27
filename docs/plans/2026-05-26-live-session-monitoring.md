# Live Session Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the token dashboard around live-session monitoring and absolute usage volume; de-emphasize cost.

**Architecture:** Backend extends `/api/sessions` with `is_live` + `heaviness` verdict (computed from existing `files.mtime` and `messages` aggregates) and adds `/api/usage-volume` for 24h/7d/30d bucket KPIs. Frontend rewrites the Overview top to a live-first layout, extends Sessions with a live filter + heaviness column, polls `POST /api/scan` every 15s while on those tabs, and adds a Settings toggle for cost framing.

**Tech Stack:** Python 3.9 stdlib (server), SQLite (existing DB, no schema changes), vanilla JS + ECharts (no build step), unittest.

**Spec:** `docs/specs/2026-05-26-live-session-monitoring-design.md`

---

## File Structure

**Modified:**
- `token_dashboard/db.py` — add `session_live_map()` (path→mtime lookup), augment `recent_sessions()` with live/heaviness fields, add `usage_volume()` for bucket aggregates (Tasks 1–2)
- `token_dashboard/server.py` — wire augmentation into `/api/sessions`, add `/api/usage-volume` route (Task 3)
- `tests/test_server.py` — tests for the new fields and endpoint (Task 3)
- `web/style.css` — live-row outlined cards, pulse animation, `.dim` opacity helper, filter chips, heaviness verdicts (Task 4)
- `web/app.js` — start/stop `setInterval` polling `/api/scan` when route is `/overview` or `/sessions` (Task 5)
- `web/routes/overview.js` — replace top KPI row with live-row + heaviest + usage trio + dimmed 7d totals (Task 6)
- `web/routes/sessions.js` — filter chips, pulse dot, heaviness column (Task 7)
- `web/routes/settings.js` — cost-framing toggle (Task 8)

No new files. No schema changes.

---

## Task 1: DB — `session_live_map()` and live/heaviness augmentation

Adds a helper that maps `session_id → mtime` from the existing `files` table, then a function that augments a `recent_sessions()` result list with `is_live`, `turns`, `cache_read_tokens`, `input_share`, `heaviness`.

**Files:**
- Modify: `~/dev/token-dashboard/token_dashboard/db.py`
- Modify: `~/dev/token-dashboard/tests/test_queries.py`

- [ ] **Step 1: Add failing test for `session_live_map`**

Append to `~/dev/token-dashboard/tests/test_queries.py`:

```python
import os, sqlite3, tempfile, time, unittest
from token_dashboard.db import init_db, session_live_map


class SessionLiveMapTests(unittest.TestCase):
    def test_returns_mtime_keyed_by_session_id(self):
        tmp = tempfile.mkdtemp()
        db = os.path.join(tmp, "t.db")
        init_db(db)
        now = time.time()
        with sqlite3.connect(db) as c:
            c.execute("INSERT INTO files VALUES (?, ?, 0, ?)",
                      ("/p/projects/foo/sess-aaa.jsonl", now - 30, now))
            c.execute("INSERT INTO files VALUES (?, ?, 0, ?)",
                      ("/p/projects/foo/sess-bbb.jsonl", now - 3600, now))
            c.commit()
        m = session_live_map(db)
        self.assertAlmostEqual(m["sess-aaa"], now - 30, places=1)
        self.assertAlmostEqual(m["sess-bbb"], now - 3600, places=1)

    def test_ignores_non_jsonl_paths(self):
        tmp = tempfile.mkdtemp()
        db = os.path.join(tmp, "t.db")
        init_db(db)
        now = time.time()
        with sqlite3.connect(db) as c:
            c.execute("INSERT INTO files VALUES (?, ?, 0, ?)",
                      ("/p/projects/foo/notes.txt", now, now))
            c.commit()
        self.assertEqual(session_live_map(db), {})
```

- [ ] **Step 2: Run, verify fails**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries.SessionLiveMapTests -v
```

Expected: `ImportError: cannot import name 'session_live_map' from 'token_dashboard.db'`.

- [ ] **Step 3: Implement `session_live_map` in `db.py`**

Add after `recent_sessions` (around line 298):

```python
def session_live_map(db_path) -> dict:
    """Return {session_id: mtime} from the files table.

    Session id is the JSONL filename stem; non-.jsonl files are skipped.
    """
    import os
    out = {}
    with connect(db_path) as c:
        for row in c.execute("SELECT path, mtime FROM files"):
            name = os.path.basename(row["path"])
            if not name.endswith(".jsonl"):
                continue
            out[name[:-len(".jsonl")]] = row["mtime"]
    return out
```

- [ ] **Step 4: Run, verify passes**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries.SessionLiveMapTests -v
```

Expected: 2 tests pass.

- [ ] **Step 5: Add failing test for `augment_sessions_with_liveness`**

Append to `~/dev/token-dashboard/tests/test_queries.py`:

```python
from token_dashboard.db import augment_sessions_with_liveness


class AugmentLivenessTests(unittest.TestCase):
    def test_marks_recent_mtime_as_live(self):
        now = time.time()
        rows = [{"session_id": "live-1", "tokens": 100, "turns": 5}]
        out = augment_sessions_with_liveness(
            rows,
            live_map={"live-1": now - 30},
            cache_reads={"live-1": 1_000_000},
            input_shares={"live-1": 0.40},
            now=now,
            live_threshold_seconds=300,
        )
        self.assertTrue(out[0]["is_live"])
        self.assertEqual(out[0]["cache_read_tokens"], 1_000_000)
        self.assertEqual(out[0]["input_share"], 0.40)
        self.assertEqual(out[0]["heaviness"], "healthy")

    def test_marks_old_mtime_as_closed(self):
        now = time.time()
        rows = [{"session_id": "old-1", "tokens": 100, "turns": 5}]
        out = augment_sessions_with_liveness(
            rows, live_map={"old-1": now - 3600},
            cache_reads={}, input_shares={}, now=now, live_threshold_seconds=300,
        )
        self.assertFalse(out[0]["is_live"])
        self.assertEqual(out[0]["heaviness"], "closed")

    def test_heavy_when_turns_over_threshold(self):
        now = time.time()
        rows = [{"session_id": "x", "tokens": 100, "turns": 60}]
        out = augment_sessions_with_liveness(
            rows, live_map={"x": now - 10}, cache_reads={"x": 0},
            input_shares={"x": 0.10}, now=now, live_threshold_seconds=300,
        )
        self.assertEqual(out[0]["heaviness"], "heavy")

    def test_heavy_when_cache_read_over_threshold(self):
        now = time.time()
        rows = [{"session_id": "x", "tokens": 100, "turns": 5}]
        out = augment_sessions_with_liveness(
            rows, live_map={"x": now - 10}, cache_reads={"x": 6_000_000},
            input_shares={"x": 0.10}, now=now, live_threshold_seconds=300,
        )
        self.assertEqual(out[0]["heaviness"], "heavy")

    def test_heavy_when_input_share_over_threshold(self):
        now = time.time()
        rows = [{"session_id": "x", "tokens": 100, "turns": 5}]
        out = augment_sessions_with_liveness(
            rows, live_map={"x": now - 10}, cache_reads={"x": 0},
            input_shares={"x": 0.75}, now=now, live_threshold_seconds=300,
        )
        self.assertEqual(out[0]["heaviness"], "heavy")
```

- [ ] **Step 6: Run, verify fails**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries.AugmentLivenessTests -v
```

Expected: `ImportError: cannot import name 'augment_sessions_with_liveness'`.

- [ ] **Step 7: Implement `augment_sessions_with_liveness`**

Add to `db.py` after `session_live_map`:

```python
HEAVY_TURNS = 50
HEAVY_CACHE_TOKENS = 5_000_000
HEAVY_INPUT_SHARE = 0.60
LIVE_THRESHOLD_SECONDS = 300


def augment_sessions_with_liveness(
    rows: list,
    live_map: dict,
    cache_reads: dict,
    input_shares: dict,
    now: float | None = None,
    live_threshold_seconds: int = LIVE_THRESHOLD_SECONDS,
) -> list:
    """Add is_live / cache_read_tokens / input_share / heaviness fields to each row."""
    import time as _time
    if now is None:
        now = _time.time()
    for r in rows:
        sid = r["session_id"]
        mtime = live_map.get(sid)
        is_live = mtime is not None and (now - mtime) <= live_threshold_seconds
        cache_read = int(cache_reads.get(sid, 0))
        share = float(input_shares.get(sid, 0.0))
        r["is_live"] = is_live
        r["cache_read_tokens"] = cache_read
        r["input_share"] = round(share, 3)
        if not is_live:
            r["heaviness"] = "closed"
        elif (r.get("turns", 0) > HEAVY_TURNS
              or cache_read > HEAVY_CACHE_TOKENS
              or share > HEAVY_INPUT_SHARE):
            r["heaviness"] = "heavy"
        else:
            r["heaviness"] = "healthy"
    return rows
```

- [ ] **Step 8: Add failing test for `session_aggregates` (helper feeding the augmenter)**

Append to `tests/test_queries.py`:

```python
from token_dashboard.db import session_aggregates


class SessionAggregatesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        with sqlite3.connect(self.db) as c:
            # session s1: input 100, output 50, cache_read 500, cache_create 25
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u1', NULL, 's1', 'p', 'user', '2026-01-01', 100, 0, 0, 0, 0)")
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('a1', 'u1', 's1', 'p', 'assistant', '2026-01-01', 0, 50, 500, 25, 0)")
            c.commit()

    def test_cache_reads_and_input_shares_by_session(self):
        cr, isr = session_aggregates(self.db, ["s1"])
        self.assertEqual(cr["s1"], 500)
        # input_share = (input + cache_create) / (input + output + cache_create) = (100+25)/(100+50+25) = 125/175
        self.assertAlmostEqual(isr["s1"], 125 / 175, places=3)

    def test_missing_session_returns_zero(self):
        cr, isr = session_aggregates(self.db, ["nonexistent"])
        self.assertEqual(cr.get("nonexistent", 0), 0)
        self.assertEqual(isr.get("nonexistent", 0.0), 0.0)
```

- [ ] **Step 9: Run, verify fails**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries.SessionAggregatesTests -v
```

Expected: `ImportError: cannot import name 'session_aggregates'`.

- [ ] **Step 10: Implement `session_aggregates`**

Add to `db.py`:

```python
def session_aggregates(db_path, session_ids: list) -> tuple:
    """Per-session (cache_read_tokens, input_share) for the given session_ids.

    Returns ({sid: cache_read_int}, {sid: input_share_float_0_1}).
    """
    if not session_ids:
        return {}, {}
    placeholders = ",".join("?" * len(session_ids))
    sql = f"""
      SELECT session_id,
             SUM(input_tokens) AS i,
             SUM(output_tokens) AS o,
             SUM(cache_read_tokens) AS cr,
             SUM(cache_create_5m_tokens) + SUM(cache_create_1h_tokens) AS cc
        FROM messages
       WHERE session_id IN ({placeholders})
       GROUP BY session_id
    """
    cache_reads, input_shares = {}, {}
    with connect(db_path) as c:
        for row in c.execute(sql, session_ids):
            sid = row["session_id"]
            i = row["i"] or 0
            o = row["o"] or 0
            cr = row["cr"] or 0
            cc = row["cc"] or 0
            denom = i + o + cc
            cache_reads[sid] = cr
            input_shares[sid] = (i + cc) / denom if denom else 0.0
    return cache_reads, input_shares
```

- [ ] **Step 11: Run all new tests, verify pass**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries -v 2>&1 | tail -10
```

Expected: `OK` with all tests passing (~10 new tests).

- [ ] **Step 12: Commit**

```bash
cd ~/dev/token-dashboard && git add token_dashboard/db.py tests/test_queries.py && git commit -m "$(cat <<'EOF'
feat(db): add session_live_map + per-session aggregates + liveness augmentation

Helpers for live-session monitoring: map session_id→mtime from the files
table, aggregate cache_read + input_share per session, then augment a
recent_sessions() result with is_live + heaviness ('heavy' / 'healthy' /
'closed') based on configured thresholds (turns>50, cache_read>5M,
input_share>60%).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: DB — `usage_volume()` bucket aggregates

Returns 24h / 7d / 30d billable-token volumes for the new Usage KPI row.

**Files:**
- Modify: `~/dev/token-dashboard/token_dashboard/db.py`
- Modify: `~/dev/token-dashboard/tests/test_queries.py`

- [ ] **Step 1: Add failing test for `usage_volume`**

Append to `tests/test_queries.py`:

```python
from token_dashboard.db import usage_volume
from datetime import datetime, timedelta, timezone


class UsageVolumeTests(unittest.TestCase):
    def test_bucket_counts_only_within_window(self):
        tmp = tempfile.mkdtemp()
        db = os.path.join(tmp, "t.db")
        init_db(db)
        now = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)
        recent = (now - timedelta(hours=2)).isoformat()
        week_old = (now - timedelta(days=4)).isoformat()
        month_old = (now - timedelta(days=20)).isoformat()
        ancient = (now - timedelta(days=60)).isoformat()
        with sqlite3.connect(db) as c:
            for ts, sess, ttype, i, o, cc in [
                (recent,     "s1", "user",      100, 0,   0),
                (recent,     "s1", "assistant", 0,   200, 50),
                (week_old,   "s2", "user",      300, 0,   0),
                (week_old,   "s2", "assistant", 0,   400, 100),
                (month_old,  "s3", "user",      500, 0,   0),
                (month_old,  "s3", "assistant", 0,   600, 200),
                (ancient,    "s4", "user",      999, 999, 999),
            ]:
                c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES (?, NULL, ?, 'p', ?, ?, ?, ?, 0, ?, 0)",
                          (f"u-{ts}-{sess}-{ttype}", sess, ttype, ts, i, o, cc))
            c.commit()
        v = usage_volume(db, now=now)
        # Billable = input + output + cache_create (cache_read excluded)
        # 24h:  100+200+50 = 350; 1 session; 1 user turn
        # 7d:   24h + (300+400+100) = 1150; 2 sessions; 2 turns
        # 30d:  7d + (500+600+200) = 2450; 3 sessions; 3 turns
        b = {row["window"]: row for row in v["buckets"]}
        self.assertEqual(b["24h"]["tokens"], 350)
        self.assertEqual(b["24h"]["sessions"], 1)
        self.assertEqual(b["24h"]["turns"], 1)
        self.assertEqual(b["7d"]["tokens"], 1150)
        self.assertEqual(b["30d"]["tokens"], 2450)
```

- [ ] **Step 2: Run, verify fails**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries.UsageVolumeTests -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `usage_volume`**

Add to `db.py`:

```python
def usage_volume(db_path, now: "datetime | None" = None) -> dict:
    """Return billable-token volume aggregated into 24h / 7d / 30d buckets."""
    from datetime import datetime, timedelta, timezone
    if now is None:
        now = datetime.now(timezone.utc)
    windows = [("24h", timedelta(hours=24)), ("7d", timedelta(days=7)), ("30d", timedelta(days=30))]
    out = []
    with connect(db_path) as c:
        for label, delta in windows:
            since_iso = (now - delta).isoformat()
            row = c.execute(
                """
                SELECT SUM(input_tokens) + SUM(output_tokens)
                     + SUM(cache_create_5m_tokens) + SUM(cache_create_1h_tokens) AS tokens,
                       COUNT(DISTINCT session_id) AS sessions,
                       SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns
                  FROM messages
                 WHERE timestamp >= ?
                """,
                (since_iso,),
            ).fetchone()
            out.append({
                "window": label,
                "tokens": int(row["tokens"] or 0),
                "sessions": int(row["sessions"] or 0),
                "turns": int(row["turns"] or 0),
            })
    return {"buckets": out}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_queries.UsageVolumeTests -v
```

Expected: 1 test pass.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/token-dashboard && git add token_dashboard/db.py tests/test_queries.py && git commit -m "$(cat <<'EOF'
feat(db): add usage_volume() 24h/7d/30d billable-token buckets

Returns billable-token totals (input + output + cache_create, excluding
cache_read) plus session and turn counts per bucket. Feeds the new
Overview 'Usage volume' KPI row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server — extend `/api/sessions`, add `/api/usage-volume`

Wires the new helpers into HTTP endpoints. `/api/sessions` keeps backward compatibility (existing fields still returned) and gains the four new fields. `/api/usage-volume` is brand new.

**Files:**
- Modify: `~/dev/token-dashboard/token_dashboard/server.py`
- Modify: `~/dev/token-dashboard/tests/test_server.py`

- [ ] **Step 1: Add failing tests in `tests/test_server.py`**

Inside `class ServerTests`:

```python
    def test_sessions_includes_is_live_and_heaviness(self):
        body = json.loads(self._get("/api/sessions?limit=10"))
        self.assertIsInstance(body, list)
        self.assertGreater(len(body), 0)
        s = body[0]
        for field in ("is_live", "turns", "cache_read_tokens", "input_share", "heaviness"):
            self.assertIn(field, s)
        self.assertIn(s["heaviness"], ("heavy", "healthy", "closed"))

    def test_usage_volume_endpoint(self):
        body = json.loads(self._get("/api/usage-volume"))
        self.assertIn("buckets", body)
        labels = [b["window"] for b in body["buckets"]]
        self.assertEqual(labels, ["24h", "7d", "30d"])
        for b in body["buckets"]:
            self.assertIn("tokens", b)
            self.assertIn("sessions", b)
            self.assertIn("turns", b)
```

- [ ] **Step 2: Run, verify fails**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_server.ServerTests.test_sessions_includes_is_live_and_heaviness tests.test_server.ServerTests.test_usage_volume_endpoint -v
```

Expected: 2 failures (missing fields / 404).

- [ ] **Step 3: Update `/api/sessions` handler**

In `~/dev/token-dashboard/token_dashboard/server.py`, find:

```python
            if path == "/api/sessions":
                return _send_json(self, recent_sessions(
                    db_path, limit=_clamp_limit(qs.get("limit", ["20"])[0], 20),
                    since=since, until=until,
                ))
```

Replace with:

```python
            if path == "/api/sessions":
                rows = recent_sessions(
                    db_path, limit=_clamp_limit(qs.get("limit", ["20"])[0], 20),
                    since=since, until=until,
                )
                live_map = session_live_map(db_path)
                sids = [r["session_id"] for r in rows]
                cache_reads, input_shares = session_aggregates(db_path, sids)
                augment_sessions_with_liveness(rows, live_map, cache_reads, input_shares)
                return _send_json(self, rows)
```

- [ ] **Step 4: Add the new `/api/usage-volume` route**

In `server.py`, add right after the `/api/sessions` block:

```python
            if path == "/api/usage-volume":
                return _send_json(self, usage_volume(db_path))
```

- [ ] **Step 5: Update the imports at the top of `server.py`**

Find the existing line that imports from `.db`. Add the new helpers:

```python
from .db import (
    # ... existing imports ...
    session_live_map, session_aggregates, augment_sessions_with_liveness,
    usage_volume,
)
```

(If the file uses individual imports, add `from .db import session_live_map, session_aggregates, augment_sessions_with_liveness, usage_volume` as a separate line.)

- [ ] **Step 6: Run, verify passes**

```bash
cd ~/dev/token-dashboard && python3 -m unittest tests.test_server -v 2>&1 | tail -8
```

Expected: `OK` — original 11 tests + 2 new + 3 from system-tab work = 16 pass.

- [ ] **Step 7: Run full suite for regression**

```bash
cd ~/dev/token-dashboard && python3 -m unittest discover tests 2>&1 | tail -4
```

Expected: `OK` with ~80+ tests pass.

- [ ] **Step 8: Commit**

```bash
cd ~/dev/token-dashboard && git add token_dashboard/server.py tests/test_server.py && git commit -m "$(cat <<'EOF'
feat(server): extend /api/sessions with liveness; add /api/usage-volume

/api/sessions now returns is_live / turns / cache_read_tokens /
input_share / heaviness for each session. /api/usage-volume returns
billable-token volume across 24h / 7d / 30d buckets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend CSS — live row, pulse, dim, filter chips, heaviness verdicts

All visual building blocks the next three frontend tasks will consume.

**Files:**
- Modify: `~/dev/token-dashboard/web/style.css`

- [ ] **Step 1: Append new CSS at the end of `style.css`**

```css
/* live-row KPI cards (Overview) */
.live-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
@media (max-width: 900px) { .live-row { grid-template-columns: repeat(2, 1fr); } }
.live-kpi {
  background: linear-gradient(180deg, rgba(63,182,139,.07), rgba(63,182,139,.02));
  border: 1px solid rgba(63,182,139,.35);
  border-radius: 8px; padding: 14px;
}
.live-kpi .label {
  font-size: 10px; color: var(--good); text-transform: uppercase;
  letter-spacing: 0.08em; font-weight: 600;
  display: flex; align-items: center; gap: 6px;
}
.live-kpi .value {
  font-family: var(--mono); font-size: 22px;
  font-variant-numeric: tabular-nums; line-height: 1.1;
  margin-top: 4px; color: var(--good);
}
.live-kpi .sub { color: var(--muted); font-size: 11px; margin-top: 3px; }
.live-kpi.idle {
  background: var(--panel); border-color: var(--border);
}
.live-kpi.idle .label, .live-kpi.idle .value { color: var(--muted); }

/* pulse dot for live indicators */
.pulse-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--good); box-shadow: 0 0 6px var(--good);
  vertical-align: middle; animation: pulse 1.8s infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* heaviest-live inline list */
.heaviest-list { display: flex; flex-direction: column; gap: 0; }
.heaviest-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0; border-bottom: 1px dashed var(--border);
  font-size: 13px;
}
.heaviest-row:last-child { border-bottom: 0; }
.heaviest-row .sev {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.heaviest-row .sev.heavy { background: var(--warn); box-shadow: 0 0 5px var(--warn); }
.heaviest-row .sev.healthy { background: var(--good); }
.heaviest-row .meta {
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  margin-left: auto;
}

/* dim helper (for de-emphasized historical KPIs) */
.dim { opacity: 0.55; }
.dim:hover { opacity: 1; transition: opacity 200ms; }

/* filter chips (Sessions tab) */
.filter-chips { display: flex; gap: 6px; margin-bottom: 12px; }
.chip {
  background: var(--panel-2); border: 1px solid var(--border);
  color: var(--muted); padding: 4px 12px; border-radius: 4px;
  font-size: 12px; cursor: pointer;
  font-family: var(--sans);
}
.chip:hover { color: var(--text); border-color: var(--border-2); }
.chip.active { color: var(--good); background: rgba(63,182,139,.10); border-color: rgba(63,182,139,.4); }
.chip.active.all { color: var(--text); background: var(--panel-2); border-color: var(--border-2); }

/* heaviness verdict in tables */
.verdict.heavy   { color: var(--warn); font-weight: 600; }
.verdict.healthy { color: var(--good); }
.verdict.closed  { color: var(--muted-2); }
```

- [ ] **Step 2: Verify no syntax breakage by loading any page**

```bash
cd ~/dev/token-dashboard && PORT=8090 python3 cli.py dashboard --no-open --no-scan &
sleep 2
curl -s http://127.0.0.1:8090/web/style.css | tail -5
pkill -f "cli.py dashboard"
```

Expected: prints the last lines of style.css (the new `.verdict.closed` rule). No errors.

- [ ] **Step 3: Commit**

```bash
cd ~/dev/token-dashboard && git add web/style.css && git commit -m "$(cat <<'EOF'
feat(ui): add CSS for live-row KPIs, pulse, dim, filter chips, verdicts

Building blocks consumed by upcoming Overview rewrite and Sessions tab
extension. Live-row cards use a green tint + green border; pulse-dot
animates to convey 'happening now'; .dim drops opacity to 55% (hover
restores). Filter chips have an active state in green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Frontend — live polling lifecycle in `app.js`

When the active route is `/overview` or `/sessions` (or `/sessions/<id>`), poll `POST /api/scan` every 15s. SSE handler already exists and triggers re-render on scan events.

**Files:**
- Modify: `~/dev/token-dashboard/web/app.js`

- [ ] **Step 1: Add live-poll constants and helpers**

At the top of `~/dev/token-dashboard/web/app.js`, after the `state` declaration:

```javascript
const LIVE_REFRESH_MS = 15000;
const LIVE_ROUTES = ['/overview', '/sessions'];

let livePollTimer = null;

function startLivePoll() {
  if (livePollTimer) return;
  livePollTimer = setInterval(() => {
    fetch('/api/scan', { method: 'POST' }).catch(() => {});
  }, LIVE_REFRESH_MS);
}

function stopLivePoll() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

function shouldPollLive(routeKey) {
  return LIVE_ROUTES.includes(routeKey);
}
```

- [ ] **Step 2: Wire start/stop into the existing `render()` function**

Find:

```javascript
async function render() {
  const hash = location.hash.replace(/^#/, '') || '/overview';
  const path = hash.split('?')[0];
  let key = path;
  if (path.startsWith('/sessions/')) key = '/sessions';
  setActiveTab(key);
  const loader = ROUTES[key] || ROUTES['/overview'];
```

Replace with:

```javascript
async function render() {
  const hash = location.hash.replace(/^#/, '') || '/overview';
  const path = hash.split('?')[0];
  let key = path;
  if (path.startsWith('/sessions/')) key = '/sessions';
  setActiveTab(key);
  if (shouldPollLive(key)) startLivePoll();
  else stopLivePoll();
  const loader = ROUTES[key] || ROUTES['/overview'];
```

- [ ] **Step 3: Verify in browser — open dev tools, watch Network**

```bash
cd ~/dev/token-dashboard && PORT=8090 python3 cli.py dashboard --no-open --no-scan &
sleep 2
echo "Open http://127.0.0.1:8090/#/overview in browser; check Network panel for POST /api/scan every 15s"
echo "Then navigate to #/settings; polling should stop"
echo "Press enter to stop server"
read
pkill -f "cli.py dashboard"
```

Expected: while on `/overview` or `/sessions`, a `POST /api/scan` request fires every 15 seconds. Switching to `/settings` stops the polling.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/token-dashboard && git add web/app.js && git commit -m "$(cat <<'EOF'
feat(ui): poll /api/scan every 15s on live tabs

Adds a setInterval lifecycle that fires POST /api/scan every 15 seconds
while the active route is /overview or /sessions (including session
detail). The existing SSE stream picks up the scan event and triggers
re-render. Polling stops automatically when the user navigates away.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend — Overview rewrite (live row + heaviest + usage row + dimmed history)

The biggest frontend change. Restructure the top of Overview around live signals; demote cost.

**Files:**
- Modify: `~/dev/token-dashboard/web/routes/overview.js`

- [ ] **Step 1: Add new fetches at the top of the default export**

In `~/dev/token-dashboard/web/routes/overview.js`, find the existing `Promise.all` and replace it with a version that also fetches the new endpoint and gets unfiltered sessions for the live computation:

```javascript
  const [totals, projects, sessionsRange, sessionsAll, tools, daily, byModel, usage] = await Promise.all([
    api(withSince('/api/overview', since)),
    api(withSince('/api/projects', since)),
    api(withSince('/api/sessions?limit=10', since)),
    api('/api/sessions?limit=50'),            // unfiltered for live computation
    api(withSince('/api/tools', since)),
    api(withSince('/api/daily', since)),
    api(withSince('/api/by-model', since)),
    api('/api/usage-volume'),
  ]);

  // Compute live aggregates from sessionsAll
  const live = sessionsAll.filter(s => s.is_live);
  const liveCacheR = live.reduce((sum, s) => sum + (s.cache_read_tokens || 0), 0);
  const liveTurns = live.reduce((sum, s) => sum + (s.turns || 0), 0);
  const maxInShare = live.reduce((m, s) => Math.max(m, s.input_share || 0), 0);
  const heaviest = live
    .slice()
    .sort((a, b) => (b.input_share || 0) - (a.input_share || 0))
    .slice(0, 3);

  const showCost = localStorage.getItem('td.show_cost') === '1';

  const sessions = sessionsRange;  // alias for existing template references
```

Keep all the existing code that follows (KPI helpers, range tabs, chart rendering) — those still receive `sessions`, `totals`, etc.

- [ ] **Step 2: Build helper to render the Live row**

Add this helper at the top of `overview.js` (after imports):

```javascript
function liveRowHtml(live, liveCacheR, liveTurns, maxInShare) {
  const liveCount = live.length;
  const idleClass = liveCount === 0 ? ' idle' : '';
  const pulse = liveCount > 0 ? '<span class="pulse-dot"></span>' : '';
  const heavyShare = maxInShare > 0.60;
  return `
    <div class="live-row">
      <div class="live-kpi${idleClass}">
        <div class="label">${pulse}Sessions live</div>
        <div class="value">${liveCount}</div>
        <div class="sub">${liveCount === 0 ? 'no live sessions' : 'mtime &lt; 5min'}</div>
      </div>
      <div class="live-kpi${idleClass}">
        <div class="label">Live cache R</div>
        <div class="value">${fmt.compact(liveCacheR)}</div>
        <div class="sub">across live sessions</div>
      </div>
      <div class="live-kpi${idleClass}">
        <div class="label">Live turns</div>
        <div class="value">${fmt.int(liveTurns)}</div>
        <div class="sub">combined</div>
      </div>
      <div class="live-kpi${idleClass}">
        <div class="label">Heaviest in-share</div>
        <div class="value" style="${heavyShare ? 'color:var(--warn)' : ''}">${fmt.pct(maxInShare)}</div>
        <div class="sub">${heavyShare ? 'over 60% threshold' : 'within budget'}</div>
      </div>
    </div>`;
}

function heaviestListHtml(heaviest) {
  if (!heaviest.length) {
    return '<div class="card" style="padding:12px"><span class="muted" style="font-size:12px">No live sessions right now.</span></div>';
  }
  return `
    <div class="card" style="padding:14px">
      <h3 style="margin:0 0 8px;font-size:13px">Heaviest live</h3>
      <div class="heaviest-list">
        ${heaviest.map(s => `
          <div class="heaviest-row">
            <span class="sev ${s.heaviness}"></span>
            <span><a href="#/sessions/${encodeURIComponent(s.session_id)}"><code>${fmt.htmlSafe(s.project_name || s.project_slug)}</code></a>
              · ${s.turns || 0} turns · in-share ${fmt.pct(s.input_share)}</span>
            <span class="meta">${fmt.compact(s.cache_read_tokens)} cache · ${fmt.ts(s.started)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function usageRowHtml(usage) {
  const b = Object.fromEntries((usage.buckets || []).map(x => [x.window, x]));
  const card = (label, key) => `
    <div class="card kpi">
      <div class="label">Tokens ${label}</div>
      <div class="value" title="${fmt.int(b[key]?.tokens || 0)}">${fmt.compact(b[key]?.tokens || 0)}</div>
      <div class="sub">${b[key]?.sessions || 0} sessions · ${b[key]?.turns || 0} turns</div>
    </div>`;
  return `<div class="row cols-3">${card('24h', '24h')}${card('7d', '7d')}${card('30d', '30d')}</div>`;
}
```

- [ ] **Step 3: Replace the existing 7-card top row template with the new layout**

In the `root.innerHTML = ...` block, find the existing structure starting with `<div class="row cols-7">` and ending after the 7-card block. Replace it through to the existing glossary block with:

```javascript
  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Overview</h2>
      <span class="muted" style="font-size:12px">${range.days ? `last ${range.days} days` : 'all time'}</span>
      <div class="spacer"></div>
      ${rangeTabs}
    </div>

    <div style="margin-bottom:14px">
      ${liveRowHtml(live, liveCacheR, liveTurns, maxInShare)}
    </div>

    <div style="margin-bottom:14px">
      ${heaviestListHtml(heaviest)}
    </div>

    <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin:4px 0 8px;font-weight:600">Usage volume</div>
    <div style="margin-bottom:14px">
      ${usageRowHtml(usage)}
    </div>

    <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin:18px 0 8px;font-weight:600">${range.days ? `Last ${range.days} days` : 'All time'}</div>
    <div class="row cols-4 ${showCost ? '' : 'dim'}">
      ${kpi('Sessions', fmt.int(totals.sessions), fmt.int(totals.sessions))}
      ${kpi('Turns', fmt.int(totals.turns), fmt.int(totals.turns))}
      ${kpi('Billable', fmt.compact((totals.input_tokens||0)+(totals.output_tokens||0)+(totals.cache_create_5m_tokens||0)+(totals.cache_create_1h_tokens||0)),
                       fmt.int((totals.input_tokens||0)+(totals.output_tokens||0)+(totals.cache_create_5m_tokens||0)+(totals.cache_create_1h_tokens||0)) + ' tokens')}
      <div class="card kpi cost">
        <div class="label">Est. cost</div>
        <div class="value" title="${fmt.usd(totals.cost_usd)}">${fmt.usd(totals.cost_usd)}</div>
        ${planSubtitle()}
      </div>
    </div>
    ${showCost ? '' : '<div class="muted" style="font-size:10px;margin-top:4px">Cost framing dimmed — toggle in Settings to re-enable.</div>'}

    <details class="card glossary" style="margin-top:16px">
```

(Continue with the rest of the existing template — glossary, charts row, etc. unchanged.)

- [ ] **Step 4: Verify in browser**

```bash
cd ~/dev/token-dashboard && PORT=8090 python3 cli.py dashboard --no-open --no-scan
```

In a separate terminal, open `http://127.0.0.1:8090/#/overview` and check:
- Top row shows 4 green Live KPI cards (or muted if no live sessions). Pulse-dot animates next to "Sessions live" when count > 0.
- "Heaviest live" card lists up to 3 sessions (or "No live sessions" message).
- "Usage volume" section shows 3 cards (24h / 7d / 30d) with bare numbers.
- "Last N days" row shows 4 KPIs at 55% opacity. Hint below: "Cost framing dimmed — toggle in Settings to re-enable."
- Charts below still render.

Stop server with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/token-dashboard && git add web/routes/overview.js && git commit -m "$(cat <<'EOF'
feat(overview): reframe around live signals; dim cost

Top of Overview now shows 4 Live KPI cards (Sessions live / Live cache R
/ Live turns / Heaviest in-share) followed by a 'Heaviest live' inline
list of up to 3 sessions. Below that, a new 'Usage volume' row shows
24h / 7d / 30d token totals. The legacy historical KPI row shrinks
from 7 to 4 cards (Sessions / Turns / Billable / Cost) and is dimmed
to 55% opacity until the cost toggle is re-enabled in Settings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend — Sessions tab filter chips + heaviness column

**Files:**
- Modify: `~/dev/token-dashboard/web/routes/sessions.js`

- [ ] **Step 1: Read the current sessions.js to know what to replace**

```bash
cat ~/dev/token-dashboard/web/routes/sessions.js
```

The existing file fetches sessions, renders a table. The structure is small.

- [ ] **Step 2: Add filter-state read/write helpers and update the renderer**

Replace the contents of `~/dev/token-dashboard/web/routes/sessions.js` with:

```javascript
// sessions.js — list of recent sessions with live filter + heaviness column.
import { api, fmt } from '/web/app.js';

function readFilter() {
  const q = location.hash.split('?')[1] || '';
  const m = /(?:^|&)filter=([^&]+)/.exec(q);
  return m ? decodeURIComponent(m[1]) : 'all';
}

function writeFilter(value) {
  const base = location.hash.replace(/^#/, '').split('?')[0] || '/sessions';
  location.hash = '#' + base + '?filter=' + encodeURIComponent(value);
}

function verdictCell(s) {
  if (s.heaviness === 'heavy') {
    const reasons = [];
    if (s.turns > 50) reasons.push(`${s.turns} turns`);
    if ((s.cache_read_tokens || 0) > 5_000_000) reasons.push(`cache ${fmt.compact(s.cache_read_tokens)}`);
    if ((s.input_share || 0) > 0.60) reasons.push(`in-share ${fmt.pct(s.input_share)}`);
    return `<span class="verdict heavy">⚠ ${fmt.htmlSafe(reasons[0] || 'heavy')}</span>`;
  }
  if (s.heaviness === 'healthy') return '<span class="verdict healthy">✓ healthy</span>';
  return '<span class="verdict closed">○ closed</span>';
}

export default async function (root) {
  const filter = readFilter();
  const all = await api('/api/sessions?limit=50');
  const liveCount = all.filter(s => s.is_live).length;
  const rows = filter === 'live' ? all.filter(s => s.is_live) : all;

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Sessions</h2>
      <div class="spacer"></div>
    </div>

    <div class="filter-chips">
      <button class="chip ${filter === 'live' ? 'active' : ''}" data-filter="live">
        ${liveCount > 0 ? '<span class="pulse-dot" style="margin-right:5px"></span>' : ''}live (${liveCount})
      </button>
      <button class="chip all ${filter === 'all' ? 'active' : ''}" data-filter="all">
        all (${all.length})
      </button>
    </div>

    <div class="card" style="padding:0">
      <table>
        <thead>
          <tr>
            <th style="width:24px"></th>
            <th>session</th>
            <th>project</th>
            <th class="num">turns</th>
            <th class="num">cache r</th>
            <th class="num">in-share</th>
            <th>heavy?</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? `<tr><td colspan="7" class="muted" style="padding:14px">No sessions match this filter.</td></tr>`
            : rows.map(s => `
              <tr>
                <td>${s.is_live ? '<span class="pulse-dot"></span>' : ''}</td>
                <td class="mono"><a href="#/sessions/${encodeURIComponent(s.session_id)}">${fmt.htmlSafe(s.session_id.slice(0, 8))}…</a></td>
                <td>${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
                <td class="num">${fmt.int(s.turns)}</td>
                <td class="num">${fmt.compact(s.cache_read_tokens)}</td>
                <td class="num">${fmt.pct(s.input_share)}</td>
                <td>${verdictCell(s)}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  root.querySelectorAll('.filter-chips .chip').forEach(btn => {
    btn.addEventListener('click', () => writeFilter(btn.dataset.filter));
  });
}
```

- [ ] **Step 3: Verify in browser**

```bash
cd ~/dev/token-dashboard && PORT=8090 python3 cli.py dashboard --no-open --no-scan
```

Visit `http://127.0.0.1:8090/#/sessions`:
- Two filter chips at top: `● live (N)` (green if live count > 0) and `all (N)`
- Table has 7 columns including new `heavy?` column with verdict
- Live sessions have a pulse-dot in the first column
- Heavy sessions show `⚠ <reason>` in amber; healthy live sessions show `✓ healthy`; closed sessions show `○ closed`
- Clicking `live` filters to just live sessions; clicking `all` shows everything; URL updates with `?filter=live` / `?filter=all`

Stop the server.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/token-dashboard && git add web/routes/sessions.js && git commit -m "$(cat <<'EOF'
feat(sessions): add live filter + heaviness column + pulse dot

Filter chips at top of the Sessions tab let you toggle between live
(mtime < 5min) and all. New 'heavy?' column reports the verdict from
/api/sessions: ⚠ <reason> for heavy, ✓ healthy for live below threshold,
○ closed for non-live. Live rows get a pulse dot in the leftmost column.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend — Settings cost-framing toggle

**Files:**
- Modify: `~/dev/token-dashboard/web/routes/settings.js`

- [ ] **Step 1: Read the current settings.js**

```bash
cat ~/dev/token-dashboard/web/routes/settings.js
```

- [ ] **Step 2: Add the toggle UI and wire it to localStorage**

Find a logical place in `settings.js` to insert (likely after the existing plan-selection UI). Add:

```javascript
function costToggleHtml(showCost) {
  return `
    <div class="card" style="margin-top:14px">
      <h3 style="margin:0 0 6px;font-size:13px">Cost framing</h3>
      <p class="muted" style="margin:0 0 10px;font-size:12px">
        Dim the cost KPI on Overview. Useful on Max-plan subscriptions where per-token cost isn't a planning lever.
      </p>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="cost-toggle" ${showCost ? 'checked' : ''}>
        <span>Show cost framing</span>
      </label>
    </div>`;
}
```

In the route's default export, after the existing render call, append the toggle HTML and wire the change handler:

```javascript
  // Append cost-framing toggle
  const showCost = localStorage.getItem('td.show_cost') === '1';
  root.insertAdjacentHTML('beforeend', costToggleHtml(showCost));
  root.querySelector('#cost-toggle').addEventListener('change', e => {
    if (e.target.checked) localStorage.setItem('td.show_cost', '1');
    else localStorage.removeItem('td.show_cost');
    // No automatic re-render; user navigates back to Overview to see effect.
  });
```

If the existing settings.js uses a different render pattern (e.g., returns innerHTML directly), adapt by inserting the toggle in the same flow.

- [ ] **Step 3: Verify in browser**

```bash
cd ~/dev/token-dashboard && PORT=8090 python3 cli.py dashboard --no-open --no-scan
```

Visit `http://127.0.0.1:8090/#/settings`:
- New "Cost framing" card with description and a checkbox
- Toggling the checkbox writes `td.show_cost` to localStorage
- Navigating back to `/overview` shows the historical KPI row at full opacity when checked, dimmed (and hint visible) when unchecked

Stop the server.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/token-dashboard && git add web/routes/settings.js && git commit -m "$(cat <<'EOF'
feat(settings): add cost-framing toggle (default off)

Stored in localStorage as td.show_cost. When off (default), the
historical KPI row on Overview renders with .dim opacity and shows
a one-line 'cost dimmed' hint. When on, full opacity, no hint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **A. Full test suite**

```bash
cd ~/dev/token-dashboard && python3 -m unittest discover tests 2>&1 | tail -4
```

Expected: all tests pass.

- [ ] **B. End-to-end browser walk**

```bash
cd ~/dev/token-dashboard && PORT=8090 python3 cli.py dashboard --no-open
```

Visit `http://127.0.0.1:8090/#/overview`:
1. Live row shows 4 KPI cards (live count > 0 if a Claude session is currently writing)
2. Heaviest list shows up to 3 sessions
3. Usage volume row shows 24h/7d/30d
4. Historical KPI row is dimmed
5. Charts render below

Navigate to `#/sessions`:
1. Filter chips visible at top
2. Table has 7 columns including heavy? verdicts
3. Click `live` filter — table shows only live; URL updates to `?filter=live`

Navigate to `#/settings`:
1. Cost framing card visible at bottom
2. Toggle on → reload `#/overview` → historical KPI row at full opacity, hint gone

Open browser DevTools → Network tab on `#/overview` → confirm `POST /api/scan` fires every 15 seconds. Navigate to `#/settings` → polling stops.

Stop server with Ctrl-C.

- [ ] **C. Success criteria from spec**

1. ✓ Live count, combined cache_read, max input_share visible without clicking
2. ✓ Heaviest live session named in Overview within ~15s of becoming heavy
3. ✓ Sessions tab `live` filter matches files with mtime < 5min
4. ✓ Cost toggle hides framing without losing data
5. ✓ No new third-party deps (stdlib + vanilla JS)
6. ✓ Existing tests + new tests pass
