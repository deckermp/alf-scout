/**
 * Node factory + pure scoring/ranking logic for the runtime-compiled DAG.
 *
 * This file has ZERO dependency on the harness (no Anthropic/Claude SDK
 * imports). Everything the nodes need from the outside world — the LLM
 * executor, event sink, and the HITL on/off switch — is injected via `deps`
 * so this module stays a pure function of (spec, deps) -> LangGraph node.
 */
import { Annotation, interrupt } from "@langchain/langgraph";
import type {
  DagNodeSpec,
  DagSpec,
  Facility,
  HitlRequest,
  HitlResponse,
  RunEvent,
  Sourced,
} from "@/lib/contract";

// ---------- Graph state ----------

/**
 * `enrich_management`/`enrich_aco`/`enrich_services` all run in parallel
 * (they share `after: ["discover"]`), and each writes back the *entire*
 * facilities array with only its own field(s) populated. A plain
 * last-value channel can't accept concurrent writes in the same step
 * (LangGraph throws INVALID_CONCURRENT_GRAPH_UPDATE), so `facilities` needs
 * a reducer that merges those concurrent partial views by facility id:
 * per Sourced field, prefer whichever side actually has a value, breaking
 * ties by confidence.
 */
function mergeSourced<T>(left: Sourced<T>, right: Sourced<T>): Sourced<T> {
  if (left.value === null) return right;
  if (right.value === null) return left;
  return right.prov.confidence >= left.prov.confidence ? right : left;
}

function mergeFacility(left: Facility, right: Facility): Facility {
  return {
    ...left,
    ...right,
    address: mergeSourced(left.address, right.address),
    distanceMiles: mergeSourced(left.distanceMiles, right.distanceMiles),
    beds: mergeSourced(left.beds, right.beds),
    avgMonthlyFee: mergeSourced(left.avgMonthlyFee, right.avgMonthlyFee),
    management: mergeSourced(left.management, right.management),
    acos: mergeSourced(left.acos, right.acos),
    services: mergeSourced(left.services, right.services),
    notes: left.notes === right.notes ? left.notes : Array.from(new Set([...left.notes, ...right.notes])),
  };
}

/**
 * Order follows `right`, not `left`: every node here returns the complete
 * facilities array (never a subset), so `right` always reflects the latest
 * writer's intent — critically, `rank`'s sort order must win, not get
 * discarded back to insertion order. `left` is only consulted to pull in
 * field-level data other concurrent writers already contributed.
 */
function mergeFacilities(left: Facility[], right: Facility[]): Facility[] {
  const leftById = new Map(left.map((f) => [f.id, f] as const));
  return right.map((incoming) => {
    const existing = leftById.get(incoming.id);
    return existing ? mergeFacility(existing, incoming) : incoming;
  });
}

/**
 * Shared state threaded through every node. Mirrors the fields of RunState
 * that the graph itself needs to read/write; `runId`/`zip` are supplied at
 * invoke time and treated as last-value, `events` accumulates (nodes append,
 * never overwrite), `facilities` merges concurrent per-field writes (see
 * `mergeFacilities` above), `dag`/`pendingHitl` are overwritten by the node
 * that last touched them.
 */
export const GraphAnnotation = Annotation.Root({
  runId: Annotation<string>,
  zip: Annotation<string>,
  dag: Annotation<DagSpec>,
  facilities: Annotation<Facility[]>({
    reducer: mergeFacilities,
    default: () => [] as Facility[],
  }),
  events: Annotation<RunEvent[]>({
    reducer: (left: RunEvent[], right: RunEvent[] | RunEvent) =>
      left.concat(right),
    default: () => [] as RunEvent[],
  }),
  pendingHitl: Annotation<HitlRequest | null>,
});

export type GraphState = typeof GraphAnnotation.State;
export type GraphUpdate = typeof GraphAnnotation.Update;

/** What the harness must supply for the nodes in this file to run. */
export type NodeDeps = {
  /**
   * Runs a single enrichment/discovery instruction against the current
   * state (e.g. via the Claude Agent SDK) and returns a partial state
   * update — at minimum an updated `facilities` array. Not called for the
   * built-in `score`/`rank` nodes, which are pure local computation.
   */
  execute: (instruction: string, state: GraphState) => Promise<Partial<GraphState>>;
  /** Sink for RunEvents (e.g. push onto an SSE stream / the events log). */
  emit: (event: RunEvent) => void;
  /** Master switch for whether discover/rank should pause for a human. */
  hitlEnabled: boolean;
};

// ---------- Node factory ----------

/**
 * Builds a LangGraph node function for a single DagNodeSpec. `score` and
 * `rank` are handled as pure local computation; every other node id
 * (including patch-introduced ones) is delegated to `deps.execute`.
 */
