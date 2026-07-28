// S-19 · the payoff table. Every cell is a `Sourced` value, so every cell wears
// its provenance: a confidence bar, the source on hover, and a MUTED/DASHED
// treatment below 0.5. Nulls are em-dashes with the "why" in the tooltip —
// never 0, never "N/A". This honesty layer is the point: the data is
// agent-researched, not authoritative, and the table has to say so.
import { useMemo, useState } from "react";
import { EmptyNote } from "../../components/ui";
import { confidenceOf, provTitle, type Facility, type ServiceType, type Sourced } from "./useResearch";

const v = (n: string) => `var(--${n})`;
const mono2xs = {
  fontFamily: v("font-mono"), fontSize: v("text-2xs"), letterSpacing: v("tracking-mono"),
} as const;

type SortKey = "name" | "distanceMiles" | "beds" | "avgMonthlyFee" | "management" | "acos" | "services" | "score";
type Dir = "asc" | "desc";

const COLS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "name", label: "Name" },
  { key: "distanceMiles", label: "Distance (mi)", align: "right" },
  { key: "beds", label: "Beds", align: "right" },
  { key: "avgMonthlyFee", label: "Avg Monthly Fee", align: "right" },
  { key: "management", label: "Management" },
  { key: "acos", label: "ACOs" },
  { key: "services", label: "Services" },
  { key: "score", label: "Score", align: "right" },
];

const LOW = 0.5;

function sortValue(f: Facility, key: SortKey): number | string | null {
  if (key === "name") return f.name ?? "";
  if (key === "score") return typeof f.score === "number" ? f.score : -1;
  const field = (f as any)[key] as Sourced<any> | undefined;
  const val = field?.value;
  if (val == null) return null;
  if (Array.isArray(val)) return val.length;
  if (typeof val === "number") return val;
  return String(val);
}

export function FacilityTable({
  facilities, zip, running,
}: { facilities: Facility[]; zip: string; running: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: "score", dir: "desc" });
  const [hover, setHover] = useState<string | null>(null);

  const rows = useMemo(() => {
    const out = [...(facilities ?? [])];
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    out.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      // Unknowns always sink, regardless of direction: a missing number is not
      // a small number, and letting nulls win a sort would be a lie.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * mul;
      }
      return (av - bv) * mul;
    });
    return out;
  }, [facilities, sort]);

  function toggle(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "management" ? "asc" : "desc" }));
  }

  if (!rows.length) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: v("sp-3") }}>
        <EmptyNote>
          {running
            ? "the agent is out there — facilities land in this table the moment a node returns them"
            : `no facilities yet${zip ? ` for ${zip}` : ""} — type a 5-digit ZIP above and press Run`}
        </EmptyNote>
        <div
          style={{
            border: `1px dashed ${v("ink-4")}`, borderRadius: v("r-md"),
            padding: v("sp-5"), display: "flex", flexDirection: "column",
            gap: v("sp-2"), alignItems: "flex-start",
          }}
        >
          <span style={{ fontFamily: v("font-logbook"), fontSize: v("text-lg"), color: v("fg-0") }}>
            Assisted living, one ZIP at a time.
          </span>
          <span style={{ fontSize: v("text-sm"), color: v("fg-1"), maxWidth: "56ch" }}>
            The agent walks the DAG on the right — search, enrich, score — and streams facilities back
            here as it finds them. Every field arrives with a source and a confidence; anything it could
            not verify stays an em-dash instead of a guess.
          </span>
          <span style={{ ...mono2xs, color: v("fg-3") }}>
            try 33928 · 92104 · 10025
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto", border: v("hair"), borderRadius: v("r-md"), background: v("ink-2") }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
        <thead>
          <tr>
            {COLS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  onClick={() => toggle(c.key)}
                  title={`Sort by ${c.label}`}
                  style={{
                    ...mono2xs,
                    textTransform: "uppercase",
                    letterSpacing: v("tracking-wide"),
                    color: active ? v("phosphor") : v("fg-2"),
                    textAlign: c.align === "right" ? "right" : "left",
                    padding: `${v("sp-2")} ${v("sp-3")}`,
                    borderBottom: v("hair"),
                    background: v("ink-1"),
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    userSelect: "none",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                  }}
                >
                  {c.label}
                  <span style={{ marginLeft: 5, opacity: active ? 1 : 0.3 }}>
                    {active ? (sort.dir === "asc" ? "▲" : "▼") : "▾"}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const open = hover === f.id;
            return (
              <tr
                key={f.id}
                className="ah-row"
                onMouseEnter={() => setHover(f.id)}
                onMouseLeave={() => setHover((h) => (h === f.id ? null : h))}
                style={{ borderBottom: v("hair-faint") }}
              >
                <td style={{ ...cell, minWidth: 200 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: v("text-sm"), color: v("fg-0"), fontWeight: 500 }}>{f.name || "—"}</span>
                    <ProvValue field={f.address} label="address" render={(a) => String(a)} small />
                    {open && f.notes?.length > 0 && (
                      <span style={{ ...mono2xs, color: v("anno-dim"), marginTop: 2, whiteSpace: "normal" }}>
                        {f.notes.join(" · ")}
                      </span>
                    )}
                  </div>
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <ProvValue field={f.distanceMiles} label="distance (mi)" render={(n) => Number(n).toFixed(1)} />
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <ProvValue field={f.beds} label="beds" render={(n) => String(n)} />
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <ProvValue field={f.avgMonthlyFee} label="avg monthly fee" render={(n) => `$${Number(n).toLocaleString()}`} />
                </td>
                <td style={cell}>
                  <ProvValue field={f.management} label="management" render={(s) => String(s)} />
                </td>
                <td style={cell}>
                  <ProvValue
                    field={f.acos}
                    label="ACOs"
                    render={(a) => (Array.isArray(a) && a.length ? a.join(", ") : "none found")}
                  />
                </td>
                <td style={cell}>
                  <ServicesCell field={f.services} />
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <ScoreBar score={f.score} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ ...mono2xs, color: v("fg-3"), padding: `${v("sp-2")} ${v("sp-3")}`, borderTop: v("hair-faint") }}>
        {rows.length} facilities · bar under each value = confidence · dashed + muted = below 50% · hover a value for its source
      </div>
    </div>
  );
}

