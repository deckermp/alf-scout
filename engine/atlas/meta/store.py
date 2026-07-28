"""Durable state: runs, verdicts, lessons, promotions.

SQLite because the audit trail matters more than the throughput. Every table here is
append-mostly; a lesson is never edited, only superseded or quarantined, so the history
of what the pipeline was taught survives.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..schema import Verdict, utcnow

DB_PATH = Path(os.environ.get("ATLAS_DB", Path(__file__).resolve().parents[2] / "data" / "atlas.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, zip TEXT, policy_version TEXT, started_at TEXT,
    finished_at TEXT, payload TEXT, mean_coverage REAL, agentic INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, facility_id TEXT, field TEXT,
    action TEXT, before TEXT, after TEXT, note TEXT, reviewer TEXT, at TEXT,
    consumed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lessons (
    lesson_id TEXT PRIMARY KEY, kind TEXT, node TEXT, payload TEXT, rationale TEXT,
    evidence TEXT, created_at TEXT, status TEXT DEFAULT 'proposed',
    gate_report TEXT, promoted_at TEXT
);
CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_version TEXT, to_version TEXT,
    decision TEXT, report TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS overrides (
    facility_id TEXT, field TEXT, value TEXT, note TEXT, at TEXT,
    PRIMARY KEY (facility_id, field)
);
"""


@contextmanager
def conn() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    try:
        c.executescript(SCHEMA)
        yield c
        c.commit()
    finally:
        c.close()


# ---------------------------------------------------------------- runs

def save_run(result: Any) -> None:
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?)",
            (
                result.run_id,
                result.zip,
                result.policy_version,
                result.started_at,
                result.finished_at,
                result.model_dump_json(),
                result.mean_coverage,
                int(result.agentic_enabled),
            ),
        )


def get_run(run_id: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return dict(r) if r else None


def list_runs(limit: int = 50) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT run_id, zip, policy_version, started_at, mean_coverage, agentic "
            "FROM runs ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


# ------------------------------------------------------------ verdicts

def add_verdicts(verdicts: list[Verdict]) -> int:
    with conn() as c:
        for v in verdicts:
            c.execute(
                "INSERT INTO verdicts (run_id, facility_id, field, action, before, after, note, reviewer, at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    v.run_id,
                    v.facility_id,
                    v.field,
                    v.action,
                    json.dumps(v.before, default=str),
                    json.dumps(v.after, default=str),
                    v.note,
                    v.reviewer,
                    v.at,
                ),
            )
    return len(verdicts)


def set_override(facility_id: str, field: str, value: Any, note: str) -> None:
    """Persist what a human actually established, so the next run of this ZIP does not
    quietly discard it.

    The value stored is the *resulting cell value*, not the verdict payload. For a
    rejection those differ: the payload names what to remove, the result is what remains.
    Storing the payload here is how a reject silently turns a list of ACO links into a
    list of ACO ids.
    """
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO overrides VALUES (?,?,?,?,?)",
            (facility_id, field, json.dumps(value, default=str), note, utcnow()),
        )


def unconsumed_verdicts(limit: int = 200) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM verdicts WHERE consumed=0 ORDER BY id ASC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def mark_consumed(ids: list[int]) -> None:
    if not ids:
        return
    with conn() as c:
        c.executemany("UPDATE verdicts SET consumed=1 WHERE id=?", [(i,) for i in ids])


def all_verdicts(limit: int = 500) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT * FROM verdicts ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


def overrides_for(facility_ids: list[str]) -> dict[tuple[str, str], dict]:
    if not facility_ids:
        return {}
    qs = ",".join("?" * len(facility_ids))
    with conn() as c:
        rows = c.execute(f"SELECT * FROM overrides WHERE facility_id IN ({qs})", facility_ids).fetchall()
    out = {}
    for r in rows:
        try:
            val = json.loads(r["value"])
        except json.JSONDecodeError:
            val = r["value"]
        out[(r["facility_id"], r["field"])] = {"value": val, "note": r["note"], "at": r["at"]}
    return out


# ------------------------------------------------------------- lessons

def add_lesson(kind: str, node: str, payload: dict, rationale: str, evidence: list) -> str:
    lid = "L" + uuid.uuid4().hex[:10]
    with conn() as c:
        c.execute(
            "INSERT INTO lessons (lesson_id, kind, node, payload, rationale, evidence, created_at, status) "
            "VALUES (?,?,?,?,?,?,?,'proposed')",
            (lid, kind, node, json.dumps(payload), rationale, json.dumps(evidence, default=str), utcnow()),
        )
    return lid


def lessons(status: str | None = None) -> list[dict]:
    with conn() as c:
        if status:
            rows = c.execute(
                "SELECT * FROM lessons WHERE status=? ORDER BY created_at ASC", (status,)
            ).fetchall()
        else:
            rows = c.execute("SELECT * FROM lessons ORDER BY created_at ASC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["payload"] = json.loads(d["payload"])
        d["evidence"] = json.loads(d["evidence"] or "[]")
        if d.get("gate_report"):
            d["gate_report"] = json.loads(d["gate_report"])
        out.append(d)
    return out


def set_lesson_status(lesson_ids: list[str], status: str, gate_report: dict | None = None) -> None:
    with conn() as c:
        for lid in lesson_ids:
            c.execute(
                "UPDATE lessons SET status=?, gate_report=?, promoted_at=? WHERE lesson_id=?",
                (
                    status,
                    json.dumps(gate_report, default=str) if gate_report else None,
                    utcnow() if status == "active" else None,
                    lid,
                ),
            )


def record_promotion(from_v: str, to_v: str, decision: str, report: dict) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO promotions (from_version, to_version, decision, report, at) VALUES (?,?,?,?,?)",
            (from_v, to_v, decision, json.dumps(report, default=str), utcnow()),
        )


def promotions(limit: int = 50) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT * FROM promotions ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["report"] = json.loads(d["report"])
        out.append(d)
    return out
