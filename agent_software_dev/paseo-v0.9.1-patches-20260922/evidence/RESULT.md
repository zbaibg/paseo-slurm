# v0.9.1 companion install checks

Upstream tag: `v0.9.1` (`81865852011df86aa0ad0ae411cb2f5e4078153f`)
npm `@getpaseo/cli` latest at the time of the task: `0.9.1`

## Patch check

```text
./scripts/install-paseo-lean.sh --check-only --ref v0.9.1
OK  patches/paseo/external-wait-finish-deferral.patch
OK  patches/paseo/codex-rewind-runtime-mcp.patch
PATCHES_COMPATIBLE v0.9.1 818658520
```

Upstream `v0.9.1` does not already contain `getExternalWaitIdFromLabels`,
`paseo send --system`, or rewind `issue #3205`.

## Install

First `./scripts/install-paseo-lean.sh --ref v0.9.1` applied the patches, then
`@getpaseo/server` `build:lib` failed:

```text
src/server/agent/providers/cursor-acp-agent.ts(1,38): error TS2307:
Cannot find module '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
```

The reused `/var/tmp/paseo-lean/node_modules` was dated 2026-08-22 and was
missing JavaScript entry files (149 packages, including
`@agentclientprotocol/sdk@0.17.1`). The published 0.17.1 tarball does contain
`dist/schema/zod.gen.js`. `node_modules` was removed and the installer was
run again.

Second run exit code 0:

```text
paseo -> /home/zbai29/.nvm/versions/node/v24.15.0/bin/paseo
0.9.1
OK  dist markers {'deferral': True, 'codex_rewind_mcp': True}
INSTALLED v0.9.1 818658520 from /var/tmp/paseo-lean
```

`paseo send --help` lists `--system`.

Compute daemon job `480229` was still `RUNNING` on `compute-0-44` after the
install. It was not resubmitted.
