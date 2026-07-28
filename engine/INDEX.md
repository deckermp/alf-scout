# ALF Atlas — sprint grounding index

**Compiled** 2026-07-28, from `~/Documents/sevah-prep` plus live probes of every data source named below.
**Purpose** — one file to ground the sprint. What we inherit, what is actually queryable, what is honestly not,
and what "done" means. Read this before writing code; it is the contract the build is judged against.

---

## 0. The ask, restated

> Input: a ZIP code. Output: a table of ALF facilities matching criteria, sortable by distance, bed count and
> average fees; carrying management, affiliated ACOs, and service mix (IL / AL / Memory Care / Home Health).
> A human can correct the table. A LangGraph pipeline does the work, wrapped in an agent harness (Claude Agent
> SDK) that carries the human-in-the-loop. A meta-learning DAG turns the human's corrections into an improved
> pipeline.

The interesting half of that ask is the second half. A zip-code facility table is a query. **A pipeline that gets
measurably better every time a human corrects it is a product** — and it is the only part that cannot be
copied from a directory site.

---

## 1. What this inherits from `sevah-prep` (do not re-derive)

Five artifacts already exist and are verified in that folder. This sprint borrows their *doctrine*, not their code.

| Inherited | From | How it lands here |
|---|---|---|
| **Trust ladder** — observation → review → exception; nothing renders that the substrate does not contain | `data-model/README.md`, `schema.ts` | Every table cell is a `Cell{value, source, confidence, provenance}`. A cell with no provenance cannot be constructed. |
| **Real-vs-simulated discipline** — one scrupulous table, per artifact, no hedging | `REAL-VS-SIMULATED.md` | `docs/REAL-VS-SIMULATED.md` ships in this repo and the UI links to it. Fields that no registry holds say so *in the cell*, not in a footnote. |
| **Harness before feature** — target metric + frozen set + guardrail, declared before the feature | Sevah's own `blog_eval-first-voice-ai` | No lesson reaches the live pipeline without beating the frozen set. `atlas/meta/evals.py`. |
| **Shadow mode** — the beneficiary is never the test | Sevah's `blog_shadow-mode-evaluation` (Sravan's Civil Maps technique) | Candidate policies run in shadow against recorded runs. The user's live table is never the experiment. |
| **Earn-the-commit / canary / auto-revert** — a promotion gate that can actually say no | `fleet-harness/` rollout engine, R2 | Lesson promotion is the same state machine: propose → shadow → gate → promote, else quarantine. The word "forced-promotion" is an incident here too. |
| **Cohorts, not averages** — averaging is the wrong abstraction | `Sevah-Vault/02-Atoms/Cohorts…` | Facilities are not scored into one number. Sort keys stay separate and the user picks. No composite "match score". |
| **Deferral ≠ laundering failure** | fleet-harness fix, 2026-07-28 | A field the pipeline could not establish is `unknown` with a reason. It is never silently filled with a plausible number. |

### Market facts that constrain the design (from `research/R4-ALSNF-POPULATION-MARKET.md`)

- **There is no federal assisted-living licensure. States define, license and survey.** [R4 §7a] This is the single
  most important engineering fact in the sprint: *there is no national ALF table to query.* Any tool claiming
  national ALF coverage from one endpoint is either scraping a referral site or making it up.
- Counts differ by source and honestly so — NCAL ~30.6k licensed communities vs NCHS 32,231 residential care
  communities [R4 §1a]. Licensure counts and survey-frame counts measure different things.
- ~**53%** of AL residents are 85+; roughly half have cognitive impairment [R4 §1b]. Memory-care presence is a
  material sort key, not a nice-to-have.
- The buyer is **corporate, ROI-starved and drowning in point solutions**: 74% name lack of demonstrable ROI the
  #1 barrier to new technology, 77% rank interoperability a top-three problem [R4 §5a, Argentum 2025].
  → *A market-research tool whose output cannot be audited is another point solution.* Provenance is the feature.
- The referral economy (A Place for Mom et al.) is **paid placement — 50–100% of first month's rent** [R4 §6b].
  → Directory sites are not a neutral source. Where we use them we must say so and rank them below registries.
- Fees: **~$5,900/month median AL** is a *national median*, not a facility fact [R4 §0]. Per-facility pricing is
  almost never published. This is the field where the tool must be most honest.

### Hard rules carried forward

1. **The ACO/physician direction in the Sevah thread is privileged** — it came from a private email, not the
   public site. This repo is public. It contains **no Sevah-specific ACO framing, no Sevah branding, no Sevah
   copy.** CMS ACO data is public and is used as public data. Nothing here says why anyone would want it.
2. **No clinical claims.** No diagnoses, no medications, no vitals, no quality judgments beyond CMS's own
   published star ratings, attributed to CMS.
