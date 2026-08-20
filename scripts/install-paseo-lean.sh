#!/usr/bin/env bash
# Clone latest stable getpaseo/paseo release, check companion patches, apply
# them, then install only the daemon/CLI packages globally.
# Does not restart the Paseo daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMBINED="${ROOT}/patches/paseo/external-wait-finish-deferral.patch"
SYSTEM_SEND="${ROOT}/patches/paseo/system-send.patch"
CODEX_RELOAD="${ROOT}/patches/paseo/codex-reload-close-before-resume.patch"
CODEX_REWIND="${ROOT}/patches/paseo/codex-rewind-runtime-mcp.patch"
APPLY_EXTERNAL="${ROOT}/scripts/apply-paseo-external-wait.sh"
UPSTREAM_URL="${PASEO_UPSTREAM_URL:-https://github.com/getpaseo/paseo.git}"
SRC="${PASEO_LEAN_SRC:-/var/tmp/paseo-lean}"
CHECK_ONLY=0
REF=""

usage() {
  cat <<'EOF'
Usage: install-paseo-lean.sh [--check-only] [--src DIR] [--ref TAG]

Install a patched Paseo CLI/daemon from the latest *stable* getpaseo/paseo
release (npm @getpaseo/cli `latest`, not main/beta) without pulling the
React Native / website / desktop monorepo (those trees blow CephFS
file-count quota).

  --check-only   Fetch the release tag and run git apply --check. Do not install.
  --src DIR      Build checkout (default: /var/tmp/paseo-lean, node-local disk)
  --ref TAG      Override release (e.g. v0.4.0). Default: v$(npm view @getpaseo/cli version)

Environment:
  PASEO_LEAN_SRC, PASEO_UPSTREAM_URL, PASEO_LEAN_REF

Applies:
  external-wait-finish-deferral.patch (via apply-paseo-external-wait.sh)
  system-send.patch (only if the tree already has deferral but not --system)
  codex-reload-close-before-resume.patch (close old Codex app-server before thread/resume)
  codex-rewind-runtime-mcp.patch (pass runtime MCP config on Codex rewind thread/fork)

Does not run `paseo daemon restart`. Do that yourself after the CLI smoke test.
Never `npm i -g @getpaseo/cli` from the registry: that overwrites this install.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --src) SRC="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "${REF}" ]]; then
  REF="${PASEO_LEAN_REF:-}"
fi

if [[ ! -f "${COMBINED}" || ! -f "${SYSTEM_SEND}" || ! -f "${CODEX_RELOAD}" || ! -f "${CODEX_REWIND}" || ! -x "${APPLY_EXTERNAL}" ]]; then
  echo "error: missing patch files or apply script under ${ROOT}" >&2
  exit 1
fi

if ! command -v git >/dev/null || ! command -v npm >/dev/null; then
  echo "error: git and npm are required" >&2
  exit 1
fi

resolve_stable_ref() {
  if [[ -n "${REF}" ]]; then
    if [[ "${REF}" != v* ]]; then
      REF="v${REF}"
    fi
    return
  fi
  local npm_ver
  npm_ver="$(npm view @getpaseo/cli version)"
  if [[ -z "${npm_ver}" ]]; then
    echo "error: could not resolve npm @getpaseo/cli latest version" >&2
    exit 1
  fi
  if [[ "${npm_ver}" == *beta* || "${npm_ver}" == *rc* || "${npm_ver}" == *alpha* ]]; then
    echo "error: npm latest is prerelease (${npm_ver}); pass --ref to a stable tag" >&2
    exit 1
  fi
  REF="v${npm_ver}"
}

ensure_clean_ref() {
  if [[ ! -d "${SRC}/.git" ]]; then
    rm -rf "${SRC}"
    git clone --origin upstream "${UPSTREAM_URL}" "${SRC}"
  else
    if ! git -C "${SRC}" remote get-url upstream >/dev/null 2>&1; then
      git -C "${SRC}" remote add upstream "${UPSTREAM_URL}"
    fi
    git -C "${SRC}" fetch --prune --tags upstream
  fi
  if ! git -C "${SRC}" rev-parse --verify "refs/tags/${REF}" >/dev/null 2>&1; then
    echo "error: missing git tag ${REF} in ${SRC}" >&2
    exit 1
  fi
  git -C "${SRC}" checkout --force -B "release-${REF}" "${REF}"
  git -C "${SRC}" reset --hard "${REF}"
  # Avoid zsh globbing on * in excludes when this script is run under zsh.
  git -C "${SRC}" clean -fd -e node_modules -e '*.tgz'
}

check_patches() {
  echo "=== Paseo revision (${REF}) ==="
  git -C "${SRC}" log -1 --oneline
  echo "=== git apply --check (must be clean against this revision) ==="
  if git -C "${SRC}" apply --check "${COMBINED}"; then
    echo "OK  ${COMBINED}"
  elif git -C "${SRC}" apply --check "${SYSTEM_SEND}"; then
    echo "OK  ${SYSTEM_SEND} (incremental; combined not needed)"
  else
    echo "error: neither combined nor incremental system-send patch applies" >&2
    git -C "${SRC}" apply --check "${COMBINED}" 2>&1 || true
    git -C "${SRC}" apply --check "${SYSTEM_SEND}" 2>&1 || true
    exit 1
  fi
  if git -C "${SRC}" apply --check "${CODEX_RELOAD}"; then
    echo "OK  ${CODEX_RELOAD}"
  else
    echo "error: Codex reload patch does not apply" >&2
    git -C "${SRC}" apply --check "${CODEX_RELOAD}" 2>&1 || true
    exit 1
  fi
  if git -C "${SRC}" apply --check "${CODEX_REWIND}"; then
    echo "OK  ${CODEX_REWIND}"
  else
    echo "error: Codex rewind MCP patch does not apply" >&2
    git -C "${SRC}" apply --check "${CODEX_REWIND}" 2>&1 || true
    exit 1
  fi
}

