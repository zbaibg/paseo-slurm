#!/usr/bin/env bash
# Local daemon restart is forbidden on this cluster.
# After install, start Paseo only by submitting the compute-node job.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="${SCRIPT_DIR}/paseo-compute.sbatch"

usage() {
  cat <<EOF
Usage: tmpdir_paseo_restart.sh

This helper no longer restarts Paseo on the login node.

After install, do not run:
  paseo daemon start
  paseo start
  paseo daemon restart

Start or reload the daemon by submitting:

  sbatch ${LAUNCH}

Cancel an existing paseo-daemon Slurm job first if one is still running.
The compute launch script sets TMPDIR=/home/zbai29/soft/tmp itself.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

echo "error: do not start or restart Paseo on the login node" >&2
echo "error: after install, submit the compute-node job:" >&2
echo "  sbatch ${LAUNCH}" >&2
exit 1
