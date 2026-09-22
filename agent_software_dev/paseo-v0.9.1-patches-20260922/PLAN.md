# Install patched Paseo v0.9.1

Status: executed

## Task decision and program effect

Human asked to install Paseo v0.9.1 and make the local companion patches
apply to that release. npm `@getpaseo/cli` latest is `0.9.1`. The running
compute daemon is left as-is; this task installs the global CLI/daemon
packages and does not `sbatch` a replacement.

Pre-existing uncommitted files under `scripts/` (gateway helpers and
`paseo-compute.sbatch`) are unrelated and stay untouched.

## Compact execution brief

- Exact inputs and revisions: `getpaseo/paseo` tag `v0.9.1`; local patches
  under `patches/paseo/`; installer `scripts/install-paseo-lean.sh`.
- Protected science and fixed Human choices: do not start Paseo on the login
  node; do not submit a replacement compute daemon; do not force-apply a
  patch that no longer matches; drop a companion only if v0.9.1 already
  ships that behavior.
- Task, evidence, and write ownership: this software-change record.
- Dependencies and sibling interfaces: `paseo-slurm` still needs finish
  deferral and `paseo send --system`. Codex rewind still needs the runtime
  MCP overlay on `thread/fork` while #3205 remains open.
- Completion and return conditions: live patches apply cleanly to `v0.9.1`;
  lean install finishes; `paseo --version` is `0.9.1`; `paseo send --help`
  lists `--system`; global server dist has the deferral and rewind markers.
- Amendment boundary: a missing `--system` or finish-deferral after install,
  or applying a patch whose behavior is already upstream.

## Prospective design

`git apply --check` against tag `v0.9.1`. If a patch fails, rebase or drop
it. If it applies and the feature is still absent upstream, keep the diff
and record the new base. Install with `./scripts/install-paseo-lean.sh
--ref v0.9.1` into `/var/tmp/paseo-lean`, then global npm tarballs.
