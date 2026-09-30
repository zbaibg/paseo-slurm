# patches/paseo/superseded - Codex rewind companion now in official v0.10.2

Official `getpaseo/paseo` `v0.10.2` (`919c737c1`, 2026-09-30) already sends
runtime Codex config on rewind. The retired file is kept so earlier notes
keep resolving. Do not apply it to v0.10.2 or later.

| Retired file | Why it is retired | Replacement |
| --- | --- | --- |
| `codex-rewind-runtime-mcp.patch` | Local overlay on `thread/fork` is superseded by official [#5345](https://github.com/getpaseo/paseo/pull/5345), which closes [#3205](https://github.com/getpaseo/paseo/issues/3205). Both the legacy rollback fork and the paginated `beforeTurnId` fork receive `buildCodexInnerConfig()`. | Stock v0.10.2 `revertCodexConversation` |

Live companions that still apply to v0.10.2 remain in `patches/paseo/`:
finish deferral, `paseo send --system`, and the gateway `[1m]` launch suffix.

Earlier v0.8.0 retirements stay in [SUPERSEDED_UPSTREAM_v0.8.0.md](./SUPERSEDED_UPSTREAM_v0.8.0.md).

Owner decision: 2026-09-29, during the v0.10.2 companion rebase.
Do not cite this patch as a current install requirement.
