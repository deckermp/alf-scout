// src/research/runtime.mjs — compiles a DagSpec (DATA) into a live LangGraph and
// runs it. The graph owns ordering, fan-out/fan-in and checkpointing; the agent
// harness (./harness.mjs) owns the work inside each agent node; score/rank are
// computed locally because arithmetic is not a job for a language model.
import { StateGraph, START, END, MemorySaver, Annotation, Command, isGraphInterrupt } from "@langchain/langgraph";
import { SCORE_DIMENSIONS, RUN_STATUS } from "./contract.mjs";
import { executeNode } from "./harness.mjs";

// ---- graceful dependency loading -------------------------------------------
// dag.mjs / store.mjs / evolver.mjs are owned by a sibling module and may not be
// present (or may be missing a symbol) at import time. We must never take the
// server down for that, so every use goes through this lazy loader with a real,
// working fallback rather than a throw.
const FALLBACK_BASE_DAG = {
  version: 1,
  nodes: [
    { id: "discover", label: "Discover facilities", after: [], enabled: true, origin: "base",
      instruction: "Find assisted living facilities (ALFs) within ~25 miles of the target zip. For each, record id (slug of the name), name, address, and distanceMiles computed with the haversine tool from the zip centroid." },
    { id: "enrich_capacity", label: "Beds & services", after: ["discover"], enabled: true, origin: "base",
      instruction: "For each known facility, find licensed bed count and the service mix (IL/AL/MemoryCare/HomeHealth/SNF/Respite). Prefer the state licensing registry as source." },
    { id: "enrich_cost", label: "Average monthly fee", after: ["discover"], enabled: true, origin: "base",
      instruction: "For each known facility, find the average monthly fee in USD. If only a range is published, record the midpoint and say so in prov.note with a lowered confidence." },
    { id: "enrich_ownership", label: "Management & ACOs", after: ["discover"], enabled: true, origin: "base",
      instruction: "For each known facility, find the management/operating company and any partnered Accountable Care Organizations (ACOs). ACO partnerships are rarely published — record unknown rather than guessing." },
    { id: "score", label: "Score", after: ["enrich_capacity", "enrich_cost", "enrich_ownership"], enabled: true, origin: "base", instruction: "local" },
    { id: "rank", label: "Rank", after: ["score"], enabled: true, origin: "base", instruction: "local" },
  ],
  weights: { distance: 0.3, beds: 0.15, fee: 0.25, services: 0.2, aco: 0.1 },
};

let _dag = null;
export async function loadDag() {
  if (_dag) return _dag;
  try {
    const m = await import("./dag.mjs");
    _dag = {
      BASE_DAG: m.BASE_DAG || FALLBACK_BASE_DAG,
      compileDag: m.compileDag || ((base) => base),
      topoOrder: m.topoOrder || defaultTopoOrder,
      validateDag: m.validateDag || defaultValidateDag,
      dagToMermaid: m.dagToMermaid || defaultMermaid,
      degraded: false,
    };
  } catch {
    _dag = {
      BASE_DAG: FALLBACK_BASE_DAG,
      compileDag: (base) => base || FALLBACK_BASE_DAG,
      topoOrder: defaultTopoOrder,
      validateDag: defaultValidateDag,
      dagToMermaid: defaultMermaid,
      degraded: true,
    };
  }
  return _dag;
}

