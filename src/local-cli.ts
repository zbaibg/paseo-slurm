#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  assertExternalWaitOwnership,
  claimExternalWait,
  listExternalWaitClaims,
  readExternalWaitClaim,
  releaseExternalWaitClaim,
  withExternalWaitTransition,
  type ExternalWaitRef,
} from "./external-wait-claim.js";

const EXTERNAL_WAIT_ID_LABEL = "paseo.external-wait-id";

export interface LocalTaskResult {
  state: "COMPLETED" | "FAILED" | "CANCELLED" | "LOST";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  elapsedMilliseconds: number;
}

export interface LocalTask {
  id: string;
  agentId: string;
  command: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  resumePrompt?: string;
  paseoBin: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "preparing"
    | "starting"
    | "watching"
    | "terminal"
    | "finalizing"
    | "resumed"
    | "resume_failed"
    | "cancel_requested"
    | "lost"
    | "abandoned";
  claimGeneration?: string;
  controllerGeneration?: string;
  runnerPid?: number;
  runnerStart?: string;
  processPid?: number;
  processStart?: string;
  cancelRequestedAt?: string;
  result?: LocalTaskResult;
  error?: string;
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

interface PaseoAgentStatus {
  status: string;
  archived: boolean;
  pendingPermissionCount: number;
}

function stateRoot(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "paseo-local");
}

function tasksDir(): string {
  return join(stateRoot(), "tasks");
}

function logsDir(): string {
  return join(stateRoot(), "logs");
}

function outputDir(): string {
  return join(stateRoot(), "output");
}

function ensureStateDirs(): void {
  mkdirSync(tasksDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
  mkdirSync(outputDir(), { recursive: true });
}

function taskPath(id: string): string {
  return join(tasksDir(), `${id}.json`);
}

function logPath(id: string): string {
  return join(logsDir(), `${id}.log`);
}

function appendLog(id: string, message: string): void {
  ensureStateDirs();
  appendFileSync(logPath(id), `${new Date().toISOString()} ${message}\n`);
}

function readTask(id: string): LocalTask {
  return JSON.parse(readFileSync(taskPath(id), "utf8")) as LocalTask;
}

function writeTask(task: LocalTask): void {
  ensureStateDirs();
  task.updatedAt = new Date().toISOString();
  const path = taskPath(task.id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function allTasks(): LocalTask[] {
  ensureStateDirs();
  return readdirSync(tasksDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(tasksDir(), name), "utf8")) as LocalTask)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function activeTaskForAgent(agentId: string): LocalTask | undefined {
  return allTasks().find(
    (task) =>
      task.agentId === agentId &&
      [
        "preparing",
        "starting",
        "watching",
        "terminal",
        "finalizing",
        "resume_failed",
        "cancel_requested",
        "lost",
      ].includes(task.status),
  );
}

function taskRef(task: LocalTask): ExternalWaitRef {
  if (!task.claimGeneration) {
    throw new Error(`local task ${task.id} has no external-wait generation`);
  }
  return {
    agentId: task.agentId,
    waitId: task.id,
    kind: "paseo-local",
    generation: task.claimGeneration,
  };
}

function adoptTaskClaim(task: LocalTask): LocalTask {
  const claim = claimExternalWait({
    agentId: task.agentId,
    waitId: task.id,
    kind: "paseo-local",
    generation: task.claimGeneration,
    allowExisting: true,
  });
  if (task.claimGeneration && task.claimGeneration !== claim.generation) {
    throw new Error(`local task ${task.id} belongs to a different claim generation`);
  }
  if (!task.claimGeneration) {
    task.claimGeneration = claim.generation;
    writeTask(task);
  }
  assertExternalWaitOwnership(taskRef(task));
  return task;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positionals, options };
}

function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function processStartIdentity(pid: number | undefined): string | undefined {
  if (!pid) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(/\s+/);
    return fields[0] === "Z" ? undefined : fields[19];
  } catch {
    return undefined;
  }
}

