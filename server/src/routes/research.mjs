// src/routes/research.mjs — the REST surface for the ALF research pipeline (S-19).
//
// Contract: a run is fire-and-forget. POST /run answers 202 immediately with a
// runId; everything after that arrives on the SSE stream as `research` events
// (and is durably appended to the store so a late-joining dashboard can catch up
// via GET /runs/:id).
//
// Nothing in this router may take the server down: every handler is wrapped, and
// the sibling-owned modules (store/dag/evolver) are loaded lazily with working
// fallbacks so a missing symbol degrades instead of throwing at import time.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { broadcast } from "../bus.mjs";
import { RESEARCH_EVENT, RUN_STATUS } from "../research/contract.mjs";
import { startRun, resumeRun, loadDag, getRunHandle } from "../research/runtime.mjs";

export const research = Router();

// ---- lazy, fault-tolerant deps ---------------------------------------------
let _store = null;
async function store() {
  if (_store) return _store;
  const mem = memoryStore();
  try {
    const m = await import("../research/store.mjs");
    _store = {
      createRun: m.createRun || mem.createRun,
      getRun: m.getRun || mem.getRun,
      listRuns: m.listRuns || mem.listRuns,
      updateRun: m.updateRun || mem.updateRun,
      appendEvent: m.appendEvent || mem.appendEvent,
      getEvents: m.getEvents || mem.getEvents,
      savePatch: m.savePatch || mem.savePatch,
      listPatches: m.listPatches || mem.listPatches,
      setPatchActive: m.setPatchActive || mem.setPatchActive,
      currentDag: m.currentDag || mem.currentDag,
      degraded: false,
    };
  } catch {
    _store = { ...mem, degraded: true };
  }
  return _store;
}

/** In-memory stand-in with the exact store.mjs signatures. Real, just not durable. */
function memoryStore() {
  const runs = new Map(), events = new Map(), patches = new Map();
  return {
    createRun(zip, dagVersion) {
      const id = randomUUID();
      const row = { id, zip, dagVersion, status: RUN_STATUS.RUNNING, createdAt: new Date().toISOString(), facilities: [] };
      runs.set(id, row); events.set(id, []);
      return row;
    },
    getRun: (id) => runs.get(id) || null,
    listRuns: (limit = 50) => [...runs.values()].slice(-limit).reverse(),
    updateRun(id, patch) { const r = runs.get(id); if (r) Object.assign(r, patch); return r || null; },
    appendEvent(runId, type, payload) {
      const list = events.get(runId) || [];
      const ev = { id: list.length + 1, runId, type, payload, ts: new Date().toISOString() };
      list.push(ev); events.set(runId, list); return ev;
    },
    getEvents: (runId) => events.get(runId) || [],
    savePatch(p) { const row = { active: true, ...p }; patches.set(row.id, row); return row; },
    listPatches({ activeOnly = false } = {}) {
      const all = [...patches.values()];
      return activeOnly ? all.filter((p) => p.active) : all;
    },
    setPatchActive(id, active) { const p = patches.get(id); if (p) p.active = Boolean(active); return p || null; },
    currentDag: () => null, // resolved from runtime's loadDag() by the caller
  };
}

async function resolveCurrentDag() {
  const s = await store();
  const d = await loadDag();
  try {
    const fromStore = s.currentDag?.();
    if (fromStore && Array.isArray(fromStore.nodes)) return fromStore;
  } catch { /* fall through */ }
  try {
    const active = s.listPatches?.({ activeOnly: true }) || [];
    return d.compileDag(d.BASE_DAG, active);
  } catch {
    return d.BASE_DAG;
  }
}

// ---- HITL registry ----------------------------------------------------------
// canUseTool parks on the promise stored here; POST /hitl settles it. The
// registry is module-level so the (async, un-awaited) run and the HTTP handler
// that answers it are looking at the same object.
const PENDING = new Map(); // requestId -> {resolve, request, runId}

// Gating is scoped to specific NODES, not just tool names, and that is a
// correctness requirement rather than a preference. `allowedTools` governs what
// the model can SEE, not merely what is auto-approved — so a gated tool is left
// out of the list and becomes invisible unless ToolSearch resurfaces it.
// Gating record_facilities on every node therefore disarmed the enrichment
// nodes entirely ("nothing was written — record_facilities is unavailable") and
// the table came back with names but no beds or fees. One deliberate checkpoint
// on `discover` demonstrates the seam without starving the rest of the graph.
const DEFAULT_GATE_NODES = ["discover"];

