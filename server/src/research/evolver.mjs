// src/research/evolver.mjs — the meta-learning step.
//
// Human feedback in, DagPatch out. This is the loop that makes the pipeline
// evolve: a reviewer says "you're missing memory-care detail and I care more
// about cost than distance", and this turns that sentence into PatchOps that
// compileDag() folds into the next run's spec.
//
// This runs live in a demo. It MUST NEVER THROW. Every failure mode degrades to
// a deterministic heuristic patch instead of an exception.

import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SCORE_DIMENSIONS } from "./contract.mjs";

const OP_KINDS = new Set(["add_node", "edit_instruction", "set_enabled", "set_weights"]);

// ---- guardrails -------------------------------------------------------------

/**
 * Structural safety net applied to any candidate spec before we accept the ops
 * that produced it. Two invariants:
 *   1. `discover` must exist and stay enabled — nothing downstream has input
 *      without it.
 *   2. At least one node must be enabled — an all-off pipeline is a dead run.
 * @param {object} spec DagSpec
 * @returns {object} a repaired copy (never mutates the input)
 */
export function applyGuardrails(spec) {
  const out = {
    ...spec,
    weights: { ...(spec?.weights || {}) },
    nodes: (spec?.nodes || []).map((n) => ({ ...n, after: [...(n.after || [])] })),
    compileLog: [...(spec?.compileLog || [])],
  };

  const discover = out.nodes.find((n) => n.id === "discover");
  if (!discover) {
    out.compileLog.push("guardrail: `discover` node is missing from the spec");
  } else if (discover.enabled === false) {
    discover.enabled = true;
    out.compileLog.push("guardrail: refused to disable `discover` — re-enabled");
  }

  if (out.nodes.length && !out.nodes.some((n) => n.enabled !== false)) {
    for (const n of out.nodes) n.enabled = true;
    out.compileLog.push("guardrail: refused to disable every node — re-enabled all");
  }

  return out;
}

/** True when applying `ops` to `spec` would trip a guardrail. */
function opsTripGuardrails(spec, ops) {
  const nodes = (spec?.nodes || []).map((n) => ({ ...n }));
  for (const op of ops) {
    if (op.op === "add_node") {
      const i = nodes.findIndex((n) => n.id === op.node.id);
      if (i >= 0) nodes[i] = { ...nodes[i], ...op.node };
      else nodes.push({ ...op.node });
    } else if (op.op === "set_enabled") {
      const n = nodes.find((x) => x.id === op.id);
      if (n) n.enabled = !!op.enabled;
    }
  }
  const discover = nodes.find((n) => n.id === "discover");
  if (discover && discover.enabled === false) return true;
  if (nodes.length && !nodes.some((n) => n.enabled !== false)) return true;
  return false;
}

// ---- op validation ----------------------------------------------------------

/**
 * Validate candidate ops against the four PatchOp shapes in contract.mjs.
 * Invalid ops are DROPPED, never thrown.
 * @returns {{ops: any[], dropped: string[]}}
 */
export function validateOps(rawOps, spec) {
  const ops = [];
  const dropped = [];
  const knownIds = new Set((spec?.nodes || []).map((n) => n.id));
  const list = Array.isArray(rawOps) ? rawOps : [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object" || !OP_KINDS.has(raw.op)) {
      dropped.push(`unrecognized op ${JSON.stringify(raw)?.slice(0, 120)}`);
      continue;
    }
    if (raw.op === "add_node") {
      const n = raw.node;
      const id = String(n?.id ?? "").trim();
      const instruction = String(n?.instruction ?? "").trim();
      if (!id || !instruction) {
        dropped.push("add_node without id or instruction");
        continue;
      }
      const after = Array.isArray(n.after) ? n.after.map(String).filter((d) => knownIds.has(d) || d === id) : [];
      ops.push({
        op: "add_node",
        node: {
          id,
          label: String(n.label || id).trim(),
          after: after.filter((d) => d !== id),
          instruction,
          enabled: n.enabled === false ? false : true,
          origin: "patch",
        },
      });
      knownIds.add(id);
      continue;
    }
    if (raw.op === "edit_instruction") {
      const id = String(raw.id ?? "").trim();
      const instruction = String(raw.instruction ?? "").trim();
      if (!id || !instruction) {
        dropped.push("edit_instruction without id or instruction");
        continue;
      }
      if (!knownIds.has(id)) {
        dropped.push(`edit_instruction targets unknown node "${id}"`);
        continue;
      }
      ops.push({ op: "edit_instruction", id, instruction });
      continue;
    }
    if (raw.op === "set_enabled") {
      const id = String(raw.id ?? "").trim();
      if (!id || typeof raw.enabled !== "boolean") {
        dropped.push("set_enabled without id or boolean enabled");
        continue;
      }
      if (!knownIds.has(id)) {
        dropped.push(`set_enabled targets unknown node "${id}"`);
        continue;
      }
      ops.push({ op: "set_enabled", id, enabled: raw.enabled });
      continue;
    }
    // set_weights
    const w = raw.weights;
    if (!w || typeof w !== "object") {
      dropped.push("set_weights without a weights object");
      continue;
    }
    const clean = {};
    for (const [k, v] of Object.entries(w)) {
      const num = Number(v);
      if (!SCORE_DIMENSIONS.includes(k) || !Number.isFinite(num) || num < 0) {
        dropped.push(`set_weights dropped key "${k}"`);
        continue;
      }
      clean[k] = num;
    }
    if (!Object.keys(clean).length) {
      dropped.push("set_weights had no valid dimensions");
      continue;
    }
    ops.push({ op: "set_weights", weights: normalizeWeights({ ...(spec?.weights || {}), ...clean }) });
  }

  // Guardrail sweep: drop the offending op rather than the whole patch.
  const kept = [];
  for (const op of ops) {
    if (opsTripGuardrails(spec, [...kept, op])) {
      dropped.push(`guardrail blocked ${op.op}${op.id ? ` on "${op.id}"` : ""}`);
      continue;
    }
    kept.push(op);
  }
  return { ops: kept, dropped };
}

