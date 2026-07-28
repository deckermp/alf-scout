"""Verdicts -> proposed lessons.

Two induction paths, and the split is deliberate.

`induce_deterministic` handles the patterns that are arithmetic rather than judgement: a
reviewer rejected a match that scored 0.867, so a threshold above 0.867 would have
prevented it. No model is needed to see that, and using one would make a reproducible
inference unreproducible.

`induce_with_agent` handles the rest -- generalising several corrections into a naming
rule, spotting that a whole class of facility is mis-typed, writing a constraint for the
enrichment agent's own prompt. That is genuinely inductive and is where a model earns its
place.

Neither path can ship anything. Both write lessons as `proposed`; only the gate promotes.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import claude_agent_sdk as sdk

from ..sources.aco import normalize
from . import store
from .compiler import active_policy


def _loads(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return v
    return v


def induce_deterministic(verdicts: list[dict] | None = None) -> list[str]:
    """Arithmetic induction. Reproducible, explainable, no model in the loop."""
    rows = verdicts if verdicts is not None else store.unconsumed_verdicts()
    if not rows:
        return []

    policy = active_policy()
    created: list[str] = []
    consumed: list[int] = []

    rejected_scores: list[float] = []
    rejected_lbns: list[str] = []
    confirmed_scores: list[float] = []

    for r in rows:
        if r["field"] != "acos":
            continue
        before = _loads(r["before"]) or []
        after = _loads(r["after"]) or []
        if r["action"] == "reject" and isinstance(before, list):
            killed = [a for a in before if a.get("aco_id") in set(after or [])] or before
            for a in killed:
                if isinstance(a, dict) and a.get("match_score") is not None:
                    rejected_scores.append(float(a["match_score"]))
                    rejected_lbns.append(a.get("matched_on", ""))
            consumed.append(r["id"])
        elif r["action"] == "confirm" and isinstance(before, list):
            for a in before:
                if isinstance(a, dict) and a.get("match_score") is not None:
                    confirmed_scores.append(float(a["match_score"]))
            consumed.append(r["id"])

    if rejected_scores:
        worst = max(rejected_scores)
        floor = min(confirmed_scores) if confirmed_scores else 1.0
        # Only propose a threshold move if it can separate the two populations. If a
        # confirmed match scores at or below a rejected one, no threshold can fix it and
        # saying so is more useful than proposing a number that will fail the gate.
        if worst < floor:
            new_t = round(min(0.99, worst + 0.005), 3)
            if new_t > policy.aco_match_threshold:
                created.append(
                    store.add_lesson(
                        kind="threshold",
                        node="join_aco",
                        payload={"aco_match_threshold": new_t},
                        rationale=(
                            f"Reviewer rejected {len(rejected_scores)} ACO match(es), the highest scoring "
                            f"{worst:.3f}. Lowest confirmed match scores {floor:.3f}. A threshold of {new_t} "
                            "separates the two populations on the evidence seen so far."
                        ),
                        evidence=rejected_lbns,
                    )
                )
        else:
            names = sorted({normalize(n) for n in rejected_lbns if n})
            if names:
                created.append(
                    store.add_lesson(
                        kind="blocklist",
                        node="join_aco",
                        payload={"names": names},
                        rationale=(
                            f"Rejected matches score up to {worst:.3f} while a confirmed match scores {floor:.3f}, "
                            "so no threshold separates them. Blocking the specific affiliate names instead -- "
                            "narrower, and it does not cost recall elsewhere."
                        ),
                        evidence=rejected_lbns,
                    )
                )

    store.mark_consumed(consumed)
    return created


INDUCE_SYSTEM = """You turn a reviewer's corrections to a facility table into typed, compilable lessons.

You are NOT fixing the table. You are proposing changes to the PIPELINE so the same class
of error does not recur on the next ZIP code.

Lesson kinds and their exact payload shapes:

  alias       {"from": "<normalized facility name>", "to": "<affiliate legal business name>"}
              Use when a reviewer confirmed a match the matcher scored too low to find.
  threshold   {"aco_match_threshold": 0.90} | {"aco_min_key_tokens": 2} | {"aco_min_key_chars": 12}
  blocklist   {"names": ["<normalized affiliate name>", ...]}
  rule        {"id":"<slug>","when":{"field":"facility_type","op":"contains","value":"X"},
               "add":["MC"],"basis":"<why>","confidence":"derived"}
  source_pref {"field":"beds","order":["S1","S2"]}
  prompt      {"text":"<one constraint sentence appended to the enrichment agent's system prompt>"}