trim_workspaces() {
  python3 - "${SRC}/package.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    pj = json.load(f)
pj["workspaces"] = [
    "packages/highlight",
    "packages/plugin",
    "packages/protocol",
    "packages/client",
    "packages/server",
    "packages/relay",
    "packages/cli",
]
scripts = pj.setdefault("scripts", {})
if scripts.get("prepare") == "lefthook install --force":
    del scripts["prepare"]
with open(path, "w") as f:
    json.dump(pj, f, indent=2)
    f.write("\n")
print("workspaces", pj["workspaces"])
PY
}

verify_install() {
  local nvm_paseo
  nvm_paseo="$(command -v paseo)"
  echo "paseo -> ${nvm_paseo}"
  if [[ "${nvm_paseo}" == *"/var/tmp/"* ]]; then
    echo "warning: current PATH resolves paseo under /var/tmp; prefer ~/.nvm/.../bin/paseo" >&2
  fi
  paseo --version
  if ! paseo send --help | grep -q -- '--system'; then
    echo "error: patched CLI is missing paseo send --system" >&2
    exit 1
  fi
  python3 - <<'PY'
import os, sys
root = os.path.expanduser("~/.nvm/versions/node")
if not os.path.isdir(root):
    print("warning: ~/.nvm not found; skip dist marker check", file=sys.stderr)
    raise SystemExit(0)
hits = {"deferral": False, "codex_reload": False, "codex_rewind_mcp": False}
for dirpath, dirnames, filenames in os.walk(root):
    if "/@getpaseo/server/" not in dirpath.replace("\\", "/"):
        continue
    if "agent-prompt.js" in filenames:
        text = open(os.path.join(dirpath, "agent-prompt.js"), encoding="utf-8").read()
        hits["deferral"] = "getExternalWaitIdFromLabels" in text
    if "agent-manager.js" in filenames:
        text = open(os.path.join(dirpath, "agent-manager.js"), encoding="utf-8").read()
        hits["codex_reload"] = (
            "Closing previous session before reload resume" in text
            and "finalizeFailedReload" in text
            and "providerSessionClosed" in text
        )
    if "rewind.js" in filenames and dirpath.replace("\\", "/").endswith("/providers/codex"):
        text = open(os.path.join(dirpath, "rewind.js"), encoding="utf-8").read()
        hits["codex_rewind_mcp"] = "issue #3205" in text
if not hits["deferral"] or not hits["codex_reload"] or not hits["codex_rewind_mcp"]:
    print("error: global @getpaseo/server dist is missing patch markers", hits, file=sys.stderr)
    raise SystemExit(1)
print("OK  dist markers", hits)
PY
}

resolve_stable_ref
ensure_clean_ref
check_patches

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  echo "PATCHES_COMPATIBLE ${REF} $(git -C "${SRC}" rev-parse --short HEAD)"
  echo "No install performed (--check-only)."
  exit 0
fi

echo "=== apply patches ==="
"${APPLY_EXTERNAL}" "${SRC}"
if grep -Fq "finalizeFailedReload" \
  "${SRC}/packages/server/src/server/agent/agent-manager.ts"; then
  echo "ALREADY_APPLIED ${CODEX_RELOAD}"
else
  git -C "${SRC}" apply "${CODEX_RELOAD}"
  echo "APPLIED ${CODEX_RELOAD} -> ${SRC}"
fi
if grep -Fq "issue #3205" \
  "${SRC}/packages/server/src/server/agent/providers/codex/rewind.ts"; then
  echo "ALREADY_APPLIED ${CODEX_REWIND}"
else
  git -C "${SRC}" apply "${CODEX_REWIND}"
  echo "APPLIED ${CODEX_REWIND} -> ${SRC}"
fi

echo "=== trim workspaces to daemon packages ==="
trim_workspaces

echo "=== npm install (no RN/website/desktop) ==="
(
  cd "${SRC}"
  npm install --ignore-scripts
  PATH="${SRC}/node_modules/.bin:${PATH}" node scripts/postinstall-patches.mjs
  npm run build:server
)

echo "=== pack and npm i -g ==="
(
  cd "${SRC}"
  rm -f ./*.tgz
  npm pack --ignore-scripts \
    --workspace=@getpaseo/highlight \
    --workspace=@getpaseo/protocol \
    --workspace=@getpaseo/plugin \
    --workspace=@getpaseo/relay \
    --workspace=@getpaseo/client \
    --workspace=@getpaseo/server \
    --workspace=@getpaseo/cli
  npm i -g ./getpaseo-highlight-*.tgz ./getpaseo-protocol-*.tgz \
    ./getpaseo-plugin-*.tgz ./getpaseo-relay-*.tgz ./getpaseo-client-*.tgz \
    ./getpaseo-server-*.tgz ./getpaseo-cli-*.tgz
)

echo "=== smoke ==="
verify_install

echo
echo "INSTALLED ${REF} $(git -C "${SRC}" rev-parse --short HEAD) from ${SRC}"
echo "Daemon was NOT restarted. When ready: ./scripts/tmpdir_paseo_restart.sh"
echo "Do not run: npm i -g @getpaseo/cli"
