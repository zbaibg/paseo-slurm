# Paseo daemon git off switch and `daemon.git.ignoredPaths` companion patch

Status: committed and tested; not deployed (the Human chooses the moment)

## Current outcome and status

`patches/paseo/workspace-git-ignore.patch` has two settings:

- **Global switch (Human decision, amendment 1).** `daemon.git.enabled:
  false` (default true), or `PASEO_GIT_DISABLED=1` (1/true/yes/on; overrides
  the config), turns the daemon's git off entirely. Every path counts as
  ignored, and `utils/spawn.ts` refuses to start `git`, `gh`, `glab` or
  `tea` for any caller.
- **Per path.** Every workspace at or under `daemon.git.ignoredPaths` (or
  `PASEO_GIT_IGNORED_PATHS`) is a plain directory to the daemon.

In both cases the daemon starts no git or forge-CLI process, sets up no file
observer or git watcher, runs no refresh, fetch or PR poll, and clients see
non-git projects. The worker logs the state at startup and on each change.
Agents' own git commands are separate processes and are unaffected.

The patch applies with the three live companions in all 24 orders.
`scripts/restart-paseo-worker.sh` restarts the worker without waiting on
`paseo daemon restart`. Its `--disable-git` option writes the switch and
`--reset-git-throttle` removes the git throttle. Next action: the Human
runs the deployment below.

## Plan and source identity

- PLAN: `agent_software_dev/paseo-workspace-git-ignore-20261005/PLAN.md`
  (amendment 1: global switch)
- Upstream: `getpaseo/paseo` `v0.10.2` (`919c737c1948c5a16220307403a82e90d3e27ea0`)
- `paseo-slurm` commits:
  - `a351e22` `scripts/restart-paseo-worker.sh` and its paragraph in
    `install-and-patch.md`
  - `d4e5505` patch (per-path ignore), installer (check, apply, dist marker
    `git_ignored_paths`), `patches/paseo/README.md` item 5,
    `install-and-patch.md`
  - `b23d740` restart outcome appended to the browser-download record
  - `15333b3` this record (per-path version)
  - `6c3705f` global switch folded into the same patch; installer marker
    `git_disable`; README and install doc
  - `274a8d1` `--disable-git` and `--reset-git-throttle` in the restart script
- Patch content (relative to `packages/server/src/`):
  - new `utils/git-ignored-paths.ts`: matcher, global switch, status and
    change callback; plus its test
  - `utils/run-git-command.ts`: guard before metrics and the scheduler; with
    git off, the first stderr line says so
  - `utils/spawn.ts`: with git off, `spawnProcess`/`execCommand` refuse
    `git`, `gh`, `glab` and `tea`
  - `services/forge-cli-command.ts`: guard in the gh/glab/tea runner
  - `server/workspace-git-service.ts`: guards in `getCheckout`,
    `requestWorkingTreeWatch`, `scheduleWorkspaceObservationSetup`,
    `startWorkspaceSubscriptionTimers` and `requestWorkspaceSnapshot`
  - `server/persisted-config.ts`: `enabled` and `ignoredPaths` in the
    strict `daemon.git` schema
  - `server/bootstrap.ts`: configure at worker start; log "Daemon git
    integration is disabled: no git or forge CLI processes, watchers or
    polls" (or the ignored-paths line) at startup and on every change
  - tests in `server/workspace-git-service.test.ts` and
    `server/config-git.test.ts`
- Plan deviation: the first version had no global switch; amendment 1 added
  it.

## Where the daemon spawns git

- **Process.** Every daemon git process starts in one place:
  `utils/run-git-command.ts` `executeGitCommand` → `spawnProcess("git", …)`.
  It sits behind one global scheduler (`daemon.git.maxProcessesPerSecond` /
  `maxProcessConcurrency`; the live config has 1 and 1). The only other git
  spawn is `git --version` in diagnostics, with no cwd. Nothing passes
  `-C`, `--git-dir` or `GIT_DIR`, so the cwd decides the repository.