function makeHitl(runId, gate, gateNodes = DEFAULT_GATE_NODES) {
  const scope = Array.isArray(gateNodes) && gateNodes.length ? gateNodes : null;
  return {
    // gate: false | true | string[] of tool names to gate.
    shouldGate(nodeId, toolName) {
      if (!gate) return false;
      if (scope && nodeId && !scope.includes(nodeId)) return false;
      if (gate === true) return true;
      return Array.isArray(gate) && gate.includes(toolName);
    },
    wait(requestId, request) {
      return new Promise((resolve) => {
        PENDING.set(requestId, { resolve, request, runId });
        // Safety valve: never park a run forever. Auto-approve after 10 min.
        setTimeout(() => {
          const p = PENDING.get(requestId);
          if (p) { PENDING.delete(requestId); p.resolve({ decision: "approve", feedback: "auto-approved (timeout)" }); }
        }, 10 * 60_000).unref?.();
      });
    },
  };
}

// The dashboard's RunEvent reader keys off `kind` and DROPS any frame without
// one, and it names two events differently than the runtime does. Normalizing
// here — the single choke point every event already passes through — keeps one
// vocabulary on the wire without either side having to know about the other.
// Without this the backend succeeds while the UI sits dead, which is the worst
// failure mode to debug live.
const KIND_ALIAS = { hitl: "hitl_request", patch: "dag_updated" };

/** Wire form of a RunEvent: same object, plus the `kind` the dashboard reads. */
export function wireFrame(ev) {
  return { ...ev, kind: KIND_ALIAS[ev.type] || ev.type };
}

/** Broadcast one event, plus any companion frames the UI needs. */
function emitWire(ev) {
  try { broadcast(RESEARCH_EVENT, { event: wireFrame(ev) }); } catch { /* never throw into the graph */ }
  // `run_end` carries the final ranked table, but the UI replaces its rows only
  // on a `facilities` frame — so fan one out rather than making it special-case.
  if (ev.type === "run_end" && Array.isArray(ev.facilities)) {
    try {
      broadcast(RESEARCH_EVENT, { event: { ...ev, type: "facilities", kind: "facilities" } });
    } catch { /* best effort */ }
  }
}

/** Fan an event to BOTH the durable store and every connected SSE client. */
function makeEmit(runId, s) {
  return (event) => {
    const ev = { ...event, runId };
    try { s.appendEvent(runId, ev.type || "event", ev); } catch { /* store is best-effort */ }
    // Persist the partial table as it builds, not just at run_end. The dashboard
    // polls GET /runs/:id every 2s as an SSE fallback, and a client that joins
    // (or refreshes) mid-run must see the rows that already exist rather than an
    // empty grid attached to a run that is visibly working.
    if (ev.type === "facilities" && Array.isArray(ev.facilities)) {
      try { s.updateRun(runId, { facilities: ev.facilities }); } catch { /* best effort */ }
    }
    emitWire(ev);
  };
}

const fail = (res, status, error) => res.status(status).json({ ok: false, error: String(error?.message || error) });

// ---- routes -----------------------------------------------------------------

// POST /run {zip, gate?} -> 202 {runId}. Does NOT await the graph.
research.post("/run", async (req, res) => {
  try {
    const zip = String(req.body?.zip || "").trim();
    if (!/^\d{5}$/.test(zip)) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });
    const s = await store();
    const spec = await resolveCurrentDag();
    const run = s.createRun(zip, spec?.version ?? 1);
    const runId = run?.id || run?.runId || randomUUID();

    const emit = makeEmit(runId, s);
    const gate = req.body?.gate ?? (process.env.RESEARCH_HITL === "1");
    const hitl = makeHitl(runId, gate, req.body?.gateNodes);

    // Fire and forget — the response must not wait on an agent pipeline.
    startRun({ zip, spec, runId, emit, hitl })
      .then((out) => {
        try { s.updateRun(runId, { status: out.status, facilities: out.facilities || [], finishedAt: new Date().toISOString() }); } catch {}
      })
      .catch((e) => {
        try { s.updateRun(runId, { status: RUN_STATUS.ERROR, error: e?.message || String(e) }); } catch {}
        try { emit({ type: "error", message: e?.message || String(e) }); } catch {}
      });

    res.status(202).json({ ok: true, runId, zip, dagVersion: spec?.version ?? 1, status: RUN_STATUS.RUNNING });
  } catch (e) { fail(res, 500, e); }
});

// GET /runs
research.get("/runs", async (req, res) => {
  try {
    const s = await store();
    const limit = Math.min(200, Number(req.query.limit) || 50);
    res.json({ ok: true, runs: s.listRuns(limit) || [], degraded: s.degraded });
  } catch (e) { fail(res, 500, e); }
});

// GET /runs/:id -> run + events + facilities
research.get("/runs/:id", async (req, res) => {
  try {
    const s = await store();
    const run = s.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: "run not found" });
    const events = s.getEvents(req.params.id) || [];
    // Facilities live on the run row once it finishes; before that, recover the
    // latest snapshot any node emitted so a mid-run dashboard still has a table.
    let facilities = run.facilities || [];
    if (!facilities.length) {
      for (let i = events.length - 1; i >= 0; i--) {
        const p = events[i]?.payload || events[i];
        if (Array.isArray(p?.facilities) && p.facilities.length) { facilities = p.facilities; break; }
      }
    }
    const handle = getRunHandle(req.params.id);
    res.json({ ok: true, run, events, facilities, live: Boolean(handle), status: handle?.status || run.status });
  } catch (e) { fail(res, 500, e); }
});

