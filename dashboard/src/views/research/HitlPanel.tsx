// S-19 · Human-in-the-loop. The agent stops mid-DAG and asks. When it does,
// this is the loudest thing on the screen — escalate-toned, with the exact tool
// and input it wants to run, pretty-printed and editable. When nothing is
// pending it collapses to one quiet line, not an empty box.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, PencilLine, X } from "lucide-react";
import { Badge, Button } from "../../components/ui";
import type { HitlRequest, HitlResponse } from "./useResearch";

const v = (n: string) => `var(--${n})`;
const mono2xs = {
  fontFamily: v("font-mono"), fontSize: v("text-2xs"), letterSpacing: v("tracking-mono"),
} as const;

const KIND_LABEL: Record<string, string> = {
  approve_plan: "approve plan",
  approve_tool: "approve tool call",
  review_results: "review results",
};

function elapsed(since: string | undefined, now: number): string {
  if (!since) return "just now";
  const t = Date.parse(since);
  if (!isFinite(t)) return "just now";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function pretty(x: unknown): string {
  try { return JSON.stringify(x ?? null, null, 2); } catch { return String(x); }
}

export function HitlPanel({
  request, onAnswer,
}: { request: HitlRequest | null; onAnswer: (r: HitlResponse) => void }) {
  const [mode, setMode] = useState<"idle" | "reject" | "edit">("idle");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const payload = request?.payload ?? null;
  const prettyPayload = useMemo(() => pretty(payload), [payload]);
  const toolName =
    (payload && typeof payload === "object" && ((payload as any).tool ?? (payload as any).name)) || null;
  const toolInput =
    payload && typeof payload === "object" && (payload as any).input != null
      ? (payload as any).input
      : payload;

  // Reset the composer whenever a NEW request arrives — a stale reason carried
  // into the next question would attach the wrong words to the wrong decision.
  useEffect(() => {
    setMode("idle");
    setReason("");
    setJsonErr(null);
    setDraft(pretty(toolInput));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  useEffect(() => {
    if (!request) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [request]);

  if (!request) {
    return (
      <div style={{ ...mono2xs, color: v("fg-3"), display: "flex", alignItems: "center", gap: v("sp-2") }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: v("ink-5") }} />
        no interventions pending — the agent has not asked for anything
      </div>
    );
  }

  const esc = v("lane-escalate");

  return (
    <section
      role="alert"
      aria-label="agent is waiting on a human decision"
      style={{
        border: `1px solid ${esc}`,
        borderRadius: v("r-md"),
        background: `color-mix(in oklab, ${esc} 8%, ${v("ink-2")})`,
        boxShadow: v("shadow-card"),
        padding: v("sp-4"),
        display: "flex", flexDirection: "column", gap: v("sp-3"),
        animation: `ah-rise var(--dur-2) var(--ease-out) both`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: v("sp-2"), flexWrap: "wrap" }}>
        <span className="ah-live" style={{ color: esc, display: "inline-flex" }}><AlertTriangle size={16} /></span>
        <span style={{ fontFamily: v("font-logbook"), fontSize: v("text-lg"), color: v("fg-0") }}>
          The agent is waiting on you
        </span>
        <Badge kind="kind">{KIND_LABEL[request.kind] ?? request.kind}</Badge>
        <Badge kind="kind">node · {request.nodeId}</Badge>
        <span style={{ ...mono2xs, color: v("fg-2"), marginLeft: "auto" }}>
          asked {elapsed(request.askedAt, now)} ago
        </span>
      </div>

      <p style={{ fontSize: v("text-md"), color: v("fg-0"), margin: 0, maxWidth: "70ch" }}>
        {request.question || "(no question text supplied)"}
      </p>

      {toolName && (
        <span style={{ ...mono2xs, color: v("fg-2") }}>
          tool · <span style={{ color: v("lane-do") }}>{String(toolName)}</span>
        </span>
      )}

      {mode === "edit" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: v("sp-2") }}>
          <label style={{ ...mono2xs, color: v("fg-2") }}>edit the input, then approve</label>
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setJsonErr(null); }}
            spellCheck={false}
            rows={Math.min(18, Math.max(6, draft.split("\n").length + 1))}
            style={{
              fontFamily: v("font-mono"), fontSize: v("text-xs"), lineHeight: 1.5,
              background: v("ink-1"), color: v("fg-0"),
              border: jsonErr ? `1px solid ${v("err")}` : v("hair"),
              borderRadius: v("r-sm"), padding: v("sp-3"), resize: "vertical",
            }}
          />
          {jsonErr && <span style={{ ...mono2xs, color: v("err") }}>invalid JSON — {jsonErr}</span>}
        </div>
      ) : (
        <pre
          style={{
            margin: 0, fontFamily: v("font-mono"), fontSize: v("text-xs"), lineHeight: 1.5,
            color: v("fg-1"), background: v("ink-1"), border: v("hair"),
            borderRadius: v("r-sm"), padding: v("sp-3"),
            maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >
          {prettyPayload}
        </pre>
      )}

      {mode === "reject" && (
        <div style={{ display: "flex", flexDirection: "column", gap: v("sp-2") }}>
          <label style={{ ...mono2xs, color: v("fg-2") }}>why are you rejecting this? (the evolver reads it)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. don't scrape that directory — it's paywalled and the numbers are stale"
            style={{
              fontFamily: v("font-ui"), fontSize: v("text-sm"),
              background: v("ink-1"), color: v("fg-0"), border: v("hair"),
              borderRadius: v("r-sm"), padding: v("sp-3"), resize: "vertical",
            }}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: v("sp-2"), flexWrap: "wrap", alignItems: "center" }}>
        {mode === "idle" && (
          <>
            <Button variant="primary" onClick={() => onAnswer({ requestId: request.id, decision: "approve" })}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Check size={14} /> Approve</span>
            </Button>
            <Button onClick={() => setMode("edit")}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><PencilLine size={14} /> Edit input & approve</span>
            </Button>
            <Button variant="danger" onClick={() => setMode("reject")}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><X size={14} /> Reject with reason</span>
            </Button>
          </>
        )}

        {mode === "edit" && (
          <>
            <Button
              variant="primary"
              onClick={() => {
                let parsed: unknown;
                try { parsed = JSON.parse(draft); }
                catch (e) { setJsonErr((e as Error).message); return; }
                onAnswer({ requestId: request.id, decision: "edit", edited: parsed });
              }}
            >
              Approve edited input
            </Button>
            <Button onClick={() => { setMode("idle"); setJsonErr(null); setDraft(pretty(toolInput)); }}>Cancel</Button>
          </>
        )}

        {mode === "reject" && (
          <>
            <Button
              variant="danger"
              onClick={() => onAnswer({ requestId: request.id, decision: "reject", feedback: reason.trim() || "rejected without a reason" })}
            >
              Send rejection
            </Button>
            <Button onClick={() => setMode("idle")}>Cancel</Button>
          </>
        )}

        <span style={{ ...mono2xs, color: v("fg-3"), marginLeft: "auto" }}>
          run {request.runId?.slice(0, 8) || "—"} · request {request.id?.slice(0, 8) || "—"}
        </span>
      </div>
    </section>
  );
}
