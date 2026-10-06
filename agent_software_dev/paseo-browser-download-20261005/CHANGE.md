# Paseo `browser_download` companion patch and `literature-fulltext` skill

Status: committed and tested; not deployed (the Human chooses the moment)

## Current outcome and status

`patches/paseo/browser-download.patch` adds a daemon-only MCP tool
`browser_download` to Paseo `v0.10.2`. No desktop-client change is needed: the
tool uses only the stock broker commands `evaluate`, `new_tab`, `navigate` and
`close_tab`. The installer checks, applies and verifies it with the existing
companions. The skill `skills/literature-fulltext/SKILL.md` is installed by
symlink. The running daemon and the global install are untouched. Next action:
the Human runs the deployment below, then `tests/live-smoke.md`.

## Plan and source identity

- Accepted PLAN.md: `agent_software_dev/paseo-browser-download-20261005/PLAN.md`
- Upstream: `getpaseo/paseo` `v0.10.2` (`919c737c1948c5a16220307403a82e90d3e27ea0`)
- `paseo-slurm` commits:
  - `cc0ff9c` patch, installer, `patches/paseo/README.md`, `install-and-patch.md`
  - `38750fb` `skills/literature-fulltext/SKILL.md`
- Patch content (relative to `packages/server/src/server/`):
  - new `browser-tools/download.ts`, `browser-tools/download.test.ts`
  - `agent/tools/paseo-tools.ts`: register the tool beside the stock browser
    tools; read `daemon.browserTools.enabled` from the config store and
    `daemon.browserTools.download` from `config.json` on every call
  - `agent/mcp-server.test.ts`: tool listed when browser tools are enabled,
    absent when disabled, and one MCP call path
- Skill install: `~/.agents/skills/literature-fulltext` →
  `/home/zbai29/soft/paseo-slurm/skills/literature-fulltext`;
  `~/.claude/skills/literature-fulltext` → `~/.agents/skills/literature-fulltext`
  (same pattern as `chtc-access`).
- Plan deviations: none. Argument names are camelCase like the stock browser
  tools: `url`, `browserId`, `path`, `overwrite`, `openInNewTab`, `maxBytes`,
  `expectMagic`, `timeoutMs`.

## Implementation and validation

Truncation: the desktop client caps an evaluate result at 80,000 JSON
characters and returns a 79,000-character preview with `truncated: true`. The
daemon does not cap it. Chunks are 57,000 bytes (76,002 JSON characters, a
multiple of 3 so only the last chunk is padded).

Flow:

1. Settings: tool disabled → `browser_disabled`; invalid
   `daemon.browserTools.download` → `download_config_invalid`; a call's
   `maxBytes` above the daemon cap → `download_invalid_input`.
2. Destination before any browser call: resolve against the agent cwd, take
   the realpath of the nearest existing ancestor (symlinks cannot escape),
   require it inside a realpath'd allowed root (`allowedRoots`, default the
   agent cwd) → `download_destination_denied`; an existing file without
   `overwrite` → `download_destination_exists`.
3. `openInNewTab`: `new_tab`, `navigate` (waits for load), fetch the tab's
   final `location.href`; the tab is always closed afterwards.
4. Start script (`evaluate`): only http(s) targets; `fetch` with
   `credentials: "include"`; status must be 200; `Content-Length` and the
   streamed body are capped; bytes kept in `window.__paseoBrowserDownloads`
   under a random token; SHA-256 via `crypto.subtle`. Returns at once; the
   daemon polls status every 250 ms until ready, error or timeout (default
   120 s, max 600 s).
5. Daemon re-checks the reported size against the cap, checks the first 16
   bytes against `expectMagic` before reading any chunk, reads chunks four at
   a time, rejects a host-truncated chunk or a short chunk, reassembles,
   compares SHA-256, re-checks magic on the assembled bytes.
6. Write: temporary file `wx` + `fsync`, then `rename` (overwrite) or `link` +
   `unlink` (no overwrite, so a file that appeared meanwhile is not replaced).
7. The page buffer is freed in a `finally`.

The result is path, bytes, SHA-256, `hashVerified`, content type, final URL,
HTTP status, magic, chunk count and `browserId`. Page-derived text is printable
ASCII and at most 500 characters. Without `crypto.subtle` (insecure http page)
the download still completes with `hashVerified: false` and the summary says
"size verified only".

