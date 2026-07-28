"""Disk cache + HTTP.

Public registries are slow and large. We cache to disk with a TTL so a demo does not
hammer CMS, and so a run is reproducible for a while. Cached payloads are raw
upstream bytes -- we never cache anything we have already interpreted.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

DATA_DIR = Path(os.environ.get("ATLAS_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
CACHE_DIR = DATA_DIR / "cache"
DEFAULT_TTL = int(os.environ.get("ATLAS_CACHE_TTL", 60 * 60 * 24 * 7))  # 7 days

_UA = {"User-Agent": "alf-atlas/0.1 (public-registry research tool)"}


def _key(url: str, params: dict | None) -> Path:
    h = hashlib.sha256(f"{url}?{json.dumps(params or {}, sort_keys=True)}".encode()).hexdigest()[:24]
    return CACHE_DIR / f"{h}.json"


def get_json(url: str, params: dict | None = None, ttl: int = DEFAULT_TTL, timeout: float = 60.0) -> Any:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _key(url, params)
    if path.exists() and (time.time() - path.stat().st_mtime) < ttl:
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            path.unlink(missing_ok=True)
    r = httpx.get(url, params=params, timeout=timeout, follow_redirects=True, headers=_UA)
    r.raise_for_status()
    data = r.json()
    path.write_text(json.dumps(data))
    return data


def get_text(url: str, ttl: int = DEFAULT_TTL, timeout: float = 180.0) -> str:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _key(url, None).with_suffix(".txt")
    if path.exists() and (time.time() - path.stat().st_mtime) < ttl:
        return path.read_text(encoding="utf-8", errors="replace")
    with httpx.stream("GET", url, timeout=timeout, follow_redirects=True, headers=_UA) as r:
        r.raise_for_status()
        body = b"".join(r.iter_bytes())
    text = body.decode("utf-8", errors="replace")
    path.write_text(text, encoding="utf-8")
    return text


def get_bytes(url: str, ttl: int = DEFAULT_TTL, timeout: float = 180.0) -> bytes:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _key(url, None).with_suffix(".bin")
    if path.exists() and (time.time() - path.stat().st_mtime) < ttl:
        return path.read_bytes()
    with httpx.stream("GET", url, timeout=timeout, follow_redirects=True, headers=_UA) as r:
        r.raise_for_status()
        body = b"".join(r.iter_bytes())
    path.write_bytes(body)
    return body
