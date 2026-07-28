# ALF Atlas — recorded walkthrough

Target length: 6–8 minutes.

**The line to demo is the QUARANTINE, not the promote.** Precision 0.75 → 1.0 is a good
result, but any system that applies whatever the human says can produce a good result by
accident. Refusing a lesson that would have taken recall 1.0 → 0.0 is what distinguishes a
learning loop from a feedback form. Structure the recording so that refusal is the payoff,
and treat everything before it as the setup that earns it.

> This script replaced an earlier one written against a different build — the Node
> DAG-as-data prototype now sitting in `server/`. That build is not the tool. If you find a
> beat here that mentions `record_facilities`, `canUseTool`, or a mermaid DAG panel, it
> escaped the rewrite: cut it.

## Before you hit record

```bash
cd engine && uv sync
.venv/bin/python -m pytest tests/ -q                     # 34 passed
.venv/bin/python -m uvicorn atlas.server:app --port 8099 # leave running
open http://localhost:8099/
```

Second terminal, ready but **not yet run**:

```bash
.venv/bin/python scripts/demo_loop.py --reset
```

Check `GET /api/health` returns `"ok":true` and note the `policy_version` — you'll point at it
changing later. `--reset` restores the pre-lesson state, so run it once before recording and
once during; the numbers below are what you should see both times.

## Beat 1 — the ask (30s)

State it in the brief's own terms: a ZIP code in, a table of assisted-living facilities out,
sorted by distance, beds, and fees, with management, ACO affiliations, and service mix. A
human can intervene. The pipeline learns.

Then the sentence the rest of the recording defends: *the table is the visible deliverable;
the loop that refuses to make the table worse is the actual one.*

## Beat 2 — real data, no credentials (60s)

Enter `94301`. Thirty-five facilities come back with real names, real street addresses, real
geocodes.

Say where it comes from: **CMS and the California licensing registry, queried live, with no
API key.** This is not a fixture replay — a deployed endpoint genuinely works. Open a `beds`
cell and show `source: S1`, `confidence: registry`.

This beat buys credibility for Beat 7. A reviewer who believes the data is real will believe
the eval gate is real.

## Beat 3 — the honesty layer (60s)

Fill rates on the deterministic path, ZIP 94301, radius 5 — read them out:

| Column | Filled | Class |
|---|---|---|
| `distance_mi` | 35/35 | derived |
| `beds` | 35/35 | registry |
| `management` | 35/35 | registry |
| `services` | 35/35 | registry / derived |
| `acos` | 4/35 | derived |
| **`avg_monthly_fee`** | **0/35** | **unknown, with a reason** |

Open the fee cell. Not `0`, not `"N/A"`, not a plausible guess — `null`, carrying the note
that **no public registry publishes per-facility pricing**, plus the national median clearly
labeled as context rather than as this facility's price.

Say why it matters here specifically: this is healthcare-adjacent, and a confident wrong
number is worse than an honest gap. Every cell carries `confidence`, `source`,
`retrieved_at`, `human_verified`, and `corrected_from`, so "how do you know that" always has
an answer.

Name the `acos` 4/35 too: ACO affiliation is *inferred, never retrieved* — there is no public
facility↔ACO mapping, so attribution runs through business-name matching. That is precisely
why it needs a threshold, which is what Beats 5–7 are about.

## Beat 4 — the human corrects it (60s)

In the UI, reject the three false-positive ACO matches (`NEW HAVEN` × `VIOLET HOLDINGS`) and
confirm the true one (`THE VINEYARDS` × Stanford ACO).

Point at two things:
- Corrections persist as **overrides on those rows** — the human's answer isn't discarded
  once a lesson is derived from it.
- Nothing about the pipeline has changed yet. A correction is evidence, not an instruction.
  Resist skipping ahead; the gap between "human spoke" and "system changed" is the argument.

## Beat 5 — the correction becomes a proposal, with reasoning (45s)

Run `demo_loop.py --reset` and walk the output. The inducer finds the boundary:

```
kind=threshold  node=join_aco  status=proposed
  payload   : {"aco_match_threshold": 0.872}
  rationale : Reviewer rejected 3 ACO match(es), the highest scoring 0.867.
              Lowest confirmed match scores 1.000. A threshold of 0.872
              separates the two populations on the evidence seen so far.
```

Read the rationale aloud. It cites the scores it actually saw — 0.867 rejected, 1.000
confirmed — and picks a number between them. A lesson with evidence attached, status
`proposed`, not `active`.

## Beat 6 — the gate promotes it (45s)

The gate shadow-replays **163 frozen rows**, candidate against active:

```
DECISION: PROMOTE
  aco_precision      0.75 → 1.0        aco_false_positives   1 → 0
  aco_recall          1.0 → 1.0        rows_total          163 → 163
```

Policy version changes, threshold moves 0.86 → 0.872, and the re-run shows false positives
gone with the true affiliation kept.

Note the guardrail column: recall held at 1.0. Promotion required the target metric to improve
**and** nothing else to regress.

## Beat 7 — the gate refuses (90s) ← *the payoff*

Slow all the way down.

The script proposes a second lesson that buys precision by destroying recall
(`aco_min_key_tokens = 5`, `aco_min_key_chars = 40`):

```
DECISION: QUARANTINE
  - target metric did not improve: precision 1.0 -> 1.0, recall 1.0 -> 0.0
  - GUARDRAIL: recall regressed 1.0 -> 0.0 (3 true affiliations lost)
  lesson status now: quarantined
  active policy unchanged: True
```

Then say the thing the whole recording exists to say:

> A system that applies whatever the human tells it isn't learning — it's obeying, and it can
> be argued into being worse. This one measured the proposed change against 163 frozen rows,
> found it would throw away every true affiliation to buy precision it already had, and
> **refused it**. The correction is still on file. The policy is unchanged. Nothing silently
> degraded.

Point at `active policy unchanged: True`. That boolean is the argument.

## Beat 8 — what isn't built (45s)

Don't end on a triumph. Name the gaps:

- **The learning loop closes for one column.** `induce_deterministic()` filters to `acos` and
  emits nothing for `beds`, `management`, `services`, or `avg_monthly_fee`. A correction to a
  bed count teaches the system nothing durable today. Schema, compiler, and gate already
  support all six lesson kinds — only the inducer is narrow.
- **Widening it is not uniform**, which is the subtle part worth saying out loud: `beds` and
  `management` are *retrieved* facts with a registry of record, so a correction means "this
  source was wrong here" and `source_pref` fits. `avg_monthly_fee` is *modeled, never
  retrieved* — there is no source to prefer, so a `source_pref` lesson there would be inert
  while looking like learning. Widening is scoped to retrieved fields for exactly that reason.
- **No topology evolution.** The pipeline can retune itself but cannot restructure itself — it
  cannot add a node. That capability exists in the `server/` prototype (typed, revertible
  `PatchOp`s; its DAG reached v3 with two nodes added from live feedback and the `aco` weight
  doubled 0.15 → 0.30). The merge is designed but unbuilt: a topology patch becomes a seventh
  lesson kind whose compiled artifact is a graph instead of a threshold — and which has to
  clear the same gate.
- **One state.** The ALF connector covers CA. Everything else is structure without coverage.

## Beat 9 — close (20s)

Adding a state is a connector. Adding a learnable column is an inducer branch. Adding a
*shape* of change is a lesson kind. All three route through the same gate. The part that took
real work is the part that says no.

---

### If you only have two minutes

Beats 2, 7, and 8. Real data, the refusal, the honest gaps. That's the argument.
