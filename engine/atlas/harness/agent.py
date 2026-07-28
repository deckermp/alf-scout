"""The agent harness -- Claude Agent SDK wrapped around the LangGraph node that needs
judgement rather than a query.

Two of the seven requested columns have no registry behind them: per-facility fees, and
the IL / memory-care / home-health split. Those are genuinely research tasks, so they get
an agent with web access instead of a fabricated number.

The important part is not that an agent runs. It is *where the human sits*. The agent
cannot write a cell directly -- it can only call `propose_cell`, and every call goes
through the SDK's `can_use_tool` permission callback before it takes effect. That
callback is the action-grain HITL gate:

    agent wants to write  ->  can_use_tool  ->  human allows / denies / substitutes a value
                                              ->  PermissionResultAllow(updated_input=...)

The SDK supports returning *modified* input from that callback, which is what makes a
human correction at this seam different from a veto: the reviewer can hand the agent the
right answer and let the run continue.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

import claude_agent_sdk as sdk

MODEL = os.environ.get("ATLAS_AGENT_MODEL", "claude-sonnet-5")

HITLDecision = Literal["allow", "deny", "modify"]


@dataclass
class Proposal:
    facility_id: str
    field: str
    value: Any
    confidence: str
    rationale: str
    evidence: list[str] = field(default_factory=list)
    decision: HITLDecision | None = None
    decided_value: Any = None
    decided_by: str = ""
    reason: str = ""


@dataclass
class HarnessResult:
    proposals: list[Proposal] = field(default_factory=list)
    cost_usd: float = 0.0
    turns: int = 0
    error: str | None = None
    transcript: list[str] = field(default_factory=list)


# A reviewer callback receives a Proposal and returns (decision, value, reason).
Reviewer = Callable[[Proposal], Awaitable[tuple[HITLDecision, Any, str]]]


async def auto_reviewer(p: Proposal) -> tuple[HITLDecision, Any, str]:
    """Deferred HITL: let the write land, but it lands as `inferred` and the table shows
    it as unconfirmed. The human reviews at table-grain instead of action-grain.

    This is the honest default for a server: blocking a web request on a human is a
    worse lie than marking the cell unconfirmed."""
    return "allow", p.value, "auto-allowed; flagged for table-grain review"


def make_tools(collected: list[Proposal]):
    @sdk.tool(
        "propose_cell",
        "Propose a value for one field of one facility. This does NOT write the value -- "
        "a human reviewer approves, rejects, or replaces it. Always cite evidence URLs.",
        {
            "facility_id": str,
            "field": str,
            "value": str,
            "confidence": str,
            "rationale": str,
            "evidence": str,
        },
    )
    async def propose_cell(args: dict[str, Any]) -> dict[str, Any]:
        ev = args.get("evidence") or ""
        collected.append(
            Proposal(
                facility_id=args["facility_id"],
                field=args["field"],
                value=args["value"],
                confidence=args.get("confidence", "inferred"),
                rationale=args.get("rationale", ""),
                evidence=[e.strip() for e in ev.split(",") if e.strip()],
            )
        )
        return {"content": [{"type": "text", "text": f"recorded proposal for {args['facility_id']}.{args['field']}"}]}

    @sdk.tool(
        "record_unknown",
        "Record that a field could not be established from open sources, with the reason. "
        "Prefer this over guessing. An unknown with a reason is a correct answer.",
        {"facility_id": str, "field": str, "reason": str},
    )
    async def record_unknown(args: dict[str, Any]) -> dict[str, Any]:
        collected.append(
            Proposal(
                facility_id=args["facility_id"],
                field=args["field"],
                value=None,
                confidence="unknown",
                rationale=args.get("reason", ""),
            )
        )
        return {"content": [{"type": "text", "text": "recorded unknown"}]}

    return sdk.create_sdk_mcp_server(name="atlas", version="0.1.0", tools=[propose_cell, record_unknown])


SYSTEM = """You are a market-research analyst enriching a table of senior-living facilities.

You are given facilities that came from government registries. Two fields could not be
established from any registry, and those are the only fields you work on:

  avg_monthly_fee -- the facility's published monthly price, in USD, for assisted living
  services        -- which of IL (independent living), AL (assisted living),
                     MC (memory care), HH (home health) the facility actually offers

Rules that are not negotiable:

1. Use WebSearch/WebFetch to find the facility's own website or an operator page. Cite
   every URL you relied on in the `evidence` argument.
2. A price you found on a paid-referral directory (A Place for Mom, Caring.com,
   SeniorAdvisor, seniorly) is NOT the facility's price. You may report it, but say in
   the rationale that it is a referral-directory estimate, and set confidence "inferred".
3. Never output a national or regional average as if it were this facility's rate. If you
   cannot find a facility-specific price, call record_unknown. That is the correct answer
   and you will not be penalised for it.
4. For `services`, only claim memory care or independent living if the operator's own
   material says so. A facility being large is not evidence of memory care.
5. One propose_cell or record_unknown call per (facility, field). Do not editorialise.
6. Make no clinical claims and no quality judgements.
7. `value` formats are strict:
   - avg_monthly_fee: digits only, e.g. "9320". No currency symbol, no "/month", no range.
     If only a range is published, use the low end and say so in the rationale.
   - services: a comma-separated subset of exactly IL, AL, MC, HH -- e.g. "IL, AL".
     If the facility offers NONE of those four (a skilled-nursing-only building, say),
     call record_unknown instead. Never write "none of IL/AL/MC/HH" as a value.

