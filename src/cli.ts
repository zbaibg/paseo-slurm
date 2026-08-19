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
  source: "sacct" | "sentinel";
}

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
  resumePrompt?: string;
  paseoBin: string;
  createdAt: string;
  updatedAt: string;
  status: "registered" | "watching" | "terminal" | "resumed" | "resume_failed" | "cancelled";
  watcherPid?: number;
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

export interface WaitGroup {
  id: string;
  agentId: string;
  mode: WaitGroupMode;
  intervalSeconds: number;
  sentinelPollSeconds?: number;
  paseoBin: string;
  createdAt: string;
  updatedAt: string;
  status: "open" | "watching" | "completed" | "resume_failed" | "cancelled";
  items: WaitGroupItem[];
  watcherPid?: number;
  error?: string;
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
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

function mutateGroup(id: string, mutate: (group: WaitGroup) => void): WaitGroup {
  const group = readGroup(id);
  mutate(group);
  writeGroup(group);
  return group;
}

function activeGroupForAgent(agentId: string): WaitGroup | undefined {
  ensureStateDirs();
  return readdirSync(groupsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(groupsDir(), name), "utf8")) as WaitGroup)
    .find(
      (group) =>
        group.agentId === agentId &&
        ["open", "watching", "resume_failed"].includes(group.status),
    );
}

function activeRegistrationForAgent(agentId: string): Registration | undefined {
  ensureStateDirs();
  return readdirSync(registrationsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(registrationsDir(), name), "utf8")) as Registration)
    .find(
      (registration) =>
        registration.agentId === agentId &&
        ["registered", "watching", "terminal", "resume_failed"].includes(registration.status),
    );
}

