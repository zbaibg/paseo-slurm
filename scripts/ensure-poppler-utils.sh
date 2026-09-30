#!/usr/bin/env bash
# Put Poppler CLIs on ~/.local/bin for Claude Code PDF page rendering.
#
# Claude Code shells out to pdftoppm and pdfinfo. Those programs are not part
# of the Claude installer: Poppler is a separate GPL package, and this cluster
# image does not ship poppler-utils. Compute jobs have no root, so apt/dnf
# cannot install it. A conda-forge env on shared $HOME is visible on every
# compute node. Wrappers live in ~/.local/bin, which paseo-compute.sbatch
# puts on PATH before the daemon starts. Claude child processes inherit it.
#
#   /home/zbai29/soft/paseo-slurm/scripts/ensure-poppler-utils.sh
#
# paseo-compute.sbatch calls this on every launch. Re-running is safe: an
# existing env is left in place, and only wrappers this script owns are
# rewritten.
set -euo pipefail

PREFIX="${POPPLER_ENV_PREFIX:-${HOME}/soft/miniforge3/envs/poppler-tools}"
MAMBA="${MAMBA_EXE:-${HOME}/soft/miniforge3/bin/mamba}"
BIN_DIR="${HOME}/.local/bin"
MARKER="Managed by paseo-slurm scripts/ensure-poppler-utils.sh"

TOOLS=(
  pdfattach
  pdfdetach
  pdffonts
  pdfimages
  pdfinfo
  pdfseparate
  pdfsig
  pdftocairo
  pdftohtml
  pdftoppm
  pdftops
  pdftotext
  pdfunite
)

if [[ ! -x "${PREFIX}/bin/pdftoppm" || ! -x "${PREFIX}/bin/pdfinfo" ]]; then
  if [[ ! -x "${MAMBA}" ]]; then
    echo "error: poppler env missing and mamba not found at ${MAMBA}" >&2
    exit 1
  fi
  echo "installing poppler into ${PREFIX}"
  "${MAMBA}" create -y -p "${PREFIX}" -c conda-forge poppler
fi

if [[ ! -x "${PREFIX}/bin/pdftoppm" || ! -x "${PREFIX}/bin/pdfinfo" ]]; then
  echo "error: ${PREFIX} still has no pdftoppm/pdfinfo" >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"
installed=0
for tool in "${TOOLS[@]}"; do
  src="${PREFIX}/bin/${tool}"
  if [[ ! -x "${src}" ]]; then
    echo "error: missing ${src}" >&2
    exit 1
  fi
  dest="${BIN_DIR}/${tool}"
  if [[ -L "${dest}" ]]; then
    echo "error: ${dest} is a symlink; refusing to replace it" >&2
    exit 1
  fi
  if [[ -e "${dest}" ]] && ! grep -q -F "${MARKER}" "${dest}"; then
    echo "error: ${dest} exists and is not a paseo poppler wrapper" >&2
    exit 1
  fi
  tmp="${dest}.tmp.$$"
  cat > "${tmp}" <<EOF
#!/usr/bin/env bash
# ${MARKER}
exec ${src} "\$@"
EOF
  chmod 755 "${tmp}"
  mv -f "${tmp}" "${dest}"
  installed=$((installed + 1))
done

export PATH="${BIN_DIR}:${PATH}"
pdftoppm -v >/dev/null 2>&1
pdfinfo -v >/dev/null 2>&1
echo "poppler ready prefix=${PREFIX} tools=${installed} pdftoppm=$(command -v pdftoppm) pdfinfo=$(command -v pdfinfo)"
