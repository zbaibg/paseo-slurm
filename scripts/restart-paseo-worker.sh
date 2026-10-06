#!/usr/bin/env bash
# Restart the Paseo daemon *worker* under its running supervisor, detached from the caller,
# and confirm the replacement by process table and /api/health instead of an RPC.
#
# `paseo daemon restart` confirms the new worker with daemon.get_status requests that time out
# after 1 s each. get_status awaits every provider's availability probe (about 2 s here), so the
# CLI never sees the new worker and keeps polling until its --timeout. This script sends the
# restart with that CLI in the background and confirms the new worker itself. If the old worker
# does not go away (for example it cannot accept connections), the script SIGKILLs the old
# worker's process tree: the supervisor (scripts/supervisor.ts) respawns a worker that exits
# with a non-zero code or a signal other than SIGTERM, which is also how it ends a worker that
# ignores a graceful restart. SIGTERM to the worker, or any signal to the supervisor, stops Paseo.
#
# Config edits follow one rule: a key is never in config.json while a worker that rejects it is
# running. Every worker re-reads config.json with a strict schema for each new connection
# (Session construction), so an unknown key makes it refuse all clients ("Invalid hello").
#   - The edited config is first validated with the installed server's own loader; if that
#     fails, nothing is written and nothing restarts.
#   - Removing keys is written before the restart (every build accepts a missing key).
#   - Adding keys is written before the restart only if the running worker started after the
#     installed server was written; otherwise: restart, write, restart again.
#
# Run on the daemon host. The restart interrupts every agent turn, including the one that
# launched this script; the script detaches and waits --delay seconds first.
set -euo pipefail

HOME_DIR="${HOME}/.paseo"
DELAY=20
DRY_RUN=0
FOREGROUND=0
IGNORED_PATHS=""
DISABLE_GIT=0
RESET_THROTTLE=0
CLEAR_GIT_KEYS=0
SERVER_PKG=""
LOG=""

usage() {
  cat <<'EOF'
Usage: restart-paseo-worker.sh [--home DIR] [--delay SEC] [--disable-git]
                               [--set-git-ignored-paths P1[:P2...]] [--reset-git-throttle]
                               [--clear-git-keys] [--server-package DIR]
                               [--log FILE] [--dry-run] [--foreground]

  --disable-git            Set daemon.git.enabled=false: the daemon starts no git or forge CLI.
  --set-git-ignored-paths  Set daemon.git.ignoredPaths.
                           Both need a server with the workspace-git-ignore patch.
  --reset-git-throttle     Remove daemon.git.maxProcessesPerSecond and maxProcessConcurrency
                           (defaults 64 and 8).
  --clear-git-keys         Remove daemon.git.enabled and daemon.git.ignoredPaths (use before or
                           after rolling back to a server without the patch).
  --server-package DIR     Server package used for validation and the age check
                           (default: $(npm root -g)/@getpaseo/server).
  --dry-run                Validate, print the plan, write the edited config to
                           <log>.config-preview.json; do not change config.json or restart.
  --foreground             Do not detach (the caller must survive the worker restart).
Config edits are atomic (temporary file + rename) and leave the file at mode 600.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    --set-git-ignored-paths) IGNORED_PATHS="$2"; shift 2 ;;
    --disable-git) DISABLE_GIT=1; shift ;;
    --reset-git-throttle) RESET_THROTTLE=1; shift ;;
    --clear-git-keys) CLEAR_GIT_KEYS=1; shift ;;
    --server-package) SERVER_PKG="$2"; shift 2 ;;
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
  [[ "${DISABLE_GIT}" -eq 1 ]] && args+=(--disable-git)
  [[ "${RESET_THROTTLE}" -eq 1 ]] && args+=(--reset-git-throttle)
  [[ "${CLEAR_GIT_KEYS}" -eq 1 ]] && args+=(--clear-git-keys)
  [[ -n "${SERVER_PKG}" ]] && args+=(--server-package "${SERVER_PKG}")
  [[ "${DRY_RUN}" -eq 1 ]] && args+=(--dry-run)
  PASEO_RESTART_WORKER_DETACHED=1 setsid nohup "$0" "${args[@]}" </dev/null >/dev/null 2>&1 &
  echo "detached pid=$! log=${LOG}"
  exit 0
fi

exec >>"${LOG}" 2>&1
export PATH="${HOME}/.nvm/versions/node/v24.15.0/bin:${HOME}/.local/bin:${PATH}"
SERVER_PKG="${SERVER_PKG:-$(npm root -g)/@getpaseo/server}"
CONFIG="${HOME_DIR}/config.json"
HEALTH_URL="http://127.0.0.1:6767/api/health"
say() { echo "== $(date -Is) $*"; }

say "start dry_run=${DRY_RUN} home=${HOME_DIR} delay=${DELAY}s server=${SERVER_PKG}"
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
healthy() { curl -sf --max-time 2 "${HEALTH_URL}" >/dev/null; }
old="$(worker_pid)"
[[ -n "${old}" ]] || { say "ERROR no worker under supervisor ${sup}"; exit 1; }

# The running worker loaded the installed server only if it started after that was written.
loader="${SERVER_PKG}/dist/server/server/persisted-config.js"
[[ -f "${loader}" ]] || { say "ERROR ${loader} not found"; exit 1; }
worker_started="$(date -d "$(ps -o lstart= -p "${old}")" +%s)"
server_written="$(stat -c %Z "${loader}")"
worker_current=0
[[ "${worker_started}" -ge "${server_written}" ]] && worker_current=1
say "supervisor=${sup} worker=${old} started=$(date -d "@${worker_started}" -Is)" \
  "installed_server=$(date -d "@${server_written}" -Is) worker_runs_installed_server=${worker_current}"

