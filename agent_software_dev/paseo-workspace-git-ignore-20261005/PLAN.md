# Paseo `daemon.git.ignoredPaths` companion patch

Status: executed (not deployed)

## Task decision and program effect

The coordinator (`93805cae-2d08-43c9-a092-aea08fe6415e`) asked, with the
Human's approval, for a daemon switch that stops the Paseo daemon from
running git in chosen workspaces. The trigger is
`/home/zbai29/data/ZIF/MRE_test`: a huge NFS repository with millions of
untracked files and per-file Git LFS paths. Daemon `git status` there took
more than 30 s. Status and diff run the LFS clean filter. About 54 GB of
unexplained local LFS objects appeared between 10-03 and 10-05. The live
config throttles daemon git to 1 process/s at concurrency 1, so these
commands also delay every other workspace's git reads.

## Compact execution brief

- Inputs: `getpaseo/paseo` `v0.10.2` (`919c737c1`); live companions at
  `paseo-slurm` `b23d740`: external-wait, gateway 1M, browser-download.
- Fixed choices:
  - setting `daemon.git.ignoredPaths` (absolute paths, config.json,
    reloadable if practical) plus the env override `PASEO_GIT_IGNORED_PATHS`
    (colon-separated);
  - for a cwd at or under an ignored path: no daemon git process, no git
    watchers or refresh loops, shown as a plain directory;
  - agents' own git untouched;
  - a new patch `patches/paseo/workspace-git-ignore.patch` that applies with
    the three live patches in any order;
  - installer and docs updated;
  - no install or restart; deployment steps prepared, with a restart method
    that does not hang;
  - commit in paseo-slurm, no push.
- Also asked: find every daemon git spawn path, and check whether the hung
  `daemon status`/`restart` CLIs wait on them.
- Completion:
  - zero git spawns for an ignored cwd, shown by a spy on the spawn module
    and by scheduler metrics;
  - normal behaviour for other paths;
  - path edge cases: prefix vs sibling, symlinks, trailing slash;
  - config + env merge;
  - server typecheck, lint and build;
  - apply-order check of the four patches;
  - installer `--check-only`.

## Prospective design

- One guard at the shared git runner (`utils/run-git-command.ts`), so no
  caller can spawn git for an ignored cwd. It answers exactly like git
  outside a repository (exit 128, `fatal: not a git repository …`), so every
  caller, reconciliation included, takes its existing non-git path.
- The same guard in the forge CLI runner (`gh`/`glab`/`tea` run git in
  their cwd).
- In `WorkspaceGitServiceImpl`: a fixed non-git snapshot for ignored
  targets, and no observation setup, re-ensure timer, PR poll or
  working-tree watch, because plain directories also get a recursive file
  observer and fallback polling.
- A matcher module that merges config and env, resolves symlinks, rereads
  config.json at most every 5 s, and stays out of the protocol's mutable
  config schema.
- Optional global `workspaceIntegration: false`: not added. The runner guard
  is cwd-based, and a global switch would also stop the plugin source
  manager's git. `ignoredPaths: ["/"]` gives the same effect with that
  caveat stated.

## Execution route

Same node-local development tree as the browser-download task
(`/var/tmp/paseo-browser-download-dev` on `compute-1-2`), reset to vanilla
`v0.10.2` with its `node_modules` kept. The kestrel lean tree and the live
install were not touched.

## Exact recovery pointers

- Outcome: `CHANGE.md`, `evidence/RESULT.md`
- Source: `patches/paseo/workspace-git-ignore.patch`, `scripts/restart-paseo-worker.sh`

## Amendment 1 - 2026-10-05

The Human decided that the daemon's git integration is useless here and
asked for a global switch, keeping the per-path ignore as it is:

- `daemon.git.enabled` (default true; false = no git or forge process for
  any cwd) plus the env override `PASEO_GIT_DISABLED=1`;
- implemented through the same guard as `ignoredPaths`, i.e. every path
  ignored, plus a spawn-level refusal of `git`/`gh`/`glab`/`tea`;
- plugin-source git may be lost, but must fail with a clear message;
- one log line at startup and on change;
- folded into `workspace-git-ignore.patch`;
- `restart-paseo-worker.sh --disable-git` with the same safety checks, and a
  separate optional `--reset-git-throttle` (remove the 1/1 limits; defaults
  64/8);
- the deployment uses `--disable-git` instead of `--set-git-ignored-paths`.

This supersedes the design note above that rejected a global switch: losing
plugin-source git is now accepted.

Added tests:

- false → zero spawns for any cwd, including a real repository;
- env override;
- runtime toggle;
- default unchanged;
- schema;
- plus the earlier neighbouring, build, order and `--check-only` checks.

## Amendment 2 - 2026-10-05

The 18:39 deployment of `--disable-git` took Paseo down. The script wrote
the new strict key before the restart, and the old worker then refused
every connection, including the restart. The coordinator asked for:

- a reordering, so that a key the running worker cannot parse is never
  written while it lives, covering rollback too;
- a restart that does not depend on the old worker's RPC, using the
  supervisor's respawn after confirming it in code;
- a test or dry-run of the ordering;
- the incident recorded.

Not run for real, because the deployment is in effect.