function createGroupRecord(options: {
  agentId: string;
  mode: WaitGroupMode;
  intervalSeconds: number;
  sentinelPollSeconds: number;
  paseoBin: string;
}): WaitGroup {
  const activeGroup = activeGroupForAgent(options.agentId);
  if (activeGroup) {
    throw new Error(`agent ${options.agentId} already owns active group ${activeGroup.id}`);
  }
  const activeRegistration = activeRegistrationForAgent(options.agentId);
  if (activeRegistration) {
    throw new Error(
      `agent ${options.agentId} already owns active registration ${activeRegistration.id}; cancel or finish it before creating a group`,
    );
  }
  const now = new Date().toISOString();
  const group: WaitGroup = {
    id: `${options.agentId.slice(0, 8)}-group-${Date.now()}`,
    agentId: options.agentId,
    mode: options.mode,
    intervalSeconds: options.intervalSeconds,
    sentinelPollSeconds: options.sentinelPollSeconds,
    paseoBin: options.paseoBin,
    createdAt: now,
    updatedAt: now,
    status: "open",
    items: [],
  };
  const labelError = updateExternalWaitLabel(group, group.id);
  if (labelError) {
    throw new Error(`failed to create external wait group with Paseo: ${labelError}`);
  }
  try {
    writeGroup(group);
  } catch (error) {
    updateExternalWaitLabel(group, "");
    throw error;
  }
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
  group: Pick<WaitGroup, "mode" | "items">,
): { items: WaitGroupItem[]; final: boolean } | undefined {
  const ready = group.items.filter((item) => item.status === "terminal" && item.result);
  if (ready.length === 0) return undefined;
  const hasPending = group.items.some((item) => item.status === "pending");
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

function querySacct(jobId: string, array = false): SlurmResult | undefined {
  if (array) {
    const active = spawnSync("squeue", ["-h", "-j", jobId, "-o", "%i"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (!active.error && active.status === 0 && active.stdout.trim()) return undefined;
  }
  const result = spawnSync(
    "sacct",
    ["-X", "-n", "-P", "-j", jobId, "--format=JobID,JobIDRaw,State,ExitCode,Elapsed"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sacct exited ${result.status}: ${result.stderr.trim()}`);
  }
  return parseSacct(result.stdout, jobId);
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

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnWatcher(id: string): number {
  ensureStateDirs();
  const script = fileURLToPath(import.meta.url);
  const output = openSync(logPath(id), "a");
  const child = spawn(process.execPath, [script, "_watch", id], {
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("failed to start detached watcher");
  return child.pid;
}

function spawnGroupWatcher(id: string): number {
  ensureStateDirs();
  const script = fileURLToPath(import.meta.url);
  const output = openSync(logPath(id), "a");
  const child = spawn(process.execPath, [script, "_watch_group", id], {
    detached: true,
    stdio: ["ignore", output, output],
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("failed to start detached group watcher");
  return child.pid;
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

async function sendResume(registration: Registration, result: SlurmResult): Promise<void> {
  const prompt = buildResumePrompt(registration, result);
  await waitForAgentToPark(registration);
  let lastError = "";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const clearError = updateExternalWaitLabel(registration, "");
    if (clearError) {
      lastError = `failed to clear external wait label: ${clearError}`;
      appendLog(registration.id, `resume attempt ${attempt} failed: ${lastError}`);
      if (attempt < 10) await sleep(10_000);
      continue;
    }

    const sent = spawnSync(
      registration.paseoBin,
      ["send", registration.agentId, "--prompt", prompt, "--system", "--no-wait"],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (!sent.error && sent.status === 0) {
      appendLog(registration.id, `resumed agent ${registration.agentId}`);
      return;
    }
    lastError = sent.error?.message || sent.stderr.trim() || `paseo exited ${sent.status}`;
    const restoreError = updateExternalWaitLabel(registration, registration.id);
    if (restoreError) {
      lastError = `${lastError}; failed to restore external wait label: ${restoreError}`;
    }
    appendLog(registration.id, `resume attempt ${attempt} failed: ${lastError}`);
    if (attempt < 10) await sleep(10_000);
  }
  throw new Error(lastError);
}

async function watchRegistration(id: string): Promise<void> {
  let registration = readRegistration(id);
  if (registration.status === "cancelled" || registration.status === "resumed") return;
  registration.status = "watching";
  registration.watcherPid = process.pid;
  writeRegistration(registration);
  appendLog(id, `watching job ${registration.jobId}`);
  const sentinelWatcher = new SentinelWatcher();
  let nextSacctAt = Date.now() + registration.intervalSeconds * 1000;
  try {
    while (true) {
      registration = readRegistration(id);
      if (registration.status === "cancelled") return;
      sentinelWatcher.update([registration.sentinelPath]);
      const observedGeneration = sentinelWatcher.snapshot();
      try {
        let result = querySentinel(registration.sentinelPath);
        if (!result && Date.now() >= nextSacctAt) {
          result = querySacct(registration.jobId, registration.array);
          nextSacctAt = Date.now() + registration.intervalSeconds * 1000;
        }
        if (result) {
          registration.status = "terminal";
          registration.result = result;
          writeRegistration(registration);
          appendLog(
            id,
            `terminal state ${result.state} exit=${result.exitCode} source=${result.source}`,
          );
          try {
            await sendResume(registration, result);
            registration = readRegistration(id);
            registration.status = "resumed";
            registration.error = undefined;
            writeRegistration(registration);
            return;
          } catch (error) {
            registration = readRegistration(id);
            registration.status = "resume_failed";
            registration.error = error instanceof Error ? error.message : String(error);
            writeRegistration(registration);
            process.exitCode = 1;
            return;
          }
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

async function sendGroupResume(
  group: WaitGroup,
  items: WaitGroupItem[],
  final: boolean,
): Promise<void> {
  const prompt = buildGroupResumePrompt(group, items, final);
  let lastError = "";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (final) {
      const clearError = updateExternalWaitLabel(group, "");
      if (clearError) {
        lastError = `failed to clear external wait label: ${clearError}`;
        appendLog(group.id, `resume attempt ${attempt} failed: ${lastError}`);
        if (attempt < 10) await sleep(10_000);
        continue;
      }
    }

    const sent = spawnSync(
      group.paseoBin,
      ["send", group.agentId, "--prompt", prompt, "--system", "--no-wait"],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (!sent.error && sent.status === 0) {
      appendLog(
        group.id,
        `resumed agent ${group.agentId} jobs=${items.map((item) => item.jobId).join(",")} final=${final}`,
      );
      return;
    }
    lastError = sent.error?.message || sent.stderr.trim() || `paseo exited ${sent.status}`;
    if (final) {
      const restoreError = updateExternalWaitLabel(group, group.id);
      if (restoreError) {
        lastError = `${lastError}; failed to restore external wait label: ${restoreError}`;
      }
    }
    appendLog(group.id, `resume attempt ${attempt} failed: ${lastError}`);
    if (attempt < 10) await sleep(10_000);
  }
  throw new Error(lastError);
}

async function watchGroup(id: string): Promise<void> {
  let group = mutateGroup(id, (current) => {
    if (current.status !== "cancelled" && current.status !== "completed") {
      current.status = "watching";
      current.watcherPid = process.pid;
    }
  });
  if (group.status === "cancelled" || group.status === "completed") return;
  appendLog(id, `watching group mode=${group.mode} jobs=${group.items.map((item) => item.jobId).join(",")}`);
  const sentinelWatcher = new SentinelWatcher();
  const nextSacctAt = new Map<string, number>();
  try {
    while (true) {
      group = readGroup(id);
      if (group.status === "cancelled" || group.status === "completed") return;
      const pendingItems = group.items.filter((candidate) => candidate.status === "pending");
      sentinelWatcher.update(pendingItems.map((item) => item.sentinelPath));
      const observedGeneration = sentinelWatcher.snapshot();

      for (const item of pendingItems) {
        try {
          let result = querySentinel(item.sentinelPath);
          const backupIntervalSeconds = item.sentinelPath
            ? group.intervalSeconds
            : Math.min(group.intervalSeconds, 5);
          const dueAt =
            nextSacctAt.get(item.jobId) ?? Date.now() + backupIntervalSeconds * 1000;
          nextSacctAt.set(item.jobId, dueAt);
          if (!result && Date.now() >= dueAt) {
            result = querySacct(item.jobId, item.array);
            nextSacctAt.set(item.jobId, Date.now() + backupIntervalSeconds * 1000);
          }
          if (!result) continue;
          mutateGroup(id, (current) => {
            const currentItem = current.items.find((candidate) => candidate.jobId === item.jobId);
            if (!currentItem || currentItem.status !== "pending") return;
            currentItem.status = "terminal";
            currentItem.result = result;
          });
          nextSacctAt.delete(item.jobId);
          appendLog(
            id,
            `terminal job=${item.jobId} state=${result.state} exit=${result.exitCode} source=${result.source}`,
          );
        } catch (error) {
          appendLog(
            id,
            `status check failed job=${item.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      group = readGroup(id);
      let dispatch = selectGroupDispatch(group);
      if (dispatch) {
        try {
          await waitForAgentToPark(group);
          group = readGroup(id);
          if (group.status === "cancelled" || group.status === "completed") return;
          dispatch = selectGroupDispatch(group);
          if (!dispatch) continue;
          await sendGroupResume(group, dispatch.items, dispatch.final);
          const dispatchedJobIds = new Set(dispatch.items.map((item) => item.jobId));
          group = mutateGroup(id, (current) => {
            for (const item of current.items) {
              if (dispatchedJobIds.has(item.jobId) && item.status === "terminal") {
                item.status = "notified";
              }
            }
            current.status = dispatch?.final ? "completed" : "watching";
            current.error = undefined;
          });
          if (dispatch.final) return;
        } catch (error) {
          mutateGroup(id, (current) => {
            current.status = "resume_failed";
            current.error = error instanceof Error ? error.message : String(error);
          });
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

function submit(argv: string[]): void {
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
    group = createGroupRecord({
      agentId,
      mode: (requestedMode || "each") as WaitGroupMode,
      intervalSeconds,
      sentinelPollSeconds,
      paseoBin,
    });
  } else {
    if (requestedMode && requestedMode !== group.mode) {
      throw new Error(`active group ${group.id} uses mode=${group.mode}, not ${requestedMode}`);
    }
    if (group.mode === "all" && group.status === "watching") {
      throw new Error("cannot submit jobs to an all-mode group after watching starts");
    }
  }

  ensureStateDirs();
  const source = readFileSync(scriptPath, "utf8");
  const sentinelMode = stringOption(args, "sentinel") || "auto";
  if (sentinelMode !== "auto" && sentinelMode !== "off") {
    throw new Error("--sentinel must be auto or off");
  }
  let submittedScriptPath = scriptPath;
  let sentinelPath: string | undefined;
  const sourceDeclaresArray = hasArrayDirective(source);
  if (sentinelMode === "auto" && !sourceDeclaresArray) {
    const token = randomUUID();
    sentinelPath = join(sentinelsDir(), `${group.id}-${token}.done`);
    submittedScriptPath = join(submissionScriptsDir(), `${group.id}-${token}.sbatch`);
    writeFileSync(
      submittedScriptPath,
      buildSentinelWrapper(source, scriptPath, sentinelPath),
      { mode: 0o700 },
    );
  }

  const submitted = spawnSync("sbatch", ["--parsable", submittedScriptPath, ...scriptArgs], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (submitted.error || submitted.status !== 0) {
    throw new Error(
      submitted.error?.message || submitted.stderr.trim() || `sbatch exited ${submitted.status}`,
    );
  }
  const rawJobId = submitted.stdout.trim().split(";", 1)[0];
  const jobId = validateJobId(rawJobId);
  const arrayJob = sourceDeclaresArray || isSlurmArrayJob(jobId);
  if (arrayJob) sentinelPath = undefined;
  try {
    group = mutateGroup(group.id, (current) => {
      current.items.push({
        jobId,
        sentinelPath,
        array: arrayJob || undefined,
        resumePrompt: stringOption(args, "resume-prompt"),
        status: "pending",
      });
    });
  } catch (error) {
    console.error(`UNTRACKED_SLURM_JOB job_id=${jobId} group_id=${group.id}`);
    throw error;
  }
  console.log(
    `SUBMITTED_SLURM group_id=${group.id} mode=${group.mode} job_id=${jobId} array=${arrayJob} sentinel=${sentinelPath ?? "none"}`,
  );
}

function register(args: ParsedArgs): void {
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
  const registration: Registration = {
    id,
    agentId,
    jobId,
    sentinelPath: sentinelPath ? resolve(sentinelPath) : undefined,
    array: arrayJob || undefined,
    intervalSeconds,
    sentinelPollSeconds,
    resumePrompt: stringOption(args, "resume-prompt"),
    paseoBin: stringOption(args, "paseo-bin") || "paseo",
    createdAt: now,
    updatedAt: now,
    status: "registered",
  };
  const labelError = updateExternalWaitLabel(registration, id);
  if (labelError) {
    throw new Error(`failed to register external wait with Paseo: ${labelError}`);
  }
  try {
    writeRegistration(registration);
    registration.watcherPid = spawnWatcher(id);
    registration.status = "watching";
    writeRegistration(registration);
  } catch (error) {
    updateExternalWaitLabel(registration, "");
    throw error;
  }
  console.log(
    `WAITING_SLURM registration_id=${id} job_id=${jobId} watcher_pid=${registration.watcherPid}`,
  );
}

function createGroup(args: ParsedArgs): void {
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
  const group = createGroupRecord({
    agentId,
    mode: rawMode,
    intervalSeconds,
    sentinelPollSeconds,
    paseoBin: stringOption(args, "paseo-bin") || "paseo",
  });
  console.log(
    `SLURM_GROUP group_id=${group.id} mode=${rawMode} sacct_interval=${intervalSeconds} sentinel_poll=${sentinelPollSeconds}`,
  );
}

function addGroupJob(args: ParsedArgs): void {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  const jobId = validateJobId(requiredOption(args, "job-id"));
  const sentinelPath = stringOption(args, "sentinel");
  const arrayJob = isSlurmArrayJob(jobId);
  const group = mutateGroup(id, (current) => {
    if (current.status === "completed" || current.status === "cancelled") {
      throw new Error(`cannot add a job to ${current.status} group ${id}`);
    }
    if (current.mode === "all" && current.status === "watching") {
      throw new Error("cannot add jobs to an all-mode group after watching starts");
    }
    if (current.items.some((item) => item.jobId === jobId)) {
      throw new Error(`job ${jobId} is already in group ${id}`);
    }
    current.items.push({
      jobId,
      sentinelPath: sentinelPath && !arrayJob ? resolve(sentinelPath) : undefined,
      array: arrayJob || undefined,
      resumePrompt: stringOption(args, "resume-prompt"),
      status: "pending",
    });
  });
  console.log(`SLURM_GROUP_ADDED group_id=${id} job_id=${jobId} jobs=${group.items.length}`);
}

function waitGroup(args: ParsedArgs): void {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  let group = readGroup(id);
  if (group.items.length === 0) throw new Error(`group ${id} has no jobs`);
  if (group.status === "completed" || group.status === "cancelled") {
    throw new Error(`cannot wait on ${group.status} group ${id}`);
  }
  const labelError = updateExternalWaitLabel(group, id);
  if (labelError) {
    throw new Error(`failed to activate external wait group with Paseo: ${labelError}`);
  }
  if (!isProcessAlive(group.watcherPid)) {
    const watcherPid = spawnGroupWatcher(id);
    group = mutateGroup(id, (current) => {
      current.watcherPid = watcherPid;
      current.status = "watching";
      current.error = undefined;
    });
  }
  console.log(
    `WAITING_SLURM_GROUP group_id=${id} mode=${group.mode} jobs=${group.items.map((item) => item.jobId).join(",")} watcher_pid=${group.watcherPid}`,
  );
}

function waitCurrentGroup(args: ParsedArgs): void {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const group = activeGroupForAgent(agentId);
  if (!group) throw new Error(`agent ${agentId} has no active Slurm wait group`);
  waitGroup({
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

function cancelGroup(args: ParsedArgs): void {
  const id = args.positionals[2];
  if (!id) throw new Error("group ID is required");
  const group = mutateGroup(id, (current) => {
    current.status = "cancelled";
  });
  const labelError = updateExternalWaitLabel(group, "");
  if (labelError) {
    throw new Error(`cancelled group but failed to clear external wait label: ${labelError}`);
  }
  console.log(`cancelled_group=${id}`);
}

function groupCommand(args: ParsedArgs): void {
  switch (args.positionals[1]) {
    case "create":
      createGroup(args);
      break;
    case "add":
      addGroupJob(args);
      break;
    case "wait":
      waitGroup(args);
      break;
    case "status":
      groupStatus(args);
      break;
    case "cancel":
      cancelGroup(args);
      break;
    default:
      throw new Error("group command must be create, add, wait, status, or cancel");
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

function recover(): void {
  ensureStateDirs();
  let recovered = 0;
  for (const name of readdirSync(registrationsDir()).filter((entry) => entry.endsWith(".json"))) {
    const registration = JSON.parse(
      readFileSync(join(registrationsDir(), name), "utf8"),
    ) as Registration;
    if (!["registered", "watching", "terminal", "resume_failed"].includes(registration.status)) continue;
    if (isProcessAlive(registration.watcherPid)) continue;
    registration.status = "registered";
    registration.error = undefined;
    registration.watcherPid = spawnWatcher(registration.id);
    writeRegistration(registration);
    recovered += 1;
  }
  let recoveredGroups = 0;
  for (const name of readdirSync(groupsDir()).filter((entry) => entry.endsWith(".json"))) {
    const group = JSON.parse(readFileSync(join(groupsDir(), name), "utf8")) as WaitGroup;
    if (!["watching", "resume_failed"].includes(group.status)) continue;
    if (isProcessAlive(group.watcherPid)) continue;
    group.status = "watching";
    group.error = undefined;
    group.watcherPid = spawnGroupWatcher(group.id);
    writeGroup(group);
    recoveredGroups += 1;
  }
  console.log(`recovered=${recovered} recovered_groups=${recoveredGroups}`);
}

function cancel(args: ParsedArgs): void {
  const id = args.positionals[1];
  if (!id) throw new Error("registration ID is required");
  const registration = readRegistration(id);
  registration.status = "cancelled";
  writeRegistration(registration);
  const labelError = updateExternalWaitLabel(registration, "");
  if (labelError) {
    throw new Error(`cancelled watcher but failed to clear external wait label: ${labelError}`);
  }
  console.log(`cancelled=${id}`);
}

function usage(): void {
  console.log(`Usage:
  paseo-slurm submit [--mode each|all] [--resume-prompt TEXT]
                     [--sentinel auto|off] [--sentinel-poll SECONDS]
                     [--sacct-interval SECONDS] -- SCRIPT [ARGS...]
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
  paseo-slurm recover
  paseo-slurm cancel REGISTRATION_ID`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  switch (command) {
    case "submit":
      submit(argv);
      break;
    case "wait":
      waitCurrentGroup(args);
      break;
    case "register":
      register(args);
      break;
    case "_watch": {
      const id = args.positionals[1];
      if (!id) throw new Error("registration ID is required");
      await watchRegistration(id);
      break;
    }
    case "_watch_group": {
      const id = args.positionals[1];
      if (!id) throw new Error("group ID is required");
      await watchGroup(id);
      break;
    }
    case "group":
      groupCommand(args);
      break;
    case "status":
      status(args);
      break;
    case "recover":
      recover();
      break;
    case "cancel":
      cancel(args);
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
