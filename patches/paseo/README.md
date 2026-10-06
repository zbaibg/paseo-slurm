# Optional Paseo companion patch

Temporary home for the daemon changes that `paseo-slurm` and its agents need
until upstream lands the same behavior.

| Item | Value |
| --- | --- |
| Combined patch | `external-wait-finish-deferral.patch` (deferral + `paseo send --system`) |
| Incremental patch | `system-send.patch` (only `--system`, for trees that already have deferral) |
| Gateway 1M launch | `claude-opus-gateway-1m-launch.patch` (send bare 1M catalog ids with `[1m]` only while `ANTHROPIC_BASE_URL` is a gateway) |
| Browser download | `browser-download.patch` (daemon-side `browser_download` MCP tool; the desktop client is unchanged) |
| Workspace git ignore / off | `workspace-git-ignore.patch` (`daemon.git.enabled: false` or `daemon.git.ignoredPaths`: no daemon git, forge CLI or watcher work, everywhere or in those workspaces) |
| Upstream discussion | https://github.com/getpaseo/paseo/discussions/3010 |
| Upstream draft PR | https://github.com/getpaseo/paseo/pull/3011 (closed unmerged) |
| Verified against | `getpaseo/paseo` `v0.10.2` (`919c737c1`) |
| Install | [install-and-patch.md](./install-and-patch.md) — lean CLI/daemon from latest stable |

