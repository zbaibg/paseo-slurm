import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  claimExternalWait,
  externalWaitClaimPath,
  releaseExternalWaitClaim,
  withExternalWaitTransition,
} from "../src/external-wait-claim.js";

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("timed out waiting for external-wait state");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectProcess(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const child = spawn(executable, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

function writeFakePaseo(directory: string): string {
  const path = join(directory, "fake-paseo.cjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_PASEO_EVENTS) {
  fs.appendFileSync(process.env.FAKE_PASEO_EVENTS, JSON.stringify(args) + "\\n");
}
function block(arrivedName, releaseName) {
  const arrived = process.env[arrivedName];
  const release = process.env[releaseName];
  if (!arrived || !release) return;
  fs.writeFileSync(arrived, "arrived");
  while (!fs.existsSync(release)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (args[0] === "inspect") {
  block("FAKE_INSPECT_ARRIVED", "FAKE_INSPECT_RELEASE");
  process.stdout.write(JSON.stringify({ Status: "idle", Archived: false, PendingPermissions: [] }));
} else {
  if (args[0] === "agent" && args[1] === "update" && !args.some((value) => value.endsWith("="))) {
    block("FAKE_LABEL_ARRIVED", "FAKE_LABEL_RELEASE");
  }
  if (args[0] === "send") block("FAKE_SEND_ARRIVED", "FAKE_SEND_RELEASE");
  if (args[0] === "send" && process.env.FAKE_SEND_FAIL === "1") process.exit(1);
  process.stdout.write("{}\\n");
}
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function claimPath(stateHome: string, agentId: string): string {
  const key = createHash("sha256").update(agentId).digest("hex");
  return join(stateHome, "paseo-external-waits", "claims", `${key}.json`);
}

function readEvents(path: string): string[][] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, "utf8").trim();
  return contents ? contents.split("\n").map((line) => JSON.parse(line) as string[]) : [];
}

function fakeSchedulerEnvironment(
  directory: string,
  stateHome: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  for (const command of ["scontrol", "sacct", "squeue"]) {
    const path = join(bin, command);
    writeFileSync(path, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

test("singleton registrations exclude registrations and groups in both creation orders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-registration-claim-"));
  try {
    const stateHome = join(directory, "state");
    const fakeBin = join(directory, "bin");
    mkdirSync(fakeBin);
    const fakeScontrol = join(fakeBin, "scontrol");
    writeFileSync(fakeScontrol, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
    chmodSync(fakeScontrol, 0o700);
    const environment = {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const registered = spawnSync(
      process.execPath,
      [
        cli,
        "register",
        "--agent-id",
        "agent-registration",
        "--job-id",
        "101",
        "--sacct-interval",
        "3600",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(registered.status, 0, registered.stderr);
    const registrationId = registered.stdout.match(/registration_id=([^ ]+)/)?.[1];
    const watcherPid = Number(registered.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    assert.ok(registrationId);
    assert.ok(Number.isSafeInteger(watcherPid));

    const duplicate = spawnSync(
      process.execPath,
      [
        cli,
        "register",
        "--agent-id",
        "agent-registration",
        "--job-id",
        "101",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, new RegExp(`active Slurm registration ${registrationId}`));

    const groupWhileRegistered = spawnSync(
      process.execPath,
      [
        cli,
        "group",
        "create",
        "--agent-id",
        "agent-registration",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(groupWhileRegistered.status, 1);
    assert.match(groupWhileRegistered.stderr, /active Slurm registration/);

    const cancelled = spawnSync(process.execPath, [cli, "cancel", registrationId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    await waitUntil(() => !processIsAlive(watcherPid));

    const group = spawnSync(
      process.execPath,
      [
        cli,
        "group",
        "create",
        "--agent-id",
        "agent-registration",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(group.status, 0, group.stderr);
    const groupId = group.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);

    const registrationWhileGrouped = spawnSync(
      process.execPath,
      [
        cli,
        "register",
        "--agent-id",
        "agent-registration",
        "--job-id",
        "102",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(registrationWhileGrouped.status, 1);
    assert.match(registrationWhileGrouped.stderr, new RegExp(`active Slurm wait ${groupId}`));

    const cancelledGroup = spawnSync(
      process.execPath,
      [cli, "group", "cancel", groupId],
      { encoding: "utf8", env: environment },
    );
    assert.equal(cancelledGroup.status, 0, cancelledGroup.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paseo-local and Slurm creation exclude each other in both directions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-cross-cli-claim-"));
  try {
    const stateHome = join(directory, "state");
    const environment = { ...process.env, XDG_STATE_HOME: stateHome };
    const slurmCli = join(process.cwd(), "dist", "src", "cli.js");
    const localCli = join(process.cwd(), "dist", "src", "local-cli.js");
    const fakePaseo = writeFakePaseo(directory);

    const group = spawnSync(
      process.execPath,
      [
        slurmCli,
        "group",
        "create",
        "--agent-id",
        "agent-cross-cli",
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(group.status, 0, group.stderr);
    const groupId = group.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);

    const localWhileGrouped = spawnSync(
      process.execPath,
      [
        localCli,
        "run",
        "--agent-id",
        "agent-cross-cli",
        "--paseo-bin",
        fakePaseo,
        "--cwd",
        directory,
        "--",
        process.execPath,
        "-v",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(localWhileGrouped.status, 1);
    assert.match(localWhileGrouped.stderr, new RegExp(`active Slurm wait ${groupId}`));

    const cancelledGroup = spawnSync(
      process.execPath,
      [slurmCli, "group", "cancel", groupId],
      { encoding: "utf8", env: environment },
    );
    assert.equal(cancelledGroup.status, 0, cancelledGroup.stderr);

    const local = spawnSync(
      process.execPath,
      [
        localCli,
        "run",
        "--agent-id",
        "agent-cross-cli",
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
    assert.equal(local.status, 0, local.stderr);
    const taskId = local.stdout.match(/task_id=([^ ]+)/)?.[1];
    assert.ok(taskId);
    const taskPath = join(stateHome, "paseo-local", "tasks", `${taskId}.json`);
    let payloadStart = "";
    let payloadPid = 0;
    await waitUntil(() => {
      if (!existsSync(taskPath)) return false;
      const task = JSON.parse(readFileSync(taskPath, "utf8")) as {
        processPid?: number;
        processStart?: string;
      };
      if (typeof task.processPid !== "number" || !task.processStart) return false;
      payloadPid = task.processPid;
      payloadStart = task.processStart;
      return true;
    });

    const groupWhileLocal = spawnSync(
      process.execPath,
      [
        slurmCli,
        "group",
        "create",
        "--agent-id",
        "agent-cross-cli",
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(groupWhileLocal.status, 1);
    assert.match(groupWhileLocal.stderr, new RegExp(`active paseo-local task ${taskId}`));

    const legacyTask = JSON.parse(readFileSync(taskPath, "utf8")) as Record<string, unknown>;
    delete legacyTask.processStart;
    writeFileSync(taskPath, `${JSON.stringify(legacyTask, null, 2)}\n`);
    const refusedLegacyCancel = spawnSync(process.execPath, [localCli, "cancel", taskId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(refusedLegacyCancel.status, 1);
    assert.match(refusedLegacyCancel.stderr, /without its process-start identity/);
    assert.equal(processIsAlive(payloadPid), true);
    const repairedTask = JSON.parse(readFileSync(taskPath, "utf8")) as Record<string, unknown>;
    repairedTask.processStart = payloadStart;
    writeFileSync(taskPath, `${JSON.stringify(repairedTask, null, 2)}\n`);

    const cancelledLocal = spawnSync(process.execPath, [localCli, "cancel", taskId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cancelledLocal.status, 0, cancelledLocal.stderr);
    await waitUntil(() => {
      const task = JSON.parse(readFileSync(taskPath, "utf8")) as { status: string };
      return task.status === "resumed";
    });
    const terminalTask = JSON.parse(readFileSync(taskPath, "utf8")) as {
      processPid?: number;
      processStart?: string;
    };
    assert.equal(terminalTask.processPid, undefined);
    assert.equal(terminalTask.processStart, undefined);

    const groupAfterTerminal = spawnSync(
      process.execPath,
      [
        slurmCli,
        "group",
        "create",
        "--agent-id",
        "agent-cross-cli",
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(groupAfterTerminal.status, 0, groupAfterTerminal.stderr);
    const finalGroupId = groupAfterTerminal.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(finalGroupId);
    const finalCancel = spawnSync(
      process.execPath,
      [slurmCli, "group", "cancel", finalGroupId],
      { encoding: "utf8", env: environment },
    );
    assert.equal(finalCancel.status, 0, finalCancel.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an atomic claim excludes a concurrent creator before label or state publication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-concurrent-claim-"));
  try {
    const stateHome = join(directory, "state");
    const arrivedPath = join(directory, "label-arrived");
    const releasePath = join(directory, "release-label");
    const blockingPaseo = join(directory, "blocking-paseo.cjs");
    writeFileSync(
      blockingPaseo,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PASEO_ARRIVED, "arrived");
while (!fs.existsSync(process.env.FAKE_PASEO_RELEASE)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
process.stdout.write("{}\\n");
`,
      { mode: 0o700 },
    );
    chmodSync(blockingPaseo, 0o700);
    const environment = {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      FAKE_PASEO_ARRIVED: arrivedPath,
      FAKE_PASEO_RELEASE: releasePath,
    };
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const firstResult = collectProcess(
      process.execPath,
      [
        cli,
        "group",
        "create",
        "--agent-id",
        "agent-concurrent",
        "--paseo-bin",
        blockingPaseo,
      ],
      environment,
    );
    await waitUntil(() => existsSync(arrivedPath));

    const groupsDirectory = join(stateHome, "paseo-slurm", "groups");
    const preparingFiles = existsSync(groupsDirectory)
      ? readdirSync(groupsDirectory).filter((name) => name.endsWith(".json"))
      : [];
    assert.equal(preparingFiles.length, 1);
    const preparingGroup = JSON.parse(
      readFileSync(join(groupsDirectory, preparingFiles[0]), "utf8"),
    ) as { status: string; claimGeneration?: string };
    assert.equal(preparingGroup.status, "preparing");
    assert.ok(preparingGroup.claimGeneration);
    const secondResult = collectProcess(
      process.execPath,
      [
        cli,
        "group",
        "create",
        "--agent-id",
        "agent-concurrent",
        "--paseo-bin",
        "/bin/true",
      ],
      environment,
    );
    writeFileSync(releasePath, "release");
    const [first, second] = await Promise.all([firstResult, secondResult]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already owns active Slurm wait/);
    const groupId = first.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const cancelled = spawnSync(
      process.execPath,
      [cli, "group", "cancel", groupId],
      { encoding: "utf8", env: environment },
    );
    assert.equal(cancelled.status, 0, cancelled.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery adopts one claim without rerunning an orphaned local payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-recovery-claim-"));
  try {
    const stateHome = join(directory, "state");
    const tasksDirectory = join(stateHome, "paseo-local", "tasks");
    const payloadMarker = join(directory, "payload-reran");
    mkdirSync(tasksDirectory, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(tasksDirectory, "legacy-local.json"),
      `${JSON.stringify({
        id: "legacy-local",
        agentId: "agent-recovery",
        command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(payloadMarker)}, "ran")`],
        cwd: directory,
        stdoutPath: join(directory, "legacy.stdout"),
        stderrPath: join(directory, "legacy.stderr"),
        paseoBin: "/bin/true",
        createdAt: now,
        updatedAt: now,
        status: "lost",
      }, null, 2)}\n`,
    );
    const environment = { ...process.env, XDG_STATE_HOME: stateHome };
    const localCli = join(process.cwd(), "dist", "src", "local-cli.js");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recovered = spawnSync(process.execPath, [localCli, "recover"], {
        encoding: "utf8",
        env: environment,
      });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.match(recovered.stdout, /recovered=0 attention_required=1/);
    }
    assert.equal(existsSync(payloadMarker), false);
    const claimsDirectory = join(stateHome, "paseo-external-waits", "claims");
    assert.equal(readdirSync(claimsDirectory).filter((name) => name.endsWith(".json")).length, 1);

    const slurmCli = join(process.cwd(), "dist", "src", "cli.js");
    const conflicting = spawnSync(
      process.execPath,
      [
        slurmCli,
        "group",
        "create",
        "--agent-id",
        "agent-recovery",
        "--paseo-bin",
        "/bin/true",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /active paseo-local task legacy-local/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("singleton cancellation fences a parked terminal callback before a new owner labels", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-cancel-registration-fence-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const inspectArrived = join(directory, "inspect-arrived");
    const inspectRelease = join(directory, "inspect-release");
    const sentinel = join(directory, "terminal.done");
    writeFileSync(sentinel, "job_id=501\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
      FAKE_INSPECT_ARRIVED: inspectArrived,
      FAKE_INSPECT_RELEASE: inspectRelease,
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const registered = spawnSync(
      process.execPath,
      [
        cli,
        "register",
        "--agent-id",
        "agent-cancel-registration-fence",
        "--job-id",
        "501",
        "--sentinel",
        sentinel,
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(registered.status, 0, registered.stderr);
    const registrationId = registered.stdout.match(/registration_id=([^ ]+)/)?.[1];
    const watcherPid = Number(registered.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    assert.ok(registrationId);
    assert.ok(Number.isSafeInteger(watcherPid));
    await waitUntil(() => existsSync(inspectArrived));

    const cancelled = spawnSync(process.execPath, [cli, "cancel", registrationId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const replacement = spawnSync(
      process.execPath,
      [
        cli,
        "group",
        "create",
        "--agent-id",
        "agent-cancel-registration-fence",
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(replacement.status, 0, replacement.stderr);
    const replacementId = replacement.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(replacementId);

    writeFileSync(inspectRelease, "release");
    await waitUntil(() => !processIsAlive(watcherPid));
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const events = readEvents(eventsPath);
    assert.equal(events.filter((event) => event[0] === "send").length, 0);
    const labelEvents = events.filter((event) => event[0] === "agent" && event[1] === "update");
    assert.match(labelEvents.at(-1)?.join(" ") ?? "", new RegExp(`${replacementId}$|${replacementId} `));

    const cleanup = spawnSync(process.execPath, [cli, "group", "cancel", replacementId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("group cancellation fences a parked final callback before a new owner labels", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-cancel-group-fence-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const inspectArrived = join(directory, "inspect-arrived");
    const inspectRelease = join(directory, "inspect-release");
    const sentinel = join(directory, "terminal.done");
    writeFileSync(sentinel, "job_id=601\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
      FAKE_INSPECT_ARRIVED: inspectArrived,
      FAKE_INSPECT_RELEASE: inspectRelease,
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-cancel-group-fence", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const added = spawnSync(
      process.execPath,
      [cli, "group", "add", groupId, "--job-id", "601", "--sentinel", sentinel],
      { encoding: "utf8", env: environment },
    );
    assert.equal(added.status, 0, added.stderr);
    const waiting = spawnSync(process.execPath, [cli, "group", "wait", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(waiting.status, 0, waiting.stderr);
    const watcherPid = Number(waiting.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    assert.ok(Number.isSafeInteger(watcherPid));
    await waitUntil(() => existsSync(inspectArrived));

    const cancelled = spawnSync(process.execPath, [cli, "group", "cancel", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const replacement = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-cancel-group-fence", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(replacement.status, 0, replacement.stderr);
    const replacementId = replacement.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(replacementId);

    writeFileSync(inspectRelease, "release");
    await waitUntil(() => !processIsAlive(watcherPid));
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const events = readEvents(eventsPath);
    assert.equal(events.filter((event) => event[0] === "send").length, 0);
    const labelEvents = events.filter((event) => event[0] === "agent" && event[1] === "update");
    assert.match(labelEvents.at(-1)?.join(" ") ?? "", new RegExp(`${replacementId}$|${replacementId} `));

    const cleanup = spawnSync(process.execPath, [cli, "group", "cancel", replacementId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent group wait and recover spawn only one controller generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-group-controller-generation-"));
  try {
    const stateHome = join(directory, "state");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome);
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-group-generation", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const added = spawnSync(
      process.execPath,
      [cli, "group", "add", groupId, "--job-id", "701"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(added.status, 0, added.stderr);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    const group = JSON.parse(readFileSync(groupPath, "utf8")) as Record<string, unknown>;
    group.status = "watching";
    delete group.watcherPid;
    delete group.watcherStart;
    delete group.controllerGeneration;
    writeFileSync(groupPath, `${JSON.stringify(group, null, 2)}\n`);

    const [waited, recovered] = await Promise.all([
      collectProcess(process.execPath, [cli, "group", "wait", groupId], environment),
      collectProcess(process.execPath, [cli, "recover"], environment),
    ]);
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(recovered.status, 0, recovered.stderr);
    const finalGroup = JSON.parse(readFileSync(groupPath, "utf8")) as {
      controllerGeneration?: string;
      watcherPid?: number;
    };
    assert.ok(finalGroup.controllerGeneration);
    assert.ok(finalGroup.watcherPid);
    const logPath = join(stateHome, "paseo-slurm", "logs", `${groupId}.log`);
    await waitUntil(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("watching group"));
    assert.equal(
      readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes("watching group")).length,
      1,
    );

    const cleanup = spawnSync(process.execPath, [cli, "group", "cancel", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await waitUntil(() => !processIsAlive(finalGroup.watcherPid as number));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent singleton recovery spawns only one controller generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-registration-controller-generation-"));
  try {
    const stateHome = join(directory, "state");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome);
    const agentId = "agent-registration-generation";
    const registrationId = "registration-generation-task";
    const generation = randomUUID();
    const registrations = join(stateHome, "paseo-slurm", "registrations");
    mkdirSync(registrations, { recursive: true });
    mkdirSync(join(stateHome, "paseo-external-waits", "claims"), { recursive: true });
    writeFileSync(
      claimPath(stateHome, agentId),
      `${JSON.stringify({
        agentId,
        waitId: registrationId,
        kind: "slurm-registration",
        generation,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    const now = new Date().toISOString();
    const registrationPath = join(registrations, `${registrationId}.json`);
    writeFileSync(
      registrationPath,
      `${JSON.stringify({
        id: registrationId,
        agentId,
        jobId: "711",
        intervalSeconds: 3600,
        sentinelPollSeconds: 1,
        paseoBin: fakePaseo,
        createdAt: now,
        updatedAt: now,
        status: "registered",
        claimGeneration: generation,
      }, null, 2)}\n`,
    );
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const [first, second] = await Promise.all([
      collectProcess(process.execPath, [cli, "recover"], environment),
      collectProcess(process.execPath, [cli, "recover"], environment),
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as {
      controllerGeneration?: string;
      watcherPid?: number;
    };
    assert.ok(registration.controllerGeneration);
    assert.ok(registration.watcherPid);
    const logPath = join(stateHome, "paseo-slurm", "logs", `${registrationId}.log`);
    await waitUntil(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("watching job"));
    assert.equal(
      readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes("watching job")).length,
      1,
    );
    const cleanup = spawnSync(process.execPath, [cli, "cancel", registrationId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await waitUntil(() => !processIsAlive(registration.watcherPid as number));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent local wait and recover spawn one terminal controller and one callback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-local-controller-generation-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const inspectArrived = join(directory, "inspect-arrived");
    const inspectRelease = join(directory, "inspect-release");
    const fakePaseo = writeFakePaseo(directory);
    const environment = {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      FAKE_PASEO_EVENTS: eventsPath,
      FAKE_INSPECT_ARRIVED: inspectArrived,
      FAKE_INSPECT_RELEASE: inspectRelease,
    };
    const agentId = "agent-local-generation";
    const taskId = "local-generation-task";
    const generation = randomUUID();
    const tasks = join(stateHome, "paseo-local", "tasks");
    mkdirSync(tasks, { recursive: true });
    const claimFile = claimPath(stateHome, agentId);
    mkdirSync(join(stateHome, "paseo-external-waits", "claims"), { recursive: true });
    writeFileSync(
      claimFile,
      `${JSON.stringify({ agentId, waitId: taskId, kind: "paseo-local", generation, createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
    const now = new Date().toISOString();
    const taskPath = join(tasks, `${taskId}.json`);
    writeFileSync(
      taskPath,
      `${JSON.stringify({
        id: taskId,
        agentId,
        command: [process.execPath, "-v"],
        cwd: directory,
        stdoutPath: join(directory, "stdout"),
        stderrPath: join(directory, "stderr"),
        paseoBin: fakePaseo,
        createdAt: now,
        updatedAt: now,
        status: "terminal",
        claimGeneration: generation,
        result: {
          state: "COMPLETED",
          exitCode: 0,
          signal: null,
          startedAt: now,
          finishedAt: now,
          elapsedMilliseconds: 0,
        },
      }, null, 2)}\n`,
    );
    const localCli = join(process.cwd(), "dist", "src", "local-cli.js");
    const [waited, recovered] = await Promise.all([
      collectProcess(process.execPath, [localCli, "wait", taskId], environment),
      collectProcess(process.execPath, [localCli, "recover"], environment),
    ]);
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(recovered.status, 0, recovered.stderr);
    await waitUntil(() => existsSync(inspectArrived));
    const activeTask = JSON.parse(readFileSync(taskPath, "utf8")) as {
      controllerGeneration?: string;
      runnerPid?: number;
    };
    assert.ok(activeTask.controllerGeneration);
    assert.ok(activeTask.runnerPid);
    writeFileSync(inspectRelease, "release");
    await waitUntil(() => {
      const current = JSON.parse(readFileSync(taskPath, "utf8")) as { status: string };
      return current.status === "resumed";
    });
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);
    assert.equal(existsSync(claimFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("group add before finalization forces an intermediate each callback and retains ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-group-add-before-final-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const inspectArrived = join(directory, "inspect-arrived");
    const inspectRelease = join(directory, "inspect-release");
    const sentinel = join(directory, "first.done");
    writeFileSync(sentinel, "job_id=801\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
      FAKE_INSPECT_ARRIVED: inspectArrived,
      FAKE_INSPECT_RELEASE: inspectRelease,
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-add-before-final", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.equal(created.status, 0, created.stderr);
    assert.ok(groupId);
    assert.equal(
      spawnSync(
        process.execPath,
        [cli, "group", "add", groupId, "--job-id", "801", "--sentinel", sentinel],
        { encoding: "utf8", env: environment },
      ).status,
      0,
    );
    const waiting = spawnSync(process.execPath, [cli, "group", "wait", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(waiting.status, 0, waiting.stderr);
    await waitUntil(() => existsSync(inspectArrived));

    const added = spawnSync(
      process.execPath,
      [cli, "group", "add", groupId, "--job-id", "802"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(added.status, 0, added.stderr);
    writeFileSync(inspectRelease, "release");
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    await waitUntil(() => {
      const group = JSON.parse(readFileSync(groupPath, "utf8")) as {
        items: Array<{ jobId: string; status: string }>;
      };
      return group.items.find((item) => item.jobId === "801")?.status === "notified";
    });
    const group = JSON.parse(readFileSync(groupPath, "utf8")) as {
      status: string;
      claimGeneration: string;
      items: Array<{ jobId: string; status: string }>;
    };
    assert.equal(group.status, "watching");
    assert.equal(group.items.find((item) => item.jobId === "802")?.status, "pending");
    const claim = JSON.parse(readFileSync(claimPath(stateHome, "agent-add-before-final"), "utf8")) as {
      generation: string;
    };
    assert.equal(claim.generation, group.claimGeneration);
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event[0] === "agent" && event.some((value) => value.endsWith("=")),
      ).length,
      0,
    );

    const cleanup = spawnSync(process.execPath, [cli, "group", "cancel", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ambiguous intermediate each send is fenced and never retried automatically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-each-send-ambiguous-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const sentinel = join(directory, "terminal.done");
    writeFileSync(sentinel, "job_id=831\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
      FAKE_SEND_FAIL: "1",
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-each-ambiguous", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    assert.equal(
      spawnSync(
        process.execPath,
        [cli, "group", "add", groupId, "--job-id", "831", "--sentinel", sentinel],
        { encoding: "utf8", env: environment },
      ).status,
      0,
    );
    assert.equal(
      spawnSync(
        process.execPath,
        [cli, "group", "add", groupId, "--job-id", "832"],
        { encoding: "utf8", env: environment },
      ).status,
      0,
    );
    const waiting = spawnSync(process.execPath, [cli, "group", "wait", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(waiting.status, 0, waiting.stderr);
    const watcherPid = Number(waiting.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    await waitUntil(() => {
      const group = JSON.parse(readFileSync(groupPath, "utf8")) as { status: string };
      return group.status === "callback_ambiguous";
    });
    await waitUntil(() => !processIsAlive(watcherPid));
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);

    const recovered = spawnSync(process.execPath, [cli, "recover"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);
    const add = spawnSync(
      process.execPath,
      [cli, "group", "add", groupId, "--job-id", "833"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(add.status, 1);
    assert.match(add.stderr, /callback_ambiguous/);

    const claim = JSON.parse(
      readFileSync(claimPath(stateHome, "agent-each-ambiguous"), "utf8"),
    ) as { generation: string };
    const abandoned = spawnSync(
      process.execPath,
      [
        cli,
        "abandon",
        "--agent-id",
        "agent-each-ambiguous",
        "--wait-id",
        groupId,
        "--generation",
        claim.generation,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(abandoned.status, 0, abandoned.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an intermediate each callback is fenced before send and survives watcher death", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-each-send-killed-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const sendArrived = join(directory, "send-arrived");
    const sendRelease = join(directory, "send-release");
    const sentinel = join(directory, "terminal.done");
    writeFileSync(sentinel, "job_id=841\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
      FAKE_SEND_ARRIVED: sendArrived,
      FAKE_SEND_RELEASE: sendRelease,
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-each-killed", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    assert.equal(
      spawnSync(
        process.execPath,
        [cli, "group", "add", groupId, "--job-id", "841", "--sentinel", sentinel],
        { encoding: "utf8", env: environment },
      ).status,
      0,
    );
    assert.equal(
      spawnSync(process.execPath, [cli, "group", "add", groupId, "--job-id", "842"], {
        encoding: "utf8",
        env: environment,
      }).status,
      0,
    );
    const waiting = spawnSync(process.execPath, [cli, "group", "wait", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(waiting.status, 0, waiting.stderr);
    const watcherPid = Number(waiting.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    await waitUntil(() => existsSync(sendArrived));
    const inFlight = JSON.parse(readFileSync(groupPath, "utf8")) as { status: string };
    assert.equal(inFlight.status, "callback_ambiguous");
    process.kill(-watcherPid, "SIGKILL");
    await waitUntil(() => !processIsAlive(watcherPid));
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);

    const recovered = spawnSync(process.execPath, [cli, "recover"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /attention_required=1/);
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);

    const claim = JSON.parse(readFileSync(claimPath(stateHome, "agent-each-killed"), "utf8")) as {
      generation: string;
    };
    const abandoned = spawnSync(
      process.execPath,
      [
        cli,
        "abandon",
        "--agent-id",
        "agent-each-killed",
        "--wait-id",
        groupId,
        "--generation",
        claim.generation,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(abandoned.status, 0, abandoned.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a successful intermediate send crash remains ambiguous and is not redelivered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-each-send-commit-crash-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const sentinel = join(directory, "terminal.done");
    writeFileSync(sentinel, "job_id=851\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const baseEnvironment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
    });
    const environment = {
      ...baseEnvironment,
      PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_GROUP_SEND: "intermediate",
    };
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-each-commit-crash", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    assert.equal(
      spawnSync(
        process.execPath,
        [cli, "group", "add", groupId, "--job-id", "851", "--sentinel", sentinel],
        { encoding: "utf8", env: environment },
      ).status,
      0,
    );
    assert.equal(
      spawnSync(process.execPath, [cli, "group", "add", groupId, "--job-id", "852"], {
        encoding: "utf8",
        env: environment,
      }).status,
      0,
    );
    const waiting = spawnSync(process.execPath, [cli, "group", "wait", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(waiting.status, 0, waiting.stderr);
    const watcherPid = Number(waiting.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    await waitUntil(() => {
      if (!existsSync(groupPath)) return false;
      const group = JSON.parse(readFileSync(groupPath, "utf8")) as { status: string };
      return group.status === "callback_ambiguous";
    });
    await waitUntil(() => !processIsAlive(watcherPid));
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);
    const recovered = spawnSync(process.execPath, [cli, "recover"], {
      encoding: "utf8",
      env: baseEnvironment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);

    const claim = JSON.parse(
      readFileSync(claimPath(stateHome, "agent-each-commit-crash"), "utf8"),
    ) as { generation: string };
    const abandoned = spawnSync(
      process.execPath,
      [
        cli,
        "abandon",
        "--agent-id",
        "agent-each-commit-crash",
        "--wait-id",
        groupId,
        "--generation",
        claim.generation,
      ],
      { encoding: "utf8", env: baseEnvironment },
    );
    assert.equal(abandoned.status, 0, abandoned.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claim-less callback-ambiguous group excludes every competing creator", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-claimless-ambiguous-group-"));
  try {
    const stateHome = join(directory, "state");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome);
    const slurmCli = join(process.cwd(), "dist", "src", "cli.js");
    const localCli = join(process.cwd(), "dist", "src", "local-cli.js");
    const agentId = "agent-claimless-ambiguous";
    const created = spawnSync(
      process.execPath,
      [slurmCli, "group", "create", "--agent-id", agentId, "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    const group = JSON.parse(readFileSync(groupPath, "utf8")) as Record<string, unknown>;
    const originalGeneration = String(group.claimGeneration);
    group.status = "callback_ambiguous";
    writeFileSync(groupPath, `${JSON.stringify(group, null, 2)}\n`);
    unlinkSync(claimPath(stateHome, agentId));

    const competitors: Array<[string, string[]]> = [
      ["group", [slurmCli, "group", "create", "--agent-id", agentId, "--paseo-bin", fakePaseo]],
      ["registration", [slurmCli, "register", "--agent-id", agentId, "--job-id", "861", "--paseo-bin", fakePaseo]],
      ["local", [localCli, "run", "--agent-id", agentId, "--paseo-bin", fakePaseo, "--cwd", directory, "--", process.execPath, "-v"]],
    ];
    for (const [name, command] of competitors) {
      const attempt = spawnSync(process.execPath, command, { encoding: "utf8", env: environment });
      assert.equal(attempt.status, 1, `${name}: ${attempt.stderr}`);
      assert.match(attempt.stderr, new RegExp(`active Slurm wait ${groupId}`));
    }

    const recovered = spawnSync(process.execPath, [slurmCli, "recover"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stderr, new RegExp(`ATTENTION_EXTERNAL_WAIT.*${groupId}`));
    const restoredClaim = JSON.parse(readFileSync(claimPath(stateHome, agentId), "utf8")) as {
      generation: string;
    };
    assert.equal(restoredClaim.generation, originalGeneration);
    const recoveredGroup = JSON.parse(readFileSync(groupPath, "utf8")) as { status: string };
    assert.equal(recoveredGroup.status, "callback_ambiguous");

    const abandoned = spawnSync(
      process.execPath,
      [
        slurmCli,
        "abandon",
        "--agent-id",
        agentId,
        "--wait-id",
        groupId,
        "--generation",
        originalGeneration,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(abandoned.status, 0, abandoned.stderr);
    assert.equal(existsSync(claimPath(stateHome, agentId)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finalizing group excludes a concurrent add and completes without pending items", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-group-final-before-add-"));
  try {
    const stateHome = join(directory, "state");
    const sendArrived = join(directory, "send-arrived");
    const sendRelease = join(directory, "send-release");
    const sentinel = join(directory, "only.done");
    writeFileSync(sentinel, "job_id=811\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_SEND_ARRIVED: sendArrived,
      FAKE_SEND_RELEASE: sendRelease,
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-final-before-add", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.equal(created.status, 0, created.stderr);
    assert.ok(groupId);
    const addedInitial = spawnSync(
      process.execPath,
      [cli, "group", "add", groupId, "--job-id", "811", "--sentinel", sentinel],
      { encoding: "utf8", env: environment },
    );
    assert.equal(addedInitial.status, 0, addedInitial.stderr);
    const waiting = spawnSync(process.execPath, [cli, "group", "wait", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(waiting.status, 0, waiting.stderr);
    const watcherPid = Number(waiting.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    await waitUntil(() => existsSync(sendArrived));

    const concurrentAdd = collectProcess(
      process.execPath,
      [cli, "group", "add", groupId, "--job-id", "812"],
      environment,
    );
    writeFileSync(sendRelease, "release");
    const addResult = await concurrentAdd;
    assert.equal(addResult.status, 1);
    assert.match(addResult.stderr, /cannot add a job to completed group/);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    await waitUntil(() => {
      const group = JSON.parse(readFileSync(groupPath, "utf8")) as { status: string };
      return group.status === "completed";
    });
    const group = JSON.parse(readFileSync(groupPath, "utf8")) as {
      status: string;
      items: Array<{ status: string }>;
    };
    assert.equal(group.status, "completed");
    assert.equal(group.items.some((item) => item.status === "pending"), false);
    assert.equal(existsSync(claimPath(stateHome, "agent-final-before-add")), false);
    await waitUntil(() => !processIsAlive(watcherPid));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery releases a matching conclusively final claim and ignores a stale legacy release lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-final-claim-reconcile-"));
  try {
    const stateHome = join(directory, "state");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome);
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-final-reconcile", "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const groupPath = join(stateHome, "paseo-slurm", "groups", `${groupId}.json`);
    const group = JSON.parse(readFileSync(groupPath, "utf8")) as Record<string, unknown>;
    group.status = "completed";
    group.items = [];
    writeFileSync(groupPath, `${JSON.stringify(group, null, 2)}\n`);
    const claimFile = claimPath(stateHome, "agent-final-reconcile");
    const staleReleaseLock = `${claimFile}.lock`;
    mkdirSync(staleReleaseLock);

    const recovered = spawnSync(process.execPath, [cli, "recover"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(claimFile), false);
    assert.equal(existsSync(staleReleaseLock), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale transition lock file does not block a new crash-recoverable transaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-stale-transition-lock-"));
  try {
    const stateHome = join(directory, "state");
    const agentId = "agent-stale-transition";
    const key = createHash("sha256").update(agentId).digest("hex");
    const transitions = join(stateHome, "paseo-external-waits", "transitions");
    mkdirSync(transitions, { recursive: true });
    writeFileSync(join(transitions, `${key}.lock`), "stale inode from a dead owner\n");
    writeFileSync(join(transitions, ".stale.ready"), "stale readiness marker\n");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome);
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", agentId, "--paseo-bin", fakePaseo],
      { encoding: "utf8", env: environment },
    );
    assert.equal(created.status, 0, created.stderr);
    const groupId = created.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const cleanup = spawnSync(process.execPath, [cli, "group", "cancel", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery releases a claim after a controller crashes following final persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-final-persist-crash-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const sentinel = join(directory, "terminal.done");
    writeFileSync(sentinel, "job_id=991\nrc=0\n");
    const fakePaseo = writeFakePaseo(directory);
    const baseEnvironment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
    });
    const crashEnvironment = {
      ...baseEnvironment,
      PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_FINAL_PERSIST: "slurm-registration",
    };
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const created = spawnSync(
      process.execPath,
      [
        cli,
        "register",
        "--agent-id",
        "agent-final-persist-crash",
        "--job-id",
        "991",
        "--sentinel",
        sentinel,
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: crashEnvironment },
    );
    assert.equal(created.status, 0, created.stderr);
    const registrationId = created.stdout.match(/registration_id=([^ ]+)/)?.[1];
    const watcherPid = Number(created.stdout.match(/watcher_pid=([0-9]+)/)?.[1]);
    assert.ok(registrationId);
    const registrationPath = join(
      stateHome,
      "paseo-slurm",
      "registrations",
      `${registrationId}.json`,
    );
    await waitUntil(() => {
      if (!existsSync(registrationPath)) return false;
      const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as { status: string };
      return registration.status === "resumed";
    });
    await waitUntil(() => !processIsAlive(watcherPid));
    const claimFile = claimPath(stateHome, "agent-final-persist-crash");
    assert.equal(existsSync(claimFile), true);
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);

    const recovered = spawnSync(process.execPath, [cli, "recover"], {
      encoding: "utf8",
      env: baseEnvironment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(claimFile), false);
    assert.equal(readEvents(eventsPath).filter((event) => event[0] === "send").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claim-only orphan requires exact-generation explicit abandon", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-claim-only-abandon-"));
  try {
    const stateHome = join(directory, "state");
    const eventsPath = join(directory, "events.jsonl");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_PASEO_EVENTS: eventsPath,
    });
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const crashed = spawnSync(
      process.execPath,
      [cli, "group", "create", "--agent-id", "agent-claim-only", "--paseo-bin", fakePaseo],
      {
        encoding: "utf8",
        env: {
          ...environment,
          PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_CLAIM: "slurm-group",
        },
      },
    );
    assert.equal(crashed.status, 92, crashed.stderr);
    const claimFile = claimPath(stateHome, "agent-claim-only");
    const claim = JSON.parse(readFileSync(claimFile, "utf8")) as {
      generation: string;
      waitId: string;
    };
    const groupId = claim.waitId;
    assert.equal(existsSync(join(stateHome, "paseo-slurm", "groups", `${groupId}.json`)), false);
    assert.equal(readEvents(eventsPath).length, 0);

    const recovered = spawnSync(process.execPath, [cli, "recover"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stderr, new RegExp(`ORPHAN_EXTERNAL_WAIT.*${groupId}`));
    assert.match(recovered.stdout, /orphan_claims=1/);
    assert.equal(existsSync(claimFile), true);

    const wrong = spawnSync(
      process.execPath,
      [
        cli,
        "abandon",
        "--agent-id",
        "agent-claim-only",
        "--wait-id",
        groupId,
        "--generation",
        "wrong-generation",
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(wrong.status, 1);
    assert.equal(existsSync(claimFile), true);

    const abandoned = spawnSync(
      process.execPath,
      [
        cli,
        "abandon",
        "--agent-id",
        "agent-claim-only",
        "--wait-id",
        groupId,
        "--generation",
        claim.generation,
        "--paseo-bin",
        fakePaseo,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(abandoned.status, 0, abandoned.stderr);
    assert.equal(existsSync(claimFile), false);
    assert.ok(
      readEvents(eventsPath).some(
        (event) => event[0] === "agent" && event.some((value) => value.endsWith("=")),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claim acquisition retries when an EEXIST owner disappears before read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-claim-disappears-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = join(directory, "state");
    let removed = false;
    await withExternalWaitTransition("agent-disappearing-claim", () => {
      claimExternalWait({
        agentId: "agent-disappearing-claim",
        waitId: "old-wait",
        kind: "slurm-group",
      });
      const replacement = claimExternalWait({
        agentId: "agent-disappearing-claim",
        waitId: "new-wait",
        kind: "slurm-registration",
        onExistingClaim: (path) => {
          if (removed) return;
          removed = true;
          unlinkSync(path);
        },
      });
      assert.equal(replacement.waitId, "new-wait");
      assert.ok(replacement.generation);
      releaseExternalWaitClaim(replacement);
    });
    assert.equal(removed, true);
    assert.equal(existsSync(externalWaitClaimPath("agent-disappearing-claim")), false);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registration and local creation lose concurrently to an in-flight group preparation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-three-way-creation-"));
  try {
    const stateHome = join(directory, "state");
    const labelArrived = join(directory, "label-arrived");
    const labelRelease = join(directory, "label-release");
    const fakePaseo = writeFakePaseo(directory);
    const environment = fakeSchedulerEnvironment(directory, stateHome, {
      FAKE_LABEL_ARRIVED: labelArrived,
      FAKE_LABEL_RELEASE: labelRelease,
    });
    const slurmCli = join(process.cwd(), "dist", "src", "cli.js");
    const localCli = join(process.cwd(), "dist", "src", "local-cli.js");
    const groupResult = collectProcess(
      process.execPath,
      [slurmCli, "group", "create", "--agent-id", "agent-three-way", "--paseo-bin", fakePaseo],
      environment,
    );
    await waitUntil(() => existsSync(labelArrived));
    const registrationResult = collectProcess(
      process.execPath,
      [
        slurmCli,
        "register",
        "--agent-id",
        "agent-three-way",
        "--job-id",
        "901",
        "--paseo-bin",
        fakePaseo,
      ],
      environment,
    );
    const localResult = collectProcess(
      process.execPath,
      [
        localCli,
        "run",
        "--agent-id",
        "agent-three-way",
        "--paseo-bin",
        fakePaseo,
        "--cwd",
        directory,
        "--",
        process.execPath,
        "-v",
      ],
      environment,
    );
    writeFileSync(labelRelease, "release");
    const [group, registration, local] = await Promise.all([
      groupResult,
      registrationResult,
      localResult,
    ]);
    assert.equal(group.status, 0, group.stderr);
    assert.equal(registration.status, 1);
    assert.equal(local.status, 1);
    assert.match(registration.stderr, /already owns active Slurm wait/);
    assert.match(local.stderr, /already owns active Slurm wait/);
    const groupId = group.stdout.match(/group_id=([^ ]+)/)?.[1];
    assert.ok(groupId);
    const cleanup = spawnSync(process.execPath, [slurmCli, "group", "cancel", groupId], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
