FROM python:3.12-slim

# Node + the Claude Code CLI: the Agent SDK drives the CLI, so agentic enrichment is only
# genuinely available (bring-your-own-key) if the binary is present. Without a key the
# server still serves the full deterministic spine and marks agentic cells unknown.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @anthropic-ai/claude-code \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock README.md ./
COPY atlas ./atlas
RUN uv sync --frozen --no-dev

COPY ui ./ui
COPY evals ./evals
COPY scripts ./scripts

# Warm the two large registry pulls into the image so the first request is not a
# 2.4 MB download. Both are public and keyless; a build without network still succeeds.
ENV ATLAS_DATA_DIR=/app/data
RUN uv run python -c "\
from atlas.sources.states.ca import _by_zip; \
from atlas.sources.aco import _affiliates; \
from atlas.sources.geo import _load_zips; \
print('ca rcfe zips', len(_by_zip()), 'aco affiliates', len(_affiliates()), 'zctas', len(_load_zips()))" \
 || echo "cache warm skipped (no network at build time)"

EXPOSE 8000
CMD ["sh", "-c", "uv run uvicorn atlas.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
