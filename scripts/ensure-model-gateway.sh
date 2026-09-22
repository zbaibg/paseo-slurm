#!/usr/bin/env bash
# Start, stop, or check Eigenwise Model Gateway on the current compute node.
# This is the Paseo-script home for claude-code-proxy process environment.
# Do not run on the login node. paseo-compute.sbatch calls --ensure/--stop;
# SSH to the allocated node also works without resubmitting.
#
#   /home/zbai29/soft/paseo-slurm/scripts/ensure-model-gateway.sh --ensure
#   /home/zbai29/soft/paseo-slurm/scripts/ensure-model-gateway.sh --status
#   /home/zbai29/soft/paseo-slurm/scripts/ensure-model-gateway.sh --stop
#
# Never run model-gateway setup from here: that re-downloads the official
# linux tarball and overwrites the EL9-local claude-code-proxy binary.
set -euo pipefail

GW_JS="${MODEL_GATEWAY_JS:-${HOME}/.claude/plugins/cache/eigenwise-toolshed/model-gateway/0.51.2/bin/model-gateway.js}"
STATE="${MODEL_GATEWAY_STATE:-${HOME}/.claude/model-gateway}"

# Proxy-only environment. CCP_COMPACT_EFFORT has no config.json key.
# Default in claude-code-proxy is low; off keeps the session's effort on
# /compact and auto-compact. https://claude-code-proxy.raine.dev/reference/configuration/
export CCP_COMPACT_EFFORT="${CCP_COMPACT_EFFORT:-off}"

usage() {
  echo "usage: $0 [--ensure|--stop|--status]" >&2
  exit 2
}

mode="ensure"
if [[ $# -gt 1 ]]; then
  usage
fi
if [[ $# -eq 1 ]]; then
  case "$1" in
    --ensure|--stop|--status) mode="${1#--}" ;;
    *) usage ;;
  esac
fi

host="$(hostname -s)"
if [[ "${host}" == "kestrel" ]]; then
  echo "error: refused to ${mode} Model Gateway on login node ${host}" >&2
  exit 1
fi

export NVM_DIR="${HOME}/.nvm"
# shellcheck source=/dev/null
. "${NVM_DIR}/nvm.sh"
export PATH="${HOME}/.local/bin:${PATH}"
command -v node >/dev/null

if [[ ! -f "${GW_JS}" ]]; then
  echo "error: missing ${GW_JS}" >&2
  exit 1
fi

stop_recorded() {
  node "${GW_JS}" stop || true
  local pidfile pid
  for pidfile in "${STATE}/guardian.pid" "${STATE}/shim.pid" "${STATE}/proxy.pid"; do
    [[ -f "${pidfile}" ]] || continue
    pid="$(tr -d '[:space:]' < "${pidfile}" || true)"
    [[ -n "${pid}" ]] || continue
    kill "${pid}" 2>/dev/null || true
  done
}

case "${mode}" in
  ensure)
    node "${GW_JS}" ensure
    echo "CCP_COMPACT_EFFORT=${CCP_COMPACT_EFFORT}"
    ;;
  status)
    node "${GW_JS}" status
    ;;
  stop)
    stop_recorded
    ;;
esac
