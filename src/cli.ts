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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

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

export interface SlurmResult {
  state: string;
  exitCode: string;
  elapsed?: string;
  source: "sacct" | "sentinel";
}

interface Registration {
  id: string;
  agentId: string;
  jobId: string;
  sentinelPath?: string;
  intervalSeconds: number;
  resumePrompt?: string;
  paseoBin: string;
  createdAt: string;
  updatedAt: string;
  status: "registered" | "watching" | "terminal" | "resumed" | "resume_failed" | "cancelled";
  watcherPid?: number;
  result?: SlurmResult;
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

function ensureStateDirs(): void {
  mkdirSync(registrationsDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}

function registrationPath(id: string): string {
  return join(registrationsDir(), `${id}.json`);
}

function logPath(id: string): string {
  return join(logsDir(), `${id}.log`);
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
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rowId, rawState, exitCode, elapsed] = line.split("|");
    if (rowId !== jobId) continue;
    const state = normalizeState(rawState ?? "");
    if (!TERMINAL_STATES.has(state)) return undefined;
    return {
      state,
      exitCode: exitCode || "unknown",
      elapsed: elapsed || undefined,
      source: "sacct",
    };
  }
  return undefined;
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

function querySacct(jobId: string): SlurmResult | undefined {
  const result = spawnSync(
    "sacct",
    ["-X", "-n", "-P", "-j", jobId, "--format=JobIDRaw,State,ExitCode,Elapsed"],
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

async function sendResume(registration: Registration, result: SlurmResult): Promise<void> {
  const prompt = buildResumePrompt(registration, result);
  let lastError = "";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const sent = spawnSync(
      registration.paseoBin,
      ["send", registration.agentId, "--prompt", prompt, "--no-wait"],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (!sent.error && sent.status === 0) {
      appendLog(registration.id, `resumed agent ${registration.agentId}`);
      return;
    }
    lastError = sent.error?.message || sent.stderr.trim() || `paseo exited ${sent.status}`;
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

  while (true) {
    registration = readRegistration(id);
    if (registration.status === "cancelled") return;
    try {
      const result = querySentinel(registration.sentinelPath) || querySacct(registration.jobId);
      if (result) {
        registration.status = "terminal";
        registration.result = result;
        writeRegistration(registration);
        appendLog(id, `terminal state ${result.state} exit=${result.exitCode} source=${result.source}`);
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
    await sleep(registration.intervalSeconds * 1000);
  }
}

function register(args: ParsedArgs): void {
  const agentId = stringOption(args, "agent-id") || process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) throw new Error("--agent-id is required outside a Paseo agent");
  const jobId = validateJobId(requiredOption(args, "job-id"));
  const intervalText = stringOption(args, "interval") || "60";
  const intervalSeconds = Number(intervalText);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error("--interval must be a positive integer");
  }
  const sentinelPath = stringOption(args, "sentinel");
  const id = `${agentId.slice(0, 8)}-${jobId}-${Date.now()}`;
  const now = new Date().toISOString();
  const registration: Registration = {
    id,
    agentId,
    jobId,
    sentinelPath: sentinelPath ? resolve(sentinelPath) : undefined,
    intervalSeconds,
    resumePrompt: stringOption(args, "resume-prompt"),
    paseoBin: stringOption(args, "paseo-bin") || "paseo",
    createdAt: now,
    updatedAt: now,
    status: "registered",
  };
  writeRegistration(registration);
  registration.watcherPid = spawnWatcher(id);
  registration.status = "watching";
  writeRegistration(registration);
  console.log(
    `WAITING_SLURM registration_id=${id} job_id=${jobId} watcher_pid=${registration.watcherPid}`,
  );
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
  console.log(`recovered=${recovered}`);
}

function cancel(args: ParsedArgs): void {
  const id = args.positionals[1];
  if (!id) throw new Error("registration ID is required");
  const registration = readRegistration(id);
  registration.status = "cancelled";
  writeRegistration(registration);
  console.log(`cancelled=${id}`);
}

function usage(): void {
  console.log(`Usage:
  paseo-slurm register --job-id ID [--sentinel PATH] [--interval SECONDS]
                       [--resume-prompt TEXT] [--agent-id ID] [--paseo-bin PATH]
  paseo-slurm status [REGISTRATION_ID]
  paseo-slurm recover
  paseo-slurm cancel REGISTRATION_ID`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  switch (command) {
    case "register":
      register(args);
      break;
    case "_watch": {
      const id = args.positionals[1];
      if (!id) throw new Error("registration ID is required");
      await watchRegistration(id);
      break;
    }
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
