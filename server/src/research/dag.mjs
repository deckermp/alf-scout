// src/research/dag.mjs — the DAG-as-DATA layer (S-19).
//
// The pipeline is a list of rows, not a call graph. Each node carries an
// `instruction` string an agent executes. A human's feedback compiles into
// PatchOps (see contract.mjs) which fold over BASE_DAG to produce the spec the
// next run actually executes — no code edits, no redeploy.
//
// Shapes are defined ONCE in ./contract.mjs. This file only manipulates them.

import { SCORE_DIMENSIONS } from "./contract.mjs";

/** @typedef {import("./contract.mjs")} _Contract */

/** The hand-authored starting pipeline. Version 1. Never mutated at runtime. */
export const BASE_DAG = Object.freeze({
  version: 1,
  weights: Object.freeze({ distance: 0.25, beds: 0.2, fee: 0.25, services: 0.15, aco: 0.15 }),
  nodes: Object.freeze([
    {
      id: "discover",
      label: "Discover facilities",
      after: [],
      // Bounded on purpose. The unbounded phrasing ("find EVERY licensed
      // facility, prefer state registries") invited a page-open per facility and
      // pushed this node past 8 minutes. Later nodes enrich; this one only has
      // to produce the candidate set, so a search-results listing is enough.
      instruction:
        "Find assisted living facilities in the target ZIP code. BUDGET: at most 3 web searches, then stop searching. Return up to 10 facilities with name and street address. Do NOT open a page per facility — search-result listings are sufficient here, later nodes enrich each one. Call record_facilities EXACTLY ONCE with everything you found. Set each field's confidence honestly: search-snippet data is roughly 0.6, not 0.9.",
      enabled: true,
      origin: "base",
    },
    {
      id: "enrich_management",
      label: "Management company",
      after: ["discover"],
      instruction:
        "For each facility, identify the management/operator company (the entity that runs it day to day, not the real-estate owner). BUDGET: at most 2 web searches total across ALL facilities — batch them, do not search per facility. Call record_facilities exactly once. Leave management null with a reason rather than guessing.",
      enabled: true,
      origin: "base",
    },
    {
      id: "enrich_aco",
      label: "ACO partnerships",
      after: ["discover"],
      instruction:
        "For each facility, identify any Accountable Care Organizations (ACOs), Medicare Advantage plans, or value-based care networks it partners with. BUDGET: at most 2 web searches total across ALL facilities. ACO affiliation is rarely published, so an empty list with low confidence is the CORRECT answer far more often than a guess — say so rather than inventing a partner. Call record_facilities exactly once.",
      enabled: true,
      origin: "base",
    },
    {
      id: "enrich_services",
      label: "Beds, fees, service mix",
      after: ["discover"],
      instruction:
        "For each facility, determine licensed bed count, average monthly private-pay fee in USD, and which service lines it offers from: IL, AL, MemoryCare, HomeHealth, SNF, Respite. BUDGET: at most 3 web searches total across ALL facilities — batch them. beds and avgMonthlyFee MUST be a number or null, never a string like '60 units'. Call record_facilities exactly once.",
      enabled: true,
      origin: "base",
    },
    {
      id: "score",
      label: "Score",
      after: ["enrich_management", "enrich_aco", "enrich_services"],
      instruction: "Compute the composite score from the configured weights.",
      enabled: true,
      origin: "base",
    },
    {
      id: "rank",
      label: "Rank",
      after: ["score"],
      instruction: "Sort facilities by composite score, descending.",
      enabled: true,
      origin: "base",
    },
  ]),
});

/** Deep-ish clone of a DagSpec — nodes and weights become fresh objects. */
function cloneSpec(spec) {
  return {
    version: spec?.version ?? 1,
    weights: { ...(spec?.weights || {}) },
    nodes: (spec?.nodes || []).map((n) => ({ ...n, after: [...(n.after || [])] })),
    compileLog: [...(spec?.compileLog || [])],
  };
}

function normalizeNode(node) {
  const id = String(node?.id ?? "").trim();
  return {
    id,
    label: String(node?.label ?? id ?? "").trim() || id,
    after: Array.isArray(node?.after) ? node.after.map(String) : [],
    instruction: String(node?.instruction ?? ""),
    enabled: node?.enabled === false ? false : true,
    origin: node?.origin === "base" ? "base" : "patch",
  };
}

