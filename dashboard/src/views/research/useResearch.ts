// S-19 Research — the one hook that owns every byte of state this screen shows.
//
// DEVIATION (deliberate, noted per the build brief): every other screen reads
// through src/store.ts, which owns the single app-wide EventSource. Another
// concern owns that file during this build, so this hook opens its OWN
// EventSource on /stream and filters `type === "research"`. Two EventSources to
// the same endpoint is fine (SSE fans out per-connection); if/when store.ts is
// free, fold `research` frames into it and delete `subscribeResearch` below.
//
// Everything here codes DEFENSIVELY: the backend is being built in parallel, so
// a 404 / dead server must produce a sane empty state, never a blank panel and
// never a thrown render.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------- shapes ------ */
// Mirrors server/src/research/contract.mjs. Kept structural (no import of the
// .mjs) so a server-side rename can't break the dashboard build.

export type ServiceType = "IL" | "AL" | "MemoryCare" | "HomeHealth" | "SNF" | "Respite";
export type ProvSource = "web" | "model_inference" | "state_registry" | "user_correction" | "unknown";

export interface Provenance { source: ProvSource; confidence: number; note?: string }
export interface Sourced<T = unknown> { value: T | null; prov: Provenance }

export interface Facility {
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
  score: number;
  notes: string[];
}

export interface DagNodeSpec {
  id: string;
  label: string;
  after: string[];
  instruction: string;
  enabled: boolean;
  origin: "base" | "patch";
}
export interface DagSpec {
  version: number;
  nodes: DagNodeSpec[];
  weights: Record<string, number>;
}

export type PatchOp =
  | { op: "add_node"; node: DagNodeSpec }
  | { op: "edit_instruction"; id: string; instruction: string }
  | { op: "set_enabled"; id: string; enabled: boolean }
  | { op: "set_weights"; weights: Record<string, number> };

export interface DagPatch {
  id: string;
  createdAt: string;
  feedback: string;
  rationale: string;
  ops: PatchOp[];
  /** Server may omit; absent means active. */
  active?: boolean;
}

export interface HitlRequest {
  id: string;
  runId: string;
  nodeId: string;
  kind: "approve_plan" | "approve_tool" | "review_results";
  question: string;
  payload: any;
  /** Server may stamp this; we fall back to first-seen-at locally. */
  askedAt?: string;
}

export interface HitlResponse {
  requestId: string;
  decision: "approve" | "reject" | "edit";
  feedback?: string;
  edited?: any;
}

export type RunStatus = "idle" | "running" | "awaiting_human" | "done" | "error";

/** The SSE payload we consume. See the report / README block at the bottom. */
export interface RunEvent {
  kind:
    | "run_start" | "node_start" | "node_end"
    | "facilities" | "hitl_request" | "hitl_resolved"
    | "run_end" | "error" | "dag_updated" | string;
  runId?: string;
  nodeId?: string;
  at?: string;
  status?: RunStatus;
  message?: string;
  facilities?: Facility[];
  request?: HitlRequest;
  requestId?: string;
  spec?: DagSpec;
  data?: any;
}

export interface NodeRuntime { state: "running" | "done" | "error"; at?: string }

export interface ResearchState {
  runId: string | null;
  status: RunStatus;
  facilities: Facility[];
  events: RunEvent[];
  pendingHitl: HitlRequest | null;
  dag: DagSpec | null;
  mermaid: string;
  problems: string[];
  patches: DagPatch[];
  nodeStates: Record<string, NodeRuntime>;
  error: string | null;
  loading: boolean;
  streamConnected: boolean;
}