function maybeCrashAfterClaim(): void {
  if (process.env.PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_CLAIM === "paseo-local") process.exit(92);
}

function maybeCrashAfterFinalPersistence(): void {
  if (process.env.PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_FINAL_PERSIST === "paseo-local") {
    process.exit(91);
  }
}

function isProcessAlive(pid: number | undefined, expectedStart?: string): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return !expectedStart || processStartIdentity(pid) === expectedStart;
  } catch {
    return false;
  }
}

export function buildExternalWaitLabelArgs(agentId: string, waitId: string): string[] {
  return [
    "agent",
    "update",
    agentId,
    "--label",
    `${EXTERNAL_WAIT_ID_LABEL}=${waitId}`,
    "--json",
  ];
}

export function parsePaseoAgentStatus(output: string): PaseoAgentStatus {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const status = parsed.Status ?? parsed.status;
  const archived = parsed.Archived ?? parsed.archived;
  const pendingPermissions = parsed.PendingPermissions ?? parsed.pendingPermissions;
  if (typeof status !== "string") {
    throw new Error("Paseo inspect response did not contain an agent status");
  }
  return {
    status: status.toLowerCase(),
    archived: archived === true,
    pendingPermissionCount: Array.isArray(pendingPermissions) ? pendingPermissions.length : 0,
  };
}

