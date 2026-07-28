# ALF Atlas

**Input: a ZIP code. Output: a table of assisted-living facilities — distance, beds,
management, ACO affiliations, service mix — that gets better every time a human corrects it.**

A LangGraph pipeline inside a Claude Agent SDK harness, where human corrections compile into
a versioned policy and **only take effect if they survive an eval gate**.

```bash
cd engine && uv sync
.venv/bin/python -m uvicorn atlas.server:app --port 8099
open http://localhost:8099/
```

No API key required. The deterministic path queries CMS and the California licensing registry
live.

---

## The claim

The table is the visible deliverable. The actual deliverable is **the loop that makes the
table better without an engineer in the room** — and, more importantly, the loop that
*refuses to apply a change that would make it worse*.

Run `.venv/bin/python scripts/demo_loop.py --reset` and you see both halves:

**It promotes a good lesson.** A reviewer rejects three false-positive ACO matches. The
inducer finds the boundary separating rejected matches (top score 0.867) from confirmed ones
(1.000), proposes `aco_match_threshold = 0.872`, and the gate shadow-replays 163 frozen rows:

```
DECISION: PROMOTE
  aco_precision         0.75 → 1.0        aco_false_positives   1 → 0
  aco_recall             1.0 → 1.0        rows_total          163 → 163
```

**It refuses a bad one.** The same script then proposes a lesson that buys precision by
destroying recall:

```
DECISION: QUARANTINE
  GUARDRAIL: recall regressed 1.0 → 0.0 (3 true affiliations lost)
  active policy unchanged: True
```

**That refusal is the point.** A self-improving system that only ever accepts its own
proposals is theater. This one holds a frozen ground-truth set, computes precision *and*
recall, and quarantines the lesson. There is deliberately no `force` parameter on
`POST /api/gate`.

---

## How it's built

```
ZIP ─→ discover ─┬─→ enrich_registry ─┐
                 ├─→ join_aco ────────┼─→ review (HITL pause) ─→ score ─→ table
                 └─→ enrich_agentic ──┘           │
                                                  │ verdicts
                                                  ▼
                                    induce ─→ lessons ─→ GATE ─→ policy vN+1
                                                          │
                                                    (or quarantine)
```

**Nodes read a policy, never the lesson store.** Lessons compile deterministically into an
immutable, version-hashed `Policy`. A run records the version it executed under, so replaying
a version reproduces the table. That is also what makes the gate meaningful — you cannot
shadow-evaluate "the lessons so far," only one compiled artifact against another.

**Two HITL granularities.** LangGraph's `interrupt()` + checkpointer pauses *between* nodes
with graph state persisted, so a run can wait on a human indefinitely. The Agent SDK's
`canUseTool` callback catches "about to do something consequential *inside* a node."

**Six lesson kinds**, each re-parameterizing exactly one node: `alias`, `threshold`,
`blocklist` (→ `join_aco`), `rule`, `source_pref` (→ `enrich_registry`), `prompt`
(→ `enrich_agentic`).

---

## The honesty layer

Every field is `Sourced` — `{value, confidence, source, note, retrieved_at, human_verified,
corrected_from}`. Unknown is `null` **with a reason**, never `0` and never a plausible guess.

Column fill rate for ZIP `94301`, deterministic path:

| Filled | Columns | Why |
|---|---|---|
| 35/35 | `distance_mi` · `beds` · `bed_basis` · `management` · `services` | registry-sourced |
| 4/35 | `acos` | **inferred, never retrieved** |
| 0/35 | `avg_monthly_fee` | **modeled — no registry publishes it** |

The two thin columns are thin on purpose, and the engine says so rather than filling them:

> `acos` — *"No MSSP ACO affiliate in CA matched this facility's names at threshold 0.87.
> Absence of a match is not evidence of no affiliation."*

> `avg_monthly_fee` — *"No public registry publishes per-facility pricing. National median AL
> is ~$5,900/mo (Genworth-derived) but that is a market statistic, not this facility's rate."*

There is no public facility↔ACO mapping — ACO attribution is at the beneficiary level, not the
facility level — so that column is derived by name-matching against MSSP affiliate rosters,
scored, gated, and left empty when nothing clears the bar. An empty cell with a stated reason
beats a confident wrong number, most of all in `acos`, which is the column a user would
actually act on.

---

## Repo layout

```
engine/                    THE TOOL — Python, FastAPI, LangGraph
  atlas/pipeline.py        ZIP in, table out; interrupt/resume across a checkpointer
  atlas/graph/             LangGraph topology
  atlas/harness/agent.py   Claude Agent SDK wrapper
  atlas/meta/              policy · compiler · induce · evals (the gate) · store
  atlas/sources/           CMS · ACO · geocode · states/ca · disk cache
  evals/frozen_set.json    ground truth the gate judges against
  ui/index.html            complete UI: search, table, verdicts, policy, gate
  Dockerfile

server/ · dashboard/ · lib/   SUPERSEDED first lineage — see INTEGRATION.md
app/                          Next.js shell
```

### Two lineages, honestly

This repo contains two implementations. `server/` + `dashboard/` is a Node build whose thesis
was **DAG-as-data**: a node is a row with a natural-language instruction, so feedback can add,
reword, or disable nodes and the next run is a genuinely different graph. It works — driven
from a sibling harness it reached DAG v3, with `golden_set_validation` and `aco_conflict_filter`
added from live user feedback and the `aco` weight raised 0.15 → 0.30.

It is superseded as *the tool* because it has no authoritative data ingest: facilities are
researched live by an agent rather than pulled from a licensure registry. Atlas wins on
exactly the axis a reviewer will push hardest — registry-sourced beats web-inferred, and an
honest `0/35` on fees beats a handful of inferred numbers.

**Its one surviving contribution is topology evolution, which Atlas does not do.** Atlas
evolves *parameters* behind a gate; the Node build evolves *shape* without one. Merging them —
topology ops as a seventh lesson kind, routed through Atlas's gate — is R5 in
`INTEGRATION.md`.

---

## Docs

| | |
|---|---|
| [`TESTING.md`](TESTING.md) | verified setup, smoke commands, what a passing run proves |
| [`INTEGRATION.md`](INTEGRATION.md) | which lineage is live, why, ranked remaining work R1–R6 |
| [`engine/INDEX.md`](engine/INDEX.md) | Atlas's own build notes |

## Known limits

- **Not every column learns the same way.** `beds`, `management` and `services` are
  *retrieved*, so a correction means "this source was wrong" and compiles to a `source_pref`
  lesson demoting it. `avg_monthly_fee` is *modeled* — there is no source to prefer, so a
  `source_pref` lesson there would be inert while looking like learning, and the inducer
  refuses to write one. Fees need an interval with a stated method instead; that is unbuilt.
- **`acos` corrections still only move a threshold or a blocklist.** The richer lesson kinds
  (`alias`, `rule`, `prompt`) are reachable only through the agent induction path.
- **California is the only state with an ALF licensure connector.** Other ZIPs fall back to
  CMS-only, which returns skilled nursing and no state-licensed assisted living.
- **Distance is straight-line** from the origin ZIP centroid, not driving distance.
- `data/atlas.db` is local SQLite — single-machine, not multi-user.
