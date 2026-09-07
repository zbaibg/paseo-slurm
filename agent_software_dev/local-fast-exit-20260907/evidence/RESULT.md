# Local fast-exit race fixed

Baseline: 26df381e8222d5c6f9ad31d9935eceab6a72e2c3.

Root cause: runTask spawned the payload, awaited a per-agent transition lock to
persist its PID/start identity, then subscribed to error/close. A quickly exiting
child could close during the await. Node does not replay close; the unresolved
Promise does not keep the controller alive. Both processes disappear while the
record remains watching without a terminal result, so no callback is possible.

Fix: subscribe synchronously immediately after spawn and retain that outcome
Promise across identity persistence. Missing /proc identity for an already reaped
child no longer discards its observed result; no unsafe cancellation identity is
invented. Ownership fencing/cancellation/callback uniqueness remain unchanged.

Reproduction: tests/reproduce-old.mjs runs the new missing-script regression on
the pinned baseline in isolated scratch with fake Paseo and separate state. It
fails after 5 seconds waiting for a callback (OLD_CODE_RACE_REPRODUCED). The fixed
CLI passes that scenario in ~0.37 seconds: FAILED exit127, exactly one callback.
Immediate success, immediate nonzero exit and missing executable also pass.
All 54 local/shared-wait/Slurm tests pass in10.82 seconds; no live Slurm submitted.
Raw diagnostics: tests/output/{old-regression,local-tests,full-tests,build}.log.

This fixes the observed fast-exit race, not every possible controller crash or
transport outage. Existing exact-generation recovery rules remain necessary for
unknown/lost process state; no automatic job retry or state stealing is added.
Shared Slurm transition holder observes close/error before its first await and
has no corresponding late-listener issue. No unrelated patch files changed.

The installed paseo-local symlink targets this repository's dist/src/local-cli.js;
the TypeScript build refreshed that target. No daemon restart required. A runner
already in memory retains its original code; its task state was not changed.