function queryPaseoAgentStatus(task: LocalTask): PaseoAgentStatus {
  const inspected = spawnSync(task.paseoBin, ["inspect", task.agentId, "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (inspected.error || inspected.status !== 0) {
    throw new Error(
      inspected.error?.message || inspected.stderr.trim() || `paseo exited ${inspected.status}`,
    );
  }
  return parsePaseoAgentStatus(inspected.stdout);
}

async function waitForAgentToPark(task: LocalTask): Promise<void> {
  let previousDescription = "";
  while (true) {
    let agent: PaseoAgentStatus;
    try {
      agent = queryPaseoAgentStatus(task);
    } catch (error) {
      appendLog(
        task.id,
        `agent status check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(1_000);
      continue;
    }
    if (agent.archived) throw new Error(`agent ${task.agentId} is archived`);
    if (
      (agent.status === "idle" || agent.status === "error") &&
      agent.pendingPermissionCount === 0
    ) {
      return;
    }
    const description = `status=${agent.status} pending_permissions=${agent.pendingPermissionCount}`;
    if (description !== previousDescription) {
      appendLog(task.id, `waiting for agent to park: ${description}`);
      previousDescription = description;
    }
    await sleep(1_000);
  }
}

function updateExternalWaitLabel(task: LocalTask, waitId: string): string | null {
  const updated = spawnSync(
    task.paseoBin,
    buildExternalWaitLabelArgs(task.agentId, waitId),
    { encoding: "utf8", timeout: 30_000 },
  );
  if (!updated.error && updated.status === 0) return null;
  return updated.error?.message || updated.stderr.trim() || `paseo exited ${updated.status}`;
}

function updateExternalWaitLabelOwned(
  task: LocalTask,
  reference: ExternalWaitRef,
  waitId: string,
): string | null {
  assertExternalWaitOwnership(reference);
  const error = updateExternalWaitLabel(task, waitId);
  assertExternalWaitOwnership(reference);
  return error;
}

function sendOwned(task: LocalTask, reference: ExternalWaitRef, prompt: string): string | null {
  assertExternalWaitOwnership(reference);
  const sent = spawnSync(
    task.paseoBin,
    ["send", task.agentId, "--prompt", prompt, "--system", "--no-wait"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assertExternalWaitOwnership(reference);
  if (!sent.error && sent.status === 0) return null;
  return sent.error?.message || sent.stderr.trim() || `paseo exited ${sent.status}`;
}

export function buildLocalResumePrompt(
  task: Pick<LocalTask, "id" | "cwd" | "stdoutPath" | "stderrPath" | "resumePrompt">,
  result: LocalTaskResult,
): string {
  const details = [
    `task_id=${task.id}`,
    `state=${result.state}`,
    `exit_code=${result.exitCode ?? "unknown"}`,
    `signal=${result.signal ?? "none"}`,
    `elapsed_ms=${result.elapsedMilliseconds}`,
    `cwd=${JSON.stringify(task.cwd)}`,
    `stdout=${JSON.stringify(task.stdoutPath)}`,
    `stderr=${JSON.stringify(task.stderrPath)}`,
  ];
  const next =
    task.resumePrompt?.trim() ||
    "Inspect the final status and logs once, then continue the task from this result.";
  return [
    "<paseo-system>",
    `Local task ${task.id} reached terminal state.`,
    details.join(" "),
    "",
    next,
    "</paseo-system>",
  ].join("\n");
}

function spawnRunner(id: string, controllerGeneration: string, command = "_run"): number {
  ensureStateDirs();
  const script = fileURLToPath(import.meta.url);
  const output = openSync(logPath(id), "a");
  const child = spawn(process.execPath, [script, command, id, controllerGeneration], {
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env,
  });
  closeSync(output);
  child.unref();
  if (!child.pid) throw new Error("failed to start detached local-task runner");
  return child.pid;
}

function signalProcessGroup(
  pid: number,
  expectedStart: string | undefined,
  signal: NodeJS.Signals,
): void {
  if (!expectedStart) {
    throw new Error(`refusing to signal payload pid ${pid} without its process-start identity`);
  }
  if (processStartIdentity(pid) !== expectedStart) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isProcessAlive(pid, expectedStart)) return;
    throw error;
  }
}

function assertTaskController(task: LocalTask, controllerGeneration: string): ExternalWaitRef {
  const reference = taskRef(task);
  assertExternalWaitOwnership(reference);
  if (task.controllerGeneration !== controllerGeneration) {
    throw new Error(`local task ${task.id} controller generation was fenced`);
  }
  return reference;
}

async function resumeTerminalTask(id: string, controllerGeneration: string): Promise<void> {
  let task = readTask(id);
  if (task.status === "resumed") return;
  if (!task.result) throw new Error(`local task ${id} has no terminal result`);
  await waitForAgentToPark(task);
  try {
    await withExternalWaitTransition(task.agentId, () => {
      task = readTask(id);
      let reference = assertTaskController(task, controllerGeneration);
      if (["resumed", "abandoned"].includes(task.status)) return;
      if (!task.result || !["terminal", "resume_failed"].includes(task.status)) {
        throw new Error(`local task ${id} is not ready for terminal callback`);
      }
      task.status = "finalizing";
      task.error = undefined;
      writeTask(task);
      task = readTask(id);
      reference = assertTaskController(task, controllerGeneration);
      const clearError = updateExternalWaitLabelOwned(task, reference, "");
      if (clearError) {
        task.status = "resume_failed";
        task.error = `failed to clear external wait label: ${clearError}`;
        writeTask(task);
        throw new Error(task.error);
      }
      if (!task.result) throw new Error(`local task ${id} lost its terminal result`);
      const sendError = sendOwned(task, reference, buildLocalResumePrompt(task, task.result));
      if (sendError) {
        const restoreError = updateExternalWaitLabelOwned(task, reference, task.id);
        task = readTask(id);
        assertTaskController(task, controllerGeneration);
        task.status = "finalizing";
        task.error = restoreError
          ? `${sendError}; failed to restore external wait label: ${restoreError}`
          : `callback result is ambiguous after send failure: ${sendError}`;
        writeTask(task);
        throw new Error(task.error);
      }
      task = readTask(id);
      reference = assertTaskController(task, controllerGeneration);
      if (task.status !== "finalizing") {
        throw new Error(`local task ${id} left finalizing state before commit`);
      }
      task.status = "resumed";
      task.error = undefined;
      writeTask(task);
      assertExternalWaitOwnership(reference);
      maybeCrashAfterFinalPersistence();
      releaseExternalWaitClaim(reference);
      appendLog(id, `resumed agent ${task.agentId}`);
    });
  } catch (error) {
    appendLog(id, `terminal callback stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function runTask(id: string, controllerGeneration: string): Promise<void> {
  let task = readTask(id);
  const shouldRun = await withExternalWaitTransition(task.agentId, () => {
    task = readTask(id);
    assertTaskController(task, controllerGeneration);
    if (["resumed", "abandoned", "finalizing"].includes(task.status) || task.result) return false;
    if (!["starting", "watching", "cancel_requested"].includes(task.status)) return false;
    task.status = task.cancelRequestedAt ? "cancel_requested" : "watching";
    task.runnerPid = process.pid;
    task.runnerStart = processStartIdentity(process.pid);
    writeTask(task);
    return true;
  });
  if (!shouldRun) return;
  appendLog(id, `starting command in ${task.cwd}`);

  const startedAt = new Date();
  let output: number | undefined;
  let errorOutput: number | undefined;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let launchError: string | undefined;
  try {
    output = openSync(task.stdoutPath, "w", 0o600);
    errorOutput = openSync(task.stderrPath, "w", 0o600);
    const child = spawn(task.command[0], task.command.slice(1), {
      cwd: task.cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", output, errorOutput],
    });
    closeSync(output);
    closeSync(errorOutput);
    output = undefined;
    errorOutput = undefined;
    if (child.pid) {
      const childStart = processStartIdentity(child.pid);
      if (!childStart) {
        throw new Error(`cannot determine process-start identity for local payload pid ${child.pid}`);
      }
      task = await withExternalWaitTransition(task.agentId, () => {
        const current = readTask(id);
        assertTaskController(current, controllerGeneration);
        current.processPid = child.pid;
        current.processStart = childStart;
        current.status = current.cancelRequestedAt ? "cancel_requested" : "watching";
        writeTask(current);
        return current;
      });
      appendLog(id, `watching pid=${child.pid}`);
      if (task.cancelRequestedAt) signalProcessGroup(child.pid, childStart, "SIGTERM");
    }
    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    }>((resolveOutcome) => {
      let settled = false;
      const finish = (result: {
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: string;
      }) => {
        if (settled) return;
        settled = true;
        resolveOutcome(result);
      };
      child.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
      child.once("close", (code, closeSignal) => finish({ code, signal: closeSignal }));
    });
    exitCode = outcome.code;
    signal = outcome.signal;
    launchError = outcome.error;
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  } finally {
    if (output !== undefined) closeSync(output);
    if (errorOutput !== undefined) closeSync(errorOutput);
  }

  const finishedAt = new Date();
  let state: LocalTaskResult["state"] = "FAILED";
  try {
    task = await withExternalWaitTransition(task.agentId, () => {
      const current = readTask(id);
      assertTaskController(current, controllerGeneration);
      state = current.cancelRequestedAt
        ? "CANCELLED"
        : exitCode === 0 && !launchError
          ? "COMPLETED"
          : "FAILED";
      current.status = "terminal";
      current.result = {
        state,
        exitCode,
        signal,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        elapsedMilliseconds: finishedAt.getTime() - startedAt.getTime(),
      };
      current.processPid = undefined;
      current.processStart = undefined;
      current.error = launchError;
      writeTask(current);
      return current;
    });
  } catch (error) {
    appendLog(id, `terminal commit fenced: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  appendLog(
    id,
    `terminal state=${state} exit=${exitCode ?? "unknown"} signal=${signal ?? "none"}`,
  );
  await resumeTerminalTask(id, controllerGeneration);
}

function startInitialTaskControllerLocked(task: LocalTask): LocalTask {
  assertExternalWaitOwnership(taskRef(task));
  if (task.result || task.status !== "starting") {
    throw new Error(`local task ${task.id} is not in its initial starting state`);
  }
  const controllerGeneration = randomUUID();
  task.controllerGeneration = controllerGeneration;
  task.runnerPid = undefined;
  task.runnerStart = undefined;
  writeTask(task);
  const runnerPid = spawnRunner(task.id, controllerGeneration, "_run");
  task.runnerPid = runnerPid;
  task.runnerStart = processStartIdentity(runnerPid);
  writeTask(task);
  return task;
}

function ensureTerminalTaskControllerLocked(task: LocalTask): LocalTask {
  assertExternalWaitOwnership(taskRef(task));
  if (
    task.controllerGeneration &&
    isProcessAlive(task.runnerPid, task.runnerStart)
  ) {
    return task;
  }
  if (!task.result || !["terminal", "resume_failed"].includes(task.status)) {
    throw new Error(`local task ${task.id} has no recoverable terminal callback`);
  }
  const controllerGeneration = randomUUID();
  task.controllerGeneration = controllerGeneration;
  task.runnerPid = undefined;
  task.runnerStart = undefined;
  task.status = "terminal";
  task.error = undefined;
  writeTask(task);
  const runnerPid = spawnRunner(task.id, controllerGeneration, "_resume");
  task.runnerPid = runnerPid;
  task.runnerStart = processStartIdentity(runnerPid);
  writeTask(task);
  return task;
}

async function run(argv: string[]): Promise<void> {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("local run requires -- COMMAND [ARGS...]");
  }
  const args = parseArgs(argv.slice(0, separator));
  const command = argv.slice(separator + 1);
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const id = `${agentId.slice(0, 8)}-local-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const cwd = resolve(stringOption(args, "cwd") || process.cwd());
  if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`);
  ensureStateDirs();
  const stdoutPath = resolve(stringOption(args, "stdout") || join(outputDir(), `${id}.stdout.log`));
  const stderrPath = resolve(stringOption(args, "stderr") || join(outputDir(), `${id}.stderr.log`));
  for (const path of [stdoutPath, stderrPath]) {
    if (!existsSync(dirname(path))) throw new Error(`output directory does not exist: ${dirname(path)}`);
  }
  const now = new Date().toISOString();
  let task: LocalTask = {
    id,
    agentId,
    command,
    cwd,
    stdoutPath,
    stderrPath,
    resumePrompt: stringOption(args, "resume-prompt"),
    paseoBin: stringOption(args, "paseo-bin") || "paseo",
    createdAt: now,
    updatedAt: now,
    status: "preparing",
  };
  await withExternalWaitTransition(agentId, () => {
    const claim = claimExternalWait({
      agentId: task.agentId,
      waitId: task.id,
      kind: "paseo-local",
    });
    maybeCrashAfterClaim();
    task.claimGeneration = claim.generation;
    writeTask(task);
    const labelError = updateExternalWaitLabelOwned(task, taskRef(task), id);
    if (labelError) {
      task.error = `failed to set external-wait label: ${labelError}`;
      writeTask(task);
      throw new Error(`failed to register local wait with Paseo: ${labelError}`);
    }
    task.status = "starting";
    task.error = undefined;
    writeTask(task);
    task = startInitialTaskControllerLocked(task);
  });
  console.log(
    `WAITING_LOCAL_TASK task_id=${id} runner_pid=${task.runnerPid} stdout=${stdoutPath} stderr=${stderrPath}`,
  );
}

function status(args: ParsedArgs): void {
  const id = args.positionals[1];
  console.log(JSON.stringify(id ? readTask(id) : allTasks(), null, 2));
}

async function wait(args: ParsedArgs): Promise<void> {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  const id = args.positionals[1] || (agentId ? activeTaskForAgent(agentId)?.id : undefined);
  if (!id) throw new Error("task ID is required when no active task belongs to this agent");
  let task = readTask(id);
  if (task.status === "resumed") throw new Error(`local task ${id} already resumed its agent`);
  await withExternalWaitTransition(task.agentId, () => {
    task = readTask(id);
    if (["resumed", "abandoned", "finalizing"].includes(task.status)) {
      throw new Error(`cannot wait on ${task.status} local task ${id}`);
    }
    task = adoptTaskClaim(task);
    const labelError = updateExternalWaitLabelOwned(task, taskRef(task), id);
    if (labelError) throw new Error(`failed to activate local wait with Paseo: ${labelError}`);
    if (task.result) {
      task = ensureTerminalTaskControllerLocked(task);
    } else if (!isProcessAlive(task.runnerPid, task.runnerStart)) {
      throw new Error(`local task ${id} has no live runner and no terminal result; inspect or abandon it`);
    }
  });
  console.log(
    `WAITING_LOCAL_TASK task_id=${id} runner_pid=${task.runnerPid} stdout=${task.stdoutPath} stderr=${task.stderrPath}`,
  );
}

async function cancel(args: ParsedArgs): Promise<void> {
  const id = args.positionals[1];
  if (!id) throw new Error("task ID is required");
  const rawSignal = stringOption(args, "signal") || "SIGTERM";
  if (!/^SIG[A-Z0-9]+$/.test(rawSignal)) throw new Error("--signal must be a signal name such as SIGTERM");
  const signal = rawSignal as NodeJS.Signals;
  let task = readTask(id);
  await withExternalWaitTransition(task.agentId, () => {
    task = readTask(id);
    if (task.result || ["resumed", "finalizing", "abandoned"].includes(task.status)) {
      throw new Error(`local task ${id} is already terminal`);
    }
    task = adoptTaskClaim(task);
    assertTaskController(task, task.controllerGeneration ?? "");
    task.cancelRequestedAt = new Date().toISOString();
    task.status = "cancel_requested";
    writeTask(task);
    if (task.processPid) signalProcessGroup(task.processPid, task.processStart, signal);
  });
  console.log(`cancel_requested=${id} signal=${signal}`);
}

async function recover(): Promise<void> {
  let recovered = 0;
  let attention = 0;
  for (let task of allTasks()) {
    try {
      await withExternalWaitTransition(task.agentId, () => {
        task = readTask(task.id);
        const existingClaim = readExternalWaitClaim(task.agentId);
        if (["resumed", "abandoned"].includes(task.status)) {
          if (
            existingClaim &&
            task.claimGeneration === existingClaim.generation &&
            existingClaim.waitId === task.id &&
            existingClaim.kind === "paseo-local"
          ) {
            releaseExternalWaitClaim(taskRef(task));
          }
          return;
        }
        if (task.status === "finalizing") {
          task = adoptTaskClaim(task);
          appendLog(task.id, "recovery requires explicit abandon for finalizing local task");
          console.error(
            `ATTENTION_EXTERNAL_WAIT kind=paseo-local agent_id=${task.agentId} wait_id=${task.id} generation=${task.claimGeneration} status=${task.status}; inspect before exact-generation abandon`,
          );
          attention += 1;
          return;
        }
        task = adoptTaskClaim(task);
        if (task.status === "preparing") {
          const labelError = updateExternalWaitLabelOwned(task, taskRef(task), task.id);
          if (labelError) throw new Error(`failed to recover preparing label: ${labelError}`);
          task.status = "lost";
          task.error = "creation stopped before the payload controller was durably started";
          writeTask(task);
          attention += 1;
          return;
        }
        if (task.result) {
          const hadLiveController = isProcessAlive(task.runnerPid, task.runnerStart);
          task = ensureTerminalTaskControllerLocked(task);
          if (!hadLiveController) recovered += 1;
          return;
        }
        if (!isProcessAlive(task.runnerPid, task.runnerStart)) attention += 1;
      });
    } catch (error) {
      appendLog(
        task.id,
        `recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      attention += 1;
    }
  }
  let orphanClaims = 0;
  for (const claim of listExternalWaitClaims("paseo-local")) {
    if (existsSync(taskPath(claim.waitId))) continue;
    orphanClaims += 1;
    attention += 1;
    console.error(
      `ORPHAN_EXTERNAL_WAIT kind=${claim.kind} agent_id=${claim.agentId} wait_id=${claim.waitId} generation=${claim.generation}; use abandon with these exact ownership values after checking Paseo and the payload`,
    );
  }
  console.log(
    `recovered=${recovered} attention_required=${attention} orphan_claims=${orphanClaims}`,
  );
}

async function abandon(args: ParsedArgs): Promise<void> {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const waitId = stringOption(args, "wait-id") || args.positionals[1];
  if (!waitId) throw new Error("--wait-id is required");
  const generation = stringOption(args, "generation");
  if (!generation) throw new Error("--generation is required");
  const paseoBin = stringOption(args, "paseo-bin") || "paseo";
  await withExternalWaitTransition(agentId, () => {
    const owner = readExternalWaitClaim(agentId);
    if (
      !owner ||
      owner.waitId !== waitId ||
      owner.generation !== generation ||
      owner.kind !== "paseo-local"
    ) {
      throw new Error(`ownership check failed for abandoned local task ${waitId}`);
    }
    assertExternalWaitOwnership(owner);
    let task: LocalTask | undefined;
    if (existsSync(taskPath(waitId))) {
      task = readTask(waitId);
      if (task.claimGeneration !== generation) {
        throw new Error(`local task ${waitId} generation does not match the claim`);
      }
      if (task.processPid && !task.processStart) {
        throw new Error(
          `local task ${waitId} has a legacy payload pid without process-start identity; refusing to abandon`,
        );
      }
      if (
        isProcessAlive(task.runnerPid, task.runnerStart) ||
        isProcessAlive(task.processPid, task.processStart)
      ) {
        throw new Error(`local task ${waitId} still has a live controller or payload`);
      }
      task.status = "lost";
      task.controllerGeneration = `abandoned-${randomUUID()}`;
      task.runnerPid = undefined;
      task.runnerStart = undefined;
      task.error = "explicit abandon in progress";
      writeTask(task);
    }
    const labelOwner = task ?? {
      id: waitId,
      agentId,
      paseoBin,
    } as LocalTask;
    const labelError = updateExternalWaitLabelOwned(labelOwner, owner, "");
    if (labelError) throw new Error(`failed to clear abandoned wait label: ${labelError}`);
    if (task) {
      task = readTask(waitId);
      assertExternalWaitOwnership(owner);
      task.status = "abandoned";
      task.error = "explicitly abandoned after ownership-checked repair";
      writeTask(task);
    }
    assertExternalWaitOwnership(owner);
    releaseExternalWaitClaim(owner);
  });
  console.log(`abandoned=${waitId}`);
}

function usage(): void {
  console.log(`Usage:
  paseo-local run [--cwd PATH] [--stdout PATH] [--stderr PATH]
                  [--resume-prompt TEXT] [--agent-id ID] [--paseo-bin PATH]
                  -- COMMAND [ARGS...]
  paseo-local wait [TASK_ID] [--agent-id ID]
  paseo-local status [TASK_ID]
  paseo-local cancel TASK_ID [--signal SIGTERM]
  paseo-local recover
  paseo-local abandon --wait-id ID --generation TOKEN [--agent-id ID]
                      [--paseo-bin PATH]`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  switch (args.positionals[0]) {
    case "run":
      await run(argv);
      break;
    case "wait":
      await wait(args);
      break;
    case "status":
      status(args);
      break;
    case "cancel":
      await cancel(args);
      break;
    case "recover":
      await recover();
      break;
    case "_run": {
      const id = args.positionals[1];
      if (!id) throw new Error("task ID is required");
      const controllerGeneration = args.positionals[2];
      if (!controllerGeneration) throw new Error("controller generation is required");
      await runTask(id, controllerGeneration);
      break;
    }
    case "_resume": {
      const id = args.positionals[1];
      if (!id) throw new Error("task ID is required");
      const controllerGeneration = args.positionals[2];
      if (!controllerGeneration) throw new Error("controller generation is required");
      await resumeTerminalTask(id, controllerGeneration);
      break;
    }
    case "abandon": {
      await abandon(args);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      throw new Error(`unknown command: ${args.positionals[0]}`);
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
