# Companion patches rebased onto Paseo v0.8.0

Status: installed locally; compute daemon resubmitted

## Current outcome and status

Local companion patches now apply cleanly to official `v0.8.0`
(`b8e24677e`). Two former companions were dropped because the release already
ships them. Remaining companions are finish-deferral + `paseo send --system`,
and rewind runtime MCP on both legacy and paginated `thread/fork`. Global CLI
is `0.8.0` with `--system` and the remaining dist markers. Official Paseo
skills are synced to the 0.8.0 bundle (`paseo-plugin` was the only drift).
Compute daemon job `477657` was submitted with `sbatch` and was pending at
submit time.

## Plan and source identity

- Accepted PLAN.md: `agent_software_dev/paseo-v0.8.0-patches-20260911/PLAN.md`
- Source locations and revisions:
  - `getpaseo/paseo` tag `v0.8.0` (`b8e24677e12b226c7c38c1c3a40649daa9f1152f`)
  - live patches: `patches/paseo/external-wait-finish-deferral.patch`,
    `system-send.patch`, `codex-rewind-runtime-mcp.patch`
  - retired: `patches/paseo/superseded/`
  - installer: `scripts/install-paseo-lean.sh`
- Protected behavior and material Plan deviations: none. Official #4353
  close-first reload is used as-is; the older local `error` +
  `providerSessionClosed` parking from #3574 is not re-imposed.
- Resolved architecture and durable promotion: lean build on
  `/var/tmp/paseo-lean`; global npm packages under
  `~/.nvm/versions/node/v24.15.0/lib/node_modules/@getpaseo`

Working tree already had staged `codex-astra-fast-mode.patch` plus README
notes from earlier 0.7.x work. Those were consumed here and retired with the
official Fast list.

## Implementation and validation

Dropped because official v0.8.0 already has them:

- Codex Fast for GPT-6 Astra: #4640 closes #4451. Official code uses an exact
  model set that includes `gpt-6-astra`, not the local prefix allowlist.
- Codex reload close-before-resume: #4353 supersedes local #3574. Stock
  `reloadAgentSessionInternal` closes the previous writer before resume.

Rebased survivors:

- External-wait finish deferral and `paseo send --system`. #3011 remains
  closed unmerged.
- Rewind MCP overlay now covers both the legacy fork+rollback path and the
  v0.8.0 paginated `beforeTurnId` fork. #3205 / #3579 remain open.

`./scripts/install-paseo-lean.sh --check-only --ref v0.8.0` reported
`PATCHES_COMPATIBLE v0.8.0 b8e24677e`. Lean install then applied the live
patches, built daemon workspaces, and packed `*-0.8.0.tgz`. After `npm i -g`
had written the packages, `paseo --version` was `0.8.0`, `paseo send --help`
listed `--system`, and global `@getpaseo/server` dist contained
`getExternalWaitIdFromLabels`, rewind `issue #3205`, official Astra Fast, and
the official exclusive-writer reload comment. Evidence:
`evidence/RESULT.md`.

The installer `npm i -g` step stayed quiet for several minutes after packing
because it unpacks seven tarballs, including a ~1.7 MB server package, with
almost no further stdout.

Human later asked to update Paseo's own skills and resubmit the compute
daemon. Official `updateSkills` against the installed 0.8.0 bundle reported
drift only for `paseo-plugin` (0.7-era text vs the v0.8 plugin contract).
After update, status was `up-to-date` in `~/.claude/skills`,
`~/.codex/skills`, and `~/.agents/skills`. The other five official skills
already matched. Selection in `~/.paseo/config.json` is `mode: all`.

No `paseo-daemon` job was in the queue. A stale pidfile still named
`compute-0-44.local` pid `3931916` from 2026-09-07. Submitted
`sbatch scripts/paseo-compute.sbatch` as job `477657` (PD at submit). The
launch script clears leftover pid/` :6767` on that node. This is a
long-lived service job, not a `paseo-slurm` scientific wait.

## Resource status and forecast checkpoints

Direct login-node lean build on `/var/tmp`. Compute daemon submitted as
Slurm job `477657`. Do not poll it from the model.

## Limitations and follow-up

Job `477657` was pending at submit. Confirm it is healthy only after it
starts (`paseo daemon status` against that host, or the Slurm out/err under
`~/.paseo/slurm-paseo-477657.*`). A leftover `npm i -g` from the lean
install was still running on the login node after packages already reported
0.8.0; it does not block the compute job from loading the installed
packages.