- **Callers through that runner:**
  - the workspace git service: snapshot facts, status, shortstat, worktree
    state, ref-derived state, PR lookup target, observation setup,
    background fetch (`workspace-git-fetch.ts`);
  - `utils/checkout-git.ts`: status, diff, branches, stashes, worktree list;
  - `checkout-diff-manager.ts`;
  - the file explorer's repository check;
  - workspace registry, provisioning and recovery (git/non-git
    classification);
  - `git-mutation-service.ts` (UI commit/push);
  - `utils/worktree.ts`;
  - the worktree setup status;
  - the plugin source manager (plugin repositories, not workspaces).
- **Triggers:**
  - each client subscription (`registerWorkspace`), with its initial
    refresh;
  - debounced refreshes from the working-tree file observer and the `.git`
    metadata watcher;
  - the 30 s observation re-ensure timer;
  - fallback polling (`not_a_git_checkout`, `watch_fallback`);
  - background fetch;
  - the forge PR status poll;
  - the workspace reconciliation pass (logged "Skipped workspace
    reconciliation after Git read failed" every 30 s on 10-05);
  - client `checkout_status`, `checkout_pr_status` and diff requests.
- **Forge CLIs.** `gh`/`glab`/`tea` run through `createForgeCliRunner` with
  the workspace cwd and run git themselves. The host auth probes use the
  daemon's own cwd.
- **Watchers.** Every observed workspace gets a working-tree watch: a
  recursive file observer, plus fallback polling for plain directories. Git
  checkouts also get a `.git` metadata watcher. On MRE_test, file-observer
  reconciliations took 63–110 s.

## What the patch disables for an ignored cwd

- The shared runner returns git's own "not a git repository" result (exit
  128) without a process, a scheduler slot or a metrics entry. Callers that
  accept 128 get that result; the others get the usual `Git command failed …
  (exit code: 128 …)` error.
- `checkout-git` therefore reports `isGit: false` (`isNotGitRepositoryError`).
- The forge runner rejects with the brand's command error (exit 128) before
  any spawn.
- In the workspace git service:
  - `requestWorkspaceSnapshot` stores and publishes `buildNotGitSnapshot(cwd)`;
  - `getCheckout` returns non-git without calling its dependency;
  - no observation setup, re-ensure timer or PR poll;
  - `requestWorkingTreeWatch` returns `{ repoRoot: null }` with no watcher.
- Reconciliation reads `getCheckout`, so the project's stored kind becomes
  `non_git`, with a path-derived project key. Removing the entry reverses
  that at the next pass.
- Matching:
  - `isSameOrDescendantPath` on the lexical path, then on the cwd's realpath;
  - the configured paths are kept and also added as realpaths;
  - relative entries and empty segments are dropped.
- Config:
  - config list ∪ env list;
  - `config.json` is reread at most every 5 s when its mtime changed;
  - a new entry stops spawns immediately;
  - watchers set up before the entry existed stop at the next worker restart.
- Commands that do not need a repository also fail in an ignored cwd, for
  example `git init` or `git clone` from the UI.

With `daemon.git.enabled: false` or `PASEO_GIT_DISABLED=1`, everything
above applies to every cwd. In addition:

- The runner's stderr starts with "Paseo daemon git integration is disabled
  (daemon.git.enabled=false or PASEO_GIT_DISABLED); git was not run",
  followed by the "not a git repository" line, which keeps workspace
  classification working. Git-sourced plugin installs therefore fail with
  that message (`plugins/managed-source.ts` clone/checkout/ls-remote go
  through the runner).
- `utils/spawn.ts` refuses `git`, `gh`, `glab` and `tea` in `spawnProcess`
  and `execCommand`, whatever the caller. This covers the diagnostics
  `git --version` and the forge host auth probes, which otherwise run only
  for a resolved remote. A refused `gh --version` makes executable
  resolution report gh as missing.
- The worker logs one line at startup and one on every change it sees.
  The change is seen by the 5 s config reread on the next git query;
  reconciliation queries every 30 s.
- Losses while git is off:
  - branch, diff and PR panels;
  - Paseo worktree creation and worktree agents;
  - git-sourced plugins;
  - UI commit/push.
- Reconciliation marks every project `non_git` and every workspace a
  `directory`. Nothing is archived, and turning git back on restores them.