# Build the edited config in a private temporary file.
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
candidate="${work}/config.json"
python3 - "${CONFIG}" "${candidate}" "${IGNORED_PATHS}" "${DISABLE_GIT}" "${RESET_THROTTLE}" \
  "${CLEAR_GIT_KEYS}" <<'PY'
import json, os, sys
source, target, paths, disable, reset, clear = sys.argv[1:7]
config = json.load(open(source))
git = config.setdefault("daemon", {}).setdefault("git", {})
if clear == "1":
    git.pop("enabled", None)
    git.pop("ignoredPaths", None)
if paths:
    git["ignoredPaths"] = [p for p in paths.split(":") if p]
if disable == "1":
    git["enabled"] = False
if reset == "1":
    git.pop("maxProcessesPerSecond", None)
    git.pop("maxProcessConcurrency", None)
with open(target, "w") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
os.chmod(target, 0o600)
print(f"edited daemon.git={json.dumps(git)}")
PY

# Validate with the installed server's strict loader: the next worker reads exactly this.
cat >"${work}/validate.mjs" <<'JS'
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const [pkg, file] = process.argv.slice(2);
const { loadPersistedConfig } = await import(path.join(pkg, "dist/server/server/persisted-config.js"));
const home = mkdtempSync(path.join(tmpdir(), "paseo-config-check-"));
try {
  copyFileSync(file, path.join(home, "config.json"));
  chmodSync(path.join(home, "config.json"), 0o600);
  loadPersistedConfig(home);
  console.log("installed server accepts the config");
} catch (error) {
  console.log(`installed server rejects the config: ${String(error?.message ?? error).split("\n").slice(0, 3).join(" | ")}`);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
JS
if ! node "${work}/validate.mjs" "${SERVER_PKG}" "${candidate}"; then
  say "ERROR config.json unchanged and no restart: the next worker would not start with this config"
  [[ "${CLEAR_GIT_KEYS}" -eq 1 ]] || say "hint: after rolling back to a server without the patch, add --clear-git-keys"
  exit 1
fi

adds=0
[[ -n "${IGNORED_PATHS}" || "${DISABLE_GIT}" -eq 1 ]] && adds=1
if cmp -s "${CONFIG}" "${candidate}" \
  || python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1])) != json.load(open(sys.argv[2])))' \
    "${CONFIG}" "${candidate}"; then
  plan="restart"
elif [[ "${adds}" -eq 0 || "${worker_current}" -eq 1 ]]; then
  plan="write restart"
else
  plan="restart write restart"
fi
say "plan: ${plan}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  cp "${candidate}" "${LOG}.config-preview.json"
  chmod 600 "${LOG}.config-preview.json"
  healthy && say "health ok" || say "health FAILED"
  say "dry run done (preview ${LOG}.config-preview.json)"
  exit 0
fi

write_config() {
  local tmp
  tmp="$(mktemp "${HOME_DIR}/.config.json.XXXXXX")"
  cp "${candidate}" "${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${CONFIG}"
  say "config.json written: $(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["daemon"].get("git", {})))' "${CONFIG}")"
}

kill_tree() {
  local pid="$1" child
  for child in $(ps -o pid= --ppid "${pid}" 2>/dev/null); do
    kill_tree "${child}"
  done
  kill -KILL "${pid}" 2>/dev/null || true
}

wait_new_worker() {
  local before="$1" seconds="$2" i candidate_pid
  for ((i = 1; i <= seconds; i++)); do
    candidate_pid="$(worker_pid)"
    if [[ -n "${candidate_pid}" && "${candidate_pid}" != "${before}" ]] && healthy; then
      echo "${candidate_pid}"
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_worker() {
  local before cli new_pid
  before="$(worker_pid)"
  say "sending restart to worker ${before}"
  timeout 90 paseo daemon restart --home "${HOME_DIR}" --timeout 60 &
  cli=$!
  if new_pid="$(wait_new_worker "${before}" 30)"; then
    kill "${cli}" 2>/dev/null || true
  else
    kill "${cli}" 2>/dev/null || true
    if kill -0 "${before}" 2>/dev/null; then
      say "worker ${before} still running 30 s after the restart request; SIGKILL its process tree" \
        "so the supervisor respawns it"
      kill_tree "${before}"
    fi
    new_pid="$(wait_new_worker "${before}" 120)" || {
      say "ERROR no healthy replacement worker; supervisor alive: $(kill -0 "${sup}" 2>/dev/null && echo yes || echo no)"
      exit 1
    }
  fi
  say "new worker ${new_pid} healthy"
  current_worker="${new_pid}"
}

current_worker="${old}"
for step in ${plan}; do
  case "${step}" in
    write) write_config ;;
    restart) restart_worker ;;
  esac
done

expected=""
if [[ "${DISABLE_GIT}" -eq 1 ]]; then
  expected="Daemon git integration is disabled"
elif [[ -n "${IGNORED_PATHS}" ]]; then
  expected="Git workspace integration disabled for ignored paths"
fi
if [[ -n "${expected}" ]]; then
  for ((i = 1; i <= 60; i++)); do
    if tail -n 20000 "${HOME_DIR}/daemon.log" | grep -F "\"pid\":${current_worker}," \
      | grep -qF "${expected}"; then
      say "worker ${current_worker} logged: ${expected}"
      break
    fi
    sleep 1
  done
  [[ "${i}" -le 60 ]] || { say "ERROR worker ${current_worker} did not log '${expected}' within 60 s"; exit 1; }
fi

# Re-send callbacks that failed while the worker was down. Both are idempotent and never
# resubmit jobs or rerun commands.
paseo-local recover || say "paseo-local recover exit $?"
paseo-slurm recover || say "paseo-slurm recover exit $?"
say "done"