function enabledNodes(spec) {
  return (spec?.nodes || []).filter((n) => n && n.enabled !== false);
}
function defaultTopoOrder(spec) {
  const nodes = enabledNodes(spec);
  const ids = new Set(nodes.map((n) => n.id));
  const out = [], seen = new Set();
  const visit = (n) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    for (const up of n.after || []) {
      if (!ids.has(up)) continue;
      visit(nodes.find((x) => x.id === up));
    }
    out.push(n.id);
  };
  for (const n of nodes) visit(n);
  return out;
}
function defaultValidateDag(spec) {
  const problems = [];
  const ids = new Set((spec?.nodes || []).map((n) => n.id));
  for (const n of spec?.nodes || []) {
    for (const up of n.after || []) if (!ids.has(up)) problems.push(`${n.id}: unknown upstream "${up}"`);
  }
  if (!enabledNodes(spec).some((n) => (n.after || []).length === 0)) problems.push("no entry node");
  return problems;
}
function defaultMermaid(spec) {
  const lines = ["graph TD"];
  for (const n of enabledNodes(spec)) {
    lines.push(`  ${n.id}["${(n.label || n.id).replace(/"/g, "'")}"]`);
    for (const up of n.after || []) lines.push(`  ${up} --> ${n.id}`);
  }
  return lines.join("\n");
}

// ---- state -----------------------------------------------------------------
// THE SUBTLE PART: `facilities` fans in from three parallel enrichment branches
// that each return only the fields THEY discovered. A default last-write-wins
// channel would let whichever branch finishes last erase the other two. This
// reducer merges by facility id and, per field, keeps the incoming value only
// when it actually carries information (non-null) — so beds, fees and ownership
// compose into one row instead of clobbering each other.
function mergeFacilities(prev = [], next = []) {
  if (!Array.isArray(next) || next.length === 0) return prev;
  const byId = new Map((prev || []).map((f) => [f.id, f]));
  for (const inc of next) {
    if (!inc?.id) continue;
    const cur = byId.get(inc.id);
    if (!cur) { byId.set(inc.id, { notes: [], ...inc }); continue; }
    const merged = { ...cur };
    for (const [k, v] of Object.entries(inc)) {
      if (k === "notes") { merged.notes = [...new Set([...(cur.notes || []), ...(v || [])])]; continue; }
      if (v == null) continue;
      // Sourced field: only overwrite when the incoming one is not empty, and
      // prefer the higher-confidence claim when both sides have a value.
      if (typeof v === "object" && "value" in v) {
        const old = cur[k];
        const oldHas = old && old.value != null;
        const newHas = v.value != null;
        if (!newHas) continue;
        if (!oldHas || (v.prov?.confidence ?? 0) >= (old.prov?.confidence ?? 0)) merged[k] = v;
        continue;
      }
      merged[k] = v;
    }
    byId.set(inc.id, merged);
  }
  return [...byId.values()];
}

const ResearchState = Annotation.Root({
  zip: Annotation({ reducer: (_p, n) => n ?? _p, default: () => "" }),
  runId: Annotation({ reducer: (_p, n) => n ?? _p, default: () => "" }),
  facilities: Annotation({ reducer: mergeFacilities, default: () => [] }),
  notes: Annotation({
    reducer: (p = [], n = []) => [...p, ...(Array.isArray(n) ? n : [n])],
    default: () => [],
  }),
});

// ---- local (non-agent) nodes ----------------------------------------------
const num = (f, k) => (typeof f?.[k]?.value === "number" ? f[k].value : null);
const conf = (f, k) => {
  const c = f?.[k]?.prov?.confidence;
  return typeof c === "number" ? Math.max(0, Math.min(1, c)) : 0;
};
const arrLen = (f, k) => (Array.isArray(f?.[k]?.value) ? f[k].value.length : null);

function normalize(vals, v, invert) {
  const clean = vals.filter((x) => typeof x === "number");
  if (clean.length === 0 || typeof v !== "number") return null;
  const lo = Math.min(...clean), hi = Math.max(...clean);
  if (hi === lo) return 1;
  const n = (v - lo) / (hi - lo);
  return invert ? 1 - n : n;
}

/**
 * score — deliberately local, deliberately confidence-weighted.
 *
 * HONESTY PROPERTY: each normalized dimension is MULTIPLIED by that field's
 * prov.confidence before it enters the weighted sum. A facility whose $4,200/mo
 * fee came from an unsourced model guess (confidence 0.2) contributes 20% of
 * what the same number sourced from a state registry (confidence 0.95) would.
 * Unverified data therefore cannot win the ranking — it can only fail to lose.
 * Missing values are treated as a neutral 0.5 and leave a visible note.
 */