3. **Never present an inference as verified.** Every cell carries its own confidence.
4. `ruff`/`tsc`-equivalent clean and the test suite green at every phase boundary. Verify before claiming.

---

## 2. The source ledger — what is actually queryable

Every row below was **probed live on 2026-07-28** from this machine. HTTP status and row counts are observed,
not assumed.

| # | Source | Endpoint | Verified | Gives us |
|---|---|---|---|---|
| S1 | **CA CCL — Residential Care Facilities for the Elderly** | `data.chhs.ca.gov` CSV resource `744d1583…` | ✅ 200, **12,522 rows**, 2.4 MB | The real ALF spine for CA: `facility_name`, `facility_zip`, **`facility_capacity`** (beds), **`licensee`** (management), `facility_administrator`, `facility_type` (encodes CCRC), `facility_status`, `license_first_date` |
| S2 | **CMS Nursing Home — Provider Information** | `data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0` | ✅ 200, **14,695 rows**, 99 cols | Certified SNFs nationally: `number_of_certified_beds`, `average_number_of_residents_per_day`, `ownership_type`, **`chain_name`**, `legal_business_name`, five-star ratings, `zip_code` |
| S3 | **CMS Nursing Home — Ownership** | `…/datastore/query/y2hd-n93e/0` | ✅ 200, **245,354 rows** | **Management, for real**: `owner_name`, `owner_type`, `ownership_percentage`, and `role_played_by_owner_or_manager_in_facility` — which distinguishes *ownership interest* from **MANAGERIAL CONTROL** |
| S4 | **CMS — ACO SNF Affiliates (MSSP PY2026)** | `data.cms.gov/data-api/v1/dataset/5b227bd9…/data` | ✅ 200 | **The ACO↔facility link.** `Aff_LBN` (affiliate legal business name), `ACO_ID`, `ACO_Name`, `ACO_Service_Area`, `SNF_3-Day_Rule_Waiver`, track, public reporting URL |
| S5 | **CMS — Accountable Care Organizations (master)** | `…/dataset/69ec2609…/data` | ✅ 200 | ACO roster with `lat`/`long`, service area, track, exec contacts — for ACOs present in the market even without a named SNF affiliate |
| S6 | **Census Geocoder** (one-line address) | `geocoding.geo.census.gov/geocoder/locations/onelineaddress` | ✅ returns coords (verified on a real RCFE address) | Exact facility lat/lon. Free, no key. |
| S7 | **Census ZCTA Gazetteer 2024** | `www2.census.gov/geo/docs/…/2024_Gaz_zcta_national.zip` | ✅ 200 | ZIP centroid lat/lon → the origin point for distance |
| — | **NPPES NPI Registry** | `npiregistry.cms.gov/api` | ❌ **DNS does not resolve from this machine** (`curl: (6)`) | Would have given a national ALF taxonomy search (`310400000X`). **Not available. Recorded as a gap, not routed around.** |

**Read that table twice.** Five of the seven requested output columns have a real, free, keyless public source.
Two do not, and no amount of engineering changes that.

### Requirement → source map

| Requested column | Source | Honest status |
|---|---|---|
| Find all ALFs in a ZIP | S1 (CA) + S2 (SNF, national) | ✅ **real** in CA; national ALF coverage is structurally impossible from one source — see §3 |
| Sort by distance | S6/S7 + haversine | ✅ **real**, exact geocode, cached |
| Sort by number of beds | S1 `facility_capacity`, S2 `number_of_certified_beds` | ✅ **real** — but they are *different things* (licensed capacity vs Medicare-certified beds) and must not be silently merged into one column |
| Sort by average fees | — | ⚠️ **no public per-facility source exists.** Agentic retrieval + HITL, always labelled `estimated`/`unknown`, never a bare number |
| List the management | S3 `MANAGERIAL CONTROL` rows, S2 `chain_name`, S1 `licensee` | ✅ **real** for SNF; **real** for CA ALF (licensee ≠ manager — state the distinction) |
| List affiliated ACOs | S4 + S5 | ✅ **real data**, ⚠️ **fuzzy join** — S4 keys on legal business name, not CCN. See §4; this is the best HITL demo in the build |
| Service type (IL/AL/MC/HH) | S1 `facility_type` (partial), S2 (SNF) | 🟡 **partial** — MC and IL are not licensure categories in most states. Agentic + HITL |

---

## 3. The gaps, stated before they are discovered

1. **National ALF coverage is not achievable and the tool must not pretend otherwise.** The design answer is a
   **pluggable state-connector registry**: CA ships real (S1); every other state returns
   `CoverageGap(state, reason, what_would_close_it)` and the UI renders that gap as a first-class row, not an
   empty table. This is R4 §7a made operational. Adding a state is adding one connector file.
2. **Fees are the weakest column in the product.** No registry publishes them. The tool's contribution is not a
   number — it is *knowing that it does not have the number* while a directory site would happily print one.
