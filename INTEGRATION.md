# Integration — two lineages, one tool

**Branch:** `integrate/atlas-engine`
**Written:** 2026-07-28

This repo now contains two implementations of the same brief. This document says which one
is live, which one is superseded, and what remains before the merged tool is complete.

---

## What happened

Three builds were produced in parallel for the ALF market-research take-home. They turned
out to be **two lineages, not three**:

**Lineage A — the DAG-as-data prototype.**
`agenthome/server/src/research/` → copied into this repo as `server/` + `dashboard/`.
Three of its seven backend modules are byte-identical to the agenthome originals
(`contract.mjs`, `evolver.mjs`, `store.mjs`); four diverged slightly. Node/JS. Its idea is
that a pipeline node is a *row* with a natural-language `instruction`, so human feedback can
add, reword, or disable a node and the next run is genuinely a different graph.

**Lineage B — the Atlas engine.** `engine/` (was `~/Documents/alf-atlas`). Python. Real
registry connectors, an immutable version-hashed policy, an eval gate, and a working
end-to-end run against live data.

**Lineage B is the live tool.** Lineage A stays in the tree because its topology-evolution
idea is the one thing Atlas does not do, and it is the natural next merge (see "Remaining
work"). It is not wired to anything right now.

---

## Why Atlas is the spine

Verified 2026-07-28, running locally:

- `pytest` — **34 passed in 0.07s**
- `POST /api/search {"zip":"94301","radius_mi":5}` — **35 real facilities**, real addresses,
  real geocodes, bed counts from state and federal registries
- `GET /api/health` — `{"ok":true,"policy_version":"pafcd1afc2cfc","lessons_active":1,...}`
- The deterministic spine needs **no credentials**. It queries CMS and the CA licensing
  registry on request, so a deployed endpoint is genuinely live rather than a fixture replay.
  Agentic enrichment is bring-your-own-key and degrades to `unknown` cells *with reasons*,
  never to a plausible-looking number.

### Column fill rate, ZIP 94301, deterministic path only

| Column | Filled | Source class |
|---|---|---|
| `distance_mi` | 35/35 | derived |
| `beds` | 35/35 | registry |
| `bed_basis` | 35/35 | registry |
| `management` | 35/35 | registry |
| `services` | 35/35 | 27 registry · 8 derived |
| `acos` | **4/35** | derived |
| `avg_monthly_fee` | **0/35** | — |

Five of seven columns are registry-backed and stable. The two thin ones are thin *for the
right reasons* — and the engine says so in the HITL payload rather than hiding it:

> `acos`: "No MSSP ACO affiliate in CA matched this facility's names at threshold 0.87.
> **Absence of a match is not evidence of no affiliation.**"

> `avg_monthly_fee`: "No public registry publishes per-facility pricing. National median AL
> is ~$5,900/mo (Genworth-derived, cited in R4) but that is a market statistic, not this
> facility's rate."

That is the correct posture for both fields — ACO affiliation is *inferred*, never
retrieved, and per-facility pricing is *modeled*, always. An empty cell with a stated reason
beats a confident wrong number, particularly in the ACO column, which is the one a user would
actually act on.

---

## Architecture as merged

```
engine/                          ← THE LIVE TOOL (Python, FastAPI, LangGraph)
  atlas/
    pipeline.py                  ZIP in, table out; interrupt/resume across a real checkpointer
    graph/{build,nodes,state}.py LangGraph topology — nodes are Python functions
    harness/agent.py             Claude Agent SDK wrapper
    meta/
      policy.py                  immutable, version-hashed Policy — the ONLY thing nodes read
      compiler.py                lessons → Policy, deterministic and total
      induce.py                  verdicts → proposed lessons
      evals.py                   the promotion gate (shadow replay of the frozen set)
      store.py                   runs · verdicts · lessons · promotions · overrides
    sources/                     cms · aco · geo · states/ca · disk cache
  evals/frozen_set.json          ground truth the gate judges against
  ui/index.html                  complete single-file UI: search, table, verdicts, meta panel
  Dockerfile                     deployable as-is

server/ · dashboard/ · lib/      ← LINEAGE A, superseded, not wired. Kept for the topology
                                   layer noted under "Remaining work".
app/                             ← Next.js shell from the original scaffold
```

### The two meta-learning models, side by side

They evolve **different axes**, which is why the merge is additive rather than a choice:

| | Lineage A (`server/`) | Atlas (`engine/`) |
|---|---|---|
| Evolves | **Topology** — add / reword / disable nodes | **Parameters** — thresholds, aliases, blocklists, service rules, source preference, prompt addenda |
| Applied | Immediately, unconditionally | Only after passing an eval gate |
| Reproducible run | No | Yes — runs record a policy version hash |
| Instance corrections | ❌ | ✅ `overrides` table |
| Source-trust priors | ❌ | ✅ `source_pref` per field |
| Frozen eval set | ❌ | ✅ |
| Revert | Patch `active` flag | Lesson `status` + `promotions` ledger |

Atlas holds the levels that compound (instance facts, source trust) and the discipline that
makes evolution honest (a gate, a version hash). Lineage A holds the one axis Atlas lacks:
the graph's *shape*.

---

## Remaining work, ranked

### R1 — The learning loop closes for exactly one field

`induce_deterministic()` opens with `if r["field"] != "acos": continue`. It handles two
lesson kinds — `threshold` and `blocklist` — and only when the verdict carries a populated
`before` list with `match_score` values. **A correction to `beds`, `management`, `services`,
or `avg_monthly_fee` produces no lesson at all** on the deterministic path. The other four
lesson kinds (`alias`, `rule`, `source_pref`, `prompt`) are reachable only through the
agentic inducer.

Verified live: submitting a verdict rejecting a null `acos` value returned
`{"created":[],"lessons":[]}`, and the gate then correctly reported
`{"decision":"noop","reasons":["no proposed lessons to evaluate"]}`.

This is the highest-value gap. The schema, the compiler, and the gate all already support the
other kinds — only the inducer is narrow. Extending it to emit `source_pref` lessons from
field disagreements is the single change that makes "the pipeline learns" true across the
whole table rather than one column.

### R2 — `avg_monthly_fee` is 0/35

Nothing populates it. `source_pref` already lists `["human", "agent"]` for this field, so the
intended path is agentic or human. It should be a **`{low, high, method}` interval**, not a
scalar — a point estimate for a modeled quantity is the most misleading cell available.

### R3 — `acos` is 4/35

The matcher works and is honest about its misses. Improving recall means the derivation chain
from `DIMENSIONS.md` §2: CMS ACO PUF → participant TIN/NPI → NPPES practice address → does
that provider plausibly serve this building. Strong evidence is an NPPES practice address that
*is* the facility address; a nearby geriatrics practice is not evidence.

> ⚠️ Verify first: which CMS ACO PUF vintages expose participant TINs vs. individual NPIs
> varies by program year. Do not assume roster granularity.

### R4 — Only CA has a licensure connector

`states_with_alf_connector: ["CA"]`. Every other ZIP falls back to CMS-only, which means SNFs
and no state-licensed ALFs. Either add connectors or make the UI state plainly that non-CA
ZIPs return a partial table — silence here reads as "no facilities exist."

### R5 — Fold Lineage A's topology layer into Atlas

Atlas evolves parameters; nodes are fixed Python functions. Adding a node still requires an
engineer. Lineage A's `add_node` / `edit_instruction` / `set_enabled` ops are the missing
axis — and routed through Atlas's existing gate, they would be strictly better than they are
in Lineage A, where they apply unconditionally.

### R6 — Ports and the UI question

Atlas serves its own complete UI from `engine/ui/index.html` (search, radius, agentic toggle,
gaps, table, verdict bar, meta panel with induce/gate/policy/lessons, trace). It covers the
full loop today. Lineage A's six React components are richer visually but speak a different
API contract and are not wired. **For v1, ship Atlas's UI** — porting React is real work and
buys presentation, not capability.

---

## Run it

```bash
cd engine
uv sync                 # or: python -m venv .venv && .venv/bin/pip install -e .
.venv/bin/python -m pytest tests/ -q
.venv/bin/python -m uvicorn atlas.server:app --port 8099
open http://localhost:8099/
```

Deterministic path needs no key. For agentic enrichment, set `ANTHROPIC_API_KEY` (or have an
authenticated `claude` CLI on PATH — the SDK will drive it).

### Endpoints

`GET /api/health` · `POST /api/search` · `POST /api/verdicts` · `GET /api/runs` ·
`GET /api/run/{id}` · `GET /api/policy` · `GET /api/lessons` · `GET /api/verdicts` ·
`POST /api/induce` · `POST /api/gate` · `GET /api/promotions` · `GET /api/frozen-set`

---

## Cross-references

- `~/Documents/sevah-prep/takehome/DIMENSIONS.md` — the domain analysis behind R2, R3, R4
- `~/Documents/agenthome/docs/RESEARCH-META-LEARNING-HANDOFF.md` — the gap list written
  against Lineage A before Atlas was found; its G1/G2/G6 are already solved in `engine/`
- `engine/INDEX.md` — Atlas's own build notes
