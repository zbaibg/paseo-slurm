#!/usr/bin/env bash
# Apply the optional Paseo external-wait companion patches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMBINED="${ROOT}/patches/paseo/external-wait-finish-deferral.patch"
SYSTEM_SEND="${ROOT}/patches/paseo/system-send.patch"

usage() {
  cat <<'EOF'
Usage: apply-paseo-external-wait.sh <paseo-source-checkout>

Applies patches/paseo/external-wait-finish-deferral.patch (finish deferral
plus `paseo send --system`) with `git apply -p1`.

If the tree already has finish deferral but not `--system`, applies the
incremental patches/paseo/system-send.patch instead.

Exits 0 with ALREADY_APPLIED when both features are present.
Does not build packages or restart the daemon.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

PASEO_SRC="$(cd "$1" && pwd)"

if [[ ! -f "${COMBINED}" ]]; then
  echo "error: missing patch file: ${COMBINED}" >&2
  exit 1
fi

if [[ ! -f "${PASEO_SRC}/packages/server/src/server/agent/agent-prompt.ts" ]]; then
  echo "error: not a Paseo source tree: ${PASEO_SRC}" >&2
  exit 1
fi

has_marker() {
  local file="$1"
  local pattern="$2"
  if command -v rg >/dev/null 2>&1; then
    rg -q -- "${pattern}" "${file}"
  else
    grep -q -- "${pattern}" "${file}"
  fi
}

PROMPT_FILE="${PASEO_SRC}/packages/server/src/server/agent/agent-prompt.ts"
SEND_FILE="${PASEO_SRC}/packages/cli/src/commands/agent/send.ts"

has_deferral=false
has_system=false
if has_marker "${PROMPT_FILE}" 'getExternalWaitIdFromLabels'; then
  has_deferral=true
fi
if [[ -f "${SEND_FILE}" ]] && grep -Fq '.option("--system"' "${SEND_FILE}"; then
  has_system=true
fi

if [[ "${has_deferral}" == true && "${has_system}" == true ]]; then
  echo "ALREADY_APPLIED ${PASEO_SRC}"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required to apply the patch" >&2
  exit 1
fi

apply_patch() {
  local patch="$1"
  git -C "${PASEO_SRC}" apply "${patch}"
  echo "APPLIED ${patch} -> ${PASEO_SRC}"
}

if [[ "${has_deferral}" == true && "${has_system}" == false ]]; then
  if [[ ! -f "${SYSTEM_SEND}" ]]; then
    echo "error: missing incremental patch file: ${SYSTEM_SEND}" >&2
    exit 1
  fi
  if git -C "${PASEO_SRC}" apply --check "${SYSTEM_SEND}"; then
    apply_patch "${SYSTEM_SEND}"
    echo "Next: build @getpaseo/protocol, @getpaseo/client, @getpaseo/server, and @getpaseo/cli, then restart the daemon."
    exit 0
  fi
  echo "error: incremental system-send patch does not apply cleanly to ${PASEO_SRC}" >&2
  git -C "${PASEO_SRC}" apply --check "${SYSTEM_SEND}" 2>&1 || true
  exit 1
fi

if git -C "${PASEO_SRC}" apply --check "${COMBINED}"; then
  apply_patch "${COMBINED}"
  echo "Next: build @getpaseo/protocol, @getpaseo/client, @getpaseo/server, and @getpaseo/cli, then restart the daemon."
  exit 0
fi

echo "error: patch does not apply cleanly to ${PASEO_SRC}" >&2
echo "Re-generate against your Paseo revision or wait for upstream #3011." >&2
git -C "${PASEO_SRC}" apply --check "${COMBINED}" 2>&1 || true
exit 1
