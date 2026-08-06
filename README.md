# paseo-slurm

`paseo-slurm` waits for Slurm jobs outside the AI model and resumes the same
[Paseo](https://github.com/getpaseo/paseo) agent when the job reaches a terminal
state. Scheduler polling therefore consumes no model tokens.

This is an independent sidecar. It does not patch or fork Paseo.

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

## Register a wait

Submit with `sbatch --parsable`, then register the returned job ID:

```bash
job_id=$(sbatch --parsable build.sbatch)

paseo-slurm register \
  --job-id "$job_id" \
  --sentinel "/path/to/status_${job_id}.done" \
  --interval 60 \
  --resume-prompt "Inspect the build result and continue with focused tests."
```

`register` starts a detached, non-AI watcher and immediately prints
`WAITING_SLURM`. The calling agent should then end its run. On terminal state,
the watcher executes:

```bash
paseo send "$PASEO_AGENT_ID" --prompt "<result and continuation>" --no-wait
```

The sentinel is optional. `sacct` remains the independent fallback, so a broken
wrapper cannot leave the wait hanging indefinitely.

## Commands

```text
paseo-slurm register --job-id ID [options]
paseo-slurm status [REGISTRATION_ID]
paseo-slurm recover
paseo-slurm cancel REGISTRATION_ID
```

State and logs are stored beneath
`${XDG_STATE_HOME:-~/.local/state}/paseo-slurm`. `recover` restarts missing
watchers after a login or machine restart.

## Current limitation

Paseo currently considers an agent run finished when it returns
`WAITING_SLURM`. The sidecar automatically resumes that agent, but it cannot
suppress Paseo's initial parent finish notification. Eliminating that
notification requires a native Paseo `waiting_external` lifecycle state.

## Safety

- Job IDs are validated before they reach `sacct`.
- External commands use argument arrays rather than shell interpolation.
- Registration files are written atomically with user-only permissions.
- Cancelling a registration stops monitoring; it does not run `scancel`.