/** Scale a weight map so it sums to 1 across SCORE_DIMENSIONS. */
export function normalizeWeights(weights) {
  const out = {};
  for (const d of SCORE_DIMENSIONS) out[d] = Math.max(0, Number(weights?.[d]) || 0);
  const sum = SCORE_DIMENSIONS.reduce((a, d) => a + out[d], 0);
  if (sum <= 0) {
    const even = 1 / SCORE_DIMENSIONS.length;
    for (const d of SCORE_DIMENSIONS) out[d] = Number(even.toFixed(4));
    return out;
  }
  for (const d of SCORE_DIMENSIONS) out[d] = Number((out[d] / sum).toFixed(4));
  return out;
}

// ---- JSON extraction --------------------------------------------------------

/** Strip markdown fences and pull the FIRST balanced JSON object out of text. */
export function extractJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let s = text.replace(/```(?:json|JSON)?\s*/g, "```").replace(/```/g, "\n");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const chunk = s.slice(start, i + 1);
        try {
          return JSON.parse(chunk);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- heuristic fallback -----------------------------------------------------

const DIMENSION_WORDS = [
  [/\bdistan|\bmile|\bnear|\bclose|\bproximit/i, "distance"],
  [/\bbed|\bcapacit|\bunit\b|\bsize\b/i, "beds"],
  [/\bfee|\bcost|\bpric|\brate\b|\baffordab|\bexpensiv|\bbudget/i, "fee"],
  [/\bservice|\bmemory\s*care|\bmemorycare|\bmemory\b|\bhome\s*health|\bskilled|\brespite|\bIL\b|\bAL\b/i, "services"],
  [/\baco\b|\bmedicare|\bvalue[- ]based|\bpayer|\bnetwork|\badvantage\b/i, "aco"],
];

/** Deterministic patch used when the model gives us nothing usable. */
export function heuristicPatch({ feedback, spec }) {
  const text = String(feedback || "");
  const hits = [];
  for (const [re, dim] of DIMENSION_WORDS) if (re.test(text) && !hits.includes(dim)) hits.push(dim);

  const base = { ...(spec?.weights || {}) };
  for (const d of SCORE_DIMENSIONS) if (!Number.isFinite(Number(base[d]))) base[d] = 0;

  if (!hits.length) {
    return {
      ops: [],
      rationale:
        "Heuristic fallback: the evolver model returned nothing usable and the feedback named no scoring dimension (distance, beds, fee, services, aco), so the DAG was left unchanged.",
    };
  }

  for (const dim of hits) base[dim] = (Number(base[dim]) || 0) + 0.1;
  const weights = normalizeWeights(base);
  return {
    ops: [{ op: "set_weights", weights }],
    rationale: `Heuristic fallback: the evolver model returned nothing usable, so the feedback was keyword-scanned. It mentions ${hits.join(", ")}, so ${hits
      .map((d) => `\`${d}\``)
      .join(" and ")} was nudged up by 0.1 and all weights renormalized to sum to 1.`,
  };
}

// ---- the model call ---------------------------------------------------------

function compactSample(facilities, limit = 8) {
  const list = Array.isArray(facilities) ? facilities.slice(0, limit) : [];
  return list.map((f) => ({
    name: f?.name ?? null,
    beds: f?.beds?.value ?? null,
    avgMonthlyFee: f?.avgMonthlyFee?.value ?? null,
    distanceMiles: f?.distanceMiles?.value ?? null,
    management: f?.management?.value ?? null,
    acos: f?.acos?.value ?? null,
    services: f?.services?.value ?? null,
    score: typeof f?.score === "number" ? Number(f.score.toFixed(3)) : null,
  }));
}

function buildPrompt({ feedback, currentSpec, facilities }) {
  const nodes = (currentSpec?.nodes || []).map((n) => ({
    id: n.id,
    label: n.label,
    after: n.after,
    enabled: n.enabled !== false,
    instruction: n.instruction,
  }));
  return `You evolve a market-research pipeline that is stored as DATA, not code.

The pipeline finds assisted living facilities (ALFs) in a US ZIP code and reports distance, bed count, average monthly fee, management company, partnered ACOs, and service mix.

CURRENT DAG NODES (JSON):
${JSON.stringify(nodes, null, 2)}

CURRENT SCORING WEIGHTS (must sum to 1, keys exactly ${SCORE_DIMENSIONS.join(", ")}):
${JSON.stringify(currentSpec?.weights || {}, null, 2)}

SAMPLE OF THE RESULT TABLE THE HUMAN REVIEWED:
${JSON.stringify(compactSample(facilities), null, 2)}

THE HUMAN'S FEEDBACK:
"""
${String(feedback || "").slice(0, 4000)}
"""

Translate that feedback into the smallest set of patch operations that would make the NEXT run satisfy it. Prefer rewording an existing node's instruction over adding a node. Add a node only when a genuinely new kind of information is being requested. Adjust weights only when the feedback expresses a change in what matters.

Reply with ONLY a JSON object, no prose and no markdown fences:
{
  "rationale": "one or two sentences explaining the change",
  "ops": [ ... ]
}

Each op must be EXACTLY one of these four shapes:
{"op":"add_node","node":{"id":"snake_case_id","label":"Short Label","after":["existing_node_id"],"instruction":"natural language instruction the agent will execute","enabled":true,"origin":"patch"}}
{"op":"edit_instruction","id":"existing_node_id","instruction":"new instruction text"}
{"op":"set_enabled","id":"existing_node_id","enabled":false}
{"op":"set_weights","weights":{"distance":0.2,"beds":0.2,"fee":0.3,"services":0.15,"aco":0.15}}

Rules: never disable the "discover" node. never disable every node. new nodes must depend on at least one existing node, usually "discover", and enrichment nodes should be added to the "after" list conceptually upstream of "score". weights keys are limited to ${SCORE_DIMENSIONS.join(", ")} and must sum to 1. Return an empty ops array if the feedback requires no pipeline change.`;
}

/** Drive the Agent SDK once and concatenate the assistant's text output. */
async function askModel(prompt, { signal } = {}) {
  let text = "";
  const q = query({
    prompt,
    options: { maxTurns: 1, allowedTools: [], permissionMode: "bypassPermissions" },
  });
  const onAbort = () => {
    try {
      q.close?.();
    } catch {}
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    for await (const msg of q) {
      if (msg?.type === "assistant") {
        const content = msg.message?.content;
        if (typeof content === "string") text += content;
        else if (Array.isArray(content)) {
          for (const block of content) if (block?.type === "text" && block.text) text += block.text;
        }
      } else if (msg?.type === "result") {
        if (msg.subtype === "success" && typeof msg.result === "string" && !text.trim()) text += msg.result;
      }
    }
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }
  return text;
}

// ---- public entry point -----------------------------------------------------

/**
 * Turn human feedback into a DagPatch. NEVER throws.
 *
 * @param {object} args
 * @param {string} args.feedback     the human's words
 * @param {string} [args.runId]      run the feedback came from
 * @param {object} args.currentSpec  the DagSpec that produced the reviewed table
 * @param {Array}  [args.facilities] the reviewed result rows
 * @returns {Promise<{id:string,createdAt:string,runId:(string|null),feedback:string,rationale:string,ops:any[],source:string,dropped:string[]}>}
 */
export async function evolveFromFeedback({ feedback, runId, currentSpec, facilities } = {}) {
  const id = `patch_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const spec = currentSpec && Array.isArray(currentSpec.nodes) ? applyGuardrails(currentSpec) : { nodes: [], weights: {} };
  const fb = String(feedback ?? "");

  let source = "model";
  let rationale = "";
  let ops = [];
  let dropped = [];

  try {
    const text = await askModel(buildPrompt({ feedback: fb, currentSpec: spec, facilities }));
    const parsed = extractJsonObject(text);
    if (parsed) {
      const v = validateOps(parsed.ops, spec);
      ops = v.ops;
      dropped = v.dropped;
      rationale = String(parsed.rationale ?? "").trim();
    } else {
      dropped.push("model output contained no parseable JSON object");
    }
  } catch (err) {
    dropped.push(`model call failed: ${err?.message || String(err)}`);
  }

  if (!ops.length) {
    const h = heuristicPatch({ feedback: fb, spec });
    const v = validateOps(h.ops, spec);
    ops = v.ops;
    dropped = dropped.concat(v.dropped);
    rationale = h.rationale;
    source = "heuristic";
  } else if (!rationale) {
    rationale = `Applied ${ops.length} patch operation${ops.length === 1 ? "" : "s"} derived from the reviewer's feedback.`;
  }

  return { id, createdAt, runId: runId ?? null, feedback: fb, rationale, ops, source, dropped };
}

export default { evolveFromFeedback, applyGuardrails, validateOps, normalizeWeights, extractJsonObject, heuristicPatch };
