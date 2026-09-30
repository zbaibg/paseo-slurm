# Patched Paseo v0.10.2 installed

Status: global CLI/daemon packages installed; replacement daemon is pending

## Current outcome and status

Official `v0.10.2` (`919c737c1948c5a16220307403a82e90d3e27ea0`) already sends
runtime Codex config on rewind, so `codex-rewind-runtime-mcp.patch` is retired.
Finish deferral and `paseo send --system` still apply unchanged. The gateway
`[1m]` launch patch was rebased onto the v0.10.2 Claude config-directory
helper and now includes Sonnet 5.5. Global `paseo --version` is `0.10.2`.

Job `493246` was cancelled. Replacement job `495897` is pending because
`compute-0-44` is held by another user's unlimited job `495895`. The daemon
is not running until that node is free.

## Plan and source identity

- Accepted PLAN.md: `agent_software_dev/paseo-v0.10.2-patches-20260929/PLAN.md`
- Source locations and revisions:
  - `getpaseo/paseo` tag `v0.10.2` (`919c737c1948c5a16220307403a82e90d3e27ea0`)
  - live patches: `patches/paseo/external-wait-finish-deferral.patch`,
    `patches/paseo/claude-opus-gateway-1m-launch.patch`
  - retired: `patches/paseo/superseded/codex-rewind-runtime-mcp.patch`
    (official [#5345](https://github.com/getpaseo/paseo/pull/5345))
  - installer: `scripts/install-paseo-lean.sh --ref v0.10.2`
- Protected behavior and material Plan deviations: the host pin
  `compute-0-44` was kept. The replacement job did not become healthy in this
  turn because that node was allocated to job `495895`.
- Resolved architecture and durable promotion: lean build on
  `/var/tmp/paseo-lean`; global npm packages under
  `~/.nvm/versions/node/v24.15.0/lib/node_modules/@getpaseo`

Pre-existing uncommitted files `scripts/paseo-compute.sbatch` and
`scripts/ensure-poppler-utils.sh` were left untouched.

## Implementation and validation

`./scripts/install-paseo-lean.sh --check-only --ref v0.10.2` reported
`PATCHES_COMPATIBLE v0.10.2 919c737c1`.

The first full install failed because a leftover
`packages/server/node_modules/ajv` from 2026-08-22 made esbuild unable to
resolve `ajv` while bundling the OpenCode v2 bridge. The installer now
removes every `node_modules` under the lean checkout before `npm install`.
The second run installed `0.10.2` and the dist markers passed. Evidence:
`evidence/RESULT.md`.

`paseo send --help` lists `--system`. Stock `rewind.js` contains
`config: input.config`.

## Resource status and forecast checkpoints

Direct login-node lean build on `/var/tmp` (`/dev/sdb4`, about 201G free
before the clean install). The successful install took about 76 seconds
after the stale modules were removed.

Daemon job `493246` (`paseo-daemon` on `compute-0-44`, about 3 days 5 hours)
was cancelled. Job `495897` is pending with `ReqNodeList=compute-0-44`.

## Limitations and follow-up

The new packages are on the login-node global prefix. They load only when
job `495897` starts. That job waits on `compute-0-44`, currently running
`495895` (`CoSn`, user `sthoang`, unlimited). The daemon stays down until
that allocation ends or the host pin is changed.
