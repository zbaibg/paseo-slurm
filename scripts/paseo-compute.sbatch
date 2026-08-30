#!/usr/bin/env bash
#SBATCH --job-name=paseo-daemon
#SBATCH --partition=batch
#SBATCH --exclude=compute-0-[0-35]
#SBATCH --nodelist=compute-0-40
#SBATCH --nodes=1
#SBATCH --ntasks=8
#SBATCH --cpus-per-task=1
#SBATCH --mem-per-cpu=4000M
#SBATCH --output=/home/zbai29/.paseo/slurm-paseo-%j.out
#SBATCH --error=/home/zbai29/.paseo/slurm-paseo-%j.err

# Submit from the login node after install. Do not start the daemon locally:
#   sbatch /home/zbai29/soft/paseo-slurm/scripts/paseo-compute.sbatch
# One Paseo daemon on the Human-fixed host compute-0-40. Same ~/.paseo on NFS;
# do not start a second daemon on kestrel. After the daemon is healthy,
# reattach watching paseo-slurm groups on this node so resume talks to this
# daemon.

set -euo pipefail

if [[ -z "${SLURM_JOB_ID:-}" ]]; then
  echo "error: submit with sbatch; do not run this script on the login node" >&2
  echo "error: after install, never start Paseo locally (paseo daemon start/restart)" >&2
  exit 1
fi

host="$(hostname -s)"
if [[ "${host}" == "kestrel" ]]; then
  echo "error: refused to start Paseo on login node ${host}" >&2
  exit 1
fi

export NVM_DIR="${HOME}/.nvm"
# shellcheck source=/dev/null
. "${NVM_DIR}/nvm.sh"
command -v node >/dev/null
command -v paseo >/dev/null
command -v paseo-slurm >/dev/null

export TMPDIR="${PASEO_TMPDIR:-/home/zbai29/soft/tmp}"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
mkdir -p "${TMPDIR}"

status_json="$(paseo daemon status --json)"
local_daemon="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("localDaemon") or "")' <<<"${status_json}")"
if [[ "${local_daemon}" != "stopped" && -n "${local_daemon}" ]]; then
  echo "error: a Paseo daemon is already ${local_daemon}; stop it before this job" >&2
  echo "${status_json}" >&2
  exit 1
fi

echo "host=${host} job=${SLURM_JOB_ID} ntasks=${SLURM_NTASKS} node=${SLURM_JOB_NODELIST}"
echo "paseo=$(command -v paseo) paseo-slurm=$(command -v paseo-slurm) node=$(command -v node)"
echo "TMPDIR=${TMPDIR}"
paseo --version || true

paseo daemon start \
  --foreground \
  --listen 127.0.0.1:6767 \
  --relay \
  --home "${HOME}/.paseo" &
daemon_pid=$!

cleanup() {
  kill "${daemon_pid}" 2>/dev/null || true
  wait "${daemon_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "${daemon_pid}" 2>/dev/null; then
    echo "error: Paseo daemon exited before becoming healthy" >&2
    wait "${daemon_pid}" || true
    exit 1
  fi
  if curl -sf --max-time 2 "http://127.0.0.1:6767/api/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "${ready}" -ne 1 ]]; then
  echo "error: Paseo daemon did not become healthy on 127.0.0.1:6767" >&2
  exit 1
fi
paseo daemon status --json

mapfile -t watching_groups < <(python3 - <<'PY'
import json
from pathlib import Path
root = Path.home() / ".local/state/paseo-slurm/groups"
if not root.is_dir():
    raise SystemExit(0)
for path in sorted(root.glob("*.json")):
    group = json.loads(path.read_text())
    if group.get("status") == "watching":
        print(group["id"])
PY
)
for group_id in "${watching_groups[@]+"${watching_groups[@]}"}"; do
  echo "reattach paseo-slurm group ${group_id}"
  paseo-slurm group wait "${group_id}"
done

echo "paseo daemon pid=${daemon_pid} watching_groups=${#watching_groups[@]}"
wait "${daemon_pid}"
trap - EXIT INT TERM
