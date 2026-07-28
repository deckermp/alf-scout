"""End-to-end demonstration of the closed loop, against live registries.

    run -> pause for review -> reviewer verdicts -> induce lesson -> eval gate -> re-run

Run it with a clean store to see the whole arc:

    uv run python scripts/demo_loop.py --reset
"""

from __future__ import annotations

import argparse
import json
import sys

from atlas.meta import evals, induce, store
from atlas.meta.compiler import active_policy
from atlas.pipeline import resume, search

ZIP, RADIUS = "94550", 4.0


def rule(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def show_acos(result, label: str) -> None:
    print(f"\n  {label}: {len(result.facilities)} facilities, policy {result.policy_version}")
    any_ = False
    for f in result.facilities:
        for a in f.acos.value or []:
            any_ = True
            flag = "EXACT" if a.get("exact_legal_entity") else "fuzzy"
            print(f"    {a['match_score']:.3f} [{flag:5}] {f.name[:34]:<34} -> {a['aco_name'][:40]}")
            print(f"            via {a['match_basis']} '{a['matched_on']}'")
    if not any_:
        print("    (no ACO links proposed)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="clear lessons, verdicts and overrides first")
    args = ap.parse_args()

    if args.reset:
        with store.conn() as c:
            for t in ("lessons", "verdicts", "overrides", "promotions"):
                c.execute(f"DELETE FROM {t}")
        print("store reset: lessons, verdicts, overrides, promotions cleared")

    rule("1. BASELINE RUN -- live CMS + CA licensing, no lessons applied")
    p0 = active_policy()
    print(f"  policy {p0.version}  threshold={p0.aco_match_threshold}  lessons={len(p0.lesson_ids)}")
    before, interrupt_payload, cfg = search(ZIP, radius_mi=RADIUS, review=True)
    show_acos(before, "BEFORE")

    rule("2. HITL -- the graph is paused at interrupt(); a reviewer looks at the proposals")
    print(f"  interrupt kind : {interrupt_payload['kind']}")
    print(f"  rows           : {interrupt_payload['rows']}")
    print(f"  flagged cells  : {len(interrupt_payload['needs_attention'])}")

    verdicts = []
    for f in before.facilities:
        if not f.acos.value:
            continue
        if "NEW HAVEN" in f.name.upper():
            verdicts.append(
                {
                    "facility_id": f.id,
                    "field": "acos",
                    "action": "reject",
                    "after": [a["aco_id"] for a in f.acos.value],
                    "note": "Licensee is SOLETA HOLDINGS, INC. The matched affiliate is VIOLET HOLDINGS, LLC. "
                    "Different companies -- the shared token 'holdings' inflated the score.",
                    "reviewer": "decker",
                }
            )
        else:
            verdicts.append(
                {
                    "facility_id": f.id,
                    "field": "acos",
                    "action": "confirm",
                    "note": "legal_business_name matches the CMS affiliate file verbatim",
                    "reviewer": "decker",
                }
            )
    for v in verdicts:
        print(f"  {v['action'].upper():8} {v['facility_id']}  {v['note'][:64]}")

    after_review = resume(cfg, verdicts)
    print(f"\n  resumed; verdicts recorded: {len(verdicts)}")

    rule("3. INDUCE -- corrections become a typed, compilable lesson")
    created = induce.induce_deterministic()
    if not created:
        print("  no lesson induced (nothing generalised)")
    for lid in created:
        L = next(x for x in store.lessons() if x["lesson_id"] == lid)
        print(f"  {lid}  kind={L['kind']}  node={L['node']}  status={L['status']}")
        print(f"    payload   : {json.dumps(L['payload'])}")
        print(f"    rationale : {L['rationale']}")

    rule("4. GATE -- shadow-replay the frozen set: candidate vs active. The gate may refuse.")
    report = evals.run_gate()
    print(f"  DECISION: {report['decision'].upper()}")
    for r in report["reasons"]:
        print(f"    - {r}")
    if "baseline" in report:
        b, c = report["baseline"], report["candidate"]
        print(f"\n  {'metric':<22} {'active':>12} {'candidate':>12}")
        for k in ("aco_precision", "aco_recall", "aco_true_positives", "aco_false_positives", "beds_coverage", "rows_total"):
            print(f"  {k:<22} {b[k]:>12} {c[k]:>12}")

    rule("5. RE-RUN -- same ZIP, evolved pipeline")
    p1 = active_policy()
    print(f"  policy {p0.version} -> {p1.version}  threshold {p0.aco_match_threshold} -> {p1.aco_match_threshold}")
    after, _, _ = search(ZIP, radius_mi=RADIUS)
    show_acos(after, "AFTER")

    rule("6. THE GATE CAN REFUSE -- propose a lesson that buys precision by losing recall")
    bad = store.add_lesson(
        kind="threshold",
        node="join_aco",
        payload={"aco_min_key_tokens": 5, "aco_min_key_chars": 40},
        rationale="Adversarial control: demanding 5+ tokens or a 40-character name would suppress "
        "every remaining false positive -- and also discards 'vineyards healthcare center' and "
        "'1527 springs road', both confirmed true affiliations. Precision bought with recall.",
        evidence=["adversarial-control"],
    )
    print(f"  proposed {bad}: aco_min_key_tokens = 5, aco_min_key_chars = 40")
    bad_report = evals.run_gate()
    print(f"  DECISION: {bad_report['decision'].upper()}")
    for r in bad_report["reasons"]:
        print(f"    - {r}")
    if "candidate" in bad_report:
        b, c = bad_report["baseline"], bad_report["candidate"]
        print(f"    recall {b['aco_recall']} -> {c['aco_recall']}, true positives {b['aco_true_positives']} -> {c['aco_true_positives']}")
    print(f"  lesson status now: {next(x['status'] for x in store.lessons() if x['lesson_id'] == bad)}")
    print(f"  active policy unchanged: {active_policy().version == p1.version}")

    rule("RESULT")
    fp_before = sum(1 for f in before.facilities if "NEW HAVEN" in f.name.upper() and f.acos.value)
    fp_after = sum(1 for f in after.facilities if "NEW HAVEN" in f.name.upper() and f.acos.value)
    tp_before = sum(1 for f in before.facilities if "VINEYARDS" in f.name.upper() and f.acos.value)
    tp_after = sum(1 for f in after.facilities if "VINEYARDS" in f.name.upper() and f.acos.value)
    print(f"  false positives (NEW HAVEN x VIOLET HOLDINGS) : {fp_before} -> {fp_after}")
    print(f"  true positives  (VINEYARDS x Stanford ACO)    : {tp_before} -> {tp_after}")
    print(f"  human corrections preserved as overrides       : {len(store.overrides_for([f.id for f in after.facilities]))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