Error codes: `browser_disabled`, `browser_no_host`, `browser_tab_not_found`,
`browser_timeout` (from the broker), `browser_denied`, `download_invalid_input`,
`download_config_invalid`, `download_destination_denied`,
`download_destination_exists`, `download_cors_or_network`,
`download_http_status`, `download_too_large`, `download_timeout`,
`download_page_error`, `download_buffer_lost`, `download_chunk_truncated`,
`download_magic_mismatch`, `download_size_mismatch`, `download_hash_mismatch`,
`download_write_failed`.

Tests (patched source suite, `packages/server`, entry points and results in
`evidence/RESULT.md`):

- `src/server/browser-tools/download.test.ts`, 15 tests. The fake broker runs
  the real in-page scripts against a fake page with a same-origin `fetch` and
  real WebCrypto, and reproduces the desktop 80,000-character cap. Covered:
  three-chunk byte-exact reassembly with a summary-only result, current-tab
  mode, truncated chunk, corrupted chunk (hash), short chunk (size), no
  `crypto.subtle`, buffer lost to navigation, a page that rewrites its size,
  `openInNewTab` for a cross-origin CDN redirect (plain mode fails with
  `download_cors_or_network`), HTTP 404, magic mismatch with no chunk reads,
  size cap, missing host, disabled tools, allowlist (absolute, `..`, symlink
  escape, directory path, configured roots), overwrite refusal and
  replacement, schema (http(s) only), settings parsing.
- `src/server/agent/mcp-server.test.ts`: listing and one MCP call.
- Results: 202 passed (browser-tools + MCP server); `npm run typecheck` and
  `npm run lint` clean; `npm run build:server` passes with all three companion
  patches; mutation checks fail as expected. The pre-existing upstream failure
  in `claude/models.test.ts` also occurs on vanilla `v0.10.2`.

No live test against the Human's browser was run.

## Deployment (prepared, not executed)

The live daemon is a detached supervisor on `compute-1-2` (`Paseo Supervisor`
pid 10580 with worker `Paseo Daemon` pid 10616, started 2026-10-03 07:36,
parent pid 1), not a Slurm job. `scripts/paseo-compute.sbatch` asks for
`--exclusive` on `compute-1-2`, where science jobs `498557_8` and `498557_9`
were running at 2026-10-05 17:20, so re-submitting it would leave Paseo down
until the node is free. The steps below restart only the worker.

On kestrel, from `/home/zbai29/soft/paseo-slurm`:

```bash
# 0. Keep the installed Sept 29 tarballs for rollback (the installer deletes *.tgz)
mkdir -p ~/soft/paseo-rollback/v0.10.2-20260929
cp /var/tmp/paseo-lean/getpaseo-*-0.10.2.tgz ~/soft/paseo-rollback/v0.10.2-20260929/
# 1. Must print OK for browser-download.patch and PATCHES_COMPATIBLE v0.10.2 919c737c1
./scripts/install-paseo-lean.sh --check-only --ref v0.10.2
# 2. Build in /var/tmp/paseo-lean (about 1-2 min) and npm i -g the 7 tarballs.
#    Must end with: OK  dist markers {..., 'browser_download': True}
./scripts/install-paseo-lean.sh --ref v0.10.2
```

Then immediately on `compute-1-2`:

```bash
# 3. Restart the worker; supervisor 10580 and its environment stay
paseo daemon restart --home ~/.paseo
paseo daemon status --json
curl -sf http://127.0.0.1:6767/api/health
# 4. Re-deliver callbacks that may have failed during steps 2-3
paseo-local recover
for g in $(python3 - <<'PY'
import json
from pathlib import Path
root = Path.home() / ".local/state/paseo-slurm/groups"
for path in sorted(root.glob("*.json")) if root.is_dir() else []:
    group = json.loads(path.read_text())
    if group.get("status") == "watching":
        print(group["id"])
PY
); do paseo-slurm group wait "$g"; done
```

Optional, any time, no restart: add `"download": {"allowedRoots": [...],
"maxBytes": ...}` under `daemon.browserTools` in `~/.paseo/config.json`.

Impact on running agents:

- Step 2: `npm i -g` replaces the `paseo` CLI and the server files on the
  shared prefix while the old worker runs (seconds). A callback's
  `paseo send --system` in that window can fail; step 4 re-sends it. The old
  worker keeps its loaded code; a module it imports lazily in that window
  would come from the new files (same version, additive change).
- Step 3: the worker exits and a new one starts (seconds to a minute). Every
  agent's in-flight turn, including the coordinator's, is interrupted;
  clients and the relay reconnect. Slurm jobs and paseo-slurm watcher
  processes are separate and keep running.
- `browser_download` appears for agents created after step 3; use a new agent
  for the smoke test.

Rollback: on kestrel
`npm i -g ~/soft/paseo-rollback/v0.10.2-20260929/getpaseo-{highlight,protocol,plugin,relay,client,server,cli}-0.10.2.tgz`,
then steps 3-4 on `compute-1-2`.

Live smoke test: `tests/live-smoke.md` (arXiv 1706.03762v7; in-page SHA-256
vs tool SHA-256 vs `sha256sum`, new-tab route, three refusal codes).

## Resource status

Development and tests ran on `compute-1-2` node-local `/var/tmp` (npm install
about 3 min, `build:server` about 1 min, unit tests seconds). Kestrel was
only read (`ls`, `git log`). Temporary trees removed: `/var/tmp/paseo-bd-verify`,
`/var/tmp/paseo-bd-checkonly`. Kept for follow-up fixes:
`/var/tmp/paseo-browser-download-dev` (all three patches applied, built);
delete when no longer needed.

## Limitations and follow-up

- Untested against the real Electron host: the PDF-viewer tab in new-tab mode,
  `new_tab` without a URL, relay latency per chunk (about 57 KB per round trip,
  four in flight). A link served as an attachment makes `navigate` fail and may
  also start a download in the desktop client; new-tab mode is for links that
  open in the browser.
- The scripts run in the page's main world. Page scripts can replace `fetch`
  or `crypto.subtle` or rewrite the buffer. The in-page hash protects the
  transport, not against a hostile page. The daemon caps size and output text
  on its side.
- Only HTTP 200 is accepted (206 and other 2xx are rejected).
- Memory: the page holds the whole file; the daemon holds about twice the file
  size while assembling (cap 200 MiB by default).
- `daemon.browserTools.download` is not part of the mutable config schema, so
  it is set by editing `config.json`. Whether a settings save from the desktop
  client keeps the extra key was not checked.
- The desktop UI has no custom rendering entry for `browser_download`
  (`paseo-tool-call-detail.ts` is client-side); it shows as a generic tool.
- If a future desktop client lowers its evaluate cap, downloads fail closed
  with `download_chunk_truncated`; adjust `BROWSER_DOWNLOAD_CHUNK_BYTES`.

## Deployment executed (2026-10-05, coordinator 93805cae, Human: "部署")
- 17:3x steps 0–2 on kestrel: rollback tarballs in `~/soft/paseo-rollback/v0.10.2-20260929/`; `--check-only` PATCHES_COMPATIBLE
  v0.10.2 919c737c1 (browser-download OK); install ended `OK dist markers {... 'browser_download': True}`; node-pty linux-x64
  prebuild present.
- Steps 3–4 launched detached over ssh (`~/soft/paseo-rollback/deploy-restart-20261005.sh`, log `deploy-restart-20261005.log`
  next to it): worker restart, health wait, reattach of watching paseo-slurm groups, `paseo-local recover`.
- Live smoke test (tests/live-smoke.md) follows with a new agent; result to be appended here.

### Restart outcome and CLI hangs (appended 2026-10-05 by the task agent)

- The worker restarted at 17:35:56 (old worker 10616, new worker 2567403 under
  supervisor 10580) and `/api/health` answered at the first poll. The
  `paseo daemon restart --home ~/.paseo` CLI never returned and was killed
  after about 6 min. `paseo daemon status --json` then hung and was killed
  after about 1 min.
- Restart hang cause (daemon log): the CLI confirms the new worker with
  `daemon.get_status` requests that time out after `min(1 s, remaining)`.
  On the new worker, all 250 of them between 17:35:56 and 17:42:31 took
  2.1–2.7 s (about 50 s at 17:38 during agent reload). The handler awaits
  `listProviderAvailability()`, one `isAvailable()` probe per provider; no
  git is involved. The CLI therefore never observed the new pid and would
  have polled to its 600 s default.
