// src/research/tools.mjs — the in-process tool surface the Agent-SDK harness
// hands to every node. These are SDK MCP tools (createSdkMcpServer), so they run
// in this Node process: no subprocess, no network hop, direct access to the run's
// structured sink.
//
// Shapes come from ./contract.mjs and nowhere else.
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

// ---- zip centroids ---------------------------------------------------------
// Embedded so the demo works with zero network. Anything outside this table
// returns {found:false} and the model reasons (or web-searches) without it.
const ZIP_CENTROIDS = {
  "33701": { lat: 27.7731, lng: -82.6400, city: "St. Petersburg", state: "FL" },
  "34102": { lat: 26.1420, lng: -81.7948, city: "Naples", state: "FL" },
  "90210": { lat: 34.0901, lng: -118.4065, city: "Beverly Hills", state: "CA" },
  "10021": { lat: 40.7695, lng: -73.9585, city: "New York", state: "NY" },
  "02138": { lat: 42.3782, lng: -71.1248, city: "Cambridge", state: "MA" },
  "78704": { lat: 30.2432, lng: -97.7660, city: "Austin", state: "TX" },
  "85251": { lat: 33.4942, lng: -111.9261, city: "Scottsdale", state: "AZ" },
};

/** Raw form — usable directly from runtime/tests without going through MCP. */
export function zipCentroid(zip) {
  const key = String(zip || "").trim().slice(0, 5);
  const hit = ZIP_CENTROIDS[key];
  if (!hit) return { found: false, zip: key };
  return { found: true, zip: key, ...hit };
}

/** Great-circle distance in statute miles. Pure math, exact. */
export function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613; // mean Earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- the structured sink ---------------------------------------------------
// Where discover/enrich nodes write. The MCP tool handler is invoked deep inside
// the SDK's transport, so we cannot thread a per-call context down to it. Instead
// the harness registers a sink for the duration of one node turn and we fan out
// to every sink currently open. Parallel enrichment branches of the SAME run
// therefore all see each other's writes — which is exactly what the runtime's
// merge-by-id reducer already collapses, so it is harmless. Sinks are per-turn,
// so two different runs never cross-contaminate for longer than their overlap
// (and each run's reducer only keeps ids its own graph produced).
const SINKS = new Set();

/** Harness calls this before each node turn so record_facilities has somewhere to go. */
export function bindSink(fn) { SINKS.add(fn); return () => SINKS.delete(fn); }
export function unbindSink(fn) { if (fn) SINKS.delete(fn); else SINKS.clear(); }

const PROV_SOURCES = ["web", "model_inference", "state_registry", "user_correction", "unknown"];

// The Sourced envelope. Loose on `value` (it is string | number | string[] | null
// depending on field) but STRICT on provenance.
const zProv = z.object({
  source: z.enum(["web", "model_inference", "state_registry", "user_correction", "unknown"]),
  confidence: z.number().min(0).max(1),
  note: z.string().optional(),
});
const zSourced = z.object({ value: z.any().nullable(), prov: zProv });

const zFacility = z.object({
  id: z.string(),
  name: z.string(),
  zip: z.string().optional(),
  address: zSourced.optional(),
  distanceMiles: zSourced.optional(),
  beds: zSourced.optional(),
  avgMonthlyFee: zSourced.optional(),
  management: zSourced.optional(),
  acos: zSourced.optional(),
  services: zSourced.optional(),
  notes: z.array(z.string()).optional(),
});

/** Fields that carry a number and therefore fall under the honesty rule. */
const NUMERIC_FIELDS = ["distanceMiles", "beds", "avgMonthlyFee"];
const SOURCED_FIELDS = [
  "address", "distanceMiles", "beds", "avgMonthlyFee", "management", "acos", "services",
];

/**
 * HARD HONESTY RULE: a numeric field may NEVER arrive as a bare number. Every
 * value must be wrapped in a Sourced envelope {value, prov:{source,confidence}}.
 * A model that cannot say where a bed count came from must say `value:null` with
 * source:"unknown" — it may not guess. We reject the whole call and name the
 * offending field so the agent gets an actionable correction, because silently
 * coercing an unsourced number is exactly how a research pipeline starts lying.
 */