Do not vendor a resume-MCP rebind for [getpaseo/paseo#3283](https://github.com/getpaseo/paseo/issues/3283): after daemon restart the thread is unloaded, so Paseo already sends the runtime overlay on `thread/resume`. Codex 0.148 honors that. Rewind/`thread/fork` is official since [getpaseo/paseo#5345](https://github.com/getpaseo/paseo/pull/5345) (closes [#3205](https://github.com/getpaseo/paseo/issues/3205)).

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
3. When `ANTHROPIC_BASE_URL` is a gateway rather than `api.anthropic.com`, send
   bare catalog ids whose window is already 1M — Opus 5, Opus 5.5, Fable 5,
   Fable 5.1, and Sonnet 5.5 — as `${id}[1m]`. Claude Code otherwise budgets
   those bare ids at 200k. The catalog id and the picker stay unchanged. Rows
   that are their own 200k or 1M entries, such as Sonnet 5 and Opus 4.8, are
   left unchanged. With the base URL unset or pointed at the official API, the
   id sent to Claude matches stock Paseo. The settings fallback reads
   `ANTHROPIC_BASE_URL` from the v0.10.2 Claude config directory.

4. Add the MCP tool `browser_download`, registered next to the other browser
   tools when `daemon.browserTools.enabled` is true. It fetches a URL (or the
   tab's current document) inside a Paseo browser tab with that tab's cookies,
   keeps the bytes in a page-scoped buffer, hashes them in the page
   (`crypto.subtle`), reads base64 chunks of 57,000 bytes through ordinary
   `evaluate` commands, and writes the file on the daemon host after size and
   SHA-256 checks (temporary file, then `rename`, or `link` when overwrite is
   off). The model only sees path, bytes, SHA-256, content type, final URL
   and the magic check. `openInNewTab` handles links that redirect to a signed
   cross-origin CDN URL. It opens the target URL directly with `new_tab`;
   without a URL the desktop app would open `https://example.com`. The
   desktop app stops waiting for a new tab to register after 5 s and answers
   `browser_timeout`, naming the tab and leaving it open. The tool keeps
   polling `list_tabs` for up to 60 s and waits for `document.readyState`
   to be complete. It closes every tab it opened, on success and on every
   failure path, including a tab that never registered. The desktop client caps an evaluate result at 80,000
   JSON characters, which is why chunks are 57,000 bytes (76,002 characters).

   Optional config in `~/.paseo/config.json`, read on every call:

   ```json
   { "daemon": { "browserTools": { "enabled": true,
       "download": { "allowedRoots": ["~/papers", "/scratch/me"], "maxBytes": 209715200 } } } }
   ```

   Without `allowedRoots` the only allowed root is the calling agent's cwd. A
   configured list replaces that default. `maxBytes` defaults to 200 MiB and a
   call's own `maxBytes` cannot exceed it. Error codes include
   `browser_disabled`, `browser_no_host`, `download_cors_or_network`,
   `download_http_status`, `download_magic_mismatch`, `download_hash_mismatch`,
   `download_destination_denied` and `download_destination_exists`. Agents
   created before the daemon restart do not have the tool.

5. Add `daemon.git.ignoredPaths` (absolute paths) and the environment variable
   `PASEO_GIT_IGNORED_PATHS` (colon-separated; merged with the config list).
   A workspace whose cwd is at or under one of them, after resolving
   symlinks, is a plain directory to the daemon:
   - the shared git runner answers every command there like git outside a
     repository (exit 128, `not a git repository`) without starting a
     process or taking a scheduler slot, so every caller takes its existing
     non-git path and reconciliation stores the project as `non_git`;
   - the `gh`/`glab`/`tea` runner refuses that cwd the same way;
   - the workspace git service serves a fixed non-git snapshot and sets up
     no file observer, fallback polling, repository watcher, background
     fetch or PR status poll for it.

   `daemon.git.enabled: false` (default true) or `PASEO_GIT_DISABLED=1`
   (1/true/yes/on; overrides the config) treats every path as ignored, and
   `utils/spawn.ts` then refuses to start `git`, `gh`, `glab` or `tea` for
   any caller, so diagnostics and forge host probes start nothing either.
   The worker logs one line at startup and one on each change ("Daemon git
   integration is disabled: …"). With git off, branch/diff/PR panels,
   Paseo worktree creation and git-sourced plugins are unavailable; plugin
   installs fail with "Paseo daemon git integration is disabled
   (daemon.git.enabled=false or PASEO_GIT_DISABLED); git was not run".
   Reconciliation marks every project `non_git` and every workspace a
   directory; nothing is archived, and turning git back on restores them.

   Agents' own git commands are separate processes and are not affected.
   `config.json` is reread at most every 5 s, so a changed setting stops git
   spawns without a restart; watchers set up before the change stop only at
   the next worker restart, and turning git back on takes full effect after
   a restart. `daemon.git` is a strict schema: an unpatched daemon or CLI
   rejects a `config.json` that contains `enabled` or `ignoredPaths`. A
   running unpatched worker then refuses every connection ("Invalid hello");
   this took Paseo down on 2026-10-05. Never write these keys while such a
   worker runs. `scripts/restart-paseo-worker.sh --disable-git` (or
   `--set-git-ignored-paths`) validates with the installed server and
   restarts before writing when the running worker predates the install.
   After rolling back to a build without this patch, use
   `restart-paseo-worker.sh --clear-git-keys`.

Paseo does not poll Slurm or interpret the wait id. That policy stays in
`paseo-slurm`.

## Dropped in v0.8.0

Official `v0.8.0` already ships these former companions. Kept only as retired
copies under [superseded/](./superseded/):

- Codex reload close-before-resume: [getpaseo/paseo#4353](https://github.com/getpaseo/paseo/pull/4353) supersedes local [#3574](https://github.com/getpaseo/paseo/pull/3574).
- Codex Fast for GPT-6 Astra: [getpaseo/paseo#4640](https://github.com/getpaseo/paseo/pull/4640) closes [#4451](https://github.com/getpaseo/paseo/issues/4451). Official support is an exact model list, not the old prefix allowlist.

## Dropped in v0.10.2

Official `v0.10.2` already passes `buildCodexInnerConfig()` on both Codex
rewind `thread/fork` paths ([#5345](https://github.com/getpaseo/paseo/pull/5345),
closes [#3205](https://github.com/getpaseo/paseo/issues/3205)). The local
`codex-rewind-runtime-mcp.patch` is retired under [superseded/](./superseded/).

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
