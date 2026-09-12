# Rebase companion Paseo patches onto v0.8.0

Status: executed

## Task decision and program effect

Human asked to update every local companion patch so they apply to the latest
stable Paseo release (`v0.8.0`) and then install that release. Official 0.8.0
already ships some previously vendored behavior (Astra Fast, Codex reload
close-before-resume). Remaining companion patches must be rebased or dropped;
the lean installer must stop requiring obsolete patches.

Working tree already had staged, uncommitted `codex-astra-fast-mode.patch` plus
`patches/paseo/README.md` from earlier 0.7.x work. That staged set is consumed
by this task; no separate commit of the stale staging is needed.

## Compact execution brief

- Exact inputs and revisions: `getpaseo/paseo` tag `v0.8.0`; local patches
  under `patches/paseo/`; installer `scripts/install-paseo-lean.sh`.
- Protected science and fixed Human choices: do not start or restart the
  daemon on the login node; do not `sbatch` a replacement compute daemon from
  this unattended update; do not force-apply stale patches; keep
  `paseo.external-wait-id` and `paseo send --system` until upstream ships them.
- Task, evidence, and write ownership: this software-change record.
- Dependencies and sibling interfaces: `paseo-slurm` sidecar still needs
  finish deferral and hidden system send. Codex rewind still needs runtime MCP
  on `thread/fork` while #3205 / #3579 remain open.
- Completion and return conditions: remaining patches apply cleanly to
  `v0.8.0`; lean installer check passes; global CLI reports `0.8.0` with
  `--system` and remaining dist markers; dropped patches documented.
- Amendment boundary: a missing `--system` or finish-deferral after install,
  or applying a patch whose behavior is already upstream.

## Prospective design

Inspect `v0.8.0` against each companion patch. Drop patches whose behavior is
already in the release. Rebase survivors against the tagged source. Update the
lean installer and notes so `--check` only requires live patches. Install the
patched packages globally from `/var/tmp/paseo-lean`. Leave the running
compute-node daemon untouched.

Known official 0.8.0 landings to drop:

- Codex Fast for GPT-6 Astra: #4640 (closes #4451). Official list is an exact
  model set, not the local prefix allowlist.
- Codex reload close-before-resume: #4353 (supersedes local #3574). Official
  close-first reload plus failed-replacement recovery.

Likely survivors:

- External-wait finish deferral + `paseo send --system` (#3011 closed unmerged).
- Codex rewind runtime MCP on `thread/fork` (#3205 open; #3579 open). v0.8.0
  rewind now has a paginated `beforeTurnId` fork path; both fork sites need
  the runtime overlay.

## Existing evidence and applicability

Verified against `v0.7.0` (`c56638ea8`) in `3cd0ba2`. Official v0.8.0 notes
name #4353 and #4640. #3011 was closed without merge on 2026-09-08. #3205
remains open. Pre-existing staged Astra patch is superseded by #4640.

## Execution route and implementation freedom

Direct software change on this login host. Build tree stays on node-local
`/var/tmp/paseo-lean` (existing lean-install contract). No Slurm job. No
daemon restart.

## Resource arrangement

Lean clone/build on `/var/tmp` to avoid CephFS inode growth. No production
science. Do not submit `paseo-compute.sbatch` from this task.

## Amendment 1 - 2026-09-11

Human asked to update Paseo's own bundled skills and to resubmit the
compute-node daemon. Official `paseo-plugin` in v0.8.0 drifted from the
installed copies; the other five official skills already matched the 0.8.0
bundle. Submit `scripts/paseo-compute.sbatch` with the project's existing
direct-sbatch launch path (long-lived daemon, not a completable scientific
job; `PASEO_AGENT_ID` is unset in this Cursor session). The launch script
clears leftover `~/.paseo/paseo.pid` and `:6767` on the target node.

## Exact recovery pointers

- PROGRAM.md and Wiki binding: none in this repo
- Outcome record: `CHANGE.md` in this directory
- Source/revision links: `getpaseo/paseo` `v0.8.0`; local `patches/paseo/`
- Primary evidence paths: `evidence/`
