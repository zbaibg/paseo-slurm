#!/usr/bin/env bash
# Install CLIProxyAPI, write its local config, and add the Paseo claudex
# provider. Codex OAuth for the proxy should be a separate device-code login,
# not a copy of ~/.codex/auth.json. Files live on NFS, so this may run on the
# login node. It does not start CLIProxyAPI or Paseo; paseo-compute.sbatch
# starts both on the compute node.
#
#   /home/zbai29/soft/paseo-slurm/scripts/archived/configure-claudex.sh
#   /home/zbai29/soft/paseo-slurm/scripts/archived/configure-claudex.sh --update
#
# After a Paseo config change on a live daemon:
#   ssh compute-0-44 'export NVM_DIR=$HOME/.nvm; . "$NVM_DIR/nvm.sh";
#     export PATH=$HOME/.local/bin:$PATH; paseo reload --json'
#
# Archived 2026-09-19: Human replaced this path with Eigenwise Model Gateway.
# Moved out of scripts/ into scripts/archived/. See
# ../ARCHIVED_CLIPROXYAPI_CLAUDEX.md. Refuses unless CLIPROXYAPI_ALLOW_ARCHIVED=1.
set -euo pipefail

if [[ "${CLIPROXYAPI_ALLOW_ARCHIVED:-}" != "1" ]]; then
  echo "error: CLIProxyAPI/claudex is archived; see /home/zbai29/soft/paseo-slurm/scripts/ARCHIVED_CLIPROXYAPI_CLAUDEX.md" >&2
  echo "error: set CLIPROXYAPI_ALLOW_ARCHIVED=1 only to recover the old path" >&2
  exit 1
fi

CLIPROXYAPI_ROOT="${CLIPROXYAPI_ROOT:-/home/zbai29/soft/cliproxyapi}"
PASEO_HOME="${PASEO_HOME:-${HOME}/.paseo}"
AUTH_DIR="${CLIPROXYAPI_AUTH_DIR:-${HOME}/.cli-proxy-api}"
CODEX_AUTH="${CODEX_AUTH:-${HOME}/.codex/auth.json}"
BIN_LINK="${CLIPROXYAPI_BIN_LINK:-${HOME}/.local/bin/cli-proxy-api}"
DOWNLOAD_DIR="${CLIPROXYAPI_DOWNLOAD_DIR:-/home/zbai29/soft/tmp}"
PORT="${CLIPROXYAPI_PORT:-8317}"
VERSION="${CLIPROXYAPI_VERSION:-7.3.9}"
UPDATE=0
REIMPORT_CODEX=0

usage() {
  cat <<'EOF'
Usage: configure-claudex.sh [--update] [--reimport-codex] [--version X.Y.Z]

Install or refresh CLIProxyAPI and the Paseo claudex provider.

  --update           Re-download the CLIProxyAPI binary even if it exists
  --reimport-codex   Fallback only: copy ~/.codex/auth.json into the proxy
                     auth-dir. Prefer a separate device-code login:
                       cli-proxy-api -codex-device-login -config $CLIPROXYAPI_ROOT/config.yaml
  --version X.Y.Z    Release to download (default: 7.3.9, or CLIPROXYAPI_VERSION)

Writes:
  $CLIPROXYAPI_ROOT/cli-proxy-api
  $CLIPROXYAPI_ROOT/config.yaml
  $CLIPROXYAPI_ROOT/api-key
  ~/.paseo/config.json  (agents.providers.claudex and claudex-272k)

Does not start the proxy or the Paseo daemon. Compute-node start is
the archived start script at $CLIPROXYAPI_ROOT/archived/start-cliproxyapi.sh.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --update) UPDATE=1; shift ;;
    --reimport-codex) REIMPORT_CODEX=1; shift ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v curl >/dev/null || ! command -v python3 >/dev/null; then
  echo "error: curl and python3 are required" >&2
  exit 1
fi

arch="$(uname -m)"
case "${arch}" in
  x86_64|amd64) asset_arch="amd64" ;;
  aarch64|arm64) asset_arch="aarch64" ;;
  *)
    echo "error: unsupported architecture ${arch}" >&2
    exit 1
    ;;
esac

mkdir -p "${CLIPROXYAPI_ROOT}/logs" "${CLIPROXYAPI_ROOT}/plugins" "${DOWNLOAD_DIR}" \
  "$(dirname "${BIN_LINK}")" "${AUTH_DIR}"
chmod 700 "${AUTH_DIR}"

