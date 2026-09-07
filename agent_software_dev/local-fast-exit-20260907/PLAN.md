# Local fast-exit callback repair

Human explicitly requests fixing paseo-slurm local-job failures after observed missing-script exit left watching state. Source src/local-cli.ts plus isolated fake-Paseo tests; do not modify active real waits, daemon state, scheduler jobs, or unrelated patches/paseo changes. User authorization covers this bounded transport repair. Main branch continuous integration.

Root cause candidate: child close/error listeners installed after asynchronous identity transition. Observe completion before any await, preserve PID/start fencing, handle already-reaped children without invented identities. Validate fast success/failure/missing script/ENOENT each yields a terminal record and exactly one callback; existing shared-claim/Slurm tests protect neighboring paths. Local compute test-only fake agents/XDG_STATE_HOME, no actual Slurm submission or messages to real users/agents. Existing real scientific task remains untouched. Build CLI only, no daemon restart.