3. **NPPES is unreachable from this machine.** It would have widened ALF coverage nationally via taxonomy search.
   Logged as an open item with the exact call that would work elsewhere; not silently dropped.
4. **The ACO join is name-based.** `Aff_LBN` vs `provider_name` vs `legal_business_name` disagree on
   punctuation, `LLC`/`INC`, DBA names and chain naming. A threshold picked by taste will produce false
   positives. **This is precisely why the meta-learning loop exists** — see §4.
5. **`chain_name` is frequently blank in S2** and ownership percentages in S3 are strings (`"5%"`, `"81%"`).
   Parsing is real work, not a cast.

---

## 4. Architecture — three layers and a loop

```
ZIP ──► [ LangGraph DAG ]  deterministic spine, real sources, per-cell provenance
             │
             ├─ resolve_zip ─ discover ─ enrich_registry ─ join_aco ─ enrich_agentic ─ score ─ render
             │                                                │
             │                                  ┌─────────────┘
             │                                  ▼
             │                        [ Claude Agent SDK harness ]
             │                        · runs the enrichment agent
             │                        · canUseTool = the HITL gate: every write to a
             │                          cell is a tool call a human can allow/deny/edit
             │
             ▼
        interrupt() ──► [ HUMAN reviews the table ] ──► corrections + confirmations
                                                              │
                                                              ▼
                                              [ META-LEARNING DAG ]
                              corrections ─► induce lessons ─► compile policy@vN+1
                                                              │
                                          shadow-replay frozen set: vN+1 vs vN
                                                              │
                                       gate passes ──► promote      gate fails ──► quarantine
```

**Two grains of HITL, deliberately distinguished:**
- *Action-grain* — Claude Agent SDK `can_use_tool`. The agent proposes writing a cell; the human allows, denies,
  or supplies the correct value. This is the SDK's permission callback used for what it is actually for.
- *Table-grain* — LangGraph `interrupt()`. The pipeline pauses with the assembled table and resumes via
  `Command(resume=…)` carrying a batch of verdicts.

**The meta-learning DAG** turns verdicts into five typed lesson kinds, each bound to a named DAG node:

| Lesson kind | Example induced from a correction | Node it re-parameterises |
|---|---|---|
| `alias` | `"SUNRISE OF PALO ALTO" ≡ "Sunrise Senior Living"` | `join_aco` |
| `threshold` | fuzzy match cutoff 0.82 → 0.88 after 3 false positives | `join_aco` |
| `rule` | `facility_type` contains `CONTINUING CARE` → services ⊇ {IL, AL} | `enrich_registry` |
| `source_pref` | for `beds` in CA prefer S1 over an agentic estimate, always | `enrich_registry` |
| `prompt` | appended constraint to the enrichment agent's system prompt | `enrich_agentic` |

A lesson is **compiled**, not obeyed: `atlas/meta/compiler.py` folds active lessons into an immutable
`Policy` object with a version hash. The DAG reads policy; it never reads the lesson store directly. That keeps
runs reproducible — a run records its policy version, and replaying that version reproduces the run.

**The gate is the point.** `atlas/meta/evals.py` replays a frozen set of ZIP/expected-cell pairs under the
candidate policy. Promote only if the target metric improves **and** the guardrail does not regress. Otherwise
quarantine the lesson with the failing case attached. Borrowed wholesale from the fleet harness — the lesson
there was that a gate reachable only by `force` is not a gate.

---

## 5. Definition of done

1. `POST /api/search {zip}` returns a real table for a real CA ZIP, every cell carrying source + confidence,
   built from live S1–S7 — no fixtures on the critical path.
2. Sortable by distance, beds and fees; fee cells that are unknown say `unknown` and say why.
3. Management and ACO columns are populated from S3/S4 for facilities that have them, and visibly empty for
   those that do not.
4. A human can correct a cell in the UI; the correction persists as an event with a full audit trail.
5. Corrections induce lessons; lessons compile to `policy@vN+1`; the eval gate runs and **can refuse**.
   A refused promotion is demonstrable on demand.
6. A second run of the same ZIP after a promoted lesson produces a measurably better table, and the diff is
   inspectable.
7. Public GitHub repo + a live endpoint. The deterministic spine works on the live endpoint with **no API key**;
   agentic enrichment is bring-your-own-key and degrades to `unknown` without one.
8. `docs/REAL-VS-SIMULATED.md` answers "what's real here?" with a table rather than a hedge.

---

## 6. Non-goals

- No national ALF claim. No scraping of paid-referral directories to fake coverage.
- No composite "match score" — cohorts, not averages.
- No auth, no PII, no resident-level data of any kind. Facilities only.
- No auto-promotion of a lesson that fails the gate, for any reason, including "the demo needs it."
