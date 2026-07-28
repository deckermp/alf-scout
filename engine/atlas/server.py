"""HTTP surface.

The deterministic spine needs no credentials, so the live endpoint is genuinely live: it
queries CMS and the CA licensing registry on request. Agentic enrichment is
bring-your-own-key and degrades to `unknown` cells with reasons when no key is present --
never to a plausible-looking number.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi import Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import pipeline
from .meta import evals, induce, store
from .meta.compiler import active_policy, candidate_policy
from .schema import Verdict
from .sources import states as state_registry

UI_DIR = Path(__file__).resolve().parents[1] / "ui"

app = FastAPI(title="ALF Atlas", version="0.1.0")

# thread configs for paused graphs, so a review can be resumed by run_id
_THREADS: dict[str, dict] = {}


def agentic_available() -> bool:
    """An API key, or a locally authenticated Claude Code CLI (which the SDK drives)."""
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return True
    return shutil.which("claude") is not None


class SearchReq(BaseModel):
    zip: str = Field(min_length=5, max_length=10)
    radius_mi: float = Field(default=5.0, ge=0.5, le=50.0)
    agentic: bool = False
    review: bool = True


class VerdictsReq(BaseModel):
    run_id: str
    verdicts: list[dict[str, Any]]


@app.get("/api/health")
def health() -> dict:
    p = active_policy()
    return {
        "ok": True,
        "policy_version": p.version,
        "aco_match_threshold": p.aco_match_threshold,
        "lessons_active": len(p.lesson_ids),
        "states_with_alf_connector": state_registry.supported(),
        "agentic_available": agentic_available(),
    }


@app.post("/api/search")
def api_search(req: SearchReq) -> dict:
    if req.agentic and not agentic_available():
        raise HTTPException(400, "agentic enrichment requires ANTHROPIC_API_KEY on the server")
    try:
        result, interrupt_payload, cfg = pipeline.search(
            req.zip, radius_mi=req.radius_mi, agentic=req.agentic, review=req.review
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"upstream registry error: {type(e).__name__}: {e}") from e
    _THREADS[result.run_id] = cfg
    return {"result": result.model_dump(), "interrupt": interrupt_payload, "paused": interrupt_payload is not None}


@app.post("/api/verdicts")
def api_verdicts(req: VerdictsReq) -> dict:
    cfg = _THREADS.get(req.run_id)
    if cfg:
        result = pipeline.resume(cfg, req.verdicts)
        _THREADS.pop(req.run_id, None)
        return {"result": result.model_dump(), "resumed": True, "recorded": len(req.verdicts)}
    # Graph already finished (or this process did not run it) -- record the verdicts
    # anyway so the meta-learning loop still receives the evidence.
    store.add_verdicts([Verdict(run_id=req.run_id, **v) for v in req.verdicts])
    return {"resumed": False, "recorded": len(req.verdicts)}


@app.get("/api/runs")
def api_runs(limit: int = 30) -> list[dict]:
    return store.list_runs(limit)


@app.get("/api/run/{run_id}")
def api_run(run_id: str) -> dict:
    r = store.get_run(run_id)
    if not r:
        raise HTTPException(404, "unknown run")
    return r


CSV_COLUMNS = [
    "name", "address", "city", "state", "zip", "distance_mi", "beds", "bed_basis",
    "management", "services", "acos", "avg_monthly_fee", "facility_kind",
    "cms_ccn", "license_id", "cms_overall_rating", "score",
]


def _cell(v: Any) -> tuple[str, str]:
    """A Sourced cell -> (value, provenance). Unknown keeps its reason rather than
    flattening to an empty string -- the reason is the point."""
    if not isinstance(v, dict) or "value" not in v:
        return ("" if v is None else str(v), "")
    val = v.get("value")
    conf = v.get("confidence")
    conf = getattr(conf, "value", conf) or ""
    prov = f"{conf}:{v.get('source') or ''}".strip(":")
    if val is None:
        return ("", f"unknown — {v.get('note') or 'not found'}")
    if isinstance(val, list):
        val = "; ".join(x.get("name", str(x)) if isinstance(x, dict) else str(x) for x in val)
    if v.get("human_verified"):
        prov += " (human-verified)"
    return (str(val), prov)


@app.get("/api/run/{run_id}/csv")
def api_run_csv(run_id: str) -> Any:
    """The table as CSV, one provenance column per data column.

    Provenance travels with the data on purpose. A spreadsheet that has been stripped of
    where each number came from is exactly how an inferred cell gets quoted as a fact.
    """
    import csv
    import io

    r = store.get_run(run_id)
    if not r:
        raise HTTPException(404, "unknown run")
    payload = r.get("payload")
    if isinstance(payload, str):
        import json as _json

        payload = _json.loads(payload)
    facilities = (payload or {}).get("facilities") or []

    buf = io.StringIO()
    w = csv.writer(buf)
    header: list[str] = []
    for c in CSV_COLUMNS:
        header.append(c)
        header.append(f"{c}__source")
    w.writerow(header)
    for f in facilities:
        row: list[str] = []
        for c in CSV_COLUMNS:
            val, prov = _cell(f.get(c))
            row.extend([val, prov])
        w.writerow(row)

    zipcode = (payload or {}).get("zip") or "run"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="alf-atlas-{zipcode}-{run_id}.csv"'},
    )


@app.get("/api/policy")
def api_policy() -> dict:
    active = active_policy()
    cand, proposed = candidate_policy()
    return {
        "active": active.model_dump(),
        "candidate": cand.model_dump(),
        "proposed_lesson_ids": proposed,
        "differs": cand.version != active.version,
    }


@app.get("/api/lessons")
def api_lessons(status: str | None = None) -> list[dict]:
    return store.lessons(status)


@app.get("/api/verdicts")
def api_all_verdicts(limit: int = 200) -> list[dict]:
    return store.all_verdicts(limit)


@app.post("/api/induce")
def api_induce(use_agent: bool = False) -> dict:
    if use_agent:
        if not agentic_available():
            raise HTTPException(400, "agent induction requires ANTHROPIC_API_KEY on the server")
        return induce.induce_with_agent_sync()
    created = induce.induce_deterministic()
    return {"created": created, "lessons": [x for x in store.lessons() if x["lesson_id"] in created]}


@app.post("/api/gate")
def api_gate() -> dict:
    """Run the eval gate. Note there is no `force` parameter, by design."""
    return evals.run_gate()


@app.get("/api/promotions")
def api_promotions(limit: int = 20) -> list[dict]:
    return store.promotions(limit)


@app.get("/api/frozen-set")
def api_frozen_set() -> dict:
    return evals.load_cases()


@app.get("/")
def index() -> Any:
    idx = UI_DIR / "index.html"
    if not idx.exists():
        return JSONResponse({"error": "ui not built"}, status_code=404)
    return FileResponse(idx)


if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")