bin="${CLIPROXYAPI_ROOT}/cli-proxy-api"
tarball="CLIProxyAPI_${VERSION}_linux_${asset_arch}.tar.gz"
tarball_path="${DOWNLOAD_DIR}/${tarball}"
release_url="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/${tarball}"

if [[ ! -x "${bin}" || "${UPDATE}" -eq 1 ]]; then
  echo "downloading CLIProxyAPI ${VERSION} (${asset_arch})"
  curl -fL --retry 3 --retry-delay 2 -o "${tarball_path}" "${release_url}"
  tar -xzf "${tarball_path}" -C "${CLIPROXYAPI_ROOT}" cli-proxy-api
  chmod 755 "${bin}"
fi
ln -sfn "${bin}" "${BIN_LINK}"
echo "cli-proxy-api=$("${bin}" --help 2>&1 | head -n 1)"

python3 - "${CLIPROXYAPI_ROOT}" "${AUTH_DIR}" "${CODEX_AUTH}" "${PASEO_HOME}" \
  "${PORT}" "${REIMPORT_CODEX}" <<'PY'
import json
import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path
import base64

root = Path(sys.argv[1])
auth_dir = Path(sys.argv[2])
codex_auth = Path(sys.argv[3])
paseo_home = Path(sys.argv[4])
port = int(sys.argv[5])
reimport = sys.argv[6] == "1"

key_path = root / "api-key"
config_path = root / "config.yaml"
paseo_config = paseo_home / "config.json"
imported = auth_dir / "codex-imported-chatgpt.json"

if key_path.is_file() and key_path.read_text().strip():
    api_key = key_path.read_text().strip()
else:
    api_key = "sk-" + secrets.token_hex(32)
    key_path.write_text(api_key + "\n")
key_path.chmod(0o600)

config = f"""# Local CLIProxyAPI for Paseo claudex. Bind loopback only on the compute node.
host: "127.0.0.1"
port: {port}
auth-dir: "{auth_dir}"
api-keys:
  - "{api_key}"
debug: false
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
logging-to-file: true
logs-max-total-size-mb: 50
usage-statistics-enabled: false
request-retry: 3
max-retry-interval: 30
ws-auth: true
streaming:
  keepalive-seconds: 15
  bootstrap-retries: 1
plugins:
  enabled: false
  dir: "{root / 'plugins'}"
discovery:
  enabled: false
"""
config_path.write_text(config)
config_path.chmod(0o600)

def jwt_claims(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))

have_codex = False
for path in auth_dir.glob("*.json"):
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        continue
    if isinstance(payload, dict) and payload.get("type") == "codex":
        have_codex = True
        break

if reimport:
    if not codex_auth.is_file():
        raise SystemExit(f"error: missing Codex auth {codex_auth}; run Codex login first")
    src = json.loads(codex_auth.read_text())
    tokens = src.get("tokens") or {}
    if not tokens.get("refresh_token"):
        raise SystemExit(f"error: {codex_auth} has no refresh_token")
    access_claims = jwt_claims(tokens["access_token"])
    id_claims = jwt_claims(tokens["id_token"])
    exp = access_claims.get("exp")
    expired = ""
    if isinstance(exp, (int, float)):
        expired = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
    record = {
        "type": "codex",
        "id_token": tokens["id_token"],
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "account_id": tokens.get("account_id") or "",
        "email": str(id_claims.get("email") or "imported"),
        "last_refresh": src.get("last_refresh")
        or datetime.now(timezone.utc).isoformat(),
        "expired": expired,
    }
    imported.write_text(json.dumps(record, indent=2) + "\n")
    imported.chmod(0o600)
    print(f"imported Codex OAuth into {imported} (shared token; prefer device login)")
elif have_codex:
    print(f"kept existing Codex auth in {auth_dir}")
else:
    print(
        "no Codex auth in the proxy auth-dir; run a separate device login:\n"
        f"  {root / 'cli-proxy-api'} -codex-device-login -config {root / 'config.yaml'}"
    )

if not paseo_config.is_file():
    raise SystemExit(f"error: missing Paseo config {paseo_config}")
