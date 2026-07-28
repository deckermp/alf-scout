/**
 * SHARED CONTRACT — every module in alf-scout imports types from here.
 * Do not redefine these shapes anywhere else.
 */

// ---------- Domain ----------

export type ServiceType = "IL" | "AL" | "MemoryCare" | "HomeHealth" | "SNF" | "Respite";

export type Provenance = {
  /** Where this value came from. */
  source: "web" | "model_inference" | "state_registry" | "user_correction" | "unknown";
  /** 0..1 — how much we trust it. */
  confidence: number;
  /** Human-readable citation or reasoning. */
  note?: string;
};

/** A field paired with where it came from. Never ship a bare number. */
export type Sourced<T> = { value: T | null; prov: Provenance };

export type Facility = {
  id: string;
  name: string;
  address: Sourced<string>;
  zip: string;
  distanceMiles: Sourced<number>;
  beds: Sourced<number>;
  avgMonthlyFee: Sourced<number>;
  management: Sourced<string>;
  acos: Sourced<string[]>;
  services: Sourced<ServiceType[]>;
  /** Composite score produced by the scoring node; drives default sort. */
  score: number;
  /** Per-node notes for the trace panel. */
  notes: string[];
};

// ---------- DAG / meta-learning ----------

export type NodeId =
  | "discover"
  | "enrich_management"
  | "enrich_aco"
  | "enrich_services"
  | "score"
  | "rank"
  | string; // patches may introduce new node ids

export type DagNodeSpec = {
  id: NodeId;
  label: string;
  /** Which node(s) feed this one. */
  after: NodeId[];
  /** Natural-language instruction the node's agent executes. Mutable by patches. */
  instruction: string;
  /** Set false to prune a node without deleting its history. */
  enabled: boolean;
  /** Where this node came from. */
  origin: "base" | "patch";
};

export type DagSpec = {
  version: number;
  nodes: DagNodeSpec[];
  /** Weights used by the score node. Mutable by patches. */
  weights: Record<string, number>;
};

/** What the meta-learner emits after reading human feedback. */
export type DagPatch = {
  id: string;
  createdAt: string;
  /** The raw human feedback that caused this patch. */
  feedback: string;
  rationale: string;
  ops: PatchOp[];
};

export type PatchOp =
  | { op: "add_node"; node: DagNodeSpec }
  | { op: "edit_instruction"; id: NodeId; instruction: string }
  | { op: "set_enabled"; id: NodeId; enabled: boolean }
  | { op: "set_weights"; weights: Record<string, number> };

// ---------- Run / HITL ----------

export type HitlRequest = {
  id: string;
  runId: string;
  nodeId: NodeId;
  kind: "approve_plan" | "approve_tool" | "review_results";
  question: string;
  payload: unknown;
};

export type HitlResponse = {
  requestId: string;
  decision: "approve" | "reject" | "edit";
  feedback?: string;
  edited?: unknown;
};

export type RunEvent =
  | { t: "node_start"; nodeId: NodeId; at: number }
  | { t: "node_end"; nodeId: NodeId; at: number; summary: string }
  | { t: "tool"; nodeId: NodeId; name: string; input: unknown; at: number }
  | { t: "hitl"; request: HitlRequest; at: number }
  | { t: "hitl_resolved"; response: HitlResponse; at: number }
  | { t: "patch"; patch: DagPatch; at: number }
  | { t: "done"; facilities: Facility[]; at: number }
  | { t: "error"; message: string; at: number };

export type RunState = {
  runId: string;
  zip: string;
  dag: DagSpec;
  facilities: Facility[];
  events: RunEvent[];
  pendingHitl: HitlRequest | null;
};
