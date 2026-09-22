# Patched Paseo v0.9.1 installed

Status: global CLI/daemon packages installed; compute daemon not restarted

## Current outcome and status

Companion patches apply unchanged to official `v0.9.1`
(`81865852011df86aa0ad0ae411cb2f5e4078153f`). Finish deferral,
`paseo send --system`, and the Codex rewind runtime MCP overlay are still
absent upstream, so the diffs were kept. Global `paseo --version` is `0.9.1`
and `paseo send --help` lists `--system`. The running compute daemon was not
replaced.

## Plan and source identity

- Accepted PLAN.md: `agent_software_dev/paseo-v0.9.1-patches-20260922/PLAN.md`
- Source locations and revisions:
  - `getpaseo/paseo` tag `v0.9.1` (`81865852011df86aa0ad0ae411cb2f5e4078153f`)
  - live patches: `patches/paseo/external-wait-finish-deferral.patch`,
    `system-send.patch`, `codex-rewind-runtime-mcp.patch`
  - installer: `scripts/install-paseo-lean.sh --ref v0.9.1`
- Protected behavior and material Plan deviations: none. The first lean build
  failed because `/var/tmp/paseo-lean/node_modules` still held an August 22
  tree whose JavaScript files were missing. That directory was removed and
  the same installer was run again.
- Resolved architecture and durable promotion: lean build on
  `/var/tmp/paseo-lean`; global npm packages under
  `~/.nvm/versions/node/v24.15.0/lib/node_modules/@getpaseo`

Pre-existing uncommitted files under `scripts/` were left untouched.

## Implementation and validation

`./scripts/install-paseo-lean.sh --check-only --ref v0.9.1` reported
`PATCHES_COMPATIBLE v0.9.1 818658520` before the header notes were updated.
After those notes, the install run checked and applied the same diffs.

No companion was dropped. Stock v0.9.1 still lacks
`getExternalWaitIdFromLabels`, `paseo send --system`, and the rewind
`thread/fork` runtime overlay (`#3205`).

The successful install applied both live patches, built the daemon
workspaces, and packed `*-0.9.1.tgz`. After `npm i -g`, `paseo --version`
was `0.9.1` and the global `@getpaseo/server` dist contained
`getExternalWaitIdFromLabels` and rewind `issue #3205`. Evidence:
`evidence/RESULT.md`.

## Resource status and forecast checkpoints

Direct login-node lean build on `/var/tmp` (`/dev/sdb4`, about 201G free
before the clean install). Compute daemon job `480229` (`paseo-daemon` on
`compute-0-44`, running about 8 days) was left running. It still has the
previous process until a replacement `sbatch scripts/paseo-compute.sbatch`.
That submission stops the current daemon and its agents.

## Limitations and follow-up

The new packages are on the login-node global prefix. They are not loaded
by job `480229`. Resubmit the compute daemon only when stopping that daemon
is acceptable.

## Amendment 2026-09-22 — launch flags

Human submitted `sbatch` after the install. Job `490940` cancelled `480229`
and then failed in 13 seconds: v0.9.1 removed `paseo daemon start
--foreground/--listen/--relay`. `scripts/paseo-compute.sbatch` now writes
`daemon.listen` and `daemon.relay.enabled` and starts with `paseo daemon run`.
