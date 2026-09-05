#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
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

const TERMINAL_STATES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "OUT_OF_MEMORY",
  "NODE_FAIL",
  "PREEMPTED",
  "BOOT_FAIL",
  "DEADLINE",
  "REVOKED",
]);
export const EXTERNAL_WAIT_ID_LABEL = "paseo.external-wait-id";

export interface SlurmResult {
  state: string;
  exitCode: string;
  elapsed?: string;
  source: "sacct" | "sacct-fallback" | "sentinel";
}

export type AccountingQueryCommand = string[];

export interface PaseoAgentStatus {
  status: string;
  archived: boolean;
  pendingPermissionCount: number;
}

interface Registration {
  id: string;
  agentId: string;
  jobId: string;
  sentinelPath?: string;
  array?: boolean;
  intervalSeconds: number;
  sentinelPollSeconds?: number;
  accountingQueryCommands?: AccountingQueryCommand[];
  resumePrompt?: string;
  paseoBin: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "preparing"
    | "registered"
    | "watching"
    | "terminal"
    | "finalizing"
    | "resumed"
    | "resume_failed"
    | "cancelling"
    | "cancelled"
    | "abandoned";
  claimGeneration?: string;
  controllerGeneration?: string;
  watcherPid?: number;
  watcherStart?: string;
  result?: SlurmResult;
  error?: string;
}

export type WaitGroupMode = "all" | "each";

export interface WaitGroupItem {
  jobId: string;
  sentinelPath?: string;
  array?: boolean;
  resumePrompt?: string;
  status: "pending" | "terminal" | "notified";
  result?: SlurmResult;
}

export interface WaitGroupSubmission {
  token: string;
  scriptPath: string;
  createdAt: string;
}

export interface WaitGroup {
  id: string;
  agentId: string;
  mode: WaitGroupMode;
  intervalSeconds: number;
  sentinelPollSeconds?: number;
  accountingQueryCommands?: AccountingQueryCommand[];
  paseoBin: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "preparing"
    | "open"
    | "watching"
    | "finalizing"
    | "completed"
    | "resume_failed"
    | "callback_ambiguous"
    | "cancelling"
    | "cancelled"
    | "abandoned";
  items: WaitGroupItem[];
  pendingSubmissions?: WaitGroupSubmission[];
  claimGeneration?: string;
  controllerGeneration?: string;
  watcherPid?: number;
  watcherStart?: string;
  error?: string;
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

const DEFAULT_ACCOUNTING_QUERY_COMMANDS: AccountingQueryCommand[] = [["sacct"]];

export function parsePaseoSlurmConfig(config: unknown): AccountingQueryCommand[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("configuration must be a JSON object");
  }
  const record = config as Record<string, unknown>;
  const unexpectedTopLevel = Object.keys(record).filter((key) => !["schema_version", "accounting"].includes(key));
  if (unexpectedTopLevel.length > 0) {
    throw new Error(`unexpected configuration field: ${unexpectedTopLevel[0]}`);
  }
  if (record.schema_version !== 1) throw new Error("schema_version must be 1");
  const accounting = record.accounting;
  if (!accounting || typeof accounting !== "object" || Array.isArray(accounting)) {
    throw new Error("accounting must be a JSON object");
  }
  const accountingRecord = accounting as Record<string, unknown>;
  const unexpectedAccounting = Object.keys(accountingRecord).filter((key) => key !== "query_commands");
  if (unexpectedAccounting.length > 0) {
    throw new Error(`unexpected accounting field: ${unexpectedAccounting[0]}`);
  }
  const commands = accountingRecord.query_commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("accounting.query_commands must be a non-empty array");
  }
  return commands.map((command, commandIndex) => {
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error(`accounting.query_commands[${commandIndex}] must be a non-empty argv array`);
    }
    return command.map((argument, argumentIndex) => {
      if (typeof argument !== "string" || argument.length === 0 || argument.includes("\0")) {
        throw new Error(
          `accounting.query_commands[${commandIndex}][${argumentIndex}] must be a non-empty string without NUL`,
        );
      }
      return argument;
    });
  });
}