- `env` beats config: `PASEO_GIT_DISABLED=1` disables git even when
  `enabled` is true. Other values leave it to the config.

## The CLI hangs during the browser_download deployment

They did not wait on git.

- **`paseo daemon restart`** confirms the replacement with
  `daemon.get_status`, using a per-attempt timeout of `min(1 s, remaining)`.
  The handler awaits `listProviderAvailability()`, one `isAvailable()` probe
  per provider. On the new worker that took 2.1–2.7 s (250 requests between
  17:35:56 and 17:42:31; 50 s once during agent reload). So the CLI never
  saw the new pid and polls up to its 600 s default.
- **`paseo daemon status`** uses 1.5 s timeouts. Its about 1-min hang
  overlapped a saturated worker and was not isolated; at 18:05 it returned
  in 3.1 s.
- **Git's indirect role.** The daemon's git queue at 1/s and concurrency 1
  explains `checkout_status` waits of 42–474 s in the same window.
- **Fix.** `scripts/restart-paseo-worker.sh`:
  - detaches with `setsid`, waits `--delay` (20 s);
  - optionally writes `daemon.git.ignoredPaths`, atomically with mode 600,
    and only if the installed dist contains `isGitIgnoredPath`;
  - sends the restart with `timeout 90 paseo daemon restart --timeout 60`
    and ignores its exit;
  - waits for a new `Paseo Daemon` child of the supervisor plus
    `/api/health`;
  - runs `paseo-local recover` and `paseo-slurm recover`;
  - logs everything to `~/soft/paseo-rollback/restart-worker-*.log`.

## Tests

Entry points and results: `evidence/RESULT.md`; full logs in `tests/output/`.

- `utils/git-ignored-paths.test.ts`, 6 tests, with a pass-through spy on
  `spawnProcess`/`execCommand`:
  - prefix vs sibling, trailing slash, `..`, relative entries;
  - symlinked cwd and symlinked configured path;
  - config ∪ env merge and the 5 s reread;
  - unconfigured;
  - a real `git init` repository that is ignored: runner rejection, the
    accepted-128 result, `getCheckoutStatus` → non-git, zero spawns and zero
    scheduler submissions; the same repository back to git after reset;
    a non-ignored directory still spawns;
  - the forge runner: no spawn when ignored, spawn otherwise.
- `server/workspace-git-service.test.ts`, 2 new tests:
  - an ignored workspace gets a non-git snapshot through subscribe,
    `getSnapshot`, `getCheckout`, `refresh`, scheduled refresh, external
    change and working-tree watch, over 10 min of fake time, with none of
    the eight injected git, watcher, fetch or forge dependencies called and
    zero repository/watch targets;
  - a sibling with the same prefix is still observed.
- `server/config-git.test.ts`, 1 new test: the strict schema accepts
  `ignoredPaths`, and the process limits are unchanged.
- Mutation checks: removing the runner guard, the snapshot short-circuit,
  the observation guard, or the schema entry each fails its test.
- Neighbouring suites (workspace git service ×4, config, persisted config,
  forge runner, git runner ×3, reconciliation ×2, bootstrap smoke): 279
  passed. Server typecheck and lint clean.
- All four live patches applied in all 24 orders.
- `npm run build:server` passes with all four applied. 283 tests passed in
  the integrated tree (new suites, browser-tools, MCP server, agent-prompt,
  bootstrap smoke).
- The dist marker check is True for all five markers.
- `install-paseo-lean.sh --check-only --ref v0.10.2` printed OK for all four
  patches and `PATCHES_COMPATIBLE v0.10.2 919c737c1`.
- The patched build's `loadConfig` accepts a copy of the live config.json
  with `ignoredPaths`. The matcher ignores
  `/home/zbai29/data/ZIF/MRE_test/agent_x`, but not `MRE-paper` or
  `soft/paseo-slurm`.
- `restart-paseo-worker.sh --dry-run`:
  - found supervisor 10580 and worker 2567403, health ok;
  - with `--set-git-ignored-paths` it refused, because the installed dist is
    still unpatched;
  - its config edit on a private copy kept every other key and set mode 600.

Amendment 1 (global switch), same tree, same entry points:

