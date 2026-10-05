#!/usr/bin/env bash
# Restart the Paseo daemon *worker* under its running supervisor, detached from the caller,
# and confirm the replacement by process table and /api/health instead of an RPC.
#
# `paseo daemon restart` confirms the new worker with daemon.get_status requests that time out
# after 1 s each. get_status awaits every provider's availability probe (about 2 s here), so the
# CLI never sees the new worker and keeps polling until its --timeout (default 600 s). This
# script still uses that CLI to send the restart, bounded by `timeout`, and ignores its exit.
#
# Run on the daemon host. The worker restart interrupts every agent turn, including the one that
# launched this script; the script detaches and waits --delay seconds first.
set -euo pipefail

HOME_DIR="${HOME}/.paseo"
DELAY=20
DRY_RUN=0
FOREGROUND=0
IGNORED_PATHS=""
LOG=""

usage() {
  cat <<'EOF'
Usage: restart-paseo-worker.sh [--home DIR] [--delay SEC] [--set-git-ignored-paths P1[:P2...]]
                               [--log FILE] [--dry-run] [--foreground]

  --set-git-ignored-paths  Write daemon.git.ignoredPaths into config.json right before the
                           restart. Refused unless the installed server has the
                           workspace-git-ignore patch (an unpatched worker rejects the key).
  --dry-run                Check host, supervisor, worker and dist; write the edited config to
                           <log>.config-preview.json; do not restart.
  --foreground             Do not detach (the caller must survive the worker restart).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    --set-git-ignored-paths) IGNORED_PATHS="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

LOG="${LOG:-${HOME}/soft/paseo-rollback/restart-worker-$(date +%Y%m%d-%H%M%S).log}"
mkdir -p "$(dirname "${LOG}")"

if [[ "${FOREGROUND}" -eq 0 && -z "${PASEO_RESTART_WORKER_DETACHED:-}" ]]; then
  args=(--home "${HOME_DIR}" --delay "${DELAY}" --log "${LOG}")
  [[ -n "${IGNORED_PATHS}" ]] && args+=(--set-git-ignored-paths "${IGNORED_PATHS}")
  [[ "${DRY_RUN}" -eq 1 ]] && args+=(--dry-run)
  PASEO_RESTART_WORKER_DETACHED=1 setsid nohup "$0" "${args[@]}" </dev/null >/dev/null 2>&1 &
  echo "detached pid=$! log=${LOG}"
  exit 0
fi

exec >>"${LOG}" 2>&1
export PATH="${HOME}/.nvm/versions/node/v24.15.0/bin:${HOME}/.local/bin:${PATH}"
say() { echo "== $(date -Is) $*"; }

say "start dry_run=${DRY_RUN} home=${HOME_DIR} delay=${DELAY}s"
[[ "${DRY_RUN}" -eq 1 ]] || sleep "${DELAY}"

read -r sup sup_host < <(python3 - "${HOME_DIR}/paseo.pid" <<'PY'
import json, sys
info = json.load(open(sys.argv[1]))
print(info["pid"], info.get("hostname", ""))
PY
)
here="$(hostname)"
if [[ "${sup_host%%.*}" != "${here%%.*}" ]]; then
  say "ERROR supervisor ${sup} runs on ${sup_host}, not ${here}; run this on the daemon host"
  exit 1
fi
worker_pid() { pgrep -P "${sup}" -f "Paseo Daemon" | head -1 || true; }
old="$(worker_pid)"
say "supervisor=${sup} worker=${old:-none}"
[[ -n "${old}" ]] || { say "ERROR no worker under supervisor ${sup}"; exit 1; }

if [[ -n "${IGNORED_PATHS}" ]]; then
  dist="$(npm root -g)/@getpaseo/server/dist/server/utils/run-git-command.js"
  if ! grep -q isGitIgnoredPath "${dist}"; then
    say "ERROR ${dist} lacks the workspace-git-ignore patch; install first, config left unchanged"
    exit 1
  fi
  target="${HOME_DIR}/config.json"
  [[ "${DRY_RUN}" -eq 1 ]] && target="${LOG}.config-preview.json"
  python3 - "${HOME_DIR}/config.json" "${target}" "${IGNORED_PATHS}" <<'PY'
import json, os, sys, tempfile
source, target, paths = sys.argv[1], sys.argv[2], [p for p in sys.argv[3].split(":") if p]
config = json.load(open(source))
config.setdefault("daemon", {}).setdefault("git", {})["ignoredPaths"] = paths
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(target)), prefix=".config.json.")
with os.fdopen(fd, "w") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, target)
print(f"daemon.git.ignoredPaths={paths} -> {target}")
PY
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  curl -sf --max-time 2 http://127.0.0.1:6767/api/health >/dev/null && say "health ok" || say "health FAILED"
  say "dry run done"
  exit 0
fi

say "sending restart"
timeout 90 paseo daemon restart --home "${HOME_DIR}" --timeout 60 || say "restart CLI exit $? (expected while get_status exceeds 1 s)"

new=""
for i in $(seq 1 300); do
  new="$(worker_pid)"
  if [[ -n "${new}" && "${new}" != "${old}" ]] \
    && curl -sf --max-time 2 http://127.0.0.1:6767/api/health >/dev/null; then
    say "new worker ${new} healthy after ${i}s"
    break
  fi
  new=""
  sleep 1
done
[[ -n "${new}" ]] || { say "ERROR no healthy replacement worker after 300 s"; exit 1; }

# Re-send callbacks that failed while the worker was down. Both are idempotent and never
# resubmit jobs or rerun commands.
paseo-local recover || say "paseo-local recover exit $?"
paseo-slurm recover || say "paseo-slurm recover exit $?"
say "done"