Hard rules:
1. Propose a lesson only where the evidence supports GENERALISING. One correction to one
   facility is an override, not a lesson. Two or more corrections sharing a cause is a lesson.
2. Never propose a threshold that would discard a match the reviewer CONFIRMED. Check the
   confirmed scores you are given.
3. Prefer the narrowest lesson that covers the evidence. A blocklist of two names beats a
   threshold move that costs recall everywhere.
4. If the corrections do not generalise, call no tools and say so. Proposing nothing is a
   valid and often correct outcome.
5. Every lesson needs a rationale a reviewer could disagree with -- state the mechanism,
   not "improves accuracy"."""


def _tool(collected: list[dict]):
    @sdk.tool(
        "propose_lesson",
        "Propose one compilable lesson. payload_json must match the shape for the kind exactly.",
        {"kind": str, "node": str, "payload_json": str, "rationale": str},
    )
    async def propose_lesson(args: dict[str, Any]) -> dict[str, Any]:
        try:
            payload = json.loads(args["payload_json"])
        except json.JSONDecodeError as e:
            return {"content": [{"type": "text", "text": f"rejected: payload_json is not valid JSON ({e})"}]}
        collected.append(
            {"kind": args["kind"], "node": args["node"], "payload": payload, "rationale": args.get("rationale", "")}
        )
        return {"content": [{"type": "text", "text": f"accepted {args['kind']} lesson"}]}

    return sdk.create_sdk_mcp_server(name="induct", version="0.1.0", tools=[propose_lesson])


async def induce_with_agent(verdicts: list[dict] | None = None, model: str = "claude-sonnet-5") -> dict[str, Any]:
    rows = verdicts if verdicts is not None else store.unconsumed_verdicts()
    if not rows:
        return {"created": [], "note": "no unconsumed verdicts", "cost_usd": 0.0}

    policy = active_policy()
    brief = {
        "current_policy": {
            "aco_match_threshold": policy.aco_match_threshold,
            "aco_min_key_tokens": policy.aco_min_key_tokens,
            "aco_min_key_chars": policy.aco_min_key_chars,
            "aco_aliases": policy.aco_aliases,
            "aco_blocklist": policy.aco_blocklist,
            "service_rule_ids": [r.get("id") for r in policy.service_rules],
        },
        "verdicts": [
            {
                "facility_id": r["facility_id"],
                "field": r["field"],
                "action": r["action"],
                "before": _loads(r["before"]),
                "after": _loads(r["after"]),
                "note": r["note"],
            }
            for r in rows
        ],
    }

    collected: list[dict] = []
    options = sdk.ClaudeAgentOptions(
        model=model,
        system_prompt=INDUCE_SYSTEM,
        mcp_servers={"induct": _tool(collected)},
        allowed_tools=["mcp__induct__propose_lesson"],
        max_turns=6,
        permission_mode="default",
    )

    cost, transcript = 0.0, []
    try:
        async for msg in sdk.query(
            prompt=f"Reviewer corrections and current policy:\n\n{json.dumps(brief, indent=2, default=str)}",
            options=options,
        ):
            if isinstance(msg, sdk.AssistantMessage):
                for b in msg.content:
                    if isinstance(b, sdk.TextBlock) and b.text.strip():
                        transcript.append(b.text.strip()[:500])
            elif isinstance(msg, sdk.ResultMessage):
                cost = msg.total_cost_usd or 0.0
    except Exception as e:  # noqa: BLE001
        return {"created": [], "error": f"{type(e).__name__}: {e}", "cost_usd": cost}

    created = [
        store.add_lesson(
            kind=c["kind"],
            node=c["node"],
            payload=c["payload"],
            rationale=c["rationale"],
            evidence=[r["facility_id"] for r in rows],
        )
        for c in collected
    ]
    store.mark_consumed([r["id"] for r in rows])
    return {"created": created, "proposals": collected, "cost_usd": cost, "transcript": transcript}


def induce_with_agent_sync(**kw) -> dict[str, Any]:
    return asyncio.run(induce_with_agent(**kw))