export function loadAccountingQueryCommands(): AccountingQueryCommand[] {
  const configBase = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const configPath = join(configBase, "paseo-slurm", "config.json");
  if (!existsSync(configPath)) {
    return DEFAULT_ACCOUNTING_QUERY_COMMANDS.map((command) => [...command]);
  }
  try {
    return parsePaseoSlurmConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    throw new Error(
      `cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stateRoot(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "paseo-slurm");
}

function registrationsDir(): string {
  return join(stateRoot(), "registrations");
}

function logsDir(): string {
  return join(stateRoot(), "logs");
}

function groupsDir(): string {
  return join(stateRoot(), "groups");
}

function sentinelsDir(): string {
  return join(stateRoot(), "sentinels");
}

function submissionScriptsDir(): string {
  return join(stateRoot(), "submission-scripts");
}

function ensureStateDirs(): void {
  mkdirSync(registrationsDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
  mkdirSync(groupsDir(), { recursive: true });
  mkdirSync(sentinelsDir(), { recursive: true });
  mkdirSync(submissionScriptsDir(), { recursive: true });
}

function registrationPath(id: string): string {
  return join(registrationsDir(), `${id}.json`);
}

function logPath(id: string): string {
  return join(logsDir(), `${id}.log`);
}

function groupPath(id: string): string {
  return join(groupsDir(), `${id}.json`);
}

function appendLog(id: string, message: string): void {
  ensureStateDirs();
  appendFileSync(logPath(id), `${new Date().toISOString()} ${message}\n`);
}

function readRegistration(id: string): Registration {
  return JSON.parse(readFileSync(registrationPath(id), "utf8")) as Registration;
}

function writeRegistration(registration: Registration): void {
  ensureStateDirs();
  registration.updatedAt = new Date().toISOString();
  const path = registrationPath(registration.id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readGroup(id: string): WaitGroup {
  return JSON.parse(readFileSync(groupPath(id), "utf8")) as WaitGroup;
}

function writeGroup(group: WaitGroup): void {
  ensureStateDirs();
  group.updatedAt = new Date().toISOString();
  const path = groupPath(group.id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(group, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function activeGroupForAgent(agentId: string): WaitGroup | undefined {
  ensureStateDirs();
  return readdirSync(groupsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(groupsDir(), name), "utf8")) as WaitGroup)
    .find(
      (group) =>
        group.agentId === agentId &&
        ["preparing", "open", "watching", "resume_failed", "callback_ambiguous", "finalizing", "cancelling"].includes(
          group.status,
        ),
    );
}

function registrationRef(registration: Registration): ExternalWaitRef {
  if (!registration.claimGeneration) {
    throw new Error(`registration ${registration.id} has no external-wait generation`);
  }
  return {
    agentId: registration.agentId,
    waitId: registration.id,
    kind: "slurm-registration",
    generation: registration.claimGeneration,
  };
}

function groupRef(group: WaitGroup): ExternalWaitRef {
  if (!group.claimGeneration) {
    throw new Error(`group ${group.id} has no external-wait generation`);
  }
  return {
    agentId: group.agentId,
    waitId: group.id,
    kind: "slurm-group",
    generation: group.claimGeneration,
  };
}

function adoptRegistrationClaim(registration: Registration): Registration {
  const claim = claimExternalWait({
    agentId: registration.agentId,
    waitId: registration.id,
    kind: "slurm-registration",
    generation: registration.claimGeneration,
    allowExisting: true,
  });
  if (registration.claimGeneration && registration.claimGeneration !== claim.generation) {
    throw new Error(`registration ${registration.id} belongs to a different claim generation`);
  }
  if (!registration.claimGeneration) {
    registration.claimGeneration = claim.generation;
    writeRegistration(registration);
  }
  assertExternalWaitOwnership(registrationRef(registration));
  return registration;
}

function adoptGroupClaim(group: WaitGroup): WaitGroup {
  const claim = claimExternalWait({
    agentId: group.agentId,
    waitId: group.id,
    kind: "slurm-group",
    generation: group.claimGeneration,
    allowExisting: true,
  });
  if (group.claimGeneration && group.claimGeneration !== claim.generation) {
    throw new Error(`group ${group.id} belongs to a different claim generation`);
  }
  if (!group.claimGeneration) {
    group.claimGeneration = claim.generation;
    writeGroup(group);
  }
  assertExternalWaitOwnership(groupRef(group));
  return group;
}

function createGroupRecordLocked(options: {
  agentId: string;
  mode: WaitGroupMode;
  intervalSeconds: number;
  sentinelPollSeconds: number;
  accountingQueryCommands: AccountingQueryCommand[];
  paseoBin: string;
}): WaitGroup {
  const now = new Date().toISOString();
  const group: WaitGroup = {
    id: `${options.agentId.slice(0, 8)}-group-${Date.now()}`,
    agentId: options.agentId,
    mode: options.mode,
    intervalSeconds: options.intervalSeconds,
    sentinelPollSeconds: options.sentinelPollSeconds,
    accountingQueryCommands: options.accountingQueryCommands,
    paseoBin: options.paseoBin,
    createdAt: now,
    updatedAt: now,
    status: "preparing",
    items: [],
  };
  const claim = claimExternalWait({
    agentId: group.agentId,
    waitId: group.id,
    kind: "slurm-group",
  });
  maybeCrashAfterClaim("slurm-group");
  group.claimGeneration = claim.generation;
  writeGroup(group);
  const labelError = updateExternalWaitLabelOwned(group, groupRef(group), group.id);
  if (labelError) {
    group.error = `failed to set external-wait label: ${labelError}`;
    writeGroup(group);
    throw new Error(`failed to create external wait group with Paseo: ${labelError}`);
  }
  group.status = "open";
  group.error = undefined;
  writeGroup(group);
  return group;
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

function requiredOption(args: ParsedArgs, name: string): string {
  const value = args.options.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function validateJobId(jobId: string): string {
  if (!/^[0-9]+(?:[_.][0-9]+)?$/.test(jobId)) {
    throw new Error(`invalid Slurm job ID: ${jobId}`);
  }
  return jobId;
}

export function normalizeState(state: string): string {
  return state.trim().split(/\s+/, 1)[0].replace(/\+$/, "").toUpperCase();
}

export function parseSacct(output: string, jobId: string): SlurmResult | undefined {
  const arrayRows: Array<{
    state: string;
    exitCode: string;
    elapsed?: string;
  }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("|");
    const [logicalId, rowId, rawState, exitCode, elapsed] =
      fields.length >= 5
        ? fields
        : [fields[0], fields[0], fields[1], fields[2], fields[3]];
    if (logicalId?.startsWith(`${jobId}_`)) {
      arrayRows.push({
        state: normalizeState(rawState ?? ""),
        exitCode: exitCode || "unknown",
        elapsed: elapsed || undefined,
      });
      continue;
    }
    if (logicalId !== jobId && rowId !== jobId) continue;
    const state = normalizeState(rawState ?? "");
    if (!TERMINAL_STATES.has(state)) return undefined;
    if (arrayRows.length === 0) return {
      state,
      exitCode: exitCode || "unknown",
      elapsed: elapsed || undefined,
      source: "sacct",
    };
  }
  if (arrayRows.length === 0 || arrayRows.some((row) => !TERMINAL_STATES.has(row.state))) {
    return undefined;
  }
  const failed = arrayRows.find((row) => row.state !== "COMPLETED");
  const result = failed ?? arrayRows[0];
  return {
    state: failed?.state ?? "COMPLETED",
    exitCode: failed?.exitCode ?? "0:0",
    elapsed: result?.elapsed,
    source: "sacct",
  };
}

export function parseSentinel(contents: string): SlurmResult | undefined {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const rc = values.get("rc");
  if (rc === undefined || !/^-?[0-9]+$/.test(rc)) return undefined;
  return {
    state: Number(rc) === 0 ? "COMPLETED" : "FAILED",
    exitCode: `${rc}:0`,
    source: "sentinel",
  };
}

export function buildResumePrompt(registration: Pick<Registration, "jobId" | "resumePrompt">, result: SlurmResult): string {
  const details = [
    `Slurm job ${registration.jobId} reached terminal state.`,
    `state=${result.state}`,
    `exit_code=${result.exitCode}`,
    `source=${result.source}`,
  ];
  if (result.elapsed) details.push(`elapsed=${result.elapsed}`);
  const next = registration.resumePrompt?.trim() ||
    "Inspect sacct and the job logs, then continue the task from this result.";
  return `${details.join(" ")}\n\n${next}`;
}

export function selectGroupDispatch(
  group: Pick<WaitGroup, "mode" | "items"> & Pick<WaitGroup, "pendingSubmissions">,
): { items: WaitGroupItem[]; final: boolean } | undefined {
  const ready = group.items.filter((item) => item.status === "terminal" && item.result);
  const hasPending =
    group.items.some((item) => item.status === "pending") ||
    (group.pendingSubmissions?.length ?? 0) > 0;
  if (ready.length === 0) {
    if (
      group.mode === "each" &&
      !hasPending &&
      group.items.length > 0 &&
      group.items.every((item) => item.status === "notified")
    ) {
      return { items: [], final: true };
    }
    return undefined;
  }
  if (group.mode === "all" && hasPending) return undefined;
  return { items: ready, final: !hasPending };
}

export function buildGroupResumePrompt(
  group: Pick<WaitGroup, "id" | "mode">,
  items: WaitGroupItem[],
  final: boolean,
): string {
  const rows = items.map((item) => {
    const result = item.result;
    const details = [
      `job_id=${item.jobId}`,
      `state=${result?.state ?? "UNKNOWN"}`,
      `exit_code=${result?.exitCode ?? "unknown"}`,
      `source=${result?.source ?? "unknown"}`,
    ];
    if (result?.elapsed) details.push(`elapsed=${result.elapsed}`);
    if (item.resumePrompt?.trim()) details.push(`next=${JSON.stringify(item.resumePrompt.trim())}`);
    return `- ${details.join(" ")}`;
  });
  const phase = final ? "final" : "intermediate";
  const instruction = final
    ? "All jobs in this external wait group are terminal. Inspect the results and finish the task, or create a new wait group before yielding if more external work is required."
    : "Process these completed jobs now. Other jobs in the group are still running; add any follow-up jobs to this group, then end the turn while the group remains active.";
  return [
    "<paseo-system>",
    `External wait group ${group.id} emitted ${final ? "a" : "an"} ${phase} ${group.mode} event:`,
    ...rows,
    "",
    instruction,
    "</paseo-system>",
  ].join("\n");
}

function commandLabel(command: AccountingQueryCommand): string {
  return command.map((argument) => JSON.stringify(argument)).join(" ");
}

export interface AccountingQueryJob {
  jobId: string;
  array?: boolean;
}

export function querySacctMany(
  jobs: AccountingQueryJob[],
  queryCommands: AccountingQueryCommand[] = DEFAULT_ACCOUNTING_QUERY_COMMANDS,
): Map<string, SlurmResult | undefined> {
  if (jobs.length === 0) return new Map();
  const seen = new Set<string>();
  for (const job of jobs) {
    validateJobId(job.jobId);
    if (seen.has(job.jobId)) throw new Error(`duplicate accounting query job ID: ${job.jobId}`);
    seen.add(job.jobId);
  }

  const activeArrays = new Set<string>();
  const arrayJobs = jobs.filter((job) => job.array);
  if (arrayJobs.length > 0) {
    const active = spawnSync(
      "squeue",
      ["-h", "-j", arrayJobs.map((job) => job.jobId).join(","), "-o", "%i"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (!active.error && active.status === 0) {
      for (const line of active.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        for (const job of arrayJobs) {
          if (line === job.jobId || line.startsWith(`${job.jobId}_`)) activeArrays.add(job.jobId);
        }
      }
    }
  }

  const sacctArguments = [
    "-X", "-n", "-P", "-j", jobs.map((job) => job.jobId).join(","),
    "--format=JobID,JobIDRaw,State,ExitCode,Elapsed",
  ];
  const failures: string[] = [];
  for (let index = 0; index < queryCommands.length; index += 1) {
    const command = queryCommands[index];
    if (!command || command.length === 0) throw new Error("accounting query command cannot be empty");
    const result = spawnSync(command[0], [...command.slice(1), ...sacctArguments], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) {
      failures.push(`${commandLabel(command)}: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      failures.push(
        `${commandLabel(command)} exited ${result.status}: ${result.stderr.trim() || "no stderr"}`,
      );
      continue;
    }
    const results = new Map<string, SlurmResult | undefined>();
    for (const job of jobs) {
      const parsed = activeArrays.has(job.jobId) ? undefined : parseSacct(result.stdout, job.jobId);
      results.set(job.jobId, parsed && index > 0 ? { ...parsed, source: "sacct-fallback" } : parsed);
    }
    return results;
  }
  throw new Error(`all accounting query commands failed: ${failures.join("; ")}`);
}

export function querySacct(
  jobId: string,
  array = false,
  queryCommands: AccountingQueryCommand[] = DEFAULT_ACCOUNTING_QUERY_COMMANDS,
): SlurmResult | undefined {
  return querySacctMany([{ jobId, array }], queryCommands).get(jobId);
}