export function scoreFacilities(facilities, weights) {
  const w = { ...(weights || {}) };
  for (const d of SCORE_DIMENSIONS) if (typeof w[d] !== "number") w[d] = 1 / SCORE_DIMENSIONS.length;

  const dists = facilities.map((f) => num(f, "distanceMiles"));
  const beds = facilities.map((f) => num(f, "beds"));
  const fees = facilities.map((f) => num(f, "avgMonthlyFee"));
  const svcs = facilities.map((f) => arrLen(f, "services"));
  const acos = facilities.map((f) => arrLen(f, "acos"));

  return facilities.map((f) => {
    const notes = [...(f.notes || [])];
    const dims = [
      ["distance", normalize(dists, num(f, "distanceMiles"), true), conf(f, "distanceMiles"), "distanceMiles"],
      ["beds", normalize(beds, num(f, "beds"), false), conf(f, "beds"), "beds"],
      ["fee", normalize(fees, num(f, "avgMonthlyFee"), true), conf(f, "avgMonthlyFee"), "avgMonthlyFee"],
      ["services", normalize(svcs, arrLen(f, "services"), false), conf(f, "services"), "services"],
      ["aco", normalize(acos, arrLen(f, "acos"), false), conf(f, "acos"), "acos"],
    ];
    let total = 0, wsum = 0;
    for (const [dim, rawN, c, field] of dims) {
      let n = rawN;
      let c2 = c;
      if (n === null) {
        n = 0.5; c2 = 0.5; // unknown → neutral, and say so
        if (!notes.some((x) => x.startsWith(`unknown ${field}`))) notes.push(`unknown ${field}: scored neutral`);
      }
      total += w[dim] * n * c2; // <-- the confidence multiplier
      wsum += w[dim];
    }
    const score = wsum > 0 ? Number((total / wsum).toFixed(4)) : 0;
    return { ...f, score, notes };
  });
}

