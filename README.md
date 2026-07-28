# S-19 Research — a market-research ADW whose DAG learns from its users

Status: built 2026-07-28 in a ~45-minute sprint. This document is the reasoning
record; the code is under `server/src/research/` and `dashboard/src/views/research/`.

---

## The problem as stated

> Input: a ZIP code. Output: a table of ALF facilities matching criteria, sorted by
> various fields — distance, beds, average fees — plus management, partnered ACOs,
> and service type (IL / AL / Memory Care / Home Health). The user should be able to
> provide HITL. Wrap LangGraph with an agent harness (Claude Agent SDK) to
> incorporate HITL from users. Use meta-learning DAG + Agent SDK to evolve the
> pipeline to improve the output.

The table is the *visible* deliverable. The actual deliverable is the loop that makes
the table get better without an engineer in the room.

## The three claims this build makes

**1. The DAG is data, not code.**
A pipeline node is a row — `{id, label, after[], instruction, enabled, origin}` — where
`instruction` is a natural-language string the harness executes. Nothing about a node is
compiled in. That single decision is what makes everything downstream possible: if a node
is a row, then a human's feedback can add one, reword one, or switch one off, and the next
run is genuinely a different pipeline. If nodes were functions, "evolving the DAG" would
mean writing code, which is exactly the thing the brief rules out.

`compileDag(BASE_DAG, patches)` folds an append-only patch log into the spec that
`buildGraph()` hands to LangGraph. Version number goes up. The graph really is different.

**2. `canUseTool` is the HITL seam.**
The Claude Agent SDK's tool-permission callback is a natural suspension point in an agent's
execution: the harness is already asking "may I run this?" We answer that question with a
human instead of a policy. The callback emits a `HitlRequest` over SSE and awaits a promise;
the dashboard resolves it via `POST /api/research/hitl` with approve / reject-with-reason /
edit-the-input-and-approve. LangGraph's `interrupt()` + `MemorySaver` handles the coarser
suspension — pausing *between* nodes with graph state checkpointed — so a run can wait on a
human for minutes without holding anything open.

Two mechanisms, two granularities, on purpose: `canUseTool` catches "about to do something
consequential *inside* a node," `interrupt()` catches "a stage finished, review it before I
continue."

**3. Feedback compiles into structure, not into a prompt.**
The cheap version of "meta-learning" is appending the user's complaint to a system prompt.
We don't do that. `evolveFromFeedback()` reads the human's words, the current DagSpec, and
the result table, and emits a typed `DagPatch` of `add_node` / `edit_instruction` /
`set_enabled` / `set_weights` operations. Those are structural edits to the graph, they're
persisted, they're attributable to the sentence that caused them, and — the part that makes
it honest — **they're revertible**. Every patch has an `active` flag. Toggle it off and the
next compile drops it.

Say a user writes *"you're missing memory-care bed counts, break those out."* The evolver
adds an `enrich_memory_care_beds` node downstream of `discover` and bumps the `beds`
weight. Version 1 → 2. The graph on screen grows a node. No one opened an editor.

## Why this lives in agenthome instead of a new repo

The first instinct was a greenfield Next.js app. Wrong instinct, and I killed it about ten
minutes in. Agenthome already has the parts that are tedious and load-bearing:

- `server/src/bus.mjs` — `broadcast()` already fans out SSE to every connected dashboard.
- `server/src/db.mjs` — a SQLite ledger already open, already migrated, already backed up.
- `dashboard/` — a screen registry, hash routing, a design-token palette, mermaid, and a
  Trace view whose visual language the new screen inherits for free.

Building a second harness would have meant spending the sprint on plumbing that already
works, and shipping something that looked like a demo rather than something that looked like
it belonged to a system. The research surface is one router mount, one screen registration,
and six new modules.

## Shape

```
 ZIP ─→ ┌──────────────────── LangGraph (compiled from DagSpec) ────────────────────┐
        │  discover ─┬─→ enrich_management ─┐                                       │
        │            ├─→ enrich_aco ────────┼─→ score ─→ rank ─→ facilities[]       │
        │            └─→ enrich_services ───┘                                       │
        └───────┬──────────────────────────────────────────────────┬────────────────┘
                │ each node's instruction executed by              │
                ▼                                                  ▼
        Claude Agent SDK query()                            score/rank computed
        · MCP tools: zip_centroid, haversine_miles,          locally (deterministic,
          record_facilities, WebSearch, WebFetch             confidence-weighted)
        · canUseTool ──→ HitlRequest ──SSE──→ dashboard
                            ▲                    │
                            └── POST /hitl ──────┘
                                                 │  human feedback
                                                 ▼
                                        evolveFromFeedback()
                                                 │ DagPatch
                                                 ▼
                                        append-only patch log ──→ compileDag() ──→ next run
```

The three enrichment branches run in parallel and fan back in. The facilities reducer
**merges by facility id** rather than replacing the array — otherwise the last branch to
finish would silently clobber the other two. That's the subtlest bug in the design and it's
commented as such in `runtime.mjs`.

## The honesty layer

This data is agent-researched, not authoritative. Pretending otherwise would be the worst
possible failure mode in a healthcare-adjacent tool, so the type system refuses to let us:

- Every field is `Sourced<T>` = `{value, prov: {source, confidence, note}}`. The
  `record_facilities` tool **rejects** any numeric field submitted without provenance.
- Unknown is `{value: null}` with a reason — never `0`, never `"N/A"`. The table renders an
  em-dash and puts the reason in the tooltip.
- The composite score multiplies each normalized dimension by that field's confidence, so a
  facility can't win the ranking on numbers we aren't sure about.
- The UI renders sub-0.5-confidence values visually distinct.

This is the discipline from `~/Documents/sevah-prep/REAL-VS-SIMULATED.md`, applied at the
type level instead of in a README.

## Known cuts, stated plainly

- **No authoritative data ingest.** No CMS Provider of Services file, no state licensure
  database. Facilities are researched live by the agent. A production version replaces the
  `discover` node's tool set with a licensure API and keeps everything else identical —
  which is a point in favor of nodes-as-data.
- **Distance is straight-line** from ZIP centroid, not driving distance, and the centroid
  table is a small embedded fixture covering the demo ZIPs.
- **Patch store is SQLite-local.** Survives restart on this machine; not multi-user.
- **The evolver can be wrong.** It's an LLM proposing structural edits. Mitigations:
  guardrails reject ops that delete `discover` or disable every node, invalid ops are
  dropped rather than thrown, a deterministic weight-nudge heuristic backs it up when the
  model returns junk, and every patch is revertible by the human who caused it.

## Verify it end to end

```bash
cd ~/Documents/agenthome/server && npm start          # :4747
cd ~/Documents/agenthome/dashboard && npm run dev     # :4748 → #/research
```

1. Enter `33701`. Watch nodes light up in the DAG panel as the run streams.
2. When the agent pauses for permission, answer it in the HITL panel — the run resumes.
3. Sort the table by beds, then by fee. Note the confidence dots and the em-dashes.
4. Type feedback: *"you're missing memory-care bed counts, break those out separately."*
5. Watch a patch appear with its rationale, the DAG version increment, and a new node
   render in the graph. Run `33701` again — the pipeline is different.
6. Toggle the patch off. The node disappears. That's the revert path.