/**
 * Fold PatchOps (chronological) over a base spec into a NEW DagSpec.
 * Never mutates `base` or `patches`. Unknown-id ops are silently skipped but
 * recorded in `spec.compileLog` (string[]).
 *
 * @param {object} base    DagSpec
 * @param {Array<{ops?:any[], id?:string, createdAt?:string}>|any[]} patches
 *        Either DagPatch objects (with .ops) or bare PatchOp arrays.
 * @returns {object} DagSpec with an extra `compileLog: string[]`
 */
export function compileDag(base, patches = []) {
  const spec = cloneSpec(base);
  spec.compileLog = [];
  const list = Array.isArray(patches) ? patches : [];

  for (const patch of list) {
    const ops = Array.isArray(patch?.ops) ? patch.ops : Array.isArray(patch) ? patch : [];
    const tag = patch?.id ? `patch ${patch.id}` : "patch";
    for (const op of ops) {
      if (!op || typeof op !== "object") {
        spec.compileLog.push(`${tag}: skipped a non-object op`);
        continue;
      }
      switch (op.op) {
        case "add_node": {
          const node = normalizeNode(op.node || {});
          if (!node.id) {
            spec.compileLog.push(`${tag}: add_node skipped — missing node id`);
            break;
          }
          const idx = spec.nodes.findIndex((n) => n.id === node.id);
          if (idx >= 0) {
            // add_node on an existing id is an UPDATE, not a duplicate.
            spec.nodes[idx] = { ...spec.nodes[idx], ...node, origin: spec.nodes[idx].origin };
            spec.compileLog.push(`${tag}: add_node "${node.id}" applied as an update to the existing node`);
          } else {
            spec.nodes.push(node);
            spec.compileLog.push(`${tag}: added node "${node.id}"`);
          }
          break;
        }
        case "edit_instruction": {
          const n = spec.nodes.find((x) => x.id === op.id);
          if (!n) {
            spec.compileLog.push(`${tag}: edit_instruction skipped — unknown node id "${op.id}"`);
            break;
          }
          n.instruction = String(op.instruction ?? n.instruction);
          spec.compileLog.push(`${tag}: reworded instruction on "${op.id}"`);
          break;
        }
        case "set_enabled": {
          const n = spec.nodes.find((x) => x.id === op.id);
          if (!n) {
            spec.compileLog.push(`${tag}: set_enabled skipped — unknown node id "${op.id}"`);
            break;
          }
          n.enabled = !!op.enabled;
          spec.compileLog.push(`${tag}: ${n.enabled ? "enabled" : "disabled"} node "${op.id}"`);
          break;
        }
        case "set_weights": {
          const w = op.weights && typeof op.weights === "object" ? op.weights : null;
          if (!w) {
            spec.compileLog.push(`${tag}: set_weights skipped — no weights object`);
            break;
          }
          const applied = [];
          for (const [k, v] of Object.entries(w)) {
            const num = Number(v);
            if (!Number.isFinite(num)) {
              spec.compileLog.push(`${tag}: set_weights skipped key "${k}" — not a number`);
              continue;
            }
            if (!SCORE_DIMENSIONS.includes(k)) {
              spec.compileLog.push(`${tag}: set_weights skipped unknown dimension "${k}"`);
              continue;
            }
            spec.weights[k] = num;
            applied.push(`${k}=${num}`);
          }
          if (applied.length) spec.compileLog.push(`${tag}: set weights ${applied.join(", ")}`);
          break;
        }
        default:
          spec.compileLog.push(`${tag}: skipped unknown op "${String(op.op)}"`);
      }
    }
  }

  spec.version = (base?.version ?? 1) + list.length;
  return spec;
}

/**
 * Enabled node ids in dependency order (Kahn). Edges from disabled upstreams are
 * ignored so disabling a node does not strand the rest of the pipeline.
 * @throws {Error} naming the cycle when one exists.
 */
export function topoOrder(spec) {
  const nodes = (spec?.nodes || []).filter((n) => n.enabled !== false);
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map();
  const out = new Map();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    out.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.after || []) {
      if (!ids.has(dep)) continue; // dangling or disabled upstream — ignore here
      out.get(dep).push(n.id);
      indeg.set(n.id, indeg.get(n.id) + 1);
    }
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const nxt of out.get(id) || []) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) queue.push(nxt);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    throw new Error(
      `DAG has a cycle among nodes: ${stuck.join(" -> ")}. Break the dependency loop before running.`,
    );
  }
  return order;
}

