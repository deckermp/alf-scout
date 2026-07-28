# ALF Atlas — orientation for coding agents

**The tool is Python, in `engine/`.** Not the Next.js app at the repo root — that is a
superseded prototype (see below). If you are here to change behavior, you are working in
`engine/atlas/`.

## Run it

```bash
cd engine
uv sync
.venv/bin/python -m pytest tests/ -q                      # 42 tests, ~2s
.venv/bin/python -m uvicorn atlas.server:app --port 8099  # UI at http://localhost:8099/
```

No API key needed — the deterministic path queries CMS and the CA licensing registry live.
Set `ANTHROPIC_API_KEY` only for agentic enrichment.

The end-to-end proof is `.venv/bin/python scripts/demo_loop.py --reset` (~2 min, live data).
Run it before and after any change to `engine/atlas/meta/`.

## What this is

ZIP code in, assisted-living facility table out. Human corrections compile into a versioned
policy, and a lesson only takes effect **if it survives an eval gate**.

```
ZIP ─→ discover ─┬─→ enrich_registry ─┐
                 ├─→ join_aco ────────┼─→ review (HITL pause) ─→ score ─→ table
                 └─→ enrich_agentic ──┘           │ verdicts
                                                  ▼
                                    induce ─→ lessons ─→ GATE ─→ policy vN+1
                                                          └─→ or quarantine
```

## Rules that are load-bearing

1. **Nodes read a `Policy`, never the lesson store.** Lessons compile deterministically into
   an immutable version-hashed policy in `meta/compiler.py`. Runs record the version they ran
   under. Breaking this breaks reproducibility *and* the gate, which can only compare two
   compiled artifacts.
2. **Never add a `force` parameter to the gate.** `POST /api/gate` refusing to promote is the
   product's central claim. `meta/evals.py` quarantines lessons that regress recall; that
   behavior is tested and must stay.
3. **Unknown is `null` with a stated reason** — never `0`, never `"N/A"`, never a plausible
   guess. Every cell is `Sourced` (`schema.py`). A healthcare-adjacent tool that invents a
   number is worse than one that says it does not know.
4. **Do not emit a lesson that compiles to the same policy.** An inert lesson reports learning
   that did not happen. `meta/induce.py` refuses several of these on purpose and the refusals
   are tested — read `tests/test_induce_source_pref.py` before changing induction.
5. **Retrieved vs. modeled fields learn differently.** `beds` / `management` / `services` are
   retrieved, so a correction demotes a source (`source_pref`). `avg_monthly_fee` is modeled —
   no registry publishes per-facility pricing — so there is no source to demote and the
   inducer deliberately writes nothing.

## Layout

```
engine/atlas/
  pipeline.py     ZIP in, table out; interrupt/resume across a LangGraph checkpointer
  graph/          nodes, build, state — the LangGraph topology
  harness/        Claude Agent SDK wrapper
  meta/           policy · compiler · induce · evals (the gate) · store
  sources/        cms · aco · geo · states/ca · disk cache
  server.py       FastAPI, 12 endpoints, serves ui/index.html at /
engine/evals/frozen_set.json   ground truth the gate judges against
engine/ui/index.html           the whole UI, single file, no build step
```

## Superseded — do not build on

`server/`, `dashboard/`, `lib/`, `app/` are a Node/Next.js prototype of the same brief. It is
kept for one idea Atlas lacks (topology evolution: adding and rewording graph nodes) and is
otherwise not wired to anything. **It is not the tool.** See `INTEGRATION.md`.

## Docs

`README.md` — what it is and the claim · `TESTING.md` — verified commands and what a passing
run proves · `INTEGRATION.md` — lineage decision and ranked remaining work · `engine/INDEX.md`
— Atlas build notes.

## Known limits

Only California has an ALF licensure connector; other ZIPs fall back to CMS-only (skilled
nursing, no state-licensed assisted living). `avg_monthly_fee` is unpopulated by design and
needs an interval-with-method mechanism. Distance is straight-line from the ZIP centroid.
`data/atlas.db` is local SQLite, single-machine.
