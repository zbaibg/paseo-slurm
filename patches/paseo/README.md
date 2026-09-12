# Optional Paseo companion patch

Temporary home for the daemon changes that `paseo-slurm` needs until upstream
lands the same behavior.

| Item | Value |
| --- | --- |
| Combined patch | `external-wait-finish-deferral.patch` (deferral + `paseo send --system`) |
| Incremental patch | `system-send.patch` (only `--system`, for trees that already have deferral) |
| Codex rewind MCP patch | `codex-rewind-runtime-mcp.patch` (pass runtime MCP config on `thread/fork`) |
| Upstream discussion | https://github.com/getpaseo/paseo/discussions/3010 |
| Upstream draft PR | https://github.com/getpaseo/paseo/pull/3011 (closed unmerged) |
| Upstream rewind bug | https://github.com/getpaseo/paseo/issues/3205 |
| Verified against | `getpaseo/paseo` `v0.8.0` (`b8e24677e`) |
| Install | [install-and-patch.md](./install-and-patch.md) — lean CLI/daemon from latest stable |

Do not vendor a resume-MCP rebind for [getpaseo/paseo#3283](https://github.com/getpaseo/paseo/issues/3283): after daemon restart the thread is unloaded, so Paseo already sends the runtime overlay on `thread/resume`. Codex 0.148 honors that. That path is distinct from rewind/`thread/fork` (#3205).

These patches do **not** include machine-local defaults such as
`TMPDIR=/home/zbai29/soft/tmp`. The compute launch script sets that. After
install, **do not start Paseo on the login node**.

**Install (do this, not a full monorepo `npm install` on scratch):**

```bash
./scripts/install-paseo-lean.sh --check-only
./scripts/install-paseo-lean.sh
sbatch ./scripts/paseo-compute.sbatch
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
   resume attempts fail on stock stable CLI.
3. Pass the current runtime `buildCodexInnerConfig()` result (injected Paseo
   MCP endpoint, developer instructions) on Codex `thread/fork` during
   **Rewind conversation**, including the v0.8.0 paginated `beforeTurnId`
   path. Without this, the forked thread stays loaded and falls back to the
   Codex base MCP config
   ([getpaseo/paseo#3205](https://github.com/getpaseo/paseo/issues/3205)).

Paseo does not poll Slurm or interpret the wait id. That policy stays in
`paseo-slurm`.

## Dropped in v0.8.0

Official `v0.8.0` already ships these former companions. Kept only as retired
copies under [superseded/](./superseded/):

- Codex reload close-before-resume: [getpaseo/paseo#4353](https://github.com/getpaseo/paseo/pull/4353) supersedes local [#3574](https://github.com/getpaseo/paseo/pull/3574).
- Codex Fast for GPT-6 Astra: [getpaseo/paseo#4640](https://github.com/getpaseo/paseo/pull/4640) closes [#4451](https://github.com/getpaseo/paseo/issues/4451). Official support is an exact model list, not the old prefix allowlist.

## Apply

Preferred path (latest stable tag, patch `--check`, daemon packages only, global
`npm i -g` tarballs): [install-and-patch.md](./install-and-patch.md).

```bash
./scripts/install-paseo-lean.sh --check-only
./scripts/install-paseo-lean.sh
sbatch ./scripts/paseo-compute.sbatch
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

Drop `codex-rewind-runtime-mcp.patch` when upstream rewind passes runtime
`buildCodexInnerConfig()` on both legacy and paginated `thread/fork` paths
([#3205](https://github.com/getpaseo/paseo/issues/3205),
[#3579](https://github.com/getpaseo/paseo/pull/3579)).
