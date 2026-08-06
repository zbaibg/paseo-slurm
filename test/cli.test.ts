import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalWaitLabelArgs,
  buildResumePrompt,
  EXTERNAL_WAIT_ID_LABEL,
  normalizeState,
  parsePaseoAgentStatus,
  parseSacct,
  parseSentinel,
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