- `utils/git-ignored-paths.test.ts`, now 10 tests (4 new):
  - `enabled: false` with a real `git init` repository: status in the repo,
    a plugin-style `git clone` in another cwd, `getCheckoutStatus` (non-git)
    and the forge runner start no process (spy empty, 0 scheduler
    submissions); the clone error's second line is the "disabled" message;
    direct `execCommand("git")` and `execCommand("/usr/bin/gh")` are refused;
  - `PASEO_GIT_DISABLED=1` overrides `enabled: true`, while `0` leaves git
    on and the real repository is git again;
  - a runtime toggle false → true → false is reread after 5 s and reported
    to `onChange` exactly twice (`[true, false]`);
  - absent or `maxProcessesPerSecond` only: git stays on and spawns.
- `server/workspace-git-service.test.ts`: with `PASEO_GIT_DISABLED=1`, two
  unrelated workspaces get non-git snapshots and none of the eight injected
  dependencies is called over 10 min of fake time.
- `server/config-git.test.ts`: the strict schema accepts `enabled: false`
  next to `ignoredPaths`, and the process limits are unchanged.
- Mutation checks: removing the global short-circuit (2 tests fail), the env
  override (1), the spawn backstop (1), the schema key (1) or the change
  callback (1) each fails.
- 25 suites (the 14 above plus spawn ×3, executable resolution ×2,
  plugin managed-source, browser-tools ×3, MCP server, agent-prompt):
  550 passed, 12 skipped (platform-specific). Typecheck and lint clean.
- All four patches applied in all 24 orders again. `npm run build:server`
  passed with all four. All six dist markers are True (new: `git_disable`).
- `--check-only` printed OK for all four patches and `PATCHES_COMPATIBLE`.
- On the built dist, a copy of the live config with
  `daemon.git = {enabled: false}`:
  - `loadConfig` gives git limits 64/8;
  - the status is `{enabled: false, disabledBy: "config"}`;
  - `git status` in `soft/paseo-slurm` fails with the "disabled" line;
  - `execCommand git --version` is refused.
- `restart-paseo-worker.sh --dry-run`:
  - `--reset-git-throttle` previewed `daemon.git = {}` (mode 600);
  - `--disable-git` was refused on today's unpatched dist and wrote no
    preview;
  - the combined edit on a private copy produced `{"enabled": false}` and
    left all other keys unchanged.

## Deployment (prepared, not executed)

Amendment 1 replaces `--set-git-ignored-paths` with `--disable-git`. The
throttle reset is a separate, optional flag.

On kestrel, in `/home/zbai29/soft/paseo-slurm`:

```bash
# 0. Keep the current (browser-download) install for rollback; the installer deletes *.tgz
mkdir -p ~/soft/paseo-rollback/v0.10.2-browser-download-20261005
cp /var/tmp/paseo-lean/getpaseo-*-0.10.2.tgz ~/soft/paseo-rollback/v0.10.2-browser-download-20261005/
# 1. Must print OK for workspace-git-ignore.patch and PATCHES_COMPATIBLE v0.10.2 919c737c1
./scripts/install-paseo-lean.sh --check-only --ref v0.10.2
# 2. Must end with: OK  dist markers {..., 'git_ignored_paths': True, 'git_disable': True}
./scripts/install-paseo-lean.sh --ref v0.10.2
```

Then, right away, on `compute-1-2` (any shell; it detaches):

```bash
# 3. After 20 s: write daemon.git.enabled=false (and, optional, drop the 1/1 throttle),
#    restart the worker, confirm by pgrep + /api/health, run both recovers
~/soft/paseo-slurm/scripts/restart-paseo-worker.sh --disable-git --reset-git-throttle
# prints: detached pid=... log=~/soft/paseo-rollback/restart-worker-<time>.log
# 4. The log must show "new worker <pid> healthy", the line
#    "Daemon git integration is disabled: no git or forge CLI processes, watchers or polls"
#    and "done".
```

Omit `--reset-git-throttle` to keep the current 1/1 limits; with git off
they no longer matter.

Order matters:

- `daemon.git` is a strict schema. The old worker and an unpatched CLI
  reject a config.json that contains `enabled` or `ignoredPaths`. For
  example, `loadPersistedConfig` runs when an agent's tool catalog is
  built.
