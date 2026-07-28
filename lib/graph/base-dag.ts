/**
 * The default (non-developer-editable-in-code) DAG. This is the seed spec —
 * everything a human can change later (add/disable nodes, edit instructions,
 * reweight scoring) happens via DagPatch objects folded on top of this by
 * `compileDag` in ./compile.ts. Nobody should need to touch this file after
 * launch; it exists to give the meta-learner a version-1 baseline to patch.
 */
import type { DagSpec } from "@/lib/contract";

export const BASE_DAG: DagSpec = {
  version: 1,
  nodes: [
    {
      id: "discover",
      label: "Discover facilities",
      after: [],
      instruction:
        "Find all assisted living facilities in the given zip code; return name + street address for each.",
      enabled: true,
      origin: "base",
    },
    {
      id: "enrich_management",
      label: "Enrich: management",
      after: ["discover"],
      instruction: "Identify the operator/management company for each facility.",
      enabled: true,
      origin: "base",
    },
    {
      id: "enrich_aco",
      label: "Enrich: ACO partners",
      after: ["discover"],
      instruction:
        "Identify Accountable Care Organizations (ACOs) that partner with each facility.",
      enabled: true,
      origin: "base",
    },
    {
      id: "enrich_services",
      label: "Enrich: services",
      after: ["discover"],
      instruction:
        "Classify which of IL, AL, MemoryCare, HomeHealth, SNF, Respite each facility offers, plus licensed bed count and average monthly fee.",
      enabled: true,
      origin: "base",
    },
    {
      id: "score",
      label: "Score",
      after: ["enrich_management", "enrich_aco", "enrich_services"],
      instruction: "Compute a composite score for each facility from the configured weights.",
      enabled: true,
      origin: "base",
    },
    {
      id: "rank",
      label: "Rank",
      after: ["score"],
      instruction: "Sort facilities descending by score.",
      enabled: true,
      origin: "base",
    },
  ],
  weights: {
    distance: 0.25,
    beds: 0.2,
    fee: 0.25,
    services: 0.15,
    aco: 0.15,
  },
};
