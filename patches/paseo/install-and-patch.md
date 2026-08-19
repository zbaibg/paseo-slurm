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
Override with `--src DIR` or `PASEO_LEAN_SRC`. Pin a tag with `--ref v0.4.0`
or `PASEO_LEAN_REF`.

Then, when you are ready to load the new server code, restart with a durable
TMPDIR (the patches do **not** bake this in):

```bash
./scripts/tmpdir_paseo_restart.sh
# same as: TMPDIR=/home/zbai29/soft/tmp paseo daemon restart
```

Restart kills running agents. Do not do it from an unattended worker.

## What the installer does

1. Resolve stable ref: `v$(npm view @getpaseo/cli version)` (or `--ref`).
2. Clone or `git fetch --tags` `https://github.com/getpaseo/paseo.git`.
3. `git reset --hard` that release tag so the tree is vanilla.
4. `git apply --check` on `external-wait-finish-deferral.patch` (or the
   incremental `system-send.patch` if deferral is already present), on
   `codex-reload-close-before-resume.patch`, and on
   `codex-rewind-runtime-mcp.patch`.
5. Apply those patches (`scripts/apply-paseo-external-wait.sh` is idempotent;
   the Codex reload and rewind MCP patches are applied next).
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
paseo --version      # e.g. 0.4.0 (stable, not *-beta.*)
paseo send --help    # must list --system
```

Global `@getpaseo/server` dist must contain:

- `getExternalWaitIdFromLabels` in `agent-prompt.js`
- `Closing previous session before reload resume` in `agent-manager.js`
- `issue #3205` in `providers/codex/rewind.js`

The installer checks those markers.

## After upstream merges

When #3011 (or equivalent, including `paseo send --system`) is on the stable
release, drop the external-wait patches and stop applying them.

`--check-only` is the way to notice that: a failed `--check` means regenerate
or delete the patch, not force-apply.

## Patch notes

See [README.md](./README.md) in this directory for what each patch does.
`codex-rewind-runtime-mcp.patch` is the #3205 rewind/`thread/fork` fix and is
applied. Do not apply a resume-MCP rebind for #3283; Codex 0.148 already honors
the overlay Paseo sends on `thread/resume` after daemon restart.