- So the key is written only after step 2 and only seconds before the
  restart, and the script refuses to write it on an unpatched install.
- Removing the throttle keys is valid under either schema.

Impact:

- Step 2 replaces the CLI and server files under the running worker for a
  few seconds.
- Step 3 interrupts every agent's in-flight turn, the coordinator's
  included. Slurm jobs and watcher processes keep running. Callbacks that
  fail in the window are re-sent by the two recover commands.
- `paseo-slurm recover` walks 1094 group records on NFS (a few minutes). It
  re-arms the 15 stale groups of archived agents listed in the
  browser-download record; those watchers stop at once.
- After the restart, every workspace shows as a plain directory: no branch,
  diff or PR panels, no Paseo worktrees, no git-sourced plugins
  (`paseo plugin ls` is empty today).
- Agents' own git is unaffected.

Rollback:

1. On `compute-1-2`, remove the keys first:
   `python3 -c 'import json,os;p=os.path.expanduser("~/.paseo/config.json");c=json.load(open(p));g=c["daemon"].get("git",{});g.pop("enabled",None);g.pop("ignoredPaths",None);t=p+".tmp";open(t,"w").write(json.dumps(c,indent=2)+"\n");os.chmod(t,0o600);os.replace(t,p)'`
   This turns git back on within 5 s even before step 2. Watchers return
   only after a restart.
2. On kestrel:
   `npm i -g ~/soft/paseo-rollback/v0.10.2-browser-download-20261005/getpaseo-{highlight,protocol,plugin,relay,client,server,cli}-0.10.2.tgz`
3. On `compute-1-2`: `~/soft/paseo-slurm/scripts/restart-paseo-worker.sh`

## Resource status

- Development ran on `compute-1-2` node-local `/var/tmp`. The integrated
  build took about 1 min; tests took seconds to minutes.
- Temporary trees `/var/tmp/paseo-gi-verify`, `/var/tmp/paseo-gi-checkonly`,
  `/var/tmp/paseo-gd-verify` and `/var/tmp/paseo-gd-checkonly` were removed.
- `/var/tmp/paseo-browser-download-dev` now holds all four patches and is
  built; delete it when no longer needed.

## Limitations and follow-up

- Not run against the live daemon. The UI result (plain directory) follows
  from the non-git snapshot and the reconciliation kind, but no desktop
  client was checked.
- Removing an entry, or turning git back on, at runtime does not restart
  observation for workspaces already open; it takes full effect after a
  worker restart.
- With git off, the reconciliation service's non-recursive project-root
  `fs.watch` (it notices a `.git` appearing) stays. It starts no process,
  and its events only trigger a reconciliation that the guards answer
  without git.
- The website's generated `paseo.config.v1.json` (editor schema) does not
  list `enabled` or `ignoredPaths`; it is not used by the daemon.
- Whether the 54 GB of LFS objects came from daemon status/diff is not
  established here; the patch only removes that possible source.
- The 15 stale `watching` groups of archived agents are candidates for an
  exact-generation `paseo-slurm abandon` by their owner.

## Deployment executed (2026-10-05 ≈ 18:40, coordinator 93805cae; Human: "做好可以部署")
- Rollback tarballs of the browser-download install: `~/soft/paseo-rollback/v0.10.2-browser-download-20261005/` (7 files).
- `--check-only`: all four patches OK, PATCHES_COMPATIBLE v0.10.2 919c737c1. Install: dist markers all True incl.
  `git_ignored_paths` and `git_disable`.
- Dry run of `restart-paseo-worker.sh --disable-git --reset-git-throttle`: supervisor 10580, worker 2567403, preview
  daemon.git={"enabled": false}, no change made. Then the real run was launched (log `~/soft/paseo-rollback/restart-worker-*.log`).
- Housekeeping before the restart: 16 stale `watching` paseo-slurm groups cancelled with `paseo-slurm group cancel` (no scancel):
  the 15 listed in the browser-download record plus `6c6081cd-group-1787928183702` (agent "MS", archived, Slurm jobs of
  2026-08-28). Remaining watching groups: 93805cae-group-1791238234191, 70bf1e30-group-1791233464788.
