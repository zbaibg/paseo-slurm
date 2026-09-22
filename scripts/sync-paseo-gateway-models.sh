#!/usr/bin/env bash
# Copy Model Gateway Codex rows into Paseo claude additionalModels.
# Paseo does not read the gateway discovery cache; this list is curated.
#
#   /home/zbai29/soft/paseo-slurm/scripts/sync-paseo-gateway-models.sh
#   /home/zbai29/soft/paseo-slurm/scripts/sync-paseo-gateway-models.sh --reload
#
# Reads ~/.claude/cache/gateway-models.json (written by Model Gateway ensure).
# Writes only agents.providers.claude.additionalModels. Does not set models
# (that would replace the first-party Claude list) and does not set
# ANTHROPIC_BASE_URL (that would shadow Model Gateway).
#
# After a plugin/proxy catalog change, run ensure on the compute node, then
# this script. Do not run model-gateway setup; it overwrites the EL9-local
# claude-code-proxy binary.
set -euo pipefail

PASEO_HOME="${PASEO_HOME:-${HOME}/.paseo}"
CACHE="${GATEWAY_MODELS_CACHE:-${HOME}/.claude/cache/gateway-models.json}"
CATALOG="${GATEWAY_CATALOG:-${HOME}/.claude/model-gateway/catalog.json}"
RELOAD_HOST="${PASEO_RELOAD_HOST:-compute-0-44}"
INCLUDE_GROK=0
RELOAD=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: sync-paseo-gateway-models.sh [--reload] [--include-grok] [--dry-run]

  --reload         paseo reload --json on the compute-node daemon
  --include-grok   also append claude-grok-* rows (needs a Grok login)
  --dry-run        print the ids that would be written

Source: ~/.claude/cache/gateway-models.json, else ~/.claude/model-gateway/catalog.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --reload) RELOAD=1; shift ;;
    --include-grok) INCLUDE_GROK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

python3 - "$PASEO_HOME/config.json" "$CACHE" "$CATALOG" "$INCLUDE_GROK" "$DRY_RUN" <<'PY'
import json
import re
import sys
from pathlib import Path

paseo_path = Path(sys.argv[1])
cache_path = Path(sys.argv[2])
catalog_path = Path(sys.argv[3])
include_grok = sys.argv[4] == "1"
dry_run = sys.argv[5] == "1"

THINKING = [
    {"id": "low", "label": "Low"},
    {"id": "medium", "label": "Medium", "isDefault": True},
    {"id": "high", "label": "High"},
    {"id": "xhigh", "label": "Extra high"},
    {"id": "max", "label": "Max"},
]


def load_rows():
    if cache_path.is_file():
        payload = json.loads(cache_path.read_text())
        return payload.get("models") or [], cache_path
    if catalog_path.is_file():
        payload = json.loads(catalog_path.read_text())
        return payload.get("models") or [], catalog_path
    raise SystemExit(
        f"error: no gateway model list at {cache_path} or {catalog_path}; "
        "run model-gateway ensure on the compute node, not setup"
    )


def keep(model_id: str) -> bool:
    if model_id.startswith("claude-gpt-"):
        return True
    return include_grok and model_id.startswith("claude-grok-")


def label_for(model: dict) -> str:
    raw = model.get("display_name") or model.get("label") or model["id"]
    raw = re.sub(r"\s*\(Codex\)\s*$", "", raw).strip()
    raw = raw.replace("-", " ")
    return raw


def sort_key(model_id: str):
    body = model_id.removeprefix("claude-").removesuffix("[1m]")
    if body.startswith("grok-"):
        return (9, 0, 0, body)
    match = re.match(r"gpt-(\d+)(?:\.(\d+))?", body)
    if match:
        major = int(match.group(1))
        minor = int(match.group(2) or 0)
        return (0 if major >= 6 else 1, -major, -minor, body)
    return (2, 0, 0, body)


rows, source = load_rows()
selected = []
seen = set()
for model in rows:
    model_id = model.get("id")
    if not isinstance(model_id, str) or not keep(model_id) or model_id in seen:
        continue
    seen.add(model_id)
    selected.append({"id": model_id, "label": label_for(model), "thinkingOptions": THINKING})
selected.sort(key=lambda item: sort_key(item["id"]))
if not selected:
    raise SystemExit(f"error: {source} had no claude-gpt-* rows")

ids = [item["id"] for item in selected]
if dry_run:
    print(f"source={source}")
    print(f"n={len(ids)}")
    print("\n".join(ids))
    raise SystemExit(0)

if not paseo_path.is_file():
    raise SystemExit(f"error: missing {paseo_path}")
data = json.loads(paseo_path.read_text())
claude = data.setdefault("agents", {}).setdefault("providers", {}).setdefault("claude", {})
claude.pop("models", None)
env = claude.get("env")
if isinstance(env, dict):
    env.pop("ANTHROPIC_BASE_URL", None)
    if not env:
        claude.pop("env", None)
claude["enabled"] = True
claude["additionalModels"] = selected
paseo_path.write_text(json.dumps(data, indent=2) + "\n")
print(f"source={source}")
print(f"wrote {paseo_path} agents.providers.claude.additionalModels n={len(ids)}")
print("\n".join(ids))
PY

if [[ "${RELOAD}" -eq 1 ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=8 "${RELOAD_HOST}" 'bash --noprofile --norc -lc "
    export NVM_DIR=\$HOME/.nvm
    . \"\$NVM_DIR/nvm.sh\"
    export PATH=\$HOME/.local/bin:\$PATH
    paseo reload --json
  "'
fi