export function rankFacilities(facilities) {
  return [...facilities].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

const LOCAL_NODES = new Set(["score", "rank"]);

// ---- graph construction ----------------------------------------------------
/**
 * Compile a DagSpec into a StateGraph. One graph node per ENABLED DagNodeSpec;
 * `after: []` nodes hang off START; nodes with no downstream go to END.
 */
export function buildGraph(spec, deps = {}) {
  const { emit = () => {}, hitl, runId = "" } = deps;
  const nodes = enabledNodes(spec);
  const ids = new Set(nodes.map((n) => n.id));
  const g = new StateGraph(ResearchState);

  for (const node of nodes) {
    if (LOCAL_NODES.has(node.id)) {
      g.addNode(node.id, async (state) => {
        emit({ type: "node_start", runId, nodeId: node.id, label: node.label || node.id, ts: new Date().toISOString() });
        const out = node.id === "score"
          ? scoreFacilities(state.facilities || [], spec.weights)
          : rankFacilities(state.facilities || []);
        emit({ type: "node_end", runId, nodeId: node.id, label: node.label || node.id,
          summary: `${node.id} over ${out.length} facilities`, count: out.length, ts: new Date().toISOString() });
        // Replace wholesale: score/rank rewrite every row, and the merge reducer
        // keeps them keyed by id so this is a field-level update, not a wipe.
        return { facilities: out };
      });
      continue;
    }
    g.addNode(node.id, async (state) => {
      emit({ type: "node_start", runId, nodeId: node.id, label: node.label || node.id, ts: new Date().toISOString() });
      const res = await executeNode({ node, state, runId, emit, hitl });
      return {
        facilities: res.facilities || [],
        notes: res.summary ? [`${node.id}: ${res.summary}`] : [],
      };
    });
  }

  const hasDownstream = new Set();
  for (const node of nodes) for (const up of node.after || []) if (ids.has(up)) hasDownstream.add(up);

  for (const node of nodes) {
    const ups = (node.after || []).filter((u) => ids.has(u));
    if (ups.length === 0) g.addEdge(START, node.id);
    else for (const up of ups) g.addEdge(up, node.id);
    if (!hasDownstream.has(node.id)) g.addEdge(node.id, END);
  }

  return g;
}

// ---- run registry ----------------------------------------------------------
// Compiled graphs + their configs live here so a later resume can find them.
const RUNS = new Map(); // runId -> {app, config, spec, emit, hitl, status}

export function getRunHandle(runId) { return RUNS.get(runId) || null; }

export async function startRun({ zip, spec, runId, emit = () => {}, hitl }) {
  const d = await loadDag();
  const useSpec = spec || d.compileDag(d.BASE_DAG, []);
  const graph = buildGraph(useSpec, { emit, hitl, runId });
  const app = graph.compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: runId }, recursionLimit: 50 };
  RUNS.set(runId, { app, config, spec: useSpec, emit, hitl, status: RUN_STATUS.RUNNING });

  emit({ type: "run_start", runId, zip, dagVersion: useSpec.version, ts: new Date().toISOString() });
  try {
    const final = await app.invoke({ zip, runId, facilities: [], notes: [] }, config);
    const handle = RUNS.get(runId);
    if (handle) handle.status = RUN_STATUS.DONE;
    emit({
      type: "run_end", runId, status: RUN_STATUS.DONE,
      facilities: final.facilities || [], count: (final.facilities || []).length,
      ts: new Date().toISOString(),
    });
    return { status: RUN_STATUS.DONE, facilities: final.facilities || [], notes: final.notes || [] };
  } catch (e) {
    if (isGraphInterrupt?.(e)) {
      const handle = RUNS.get(runId);
      if (handle) handle.status = RUN_STATUS.AWAITING_HUMAN;
      emit({ type: "run_suspended", runId, status: RUN_STATUS.AWAITING_HUMAN, ts: new Date().toISOString() });
      return { status: RUN_STATUS.AWAITING_HUMAN };
    }
    const handle = RUNS.get(runId);
    if (handle) handle.status = RUN_STATUS.ERROR;
    emit({ type: "error", runId, message: e?.message || String(e), ts: new Date().toISOString() });
    emit({ type: "run_end", runId, status: RUN_STATUS.ERROR, ts: new Date().toISOString() });
    return { status: RUN_STATUS.ERROR, error: e?.message || String(e) };
  }
}

export async function resumeRun({ runId, resumeValue }) {
  const handle = RUNS.get(runId);
  if (!handle) return { ok: false, resumed: false, reason: "no compiled graph for that runId" };
  const { app, config, emit } = handle;
  handle.status = RUN_STATUS.RUNNING;
  emit({ type: "run_resume", runId, ts: new Date().toISOString() });
  try {
    const final = await app.invoke(new Command({ resume: resumeValue }), config);
    handle.status = RUN_STATUS.DONE;
    emit({
      type: "run_end", runId, status: RUN_STATUS.DONE,
      facilities: final.facilities || [], count: (final.facilities || []).length,
      ts: new Date().toISOString(),
    });
    return { ok: true, resumed: true, status: RUN_STATUS.DONE, facilities: final.facilities || [] };
  } catch (e) {
    if (isGraphInterrupt?.(e)) {
      handle.status = RUN_STATUS.AWAITING_HUMAN;
      emit({ type: "run_suspended", runId, ts: new Date().toISOString() });
      return { ok: true, resumed: true, status: RUN_STATUS.AWAITING_HUMAN };
    }
    handle.status = RUN_STATUS.ERROR;
    emit({ type: "error", runId, message: e?.message || String(e), ts: new Date().toISOString() });
    return { ok: false, resumed: true, status: RUN_STATUS.ERROR, error: e?.message || String(e) };
  }
}
