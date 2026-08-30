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
    | "starting"
    | "watching"
    | "terminal"
    | "resumed"
    | "resume_failed"
    | "cancel_requested"
    | "lost";
  runnerPid?: number;
  processPid?: number;
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

function mutateTask(id: string, mutate: (task: LocalTask) => void): LocalTask {
  const task = readTask(id);
  mutate(task);
  writeTask(task);
  return task;
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
        "starting",
        "watching",
        "terminal",
        "resume_failed",
        "cancel_requested",
        "lost",
      ].includes(task.status),
  );
}

function activeSlurmWaitIdForAgent(agentId: string): string | undefined {
  const slurmRoot = join(dirname(stateRoot()), "paseo-slurm");
  const candidates = [
    {
      directory: join(slurmRoot, "registrations"),
      active: new Set(["registered", "watching", "terminal", "resume_failed"]),
    },
    {
      directory: join(slurmRoot, "groups"),
      active: new Set(["open", "watching", "resume_failed"]),
    },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.directory)) continue;
    const match = readdirSync(candidate.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        JSON.parse(readFileSync(join(candidate.directory, name), "utf8")) as {
          id: string;
          agentId: string;
          status: string;
        },
      )
      .find((wait) => wait.agentId === agentId && candidate.active.has(wait.status));
    if (match) return match.id;
  }
  return undefined;
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

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
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

async function sendResume(task: LocalTask): Promise<void> {
  if (!task.result) throw new Error(`local task ${task.id} has no terminal result`);
  const prompt = buildLocalResumePrompt(task, task.result);
  await waitForAgentToPark(task);
  let lastError = "";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const clearError = updateExternalWaitLabel(task, "");
    if (clearError) {
      lastError = `failed to clear external wait label: ${clearError}`;
      appendLog(task.id, `resume attempt ${attempt} failed: ${lastError}`);
      if (attempt < 10) await sleep(10_000);
      continue;
    }
    const sent = spawnSync(
      task.paseoBin,
      ["send", task.agentId, "--prompt", prompt, "--system", "--no-wait"],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (!sent.error && sent.status === 0) {
      appendLog(task.id, `resumed agent ${task.agentId}`);
      return;
    }
    lastError = sent.error?.message || sent.stderr.trim() || `paseo exited ${sent.status}`;
    const restoreError = updateExternalWaitLabel(task, task.id);
    if (restoreError) {
      lastError = `${lastError}; failed to restore external wait label: ${restoreError}`;
    }
    appendLog(task.id, `resume attempt ${attempt} failed: ${lastError}`);
    if (attempt < 10) await sleep(10_000);
  }
  throw new Error(lastError);
}

function spawnRunner(id: string, command = "_run"): number {
  ensureStateDirs();
  const script = fileURLToPath(import.meta.url);
  const output = openSync(logPath(id), "a");
  const child = spawn(process.execPath, [script, command, id], {
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env,
  });
  closeSync(output);
  child.unref();
  if (!child.pid) throw new Error("failed to start detached local-task runner");
  return child.pid;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isProcessAlive(pid)) return;
    throw error;
  }
}

async function resumeTerminalTask(id: string): Promise<void> {
  let task = readTask(id);
  if (task.status === "resumed") return;
  if (!task.result) throw new Error(`local task ${id} has no terminal result`);
  try {
    await sendResume(task);
    task = readTask(id);
    task.status = "resumed";
    task.error = undefined;
    writeTask(task);
  } catch (error) {
    task = readTask(id);
    task.status = "resume_failed";
    task.error = error instanceof Error ? error.message : String(error);
    writeTask(task);
    process.exitCode = 1;
  }
}

async function runTask(id: string): Promise<void> {
  let task = readTask(id);
  if (task.status === "resumed" || task.result) return;
  task.status = "watching";
  task.runnerPid = process.pid;
  writeTask(task);
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
      task = mutateTask(id, (current) => {
        current.processPid = child.pid;
        current.status = current.cancelRequestedAt ? "cancel_requested" : "watching";
      });
      appendLog(id, `watching pid=${child.pid}`);
      if (task.cancelRequestedAt) signalProcessGroup(child.pid, "SIGTERM");
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
  task = readTask(id);
  const state = task.cancelRequestedAt
    ? "CANCELLED"
    : exitCode === 0 && !launchError
      ? "COMPLETED"
      : "FAILED";
  task.status = "terminal";
  task.result = {
    state,
    exitCode,
    signal,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMilliseconds: finishedAt.getTime() - startedAt.getTime(),
  };
  task.error = launchError;
  writeTask(task);
  appendLog(
    id,
    `terminal state=${state} exit=${exitCode ?? "unknown"} signal=${signal ?? "none"}`,
  );
  await resumeTerminalTask(id);
}

