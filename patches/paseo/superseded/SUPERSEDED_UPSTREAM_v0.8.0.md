# patches/paseo/superseded - dropped companions now in official v0.8.0

Official `getpaseo/paseo` `v0.8.0` (`b8e24677e`, 2026-09-10) already ships
the behavior these files used to add. They are kept only so earlier notes
and apply attempts keep resolving. Do not apply them to v0.8.0 or later.

| Retired file | Why it is retired | Replacement |
| --- | --- | --- |
| `codex-reload-close-before-resume.patch` | Local [#3574](https://github.com/getpaseo/paseo/pull/3574) was superseded by official [#4353](https://github.com/getpaseo/paseo/pull/4353). Release notes: Codex reloads no longer fail with an active-writer error. Official close-first reload plus failed-replacement recovery differs from the local `error`+`providerSessionClosed` parking. | Stock v0.8.0 `reloadAgentSessionInternal` |
| `codex-astra-fast-mode.patch` | Local prefix allowlist for `gpt-6-astra` is superseded by official [#4640](https://github.com/getpaseo/paseo/pull/4640) (closes [#4451](https://github.com/getpaseo/paseo/issues/4451)). Official Fast support is an exact model set that already includes Astra. | Stock v0.8.0 `codex-feature-definitions.ts` |

Live companions that still apply to v0.8.0 remain in `patches/paseo/`.
The lean installer no longer checks or applies these retired files.

Owner decision: 2026-09-11, during the v0.8.0 companion rebase.
Do not cite these patches as current install requirements.