- The `status` CLI uses 1.5 s connect and request timeouts. Its hang
  coincided with a saturated worker (`project.list` 50 s,
  `fetch_agent_timeline` 63–111 s, `checkout_status` 42–474 s behind the
  1-process/s git queue) and was not isolated. At 18:05 it returned in 3.1 s
  with `workerPid 2567403`.
- Group reattach walked 1094 group records on NFS and finished at 17:52. The
  first group failed with `spawnSync paseo ETIMEDOUT`. `paseo-local recover`
  reported `recovered=0`. Log: `~/soft/paseo-rollback/deploy-restart-20261005.log`.
- Unintended run: at about 18:09, while checking options, the task agent ran
  `paseo-slurm recover --help`. `recover` has no `--help`, so it ran a real
  recovery: `recovered=0 recovered_groups=15 attention_required=0
  orphan_claims=0`. All 15 new watchers exited at once with "group callback
  stopped: agent … is archived", so no callback was delivered. These 15
  groups stay `watching` and are re-armed by every reattach or recover:
  `21d87c13-group-1787456566725`, `f5b89ff9-group-1787947047621`,
  `220b4195-group-1787971048501`, `4da592a6-group-1788660652782`,
  `335484fa-group-1788428972586`, `44cbfca7-group-1788658813743`,
  `a9465184-group-1788758718973`, `c3d60a51-group-1788975115606`,
  `06f59e81-group-1789023203735`, `1dbeb0f8-group-1789279130002`,
  `5cdf2aa5-group-1789443690244`, `c9acbd30-group-1789868992564`,
  `8c155bff-group-1790055850390`, `237c1c50-group-1790065849345`,
  `a38c5bb3-group-1790110812355`.
- Later worker restarts: use `scripts/restart-paseo-worker.sh` on the daemon
  host (commit `a351e22`).

## Live smoke test (2026-10-05, coordinator 93805cae; real Electron host, Mac client, UW network)

Run per `tests/live-smoke.md` on the deployed build (commit `cc0ff9c` patch).

- **PASS, arXiv 1706.03762v7, plain mode:** 2,215,244 B in 39 chunks. The
  SHA-256 `bdfaa68d…2df697` matched three ways: an independent in-page
  fetch with `crypto.subtle`, the tool result, and `sha256sum` on disk. The
  file starts with `%PDF-` and `pdfinfo` reports 15 pages. About 6.5 s
  including model overhead.
- **PASS, arXiv with `openInNewTab`:** same SHA-256, and the tab was closed
  afterwards.
- **PASS, refusals:** `download_destination_exists`;
  `download_magic_mismatch` on the abs page ("Nothing was written");
  `download_destination_denied` for a `/tmp` path.
- **PASS, real use (ACS, paywalled):** Bondi, J. Phys. Chem. 1964,
  `https://pubs.acs.org/jpchax/article-pdf/68/3/441/10731825/j100785a001.pdf`,
  plain mode from the article tab: 1,049,975 B in 19 chunks, hash verified.
  Cloudflare cleared by itself within a few seconds on the article page.
- **DEFECT, `openInNewTab` on the same ACS PDF URL:** failed with
  `browser_timeout` "Timed out waiting for browser tab f877a84b-… to
  register with the browser automation host" and left a tab open on
  `https://example.com/` (closed by hand).

## Defect and fix (task agent, `92380a0`)

Cause, from the desktop app's `new_tab` handler
(`packages/app/src/desktop/browser/automation/handler.ts`,
`openBrowserTabForRequest`):

- `new_tab` without a URL opens `https://example.com`. The tool called
  `new_tab` with no URL and then `navigate`.
- The app waits a fixed 5 s (`waitForBrowserRegistration`, `timeoutMs ??
  5_000`, not settable from a request) for the tab to appear in its
  automation host's tab list. It then answers `browser_timeout`, naming the
  tab, but leaves the tab open.
- The tool's cleanup ran only for a tab id it had received, so a
  timed-out tab was never closed.
- `close_tab` is handled from the app's own stores and works for a tab that
  never registered.

