// S-19 · the pipeline, drawn. The mermaid string comes from GET /api/research/dag
// and CHANGES between runs — that version number climbing is the whole story of
// this screen, so it gets the biggest type in the panel.
//
// Two independent status layers, on purpose: the SVG gets tinted where we can
// match node ids, and a plain node list underneath always shows run state. If
// mermaid throws (malformed graph from an evolved spec is a real possibility),
// the raw code renders in a <pre> — never a blank panel.
import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import { Badge, EmptyNote } from "../../components/ui";
import type { DagSpec, NodeRuntime } from "./useResearch";

const v = (n: string) => `var(--${n})`;
const mono2xs = {
  fontFamily: v("font-mono"), fontSize: v("text-2xs"), letterSpacing: v("tracking-mono"),
} as const;

let initialised = false;
function ensureInit() {
  if (initialised) return;
  try {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose", fontFamily: "IBM Plex Mono, monospace" });
    initialised = true;
  } catch { /* a failed init still leaves the <pre> fallback working */ }
}

export function DagPanel({
  spec, code, problems, nodeStates,
}: {
  spec: DagSpec | null;
  code: string;
  problems: string[];
  nodeStates: Record<string, NodeRuntime>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [renderErr, setRenderErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const el = host.current;
    if (!el) return;
    if (!code || !code.trim()) { el.innerHTML = ""; setRenderErr(null); return; }
    ensureInit();
    (async () => {
      try {
        const { svg } = await mermaid.render(`research-dag-${uid}-${Date.now()}`, code);
        if (dead || !host.current) return;
        host.current.innerHTML = svg;
        const s = host.current.querySelector("svg");
        if (s) { s.removeAttribute("height"); (s as SVGElement).style.maxWidth = "100%"; }
        setRenderErr(null);
      } catch (e) {
        if (dead) return;
        if (host.current) host.current.innerHTML = "";
        setRenderErr((e as Error)?.message || "mermaid failed to render this graph");
      }
    })();
    return () => { dead = true; };
  }, [code, uid]);

  // Tint whatever node shapes we can match. Mermaid ids look like
  // `flowchart-<nodeId>-<n>`; we match on substring so a version bump in
  // mermaid's id scheme degrades to "no tint", not to a crash.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const svg = el.querySelector("svg");
    if (!svg) return;
    for (const [id, rt] of Object.entries(nodeStates)) {
      const hit =
        svg.querySelector(`[id^="flowchart-${cssEsc(id)}-"]`) ||
        svg.querySelector(`[id*="-${cssEsc(id)}-"]`) ||
        svg.querySelector(`[id="${cssEsc(id)}"]`);
      if (!hit) continue;
      const g = hit as SVGGElement;
      const tone = rt.state === "error" ? v("err") : rt.state === "running" ? v("phosphor") : v("lane-do");
      g.querySelectorAll("rect, polygon, circle, path.basic").forEach((shape) => {
        (shape as SVGElement).style.stroke = tone;
        (shape as SVGElement).style.strokeWidth = "2px";
      });
      g.style.filter = rt.state === "running" ? "drop-shadow(0 0 6px rgba(116,228,140,0.6))" : "";
      if (rt.state === "running") g.classList.add("ah-live");
      else g.classList.remove("ah-live");
    }
  }, [nodeStates, code]);

  const nodes = spec?.nodes ?? [];
  const doneCount = nodes.filter((n) => nodeStates[n.id]?.state === "done").length;

  return (
    <section
      style={{
        border: v("hair"), borderRadius: v("r-md"), background: v("ink-2"),
        padding: v("sp-4"), display: "flex", flexDirection: "column", gap: v("sp-3"),
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: v("sp-2"), flexWrap: "wrap" }}>
        <span style={{ ...mono2xs, textTransform: "uppercase", letterSpacing: v("tracking-wide"), color: v("fg-2") }}>
          pipeline
        </span>
        <span style={{ fontFamily: v("font-logbook"), fontSize: v("text-2xl"), lineHeight: 1, color: v("phosphor") }}>
          v{spec?.version ?? "—"}
        </span>
        <span style={{ ...mono2xs, color: v("fg-3") }}>
          {nodes.length ? `${nodes.length} nodes · ${doneCount} complete` : "no spec loaded"}
        </span>
        {spec?.weights && Object.keys(spec.weights).length > 0 && (
          <span style={{ ...mono2xs, color: v("fg-3"), marginLeft: "auto" }}>
            {Object.entries(spec.weights).map(([k, w]) => `${k} ${Number(w).toFixed(2)}`).join(" · ")}
          </span>
        )}
      </div>

      {problems.length > 0 && (
        <div style={{ ...mono2xs, color: v("warn"), display: "flex", flexDirection: "column", gap: 2 }}>
          {problems.map((p, i) => <span key={i}>⚠ {p}</span>)}
        </div>
      )}

      {!code?.trim() && !nodes.length && (
        <EmptyNote>
          pipeline definition unavailable — GET /api/research/dag returned nothing. The graph appears
          the moment the research service is up.
        </EmptyNote>
      )}

      {/* the diagram — or, if mermaid choked, the source that choked it */}
      <div style={{ overflowX: "auto" }}>
        <div ref={host} style={{ minHeight: code?.trim() ? 80 : 0 }} />
      </div>

      {renderErr && code?.trim() && (
        <div style={{ display: "flex", flexDirection: "column", gap: v("sp-2") }}>
          <span style={{ ...mono2xs, color: v("err") }}>graph did not render — {renderErr}</span>
          <pre
            style={{
              margin: 0, fontFamily: v("font-mono"), fontSize: v("text-2xs"), lineHeight: 1.5,
              color: v("fg-1"), background: v("ink-1"), border: v("hair"), borderRadius: v("r-sm"),
              padding: v("sp-3"), maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap",
            }}
          >
            {code}
          </pre>
        </div>
      )}

      {/* node roster — the status layer that never depends on mermaid succeeding */}
      {nodes.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {nodes.map((n) => {
            const rt = nodeStates[n.id]?.state;
            const tone =
              !n.enabled ? "fg-3"
              : rt === "running" ? "phosphor"
              : rt === "error" ? "err"
              : rt === "done" ? "lane-do"
              : "fg-2";
            const mark = !n.enabled ? "○" : rt === "done" ? "✓" : rt === "running" ? "▸" : rt === "error" ? "✕" : "·";
            return (
              <li
                key={n.id}
                title={n.instruction}
                className={rt === "running" ? "ah-live" : undefined}
                style={{
                  ...mono2xs, color: v(tone), display: "flex", gap: v("sp-2"), alignItems: "center",
                  opacity: n.enabled ? 1 : 0.5, cursor: "help",
                }}
              >
                <span style={{ width: 10, textAlign: "center" }}>{mark}</span>
                <span style={{ textDecoration: n.enabled ? undefined : "line-through" }}>{n.label || n.id}</span>
                {n.origin === "patch" && <Badge kind="kind">evolved</Badge>}
              </li>
            );
          })}
        </ul>
      )}

      <span style={{ ...mono2xs, color: v("fg-3") }}>
        the DAG is data, not code — human feedback rewrites these rows between runs
      </span>
    </section>
  );
}

function cssEsc(s: string): string {
  return s.replace(/["\\\]\[]/g, "");
}
