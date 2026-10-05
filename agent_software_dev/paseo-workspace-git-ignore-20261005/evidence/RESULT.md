# workspace-git-ignore checks

Development tree: `/var/tmp/paseo-browser-download-dev` on `compute-1-2`,
reset to vanilla `v0.10.2` (`919c737c1`) with the installer's workspace trim
and existing `node_modules`. Full logs: `../tests/output/`.

## New and changed tests (vanilla + this patch), `packages/server`

```text
npx vitest run src/utils/git-ignored-paths.test.ts                      6 passed
npx vitest run src/server/workspace-git-service.test.ts -t ignoredPaths 2 passed
npx vitest run src/server/config-git.test.ts                            5 passed
```

Mutation checks (each restored afterwards):

```text
runner guard removed (run-git-command.ts)            git-ignored-paths   1 failed | 5 passed
snapshot short-circuit removed                        workspace-git       1 failed | 1 passed
observation guard removed                             workspace-git       1 failed | 1 passed
ignoredPaths removed from the strict daemon.git schema config-git         1 failed | 4 passed
```

The last row also confirms that the unpatched schema rejects a config.json
with `daemon.git.ignoredPaths`.

## Neighbouring suites (`tests/output/paseo-gi-test1.log`)

```text
git-ignored-paths, workspace-git-service{,.observation,.primitive,.observation.integration},
config-git, persisted-config, forge-cli-command, run-git-command{,.posix,-trace.integration},
workspace-reconciliation-{service,observation}, bootstrap.smoke
Test Files  14 passed (14)
Tests  279 passed (279)
npm run typecheck   exit 0
npm run lint -- <9 changed files>   0 warnings, 0 errors
```

## All four live patches

```text
git apply in all 24 orders of external-wait, gateway-1m, browser-download, workspace-git-ignore:
24 of 24 applied cleanly
```

Dev tree with all four applied: `npm run build:server` exit 0. Markers in
dist: `isGitIgnoredPath` in `utils/run-git-command.js`,
`server/workspace-git-service.js` and `services/forge-cli-command.js`;
`registerBrowserDownloadTool` in `agent/tools/paseo-tools.js`.

```text
vitest git-ignored-paths, workspace-git-service, config-git, browser-tools/, mcp-server,
agent-prompt, bootstrap.smoke                       Test Files 9 passed, Tests 283 passed
installer dist-marker check on the built dist       {'deferral': True, 'codex_rewind_mcp': True,
                                                     'opus_1m': True, 'browser_download': True,
                                                     'git_ignored_paths': True}
```

## Installer

```text
./scripts/install-paseo-lean.sh --check-only --ref v0.10.2 --src /var/tmp/paseo-gi-checkonly
OK  .../external-wait-finish-deferral.patch
OK  upstream Codex rewind runtime config (getpaseo/paseo#5345); local patch retired
OK  .../claude-opus-gateway-1m-launch.patch
OK  .../browser-download.patch
OK  .../workspace-git-ignore.patch
PATCHES_COMPATIBLE v0.10.2 919c737c1
```

Apply block: `APPLIED`, then `ALREADY_APPLIED`.

## Live config and restart script (read-only)

- Patched `loadConfig` on a private copy of `~/.paseo/config.json` with
  `ignoredPaths: ["/home/zbai29/data/ZIF/MRE_test"]`: accepted; `git` stays
  `{maxProcessesPerSecond: 1, maxProcessConcurrency: 1}`.
- Matcher: `MRE_test/agent_x` true; `MRE-paper` false; `soft/paseo-slurm` false.
- `restart-paseo-worker.sh --foreground --dry-run`: supervisor 10580, worker
  2567403, health ok.
- With `--set-git-ignored-paths`: refused, "run-git-command.js lacks the
  workspace-git-ignore patch; install first, config left unchanged".
- The script's config edit on a private copy: only `daemon.git.ignoredPaths`
  added, mode 600.

## CLI hang evidence (daemon.log, 2026-10-05)

```text
daemon.get_status.request on worker 2567403, slow-request log (>1 s)
17:36  50 requests  1396–2745 ms
17:37  11           2123–2160 ms
17:38   2          49579–50700 ms
17:39–17:42  174    2125–2758 ms
same window: checkout_status_request 42–474 s, project.list 50 s,
fetch_agent_timeline 63–111 s
18:05 paseo daemon status --json: 3.1 s, workerPid 2567403
```

## Amendment 1: daemon.git.enabled=false (logs `tests/output/paseo-gd-*.log`)

```text
npx vitest run src/utils/git-ignored-paths.test.ts src/server/config-git.test.ts   15 passed
npx vitest run src/server/workspace-git-service.test.ts -t ignoredPaths             3 passed
mutations: global short-circuit 2 failed | env override 1 failed | spawn backstop 1 failed |
           schema enabled 1 failed | onChange 1 failed   (each restored)
25 suites (above + spawn x3, executable-resolution x2, managed-source.posix, browser-tools,
mcp-server, agent-prompt, reconciliation x2, run-git-command x3, bootstrap.smoke, ...)
           Test Files 25 passed; Tests 550 passed | 12 skipped
npm run typecheck exit 0; npm run lint -- <10 files> 0 warnings, 0 errors
git apply, all 24 orders of the four live patches: 24 of 24
npm run build:server (all four applied): exit 0
dist markers: deferral, codex_rewind_mcp, opus_1m, browser_download, git_ignored_paths,
git_disable all True
install-paseo-lean.sh --check-only --ref v0.10.2: OK x4, PATCHES_COMPATIBLE v0.10.2 919c737c1
```

Built dist on a private copy of the live config with `daemon.git = {"enabled": false}`:

```text
loadConfig git = {"maxProcessesPerSecond":64,"maxProcessConcurrency":8}
status {"enabled":false,"disabledBy":"config","ignoredPaths":[]}
runGitCommand in paseo-slurm -> Git command failed: git status (exit code: 128, signal: none) |
  Paseo daemon git integration is disabled (daemon.git.enabled=false or PASEO_GIT_DISABLED); git was not run
execCommand git --version -> Paseo daemon git integration is disabled (...); not starting git
```

`restart-paseo-worker.sh --foreground --dry-run`:

- `--reset-git-throttle`: preview `daemon.git = {}`, mode 600.
- `--disable-git --reset-git-throttle`: refused, "git-ignored-paths.js lacks
  PASEO_GIT_DISABLED (workspace-git-ignore patch); install first, config left
  unchanged".
