import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildExternalWaitLabelArgs,
  buildGroupResumePrompt,
  buildResumePrompt,
  buildSentinelWrapper,
  EXTERNAL_WAIT_ID_LABEL,
  hasArrayDirective,
  loadAccountingQueryCommands,
  normalizeState,
  parsePaseoAgentStatus,
  parsePaseoSlurmConfig,
  parseSacct,
  parseSentinel,
  querySacct,
  querySacctMany,
  selectGroupDispatch,
  validateJobId,
} from "../src/cli.js";

test("parses standalone accounting query command chains", () => {
  assert.deepEqual(
    parsePaseoSlurmConfig({
      schema_version: 1,
      accounting: {
        query_commands: [
          ["sacct"],
          ["ssh", "-o", "BatchMode=yes", "kestrel.local", "sacct"],
        ],
      },
    }),
    [
      ["sacct"],
      ["ssh", "-o", "BatchMode=yes", "kestrel.local", "sacct"],
    ],
  );
  assert.throws(
    () => parsePaseoSlurmConfig({ schema_version: 1, accounting: { query_commands: ["sacct"] } }),
    /argv array/,
  );
  assert.throws(
    () => parsePaseoSlurmConfig({ schema_version: 1, accounting: { query_command: [["sacct"]] } }),
    /unexpected accounting field/,
  );
});

