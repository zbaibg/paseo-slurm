# Optional Paseo companion patch

Temporary home for the daemon changes that `paseo-slurm` needs until upstream
lands the same behavior.

| Item | Value |
| --- | --- |
| Combined patch | `external-wait-finish-deferral.patch` (deferral + `paseo send --system`) |
| Incremental patch | `system-send.patch` (only `--system`, for trees that already have deferral) |
| Codex reload patch | `codex-reload-close-before-resume.patch` (close old app-server before `thread/resume`) |
| Codex rewind MCP patch | `codex-rewind-runtime-mcp.patch` (pass runtime MCP config on `thread/fork`) |
| Upstream discussion | https://github.com/getpaseo/paseo/discussions/3010 |
| Upstream draft PR | https://github.com/getpaseo/paseo/pull/3011 |
| Upstream rewind bug | https://github.com/getpaseo/paseo/issues/3205 |
| Verified against | `getpaseo/paseo` `v0.5.0-beta.2` (`ccd991b3e`) |
| Install | [install-and-patch.md](./install-and-patch.md) — lean CLI/daemon from latest stable |

Do not vendor a resume-MCP rebind for [getpaseo/paseo#3283](https://github.com/getpaseo/paseo/issues/3283): after daemon restart the thread is unloaded, so Paseo already sends the runtime overlay on `thread/resume`. Codex 0.148 honors that. That path is distinct from rewind/`thread/fork` (#3205).

These patches do **not** include machine-local defaults such as
`TMPDIR=/home/zbai29/soft/tmp`. Set that at restart time:

```bash
./scripts/tmpdir_paseo_restart.sh
```

**Install (do this, not a full monorepo `npm install` on scratch):**

```bash
./scripts/install-paseo-lean.sh --check-only
./scripts/install-paseo-lean.sh
./scripts/tmpdir_paseo_restart.sh   # when ready; kills running agents
```

## What they do

1. Reserve the agent label `paseo.external-wait-id`. While that label is set,
   Paseo's existing `notifyOnFinish` subscription stays alive but does **not**
   fire on intermediate `running → idle` edges. Errors and permission requests
   still notify immediately. Clearing the label and completing a final resumed
   turn restores the normal one-shot parent notification.
2. Add `paseo send --system`. Sidecar resumes use the same hidden
   `<paseo-system>` path as child-to-parent finish notifications, so they do
   not appear as a user-message bubble. Without this flag, `paseo-slurm`
   resume attempts fail on stock stable CLI (`0.4.0`).
3. Close the previous Codex app-server **before** spawning a replacement and
   calling `thread/resume`. Reload used to start the new writer first, so a
   live Codex agent failed reload with `already has an active writer`
   ([#3574](https://github.com/getpaseo/paseo/pull/3574)). If resume/MCP setup
   then fails, keep the agent visible in `error` and block `startTurn` until a
   later reload succeeds. Independent of #3011.
4. Pass the current runtime `buildCodexInnerConfig()` result (injected Paseo
   MCP endpoint, developer instructions) on Codex `thread/fork` during
   **Rewind conversation**. Without this, the forked thread stays loaded and
   falls back to the Codex base MCP config
   ([getpaseo/paseo#3205](https://github.com/getpaseo/paseo/issues/3205)).

Paseo does not poll Slurm or interpret the wait id. That policy stays in
`paseo-slurm`.

## Apply

Preferred path (latest stable tag, patch `--check`, daemon packages only, global
`npm i -g` tarballs): [install-and-patch.md](./install-and-patch.md).

```bash
./scripts/install-paseo-lean.sh --check-only
./scripts/install-paseo-lean.sh
./scripts/tmpdir_paseo_restart.sh   # when ready; kills running agents
```

To patch an existing **source** checkout without installing (no `node_modules`
required to apply):

```bash
./scripts/apply-paseo-external-wait.sh /path/to/paseo
```

The external-wait script is idempotent (`ALREADY_APPLIED` when both markers are present).
If the tree already has finish deferral but not `--system`, it applies
`system-send.patch` only.

## Remove when upstream merges

When https://github.com/getpaseo/paseo/pull/3011 (or an equivalent that also
ships `paseo send --system`) merges into a stable release, drop the
external-wait patches.

Drop `codex-reload-close-before-resume.patch` when upstream reload closes the
previous Codex app-server before `thread/resume` and parks a failed
replacement as a visible `error` agent
([#3574](https://github.com/getpaseo/paseo/pull/3574)).

Drop `codex-rewind-runtime-mcp.patch` when upstream rewind passes runtime
`buildCodexInnerConfig()` on `thread/fork` ([#3205](https://github.com/getpaseo/paseo/issues/3205)).