function querySentinel(path: string | undefined): SlurmResult | undefined {
  if (!path || !existsSync(path)) return undefined;
  return parseSentinel(readFileSync(path, "utf8"));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

class SentinelWatcher {
  private watchers = new Map<string, FSWatcher>();
  private pathKey = "";
  private generation = 0;
  private waiters = new Set<() => void>();

  update(paths: Array<string | undefined>): void {
    const directories = [...new Set(paths.filter(Boolean).map((path) => dirname(path as string)))].sort();
    const nextKey = directories.join("\0");
    if (nextKey === this.pathKey) return;
    this.closeWatchers();
    this.pathKey = nextKey;
    for (const directory of directories) {
      try {
        const watcher = watch(directory, () => {
          this.generation += 1;
          for (const wake of this.waiters) wake();
          this.waiters.clear();
        });
        watcher.on("error", () => {
          this.watchers.get(directory)?.close();
          this.watchers.delete(directory);
        });
        this.watchers.set(directory, watcher);
      } catch {
        // The periodic stat fallback handles missing directories and filesystems
        // that do not provide reliable inotify events.
      }
    }
  }

  snapshot(): number {
    return this.generation;
  }

  async waitSince(observedGeneration: number, timeoutMilliseconds: number): Promise<void> {
    if (this.generation !== observedGeneration) return;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolveWait();
      };
      const timer = setTimeout(finish, timeoutMilliseconds);
      this.waiters.add(finish);
      if (this.generation !== observedGeneration) finish();
    });
  }

  close(): void {
    this.closeWatchers();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
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

function isProcessAlive(pid: number | undefined, expectedStart?: string): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return !expectedStart || processStartIdentity(pid) === expectedStart;
  } catch {
    return false;
  }
}

async function stopController(
  pid: number | undefined,
  expectedStart: string | undefined,
): Promise<void> {
  if (!pid || !expectedStart || processStartIdentity(pid) !== expectedStart) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (processStartIdentity(pid) !== expectedStart) return;
    throw error;
  }
  const termDeadline = Date.now() + 2_000;
  while (processStartIdentity(pid) === expectedStart && Date.now() < termDeadline) {
    await sleep(20);
  }
  if (processStartIdentity(pid) !== expectedStart) return;
  process.kill(pid, "SIGKILL");
  const killDeadline = Date.now() + 2_000;
  while (processStartIdentity(pid) === expectedStart && Date.now() < killDeadline) {
    await sleep(20);
  }
  if (processStartIdentity(pid) === expectedStart) {
    throw new Error(`controller pid ${pid} did not terminate after fencing`);
  }
}

function maybeCrashAfterClaim(kind: string): void {
  if (process.env.PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_CLAIM === kind) process.exit(92);
}

function maybeCrashAfterFinalPersistence(kind: string): void {
  if (process.env.PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_FINAL_PERSIST === kind) process.exit(91);
}

function maybeCrashAfterGroupSend(final: boolean): void {
  const phase = final ? "final" : "intermediate";
  if (process.env.PASEO_EXTERNAL_WAIT_TEST_CRASH_AFTER_GROUP_SEND === phase) process.exit(90);
}