export function validateFacility(f) {
  const errs = [];
  if (!f || typeof f !== "object") return ["facility must be an object"];
  if (!f.id) errs.push("id: required");
  if (!f.name) errs.push("name: required");
  for (const field of SOURCED_FIELDS) {
    const v = f[field];
    if (v === undefined || v === null) continue; // omitted is fine — unknown() is applied later
    if (typeof v !== "object" || Array.isArray(v) || !("value" in v)) {
      errs.push(`${field}: must be a Sourced envelope {value, prov}, got a bare ${typeof v}`);
      continue;
    }
    if (!v.prov || typeof v.prov !== "object") {
      errs.push(`${field}: missing prov — every value needs {source, confidence}`);
      continue;
    }
    if (!PROV_SOURCES.includes(v.prov.source)) {
      errs.push(`${field}: prov.source must be one of ${PROV_SOURCES.join("|")}`);
    }
    const c = v.prov.confidence;
    if (typeof c !== "number" || c < 0 || c > 1) {
      errs.push(`${field}: prov.confidence must be a number 0..1`);
    }
    if (NUMERIC_FIELDS.includes(field) && v.value !== null && typeof v.value !== "number") {
      errs.push(`${field}: value must be a number or null (never a string)`);
    }
  }
  return errs;
}

/** Raw form of the sink. Returns {ok, accepted, rejected[]}. */
export function recordFacilities(facilities) {
  const list = Array.isArray(facilities) ? facilities : [];
  const accepted = [];
  const rejected = [];
  for (const f of list) {
    const errs = validateFacility(f);
    if (errs.length) rejected.push({ id: f?.id ?? null, name: f?.name ?? null, errors: errs });
    else accepted.push(f);
  }
  if (accepted.length) {
    for (const sink of SINKS) {
      try { sink(accepted); } catch { /* never let a sink kill the turn */ }
    }
  }
  return { ok: rejected.length === 0, accepted: accepted.length, rejected };
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const err = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

// ---- MCP tool definitions --------------------------------------------------
export const zipCentroidTool = tool(
  "zip_centroid",
  "Look up the lat/lng centroid, city and state for a 5-digit US zip code. Returns {found:false} for zips outside the embedded table — reason without it in that case.",
  { zip: z.string().describe("5-digit US zip code, e.g. 33701") },
  async ({ zip }) => ok(zipCentroid(zip)),
);

export const haversineTool = tool(
  "haversine_miles",
  "Exact great-circle distance in statute miles between two lat/lng points.",
  {
    lat1: z.number(), lng1: z.number(), lat2: z.number(), lng2: z.number(),
  },
  async ({ lat1, lng1, lat2, lng2 }) =>
    ok({ miles: Number(haversineMiles(lat1, lng1, lat2, lng2).toFixed(2)) }),
);

export const recordFacilitiesTool = tool(
  "record_facilities",
  "Write assisted-living facilities into the run's structured result set. EVERY data field must be a Sourced envelope: {value, prov:{source, confidence, note}}. source is one of web|model_inference|state_registry|user_correction|unknown. If you do not know a value, send {value:null, prov:{source:'unknown', confidence:0}} — never invent a number. Bare numbers are rejected.",
  { facilities: z.array(zFacility).describe("Facilities to record or merge by id") },
  async ({ facilities }) => {
    const res = recordFacilities(facilities);
    if (!res.ok) {
      const detail = res.rejected
        .map((r) => `${r.name || r.id || "(unnamed)"}: ${r.errors.join("; ")}`)
        .join(" | ");
      return err(
        `Rejected ${res.rejected.length} facility record(s) for missing/invalid provenance. ` +
        `Fix and resubmit — ${detail}`,
      );
    }
    return ok(res);
  },
);

export const researchMcpServer = createSdkMcpServer({
  name: "research",
  version: "0.1.0",
  instructions:
    "Assisted-living facility research tools. Provenance is mandatory on every recorded value.",
  tools: [zipCentroidTool, haversineTool, recordFacilitiesTool],
});

/** Fully-qualified tool names as the SDK exposes them to `allowedTools`. */
export const RESEARCH_TOOL_NAMES = [
  "mcp__research__zip_centroid",
  "mcp__research__haversine_miles",
  "mcp__research__record_facilities",
];