// POST /hitl {requestId, decision, feedback, edited} — idempotent.
research.post("/hitl", async (req, res) => {
  try {
    const { requestId, decision = "approve", feedback = "", edited } = req.body || {};
    if (!requestId) return res.status(400).json({ ok: false, error: "requestId required" });
    const pending = PENDING.get(requestId);
    if (pending) {
      PENDING.delete(requestId);
      pending.resolve({ decision, feedback, edited });
      broadcast(RESEARCH_EVENT, { event: wireFrame({ type: "hitl_resolved", runId: pending.runId, requestId, decision  }) });
      return res.json({ ok: true, resolved: true, requestId, decision, runId: pending.runId });
    }
    // Nothing parked on canUseTool — the run may instead be suspended at a
    // LangGraph interrupt(). Resume it with a Command if we know it.
    const runId = req.body?.runId;
    if (runId && getRunHandle(runId)) {
      const out = await resumeRun({ runId, resumeValue: { decision, feedback, edited } });
      return res.json({ ok: true, resolved: false, resumedGraph: Boolean(out.resumed), ...out });
    }
    res.json({ ok: true, resolved: false, note: "no pending hitl request or suspended graph for that id (no-op)" });
  } catch (e) { fail(res, 500, e); }
});

// POST /feedback {runId, feedback} -> evolve the DAG
research.post("/feedback", async (req, res) => {
  try {
    const { runId, feedback } = req.body || {};
    if (!feedback || !String(feedback).trim()) return res.status(400).json({ ok: false, error: "feedback required" });
    const s = await store();
    const d = await loadDag();
    const currentSpec = await resolveCurrentDag();

    let facilities = [];
    try { facilities = (runId && s.getRun(runId)?.facilities) || []; } catch {}

    let patch = null;
    try {
      const ev = await import("../research/evolver.mjs");
      if (typeof ev.evolveFromFeedback !== "function") throw new Error("evolveFromFeedback missing");
      patch = await ev.evolveFromFeedback({ feedback, runId, currentSpec, facilities });
    } catch (e) {
      // Degrade to a recorded-but-inert patch rather than 500ing the human's words away.
      patch = {
        id: randomUUID(), createdAt: new Date().toISOString(), feedback: String(feedback),
        rationale: `evolver unavailable (${e?.message || e}) — feedback recorded without ops`,
        ops: [],
      };
    }

    let saved = patch;
    try { saved = s.savePatch(patch) || patch; } catch {}
    let spec = currentSpec;
    try {
      const active = s.listPatches?.({ activeOnly: true }) || [];
      spec = d.compileDag(d.BASE_DAG, active);
    } catch {}

    broadcast(RESEARCH_EVENT, { event: wireFrame({ type: "patch", runId: runId || null, patch: saved, spec, ts: new Date().toISOString()  }) });
    res.json({ ok: true, patch: saved, spec, mermaid: safeMermaid(d, spec) });
  } catch (e) { fail(res, 500, e); }
});

function safeMermaid(d, spec) {
  try { return d.dagToMermaid(spec); } catch { return ""; }
}

// GET /dag
research.get("/dag", async (_req, res) => {
  try {
    const d = await loadDag();
    const spec = await resolveCurrentDag();
    let problems = [];
    try { problems = d.validateDag(spec) || []; } catch (e) { problems = [`validateDag failed: ${e.message}`]; }
    res.json({ ok: true, spec, mermaid: safeMermaid(d, spec), problems, degraded: d.degraded });
  } catch (e) { fail(res, 500, e); }
});

// GET /patches
research.get("/patches", async (_req, res) => {
  try {
    const s = await store();
    res.json({ ok: true, patches: s.listPatches({ activeOnly: false }) || [] });
  } catch (e) { fail(res, 500, e); }
});

// POST /patches/:id/active {active} — a human can REVERT an evolution.
research.post("/patches/:id/active", async (req, res) => {
  try {
    const s = await store();
    const d = await loadDag();
    const active = Boolean(req.body?.active);
    const patch = s.setPatchActive(req.params.id, active);
    if (!patch) return res.status(404).json({ ok: false, error: "patch not found" });
    const spec = await resolveCurrentDag();
    broadcast(RESEARCH_EVENT, { event: wireFrame({ type: "patch", patch, spec, ts: new Date().toISOString()  }) });
    res.json({ ok: true, patch, spec, mermaid: safeMermaid(d, spec) });
  } catch (e) { fail(res, 500, e); }
});

export default research;