data = json.loads(paseo_config.read_text())
# Paseo Claude effort IDs. GPT-6 Astra rejects reasoning.effort=none.
thinking_options = [
    {"id": "low", "label": "Low"},
    {"id": "medium", "label": "Medium", "isDefault": True},
    {"id": "high", "label": "High"},
    {"id": "xhigh", "label": "Extra high"},
    {"id": "max", "label": "Max"},
]
# Claude Code env is per Paseo provider, not per model. [1m] is the only
# per-model 1M switch; 272k needs CLAUDE_CODE_MAX_CONTEXT_TOKENS on a
# separate provider so it does not cap the 1M row.
astra_1m = "gpt-6-astra[1m]"
astra_272k = "gpt-6-astra"
other_1m = [
    {"id": "gpt-5.6-terra[1m]", "label": "GPT 5.6 Terra 1M", "thinkingOptions": thinking_options},
    {"id": "gpt-5.6-sol[1m]", "label": "GPT 5.6 Sol 1M", "thinkingOptions": thinking_options},
    {"id": "gpt-5.6-luna[1m]", "label": "GPT 5.6 Luna 1M", "thinkingOptions": thinking_options},
    {"id": "gpt-5.5[1m]", "label": "GPT 5.5 1M", "thinkingOptions": thinking_options},
]
other_272k = [
    {"id": "gpt-5.6-terra", "label": "GPT 5.6 Terra", "thinkingOptions": thinking_options},
    {"id": "gpt-5.6-sol", "label": "GPT 5.6 Sol", "thinkingOptions": thinking_options},
    {"id": "gpt-5.6-luna", "label": "GPT 5.6 Luna", "thinkingOptions": thinking_options},
    {"id": "gpt-5.5", "label": "GPT 5.5", "thinkingOptions": thinking_options},
]
shared_env = {
    "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
    "ANTHROPIC_AUTH_TOKEN": api_key,
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT": "1",
    "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY": "3",
    "ENABLE_TOOL_SEARCH": "false",
    "API_TIMEOUT_MS": "3000000",
}
providers = data.setdefault("agents", {}).setdefault("providers", {})
providers["claudex"] = {
    "extends": "claude",
    "label": "Claude + GPT 1M",
    "description": (
        "Claude Code through CLIProxyAPI on 127.0.0.1:"
        f"{port}. Every listed model uses a [1m] id; Claude Code is "
        "budgeted to 920k with compact at 880k (Eigenwise ChatGPT probe). "
        "Use provider claudex-272k for the Codex 272k window. "
        "WebSearch stays enabled so CLIProxyAPI can map it to Codex "
        "web_search; Paseo browser tools remain the fallback."
    ),
    "env": {
        **shared_env,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": astra_1m,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": astra_1m,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": astra_1m,
        "ANTHROPIC_MODEL": astra_1m,
        "CLAUDE_CODE_SUBAGENT_MODEL": astra_1m,
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "920000",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "880000",
    },
    "models": [
        {"id": astra_1m, "label": "GPT 6 Astra 1M", "isDefault": True, "thinkingOptions": thinking_options},
        *other_1m,
    ],
}
providers["claudex-272k"] = {
    "extends": "claude",
    "label": "Claude + GPT 272k",
    "description": (
        "Same CLIProxyAPI as claudex, with Claude Code budgeted to "
        "the Codex catalog default of 272k."
    ),
    "env": {
        **shared_env,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": astra_272k,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": astra_272k,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": astra_272k,
        "ANTHROPIC_MODEL": astra_272k,
        "CLAUDE_CODE_SUBAGENT_MODEL": astra_272k,
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "272000",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "272000",
    },
    "models": [
        {"id": astra_272k, "label": "GPT 6 Astra 272k", "isDefault": True, "thinkingOptions": thinking_options},
        *other_272k,
    ],
}
paseo_config.write_text(json.dumps(data, indent=2) + "\n")
paseo_config.chmod(0o600)
print(f"wrote {config_path}")
print(f"wrote {key_path} (not printed)")
print(f"updated {paseo_config} agents.providers.claudex and claudex-272k")
PY

if [[ ! -x "${CLIPROXYAPI_ROOT}/archived/start-cliproxyapi.sh" ]]; then
  echo "error: missing ${CLIPROXYAPI_ROOT}/archived/start-cliproxyapi.sh" >&2
  exit 1
fi

echo "cliproxyapi_root=${CLIPROXYAPI_ROOT}"
echo "paseo_config=${PASEO_HOME}/config.json"
echo "next: archived compute-node start is ${CLIPROXYAPI_ROOT}/archived/start-cliproxyapi.sh"
echo "next: live jobs no longer start CLIProxyAPI from scripts/paseo-compute.sbatch"
echo "next: if the daemon is already up, ssh to that node and run: paseo reload --json"