/* --------------------------------------------------------------- net ------- */
const API = "/api/research";

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`HTTP ${r.status}${r.statusText ? " " + r.statusText : ""} · ${API}${path}`);
  return (await r.json()) as T;
}
async function jpost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}${r.statusText ? " " + r.statusText : ""} · ${API}${path}`);
  const text = await r.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return {} as T; }
}

/** Normalise whatever the bus hands us into a RunEvent, or null if not ours. */
function toRunEvent(msg: any): RunEvent | null {
  if (!msg || msg.type !== "research") return null;
  // Preferred wire form: { type:"research", event:{...RunEvent} }.
  const raw = msg.event ?? msg.research ?? msg.payload ?? msg;
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind ?? raw.event ?? raw.name;
  if (!kind) return null;
  return { ...raw, kind } as RunEvent;
}

const TERMINAL: RunStatus[] = ["done", "error"];

export function useResearch() {
  const [s, setS] = useState<ResearchState>({
    runId: null,
    status: "idle",
    facilities: [],
    events: [],
    pendingHitl: null,
    dag: null,
    mermaid: "",
    problems: [],
    patches: [],
    nodeStates: {},
    error: null,
    loading: false,
    streamConnected: false,
  });

  const patch = useCallback((p: Partial<ResearchState>) => setS((prev) => ({ ...prev, ...p })), []);
  // The run id the poller/stream filter should trust, without re-subscribing.
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = s.runId;

  /* ---- DAG + patch history ------------------------------------------------ */
  const refreshDag = useCallback(async () => {
    try {
      const d = await jget<{ spec: DagSpec; mermaid: string; problems?: string[] }>("/dag");
      patch({
        dag: d?.spec ?? null,
        mermaid: typeof d?.mermaid === "string" ? d.mermaid : "",
        problems: Array.isArray(d?.problems) ? d.problems : [],
      });
    } catch (e) {
      // A missing /dag route must not blank the screen — panels render their own
      // "pipeline definition unavailable" note off `dag === null`.
      patch({ dag: null, mermaid: "", problems: [(e as Error).message] });
    }
  }, [patch]);

  const refreshPatches = useCallback(async () => {
    try {
      const p = await jget<DagPatch[] | { patches: DagPatch[] }>("/patches");
      const list = Array.isArray(p) ? p : Array.isArray((p as any)?.patches) ? (p as any).patches : [];
      patch({ patches: list });
    } catch {
      patch({ patches: [] });
    }
  }, [patch]);

  /* ---- run detail (also the SSE fallback poll) ---------------------------- */
  const refreshRun = useCallback(async (id: string) => {
    try {
      const d = await jget<{ run?: any; events?: RunEvent[]; facilities?: Facility[] }>(`/runs/${encodeURIComponent(id)}`);
      setS((prev) => {
        const events = Array.isArray(d?.events) ? d.events : prev.events;
        const status: RunStatus = (d?.run?.status as RunStatus) ?? prev.status;
        // Rebuild node states from the authoritative event log when we have one.
        const nodeStates = Array.isArray(d?.events) ? foldNodeStates(d.events) : prev.nodeStates;
        const pending = pendingFromEvents(events) ?? (status === "awaiting_human" ? prev.pendingHitl : null);
        return {
          ...prev,
          status,
          events,
          nodeStates,
          pendingHitl: pending,
          facilities: Array.isArray(d?.facilities) && d.facilities.length ? d.facilities : prev.facilities,
          error: status === "error" ? (d?.run?.error ?? prev.error ?? "run failed") : prev.error,
        };
      });
    } catch {
      /* poll failures are silent by design — SSE or the next tick may recover */
    }
  }, []);

  /* ---- SSE ---------------------------------------------------------------- */
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/stream");
    } catch {
      return;
    }
    es.onopen = () => patch({ streamConnected: true });
    es.onerror = () => patch({ streamConnected: false });
    es.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(m.data); } catch { return; }
      const ev = toRunEvent(msg);
      if (!ev) return;
      // Ignore frames for other runs once we own one.
      if (ev.runId && runIdRef.current && ev.runId !== runIdRef.current) return;
      setS((prev) => fold(prev, ev));
      if (ev.kind === "dag_updated") { refreshDag(); refreshPatches(); }
    };
    return () => { es?.close(); };
  }, [patch, refreshDag, refreshPatches]);

  /* ---- fallback poll while running ---------------------------------------- */
  useEffect(() => {
    if (!s.runId) return;
    if (TERMINAL.includes(s.status)) return;
    const t = setInterval(() => { if (runIdRef.current) refreshRun(runIdRef.current); }, 2000);
    return () => clearInterval(t);
  }, [s.runId, s.status, refreshRun]);

  /* ---- first paint: dag + patches + most recent run ----------------------- */
  useEffect(() => {
    refreshDag();
    refreshPatches();
    (async () => {
      try {
        const runs = await jget<any[] | { runs: any[] }>("/runs");
        const list = Array.isArray(runs) ? runs : Array.isArray((runs as any)?.runs) ? (runs as any).runs : [];
        const latest = list[0];
        if (latest?.id) {
          patch({ runId: latest.id, status: (latest.status as RunStatus) ?? "done" });
          runIdRef.current = latest.id;
          refreshRun(latest.id);
        }
      } catch { /* no runs route yet — the empty state is the correct answer */ }
    })();
  }, [refreshDag, refreshPatches, refreshRun, patch]);

  /* ---- actions ------------------------------------------------------------ */
  const startRun = useCallback(async (zip: string) => {
    const z = zip.trim();
    if (!/^\d{5}$/.test(z)) { patch({ error: "Enter a 5-digit US ZIP code." }); return; }
    patch({
      loading: true, error: null, facilities: [], events: [],
      nodeStates: {}, pendingHitl: null, status: "running",
    });
    try {
      const r = await jpost<{ runId?: string; id?: string }>("/run", { zip: z });
      const id = r?.runId ?? r?.id ?? null;
      runIdRef.current = id;
      patch({ runId: id, loading: false });
      if (id) refreshRun(id);
    } catch (e) {
      patch({ loading: false, status: "error", error: (e as Error).message });
    }
  }, [patch, refreshRun]);

  const answerHitl = useCallback(async (res: HitlResponse) => {
    // Optimistic: the card closes the instant he decides — waiting on a round
    // trip to dismiss a modal is exactly the lag that makes a UI feel remote.
    setS((prev) => ({ ...prev, pendingHitl: null, status: prev.status === "awaiting_human" ? "running" : prev.status }));
    try {
      await jpost("/hitl", res);
      if (runIdRef.current) refreshRun(runIdRef.current);
    } catch (e) {
      patch({ error: (e as Error).message });
    }
  }, [patch, refreshRun]);

  const sendFeedback = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    patch({ loading: true, error: null });
    try {
      await jpost<{ patch?: DagPatch; spec?: DagSpec }>("/feedback", { runId: s.runId, feedback: t });
      await Promise.all([refreshDag(), refreshPatches()]);
      patch({ loading: false });
    } catch (e) {
      patch({ loading: false, error: (e as Error).message });
    }
  }, [s.runId, patch, refreshDag, refreshPatches]);

  const togglePatch = useCallback(async (id: string, active: boolean) => {
    setS((prev) => ({ ...prev, patches: prev.patches.map((p) => (p.id === id ? { ...p, active } : p)) }));
    try {
      await jpost(`/patches/${encodeURIComponent(id)}/active`, { active });
      await Promise.all([refreshDag(), refreshPatches()]);
    } catch (e) {
      patch({ error: (e as Error).message });
      refreshPatches();
    }
  }, [patch, refreshDag, refreshPatches]);

  const actions = useMemo(
    () => ({ startRun, answerHitl, sendFeedback, togglePatch, refreshDag, refreshPatches }),
    [startRun, answerHitl, sendFeedback, togglePatch, refreshDag, refreshPatches],
  );

  return { ...s, ...actions };
}

export type UseResearch = ReturnType<typeof useResearch>;

/* ------------------------------------------------------------- folding ----- */
function fold(prev: ResearchState, ev: RunEvent): ResearchState {
  const events = [...prev.events, ev].slice(-400);
  const next: ResearchState = { ...prev, events };
  if (ev.runId && !prev.runId) next.runId = ev.runId;

  switch (ev.kind) {
    case "run_start":
      return { ...next, status: "running", nodeStates: {}, facilities: [], pendingHitl: null, error: null };
    case "node_start":
      if (!ev.nodeId) return next;
      return { ...next, status: "running", nodeStates: { ...prev.nodeStates, [ev.nodeId]: { state: "running", at: ev.at } } };
    case "node_end":
      if (!ev.nodeId) return next;
      return {
        ...next,
        nodeStates: {
          ...prev.nodeStates,
          [ev.nodeId]: { state: ev.status === "error" ? "error" : "done", at: ev.at },
        },
      };
    case "facilities":
      return { ...next, facilities: Array.isArray(ev.facilities) ? ev.facilities : prev.facilities };
    case "hitl_request":
      return {
        ...next,
        status: "awaiting_human",
        pendingHitl: ev.request ? { askedAt: ev.at, ...ev.request } : prev.pendingHitl,
      };
    case "hitl_resolved":
      return { ...next, status: "running", pendingHitl: null };
    case "run_end":
      return { ...next, status: (ev.status as RunStatus) ?? "done", pendingHitl: null };
    case "error":
      return { ...next, status: "error", error: ev.message ?? "run failed" };
    default:
      return next;
  }
}

function foldNodeStates(events: RunEvent[]): Record<string, NodeRuntime> {
  const out: Record<string, NodeRuntime> = {};
  for (const e of events) {
    if (!e?.nodeId) continue;
    if (e.kind === "node_start") out[e.nodeId] = { state: "running", at: e.at };
    else if (e.kind === "node_end") out[e.nodeId] = { state: e.status === "error" ? "error" : "done", at: e.at };
  }
  return out;
}

function pendingFromEvents(events: RunEvent[]): HitlRequest | null {
  let pending: HitlRequest | null = null;
  for (const e of events) {
    if (e.kind === "hitl_request" && e.request) pending = { askedAt: e.at, ...e.request };
    else if (e.kind === "hitl_resolved" || e.kind === "run_end") pending = null;
  }
  return pending;
}

/* ------------------------------------------------------------- helpers ----- */
export function confidenceOf(f: Sourced<any> | undefined | null): number {
  const c = f?.prov?.confidence;
  return typeof c === "number" && isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
}
export function provTitle(f: Sourced<any> | undefined | null, label: string): string {
  if (!f) return `${label} — no field returned`;
  const { source = "unknown", confidence = 0, note } = f.prov ?? ({} as Provenance);
  const head = f.value == null ? `${label}: unknown` : `${label}`;
  return `${head}\nsource: ${source}\nconfidence: ${Math.round((confidence || 0) * 100)}%${note ? `\n${note}` : ""}`;
}
