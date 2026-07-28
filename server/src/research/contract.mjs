// src/research/contract.mjs — the ONE shared shape definition for the research
// surface (S-19). Every module under src/research/ and the dashboard's
// views/research/ speaks these shapes. Do not redefine them anywhere else.
//
// The thesis: the DAG is DATA, not code. A node is a row with an `instruction`
// string that an agent executes. That is what lets a human's feedback add,
// disable, or reword a node at runtime — evolving the pipeline without anyone
// opening an editor.

/**
 * @typedef {"IL"|"AL"|"MemoryCare"|"HomeHealth"|"SNF"|"Respite"} ServiceType
 *
 * @typedef {Object} Provenance
 * @property {"web"|"model_inference"|"state_registry"|"user_correction"|"unknown"} source
 * @property {number} confidence  0..1
 * @property {string} [note]      citation or reasoning
 *
 * @typedef {Object} Sourced
 * @property {any} value          null when unknown — never invent a number
 * @property {Provenance} prov
 *
 * @typedef {Object} Facility
 * @property {string} id
 * @property {string} name
 * @property {Sourced} address
 * @property {string} zip
 * @property {Sourced} distanceMiles
 * @property {Sourced} beds
 * @property {Sourced} avgMonthlyFee
 * @property {Sourced} management
 * @property {Sourced} acos           value: string[]
 * @property {Sourced} services       value: ServiceType[]
 * @property {number} score           0..1 composite, drives default sort
 * @property {string[]} notes
 *
 * @typedef {Object} DagNodeSpec
 * @property {string} id
 * @property {string} label
 * @property {string[]} after        upstream node ids ([] = entry node)
 * @property {string} instruction    natural language; executed by the harness
 * @property {boolean} enabled
 * @property {"base"|"patch"} origin
 *
 * @typedef {Object} DagSpec
 * @property {number} version
 * @property {DagNodeSpec[]} nodes
 * @property {Record<string,number>} weights
 *
 * @typedef {{op:"add_node",node:DagNodeSpec}
 *         | {op:"edit_instruction",id:string,instruction:string}
 *         | {op:"set_enabled",id:string,enabled:boolean}
 *         | {op:"set_weights",weights:Record<string,number>}} PatchOp
 *
 * @typedef {Object} DagPatch
 * @property {string} id
 * @property {string} createdAt
 * @property {string} feedback     the human words that caused this
 * @property {string} rationale    the evolver's reasoning
 * @property {PatchOp[]} ops
 *
 * @typedef {Object} HitlRequest
 * @property {string} id
 * @property {string} runId
 * @property {string} nodeId
 * @property {"approve_plan"|"approve_tool"|"review_results"} kind
 * @property {string} question
 * @property {any} payload
 *
 * @typedef {Object} HitlResponse
 * @property {string} requestId
 * @property {"approve"|"reject"|"edit"} decision
 * @property {string} [feedback]
 * @property {any} [edited]
 */

/** SSE event type prefix broadcast through server/src/bus.mjs. */
export const RESEARCH_EVENT = "research";

/** Run lifecycle states. */
export const RUN_STATUS = /** @type {const} */ ({
  RUNNING: "running",
  AWAITING_HUMAN: "awaiting_human",
  DONE: "done",
  ERROR: "error",
});

/** The scoring dimensions. Weight keys must match these exactly. */
export const SCORE_DIMENSIONS = ["distance", "beds", "fee", "services", "aco"];

/** Build an unknown-valued Sourced field. Prefer this over inventing data. */
export function unknown(note = "not found") {
  return { value: null, prov: { source: "unknown", confidence: 0, note } };
}

/** Build a Sourced field with explicit provenance. */
export function sourced(value, source, confidence, note) {
  return { value, prov: { source, confidence, note } };
}
