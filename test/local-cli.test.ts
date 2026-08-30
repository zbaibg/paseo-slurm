import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildExternalWaitLabelArgs,
  buildLocalResumePrompt,
  parsePaseoAgentStatus,
  type LocalTaskResult,
} from "../src/local-cli.js";

const result: LocalTaskResult = {
  state: "FAILED",
  exitCode: 7,
  signal: null,
  startedAt: "2026-08-29T12:00:00.000Z",
  finishedAt: "2026-08-29T12:00:02.500Z",
  elapsedMilliseconds: 2500,
};

test("local resume prompts are structured terminal events", () => {
  const prompt = buildLocalResumePrompt(
    {
      id: "agent-local-1",
      cwd: "/scratch/zbai29/project",
      stdoutPath: "/scratch/zbai29/project/ctest.out",
      stderrPath: "/scratch/zbai29/project/ctest.err",
      resumePrompt: "Inspect the failed tests.",
    },
    result,
  );
  assert.match(prompt, /^<paseo-system>/);
  assert.match(prompt, /state=FAILED/);
  assert.match(prompt, /exit_code=7/);
  assert.match(prompt, /Inspect the failed tests/);
  assert.match(prompt, /<\/paseo-system>$/);
});

test("local waits use the same Paseo external-wait label contract", () => {
  assert.deepEqual(buildExternalWaitLabelArgs("agent-1", "local-1"), [
    "agent",
    "update",
    "agent-1",
    "--label",
    "paseo.external-wait-id=local-1",
    "--json",
  ]);
});

test("local waits parse Paseo readiness without model polling", () => {
  assert.deepEqual(
    parsePaseoAgentStatus(
      JSON.stringify({ Status: "idle", Archived: false, PendingPermissions: [] }),
    ),
    { status: "idle", archived: false, pendingPermissionCount: 0 },
  );
});

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("timed out waiting for detached local task");
}

test("paseo-local runs once, parks the agent, and sends one terminal callback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-local-test-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "paseo-events.jsonl");
    const fakePaseo = join(directory, "fake-paseo.cjs");
    const stdoutPath = join(directory, "task.stdout");
    const stderrPath = join(directory, "task.stderr");
    writeFileSync(
      fakePaseo,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify({ Status: "idle", Archived: false, PendingPermissions: [] }));
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_PASEO_EVENTS, JSON.stringify(args) + "\\n");
process.stdout.write("{}\\n");
`,
      { mode: 0o700 },
    );
    chmodSync(fakePaseo, 0o700);
    const cliPath = join(process.cwd(), "dist", "src", "local-cli.js");
    const launched = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent-id",
        "agent-test",
        "--paseo-bin",
        fakePaseo,
        "--cwd",
        directory,
        "--stdout",
        stdoutPath,
        "--stderr",
        stderrPath,
        "--resume-prompt",
        "Read the final test result once.",
        "--",
        process.execPath,
        "-e",
        "setTimeout(() => console.log('local-complete'), 75)",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_STATE_HOME: stateHome,
          FAKE_PASEO_EVENTS: eventsPath,
        },
      },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /^WAITING_LOCAL_TASK /);
    const taskId = launched.stdout.match(/task_id=([^ ]+)/)?.[1];
    assert.ok(taskId);

    const taskPath = join(stateHome, "paseo-local", "tasks", `${taskId}.json`);
    await waitUntil(() => {
      if (!existsSync(taskPath) || !existsSync(eventsPath)) return false;
      const task = JSON.parse(readFileSync(taskPath, "utf8")) as { status: string };
      return task.status === "resumed" && readFileSync(eventsPath, "utf8").includes('"send"');
    });

    const task = JSON.parse(readFileSync(taskPath, "utf8")) as {
      status: string;
      result: LocalTaskResult;
    };
    assert.equal(task.status, "resumed");
    assert.equal(task.result.state, "COMPLETED");
    assert.equal(task.result.exitCode, 0);
    assert.match(readFileSync(stdoutPath, "utf8"), /local-complete/);
    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(events.filter((args) => args[0] === "send").length, 1);
    assert.ok(events.some((args) => args.includes("--system") && args.includes("--no-wait")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paseo-local cancellation terminates the process group and reports CANCELLED", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-local-cancel-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "paseo-events.jsonl");
    const fakePaseo = join(directory, "fake-paseo.cjs");
    writeFileSync(
      fakePaseo,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify({ Status: "idle", Archived: false, PendingPermissions: [] }));
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_PASEO_EVENTS, JSON.stringify(args) + "\\n");
process.stdout.write("{}\\n");
`,
      { mode: 0o700 },
    );
    const cliPath = join(process.cwd(), "dist", "src", "local-cli.js");
    const environment = {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      FAKE_PASEO_EVENTS: eventsPath,
    };
    const launched = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent-id",
        "agent-cancel",
        "--paseo-bin",
        fakePaseo,
        "--cwd",
        directory,
        "--",
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(launched.status, 0, launched.stderr);
    const taskId = launched.stdout.match(/task_id=([^ ]+)/)?.[1];
    assert.ok(taskId);
    const taskPath = join(stateHome, "paseo-local", "tasks", `${taskId}.json`);
    await waitUntil(() => {
      if (!existsSync(taskPath)) return false;
      const task = JSON.parse(readFileSync(taskPath, "utf8")) as { processPid?: number };
      return typeof task.processPid === "number";
    });

    const cancelled = spawnSync(process.execPath, [cliPath, "cancel", taskId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /cancel_requested=/);
    await waitUntil(() => {
      const task = JSON.parse(readFileSync(taskPath, "utf8")) as { status: string };
      return task.status === "resumed";
    });
    const task = JSON.parse(readFileSync(taskPath, "utf8")) as {
      result: LocalTaskResult;
    };
    assert.equal(task.result.state, "CANCELLED");
    assert.equal(task.result.signal, "SIGTERM");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local and Slurm waits are mutually exclusive for one agent", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-wait-exclusive-"));
  try {
    const stateHome = join(directory, "state");
    const slurmGroups = join(stateHome, "paseo-slurm", "groups");
    mkdirSync(slurmGroups, { recursive: true });
    writeFileSync(
      join(slurmGroups, "group-1.json"),
      JSON.stringify({
        id: "group-1",
        agentId: "agent-exclusive",
        status: "watching",
      }),
    );
    const localCliPath = join(process.cwd(), "dist", "src", "local-cli.js");
    const local = spawnSync(
      process.execPath,
      [localCliPath, "run", "--agent-id", "agent-exclusive", "--", process.execPath, "-v"],
      { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: stateHome } },
    );
    assert.equal(local.status, 1);
    assert.match(local.stderr, /already owns active Slurm wait group-1/);

    rmSync(join(slurmGroups, "group-1.json"));
    const localTasks = join(stateHome, "paseo-local", "tasks");
    mkdirSync(localTasks, { recursive: true });
    writeFileSync(
      join(localTasks, "local-1.json"),
      JSON.stringify({
        id: "local-1",
        agentId: "agent-exclusive",
        status: "watching",
      }),
    );
    const slurmCliPath = join(process.cwd(), "dist", "src", "cli.js");
    const slurm = spawnSync(
      process.execPath,
      [
        slurmCliPath,
        "group",
        "create",
        "--agent-id",
        "agent-exclusive",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: stateHome } },
    );
    assert.equal(slurm.status, 1);
    assert.match(slurm.stderr, /already owns active paseo-local task local-1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