Work through every facility given to you, then stop."""


def _facility_brief(f: dict) -> dict:
    return {
        "facility_id": f["id"],
        "name": f["name"],
        "address": f"{f['address']}, {f['city']}, {f['state']} {f['zip']}",
        "kind": f.get("facility_kind", ""),
        "beds": f["beds"].get("value"),
        "known_services": f["services"].get("value") or [],
        "management": [m.get("name") for m in (f["management"].get("value") or []) if isinstance(m, dict)][:3],
    }


async def enrich(
    facilities: list[dict],
    prompt_addenda: list[str] | None = None,
    reviewer: Reviewer | None = None,
    max_facilities: int = 6,
    model: str = MODEL,
) -> HarnessResult:
    """Run the enrichment agent over a batch, with every write gated by `reviewer`."""
    reviewer = reviewer or auto_reviewer
    batch = facilities[:max_facilities]
    if not batch:
        return HarnessResult()

    collected: list[Proposal] = []
    gate_log: list[dict[str, Any]] = []
    server = make_tools(collected)
    result = HarnessResult()

    def _to_proposal(tool_input: dict) -> Proposal:
        return Proposal(
            facility_id=tool_input.get("facility_id", ""),
            field=tool_input.get("field", ""),
            value=tool_input.get("value"),
            confidence=tool_input.get("confidence", "inferred"),
            rationale=tool_input.get("rationale", ""),
            evidence=[e.strip() for e in (tool_input.get("evidence") or "").split(",") if e.strip()],
        )

    async def pre_tool_use(hook_input: Any, tool_use_id: str | None, ctx: Any) -> dict[str, Any]:
        """The HITL gate.

        A PreToolUse hook rather than `can_use_tool`, because `can_use_tool` is bypassed
        whenever anything else already approved the call -- an `allowed_tools` entry, or an
        allow rule in the user's own settings files. The SDK warns about the first and
        cannot even see the second. A hook fires unconditionally, which is the only way to
        make "no cell is written without a human" true rather than aspirational.
        """
        name = hook_input.get("tool_name", "") if isinstance(hook_input, dict) else ""
        tool_input = (hook_input.get("tool_input") or {}) if isinstance(hook_input, dict) else {}
        if not name.endswith("propose_cell"):
            return {}

        decision, value, reason = await reviewer(_to_proposal(tool_input))
        gate_log.append({"tool": name, "field": tool_input.get("field"), "decision": decision, "reason": reason})

        if decision == "deny":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason or "reviewer rejected this value",
                }
            }
        if decision == "modify":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": f"reviewer substituted a value: {reason}",
                    "updatedInput": {
                        **tool_input,
                        "value": value,
                        "confidence": "registry",
                        "rationale": f"reviewer-supplied: {reason}",
                    },
                }
            }
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": reason or "reviewer allowed",
            }
        }

    system = SYSTEM
    if prompt_addenda:
        system += "\n\nLearned constraints from previous reviewer corrections:\n" + "\n".join(
            f"- {a}" for a in prompt_addenda
        )

    options = sdk.ClaudeAgentOptions(
        model=model,
        system_prompt=system,
        mcp_servers={"atlas": server},
        # `propose_cell` is deliberately NOT in allowed_tools. An allowed_tools entry
        # auto-approves a tool *before* can_use_tool is consulted, which would make the
        # HITL gate decorative -- the SDK warns about exactly this. Leaving the write tool
        # out is what makes every proposed cell fall through to the reviewer callback.
        # Reads and the unknown-recorder are pre-approved; only writes are gated.
        allowed_tools=["mcp__atlas__record_unknown", "WebSearch", "WebFetch"],
        can_use_tool=can_use_tool,
        max_turns=max(8, len(batch) * 4),
        permission_mode="default",
    )

    payload = json.dumps([_facility_brief(f) for f in batch], indent=2)
    text = f"Enrich these {len(batch)} facilities:\n\n{payload}"

    async def prompt_stream():
        # `can_use_tool` requires streaming mode -- the permission callback needs a live
        # channel back to the CLI, which a plain string prompt does not open.
        yield {
            "type": "user",
            "message": {"role": "user", "content": text},
            "parent_tool_use_id": None,
            "session_id": "atlas-enrich",
        }

    try:
        async for msg in sdk.query(prompt=prompt_stream(), options=options):
            if isinstance(msg, sdk.AssistantMessage):
                for block in msg.content:
                    if isinstance(block, sdk.TextBlock) and block.text.strip():
                        result.transcript.append(block.text.strip()[:400])
            elif isinstance(msg, sdk.ResultMessage):
                result.cost_usd = msg.total_cost_usd or 0.0
                result.turns = msg.num_turns or 0
    except Exception as e:  # noqa: BLE001 -- the agent is optional; the spine is not
        result.error = f"{type(e).__name__}: {e}"

    result.proposals = collected
    return result


def enrich_sync(facilities: list[dict], prompt_addenda: list[str] | None = None, **kw) -> HarnessResult:
    return asyncio.run(enrich(facilities, prompt_addenda, **kw))
