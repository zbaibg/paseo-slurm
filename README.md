# paseo-slurm

`paseo-slurm` waits for Slurm jobs outside the AI model and resumes the same
[Paseo](https://github.com/getpaseo/paseo) agent when the job reaches a terminal
state. Scheduler polling therefore consumes no model tokens.

This is an independent sidecar: its runtime does not embed or fork Paseo.
Parent-finish deferral (`paseo.external-wait-id`) still needs either upstream
support or the optional companion patch under `patches/paseo/` (see
[Paseo compatibility](#paseo-compatibility)).

## Requirements

- Node.js 20 or newer
- Slurm `sacct`
- Paseo CLI 0.2.5 or newer
- A Paseo agent environment containing `PASEO_AGENT_ID`, or an explicit
  `--agent-id`

## Install

```bash
npm install
npm run build
npm link
```

## Submit and wait

`submit` creates or reuses the current agent's group, generates a shell wrapper
that preserves the original script path and `#SBATCH` directives, runs
`sbatch --parsable`, captures the job ID, and registers an atomic `EXIT`
sentinel:

```bash
paseo-slurm submit --mode each \
  --resume-prompt "Inspect the build result." \
  -- build.sbatch
paseo-slurm wait
```

The original batch script must be on a path visible from compute nodes; do not
submit a login node's private `/tmp` file.

The first `submit` sets the agent's reserved
`paseo.external-wait-id` label, so a compatible Paseo daemon keeps the original
parent finish subscription open without notifying the parent. `wait` starts a
detached, non-AI watcher and prints `WAITING_SLURM_GROUP`; the calling agent
must then end its run.

The watcher uses Linux inotify directory events for low-latency sentinel
detection, with a one-second `stat` fallback for shared filesystems such as
CephFS. `sacct` runs every 60 seconds as the independent scheduler-state
backup. A job submitted with `--sentinel off` has no file signal and therefore
uses five-second `sacct` checks.

Slurm arrays automatically disable the shared sentinel: one task must not mark
the whole array complete. Arrays use the allocation's authoritative `sacct`
state at five-second intervals.

On a terminal event, the watcher waits until the agent is parked and sends
internal system context:

```bash
paseo send "$PASEO_AGENT_ID" --system --prompt "<result and continuation>" --no-wait
```

This resumes the model without adding a visible user-message bubble.

## Wait groups

One agent can wait on several jobs through one group. The group owns one
`paseo.external-wait-id` label, so adding jobs does not race or overwrite parent
notification state.

`each` is the default mode. It resumes the agent when any job finishes while
other jobs continue running. Completions that arrive while the agent is busy
are coalesced into its next continuation turn:

```bash
paseo-slurm submit --mode each \
  --resume-prompt "Analyze the small-job result immediately." \
  -- small.sbatch
paseo-slurm submit \
  --resume-prompt "Analyze the large-job result." \
  -- large.sbatch
paseo-slurm wait
```

The label remains active after an intermediate `each` event, so the resumed
child can analyze that result without notifying its parent. The final event
clears the label before resuming the child; the parent is notified when that
final child turn finishes. An intermediate turn may add follow-up jobs to the
same `each` group.

Use `--mode all` when the agent should resume only after every job is terminal.
Jobs cannot be added to an `all` group after watching begins.

## Commands

```text
paseo-slurm submit [options] -- SCRIPT [ARGS...]
paseo-slurm wait
paseo-slurm register --job-id ID [options]
paseo-slurm status [REGISTRATION_ID]
paseo-slurm group create [--mode each|all] [--interval SECONDS]
paseo-slurm group add GROUP_ID --job-id ID [options]
paseo-slurm group wait GROUP_ID
paseo-slurm group status [GROUP_ID]
paseo-slurm group cancel GROUP_ID
paseo-slurm recover
paseo-slurm cancel REGISTRATION_ID
```

Group state, registration state, and logs are stored beneath
`${XDG_STATE_HOME:-~/.local/state}/paseo-slurm`. `recover` restarts missing
watchers after a login or machine restart.

## Paseo compatibility

The sidecar works with Paseo 0.2.5 and newer for token-free waiting and
automatic resume. Hidden resume (`paseo send --system`) and suppressing the
intermediate parent notification additionally require a patched Paseo daemon.
Stock `0.4.0` has neither: `send` rejects `--system`, and
`paseo.external-wait-id` is ignored.

### Optional companion patch (until upstream merges)

Until [getpaseo/paseo#3011](https://github.com/getpaseo/paseo/pull/3011) (or an
equivalent that also ships `paseo send --system`) lands, this repo vendors:

- `patches/paseo/external-wait-finish-deferral.patch` (deferral + `--system`)
- `patches/paseo/system-send.patch` (incremental `--system` only)
- `scripts/apply-paseo-external-wait.sh`
- `scripts/install-paseo-lean.sh` (latest stable tag + `--check` + lean global install)
- `scripts/tmpdir_paseo_restart.sh` (`TMPDIR=/home/zbai29/soft/tmp paseo daemon restart`)
- notes: `patches/paseo/README.md` and `patches/paseo/install-and-patch.md`
- `patches/paseo/codex-reload-close-before-resume.patch` (close old app-server before `thread/resume`)
- `patches/paseo/codex-rewind-runtime-mcp.patch` (pass runtime MCP on `thread/fork`)

Do **not** `npm install` the full Paseo monorepo on scratch (React Native /
website workspaces are ~150k inodes). Install like this:

```bash
./scripts/install-paseo-lean.sh --check-only
./scripts/install-paseo-lean.sh
./scripts/tmpdir_paseo_restart.sh   # when ready; kills running agents
```

`--check-only` fetches the current stable `getpaseo/paseo` release tag and runs
`git apply --check`. If that fails, regenerate the patches; do not force-apply.
The installer never restarts the daemon. Never `npm i -g @getpaseo/cli` from the
registry: that overwrites the patched packages.

## Safety

- Job IDs are validated before they reach `sacct`.
- External commands use argument arrays rather than shell interpolation.
- Automatic sentinels preserve the script shebang and `#SBATCH` header. Use
  `--sentinel off` for non-shell batch scripts.
- Registration files are written atomically with user-only permissions.
- Cancelling a registration stops monitoring; it does not run `scancel`.
