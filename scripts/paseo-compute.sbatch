#!/usr/bin/env bash
#SBATCH --job-name=paseo-daemon
#SBATCH --partition=batch
#SBATCH --exclude=compute-0-[0-35]
#SBATCH --nodelist=compute-0-41
#SBATCH --nodes=1
#SBATCH --exclusive
#SBATCH --ntasks=8
#SBATCH --cpus-per-task=1
#SBATCH --mem-per-cpu=4000M
#SBATCH --output=/home/zbai29/.paseo/slurm-paseo-%j.out
#SBATCH --error=/home/zbai29/.paseo/slurm-paseo-%j.err

# Submit from the login node after install. Do not start the daemon locally:
#   sbatch /home/zbai29/soft/paseo-slurm/scripts/paseo-compute.sbatch
# One Paseo daemon on the Human-fixed host compute-0-41. Same ~/.paseo on NFS;
# do not start a second daemon on kestrel. This script clears a leftover
# ~/.paseo/paseo.pid and any previous-job worker still bound to 127.0.0.1:6767
# on this node. After the daemon is healthy,
# reattach watching paseo-slurm groups and retry completed paseo-local callbacks
# on this node so resume talks to this daemon.

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
command -v paseo-local >/dev/null

export TMPDIR="${PASEO_TMPDIR:-/home/zbai29/soft/tmp}"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
mkdir -p "${TMPDIR}"

# Previous paseo-daemon jobs share ~/.paseo on NFS. scancel leaves a pid file
# and sometimes a still-bound 127.0.0.1:6767 worker. Clear those leftovers on
# this node before starting; do not signal a PID that belongs to another host.
python3 - "${HOME}/.paseo/paseo.pid" <<'PY'
import json
import os
import signal
import sys
import time
from pathlib import Path

pid_path = Path(sys.argv[1])
port = 6767
uid = os.getuid()
here = os.uname().nodename
here_short = here.split(".")[0]


def host_matches(recorded: str) -> bool:
    recorded = (recorded or "").strip()
    if not recorded:
        return False
    return recorded in {here, here_short} or recorded.split(".")[0] == here_short


def cmdline(pid: int) -> bytes:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return b""


def comm(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text(errors="replace").strip()
    except OSError:
        return ""


def is_our_process(pid: int) -> bool:
    try:
        return Path(f"/proc/{pid}").stat().st_uid == uid
    except OSError:
        return False


def is_leftover_daemon(pid: int) -> bool:
    if not is_our_process(pid):
        return False
    name = comm(pid).lower()
    # /proc/pid/comm is 16 bytes, so "Paseo Supervisor" is truncated.
    if name.startswith("paseo daemon") or name.startswith("paseo superv"):
        return True
    cmd = cmdline(pid).replace(b"\x00", b" ").decode("utf-8", "replace").lower()
    if "paseo-slurm" in cmd or "paseo-local" in cmd or "_watch_group" in cmd:
        return False
    return "paseo daemon" in cmd or "@getpaseo/server" in cmd or "supervisor-entrypoint" in cmd


def pids_listening_on_local_port(listen_port: int) -> set[int]:
    hex_port = f"{listen_port:04X}"
    inodes: set[str] = set()
    for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        if not table.is_file():
            continue
        for line in table.read_text().splitlines()[1:]:
            parts = line.split()
            if len(parts) < 10:
                continue
            local = parts[1]
            state = parts[3]
            inode = parts[9]
            if state != "0A" or inode == "0":
                continue
            addr, _, port_hex = local.rpartition(":")
            if port_hex.upper() != hex_port:
                continue
            if addr.upper() not in {"0100007F", "00000000", "00000000000000000000000001000000"}:
                continue
            inodes.add(inode)
    found: set[int] = set()
    for fd_dir in Path("/proc").glob("*/fd"):
        try:
            pid = int(fd_dir.parent.name)
        except ValueError:
            continue
        try:
            for fd in fd_dir.iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                if target.startswith("socket:[") and target[8:-1] in inodes:
                    found.add(pid)
                    break
        except OSError:
            continue
    return found


def stop_pid(pid: int) -> None:
    shown = cmdline(pid).replace(b"\x00", b" ").decode("utf-8", "replace").strip() or comm(pid)
    print(f"stopping leftover paseo pid={pid} comm={comm(pid)!r} cmd={shown}")
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return
    deadline = time.time() + 10
    while time.time() < deadline:
        if not Path(f"/proc/{pid}").exists():
            return
        time.sleep(0.2)
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


targets: set[int] = set()
if pid_path.is_file():
    try:
        record = json.loads(pid_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"removing unreadable pid file {pid_path}: {exc}")
        pid_path.unlink(missing_ok=True)
        record = None
    if isinstance(record, dict):
        recorded_pid = record.get("pid")
        recorded_host = str(record.get("hostname") or "")
        print(f"pidfile pid={recorded_pid} host={recorded_host or '-'} here={here}")
        if isinstance(recorded_pid, int) and recorded_pid > 1 and is_leftover_daemon(recorded_pid):
            targets.add(recorded_pid)
        elif recorded_host and not host_matches(recorded_host):
            print(f"stale pid file from {recorded_host}; removing")
        pid_path.unlink(missing_ok=True)
        print(f"removed {pid_path}")

for proc in Path("/proc").iterdir():
    try:
        pid = int(proc.name)
    except ValueError:
        continue
    if is_leftover_daemon(pid):
        targets.add(pid)

listeners = pids_listening_on_local_port(port)
for pid in sorted(listeners):
    print(f"listen 127.0.0.1:{port} pid={pid} comm={comm(pid)!r} ours={is_our_process(pid)}")
    if is_our_process(pid):
        targets.add(pid)

for pid in sorted(targets):
    stop_pid(pid)

deadline = time.time() + 15
while time.time() < deadline:
    leftover = {pid for pid in pids_listening_on_local_port(port) if is_our_process(pid)}
    leftover.update(pid for pid in targets if Path(f"/proc/{pid}").exists())
    if not leftover:
        break
    time.sleep(0.2)
else:
    leftover = {pid for pid in pids_listening_on_local_port(port) if is_our_process(pid)}
    if leftover:
        print(f"error: leftover process still bound to 127.0.0.1:{port}: {sorted(leftover)}", file=sys.stderr)
        raise SystemExit(1)

print(f"listen 127.0.0.1:{port} is free")
PY

status_json="$(paseo daemon status --json)"
local_daemon="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("localDaemon") or "")' <<<"${status_json}")"
if [[ "${local_daemon}" != "stopped" && -n "${local_daemon}" ]]; then
  echo "error: a Paseo daemon is still ${local_daemon} after leftover cleanup" >&2
  echo "${status_json}" >&2
  exit 1
fi

echo "host=${host} job=${SLURM_JOB_ID} ntasks=${SLURM_NTASKS} node=${SLURM_JOB_NODELIST}"
echo "paseo=$(command -v paseo) paseo-slurm=$(command -v paseo-slurm) paseo-local=$(command -v paseo-local) node=$(command -v node)"
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
paseo-local recover

echo "paseo daemon pid=${daemon_pid} watching_groups=${#watching_groups[@]}"
wait "${daemon_pid}"
trap - EXIT INT TERM