export function makeNode(spec: DagNodeSpec, deps: NodeDeps) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const startedAt = Date.now();
    deps.emit({ t: "node_start", nodeId: spec.id, at: startedAt });

    let facilities = state.facilities;
    let summary: string;

    if (spec.id === "score") {
      facilities = scoreNode(state.dag.weights)(facilities);
      summary = `scored ${facilities.length} facilities`;
    } else if (spec.id === "rank") {
      facilities = rankNode()(facilities);
      summary = `ranked ${facilities.length} facilities`;
    } else {
      const result = await deps.execute(spec.instruction, state);
      facilities = result.facilities ?? facilities;
      summary = `executed "${spec.label}"`;
    }

    // HITL checkpoints: pause after discovery (approve the candidate set
    // before spending enrichment calls on it) and after the final ranking
    // (approve/edit the results a human will actually see).
    if ((spec.id === "discover" || spec.id === "rank") && deps.hitlEnabled) {
      const request: HitlRequest = {
        id: `hitl-${spec.id}-${startedAt}`,
        runId: state.runId,
        nodeId: spec.id,
        kind: spec.id === "discover" ? "approve_plan" : "review_results",
        question:
          spec.id === "discover"
            ? `Discovered ${facilities.length} facilities in ${state.zip}. Approve to continue enrichment, or edit the list.`
            : `Final ranking ready for ${state.zip} (${facilities.length} facilities). Approve, edit, or reject.`,
        payload: facilities,
      };
      deps.emit({ t: "hitl", request, at: Date.now() });
      const response = interrupt<HitlRequest, HitlResponse>(request);
      deps.emit({ t: "hitl_resolved", response, at: Date.now() });
      if (response?.decision === "edit" && Array.isArray(response.edited)) {
        facilities = response.edited as Facility[];
      }
    }

    const endedAt = Date.now();
    deps.emit({ t: "node_end", nodeId: spec.id, at: endedAt, summary });

    return {
      facilities,
      events: [
        { t: "node_start", nodeId: spec.id, at: startedAt },
        { t: "node_end", nodeId: spec.id, at: endedAt, summary },
      ],
    };
  };
}

// ---------- Scoring ----------

type Range = { min: number; max: number };

function rangeOf(values: (number | null)[]): Range | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return { min: Math.min(...present), max: Math.max(...present) };
}

/** Min-max normalize a value into 0..1. `higherIsBetter=false` flips it (e.g. distance/fee). */
function normalize(value: number, range: Range, higherIsBetter: boolean): number {
  if (range.max === range.min) return 1; // only one distinct value in the set — nothing to discriminate on
  const t = (value - range.min) / (range.max - range.min);
  return higherIsBetter ? t : 1 - t;
}

/**
 * Pure function: computes each Facility's composite `score` (0..1) from the
 * given weights. Returns a NEW array; never mutates the input.
 *
 * Every normalized dimension is multiplied by that field's own
 * `prov.confidence` before being weighted into the composite. This is a
 * deliberate honesty property: a facility we are unsure about (low
 * confidence, e.g. model-inferred rather than sourced from the web) cannot
 * out-rank a facility we are confident about, even if its raw normalized
 * value looks better. Unverified data literally cannot dominate the ranking.
 */
export function scoreNode(weights: Record<string, number>) {
  return function score(facilities: Facility[]): Facility[] {
    if (facilities.length === 0) return facilities;

    const distanceRange = rangeOf(facilities.map((f) => f.distanceMiles.value));
    const bedsRange = rangeOf(facilities.map((f) => f.beds.value));
    const feeRange = rangeOf(facilities.map((f) => f.avgMonthlyFee.value));
    const servicesRange = rangeOf(facilities.map((f) => f.services.value?.length ?? null));
    const acoRange = rangeOf(facilities.map((f) => f.acos.value?.length ?? null));

    const weightKeys = ["distance", "beds", "fee", "services", "aco"] as const;
    const weightSum = weightKeys.reduce((sum, k) => sum + (weights[k] ?? 0), 0) || 1;

    return facilities.map((f) => {
      const notes = [...f.notes];

      const dim = (
        name: string,
        sourced: { value: number | null; prov: { confidence: number } },
        range: Range | null,
        higherIsBetter: boolean,
      ): number => {
        if (sourced.value === null || range === null) {
          notes.push(`score: ${name} unknown, treated as neutral (0.5)`);
          return 0.5;
        }
        return normalize(sourced.value, range, higherIsBetter) * sourced.prov.confidence;
      };

      const distanceScore = dim("distance", f.distanceMiles, distanceRange, false);
      const bedsScore = dim("beds", f.beds, bedsRange, true);
      const feeScore = dim("fee", f.avgMonthlyFee, feeRange, false);
      const servicesScore = dim(
        "services",
        { value: f.services.value?.length ?? null, prov: f.services.prov },
        servicesRange,
        true,
      );
      const acoScore = dim(
        "aco",
        { value: f.acos.value?.length ?? null, prov: f.acos.prov },
        acoRange,
        true,
      );

      const rawScore =
        (weights.distance ?? 0) * distanceScore +
        (weights.beds ?? 0) * bedsScore +
        (weights.fee ?? 0) * feeScore +
        (weights.services ?? 0) * servicesScore +
        (weights.aco ?? 0) * acoScore;

      const composite = Math.max(0, Math.min(1, rawScore / weightSum));

      return { ...f, score: composite, notes };
    });
  };
}

/** Pure function: sorts facilities descending by score. Returns a NEW array. */
export function rankNode() {
  return function rank(facilities: Facility[]): Facility[] {
    return [...facilities].sort((a, b) => b.score - a.score);
  };
}
