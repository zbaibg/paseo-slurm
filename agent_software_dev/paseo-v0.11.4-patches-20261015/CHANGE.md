# Patched Paseo v0.11.4 installed

Status: global CLI/daemon packages installed; compute-node worker reloaded

## Current outcome and status

Official `v0.11.4` (`dc5b02f7d`) is installed from `/var/tmp/paseo-lean`.
`paseo --version` is `0.11.4`. The worker on `compute-1-2` is pid `1970459`
under the existing supervisor `2684356`, healthy at `127.0.0.1:6767`, and
its startup log records `daemonVersion` `0.11.4` with daemon git integration
disabled from the existing `daemon.git.enabled: false` setting.

The previous worker was pid `2684370`. The restart interrupted in-flight
agent turns. `paseo-slurm recover` reattached 2 watching groups
(`recovered_groups=2`); it did not resubmit jobs.

## Plan and source identity

- Accepted PLAN.md: `agent_software_dev/paseo-v0.11.4-patches-20261015/PLAN.md`
- Source locations and revisions:
  - `getpaseo/paseo` tag `v0.11.4` (`dc5b02f7d`)
  - rebased: `patches/paseo/external-wait-finish-deferral.patch`,
    `patches/paseo/system-send.patch`,
    `patches/paseo/claude-opus-gateway-1m-launch.patch`,
    `patches/paseo/workspace-git-ignore.patch`
  - unchanged apply: `patches/paseo/browser-download.patch`
  - installer: `scripts/install-paseo-lean.sh`
- Protected behavior and material Plan deviations: none. The host stayed
  `compute-1-2`. Config keys were not rewritten.
- Resolved architecture and durable promotion: lean build on
  `/var/tmp/paseo-lean`; global npm packages under
  `~/.nvm/versions/node/v24.15.0/lib/node_modules/@getpaseo`

## Implementation and validation

`v0.11.4` rejected the v0.10.2 external-wait, gateway `[1m]`, and
workspace-git-ignore patches. `browser-download.patch` still applied.
Finish deferral and `paseo send --system` are still absent upstream.
`PaseoAgentSendOptions` is now an alias of `SendMessageOptions`, so `system`
is added only on that interface. The gateway launch helper is inserted
before `buildOptions(permissionMode)`, and Haiku 5.5 is included with the
other bare 1M catalog ids. The git-disable backstop stays in the server
`utils/spawn.ts` wrapper; that wrapper now delegates to the plugin process
launcher. Stock rewind still passes `buildCodexInnerConfig()` into
`thread/fork`.

`./scripts/install-paseo-lean.sh` reported `INSTALLED v0.11.4 dc5b02f7d`.
Dist markers all matched. Evidence: `evidence/RESULT.md`.

`paseo send --help` lists `--system`. The installed server accepts the live
`config.json`, including `daemon.git.enabled: false`.

## Resource status and forecast checkpoints

Direct login-node lean build on `/var/tmp` (`/dev/sdb4`, about 197G free).
The install took about 101 seconds. The worker restart on `compute-1-2`
finished at 2026-10-15T20:24:20-05:00. Log:
`/home/zbai29/soft/paseo-rollback/restart-worker-0.11.4.log`.

## Limitations and follow-up

Agents that were mid-turn when the worker restarted need a new turn to
continue. `browser_download` is registered only for agents created after
this restart. npm blocked install scripts for `esbuild`, `node-pty`, and
`msgpackr-extract`; the linux-x64 prebuilds those packages ship were
present after install.