Fix in `browser-tools/download.ts`:

- Open the target URL directly: `new_tab {url}`, with no `navigate`.
- On a registration timeout, take the tab id from the message (validated
  against the protocol's browser id pattern) and poll `list_tabs` until it
  appears, for up to 60 s (`tabRegistrationWaitMs`).
- If the message does not name the tab, compare `list_tabs` before and
  after. Adopt new tabs on the target URL, or the single new tab
  (redirects change the URL); several unrelated new tabs are left alone.
- Wait for the page by polling `document.readyState === "complete"` with an
  http(s) `location.href`, up to `timeoutMs`; otherwise fail with
  `download_timeout`.
- Record every tab created, or named in a timeout, and close all of them in
  the tool's `finally`: on success, registration timeout, load timeout and
  transfer errors.

Tests (`download.test.ts`). The fake broker now models the app: `new_tab`
opens its URL, registration is immediate, delayed by N list polls, or
never, using the app's exact timeout message; an unregistered tab answers
tab-not-found; closes are recorded.

- 4 new tests:
  - late registration: the tab is used, then closed;
  - registration never happens: `browser_timeout`, the tab is closed,
    nothing written;
  - an unnamed timeout: the new tab from the list is closed;
  - a page that never finishes loading: `download_timeout`, the tab is
    closed.
- The existing `openInNewTab` test now also asserts `new_tab {url}` and no
  `navigate`.
- Results: 19/19 in the file; 206 in browser-tools plus the MCP server.
- Mutation checks:
  - not recording the timed-out tab: 2 tests fail;
  - `new_tab` without a URL: 2 fail;
  - no `finally` close: 4 fail.
- Typecheck and lint clean. `npm run build:server` passes with all four
  patches.
- All 24 application orders apply.
- `--check-only`: OK for all four patches.
- The new dist marker `browser_download_new_tab` is True.

Not checked on the real host: whether a 60 s wait covers slow
registrations there, and the page-load wait on a Cloudflare interstitial.
The tool fetches once the first load completes; an interstitial that
redirects later gives `download_magic_mismatch`. In that case use plain
mode from the article tab, which worked for ACS.

## Deployment of the fix (prepared, not executed)

On kestrel, in `/home/zbai29/soft/paseo-slurm`:

```bash
# 0. Keep the current install (git switch, 18:38) for rollback; the installer deletes *.tgz
mkdir -p ~/soft/paseo-rollback/v0.10.2-git-switch-20261005
cp /var/tmp/paseo-lean/getpaseo-*-0.10.2.tgz ~/soft/paseo-rollback/v0.10.2-git-switch-20261005/
# 1. Must print OK for all four patches and PATCHES_COMPATIBLE v0.10.2 919c737c1
./scripts/install-paseo-lean.sh --check-only --ref v0.10.2
# 2. Must end with: OK  dist markers {..., 'browser_download_new_tab': True, ...}
./scripts/install-paseo-lean.sh --ref v0.10.2
```

Then on `compute-1-2` (it detaches; no config change):

```bash
~/soft/paseo-slurm/scripts/restart-paseo-worker.sh
```

- The script (`51cb600`) validates config.json with the new installed
  server, plans `restart`, sends the restart in the background, SIGKILLs
  the old worker's tree if it is still alive after 30 s, confirms the new
  pid plus `/api/health`, and runs both recovers. Its log is
  `~/soft/paseo-rollback/restart-worker-<time>.log`.
- Dry run at 20:42, read-only: supervisor 2684356, worker 2684370,
  "installed server accepts the config", plan `restart`.
- The config keeps `daemon.git.enabled=false`; the schema is unchanged.

Impact: a few seconds of `npm i -g`, and one worker restart that
interrupts every agent's current turn.

After the restart, repeat `openInNewTab` on the ACS PDF URL from a new
agent. Expect `ok` with `hashVerified`, or a clear error, with no tab left
open (`browser_list_tabs`).

Rollback: on kestrel,
`npm i -g ~/soft/paseo-rollback/v0.10.2-git-switch-20261005/getpaseo-{highlight,protocol,plugin,relay,client,server,cli}-0.10.2.tgz`,
then `restart-paseo-worker.sh` on `compute-1-2`. The config keys stay
valid, since that build has the git switch.
