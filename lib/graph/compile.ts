/**
 * Runtime DAG compiler: folds human-feedback-derived patches onto a base
 * spec, then turns the resulting DagSpec into an executable LangGraph
 * StateGraph. Nothing here is hand-wired — add/edit/disable a node or
 * reweight scoring purely by producing a DagPatch; no code change needed.
 */
import {
  END,
  MemorySaver,
  START,
  StateGraph,
  type CompiledStateGraph,
} from "@langchain/langgraph";
import type { DagNodeSpec, DagPatch, DagSpec } from "@/lib/contract";
import { GraphAnnotation, makeNode, type GraphState, type NodeDeps } from "./nodes";

// ---------- Patch folding ----------

/**
 * Applies `patches` in order on top of `base`, returning a brand new DagSpec
 * (never mutates `base`). Version is bumped once per patch folded in, so the
 * resulting version number tells you how many human-feedback rounds shaped
 * this spec.
 */
export function compileDag(base: DagSpec, patches: DagPatch[]): DagSpec {
  let nodes: DagNodeSpec[] = base.nodes.map((n) => ({ ...n }));
  let weights: Record<string, number> = { ...base.weights };
  let version = base.version;

  for (const patch of patches) {
    for (const op of patch.ops) {
      switch (op.op) {
        case "add_node": {
          const idx = nodes.findIndex((n) => n.id === op.node.id);
          if (idx >= 0) {
            nodes = nodes.map((n, i) => (i === idx ? { ...op.node } : n));
          } else {
            nodes = [...nodes, { ...op.node }];
          }
          break;
        }
        case "edit_instruction": {
          nodes = nodes.map((n) =>
            n.id === op.id ? { ...n, instruction: op.instruction } : n,
          );
          break;
        }
        case "set_enabled": {
          nodes = nodes.map((n) => (n.id === op.id ? { ...n, enabled: op.enabled } : n));
          break;
        }
        case "set_weights": {
          weights = { ...weights, ...op.weights };
          break;
        }
        default: {
          const exhaustive: never = op;
          throw new Error(`compileDag: unhandled patch op ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    version += 1;
  }

  return { version, nodes, weights };
}

// ---------- Graph construction ----------

/**
 * Builds and compiles a LangGraph StateGraph from a DagSpec. Only ENABLED
 * nodes get wired in; edges follow each node's `after` list — nodes with an
 * empty `after` connect from START, and any enabled node that nothing else
 * downstream depends on connects to END. This tolerates patch-introduced
 * node ids transparently since it never assumes a fixed node set.
 *
 * The node names are only knowable at runtime (they come from data), which
 * is fundamentally incompatible with LangGraph's compile-time-literal node
 * typing (`StateGraph<..., N extends string>`). The state channels
 * themselves (via GraphAnnotation) stay fully typed; the builder handle is
 * deliberately loosely typed here — that's the price of "compiled at
 * runtime from data" and is safe because `makeNode`/`addEdge` only ever see
 * plain strings at runtime regardless of what TS believes at compile time.
 */
export function buildGraph(spec: DagSpec, deps: NodeDeps) {
  const enabled = spec.nodes.filter((n) => n.enabled);
  const enabledIds = new Set(enabled.map((n) => n.id));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = new StateGraph(GraphAnnotation) as any;

  for (const nodeSpec of enabled) {
    builder.addNode(nodeSpec.id, makeNode(nodeSpec, deps));
  }

  // A node is "terminal" if no other enabled node lists it in `after`.
  const referenced = new Set<string>();
  for (const nodeSpec of enabled) {
    for (const upstream of nodeSpec.after) {
      if (enabledIds.has(upstream)) referenced.add(upstream);
    }
  }

  for (const nodeSpec of enabled) {
    const upstreamEnabled = nodeSpec.after.filter((id) => enabledIds.has(id));
    if (upstreamEnabled.length === 0) {
      builder.addEdge(START, nodeSpec.id);
    } else {
      for (const upstream of upstreamEnabled) {
        builder.addEdge(upstream, nodeSpec.id);
      }
    }
    if (!referenced.has(nodeSpec.id)) {
      builder.addEdge(nodeSpec.id, END);
    }
  }

  const checkpointer = new MemorySaver();
  const compiled: CompiledStateGraph<GraphState, Partial<GraphState>, string> = builder.compile({
    checkpointer,
  });
  return compiled;
}

// ---------- Mermaid rendering (for the UI) ----------

function safeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_") || "node";
}

/**
 * Renders a DagSpec as a mermaid `graph TD` string. Disabled nodes are
 * omitted (they're not part of the executable graph); patch-origin nodes get
 * a distinct `patchNode` class so the UI can style them differently from the
 * base-authored nodes.
 */
export function dagToMermaid(spec: DagSpec): string {
  const enabled = spec.nodes.filter((n) => n.enabled);
  const enabledIds = new Set(enabled.map((n) => n.id));

  const referenced = new Set<string>();
  for (const n of enabled) {
    for (const upstream of n.after) {
      if (enabledIds.has(upstream)) referenced.add(upstream);
    }
  }

  const lines: string[] = ["graph TD"];

  for (const n of enabled) {
    const label = n.label.replace(/"/g, "'");
    lines.push(`  ${safeMermaidId(n.id)}["${label}"]`);
  }

  for (const n of enabled) {
    const upstreamEnabled = n.after.filter((id) => enabledIds.has(id));
    if (upstreamEnabled.length === 0) {
      lines.push(`  START([START]) --> ${safeMermaidId(n.id)}`);
    } else {
      for (const upstream of upstreamEnabled) {
        lines.push(`  ${safeMermaidId(upstream)} --> ${safeMermaidId(n.id)}`);
      }
    }
    if (!referenced.has(n.id)) {
      lines.push(`  ${safeMermaidId(n.id)} --> END([END])`);
    }
  }

  const patchNodeIds = enabled.filter((n) => n.origin === "patch").map((n) => safeMermaidId(n.id));
  if (patchNodeIds.length > 0) {
    lines.push("  classDef patchNode fill:#f9a825,stroke:#e65100,color:#000,stroke-width:2px;");
    lines.push(`  class ${patchNodeIds.join(",")} patchNode;`);
  }

  return lines.join("\n");
}
