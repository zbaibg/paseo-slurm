import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  normalizeState,
  parsePaseoAgentStatus,
  parseSacct,
  parseSentinel,
  selectGroupDispatch,
  validateJobId,
} from "../src/cli.js";

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
