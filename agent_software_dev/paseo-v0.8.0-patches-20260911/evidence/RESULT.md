# v0.8.0 companion rebase checks

Upstream tag: `v0.8.0` (`b8e24677e12b226c7c38c1c3a40649daa9f1152f`)
npm `@getpaseo/cli` latest at the time of the task: `0.8.0`

## Patch apply

```
./scripts/install-paseo-lean.sh --check-only --ref v0.8.0
OK  patches/paseo/external-wait-finish-deferral.patch
OK  patches/paseo/codex-rewind-runtime-mcp.patch
PATCHES_COMPATIBLE v0.8.0 b8e24677e
```

`system-send.patch` applies on a deferral-only tree and does not re-apply on
the combined tree.

## Dropped companions (official v0.8.0)

- #4353 / release note: Codex reloads no longer fail with an active-writer error
- #4640 / release note: Codex Fast includes GPT-6 Astra

Retired files: `patches/paseo/superseded/`

## Installed global packages

`paseo --version` = `0.8.0`
`paseo send --help` lists `--system`

`~/.nvm/versions/node/v24.15.0/lib/node_modules/@getpaseo/{cli,client,server,protocol,plugin,relay,highlight}` all report `0.8.0`.

Dist markers in `@getpaseo/server`:

- `getExternalWaitIdFromLabels` in `agent-prompt.js`
- `issue #3205` in `providers/codex/rewind.js`
- `gpt-6-astra` plus `CODEX_FAST_MODE_SUPPORTED_MODELS` in `codex-feature-definitions.js` (official)
- `A persisted thread can have only one writer` in `agent-manager.js` (official #4353)

## Official skills

`updateSkills` from the installed `@getpaseo/server` 0.8.0 bundle:

- before: `drift`, op `update paseo-plugin`
- after: `up-to-date`
- homes: `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`
- `paseo-plugin` SKILL.md sha256 `e9d77d9ddc0622e1dd3904996c06a703199dbb09720b0d78b25a592409d59072`

## Compute daemon

`sbatch scripts/paseo-compute.sbatch` → job `477657` (`paseo-daemon`, PD at submit).
No previous `paseo-daemon` job was queued. Stale pidfile pointed at
`compute-0-44.local` pid `3931916`.
