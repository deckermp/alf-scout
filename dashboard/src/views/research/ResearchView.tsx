// S-19 Research — a market-research workspace. Type a ZIP, an agent walks a
// LangGraph DAG and streams back assisted-living facilities with provenance on
// every field. Three things this screen exists to make visible:
//   1. the run is LIVE — nodes light as they execute (SSE)
//   2. the agent PAUSES to ask a human (HITL), and he answers right here
//   3. his answer REWRITES THE DAG — and the version number climbs, revertibly
import { useEffect, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { Screen } from "../../components/Screen";
import { Badge, Button } from "../../components/ui";
import { useResearch } from "./useResearch";
import { FacilityTable } from "./FacilityTable";
import { HitlPanel } from "./HitlPanel";
import { DagPanel } from "./DagPanel";
import { EvolutionPanel } from "./EvolutionPanel";

const v = (n: string) => `var(--${n})`;
const mono2xs = {
  fontFamily: v("font-mono"), fontSize: v("text-2xs"), letterSpacing: v("tracking-mono"),
} as const;

const STATUS_TONE: Record<string, string> = {
  idle: "fg-3",
  running: "phosphor",
  awaiting_human: "lane-escalate",
  done: "lane-do",
  error: "err",
};
const STATUS_LABEL: Record<string, string> = {
  idle: "idle",
  running: "running",
  awaiting_human: "waiting on you",
  done: "complete",
  error: "failed",
};

/** Two columns above ~900px, one below. matchMedia rather than a utility class
 *  so the layout never depends on a purge/JIT pass picking up an arbitrary
 *  breakpoint variant. */
function useWide(px = 900) {
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(`(min-width: ${px}px)`).matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [px]);
  return wide;
}

export function ResearchView() {
  const r = useResearch();
  const [zip, setZip] = useState("");
  const wide = useWide(900);

  const running = r.status === "running" || r.status === "awaiting_human";
  const tone = v(STATUS_TONE[r.status] ?? "fg-3");

  return (
    <Screen
      title="Research"
      code="S-19"
      actions={
        <span style={{ display: "inline-flex", alignItems: "center", gap: v("sp-2") }}>
          <span
            className={r.streamConnected ? "live-dot" : undefined}
            style={{ width: 7, height: 7, borderRadius: "50%", background: r.streamConnected ? v("phosphor") : v("fg-3") }}
          />
          <span style={{ ...mono2xs, color: v("fg-3") }}>{r.streamConnected ? "stream live" : "stream offline"}</span>
        </span>
      }
    >
      <div style={{ padding: v("sp-5"), display: "flex", flexDirection: "column", gap: v("sp-4"), maxWidth: 1600 }}>

        {/* ------------------------------------------------------- header ---- */}
        <header style={{ display: "flex", flexDirection: "column", gap: v("sp-2") }}>
          <div style={{ display: "flex", alignItems: "center", gap: v("sp-3"), flexWrap: "wrap" }}>
            <form
              onSubmit={(e) => { e.preventDefault(); r.startRun(zip); }}
              style={{ display: "flex", alignItems: "center", gap: v("sp-2") }}
            >
              <label htmlFor="research-zip" style={{ ...mono2xs, textTransform: "uppercase", letterSpacing: v("tracking-wide"), color: v("fg-2") }}>
                zip
              </label>
              <input
                id="research-zip"
                value={zip}
                onChange={(e) => setZip(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
                inputMode="numeric"
                placeholder="33928"
                aria-label="US ZIP code"
                style={{
                  fontFamily: v("font-mono"), fontSize: v("text-md"), letterSpacing: "0.08em",
                  width: 108, background: v("ink-1"), color: v("fg-0"),
                  border: v("hair"), borderRadius: v("r-sm"), padding: `6px ${v("sp-3")}`,
                }}
              />
              <Button variant="primary" onClick={() => r.startRun(zip)}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Play size={14} /> {running ? "Run again" : "Run"}
                </span>
              </Button>
            </form>

            <span
              style={{
                ...mono2xs, textTransform: "uppercase", letterSpacing: v("tracking-wide"),
                color: tone, border: `1px solid color-mix(in oklab, ${tone} 40%, transparent)`,
                background: `color-mix(in oklab, ${tone} 12%, transparent)`,
                borderRadius: v("r-pill"), padding: "3px 10px",
              }}
              className={r.status === "running" ? "ah-live" : undefined}
            >
              {STATUS_LABEL[r.status] ?? r.status}
            </span>

            {r.runId && <Badge kind="kind">run · {r.runId.slice(0, 8)}</Badge>}
            {r.dag && <Badge kind="kind">dag v{r.dag.version}</Badge>}

            <span style={{ marginLeft: "auto", display: "inline-flex", gap: v("sp-2") }}>
              <Button onClick={() => { r.refreshDag(); r.refreshPatches(); }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <RefreshCw size={13} /> Reload pipeline
                </span>
              </Button>
            </span>
          </div>

          <p style={{ margin: 0, fontSize: v("text-sm"), color: v("fg-2"), maxWidth: "78ch" }}>
            An agent walks the pipeline on the right and reports assisted-living facilities near a ZIP.
            It stops to ask when it is unsure; what you tell it rewrites the graph for the next run.
          </p>

          {r.error && (
            <span style={{ ...mono2xs, color: v("err") }}>⚠ {r.error}</span>
          )}
        </header>

        {/* --------------------------------------------------------- hitl ---- */}
        <HitlPanel request={r.pendingHitl} onAnswer={r.answerHitl} />

        {/* --------------------------------------------------------- body ---- */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: wide ? "minmax(0, 1fr) minmax(340px, 420px)" : "minmax(0, 1fr)",
            gap: v("sp-4"),
            alignItems: "start",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: v("sp-3"), minWidth: 0 }}>
            <FacilityTable facilities={r.facilities} zip={zip} running={running} />
            {r.events.length > 0 && (
              <details>
                <summary style={{ ...mono2xs, color: v("fg-3"), cursor: "pointer" }}>
                  run log · {r.events.length} events
                </summary>
                <div
                  style={{
                    marginTop: v("sp-2"), maxHeight: 200, overflow: "auto",
                    border: v("hair-faint"), borderRadius: v("r-sm"), background: v("ink-1"),
                    padding: v("sp-2"), display: "flex", flexDirection: "column", gap: 2,
                  }}
                >
                  {r.events.slice(-80).reverse().map((e, i) => (
                    <span key={i} style={{ ...mono2xs, color: v("fg-2") }}>
                      <span style={{ color: v("fg-3") }}>{e.at ? new Date(e.at).toLocaleTimeString() : "—"} </span>
                      {e.kind}{e.nodeId ? ` · ${e.nodeId}` : ""}{e.message ? ` · ${e.message}` : ""}
                    </span>
                  ))}
                </div>
              </details>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: v("sp-4"), minWidth: 0 }}>
            <DagPanel spec={r.dag} code={r.mermaid} problems={r.problems} nodeStates={r.nodeStates} />
            <EvolutionPanel
              patches={r.patches}
              busy={r.loading}
              onFeedback={r.sendFeedback}
              onToggle={r.togglePatch}
            />
          </div>
        </div>

        <p style={{ ...mono2xs, color: v("fg-3"), marginTop: v("sp-3") }}>
          agent-researched, not authoritative · every field carries a source and a confidence · nothing unverified is rendered as a number
        </p>
      </div>
    </Screen>
  );
}
