#!/usr/bin/env bash
# Restart the Paseo daemon with TMPDIR on durable scratch, not /tmp.
# The companion patches do not bake in this machine-local default.
set -euo pipefail

TMPDIR_PASEO="${1:-${PASEO_TMPDIR:-/home/zbai29/soft/tmp}}"

usage() {
  cat <<'EOF'
Usage: tmpdir_paseo_restart.sh [DIR]

Restart `paseo daemon` with TMPDIR (and TMP/TEMP) set to DIR.
Default: /home/zbai29/soft/tmp

This kills running agents. The companion patches do not include TMPDIR;
set it at restart time instead of patching Paseo source.

  PASEO_TMPDIR   override default directory when no argument is given
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v paseo >/dev/null 2>&1; then
  echo "error: paseo not on PATH" >&2
  exit 1
fi

mkdir -p "${TMPDIR_PASEO}"
export TMPDIR="${TMPDIR_PASEO}"
export TMP="${TMPDIR_PASEO}"
export TEMP="${TMPDIR_PASEO}"

echo "TMPDIR=${TMPDIR}"
echo "paseo=$(command -v paseo)"
echo "Restarting daemon (this stops running agents)..."
paseo daemon restart
echo "OK  daemon restarted with TMPDIR=${TMPDIR}"