function run(argv: string[]): void {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("local run requires -- COMMAND [ARGS...]");
  }
  const args = parseArgs(argv.slice(0, separator));
  const command = argv.slice(separator + 1);
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const active = activeTaskForAgent(agentId);
  if (active) {
    throw new Error(`agent ${agentId} already owns active local task ${active.id}`);
  }
  const activeSlurmWaitId = activeSlurmWaitIdForAgent(agentId);
  if (activeSlurmWaitId) {
    throw new Error(
      `agent ${agentId} already owns active Slurm wait ${activeSlurmWaitId}; finish it before starting a local wait`,
    );
  }
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
    status: "starting",
  };
  const labelError = updateExternalWaitLabel(task, id);
  if (labelError) throw new Error(`failed to register local wait with Paseo: ${labelError}`);
  try {
    writeTask(task);
    const runnerPid = spawnRunner(id);
    task = mutateTask(id, (current) => {
      current.runnerPid = runnerPid;
    });
  } catch (error) {
    updateExternalWaitLabel(task, "");
    throw error;
  }
  console.log(
    `WAITING_LOCAL_TASK task_id=${id} runner_pid=${task.runnerPid} stdout=${stdoutPath} stderr=${stderrPath}`,
  );
}

function status(args: ParsedArgs): void {
  const id = args.positionals[1];
  console.log(JSON.stringify(id ? readTask(id) : allTasks(), null, 2));
}

function wait(args: ParsedArgs): void {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  const id = args.positionals[1] || (agentId ? activeTaskForAgent(agentId)?.id : undefined);
  if (!id) throw new Error("task ID is required when no active task belongs to this agent");
  let task = readTask(id);
  if (task.status === "resumed") throw new Error(`local task ${id} already resumed its agent`);
  const labelError = updateExternalWaitLabel(task, id);
  if (labelError) throw new Error(`failed to activate local wait with Paseo: ${labelError}`);
  if (task.result && !isProcessAlive(task.runnerPid)) {
    const runnerPid = spawnRunner(id, "_resume");
    task = mutateTask(id, (current) => {
      current.runnerPid = runnerPid;
      current.status = "terminal";
      current.error = undefined;
    });
  } else if (!isProcessAlive(task.runnerPid)) {
    throw new Error(`local task ${id} has no live runner and no terminal result; inspect it manually`);
  }
  console.log(
    `WAITING_LOCAL_TASK task_id=${id} runner_pid=${task.runnerPid} stdout=${task.stdoutPath} stderr=${task.stderrPath}`,
  );
}

function cancel(args: ParsedArgs): void {
  const id = args.positionals[1];
  if (!id) throw new Error("task ID is required");
  const rawSignal = stringOption(args, "signal") || "SIGTERM";
  if (!/^SIG[A-Z0-9]+$/.test(rawSignal)) throw new Error("--signal must be a signal name such as SIGTERM");
  const signal = rawSignal as NodeJS.Signals;
  const task = mutateTask(id, (current) => {
    if (current.result || current.status === "resumed") {
      throw new Error(`local task ${id} is already terminal`);
    }
    current.cancelRequestedAt = new Date().toISOString();
    current.status = "cancel_requested";
  });
  if (task.processPid) signalProcessGroup(task.processPid, signal);
  console.log(`cancel_requested=${id} signal=${signal}`);
}

function recover(): void {
  let recovered = 0;
  let attention = 0;
  for (let task of allTasks()) {
    if (task.status === "resumed") continue;
    if (task.result && !isProcessAlive(task.runnerPid)) {
      const labelError = updateExternalWaitLabel(task, task.id);
      if (labelError) {
        attention += 1;
        continue;
      }
      const runnerPid = spawnRunner(task.id, "_resume");
      task.runnerPid = runnerPid;
      task.status = "terminal";
      task.error = undefined;
      writeTask(task);
      recovered += 1;
      continue;
    }
    if (!task.result && !isProcessAlive(task.runnerPid)) attention += 1;
  }
  console.log(`recovered=${recovered} attention_required=${attention}`);
}

function usage(): void {
  console.log(`Usage:
  paseo-local run [--cwd PATH] [--stdout PATH] [--stderr PATH]
                  [--resume-prompt TEXT] [--agent-id ID] [--paseo-bin PATH]
                  -- COMMAND [ARGS...]
  paseo-local wait [TASK_ID] [--agent-id ID]
  paseo-local status [TASK_ID]
  paseo-local cancel TASK_ID [--signal SIGTERM]
  paseo-local recover`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  switch (args.positionals[0]) {
    case "run":
      run(argv);
      break;
    case "wait":
      wait(args);
      break;
    case "status":
      status(args);
      break;
    case "cancel":
      cancel(args);
      break;
    case "recover":
      recover();
      break;
    case "_run": {
      const id = args.positionals[1];
      if (!id) throw new Error("task ID is required");
      await runTask(id);
      break;
    }
    case "_resume": {
      const id = args.positionals[1];
      if (!id) throw new Error("task ID is required");
      await resumeTerminalTask(id);
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