/**
 * Health check. Returns human-readable problem strings; [] means healthy.
 * @returns {string[]}
 */
export function validateDag(spec) {
  const problems = [];
  const nodes = spec?.nodes || [];
  if (!nodes.length) {
    problems.push("DAG has no nodes.");
    return problems;
  }

  const seen = new Set();
  for (const n of nodes) {
    if (!n.id) problems.push("A node is missing an id.");
    else if (seen.has(n.id)) problems.push(`Duplicate node id "${n.id}".`);
    else seen.add(n.id);
    if (!String(n.instruction || "").trim()) problems.push(`Node "${n.id}" has an empty instruction.`);
  }

  for (const n of nodes) {
    for (const dep of n.after || []) {
      if (!seen.has(dep)) problems.push(`Node "${n.id}" depends on unknown node "${dep}".`);
    }
  }

  const enabled = nodes.filter((n) => n.enabled !== false);
  if (!enabled.length) problems.push("Every node is disabled — the pipeline would do nothing.");
  else {
    const enabledIds = new Set(enabled.map((n) => n.id));
    const entries = enabled.filter((n) => (n.after || []).filter((d) => enabledIds.has(d)).length === 0);
    if (!entries.length) problems.push("No entry node: every enabled node depends on another enabled node.");
  }

  try {
    topoOrder(spec);
  } catch (err) {
    problems.push(err.message);
  }

  const weights = spec?.weights || {};
  const keys = Object.keys(weights);
  if (!keys.length) problems.push("No scoring weights configured.");
  else {
    for (const k of keys) {
      if (!SCORE_DIMENSIONS.includes(k)) problems.push(`Unknown scoring dimension "${k}" in weights.`);
      if (!Number.isFinite(Number(weights[k]))) problems.push(`Weight "${k}" is not a number.`);
      else if (Number(weights[k]) < 0) problems.push(`Weight "${k}" is negative.`);
    }
    const sum = keys.reduce((a, k) => a + (Number(weights[k]) || 0), 0);
    if (Math.abs(sum - 1) > 0.01) problems.push(`Weights sum to ${sum.toFixed(3)}, expected ~1.00.`);
  }

  return problems;
}

/** Mermaid labels are fragile: strip quotes, brackets, parens, newlines, pipes. */
function sanitizeLabel(text) {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/["'`()[\]{}<>|#;]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "node";
}

/** Mermaid node ids must be identifier-safe. */
function safeId(id) {
  const s = String(id ?? "").replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(s) ? s : `n_${s}`;
}

/**
 * Render the spec as a mermaid `graph TD` diagram (mermaid v11 syntax).
 * Patch-origin nodes and disabled nodes get distinct classDefs.
 * @returns {string}
 */
export function dagToMermaid(spec) {
  const nodes = spec?.nodes || [];
  const known = new Set(nodes.map((n) => n.id));
  const lines = ["graph TD"];

  lines.push("  classDef base fill:#171923,stroke:#4b5563,color:#e5e7eb");
  lines.push("  classDef patched fill:#3b1d5e,stroke:#a855f7,color:#fff");
  lines.push("  classDef disabled fill:#111318,stroke:#3f3f46,color:#6b7280,stroke-dasharray: 4 3");

  for (const n of nodes) {
    lines.push(`  ${safeId(n.id)}["${sanitizeLabel(n.label || n.id)}"]`);
  }
  for (const n of nodes) {
    for (const dep of n.after || []) {
      if (!known.has(dep)) continue;
      lines.push(`  ${safeId(dep)} --> ${safeId(n.id)}`);
    }
  }

  const cls = { base: [], patched: [], disabled: [] };
  for (const n of nodes) {
    if (n.enabled === false) cls.disabled.push(safeId(n.id));
    else if (n.origin === "patch") cls.patched.push(safeId(n.id));
    else cls.base.push(safeId(n.id));
  }
  for (const [name, ids] of Object.entries(cls)) {
    if (ids.length) lines.push(`  class ${ids.join(",")} ${name}`);
  }

  return lines.join("\n");
}
