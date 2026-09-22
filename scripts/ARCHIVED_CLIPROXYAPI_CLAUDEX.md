paseo-slurm/gateway - Retired CLIProxyAPI/claudex wiring; replaced by Eigenwise Model Gateway.

Human decided on 2026-09-19. The installer was moved out of `scripts/` to
`scripts/archived/configure-claudex.sh` and refuses to run unless
`CLIPROXYAPI_ALLOW_ARCHIVED=1`. The start script is
`/home/zbai29/soft/cliproxyapi/archived/start-cliproxyapi.sh`.
`paseo-compute.sbatch` no longer starts or stops CLIProxyAPI and no longer
requires `cli-proxy-api` on PATH.

The last live provider JSON is
`/home/zbai29/soft/cliproxyapi/archived/paseo-providers-20260919.json`.
The install tree itself is marked at
`/home/zbai29/soft/cliproxyapi/ARCHIVED_CLIPROXYAPI_SUPERSEDED_BY_MODEL_GATEWAY.md`.

Do not re-add `claudex` or `claudex-272k` to `~/.paseo/config.json`, and do
not restore `ANTHROPIC_BASE_URL=http://127.0.0.1:8317` on a live Claude
provider. That env shadows Model Gateway.
