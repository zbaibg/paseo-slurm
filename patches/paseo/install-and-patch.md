# Install latest stable Paseo and apply companion patches

Use this when you want a **runnable Paseo CLI/daemon**, not a full monorepo
checkout. A normal `npm install` at the Paseo repo root also pulls the Expo /
React Native / website / desktop workspaces (`lucide-react-native`, etc.) and
can add **~150k inodes** — enough to exhaust a 1M CephFS file quota.

Official npm packages are small (`@getpaseo/cli` latest is a few hundred files).
This install matches that shape: build only daemon workspaces, `npm pack`, then
`npm i -g` the tarballs.

The installer targets the **latest stable** npm release (`npm view @getpaseo/cli
version`, tag `vX.Y.Z`), not `main` / beta builds.

## Do not

- `npm i -g @getpaseo/cli` from the registry (overwrites the patched install)
- `git clone` / `npm install` Paseo onto `~/soft` or `/scratch` (inode bomb)
- `npm link` a full `paseo-build` tree
- Restart the daemon from this script (do that yourself after a smoke test)

## One-shot (recommended)

From this repo (`paseo-slurm`):

```bash
# 1) Check that patches still apply to the current stable tag
./scripts/install-paseo-lean.sh --check-only

# 2) Apply patches, build daemon packages on node-local disk, install globally
./scripts/install-paseo-lean.sh
```

Default build tree: `/var/tmp/paseo-lean` (login-node disk, not CephFS).
Override with `--src DIR` or `PASEO_LEAN_SRC`. Pin a tag with `--ref v0.10.2`
or `PASEO_LEAN_REF`.

Then load the new server **only** by submitting the compute-node job. Do not
run `paseo daemon start` or `paseo daemon restart` on kestrel. The launch
script sets `TMPDIR=/home/zbai29/soft/tmp` itself:

```bash
# cancel an existing paseo-daemon job first if one is still running.
# The launch script clears leftover ~/.paseo/paseo.pid and a still-bound :6767.
sbatch ./scripts/paseo-compute.sbatch
```

Submitting a replacement job stops the previous compute-node daemon and its
agents. Do not do it from an unattended worker.

To load a new install under a daemon that is already running on its host,
restart only the worker with `scripts/restart-paseo-worker.sh` on that host.
It detaches, sends the restart, and confirms the new worker by process table
and `/api/health`. Do not wait on `paseo daemon restart` itself: its
confirmation polls `daemon.get_status` with a 1 s timeout, and that request
awaits every provider's availability probe (about 2 s here), so the CLI can
poll until its 600 s default timeout.

## What the installer does

1. Resolve stable ref: `v$(npm view @getpaseo/cli version)` (or `--ref`).
2. Clone or `git fetch --tags` `https://github.com/getpaseo/paseo.git`.
3. `git reset --hard` that release tag so the tree is vanilla.
4. `git apply --check` on `external-wait-finish-deferral.patch` (or the
   incremental `system-send.patch` if deferral is already present), on
   `claude-opus-gateway-1m-launch.patch`, `browser-download.patch` and
   `workspace-git-ignore.patch`.
   Confirm stock rewind already passes `buildCodexInnerConfig()` into
   `thread/fork`.
5. Apply the live patches (`scripts/apply-paseo-external-wait.sh` is idempotent;
   the gateway 1M, browser-download and workspace-git-ignore patches are
   applied next).
6. Rewrite root `workspaces` to only:
   `highlight`, `plugin`, `protocol`, `client`, `server`, `relay`, `cli`
   (drops `app`, `website`, `desktop`, `expo-two-way-audio`).
   `plugin` is required from 0.5.x (`build:server-deps` builds `@getpaseo/plugin`).
7. `npm install --ignore-scripts` (skips lefthook), run `postinstall-patches.mjs`
   for the OpenCode SDK patch, then `npm run build:server`.
8. `npm pack --ignore-scripts` (skips `prepack` web-UI, which needs the app
   workspace) and `npm i -g` the daemon tarballs.

If step 4 fails, the script stops **before** touching the global CLI. Re-generate
the failing patch against the new revision. For the external-wait pair, wait for
upstream [getpaseo/paseo#3011](https://github.com/getpaseo/paseo/pull/3011) if
that is the one that no longer applies.

## Uninstall

```bash
npm uninstall -g \
  @getpaseo/cli @getpaseo/client @getpaseo/server \
  @getpaseo/relay @getpaseo/protocol @getpaseo/highlight \
  @getpaseo/plugin
```

Then run `./scripts/install-paseo-lean.sh` again (or `npm i -g @getpaseo/cli`
for an unpatched registry install).

## Smoke test

```bash
which paseo          # should be ~/.nvm/versions/node/.../bin/paseo
paseo --version      # e.g. 0.10.2 (stable, not *-beta.*)
paseo send --help    # must list --system
```

Global `@getpaseo/server` dist must contain:

- `getExternalWaitIdFromLabels` in `agent-prompt.js`
- `claudeLaunchModelId` in `providers/claude/model-manifest.js`
- `registerBrowserDownloadTool` in `agent/tools/paseo-tools.js`
- `isGitIgnoredPath` in `utils/run-git-command.js`
- `config: input.config` in `providers/codex/rewind.js` (official #5345, not a local patch)

The installer checks those markers. Stock v0.8.0 already includes Codex
close-before-resume reload (#4353) and Astra Fast (#4640). Stock v0.10.2
already includes the rewind runtime config (#5345). Those are not
companion-patch markers.

## After upstream merges

When #3011 (or equivalent, including `paseo send --system`) is on the stable
release, drop the external-wait patches and stop applying them.

`--check-only` is the way to notice that: a failed `--check` means regenerate
or delete the patch, not force-apply.

## Patch notes

See [README.md](./README.md) in this directory for what each patch does.
Do not apply a resume-MCP rebind for #3283; Codex 0.148 already honors
the overlay Paseo sends on `thread/resume` after daemon restart. Do not apply
the retired rewind patch: official #5345 already sends runtime config on both
`thread/fork` paths.

Former reload (#3574), Astra Fast (#4451), and rewind (#3205) companions are
retired under [superseded/](./superseded/).
