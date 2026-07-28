# S-19 Research — recorded walkthrough script

Target length: 4–6 minutes. The point of the recording is not "look, a table." It is
**the pipeline changed shape because a human said something.** Everything else is setup
for that moment.

## Before you hit record

```bash
cd ~/Documents/agenthome/server   && npm start        # :4747
cd ~/Documents/agenthome/dashboard && npm run dev     # :4748
open http://localhost:4748/#/research
```

Check: DAG panel renders 6 nodes at **version 1**. If patches from testing are already
active, deactivate them in the Evolution panel first so the demo starts clean — the
version number climbing from 1 is the visual spine of the whole story.

## Beat 1 — the ask (30s)

State the problem in the brief's own terms: ZIP in, a table of assisted living facilities
out, sorted by distance / beds / fees, with management, ACO relationships, and service mix.
Then say the part that matters: *the table is the demo, the loop is the product.*

## Beat 2 — the graph is data (45s)

Point at the DAG panel before running anything. Six nodes: `discover` fans out to three
parallel enrichment nodes, which fan back into `score` → `rank`.

Say the load-bearing sentence: **a node here is a row in a spec, not a function.** Its
`instruction` is a natural-language string the agent executes. That's the design decision
everything else depends on — if nodes were code, "evolve the pipeline" would mean writing
code, which is the thing we're trying to avoid.

## Beat 3 — run it (60s)

Enter `33701`. Narrate while it streams:
- Nodes light up live over SSE as LangGraph executes them.
- The three enrichment branches genuinely run in parallel and fan back in. Mention the bug
  this surfaced: concurrent writes to one state channel throw
  `INVALID_CONCURRENT_GRAPH_UPDATE` in LangGraph. Fixed with a reducer that merges by
  facility id, field-by-field, preferring non-null and breaking ties on confidence.

## Beat 4 — the agent stops and asks (60s) ← *first payoff*

When the HITL panel appears, slow down. This is the architectural claim:

> The Claude Agent SDK's `canUseTool` callback is already the agent asking permission.
> We answer it with a human instead of a policy.

Show all three responses exist — approve, reject-with-reason, edit-the-input-and-approve —
and use **edit** at least once so it's clear the human can change what the agent does, not
just gate it. Mention the second, coarser mechanism: LangGraph `interrupt()` +
`MemorySaver` checkpoints *between* nodes, so a run can wait on a person for minutes
without holding anything open.

## Beat 5 — the honesty layer (45s)

Hover a low-confidence cell. Show the provenance dot, the source, and an em-dash where a
value is unknown.

> This data is agent-researched, not authoritative. The `record_facilities` tool **rejects**
> any numeric field submitted without provenance, unknown is `null` with a reason and never
> `0` or `"N/A"`, and the composite score multiplies each dimension by that field's
> confidence — so a facility cannot win the ranking on numbers we aren't sure about.

In a healthcare-adjacent tool this is the difference between a demo and a liability.

## Beat 6 — evolution (90s) ← *the real payoff*

Type into the feedback box, verbatim:

> "You're missing memory-care bed counts — break those out separately, and I care more about
> cost than distance."

Then show, in order:
1. The patch appears with the evolver's **rationale in its own words**.
2. The concrete ops — an `edit_instruction` on `enrich_services` and a `set_weights` moving
   weight from distance to fee. (Verified live: the model chose to reword the existing node
   rather than add one, which is the better call and worth pointing out — it reasoned about
   the graph rather than just appending to it.)
3. The DAG version increments. The graph on screen changes.
4. Re-run `33701`. **The pipeline is different.** No one opened an editor.

## Beat 7 — the revert (30s)

Toggle the patch off. Version drops, weights return to base, the graph reverts. Say why this
matters: the evolver is an LLM proposing structural edits to a pipeline, so every change it
makes has to be attributable to the sentence that caused it and undoable by the person who
said it. Guardrails also refuse ops that would delete `discover` or disable every node, and
invalid ops are dropped rather than crashing the run.

## Beat 8 — close honestly (30s)

Name the cuts without hedging: no CMS or state-licensure ingest, distance is straight-line
from a ZIP centroid fixture, the patch store is local SQLite, and the evolver can be wrong —
which is exactly why revert exists.

Then the forward statement: replacing `discover`'s tool set with a real licensure API
changes nothing else in the system. That's the argument for nodes-as-data, and it's the
reason this was built inside an existing harness instead of as a fresh demo app.
