# browser_download checks

Development tree: `/var/tmp/paseo-browser-download-dev` on `compute-1-2`
(shallow clone of `v0.10.2` `919c737c1`, installer workspace trim,
`npm install --ignore-scripts` + `postinstall-patches.mjs`). Full logs:
`../tests/output/`.

## Where evaluate is truncated

Desktop client, not daemon:
`packages/desktop/src/features/browser-automation/service.ts`

```ts
const MAX_EVALUATE_RESULT_JSON_LENGTH = 80_000;
const MAX_EVALUATE_RESULT_PREVIEW_LENGTH = 79_000;
```

`JSON.stringify(value)` longer than 80,000 characters is replaced by a
79,000-character preview with `truncated: true` (both in the injected script
and again in `capEvaluateResultJson`). The daemon broker and protocol do not
cap `resultJson`. A base64 string of 57,000 bytes is 76,000 characters, 76,002
as JSON.

## Unit and integration tests

Patched tree (vanilla + `browser-download.patch`), `packages/server`:

```text
npx vitest run src/server/browser-tools/download.test.ts      14 passed (first version)
npx vitest run src/server/agent/mcp-server.test.ts src/server/browser-tools/   201 passed
npm run typecheck                                               exit 0
npm run lint -- <4 changed files>                               0 warnings, 0 errors
```

After hardening (daemon re-checks the page-reported size; page text limited to
printable ASCII), `download.test.ts` 15 passed in three consecutive runs.

Mutation checks on `download.ts`, restored afterwards:

```text
CHUNK_BYTES 57_000 -> 60_000          8 failed | 6 passed (chunks truncated by the 80,000 cap)
hash comparison disabled              1 failed (corrupted chunk test)
```

## All live patches together

Clean worktree at `919c737c1`, `git apply` in both orders:

```text
external-wait-finish-deferral, claude-opus-gateway-1m-launch, browser-download   applied
browser-download, external-wait-finish-deferral, claude-opus-gateway-1m-launch   applied
```

Dev tree with all three applied: `npm run build:server` exit 0;
`dist/server/server/browser-tools/download.js` present and
`registerBrowserDownloadTool` in `dist/server/server/agent/tools/paseo-tools.js`.

```text
vitest browser-tools/ + mcp-server + agent-prompt + claude/models   272 passed | 1 failed
vitest browser-tools/ + mcp-server (final, verbose)                 202 passed
```

The one failure, `claude/models.test.ts > omits models that require a newer
Claude Code version`, also fails on vanilla `v0.10.2` with neither the gateway
patch nor this patch applied. It is pre-existing and unrelated.

The committed patch equals `git diff` of the final development tree.

## Installer

```text
./scripts/install-paseo-lean.sh --check-only --ref v0.10.2 --src /var/tmp/paseo-bd-checkonly
OK  .../external-wait-finish-deferral.patch
OK  upstream Codex rewind runtime config (getpaseo/paseo#5345); local patch retired
OK  .../claude-opus-gateway-1m-launch.patch
OK  .../browser-download.patch
PATCHES_COMPATIBLE v0.10.2 919c737c1
```

The apply block printed `APPLIED` and then `ALREADY_APPLIED` on a second pass.
The full install (`npm i -g`) was not run.
