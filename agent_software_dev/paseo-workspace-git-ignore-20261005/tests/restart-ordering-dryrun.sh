#!/usr/bin/env bash
# Dry-run cases for the config-write ordering of scripts/restart-paseo-worker.sh.
# Read-only for the live daemon: every case uses --dry-run --foreground; config.json and the
# worker pid are checked before and after. Server builds used:
#   installed  the globally installed (patched) @getpaseo/server
#   fresh      a copy of its dist written now, i.e. "installed after the running worker started"
#   old        the pre-patch browser-download build from the rollback tarball
# Usage: restart-ordering-dryrun.sh [ROLLBACK_SERVER_TGZ] [OUTPUT_DIR]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${ROOT}/scripts/restart-paseo-worker.sh"
OLD_TGZ="${1:-${HOME}/soft/paseo-rollback/v0.10.2-browser-download-20261005/getpaseo-server-0.10.2.tgz}"
OUT="${2:-$(dirname "${BASH_SOURCE[0]}")/output/restart-ordering}"
export PATH="${HOME}/.nvm/versions/node/v24.15.0/bin:${PATH}"
G="$(npm root -g)"
mkdir -p "${OUT}"
work="$(mktemp -d /var/tmp/restart-ordering-XXXXXX)"
trap 'rm -rf "${work}"' EXIT

link_deps() {
  ln -s "${G}/@getpaseo/server/node_modules" "$1/node_modules/@getpaseo/server/node_modules"
  ln -s "${G}/@getpaseo/protocol" "$1/node_modules/@getpaseo/protocol"
}
mkdir -p "${work}/fresh/node_modules/@getpaseo/server" "${work}/old/node_modules/@getpaseo"
cp -r "${G}/@getpaseo/server/dist" "${G}/@getpaseo/server/package.json" \
  "${work}/fresh/node_modules/@getpaseo/server/"
link_deps "${work}/fresh"
tar -xzf "${OLD_TGZ}" -C "${work}/old"
mv "${work}/old/package" "${work}/old/node_modules/@getpaseo/server"
link_deps "${work}/old"
installed="${G}/@getpaseo/server"
fresh="${work}/fresh/node_modules/@getpaseo/server"
old="${work}/old/node_modules/@getpaseo/server"

config_sum() { sha256sum "${HOME}/.paseo/config.json" | cut -d' ' -f1; }
worker() { pgrep -u "$(id -u)" -f "Paseo Daemon" | head -1; }
sum_before="$(config_sum)"
worker_before="$(worker)"
failures=0

run_case() {
  local name="$1" expect="$2" server="$3"
  shift 3
  local log="${OUT}/${name}.log"
  rm -f "${log}" "${log}.config-preview.json"
  "${SCRIPT}" --foreground --dry-run --log "${log}" --server-package "${server}" "$@" || true
  # The preview holds the whole config.json; it is not kept.
  rm -f "${log}.config-preview.json"
  if grep -qF -- "${expect}" "${log}"; then
    echo "PASS ${name}: ${expect}"
  else
    echo "FAIL ${name}: expected '${expect}'"
    sed 's/^/    /' "${log}"
    failures=$((failures + 1))
  fi
}

run_case current-worker-adds-key "plan: write restart" "${installed}" \
  --set-git-ignored-paths /tmp/paseo-ordering-test
run_case stale-worker-adds-key "plan: restart write restart" "${fresh}" \
  --set-git-ignored-paths /tmp/paseo-ordering-test
run_case old-server-rejects-current-config "ERROR config.json unchanged and no restart" "${old}"
run_case old-server-clear-git-keys "plan: write restart" "${old}" --clear-git-keys
run_case old-server-rejects-disable-git "Unrecognized key: \"enabled\"" "${old}" --disable-git

[[ "$(config_sum)" == "${sum_before}" ]] && echo "PASS config.json unchanged" \
  || { echo "FAIL config.json changed"; failures=$((failures + 1)); }
[[ "$(worker)" == "${worker_before}" ]] && echo "PASS worker ${worker_before} unchanged" \
  || { echo "FAIL worker changed"; failures=$((failures + 1)); }
echo "failures=${failures}"
exit "${failures}"
