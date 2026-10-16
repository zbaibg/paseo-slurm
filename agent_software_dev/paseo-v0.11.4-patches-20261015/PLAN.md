# Install patched Paseo v0.11.4

Status: executed

## Task decision and program effect

Human asked to update the Paseo daemon that is already running on a compute
node, and to refresh the companion patches onto that release. npm
`@getpaseo/cli` latest is `0.11.4`. The daemon supervisor is pid `2684356`
on `compute-1-2` (started 2026-10-05, parent pid 1). Reloading it interrupts
agent turns. Other queued science jobs stay untouched.

## Compact execution brief

- Exact inputs and revisions: `getpaseo/paseo` tag `v0.11.4`
  (`dc5b02f7d`); local patches under `patches/paseo/`; installer
  `scripts/install-paseo-lean.sh`.
- Protected science and fixed Human choices: do not start Paseo on the login
  node; do not force-apply a patch that no longer matches; drop a companion
  only when v0.11.4 already ships that behavior. Keep `daemon.git.enabled`
  as already set. Reload the daemon that is already on `compute-1-2` by
  restarting its worker there. Do not submit a new `--nodelist=compute-1-2`
  job: that node is allocated, and a pending node-restricted job would block
  the FIFO queue.
- Task, evidence, and write ownership: this software-change record.
- Dependencies and sibling interfaces: `paseo-slurm` still needs finish
  deferral and `paseo send --system`. The gateway `[1m]` launch suffix and
  `browser_download` are still absent upstream. Codex rewind runtime config
  remains official (#5345).
- Completion and return conditions: live patches apply cleanly to `v0.11.4`;
  lean install finishes; `paseo --version` is `0.11.4`; `paseo send --help`
  lists `--system`; global server dist has the deferral, gateway, browser
  download, and git-ignore markers plus the upstream rewind config; the
  worker on `compute-1-2` is healthy and logs `daemonVersion` `0.11.4`.
- Amendment boundary: applying a patch whose behavior is already upstream,
  or leaving the daemon on the previous worker after the install.