function spawnWatcher(id: string, controllerGeneration: string): number {
  ensureStateDirs();
  const script = fileURLToPath(import.meta.url);
  const output = openSync(logPath(id), "a");
  const child = spawn(process.execPath, [script, "_watch", id, controllerGeneration], {
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("failed to start detached watcher");
  return child.pid;
}

function spawnGroupWatcher(id: string, controllerGeneration: string): number {
  ensureStateDirs();
  const script = fileURLToPath(import.meta.url);
  const output = openSync(logPath(id), "a");
  const child = spawn(process.execPath, [script, "_watch_group", id, controllerGeneration], {
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("failed to start detached group watcher");
  return child.pid;
}

function ensureRegistrationControllerLocked(registration: Registration): Registration {
  assertExternalWaitOwnership(registrationRef(registration));
  if (
    registration.controllerGeneration &&
    isProcessAlive(registration.watcherPid, registration.watcherStart)
  ) {
    return registration;
  }
  if (["finalizing", "cancelling", "resumed", "cancelled", "abandoned"].includes(registration.status)) {
    throw new Error(`cannot start a controller for ${registration.status} registration ${registration.id}`);
  }
  const controllerGeneration = randomUUID();
  registration.controllerGeneration = controllerGeneration;
  registration.watcherPid = undefined;
  registration.watcherStart = undefined;
  if (["registered", "watching", "resume_failed"].includes(registration.status)) {
    registration.status = "registered";
  }
  writeRegistration(registration);
  const watcherPid = spawnWatcher(registration.id, controllerGeneration);
  registration.watcherPid = watcherPid;
  registration.watcherStart = processStartIdentity(watcherPid);
  writeRegistration(registration);
  return registration;
}

function ensureGroupControllerLocked(group: WaitGroup): WaitGroup {
  assertExternalWaitOwnership(groupRef(group));
  if (group.controllerGeneration && isProcessAlive(group.watcherPid, group.watcherStart)) {
    return group;
  }
  if (["callback_ambiguous", "finalizing", "cancelling", "completed", "cancelled", "abandoned"].includes(group.status)) {
    throw new Error(`cannot start a controller for ${group.status} group ${group.id}`);
  }
  const controllerGeneration = randomUUID();
  group.controllerGeneration = controllerGeneration;
  group.watcherPid = undefined;
  group.watcherStart = undefined;
  group.status = "watching";
  group.error = undefined;
  writeGroup(group);
  const watcherPid = spawnGroupWatcher(group.id, controllerGeneration);
  group.watcherPid = watcherPid;
  group.watcherStart = processStartIdentity(watcherPid);
  writeGroup(group);
  return group;
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

interface ExternalWaitOwner {
  id: string;
  agentId: string;
  paseoBin: string;
}

function queryPaseoAgentStatus(owner: ExternalWaitOwner): PaseoAgentStatus {
  const inspected = spawnSync(
    owner.paseoBin,
    ["inspect", owner.agentId, "--json"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (inspected.error || inspected.status !== 0) {
    throw new Error(
      inspected.error?.message || inspected.stderr.trim() || `paseo exited ${inspected.status}`,
    );
  }
  return parsePaseoAgentStatus(inspected.stdout);
}

async function waitForAgentToPark(owner: ExternalWaitOwner): Promise<void> {
  let previousDescription = "";
  while (true) {
    let agent: PaseoAgentStatus;
    try {
      agent = queryPaseoAgentStatus(owner);
    } catch (error) {
      appendLog(
        owner.id,
        `agent status check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(1_000);
      continue;
    }
    if (agent.archived) {
      throw new Error(`agent ${owner.agentId} is archived`);
    }
    if (
      (agent.status === "idle" || agent.status === "error") &&
      agent.pendingPermissionCount === 0
    ) {
      return;
    }
    const description = `status=${agent.status} pending_permissions=${agent.pendingPermissionCount}`;
    if (description !== previousDescription) {
      appendLog(owner.id, `waiting for agent to park: ${description}`);
      previousDescription = description;
    }
    await sleep(1_000);
  }
}

function updateExternalWaitLabel(owner: ExternalWaitOwner, waitId: string): string | null {
  const updated = spawnSync(
    owner.paseoBin,
    buildExternalWaitLabelArgs(owner.agentId, waitId),
    { encoding: "utf8", timeout: 30_000 },
  );
  if (!updated.error && updated.status === 0) {
    return null;
  }
  return updated.error?.message || updated.stderr.trim() || `paseo exited ${updated.status}`;
}

function updateExternalWaitLabelOwned(
  owner: ExternalWaitOwner,
  reference: ExternalWaitRef,
  waitId: string,
): string | null {
  assertExternalWaitOwnership(reference);
  const error = updateExternalWaitLabel(owner, waitId);
  assertExternalWaitOwnership(reference);
  return error;
}

function sendOwned(
  owner: ExternalWaitOwner,
  reference: ExternalWaitRef,
  prompt: string,
): string | null {
  assertExternalWaitOwnership(reference);
  const sent = spawnSync(
    owner.paseoBin,
    ["send", owner.agentId, "--prompt", prompt, "--system", "--no-wait"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assertExternalWaitOwnership(reference);
  if (!sent.error && sent.status === 0) return null;
  return sent.error?.message || sent.stderr.trim() || `paseo exited ${sent.status}`;
}

function assertRegistrationController(
  registration: Registration,
  controllerGeneration: string,
): ExternalWaitRef {
  const reference = registrationRef(registration);
  assertExternalWaitOwnership(reference);
  if (registration.controllerGeneration !== controllerGeneration) {
    throw new Error(`registration ${registration.id} controller generation was fenced`);
  }
  return reference;
}

async function finalizeRegistration(
  id: string,
  controllerGeneration: string,
): Promise<void> {
  const parkedOwner = readRegistration(id);
  await waitForAgentToPark(parkedOwner);
  await withExternalWaitTransition(parkedOwner.agentId, async () => {
    let registration = readRegistration(id);
    let reference = assertRegistrationController(registration, controllerGeneration);
    if (["cancelling", "cancelled", "abandoned", "resumed"].includes(registration.status)) return;
    if (!registration.result || !["terminal", "resume_failed"].includes(registration.status)) {
      throw new Error(`registration ${id} is not ready for terminal callback`);
    }
    registration.status = "finalizing";
    registration.error = undefined;
    writeRegistration(registration);

    registration = readRegistration(id);
    reference = assertRegistrationController(registration, controllerGeneration);
    if (!registration.result) throw new Error(`registration ${id} lost its terminal result`);
    const clearError = updateExternalWaitLabelOwned(registration, reference, "");
    if (clearError) {
      registration.status = "resume_failed";
      registration.error = `failed to clear external wait label: ${clearError}`;
      writeRegistration(registration);
      throw new Error(registration.error);
    }
    const prompt = buildResumePrompt(registration, registration.result);
    const sendError = sendOwned(registration, reference, prompt);
    if (sendError) {
      const restoreError = updateExternalWaitLabelOwned(registration, reference, registration.id);
      registration = readRegistration(id);
      assertRegistrationController(registration, controllerGeneration);
      registration.status = "finalizing";
      registration.error = restoreError
        ? `${sendError}; failed to restore external wait label: ${restoreError}`
        : `callback result is ambiguous after send failure: ${sendError}`;
      writeRegistration(registration);
      throw new Error(registration.error);
    }

    registration = readRegistration(id);
    reference = assertRegistrationController(registration, controllerGeneration);
    if (registration.status !== "finalizing") {
      throw new Error(`registration ${id} left finalizing state before commit`);
    }
    registration.status = "resumed";
    registration.error = undefined;
    writeRegistration(registration);
    assertExternalWaitOwnership(reference);
    maybeCrashAfterFinalPersistence("slurm-registration");
    releaseExternalWaitClaim(reference);
    appendLog(id, `resumed agent ${registration.agentId}`);
  });
}

async function watchRegistration(id: string, controllerGeneration: string): Promise<void> {
  let registration = readRegistration(id);
  const started = await withExternalWaitTransition(registration.agentId, () => {
    registration = readRegistration(id);
    assertRegistrationController(registration, controllerGeneration);
    if (["cancelling", "cancelled", "abandoned", "resumed", "finalizing"].includes(registration.status)) {
      return false;
    }
    registration.watcherPid = process.pid;
    registration.watcherStart = processStartIdentity(process.pid);
    if (registration.status !== "terminal" && registration.status !== "resume_failed") {
      registration.status = "watching";
    }
    writeRegistration(registration);
    return true;
  });
  if (!started) return;
  appendLog(id, `watching job ${registration.jobId} controller=${controllerGeneration}`);
  if (registration.result && ["terminal", "resume_failed"].includes(registration.status)) {
    try {
      await finalizeRegistration(id, controllerGeneration);
    } catch (error) {
      appendLog(id, `terminal callback stopped: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  const sentinelWatcher = new SentinelWatcher();
  let nextSacctAt = Date.now() + registration.intervalSeconds * 1000;
  try {
    while (true) {
      registration = readRegistration(id);
      if (["cancelling", "cancelled", "abandoned", "resumed", "finalizing"].includes(registration.status)) return;
      if (registration.controllerGeneration !== controllerGeneration) return;
      sentinelWatcher.update([registration.sentinelPath]);
      const observedGeneration = sentinelWatcher.snapshot();
      try {
        let result = querySentinel(registration.sentinelPath);
        if (!result && Date.now() >= nextSacctAt) {
          nextSacctAt = Date.now() + registration.intervalSeconds * 1000;
          result = querySacct(
            registration.jobId,
            registration.array,
            registration.accountingQueryCommands,
          );
        }
        if (result) {
          const accepted = await withExternalWaitTransition(registration.agentId, () => {
            registration = readRegistration(id);
            assertRegistrationController(registration, controllerGeneration);
            if (!["registered", "watching"].includes(registration.status)) return false;
            registration.status = "terminal";
            registration.result = result;
            writeRegistration(registration);
            return true;
          });
          if (!accepted) return;
          appendLog(
            id,
            `terminal state ${result.state} exit=${result.exitCode} source=${result.source}`,
          );
          try {
            await finalizeRegistration(id, controllerGeneration);
          } catch (error) {
            appendLog(id, `terminal callback stopped: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
          }
          return;
        }
      } catch (error) {
        appendLog(id, `status check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sentinelWatcher.waitSince(
        observedGeneration,
        (registration.sentinelPollSeconds ?? 1) * 1000,
      );
    }
  } finally {
    sentinelWatcher.close();
  }
}

function assertGroupController(group: WaitGroup, controllerGeneration: string): ExternalWaitRef {
  const reference = groupRef(group);
  assertExternalWaitOwnership(reference);
  if (group.controllerGeneration !== controllerGeneration) {
    throw new Error(`group ${group.id} controller generation was fenced`);
  }
  return reference;
}

async function finalizeGroupDispatch(
  id: string,
  controllerGeneration: string,
): Promise<boolean> {
  const parkedOwner = readGroup(id);
  await waitForAgentToPark(parkedOwner);
  return withExternalWaitTransition(parkedOwner.agentId, () => {
    let group = readGroup(id);
    let reference = assertGroupController(group, controllerGeneration);
    if (["cancelling", "cancelled", "abandoned", "completed", "callback_ambiguous", "finalizing"].includes(group.status)) {
      return group.status === "completed";
    }
    let dispatch = selectGroupDispatch(group);
    if (!dispatch) return false;
    if (dispatch.final) {
      group.status = "finalizing";
      group.error = undefined;
      writeGroup(group);
      group = readGroup(id);
      reference = assertGroupController(group, controllerGeneration);
      dispatch = selectGroupDispatch(group);
      if (
        !dispatch?.final ||
        group.items.some((item) => item.status === "pending") ||
        (group.pendingSubmissions?.length ?? 0) > 0
      ) {
        group.status = "watching";
        writeGroup(group);
        return false;
      }
      const clearError = updateExternalWaitLabelOwned(group, reference, "");
      if (clearError) {
        group.status = "resume_failed";
        group.error = `failed to clear external wait label: ${clearError}`;
        writeGroup(group);
        throw new Error(group.error);
      }
    } else {
      // Persist the ambiguous boundary before the external send. If this
      // controller dies after Paseo accepts the callback but before we record
      // the notified items, recovery must stop instead of sending it twice.
      group.status = "callback_ambiguous";
      group.error = "intermediate callback is in flight; inspect before explicit abandon";
      writeGroup(group);
      group = readGroup(id);
      reference = assertGroupController(group, controllerGeneration);
    }

    const prompt = buildGroupResumePrompt(group, dispatch.items, dispatch.final);
    const sendError = sendOwned(group, reference, prompt);
    if (sendError) {
      let restoreError: string | null = null;
      if (dispatch.final) {
        restoreError = updateExternalWaitLabelOwned(group, reference, group.id);
      }
      group = readGroup(id);
      assertGroupController(group, controllerGeneration);
      group.status = dispatch.final ? "finalizing" : "callback_ambiguous";
      group.error = restoreError
        ? `${sendError}; failed to restore external wait label: ${restoreError}`
        : `callback result is ambiguous after send failure: ${sendError}`;
      writeGroup(group);
      throw new Error(group.error);
    }

    maybeCrashAfterGroupSend(dispatch.final);

    group = readGroup(id);
    reference = assertGroupController(group, controllerGeneration);
    const dispatchedJobIds = new Set(dispatch.items.map((item) => item.jobId));
    for (const item of group.items) {
      if (dispatchedJobIds.has(item.jobId) && item.status === "terminal") {
        item.status = "notified";
      }
    }
    if (dispatch.final) {
      if (
        group.items.some((item) => item.status === "pending") ||
        (group.pendingSubmissions?.length ?? 0) > 0
      ) {
        throw new Error(`refusing to complete group ${id} with pending work`);
      }
      group.status = "completed";
    } else {
      group.status = "watching";
    }
    group.error = undefined;
    writeGroup(group);
    assertExternalWaitOwnership(reference);
    appendLog(
      group.id,
      `resumed agent ${group.agentId} jobs=${dispatch.items.map((item) => item.jobId).join(",")} final=${dispatch.final}`,
    );
    if (dispatch.final) {
      maybeCrashAfterFinalPersistence("slurm-group");
      releaseExternalWaitClaim(reference);
      return true;
    }
    return false;
  });
}

async function watchGroup(id: string, controllerGeneration: string): Promise<void> {
  let group = readGroup(id);
  const started = await withExternalWaitTransition(group.agentId, () => {
    group = readGroup(id);
    assertGroupController(group, controllerGeneration);
    if (["cancelling", "cancelled", "abandoned", "completed", "callback_ambiguous", "finalizing"].includes(group.status)) {
      return false;
    }
    group.status = "watching";
    group.watcherPid = process.pid;
    group.watcherStart = processStartIdentity(process.pid);
    writeGroup(group);
    return true;
  });
  if (!started) return;
  appendLog(
    id,
    `watching group mode=${group.mode} jobs=${group.items.map((item) => item.jobId).join(",")} controller=${controllerGeneration}`,
  );
  const sentinelWatcher = new SentinelWatcher();
  const nextSacctAt = new Map<string, number>();
  try {
    while (true) {
      group = readGroup(id);
      if (["cancelling", "cancelled", "abandoned", "completed", "callback_ambiguous", "finalizing"].includes(group.status)) return;
      if (group.controllerGeneration !== controllerGeneration) return;
      const pendingItems = group.items.filter((candidate) => candidate.status === "pending");
      sentinelWatcher.update(pendingItems.map((item) => item.sentinelPath));
      const observedGeneration = sentinelWatcher.snapshot();

      const detectedResults = new Map<string, SlurmResult>();
      const dueItems: WaitGroupItem[] = [];
      const now = Date.now();
      for (const item of pendingItems) {
        let sentinelResult: SlurmResult | undefined;
        try {
          sentinelResult = querySentinel(item.sentinelPath);
        } catch (error) {
          appendLog(
            id,
            `sentinel check failed job=${item.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (sentinelResult) {
          detectedResults.set(item.jobId, sentinelResult);
          continue;
        }
        const backupIntervalSeconds = item.sentinelPath
          ? group.intervalSeconds
          : Math.min(group.intervalSeconds, 5);
        const dueAt = nextSacctAt.get(item.jobId) ?? now + backupIntervalSeconds * 1000;
        nextSacctAt.set(item.jobId, dueAt);
        if (now >= dueAt) {
          nextSacctAt.set(item.jobId, now + backupIntervalSeconds * 1000);
          dueItems.push(item);
        }
      }

      if (dueItems.length > 0) {
        try {
          const accountingResults = querySacctMany(dueItems, group.accountingQueryCommands);
          for (const item of dueItems) {
            const result = accountingResults.get(item.jobId);
            if (result) detectedResults.set(item.jobId, result);
          }
        } catch (error) {
          appendLog(
            id,
            `status check failed jobs=${dueItems.map((item) => item.jobId).join(",")}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      for (const item of pendingItems) {
        const result = detectedResults.get(item.jobId);
        if (!result) continue;
        try {
          const accepted = await withExternalWaitTransition(group.agentId, () => {
            group = readGroup(id);
            assertGroupController(group, controllerGeneration);
            if (!["watching", "resume_failed"].includes(group.status)) return false;
            const currentItem = group.items.find((candidate) => candidate.jobId === item.jobId);
            if (!currentItem || currentItem.status !== "pending") return false;
            currentItem.status = "terminal";
            currentItem.result = result;
            writeGroup(group);
            return true;
          });
          if (!accepted) continue;
          nextSacctAt.delete(item.jobId);
          appendLog(
            id,
            `terminal job=${item.jobId} state=${result.state} exit=${result.exitCode} source=${result.source}`,
          );
        } catch (error) {
          appendLog(
            id,
            `terminal persistence failed job=${item.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      group = readGroup(id);
      if (selectGroupDispatch(group)) {
        try {
          if (await finalizeGroupDispatch(id, controllerGeneration)) return;
        } catch (error) {
          appendLog(id, `group callback stopped: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
          return;
        }
      }

      await sentinelWatcher.waitSince(
        observedGeneration,
        (group.sentinelPollSeconds ?? 1) * 1000,
      );
    }
  } finally {
    sentinelWatcher.close();
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSentinelWrapper(
  script: string,
  originalScriptPath: string,
  sentinelPath: string,
): string {
  const lines = script.split(/\r?\n/);
  const shebang = lines[0]?.startsWith("#!") ? lines[0] : "#!/usr/bin/env bash";
  if (
    lines[0]?.startsWith("#!") &&
    !/(?:^|[\s/])(?:bash|dash|ksh|sh|zsh)(?:\s|$)/.test(lines[0].slice(2).trim())
  ) {
    throw new Error("automatic sentinel injection requires a shell batch script");
  }
  const directives: string[] = [];
  for (let index = lines[0]?.startsWith("#!") ? 1 : 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) break;
    if (lines[index].startsWith("#SBATCH")) directives.push(lines[index]);
  }
  let interpreterWords = shebang.slice(2).trim().split(/\s+/);
  if (interpreterWords[0]?.endsWith("/env") && interpreterWords[1] === "-S") {
    interpreterWords = [interpreterWords[0], ...interpreterWords.slice(2)];
  }
  const interpreter = interpreterWords.map(shellSingleQuote).join(" ");
  const quotedStatus = shellSingleQuote(sentinelPath);
  const hook = [
    `_paseo_slurm_status=${quotedStatus}`,
    "_paseo_slurm_on_exit() {",
    "  _paseo_slurm_rc=$?",
    '  _paseo_slurm_tmp="${_paseo_slurm_status}.${SLURM_JOB_ID:-unknown}.$$"',
    "  printf 'job_id=%s\\nrc=%s\\nfinished=%s\\n' \\",
    '    "${SLURM_JOB_ID:-unknown}" "$_paseo_slurm_rc" "$(date --iso-8601=seconds)" >"$_paseo_slurm_tmp"',
    '  mv "$_paseo_slurm_tmp" "$_paseo_slurm_status"',
    "}",
    "trap _paseo_slurm_on_exit EXIT",
    "",
  ];
  return [
    shebang,
    ...directives,
    "",
    ...hook,
    `${interpreter} ${shellSingleQuote(originalScriptPath)} "$@"`,
    "",
  ].join("\n");
}

export function hasArrayDirective(script: string): boolean {
  const lines = script.split(/\r?\n/);
  for (let index = lines[0]?.startsWith("#!") ? 1 : 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) break;
    if (/^#SBATCH\s+(?:--array(?:=|\s)|-a(?:\s|$))/.test(lines[index])) return true;
  }
  return false;
}

function isSlurmArrayJob(jobId: string): boolean {
  const shown = spawnSync("scontrol", ["show", "job", "-o", jobId], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (shown.error || shown.status !== 0) return false;
  return /(?:^|\s)ArrayJobId=\d+(?:\s|$)/m.test(shown.stdout);
}

async function submit(argv: string[]): Promise<void> {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    throw new Error("submit requires `-- SCRIPT [ARGS...]`");
  }
  const args = parseArgs(argv.slice(0, separatorIndex));
  const scriptPath = resolve(argv[separatorIndex + 1]);
  const scriptArgs = argv.slice(separatorIndex + 2);
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const requestedMode = stringOption(args, "mode");
  if (requestedMode !== undefined && requestedMode !== "all" && requestedMode !== "each") {
    throw new Error("--mode must be all or each");
  }
  const paseoBin = stringOption(args, "paseo-bin") || "paseo";
  await withExternalWaitTransition(agentId, () => {
    let group = activeGroupForAgent(agentId);
    if (!group) {
      const intervalSeconds = Number(stringOption(args, "sacct-interval") || "60");
      const sentinelPollSeconds = Number(stringOption(args, "sentinel-poll") || "1");
      if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
        throw new Error("--sacct-interval must be a positive integer");
      }
      if (!Number.isSafeInteger(sentinelPollSeconds) || sentinelPollSeconds < 1) {
        throw new Error("--sentinel-poll must be a positive integer");
      }
      group = createGroupRecordLocked({
        agentId,
        mode: (requestedMode || "each") as WaitGroupMode,
        intervalSeconds,
        sentinelPollSeconds,
        accountingQueryCommands: loadAccountingQueryCommands(),
        paseoBin,
      });
    } else {
      group = adoptGroupClaim(group);
      if (requestedMode && requestedMode !== group.mode) {
        throw new Error(`active group ${group.id} uses mode=${group.mode}, not ${requestedMode}`);
      }
      if (["callback_ambiguous", "finalizing", "cancelling", "completed", "cancelled", "abandoned"].includes(group.status)) {
        throw new Error(`cannot submit jobs to ${group.status} group ${group.id}`);
      }
    }

    ensureStateDirs();
    const source = readFileSync(scriptPath, "utf8");
    const sentinelMode = stringOption(args, "sentinel") || "auto";
    if (sentinelMode !== "auto" && sentinelMode !== "off") {
      throw new Error("--sentinel must be auto or off");
    }
    const submissionToken = randomUUID();
    let submittedScriptPath = scriptPath;
    let sentinelPath: string | undefined;
    const sourceDeclaresArray = hasArrayDirective(source);
    if (sentinelMode === "auto" && !sourceDeclaresArray) {
      sentinelPath = join(sentinelsDir(), `${group.id}-${submissionToken}.done`);
      submittedScriptPath = join(submissionScriptsDir(), `${group.id}-${submissionToken}.sbatch`);
      writeFileSync(
        submittedScriptPath,
        buildSentinelWrapper(source, scriptPath, sentinelPath),
        { mode: 0o700 },
      );
    }

    group = readGroup(group.id);
    assertExternalWaitOwnership(groupRef(group));
    if (["callback_ambiguous", "finalizing", "cancelling", "completed", "cancelled", "abandoned"].includes(group.status)) {
      throw new Error(`cannot submit jobs to ${group.status} group ${group.id}`);
    }
    group.pendingSubmissions ??= [];
    group.pendingSubmissions.push({
      token: submissionToken,
      scriptPath: submittedScriptPath,
      createdAt: new Date().toISOString(),
    });
    writeGroup(group);

    const submitted = spawnSync("sbatch", ["--parsable", submittedScriptPath, ...scriptArgs], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (submitted.error || submitted.status !== 0) {
      if (!submitted.error && typeof submitted.status === "number" && submitted.status !== 0) {
        group = readGroup(group.id);
        assertExternalWaitOwnership(groupRef(group));
        group.pendingSubmissions = (group.pendingSubmissions ?? []).filter(
          (submission) => submission.token !== submissionToken,
        );
        writeGroup(group);
      }
      const detail =
        submitted.error?.message || submitted.stderr.trim() || `sbatch exited ${submitted.status}`;
      throw new Error(
        submitted.error || submitted.status === null
          ? `${detail}; submission ${submissionToken} is ambiguous and must be repaired explicitly`
          : detail,
      );
    }
    const rawJobId = submitted.stdout.trim().split(";", 1)[0];
    let jobId: string;
    let arrayJob: boolean;
    try {
      jobId = validateJobId(rawJobId);
      arrayJob = sourceDeclaresArray || isSlurmArrayJob(jobId);
    } catch (error) {
      console.error(
        `AMBIGUOUS_SLURM_SUBMISSION group_id=${group.id} submission=${submissionToken} raw_job_id=${JSON.stringify(rawJobId)}`,
      );
      throw error;
    }
    if (arrayJob) sentinelPath = undefined;
    try {
      group = readGroup(group.id);
      assertExternalWaitOwnership(groupRef(group));
      if (["callback_ambiguous", "finalizing", "cancelling", "completed", "cancelled", "abandoned"].includes(group.status)) {
        throw new Error(`cannot add submitted job to ${group.status} group ${group.id}`);
      }
      if (!(group.pendingSubmissions ?? []).some((submission) => submission.token === submissionToken)) {
        throw new Error(`submission marker ${submissionToken} disappeared from group ${group.id}`);
      }
      group.items.push({
        jobId,
        sentinelPath,
        array: arrayJob || undefined,
        resumePrompt: stringOption(args, "resume-prompt"),
        status: "pending",
      });
      group.pendingSubmissions = group.pendingSubmissions?.filter(
        (submission) => submission.token !== submissionToken,
      );
      const labelError = updateExternalWaitLabelOwned(group, groupRef(group), group.id);
      if (labelError) {
        group.error = `submitted job ${jobId} but failed to activate external wait: ${labelError}`;
        writeGroup(group);
        throw new Error(`${group.error}; run paseo-slurm recover`);
      }
      group = ensureGroupControllerLocked(group);
      writeGroup(group);
    } catch (error) {
      console.error(
        `UNTRACKED_SLURM_JOB job_id=${jobId} group_id=${group.id} submission=${submissionToken}`,
      );
      throw error;
    }
    console.log(
      `WAITING_SLURM_GROUP group_id=${group.id} mode=${group.mode} jobs=${group.items.map((item) => item.jobId).join(",")} submitted_job=${jobId} watcher_pid=${group.watcherPid}`,
    );
  });
}

async function register(args: ParsedArgs): Promise<void> {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const jobId = validateJobId(requiredOption(args, "job-id"));
  const arrayJob = isSlurmArrayJob(jobId);
  const sentinelPath = arrayJob ? undefined : stringOption(args, "sentinel");
  const intervalText =
    stringOption(args, "sacct-interval") ||
    stringOption(args, "interval") ||
    (sentinelPath ? "60" : "5");
  const intervalSeconds = Number(intervalText);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error("--sacct-interval must be a positive integer");
  }
  const sentinelPollSeconds = Number(stringOption(args, "sentinel-poll") || "1");
  if (!Number.isSafeInteger(sentinelPollSeconds) || sentinelPollSeconds < 1) {
    throw new Error("--sentinel-poll must be a positive integer");
  }
  const id = `${agentId.slice(0, 8)}-${jobId}-${Date.now()}`;
  const now = new Date().toISOString();
  let registration: Registration = {
    id,
    agentId,
    jobId,
    sentinelPath: sentinelPath ? resolve(sentinelPath) : undefined,
    array: arrayJob || undefined,
    intervalSeconds,
    sentinelPollSeconds,
    accountingQueryCommands: loadAccountingQueryCommands(),
    resumePrompt: stringOption(args, "resume-prompt"),
    paseoBin: stringOption(args, "paseo-bin") || "paseo",
    createdAt: now,
    updatedAt: now,
    status: "preparing",
  };
  await withExternalWaitTransition(agentId, () => {
    const claim = claimExternalWait({
      agentId: registration.agentId,
      waitId: registration.id,
      kind: "slurm-registration",
    });
    maybeCrashAfterClaim("slurm-registration");
    registration.claimGeneration = claim.generation;
    writeRegistration(registration);
    const labelError = updateExternalWaitLabelOwned(registration, registrationRef(registration), id);
    if (labelError) {
      registration.error = `failed to set external-wait label: ${labelError}`;
      writeRegistration(registration);
      throw new Error(`failed to register external wait with Paseo: ${labelError}`);
    }
    registration.status = "registered";
    registration.error = undefined;
    writeRegistration(registration);
    registration = ensureRegistrationControllerLocked(registration);
  });
  console.log(
    `WAITING_SLURM registration_id=${id} job_id=${jobId} watcher_pid=${registration.watcherPid}`,
  );
}

async function createGroup(args: ParsedArgs): Promise<void> {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const rawMode = stringOption(args, "mode") || "each";
  if (rawMode !== "all" && rawMode !== "each") {
    throw new Error("--mode must be all or each");
  }
  const intervalText =
    stringOption(args, "sacct-interval") || stringOption(args, "interval") || "60";
  const intervalSeconds = Number(intervalText);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error("--sacct-interval must be a positive integer");
  }
  const sentinelPollSeconds = Number(stringOption(args, "sentinel-poll") || "1");
  if (!Number.isSafeInteger(sentinelPollSeconds) || sentinelPollSeconds < 1) {
    throw new Error("--sentinel-poll must be a positive integer");
  }
  const group = await withExternalWaitTransition(agentId, () => {
    return createGroupRecordLocked({
      agentId,
      mode: rawMode,
      intervalSeconds,
      sentinelPollSeconds,
      accountingQueryCommands: loadAccountingQueryCommands(),
      paseoBin: stringOption(args, "paseo-bin") || "paseo",
    });
  });
  console.log(
    `SLURM_GROUP group_id=${group.id} mode=${rawMode} sacct_interval=${intervalSeconds} sentinel_poll=${sentinelPollSeconds}`,
  );
}

async function addGroupJob(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  const jobId = validateJobId(requiredOption(args, "job-id"));
  const sentinelPath = stringOption(args, "sentinel");
  const arrayJob = isSlurmArrayJob(jobId);
  let group = readGroup(id);
  await withExternalWaitTransition(group.agentId, async () => {
    group = readGroup(id);
    if (["callback_ambiguous", "finalizing", "completed", "cancelling", "cancelled", "abandoned"].includes(group.status)) {
      throw new Error(`cannot add a job to ${group.status} group ${id}`);
    }
    group = adoptGroupClaim(group);
    if (group.items.some((item) => item.jobId === jobId)) {
      throw new Error(`job ${jobId} is already in group ${id}`);
    }
    group.items.push({
      jobId,
      sentinelPath: sentinelPath && !arrayJob ? resolve(sentinelPath) : undefined,
      array: arrayJob || undefined,
      resumePrompt: stringOption(args, "resume-prompt"),
      status: "pending",
    });
    writeGroup(group);
  });
  console.log(`SLURM_GROUP_ADDED group_id=${id} job_id=${jobId} jobs=${group.items.length}`);
}

async function repairGroupSubmission(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  const token = requiredOption(args, "submission");
  const rawJobId = stringOption(args, "job-id");
  const drop = args.options.get("drop-submission") === true;
  if ((rawJobId ? 1 : 0) + (drop ? 1 : 0) !== 1) {
    throw new Error("repair requires exactly one of --job-id ID or --drop-submission");
  }
  const jobId = rawJobId ? validateJobId(rawJobId) : undefined;
  let group = readGroup(id);
  await withExternalWaitTransition(group.agentId, () => {
    group = readGroup(id);
    if (["callback_ambiguous", "finalizing", "completed", "cancelling", "cancelled", "abandoned"].includes(group.status)) {
      throw new Error(`cannot repair a submission in ${group.status} group ${id}`);
    }
    group = adoptGroupClaim(group);
    if (!(group.pendingSubmissions ?? []).some((submission) => submission.token === token)) {
      throw new Error(`group ${id} has no pending submission ${token}`);
    }
    if (jobId) {
      if (group.items.some((item) => item.jobId === jobId)) {
        throw new Error(`job ${jobId} is already in group ${id}`);
      }
      const arrayJob = args.options.get("array") === true || isSlurmArrayJob(jobId);
      const sentinelPath = stringOption(args, "sentinel");
      group.items.push({
        jobId,
        sentinelPath: sentinelPath && !arrayJob ? resolve(sentinelPath) : undefined,
        array: arrayJob || undefined,
        resumePrompt: stringOption(args, "resume-prompt"),
        status: "pending",
      });
    }
    group.pendingSubmissions = group.pendingSubmissions?.filter(
      (submission) => submission.token !== token,
    );
    assertExternalWaitOwnership(groupRef(group));
    writeGroup(group);
  });
  console.log(
    jobId
      ? `repaired_submission=${token} group_id=${id} job_id=${jobId}`
      : `dropped_submission=${token} group_id=${id}`,
  );
}

async function waitGroup(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  let group = readGroup(id);
  await withExternalWaitTransition(group.agentId, () => {
    group = readGroup(id);
    if (group.items.length === 0) throw new Error(`group ${id} has no jobs`);
    if (["callback_ambiguous", "finalizing", "completed", "cancelling", "cancelled", "abandoned"].includes(group.status)) {
      throw new Error(`cannot wait on ${group.status} group ${id}`);
    }
    group = adoptGroupClaim(group);
    const labelError = updateExternalWaitLabelOwned(group, groupRef(group), id);
    if (labelError) {
      throw new Error(`failed to activate external wait group with Paseo: ${labelError}`);
    }
    group = ensureGroupControllerLocked(group);
  });
  console.log(
    `WAITING_SLURM_GROUP group_id=${id} mode=${group.mode} jobs=${group.items.map((item) => item.jobId).join(",")} watcher_pid=${group.watcherPid}`,
  );
}

async function waitCurrentGroup(args: ParsedArgs): Promise<void> {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const group = activeGroupForAgent(agentId);
  if (!group) throw new Error(`agent ${agentId} has no active Slurm wait group`);
  await waitGroup({
    positionals: ["group", "wait", group.id],
    options: args.options,
  });
}

function groupStatus(args: ParsedArgs): void {
  ensureStateDirs();
  const id = args.positionals[2];
  if (id) {
    console.log(JSON.stringify(readGroup(id), null, 2));
    return;
  }
  const rows = readdirSync(groupsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(groupsDir(), name), "utf8")) as WaitGroup)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  console.log(JSON.stringify(rows, null, 2));
}

async function cancelGroup(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  let group = readGroup(id);
  await withExternalWaitTransition(group.agentId, async () => {
    group = readGroup(id);
    if (["callback_ambiguous", "finalizing", "completed", "cancelled", "abandoned"].includes(group.status)) {
      throw new Error(`cannot cancel ${group.status} group ${id}`);
    }
    group = adoptGroupClaim(group);
    let reference = groupRef(group);
    assertExternalWaitOwnership(reference);
    const oldWatcherPid = group.watcherPid;
    const oldWatcherStart = group.watcherStart;
    group.status = "cancelling";
    group.controllerGeneration = `cancelled-${randomUUID()}`;
    group.watcherPid = undefined;
    group.watcherStart = undefined;
    writeGroup(group);
    assertExternalWaitOwnership(reference);
    await stopController(oldWatcherPid, oldWatcherStart);
    group = readGroup(id);
    reference = groupRef(group);
    assertExternalWaitOwnership(reference);
    const labelError = updateExternalWaitLabelOwned(group, reference, "");
    if (labelError) {
      group.error = `failed to clear external wait label: ${labelError}`;
      writeGroup(group);
      throw new Error(`cancelling group failed to clear external wait label: ${labelError}`);
    }
    group.status = "cancelled";
    group.error = undefined;
    writeGroup(group);
    assertExternalWaitOwnership(reference);
    releaseExternalWaitClaim(reference);
  });
  console.log(`cancelled_group=${id}`);
}

async function groupCommand(args: ParsedArgs): Promise<void> {
  switch (args.positionals[1]) {
    case "create":
      await createGroup(args);
      break;
    case "add":
      await addGroupJob(args);
      break;
    case "wait":
      await waitGroup(args);
      break;
    case "status":
      groupStatus(args);
      break;
    case "cancel":
      await cancelGroup(args);
      break;
    case "repair":
      await repairGroupSubmission(args);
      break;
    default:
      throw new Error("group command must be create, add, wait, status, cancel, or repair");
  }
}

function status(args: ParsedArgs): void {
  ensureStateDirs();
  const id = args.positionals[1];
  if (id) {
    console.log(JSON.stringify(readRegistration(id), null, 2));
    return;
  }
  const rows = readdirSync(registrationsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(registrationsDir(), name), "utf8")) as Registration)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  console.log(JSON.stringify(rows, null, 2));
}

async function recover(): Promise<void> {
  ensureStateDirs();
  let recovered = 0;
  let attention = 0;
  for (const name of readdirSync(registrationsDir()).filter((entry) => entry.endsWith(".json"))) {
    let registration = JSON.parse(
      readFileSync(join(registrationsDir(), name), "utf8"),
    ) as Registration;
    try {
      await withExternalWaitTransition(registration.agentId, () => {
        registration = readRegistration(registration.id);
        const existingClaim = readExternalWaitClaim(registration.agentId);
        if (["resumed", "cancelled", "abandoned"].includes(registration.status)) {
          if (
            existingClaim &&
            registration.claimGeneration === existingClaim.generation &&
            existingClaim.waitId === registration.id &&
            existingClaim.kind === "slurm-registration"
          ) {
            releaseExternalWaitClaim(registrationRef(registration));
          }
          return;
        }
        if (registration.status === "finalizing" || registration.status === "cancelling") {
          registration = adoptRegistrationClaim(registration);
          appendLog(registration.id, `recovery requires explicit abandon for ${registration.status} registration`);
          console.error(
            `ATTENTION_EXTERNAL_WAIT kind=slurm-registration agent_id=${registration.agentId} wait_id=${registration.id} generation=${registration.claimGeneration} status=${registration.status}; inspect before exact-generation abandon`,
          );
          attention += 1;
          return;
        }
        registration = adoptRegistrationClaim(registration);
        if (registration.status === "preparing") {
          const labelError = updateExternalWaitLabelOwned(
            registration,
            registrationRef(registration),
            registration.id,
          );
          if (labelError) throw new Error(`failed to recover preparing label: ${labelError}`);
          registration.status = "registered";
          registration.error = undefined;
          writeRegistration(registration);
        }
        const hadLiveController = isProcessAlive(
          registration.watcherPid,
          registration.watcherStart,
        );
        registration = ensureRegistrationControllerLocked(registration);
        if (!hadLiveController) recovered += 1;
      });
    } catch (error) {
      appendLog(
        registration.id,
        `recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      attention += 1;
    }
  }
  let recoveredGroups = 0;
  for (const name of readdirSync(groupsDir()).filter((entry) => entry.endsWith(".json"))) {
    let group = JSON.parse(readFileSync(join(groupsDir(), name), "utf8")) as WaitGroup;
    try {
      await withExternalWaitTransition(group.agentId, () => {
        group = readGroup(group.id);
        const existingClaim = readExternalWaitClaim(group.agentId);
        if (["completed", "cancelled", "abandoned"].includes(group.status)) {
          if (
            group.status === "completed" &&
            (group.items.some((item) => item.status === "pending") ||
              (group.pendingSubmissions?.length ?? 0) > 0)
          ) {
            appendLog(group.id, "recovery refused completed group containing pending work");
            attention += 1;
            return;
          }
          if (
            existingClaim &&
            group.claimGeneration === existingClaim.generation &&
            existingClaim.waitId === group.id &&
            existingClaim.kind === "slurm-group"
          ) {
            releaseExternalWaitClaim(groupRef(group));
          }
          return;
        }
        if (["callback_ambiguous", "finalizing", "cancelling"].includes(group.status)) {
          group = adoptGroupClaim(group);
          appendLog(group.id, `recovery requires explicit abandon for ${group.status} group`);
          console.error(
            `ATTENTION_EXTERNAL_WAIT kind=slurm-group agent_id=${group.agentId} wait_id=${group.id} generation=${group.claimGeneration} status=${group.status}; inspect before exact-generation abandon`,
          );
          attention += 1;
          return;
        }
        group = adoptGroupClaim(group);
        if (group.status === "preparing") {
          const labelError = updateExternalWaitLabelOwned(group, groupRef(group), group.id);
          if (labelError) throw new Error(`failed to recover preparing label: ${labelError}`);
          group.status = "open";
          group.error = undefined;
          writeGroup(group);
          return;
        }
        if (["watching", "resume_failed"].includes(group.status)) {
          const hadLiveController = isProcessAlive(group.watcherPid, group.watcherStart);
          group = ensureGroupControllerLocked(group);
          if (!hadLiveController) recoveredGroups += 1;
        }
      });
    } catch (error) {
      appendLog(
        group.id,
        `recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      attention += 1;
    }
  }
  let orphanClaims = 0;
  for (const claim of listExternalWaitClaims().filter((candidate) =>
    candidate.kind === "slurm-registration" || candidate.kind === "slurm-group"
  )) {
    const recordExists =
      claim.kind === "slurm-registration"
        ? existsSync(registrationPath(claim.waitId))
        : existsSync(groupPath(claim.waitId));
    if (recordExists) continue;
    orphanClaims += 1;
    attention += 1;
    console.error(
      `ORPHAN_EXTERNAL_WAIT kind=${claim.kind} agent_id=${claim.agentId} wait_id=${claim.waitId} generation=${claim.generation}; use abandon with these exact ownership values after checking Paseo`,
    );
  }
  console.log(
    `recovered=${recovered} recovered_groups=${recoveredGroups} attention_required=${attention} orphan_claims=${orphanClaims}`,
  );
}

async function cancel(args: ParsedArgs): Promise<void> {
  const id = args.positionals[1];
  if (!id) throw new Error("registration ID is required");
  let registration = readRegistration(id);
  await withExternalWaitTransition(registration.agentId, async () => {
    registration = readRegistration(id);
    if (["finalizing", "resumed", "cancelled", "abandoned"].includes(registration.status)) {
      throw new Error(`cannot cancel ${registration.status} registration ${id}`);
    }
    registration = adoptRegistrationClaim(registration);
    let reference = registrationRef(registration);
    assertExternalWaitOwnership(reference);
    const oldWatcherPid = registration.watcherPid;
    const oldWatcherStart = registration.watcherStart;
    registration.status = "cancelling";
    registration.controllerGeneration = `cancelled-${randomUUID()}`;
    registration.watcherPid = undefined;
    registration.watcherStart = undefined;
    writeRegistration(registration);
    assertExternalWaitOwnership(reference);
    await stopController(oldWatcherPid, oldWatcherStart);
    registration = readRegistration(id);
    reference = registrationRef(registration);
    assertExternalWaitOwnership(reference);
    const labelError = updateExternalWaitLabelOwned(registration, reference, "");
    if (labelError) {
      registration.error = `failed to clear external wait label: ${labelError}`;
      writeRegistration(registration);
      throw new Error(`cancelling registration failed to clear external wait label: ${labelError}`);
    }
    registration.status = "cancelled";
    registration.error = undefined;
    writeRegistration(registration);
    assertExternalWaitOwnership(reference);
    releaseExternalWaitClaim(reference);
  });
  console.log(`cancelled=${id}`);
}

async function abandon(args: ParsedArgs): Promise<void> {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const waitId = stringOption(args, "wait-id") || args.positionals[1];
  if (!waitId) throw new Error("--wait-id is required");
  const generation = requiredOption(args, "generation");
  const paseoBin = stringOption(args, "paseo-bin") || "paseo";
  await withExternalWaitTransition(agentId, () => {
    const owner = readExternalWaitClaim(agentId);
    if (
      !owner ||
      owner.waitId !== waitId ||
      owner.generation !== generation ||
      !["slurm-registration", "slurm-group"].includes(owner.kind)
    ) {
      throw new Error(`ownership check failed for abandoned Slurm wait ${waitId}`);
    }
    assertExternalWaitOwnership(owner);
    let controllerOwner: ExternalWaitOwner = { id: waitId, agentId, paseoBin };
    if (owner.kind === "slurm-registration" && existsSync(registrationPath(waitId))) {
      const registration = readRegistration(waitId);
      if (registration.claimGeneration !== generation) {
        throw new Error(`registration ${waitId} generation does not match the claim`);
      }
      if (isProcessAlive(registration.watcherPid, registration.watcherStart)) {
        throw new Error(`registration ${waitId} still has a live controller`);
      }
      registration.status = "cancelling";
      registration.controllerGeneration = `abandoned-${randomUUID()}`;
      registration.watcherPid = undefined;
      registration.watcherStart = undefined;
      registration.error = "explicit abandon in progress";
      writeRegistration(registration);
      controllerOwner = registration;
    } else if (owner.kind === "slurm-group" && existsSync(groupPath(waitId))) {
      const group = readGroup(waitId);
      if (group.claimGeneration !== generation) {
        throw new Error(`group ${waitId} generation does not match the claim`);
      }
      if (isProcessAlive(group.watcherPid, group.watcherStart)) {
        throw new Error(`group ${waitId} still has a live controller`);
      }
      group.status = "cancelling";
      group.controllerGeneration = `abandoned-${randomUUID()}`;
      group.watcherPid = undefined;
      group.watcherStart = undefined;
      group.error = "explicit abandon in progress";
      writeGroup(group);
      controllerOwner = group;
    }
    const labelError = updateExternalWaitLabelOwned(controllerOwner, owner, "");
    if (labelError) throw new Error(`failed to clear abandoned wait label: ${labelError}`);
    if (owner.kind === "slurm-registration" && existsSync(registrationPath(waitId))) {
      const registration = readRegistration(waitId);
      assertExternalWaitOwnership(owner);
      registration.status = "abandoned";
      registration.error = "explicitly abandoned after ownership-checked repair";
      writeRegistration(registration);
    } else if (owner.kind === "slurm-group" && existsSync(groupPath(waitId))) {
      const group = readGroup(waitId);
      assertExternalWaitOwnership(owner);
      group.status = "abandoned";
      group.error = "explicitly abandoned after ownership-checked repair";
      writeGroup(group);
    }
    assertExternalWaitOwnership(owner);
    releaseExternalWaitClaim(owner);
  });
  console.log(`abandoned=${waitId}`);
}

function usage(): void {
  console.log(`Usage:
  paseo-slurm submit [--mode each|all] [--resume-prompt TEXT]
                     [--sentinel auto|off] [--sentinel-poll SECONDS]
                     [--sacct-interval SECONDS]
                     -- SCRIPT [ARGS...]
  paseo-slurm wait [--agent-id ID]
  paseo-slurm register --job-id ID [--sentinel PATH] [--interval SECONDS]
                       [--resume-prompt TEXT] [--agent-id ID] [--paseo-bin PATH]
  paseo-slurm status [REGISTRATION_ID]
  paseo-slurm group create [--mode each|all] [--sacct-interval SECONDS]
                           [--agent-id ID] [--paseo-bin PATH]
  paseo-slurm group add GROUP_ID --job-id ID [--sentinel PATH]
                          [--resume-prompt TEXT]
  paseo-slurm group wait GROUP_ID
  paseo-slurm group status [GROUP_ID]
  paseo-slurm group cancel GROUP_ID
  paseo-slurm group repair GROUP_ID --submission TOKEN
                           (--job-id ID [--sentinel PATH] [--array] |
                            --drop-submission)
  paseo-slurm recover
  paseo-slurm cancel REGISTRATION_ID
  paseo-slurm abandon --wait-id ID --generation TOKEN [--agent-id ID]
                       [--paseo-bin PATH]`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  switch (command) {
    case "submit":
      await submit(argv);
      break;
    case "wait":
      await waitCurrentGroup(args);
      break;
    case "register":
      await register(args);
      break;
    case "_watch": {
      const id = args.positionals[1];
      if (!id) throw new Error("registration ID is required");
      const controllerGeneration = args.positionals[2];
      if (!controllerGeneration) throw new Error("controller generation is required");
      await watchRegistration(id, controllerGeneration);
      break;
    }
    case "_watch_group": {
      const id = args.positionals[1];
      if (!id) throw new Error("group ID is required");
      const controllerGeneration = args.positionals[2];
      if (!controllerGeneration) throw new Error("controller generation is required");
      await watchGroup(id, controllerGeneration);
      break;
    }
    case "group":
      await groupCommand(args);
      break;
    case "status":
      status(args);
      break;
    case "recover":
      await recover();
      break;
    case "cancel":
      await cancel(args);
      break;
    case "abandon":
      await abandon(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
