# Install patched Paseo v0.10.2

Status: executed

## Task decision and program effect

Human asked to adapt the local Paseo companion patches to official v0.10.2,
drop any patch that upstream already ships, install the patched CLI/daemon,
and resubmit the compute-node Paseo daemon. npm `@getpaseo/cli` latest is
`0.10.2`. The running daemon is job `493246` on `compute-0-44`. Replacing it
stops that daemon and its agents. Other queued science jobs stay untouched.

Pre-existing uncommitted files `scripts/paseo-compute.sbatch` and
`scripts/ensure-poppler-utils.sh` are unrelated and stay untouched.

## Compact execution brief

- Exact inputs and revisions: `getpaseo/paseo` tag `v0.10.2`
  (`919c737c1948c5a16220307403a82e90d3e27ea0`); local patches under
  `patches/paseo/`; installer `scripts/install-paseo-lean.sh`.
- Protected science and fixed Human choices: do not start Paseo on the login
  node; do not force-apply a patch that no longer matches; drop a companion
  only when v0.10.2 already ships that behavior; resubmit only the
  `paseo-daemon` job on the existing host `compute-0-44`.
- Task, evidence, and write ownership: this software-change record.
- Dependencies and sibling interfaces: `paseo-slurm` still needs finish
  deferral and `paseo send --system`. The gateway `[1m]` launch suffix is
  still absent upstream. Codex rewind runtime config is official
  ([#5345](https://github.com/getpaseo/paseo/pull/5345)).
- Completion and return conditions: live patches apply cleanly to `v0.10.2`;
  the rewind companion is retired; lean install finishes; `paseo --version`
  is `0.10.2`; `paseo send --help` lists `--system`; global server dist has
  the deferral and gateway markers plus the upstream rewind config; a
  replacement `sbatch scripts/paseo-compute.sbatch` is running on
  `compute-0-44` and becomes healthy.
- Amendment boundary: applying a patch whose behavior is already upstream,
  or leaving the new daemon down after the replacement submit.

## Prospective design

`git apply --check` against tag `v0.10.2`. Keep a patch that still applies
and whose behavior is absent upstream. Rebase the gateway `[1m]` patch where
`models.ts` no longer has `resolveClaudeConfigDir`. Retire the rewind patch
when stock `revertCodexConversation` passes `buildCodexInnerConfig()`.
Install with `./scripts/install-paseo-lean.sh --ref v0.10.2` into
`/var/tmp/paseo-lean`, then global npm tarballs. Cancel job `493246` and
submit the existing compute launch script. That job is a long-running daemon,
so it is submitted with `sbatch` rather than a completing `paseo-slurm` wait.

## Amendment 1 - 2026-09-29

Cancelling `493246` freed `compute-0-44` before job `495897` was scheduled.
User `sthoang` job `495895` (`CoSn`, unlimited) took that node. `495897`
stays pending on the script's `--nodelist=compute-0-44`. The host pin is
unchanged.
