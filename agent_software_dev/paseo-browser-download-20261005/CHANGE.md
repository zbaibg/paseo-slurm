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
