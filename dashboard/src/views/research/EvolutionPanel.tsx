// S-19 · the meta-learning ledger. Reverse-chronological patches, each one a
// legible causal chain: HUMAN WORDS → evolver's rationale → the structural
// change it made to the graph. Every patch is revertible, because a pipeline
// that can only accumulate changes is not learning, it's drifting.
import { useState } from "react";
import { RotateCcw, Undo2 } from "lucide-react";
import { Button, EmptyNote } from "../../components/ui";
import type { DagPatch, PatchOp } from "./useResearch";

const v = (n: string) => `var(--${n})`;
const mono2xs = {
  fontFamily: v("font-mono"), fontSize: v("text-2xs"), letterSpacing: v("tracking-mono"),
} as const;

function opLine(op: PatchOp): string {
  switch (op?.op) {
    case "add_node":
      return `added node: ${op.node?.id ?? "?"}${op.node?.label ? ` — ${op.node.label}` : ""}`;
    case "edit_instruction":
      return `reworded ${op.id}: "${trunc(op.instruction, 90)}"`;
    case "set_enabled":
      return `${op.enabled ? "enabled" : "disabled"} node: ${op.id}`;
    case "set_weights":
      return `weights: ${Object.entries(op.weights ?? {}).map(([k, w]) => `${k} → ${Number(w).toFixed(2)}`).join(", ")}`;
    default:
      return `unknown op: ${JSON.stringify(op)}`;
  }
}

function trunc(s: string, n: number): string {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isFinite(d.getTime()) ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

export function EvolutionPanel({
  patches, busy, onFeedback, onToggle,
}: {
  patches: DagPatch[];
  busy: boolean;
  onFeedback: (text: string) => void;
  onToggle: (id: string, active: boolean) => void;
}) {
  const [text, setText] = useState("");

  return (
    <section
      style={{
        border: v("hair"), borderRadius: v("r-md"), background: v("ink-2"),
        padding: v("sp-4"), display: "flex", flexDirection: "column", gap: v("sp-3"),
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: v("sp-2") }}>
        <span style={{ ...mono2xs, textTransform: "uppercase", letterSpacing: v("tracking-wide"), color: v("fg-2") }}>
          evolution
        </span>
        <span style={{ ...mono2xs, color: v("fg-3") }}>
          {patches.length} {patches.length === 1 ? "patch" : "patches"}
        </span>
      </div>

      {/* ---- composer: the human's words are the input to the next pipeline -- */}
      <div style={{ display: "flex", flexDirection: "column", gap: v("sp-2") }}>
        <label htmlFor="research-feedback" style={{ fontSize: v("text-sm"), color: v("fg-1") }}>
          What was wrong with these results?
        </label>
        <textarea
          id="research-feedback"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="e.g. memory-care bed counts are missing everywhere, and you're weighting distance too hard"
          style={{
            fontFamily: v("font-ui"), fontSize: v("text-sm"), lineHeight: 1.5,
            background: v("ink-1"), color: v("fg-0"), border: v("hair"),
            borderRadius: v("r-sm"), padding: v("sp-3"), resize: "vertical",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: v("sp-2") }}>
          <Button
            variant="primary"
            onClick={() => { const t = text.trim(); if (!t || busy) return; onFeedback(t); setText(""); }}
          >
            {busy ? "evolving…" : "Rewrite the pipeline"}
          </Button>
          <span style={{ ...mono2xs, color: v("fg-3") }}>
            your words → a patch → a new DAG version
          </span>
        </div>
      </div>

      {/* ---- history --------------------------------------------------------- */}
      {patches.length === 0 ? (
        <EmptyNote>
          the pipeline has never been corrected — the DAG is still exactly as it shipped
        </EmptyNote>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: v("sp-3") }}>
          {patches.map((p) => {
            const active = p.active !== false;
            return (
              <li
                key={p.id}
                style={{
                  border: active ? v("hair") : `1px dashed ${v("ink-4")}`,
                  borderLeft: `2px solid ${active ? v("anno") : v("ink-5")}`,
                  borderRadius: v("r-sm"),
                  background: v("ink-1"),
                  padding: v("sp-3"),
                  display: "flex", flexDirection: "column", gap: v("sp-2"),
                  opacity: active ? 1 : 0.55,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: v("sp-2"), flexWrap: "wrap" }}>
                  <span style={{ ...mono2xs, color: v("fg-3") }}>{when(p.createdAt)}</span>
                  <span style={{ ...mono2xs, color: v("fg-3") }}>· {p.id?.slice(0, 8)}</span>
                  {!active && <span style={{ ...mono2xs, color: v("fg-3") }}>· reverted</span>}
                  <span style={{ marginLeft: "auto" }}>
                    <Button
                      onClick={() => onToggle(p.id, !active)}
                      style={{ padding: "3px 9px", fontSize: v("text-2xs") }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        {active ? <><Undo2 size={12} /> Revert</> : <><RotateCcw size={12} /> Restore</>}
                      </span>
                    </Button>
                  </span>
                </div>

                {/* human words — the cause */}
                <blockquote
                  style={{
                    margin: 0, paddingLeft: v("sp-3"),
                    borderLeft: `2px solid ${v("anno-dim")}`,
                    fontFamily: v("font-logbook"), fontSize: v("text-sm"),
                    color: v("anno"), fontStyle: "italic",
                  }}
                >
                  “{p.feedback || "(no feedback recorded)"}”
                </blockquote>

                {/* the evolver's reasoning — the middle of the chain */}
                {p.rationale && (
                  <span style={{ fontSize: v("text-xs"), color: v("fg-1"), lineHeight: 1.5 }}>
                    <span style={{ ...mono2xs, color: v("fg-3") }}>rationale · </span>
                    {p.rationale}
                  </span>
                )}

                {/* the ops — the structural effect */}
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  {(p.ops ?? []).map((op, i) => (
                    <li key={i} style={{ ...mono2xs, color: active ? v("phosphor") : v("fg-3"), display: "flex", gap: v("sp-2") }}>
                      <span aria-hidden>→</span>
                      <span style={{ textDecoration: active ? undefined : "line-through" }}>{opLine(op)}</span>
                    </li>
                  ))}
                  {(!p.ops || p.ops.length === 0) && (
                    <li style={{ ...mono2xs, color: v("fg-3") }}>→ no structural change recorded</li>
                  )}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
