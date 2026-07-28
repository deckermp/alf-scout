# Testing

Everything below was run and verified 2026-07-28 on `integrate/atlas-engine`.

## Setup

```bash
cd engine
uv sync
```

That is the whole setup. **The deterministic path needs no API key** — it queries CMS and the
California licensing registry live. Agentic enrichment is bring-your-own-key
(`ANTHROPIC_API_KEY`, or an authenticated `claude` CLI on PATH); without one, agentic cells
degrade to `unknown` *with a stated reason*, never to a plausible-looking number.

---

## 1. Unit tests — 5 seconds

```bash
.venv/bin/python -m pytest tests/ -q
```

Expected: `34 passed`. Covers provenance invariants, ACO name matching, and the meta layer.

## 2. The closed loop — the real test, ~2 minutes

```bash
.venv/bin/python scripts/demo_loop.py --reset
```

This runs the whole arc against **live registries**:

> run → pause for review → reviewer verdicts → induce lesson → eval gate → re-run

### What a passing run proves

**The gate promotes a good lesson.** Three false-positive ACO matches get rejected by the
reviewer. The inducer derives a threshold that separates the rejected population (top score
0.867) from the confirmed one (1.000), proposes `aco_match_threshold = 0.872`, and the gate
shadow-replays the frozen set:

```
DECISION: PROMOTE
  metric                       active    candidate
  aco_precision                  0.75          1.0
  aco_false_positives               1            0
  aco_recall                      1.0          1.0
  rows_total                      163          163
```

Precision rises, recall holds, and the policy version moves `p4f450fc2e979 → pde0676068330`.

**The gate refuses a bad lesson.** Step 6 deliberately proposes a lesson that buys precision
by destroying recall:

```
DECISION: QUARANTINE
  - target metric did not improve: precision 1.0 -> 1.0, recall 1.0 -> 0.0
  - GUARDRAIL: recall regressed 1.0 -> 0.0 (3 true affiliations lost)
  active policy unchanged: True
```

**This is the most important line in the test suite.** A meta-learning system that only ever
accepts its own proposals is theater. This one holds a frozen set, computes both metrics, and
quarantines the lesson rather than promoting it. There is no `force` parameter on
`POST /api/gate`, by design.

Final tally the script prints:

```
false positives (NEW HAVEN x VIOLET HOLDINGS) : 3 -> 0
true positives  (VINEYARDS x Stanford ACO)    : 1 -> 1
human corrections preserved as overrides      : 3
```

## 3. The server

```bash
.venv/bin/python -m uvicorn atlas.server:app --port 8099
open http://localhost:8099/
```

Smoke it:

```bash
curl -s localhost:8099/api/health
# {"ok":true,"policy_version":"p...","aco_match_threshold":0.86,
#  "lessons_active":0,"states_with_alf_connector":["CA"],"agentic_available":true}

curl -s -X POST localhost:8099/api/search \
  -H 'content-type: application/json' \
  -d '{"zip":"94301","radius_mi":5,"agentic":false,"review":false}' | head -c 400
```

Expected for `94301` (Palo Alto): **35 facilities**, real street addresses, real geocodes.

### The HITL pause

Set `"review":true` and the run suspends at the review node with `"paused":true` and an
`interrupt` payload containing `needs_attention` rows. Resume with:

```bash
curl -s -X POST localhost:8099/api/verdicts \
  -H 'content-type: application/json' \
  -d '{"run_id":"<id>","verdicts":[{"facility_id":"...","field":"acos",
       "action":"reject","before":[...],"after":[],"note":"...","reviewer":"you"}]}'
```

The graph resumes across a real LangGraph checkpointer, so a run can sit paused for as long
as the process lives.

### Endpoints

`GET /api/health` · `POST /api/search` · `POST /api/verdicts` · `GET /api/runs` ·
`GET /api/run/{id}` · `GET /api/policy` · `GET /api/lessons` · `GET /api/verdicts` ·
`POST /api/induce` · `POST /api/gate` · `GET /api/promotions` · `GET /api/frozen-set`

---

## What the numbers mean

Column fill rate for `94301`, deterministic path only:

| Filled | Columns | Class |
|---|---|---|
| 35/35 | `distance_mi`, `beds`, `bed_basis`, `management`, `services` | registry / derived |
| 4/35 | `acos` | derived — inferred, never retrieved |
| 0/35 | `avg_monthly_fee` | modeled — no registry publishes it |

The two thin columns are **thin on purpose**, and the engine says why rather than guessing:

> `acos` — "No MSSP ACO affiliate in CA matched this facility's names at threshold 0.87.
> Absence of a match is not evidence of no affiliation."

> `avg_monthly_fee` — "No public registry publishes per-facility pricing. National median AL
> is ~$5,900/mo (Genworth-derived) but that is a market statistic, not this facility's rate."

An empty cell with a stated reason beats a confident wrong number — most of all in `acos`,
which is the column a user would actually act on.

---

## Known limits

- **`induce_deterministic()` only handles the `acos` field** (`induce.py:55`). Corrections to
  `beds`, `management`, `services`, or `avg_monthly_fee` produce no lesson on the
  deterministic path. The compiler and gate already support all six lesson kinds; only the
  inducer is narrow. This is R1 in `INTEGRATION.md` and the highest-value next change.
- **Only California has an ALF licensure connector** (`states_with_alf_connector: ["CA"]`).
  Other ZIPs fall back to CMS-only, which means SNFs and no state-licensed ALFs.
- **Distance is straight-line** from the origin ZIP centroid, not driving distance.
- `data/atlas.db` is local SQLite — single-machine, not multi-user.
