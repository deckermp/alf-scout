// src/research/store.mjs — persistence for research runs + the EVOLUTION MEMORY.
//
// Lives in the existing ledger db (src/db.mjs exports the better-sqlite3 handle
// as `db`; path overridable with AGENTHOME_DB). Tables are prefixed `research_`
// and created idempotently at import, matching db.mjs's own convention.
//
// The important table is `research_patches`: it IS the pipeline's memory. The
// compiled DAG is BASE_DAG folded with every ACTIVE patch, so flipping a patch
// inactive genuinely reverts that evolution on the next run.

import { randomUUID } from "node:crypto";
import { db } from "../db.mjs";
import { BASE_DAG, compileDag } from "./dag.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  zip TEXT,
  status TEXT,
  dag_version INTEGER,
  created_at TEXT,
  updated_at TEXT,
  facilities_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_runs_created ON research_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS research_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  at TEXT,
  type TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_events_run ON research_events(run_id, id);

CREATE TABLE IF NOT EXISTS research_patches (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  run_id TEXT,
  feedback TEXT,
  rationale TEXT,
  ops_json TEXT,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_research_patches_created ON research_patches(created_at ASC);
`);

const nowIso = () => new Date().toISOString();

/** Never throw on malformed stored JSON — log once and hand back a default. */
function safeParse(text, fallback, what = "json") {
  if (text == null || text === "") return fallback;
  try {
    const v = JSON.parse(text);
    return v === undefined ? fallback : v;
  } catch (err) {
    console.warn(`[research/store] malformed ${what} in db, using default:`, err.message);
    return fallback;
  }
}

function safeStringify(value, fallback = "null") {
  try {
    return JSON.stringify(value ?? null);
  } catch (err) {
    console.warn("[research/store] could not serialize value:", err.message);
    return fallback;
  }
}

// ---- runs -------------------------------------------------------------------

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    zip: row.zip,
    status: row.status,
    dagVersion: row.dag_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    facilities: safeParse(row.facilities_json, [], "facilities_json"),
    error: row.error ?? null,
  };
}

const _insertRun = db.prepare(`
  INSERT INTO research_runs (id, zip, status, dag_version, created_at, updated_at, facilities_json, error)
  VALUES (@id, @zip, @status, @dag_version, @created_at, @updated_at, @facilities_json, NULL)
`);

/** @returns {object} the created run */
export function createRun(zip, dagVersion) {
  const at = nowIso();
  const id = `run_${randomUUID()}`;
  _insertRun.run({
    id,
    zip: String(zip ?? ""),
    status: "running",
    dag_version: Number(dagVersion) || 1,
    created_at: at,
    updated_at: at,
    facilities_json: "[]",
  });
  return getRun(id);
}

export function getRun(id) {
  return rowToRun(db.prepare("SELECT * FROM research_runs WHERE id = ?").get(id));
}

export function listRuns(limit = 50) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  return db
    .prepare("SELECT * FROM research_runs ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(n)
    .map(rowToRun);
}

/**
 * Partial update. Accepts { status, dagVersion, facilities, error } in any mix.
 * @returns {object|null} the updated run
 */
export function updateRun(id, patch = {}) {
  const sets = ["updated_at = @updated_at"];
  const params = { id, updated_at: nowIso() };
  if (patch.status !== undefined) {
    sets.push("status = @status");
    params.status = String(patch.status);
  }
  if (patch.dagVersion !== undefined) {
    sets.push("dag_version = @dag_version");
    params.dag_version = Number(patch.dagVersion) || 0;
  }
  if (patch.zip !== undefined) {
    sets.push("zip = @zip");
    params.zip = String(patch.zip);
  }
  if (patch.facilities !== undefined) {
    sets.push("facilities_json = @facilities_json");
    params.facilities_json = safeStringify(patch.facilities, "[]");
  }
  if (patch.error !== undefined) {
    sets.push("error = @error");
    params.error = patch.error == null ? null : String(patch.error);
  }
  db.prepare(`UPDATE research_runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getRun(id);
}

// ---- events -----------------------------------------------------------------

const _insertEvent = db.prepare(`
  INSERT INTO research_events (run_id, at, type, payload_json)
  VALUES (@run_id, @at, @type, @payload_json)
`);

export function appendEvent(runId, type, payload) {
  const at = nowIso();
  const info = _insertEvent.run({
    run_id: runId ?? null,
    at,
    type: String(type ?? "event"),
    payload_json: safeStringify(payload, "null"),
  });
  return { id: Number(info.lastInsertRowid), runId, at, type, payload };
}

export function getEvents(runId) {
  return db
    .prepare("SELECT * FROM research_events WHERE run_id = ? ORDER BY id ASC")
    .all(runId)
    .map((r) => ({
      id: r.id,
      runId: r.run_id,
      at: r.at,
      type: r.type,
      payload: safeParse(r.payload_json, null, "payload_json"),
    }));
}

// ---- patches (the evolution memory) ----------------------------------------

function rowToPatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    runId: row.run_id ?? null,
    feedback: row.feedback ?? "",
    rationale: row.rationale ?? "",
    ops: safeParse(row.ops_json, [], "ops_json"),
    active: row.active ? 1 : 0,
  };
}

const _insertPatch = db.prepare(`
  INSERT INTO research_patches (id, created_at, run_id, feedback, rationale, ops_json, active)
  VALUES (@id, @created_at, @run_id, @feedback, @rationale, @ops_json, @active)
  ON CONFLICT(id) DO UPDATE SET
    run_id = excluded.run_id,
    feedback = excluded.feedback,
    rationale = excluded.rationale,
    ops_json = excluded.ops_json,
    active = excluded.active
`);

/** @param {object} patch DagPatch (+ optional runId, active) */
export function savePatch(patch = {}) {
  const id = patch.id || `patch_${randomUUID()}`;
  _insertPatch.run({
    id,
    created_at: patch.createdAt || nowIso(),
    run_id: patch.runId ?? null,
    feedback: String(patch.feedback ?? ""),
    rationale: String(patch.rationale ?? ""),
    ops_json: safeStringify(Array.isArray(patch.ops) ? patch.ops : [], "[]"),
    active: patch.active === 0 || patch.active === false ? 0 : 1,
  });
  return getPatch(id);
}

export function getPatch(id) {
  return rowToPatch(db.prepare("SELECT * FROM research_patches WHERE id = ?").get(id));
}

/** Chronological — compileDag folds them in this exact order. */
export function listPatches({ activeOnly = true } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM research_patches WHERE active = 1 ORDER BY created_at ASC, rowid ASC"
    : "SELECT * FROM research_patches ORDER BY created_at ASC, rowid ASC";
  return db.prepare(sql).all().map(rowToPatch);
}

/** The revert lever: flipping this changes the DAG the NEXT run compiles. */
export function setPatchActive(id, active) {
  db.prepare("UPDATE research_patches SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  return getPatch(id);
}

/** BASE_DAG folded with every active patch, chronologically. */
export function currentDag() {
  return compileDag(BASE_DAG, listPatches({ activeOnly: true }));
}
