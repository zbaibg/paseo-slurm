# v0.10.2 companion install checks

Upstream tag: `v0.10.2` (`919c737c1948c5a16220307403a82e90d3e27ea0`)
npm `@getpaseo/cli` latest at the time of the task: `0.10.2`

## What upstream already ships

Codex rewind runtime config is official. [#5345](https://github.com/getpaseo/paseo/pull/5345)
merged 2026-09-28 and closes [#3205](https://github.com/getpaseo/paseo/issues/3205).
Stock `revertCodexConversation` passes `buildCodexInnerConfig()` into both
`thread/fork` paths. `codex-rewind-runtime-mcp.patch` does not apply and was
retired.

Still absent on the vanilla tag: `getExternalWaitIdFromLabels` and
`paseo send --system`. `claudeLaunchModelId` is also absent. Upstream `[1m]`
handling only normalizes ids observed on assistant frames.

## Patch check

```text
./scripts/install-paseo-lean.sh --check-only --ref v0.10.2
OK  patches/paseo/external-wait-finish-deferral.patch
OK  upstream Codex rewind runtime config (getpaseo/paseo#5345); local patch retired
OK  patches/paseo/claude-opus-gateway-1m-launch.patch
PATCHES_COMPATIBLE v0.10.2 919c737c1
```

`external-wait-finish-deferral.patch` applies unchanged.
`claude-opus-gateway-1m-launch.patch` was rebased: `models.ts` no longer has
`resolveClaudeConfigDir`, so the settings fallback uses `claudeConfigDir`.
Sonnet 5.5 is a new bare 1M catalog id and is included. The incremental
`system-send.patch` is not used on a vanilla tag because the combined patch
already includes `--system`.

## Install

The first `./scripts/install-paseo-lean.sh --ref v0.10.2` applied both live
patches, then `@getpaseo/server` `build:lib` failed in esbuild:

```text
Could not resolve "ajv"
src/server/agent/providers/opencode/v2/structured-output-plugin.mjs
```

Root `node_modules` had been removed, but `packages/server/node_modules/ajv`
was still the 2026-08-22 tree (`git clean` does not delete gitignored
`node_modules`). The installer now deletes every `node_modules` under the
lean checkout before `npm install`.

Second run exit code 0:

```text
paseo -> /home/zbai29/.nvm/versions/node/v24.15.0/bin/paseo
0.10.2
OK  dist markers {'deferral': True, 'codex_rewind_mcp': True, 'opus_1m': True}
INSTALLED v0.10.2 919c737c1 from /var/tmp/paseo-lean
```

`paseo send --help` lists `--system`. Global packages
`@getpaseo/{cli,client,server,protocol,plugin,relay,highlight}` are all
`0.10.2`. `providers/codex/rewind.js` contains `config: input.config`.

`npm i -g` warned that install scripts for `esbuild`, `node-pty`, and
`msgpackr-extract` were blocked by the user `allowScripts` policy. The
installed `node-pty` already has `prebuilds/linux-x64/pty.node`.

## Daemon resubmit

`scancel 493246` then `sbatch scripts/paseo-compute.sbatch` submitted job
`495897`. `493246` is `CANCELLED`. `495897` is `PENDING (Priority)` because
`compute-0-44` was taken by `495895` (`CoSn`, user `sthoang`, `TimeLimit=UNLIMITED`)
at 2026-09-29T22:07:00. No log file exists yet.
