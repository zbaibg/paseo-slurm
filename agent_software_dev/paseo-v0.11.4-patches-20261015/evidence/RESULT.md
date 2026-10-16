# v0.11.4 install markers

Source: `./scripts/install-paseo-lean.sh` on 2026-10-15, tag `v0.11.4`
(`dc5b02f7d`).

```text
paseo -> /home/zbai29/.nvm/versions/node/v24.15.0/bin/paseo
0.11.4
OK  dist markers {'deferral': True, 'codex_rewind_mcp': True, 'opus_1m': True, 'browser_download': True, 'browser_download_new_tab': True, 'git_ignored_paths': True, 'git_disable': True}
INSTALLED v0.11.4 dc5b02f7d from /var/tmp/paseo-lean
```

Worker reload on `compute-1-2`, from
`/home/zbai29/soft/paseo-rollback/restart-worker-0.11.4.log`:

```text
== 2026-10-15T20:21:24-05:00 new worker 1970459 healthy
recovered=0 recovered_groups=2 attention_required=0 orphan_claims=0
== 2026-10-15T20:24:20-05:00 done
```

Daemon log line for pid `1970459`:

```text
daemonVersion=0.11.4 module=bootstrap when=startup disabledBy=config
msg=Daemon git integration is disabled: no git or forge CLI processes, watchers or polls
```