const cell = {
  padding: `${v("sp-2")} ${v("sp-3")}`,
  fontSize: v("text-sm"),
  color: v("fg-1"),
  verticalAlign: "top" as const,
  whiteSpace: "nowrap" as const,
};

/* --------------------------------------------------------- one sourced ----- */
function ProvValue({
  field, label, render, small,
}: {
  field: Sourced<any> | undefined | null;
  label: string;
  render: (v: any) => string;
  small?: boolean;
}) {
  const conf = confidenceOf(field);
  const missing = !field || field.value == null || (Array.isArray(field.value) && field.value.length === 0);
  const low = !missing && conf < LOW;
  let text = "—";
  if (!missing) {
    try { text = render(field!.value); } catch { text = String(field!.value); }
  }
  return (
    <span
      title={provTitle(field, label)}
      style={{ display: "inline-flex", flexDirection: "column", gap: 3, alignItems: "inherit", cursor: "help" }}
    >
      <span
        style={{
          fontFamily: small ? v("font-mono") : undefined,
          fontSize: small ? v("text-2xs") : v("text-sm"),
          color: missing ? v("fg-3") : low ? v("fg-2") : v("fg-0"),
          fontStyle: low ? "italic" : undefined,
          borderBottom: low ? `1px dashed ${v("fg-3")}` : "1px solid transparent",
        }}
      >
        {text}
      </span>
      <ConfBar conf={missing ? 0 : conf} />
    </span>
  );
}

function ConfBar({ conf }: { conf: number }) {
  const tone = conf === 0 ? "ink-4" : conf < LOW ? "warn" : "phosphor";
  return (
    <span
      aria-hidden
      style={{
        display: "block", width: 34, height: 2, borderRadius: 1,
        background: v("ink-4"), overflow: "hidden",
      }}
    >
      <span style={{ display: "block", height: "100%", width: `${Math.max(conf * 100, conf > 0 ? 8 : 0)}%`, background: v(tone) }} />
    </span>
  );
}

/* ------------------------------------------------------------ services ----- */
const SERVICE_LABEL: Record<string, string> = {
  IL: "IL", AL: "AL", MemoryCare: "Memory", HomeHealth: "HH", SNF: "SNF", Respite: "Respite",
};
const SERVICE_TONE: Record<string, string> = {
  IL: "fg-2", AL: "phosphor", MemoryCare: "lane-do", HomeHealth: "anno", SNF: "fg-1", Respite: "fg-2",
};

function ServicesCell({ field }: { field: Sourced<ServiceType[]> | undefined }) {
  const conf = confidenceOf(field);
  const list = Array.isArray(field?.value) ? (field!.value as ServiceType[]) : [];
  if (!list.length) {
    return (
      <span title={provTitle(field, "services")} style={{ color: v("fg-3"), cursor: "help" }}>—</span>
    );
  }
  const low = conf < LOW;
  return (
    <span
      title={provTitle(field, "services")}
      style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", maxWidth: 200, cursor: "help", opacity: low ? 0.62 : 1 }}
    >
      {list.map((s) => {
        const tone = v(SERVICE_TONE[s] || "fg-2");
        return (
          <span
            key={s}
            style={{
              ...mono2xs,
              color: tone,
              border: low ? `1px dashed ${tone}` : `1px solid color-mix(in oklab, ${tone} 40%, transparent)`,
              background: `color-mix(in oklab, ${tone} 10%, transparent)`,
              borderRadius: v("r-pill"), padding: "0 6px", lineHeight: 1.6,
            }}
          >
            {SERVICE_LABEL[s] ?? s}
          </span>
        );
      })}
    </span>
  );
}

/* --------------------------------------------------------------- score ----- */
function ScoreBar({ score }: { score: number }) {
  const n = typeof score === "number" && isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
  if (n == null) {
    return <span title="score — not computed for this facility" style={{ color: v("fg-3"), cursor: "help" }}>—</span>;
  }
  return (
    <span
      title={`composite score ${(n * 100).toFixed(0)} / 100 — weighted from distance · beds · fee · services · aco`}
      style={{ display: "inline-flex", flexDirection: "column", gap: 3, alignItems: "flex-end", cursor: "help" }}
    >
      <span style={{ fontFamily: v("font-mono"), fontSize: v("text-sm"), color: v("fg-0") }}>
        {(n * 100).toFixed(0)}
      </span>
      <span style={{ display: "block", width: 54, height: 4, borderRadius: 2, background: v("ink-4"), overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${n * 100}%`, background: v("phosphor") }} />
      </span>
    </span>
  );
}
