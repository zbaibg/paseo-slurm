# paseo-slurm and paseo-local

`paseo-slurm` waits for Slurm jobs outside the AI model and resumes the same
[Paseo](https://github.com/getpaseo/paseo) agent when the job reaches a terminal
state. Scheduler polling therefore consumes no model tokens.

The same package installs a separate `paseo-local` command for a long process
that is intentionally running directly on the Paseo compute node. Keeping the
commands separate makes the execution choice explicit: `paseo-local` is not a
way to bypass Slurm for production or multi-node scientific work.

This is an independent sidecar: its runtime does not embed or fork Paseo.
Parent-finish deferral (`paseo.external-wait-id`) still needs either upstream
support or the optional companion patch under `patches/paseo/` (see
[Paseo compatibility](#paseo-compatibility)).

## Requirements

- Node.js 20 or newer
- Linux `/proc` and util-linux `flock`
- Slurm `sacct`
- Paseo CLI 0.2.5 or newer
- A Paseo agent environment containing `PASEO_AGENT_ID`, or an explicit
  `--agent-id`

## Configuration

`paseo-slurm` reads `${XDG_CONFIG_HOME:-~/.config}/paseo-slurm/config.json`.
This is the only configuration location; command-line and environment
overrides are intentionally unsupported so every invocation uses the same
site-owned accounting chain. When the file is absent, the default accounting
command chain is simply `[["sacct"]]`.

Accounting queries are direct argv prefixes. The watcher appends its validated
`sacct` arguments to each prefix and tries the next command only when the
current process cannot start, times out, or exits nonzero:

```json
{
  "schema_version": 1,
  "accounting": {
    "query_commands": [
      ["sacct"],
      [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "kestrel.local", "sacct"
      ]
    ]
  }
}
```

A successful query with no terminal allocation row means the job is not yet
known to be terminal and does not invoke the fallback. The effective command
chain is copied into each registration or group record so a detached watcher
does not change behavior if the configuration file is edited later. Commands
are spawned directly without a shell.

## Install

```bash
npm install
npm run build
npm link
```

After install, **do not start Paseo on the login node**. Do not run
`paseo daemon start`, `paseo start`, `paseo daemon restart`, or
`./scripts/tmpdir_paseo_restart.sh`. Those talk to `127.0.0.1:6767` on
kestrel and will fight the compute-node daemon for the same `~/.paseo`.

Start the daemon only by submitting the compute-node job from the login node:

```bash
sbatch /home/zbai29/soft/paseo-slurm/scripts/paseo-compute.sbatch
```

The batch script refuses to run on kestrel. It also clears a leftover
`~/.paseo/paseo.pid` and any previous-job daemon still bound to
`127.0.0.1:6767` on the allocated node. Watchers spawned by `paseo-slurm`
must stay on the same compute node as that daemon so `paseo send` can resume
agents. After a patched Paseo install, load the new server the same way:
stop any leftover login-node daemon, then submit this script again (cancel the
previous `paseo-daemon` job first if one is still running).

## Wait for one local process

Use `paseo-local` only after the task has already been classified as suitable
for direct execution on the current compute node: for example, one incremental
build or a focused test in an active scientific-software development workspace.
Keep short commands in the foreground. Use `paseo-slurm` for scheduler-sized,
multi-node, production, or scientific-computation workloads.

```bash
paseo-local run \
  --cwd /scratch/zbai29/my-project \
  --stdout /scratch/zbai29/my-project/logs/ctest.out \
  --stderr /scratch/zbai29/my-project/logs/ctest.err \
  --resume-prompt "Inspect the final CTest result once." \
  -- ctest --test-dir build --output-on-failure
```

`run` launches the command once and prints `WAITING_LOCAL_TASK`. The calling
agent must end its turn immediately after that marker; it must not follow with
`sleep`, `tail`, `pgrep`, or repeated status checks. A detached, non-AI runner
waits for the process, records its exit status, waits for the agent to park, and
sends one internal system callback.

The command is executed directly as an argument array. Use an explicit
`bash -lc` only when shell syntax is genuinely required. Put noisy stdout and
stderr on node-local scratch; the default logs under the state directory are
appropriate only for small output. Useful commands are:

```text
paseo-local run [options] -- COMMAND [ARGS...]
paseo-local wait [TASK_ID]
paseo-local status [TASK_ID]
paseo-local cancel TASK_ID [--signal SIGTERM]
paseo-local recover
paseo-local abandon --wait-id ID --generation TOKEN [--agent-id ID]
                     [--paseo-bin PATH]
```

`cancel` terminates the detached process group and still emits a final
`CANCELLED` callback. State is stored beneath
`${XDG_STATE_HOME:-~/.local/state}/paseo-local`. `recover` retries callbacks for
tasks that already have a terminal result; it does not guess the outcome of an
orphaned process.

Fast local commands, including missing-script and executable-launch failures,
are observed immediately after spawn, before asynchronous state transitions.
They produce the same terminal record/callback as long commands; a child exiting
while its identity is persisted must not leave a dead `watching` record. A missing
script is still a command error (e.g. bash exit 127), not a successful job. This
fix does not automatically rerun failed commands or release a genuinely live wait.

One agent may own only one external wait at a time across `paseo-local`, a
singleton Slurm registration, and a Slurm group (including `submit` in either
mode). Creation first takes a per-agent kernel transition lock and publishes an
atomic hard-link claim beneath
`${XDG_STATE_HOME:-~/.local/state}/paseo-external-waits/claims`. Only then may it
write the state record, set the Paseo label, or spawn a controller. Existing
state files are checked under the same lock for compatibility with waits made
before claims existed.

The claim generation and a separate controller generation are persisted in
the state record. Controller check-live, replacement, generation assignment,
and PID plus Linux process-start identity persistence are one serialized
transition. Every callback label update, send, final commit, and claim release
rechecks durable ownership and controller generation while holding that lock.
A Slurm cancellation adopts the exact claim, rejects a finalizing or completed
wait, revokes the controller generation, stops the old controller when its
exact process identity is available, clears the label, commits cancellation,
and only then releases the claim. An old watcher therefore cannot clear or send
after a replacement wait acquires ownership. `paseo-local cancel` instead
keeps the same ownership while it terminates the payload and emits the final
`CANCELLED` callback. The local payload also has an exact Linux PID/start
identity; cancellation refuses an identity-less legacy record, signals only a
matching process group, and clears both fields at terminal persistence.

## Submit and wait

`submit` creates or reuses the current agent's group, generates a shell wrapper
that preserves the original script path and `#SBATCH` directives, runs
`sbatch --parsable`, captures the job ID, and registers an atomic `EXIT`
sentinel:

```bash
paseo-slurm submit --mode each \
  --resume-prompt "Inspect the build result." \
  -- build.sbatch
```

The original batch script must be on a path visible from compute nodes; do not
submit a login node's private `/tmp` file.

Before invoking `sbatch`, `submit` persists a unique pending-submission marker
while holding the group transition lock. The successful job record and removal
of that marker are one later state write. A watcher treats any marker as pending
work and cannot finalize the group. If `sbatch` times out or the submitter dies
after submission but before the job ID is recorded, inspect Slurm and the group
state, then explicitly reconcile the marker:

```text
paseo-slurm group repair GROUP_ID --submission TOKEN --job-id ID [--sentinel PATH] [--array]
paseo-slurm group repair GROUP_ID --submission TOKEN --drop-submission
```

Use `--drop-submission` only after independently establishing that no job was
created. A known nonzero `sbatch` exit removes its marker automatically; an
invocation error is retained as ambiguous.

Each successful `submit` sets the agent's reserved
`paseo.external-wait-id` label, so a compatible Paseo daemon keeps the original
parent finish subscription open without notifying the parent, starts or reuses
the group's detached non-AI watcher, and prints `WAITING_SLURM_GROUP`; the
calling agent must then end its run. Explicit `wait` remains only as a
backward-compatible recovery command for an older or manually assembled group.

The watcher uses Linux inotify directory events for low-latency sentinel
detection, with a one-second `stat` fallback for shared filesystems such as
CephFS. `sacct` runs every 60 seconds as the independent scheduler-state
backup. A job submitted with `--sentinel off` has no file signal and therefore
uses five-second `sacct` checks.

If an accounting command fails, the watcher tries the next configured command.
Terminal results obtained after the first command are reported with
`source=sacct-fallback`. A failed attempt is not retried again until the normal
accounting interval; it does not collapse into the one-second sentinel-stat
cycle.

Within one wait group, every job whose accounting check is due in the same
watcher iteration is queried together with one comma-separated `-j` argument.
The result is demultiplexed by job ID before the existing `each` or `all`
dispatch logic runs. Different agents retain separate groups, controllers,
claims, command snapshots, and callback targets; batching never crosses an
agent boundary.

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

Group add, repair, cancel, watcher item mutation, and callback finalization are
serialized by the same per-agent transition. Final delivery first commits a
non-appendable `finalizing` state, rereads the group, and recomputes finality.
It will not clear the label, complete, or release ownership while any item or
pending submission remains. An intermediate `each` callback marks only its
terminal items notified and retains the same claim and label.

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
paseo-slurm group repair GROUP_ID --submission TOKEN
                         (--job-id ID [--sentinel PATH] [--array] |
                          --drop-submission)
paseo-slurm recover
paseo-slurm cancel REGISTRATION_ID
paseo-slurm abandon --wait-id ID --generation TOKEN [--agent-id ID]
                     [--paseo-bin PATH]
```

Group state, registration state, and logs are stored beneath
`${XDG_STATE_HOME:-~/.local/state}/paseo-slurm`. `recover` and `group wait`
must run next to the compute-node daemon, not on the `kestrel` login host. The
compute launch script reattaches `watching` groups after the daemon is healthy.
Recovery
adopts an existing controller's exact claim and atomically starts at most one
replacement generation. It restarts only a watcher or a conclusively unsent
terminal callback path; it never resubmits a Slurm job or reruns a local
command.

Recovery releases a matching leftover claim when the durable record is already
conclusively `resumed`, `completed`, `cancelled`, or `abandoned`. This covers a
crash after final persistence but before release without sending twice. A
Slurm `preparing` record contains enough data to restore its label transition;
a local `preparing` record is marked `lost` and its payload is never launched by
recovery. A claim with no state record is the protected claim-before-state crash
window: `recover` reports it as `ORPHAN_EXTERNAL_WAIT` with its exact agent,
wait ID, kind, and generation, but never deletes it based on age. A `finalizing`
record, an intermediate group in `callback_ambiguous`, an interrupted
cancellation, or a submit marker whose Slurm outcome is unknown is also
intentionally not guessed. If such an active record has lost its claim,
`recover` republishes the exact generation already stored in the record and
reports it for inspection; it still never resends the callback automatically.

After checking Paseo, Slurm, and any local payload, an operator may use the
appropriate `abandon` command with the exact reported generation. Abandon
refuses a mismatched claim and refuses a state record with a live controller
(or live local payload), fences the record when present, clears the reserved
label with the recorded or supplied Paseo binary, and releases the claim. This
is a repair escape hatch, not automatic garbage collection. A missing,
mismatched, or unconfirmed release is reported as an error.

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
- `scripts/paseo-compute.sbatch` (compute-node daemon; do not start Paseo locally)
- `scripts/tmpdir_paseo_restart.sh` (refuses local restart; prints the sbatch command)
- notes: `patches/paseo/README.md` and `patches/paseo/install-and-patch.md`
- `patches/paseo/codex-rewind-runtime-mcp.patch` (pass runtime MCP on `thread/fork`, including v0.8.0 paginated rewind)

Do **not** `npm install` the full Paseo monorepo on scratch (React Native /
website workspaces are ~150k inodes). Install like this:

```bash
./scripts/install-paseo-lean.sh --check-only
./scripts/install-paseo-lean.sh
sbatch ./scripts/paseo-compute.sbatch
```

`--check-only` fetches the current stable `getpaseo/paseo` release tag and runs
`git apply --check`. If that fails, regenerate the patches; do not force-apply.
The installer never starts or restarts the daemon. After install, submit
`scripts/paseo-compute.sbatch`; never start Paseo locally. Never
`npm i -g @getpaseo/cli` from the registry: that overwrites the patched
packages.

## Safety

- Job IDs are validated before they reach `sacct`.
- External commands use argument arrays rather than shell interpolation.
- Automatic sentinels preserve the script shebang and `#SBATCH` header. Use
  `--sentinel off` for non-shell batch scripts.
- Registration files are written atomically with user-only permissions.
- Cancelling a registration stops monitoring; it does not run `scancel`.
- `paseo-local cancel` signals only the recorded local process group; it never
  calls `scancel`.

## Remaining limits

- The transition protocol requires Linux `/proc`, `flock`, and one shared
  `XDG_STATE_HOME` used by all cooperating updated `paseo-slurm` and
  `paseo-local` processes. Its filesystem must provide advisory locks and
  coherent atomic rename/link operations for every host allowed to control the
  same agent. Older binaries and a second state root are outside the fence.
- A CLI waits up to 30 seconds to acquire the per-agent transition lock. If a
  current external operation holds it longer, the contender fails safely and
  may be retried.
- Paseo label update, `paseo send`, and the local state write are separate
  external operations. A crash or timeout after a send starts but before its
  result is durably committed is ambiguous. A final callback remains
  `finalizing`; an intermediate `each` callback becomes `callback_ambiguous`.
  Recovery will not send either again, because that could duplicate a
  callback; inspect and explicitly abandon or repair it.
- If a local runner dies after launching a payload but before persisting the
  child's PID, recovery will not rerun it and cannot prove that the unrecorded
  payload stopped. Inspect the node before using `paseo-local abandon`.
- Exact PID/start identity lets cancellation terminate current controllers.
  Legacy records without a start identity are still durably generation-fenced,
  but the process is not signalled by PID because that could hit a reused PID.
- Kernel locks disappear on process death; their ordinary lock files are
  intentionally persistent and harmless. A hard-killed caller can leave a
  uniquely named readiness marker. No marker or claim is auto-deleted merely
  because it is old.
- Processes that manually edit state, delete claims, or mutate the reserved
  Paseo label outside this protocol can defeat its guarantees. `abandon` and
  group submission repair are the supported ownership-checked repair paths.