test("loads only the global standalone configuration file", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-slurm-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    const configDirectory = join(directory, "paseo-slurm");
    mkdirSync(configDirectory, { recursive: true });
    const path = join(configDirectory, "config.json");
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      accounting: { query_commands: [["sacct"], ["remote-sacct"]] },
    }));
    process.env.XDG_CONFIG_HOME = directory;
    assert.deepEqual(loadAccountingQueryCommands(), [["sacct"], ["remote-sacct"]]);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("submit arms its group watcher without a separate wait command", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-slurm-submit-arm-"));
  let watcherPid: number | undefined;
  try {
    const bin = join(directory, "bin");
    const stateHome = join(directory, "state");
    mkdirSync(bin, { recursive: true });
    const fakePaseo = join(bin, "fake-paseo");
    writeFileSync(
      fakePaseo,
      "#!/usr/bin/env bash\nprintf '{}\\n'\n",
      { mode: 0o700 },
    );
    const submitCount = join(directory, "submit-count");
    writeFileSync(
      join(bin, "sbatch"),
      `#!/usr/bin/env bash\nif test -f ${JSON.stringify(submitCount)}; then printf '12346\\n'; else : >${JSON.stringify(submitCount)}; printf '12345\\n'; fi\n`,
      { mode: 0o700 },
    );
    writeFileSync(join(bin, "scontrol"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
    writeFileSync(join(bin, "sacct"), "#!/usr/bin/env bash\nprintf '12345|12345|RUNNING|0:0|00:00:01\\n'\n", { mode: 0o700 });
    const script = join(directory, "job.sbatch");
    writeFileSync(script, "#!/usr/bin/env bash\ntrue\n", { mode: 0o700 });
    const cliPath = join(process.cwd(), "dist", "src", "cli.js");
    const launched = spawnSync(
      process.execPath,
      [cliPath, "submit", "--mode", "all", "--agent-id", "agent-submit", "--paseo-bin", fakePaseo, "--", script],
      {
        encoding: "utf8",
        env: { ...process.env, XDG_STATE_HOME: stateHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /^WAITING_SLURM_GROUP /);
    const groupId = launched.stdout.match(/group_id=([^ ]+)/)?.[1];
    watcherPid = Number(launched.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    assert.ok(groupId);
    assert.ok(Number.isSafeInteger(watcherPid) && watcherPid > 0);
    const second = spawnSync(
      process.execPath,
      [cliPath, "submit", "--mode", "all", "--agent-id", "agent-submit", "--paseo-bin", fakePaseo, "--", script],
      {
        encoding: "utf8",
        env: { ...process.env, XDG_STATE_HOME: stateHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, new RegExp(`^WAITING_SLURM_GROUP group_id=${groupId} `));
    assert.match(second.stdout, new RegExp(`watcher_pid=${watcherPid}(?:\\s|$)`));
    const group = JSON.parse(
      readFileSync(join(stateHome, "paseo-slurm", "groups", `${groupId}.json`), "utf8"),
    ) as { status: string; watcherPid: number; items: Array<{ jobId: string }> };
    assert.equal(group.status, "watching");
    assert.equal(group.watcherPid, watcherPid);
    assert.deepEqual(group.items.map((item) => item.jobId), ["12345", "12346"]);
    process.kill(watcherPid, 0);
  } finally {
    if (watcherPid) {
      try { process.kill(watcherPid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("falls back to the next accounting command only when the primary invocation fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-slurm-accounting-"));
  try {
    const primary = join(directory, "primary");
    const fallback = join(directory, "fallback");
    writeFileSync(primary, "#!/usr/bin/env bash\nprintf 'local unavailable\\n' >&2\nexit 1\n", { mode: 0o700 });
    writeFileSync(
      fallback,
      "#!/usr/bin/env bash\ntest \"$1\" = remote-prefix\nprintf '474672|474672|FAILED|0:53|00:00:00\\n'\n",
      { mode: 0o700 },
    );
    assert.deepEqual(querySacct("474672", false, [[primary], [fallback, "remote-prefix"]]), {
      state: "FAILED",
      exitCode: "0:53",
      elapsed: "00:00:00",
      source: "sacct-fallback",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not fall back when the primary accounting command succeeds without a terminal row", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-slurm-accounting-pending-"));
  try {
    const primary = join(directory, "primary");
    const fallback = join(directory, "fallback");
    const fallbackMarker = join(directory, "fallback-ran");
    writeFileSync(primary, "#!/usr/bin/env bash\nprintf '474672|474672|RUNNING|0:0|00:00:01\\n'\n", { mode: 0o700 });
    writeFileSync(fallback, `#!/usr/bin/env bash\nprintf ran >${JSON.stringify(fallbackMarker)}\n`, { mode: 0o700 });
    assert.equal(querySacct("474672", false, [[primary], [fallback]]), undefined);
    assert.equal(spawnSync("test", ["-e", fallbackMarker]).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("batches multiple jobs into one fallback query and demultiplexes mixed states", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-slurm-accounting-batch-"));
  try {
    const primary = join(directory, "primary");
    const fallback = join(directory, "fallback");
    const observedArguments = join(directory, "arguments");
    writeFileSync(primary, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
    writeFileSync(
      fallback,
      [
        "#!/usr/bin/env bash",
        "arguments=$1",
        "shift",
        "printf '%s\\n' \"$*\" >\"$arguments\"",
        "printf '101|101|COMPLETED|0:0|00:00:02\\n'",
        "printf '102|102|RUNNING|0:0|00:00:01\\n'",
        "printf '103|103|FAILED|2:0|00:00:03\\n'",
      ].join("\n"),
      { mode: 0o700 },
    );
    const results = querySacctMany(
      [{ jobId: "101" }, { jobId: "102" }, { jobId: "103" }],
      [[primary], [fallback, observedArguments]],
    );
    assert.deepEqual(results.get("101"), {
      state: "COMPLETED",
      exitCode: "0:0",
      elapsed: "00:00:02",
      source: "sacct-fallback",
    });
    assert.equal(results.get("102"), undefined);
    assert.deepEqual(results.get("103"), {
      state: "FAILED",
      exitCode: "2:0",
      elapsed: "00:00:03",
      source: "sacct-fallback",
    });
    assert.match(readFileSync(observedArguments, "utf8"), /-j 101,102,103/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes decorated Slurm states", () => {
  assert.equal(normalizeState("CANCELLED by 1234"), "CANCELLED");
  assert.equal(normalizeState("COMPLETED+"), "COMPLETED");
});

test("parses an exact terminal sacct allocation", () => {
  const output = [
    "1160646|COMPLETED|0:0|00:01:42",
    "1160646.batch|COMPLETED|0:0|00:01:42",
  ].join("\n");
  assert.deepEqual(parseSacct(output, "1160646"), {
    state: "COMPLETED",
    exitCode: "0:0",
    elapsed: "00:01:42",
    source: "sacct",
  });
});

test("ignores active and step-only sacct rows", () => {
  assert.equal(parseSacct("123|RUNNING|0:0|00:00:03", "123"), undefined);
  assert.equal(parseSacct("123.batch|FAILED|2:0|00:00:03", "123"), undefined);
});

test("requires every Slurm array task to be terminal", () => {
  const active = [
    "1160897_0|1160899|COMPLETED|0:0|00:00:04",
    "1160897_1|1160900|RUNNING|0:0|00:00:03",
    "1160897_[2-4]|1160897|PENDING|0:0|00:00:00",
  ].join("\n");
  assert.equal(parseSacct(active, "1160897"), undefined);

  const completed = [
    "1160897_0|1160899|COMPLETED|0:0|00:00:04",
    "1160897_1|1160900|COMPLETED|0:0|00:00:03",
  ].join("\n");
  assert.deepEqual(parseSacct(completed, "1160897"), {
    state: "COMPLETED",
    exitCode: "0:0",
    elapsed: "00:00:04",
    source: "sacct",
  });
});

test("maps sentinel return codes to terminal states", () => {
  assert.deepEqual(parseSentinel("job_id=12\nrc=0\n"), {
    state: "COMPLETED",
    exitCode: "0:0",
    source: "sentinel",
  });
  assert.deepEqual(parseSentinel("job_id=12\nrc=2\n"), {
    state: "FAILED",
    exitCode: "2:0",
    source: "sentinel",
  });
  assert.equal(parseSentinel("job_id=12\n"), undefined);
});

test("validates Slurm allocation and array IDs", () => {
  assert.equal(validateJobId("12345"), "12345");
  assert.equal(validateJobId("12345_7"), "12345_7");
  assert.throws(() => validateJobId("123;touch /tmp/x"), /invalid Slurm job ID/);
});

test("builds a self-contained resume prompt", () => {
  const prompt = buildResumePrompt(
    { jobId: "123", resumePrompt: "Run the focused tests." },
    { state: "FAILED", exitCode: "2:0", source: "sacct", elapsed: "00:00:24" },
  );
  assert.match(prompt, /job 123/);
  assert.match(prompt, /state=FAILED/);
  assert.match(prompt, /Run the focused tests/);
});

test("builds shell-free Paseo label update arguments", () => {
  assert.deepEqual(buildExternalWaitLabelArgs("agent-123", "wait-456"), [
    "agent",
    "update",
    "agent-123",
    "--label",
    `${EXTERNAL_WAIT_ID_LABEL}=wait-456`,
    "--json",
  ]);
});

test("parses Paseo inspect output before resuming an agent", () => {
  assert.deepEqual(
    parsePaseoAgentStatus(
      JSON.stringify({
        Status: "idle",
        Archived: false,
        PendingPermissions: [{ id: "permission-1" }],
      }),
    ),
    {
      status: "idle",
      archived: false,
      pendingPermissionCount: 1,
    },
  );
});

const completedItem = {
  jobId: "101",
  status: "terminal" as const,
  result: { state: "COMPLETED", exitCode: "0:0", source: "sacct" as const },
};

test("each groups dispatch completed jobs while others remain pending", () => {
  assert.deepEqual(
    selectGroupDispatch({
      mode: "each",
      items: [completedItem, { jobId: "102", status: "pending" }],
    }),
    { items: [completedItem], final: false },
  );
});

test("pending submissions prevent group finality and support an empty final close", () => {
  assert.deepEqual(
    selectGroupDispatch({
      mode: "each",
      items: [completedItem],
      pendingSubmissions: [
        { token: "submit-1", scriptPath: "/tmp/job.sbatch", createdAt: "2026-08-30T00:00:00Z" },
      ],
    }),
    { items: [completedItem], final: false },
  );
  assert.equal(
    selectGroupDispatch({
      mode: "all",
      items: [completedItem],
      pendingSubmissions: [
        { token: "submit-1", scriptPath: "/tmp/job.sbatch", createdAt: "2026-08-30T00:00:00Z" },
      ],
    }),
    undefined,
  );
  assert.deepEqual(
    selectGroupDispatch({
      mode: "each",
      items: [{ ...completedItem, status: "notified" }],
      pendingSubmissions: [],
    }),
    { items: [], final: true },
  );
});

test("all groups wait until every job is terminal", () => {
  assert.equal(
    selectGroupDispatch({
      mode: "all",
      items: [completedItem, { jobId: "102", status: "pending" }],
    }),
    undefined,
  );
  const failedItem = {
    jobId: "102",
    status: "terminal" as const,
    result: { state: "FAILED", exitCode: "2:0", source: "sentinel" as const },
  };
  assert.deepEqual(
    selectGroupDispatch({ mode: "all", items: [completedItem, failedItem] }),
    { items: [completedItem, failedItem], final: true },
  );
});

test("group resume prompts are structured system events", () => {
  const prompt = buildGroupResumePrompt(
    { id: "group-1", mode: "each" },
    [completedItem],
    false,
  );
  assert.match(prompt, /^<paseo-system>/);
  assert.match(prompt, /intermediate each event/);
  assert.match(prompt, /job_id=101/);
  assert.match(prompt, /still running/);
  assert.match(prompt, /<\/paseo-system>$/);
});

test("builds a sentinel wrapper that preserves directives and the original script path", () => {
  const source = [
    "#!/usr/bin/env bash",
    "#SBATCH --time=00:05:00",
    "#SBATCH --job-name=smoke",
    "",
    "run_payload",
  ].join("\n");
  const wrapper = buildSentinelWrapper(
    source,
    "/project/jobs/smoke.sbatch",
    "/shared/status file.done",
  );
  assert.ok(wrapper.indexOf("#SBATCH --job-name=smoke") < wrapper.indexOf("_paseo_slurm_status="));
  assert.doesNotMatch(wrapper, /run_payload/);
  assert.match(wrapper, /trap _paseo_slurm_on_exit EXIT/);
  assert.match(wrapper, /mv "\$_paseo_slurm_tmp" "\$_paseo_slurm_status"/);
  assert.match(wrapper, /'\/usr\/bin\/env' 'bash' '\/project\/jobs\/smoke\.sbatch' "\$@"/);
});

test("rejects automatic sentinel injection for non-shell scripts", () => {
  assert.throws(
    () =>
      buildSentinelWrapper(
        "#!/usr/bin/env python3\nprint('hello')\n",
        "/project/job.py",
        "/tmp/status.done",
      ),
    /requires a shell batch script/,
  );
});

test("sentinel wrapper preserves original script identity and exit status", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-slurm-wrapper-"));
  try {
    const originalPath = join(directory, "original.sbatch");
    const observedPath = join(directory, "observed.txt");
    const sentinelPath = join(directory, "status.done");
    const source = [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$0" >${JSON.stringify(observedPath)}`,
      "exit 7",
    ].join("\n");
    writeFileSync(originalPath, source);
    const wrapperPath = join(directory, "wrapper.sbatch");
    writeFileSync(wrapperPath, buildSentinelWrapper(source, originalPath, sentinelPath), {
      mode: 0o700,
    });

    const result = spawnSync(wrapperPath, [], { encoding: "utf8" });
    assert.equal(result.status, 7);
    assert.equal(readFileSync(observedPath, "utf8").trim(), originalPath);
    assert.match(readFileSync(sentinelPath, "utf8"), /rc=7/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detects Slurm array directives only in the batch header", () => {
  assert.equal(
    hasArrayDirective("#!/bin/bash\n#SBATCH --array=0-41%10\nrun_payload\n"),
    true,
  );
  assert.equal(hasArrayDirective("#!/bin/bash\n#SBATCH -a 0-14\nrun_payload\n"), true);
  assert.equal(
    hasArrayDirective("#!/bin/bash\nrun_payload\n# SBATCH --array=0-10\n"),
    false,
  );
});
