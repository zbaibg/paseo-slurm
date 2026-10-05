# Paseo `browser_download` companion patch and `literature-fulltext` skill

Status: executed (not deployed)

## Task decision and program effect

The Human asked, through the coordinator agent
(`93805cae-2d08-43c9-a092-aea08fe6415e`), for a daemon-side MCP tool
`browser_download` that saves a file fetched in a Paseo browser tab onto the
daemon host, and for a general skill on obtaining subscription full text.
Today the only routes are a Blob download into the Human's Mac Downloads or
about 18 base64 `browser_evaluate` calls per MB. The tool moves the whole
transfer into the daemon so the model sees only a short summary.

## Compact execution brief

- Exact inputs and revisions: `getpaseo/paseo` tag `v0.10.2`
  (`919c737c1948c5a16220307403a82e90d3e27ea0`); live companions
  `external-wait-finish-deferral.patch` and
  `claude-opus-gateway-1m-launch.patch` at `paseo-slurm` `2a2d5ed`.
- Fixed Human choices: daemon-only change; stop and report if the desktop
  client must change. Do not install over the running global Paseo and do not
  restart the daemon on `compute-1-2`; prepare deployment steps and a live
  smoke test for the Human. No live test against the Human's browser. Commit
  in `paseo-slurm`, one logical change per commit, no push. The skill stays
  general (no project details).
- Tool requirements: URL or current tab, `browserId`, destination path,
  overwrite flag, optional new-tab mode, size limit and expected magic.
  In-page fetch with credentials, page-scoped buffer, in-page SHA-256, chunked
  base64 reads sized below the evaluate limit, daemon-side size and SHA-256
  checks, atomic write, buffer freed. Allowlisted destinations (default agent
  cwd), overwrite refusal, 200 MB default cap, http(s) only, no use of fetched
  content as instructions, clear error codes.
- Ownership: this record, `patches/paseo/browser-download.patch`,
  `scripts/install-paseo-lean.sh`, `patches/paseo/{README,install-and-patch}.md`,
  `skills/literature-fulltext/`.
- Completion: unit tests with a mocked broker; daemon packages build; the
  three live patches apply together; `--check-only` covers the new patch;
  commits made; deployment steps and smoke test written.
- Amendment boundary: any desktop-client change; any action on the live
  daemon or global install.

## Prospective design

- Locate the evaluate truncation in source (desktop client vs daemon) and
  size chunks from it.
- New module `packages/server/src/server/browser-tools/download.ts`,
  registered from `paseo-tools.ts` next to the stock browser tools, using only
  existing broker commands (`evaluate`, `new_tab`, `navigate`, `close_tab`).
  Keep `registerBrowserTools` unchanged so the stock tool list test stays.
- Configuration under `daemon.browserTools.download` in `config.json` (the
  persisted schema is `passthrough`), read per call; no protocol change.
- Tests: a fake broker that runs the real in-page scripts against a fake page
  (fake `fetch` with same-origin rule, real WebCrypto) and reproduces the
  desktop 80,000-character cap; real temporary directories for the
  filesystem. Extend the MCP catalog test for enabled/disabled listing.

## Execution route and implementation freedom

- Development tree: node-local `/var/tmp/paseo-browser-download-dev` on
  `compute-1-2` (direct development host), shallow clone of the tag with the
  installer's workspace trim. The kestrel lean tree `/var/tmp/paseo-lean` was
  read only, to keep the login node light and the install tree untouched.

## Exact recovery pointers

- Outcome record: `CHANGE.md`; evidence `evidence/RESULT.md`; live smoke
  procedure `tests/live-smoke.md`.
- Source: `patches/paseo/browser-download.patch`, `skills/literature-fulltext/SKILL.md`.
