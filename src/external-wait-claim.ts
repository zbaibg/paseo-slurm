import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type ExternalWaitKind = "slurm-registration" | "slurm-group" | "paseo-local";

export interface ExternalWaitRef {
  agentId: string;
  waitId: string;
  kind: ExternalWaitKind;
  generation: string;
}

export interface ExternalWaitClaim extends ExternalWaitRef {
  createdAt: string;
}

interface ActiveExternalWait {
  agentId: string;
  waitId: string;
  kind: ExternalWaitKind;
}

interface TransitionContext {
  agentId: string;
  active: boolean;
  lockAlive: () => boolean;
}

const transitionContext = new AsyncLocalStorage<TransitionContext>();

const ACTIVE_STATE_LOCATIONS: Array<{
  relativeDirectory: string[];
  kind: ExternalWaitKind;
  statuses: Set<string>;
}> = [
  {
    relativeDirectory: ["paseo-slurm", "registrations"],
    kind: "slurm-registration",
    statuses: new Set([
      "preparing",
      "registered",
      "watching",
      "terminal",
      "resume_failed",
      "callback_ambiguous",
      "finalizing",
      "cancelling",
    ]),
  },
  {
    relativeDirectory: ["paseo-slurm", "groups"],
    kind: "slurm-group",
    statuses: new Set([
      "preparing",
      "open",
      "watching",
      "resume_failed",
      "callback_ambiguous",
      "finalizing",
      "cancelling",
    ]),
  },
  {
    relativeDirectory: ["paseo-local", "tasks"],
    kind: "paseo-local",
    statuses: new Set([
      "preparing",
      "starting",
      "watching",
      "terminal",
      "resume_failed",
      "finalizing",
      "cancel_requested",
      "lost",
    ]),
  },
];

const LOCK_HOLDER_SOURCE = String.raw`
const fs = require("node:fs");
const [readyPath, parentPidText, expectedStart] = process.argv.slice(1);
const parentPid = Number(parentPidText);
function processStart(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(/\s+/);
    return fields[0] === "Z" ? undefined : fields[19];
  } catch {
    return undefined;
  }
}
fs.writeFileSync(readyPath, "locked\n", { flag: "wx", mode: 0o600 });
const timer = setInterval(() => {
  if (processStart(parentPid) !== expectedStart) process.exit(0);
}, 100);
timer.unref();
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 60_000);
`;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function stateBase(): string {
  return process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
}

function externalWaitRoot(): string {
  return join(stateBase(), "paseo-external-waits");
}

function claimsDir(): string {
  return join(externalWaitRoot(), "claims");
}

function transitionsDir(): string {
  return join(externalWaitRoot(), "transitions");
}

export function externalWaitAgentKey(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex");
}

export function externalWaitClaimPath(agentId: string): string {
  return join(claimsDir(), `${externalWaitAgentKey(agentId)}.json`);
}

export function externalWaitTransitionPath(agentId: string): string {
  return join(transitionsDir(), `${externalWaitAgentKey(agentId)}.lock`);
}

function processStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(/\s+/);
    return fields[0] === "Z" ? undefined : fields[19];
  } catch {
    return undefined;
  }
}

async function waitForChildClose(
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  milliseconds: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function releaseLockHolder(
  holder: ChildProcess,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (holder.exitCode !== null || holder.signalCode !== null) {
    await closed;
    return;
  }
  if (!holder.kill("SIGTERM")) {
    if (await waitForChildClose(closed, 250)) return;
    throw new Error("failed to signal external-wait transition lock holder");
  }
  if (await waitForChildClose(closed, 5_000)) return;
  if (!holder.kill("SIGKILL")) {
    if (await waitForChildClose(closed, 250)) return;
    throw new Error("external-wait transition lock holder did not terminate");
  }
  if (!(await waitForChildClose(closed, 5_000))) {
    throw new Error("external-wait transition lock release could not be confirmed");
  }
}

/**
 * Runs a consequential transition under one per-agent kernel lock. The helper
 * watches the caller's exact Linux process identity, so caller death releases
 * the lock. Lock files are inert and are never removed based on age.
 */
export async function withExternalWaitTransition<T>(
  agentId: string,
  transition: () => T | Promise<T>,
): Promise<T> {
  const existingContext = transitionContext.getStore();
  if (existingContext?.active && existingContext.agentId === agentId) {
    throw new Error(`nested external-wait transition for agent ${agentId}`);
  }
  mkdirSync(transitionsDir(), { recursive: true, mode: 0o700 });
  const readyPath = join(transitionsDir(), `.${process.pid}-${randomUUID()}.ready`);
  const parentStart = processStartIdentity(process.pid);
  if (!parentStart) throw new Error("cannot determine current process identity for transition lock");
  const holder = spawn(
    "flock",
    [
      "--exclusive",
      "--no-fork",
      externalWaitTransitionPath(agentId),
      process.execPath,
      "-e",
      LOCK_HOLDER_SOURCE,
      readyPath,
      String(process.pid),
      parentStart,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let holderError = "";
  let holderFailed = false;
  holder.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    holderError += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClosed) => {
      holder.once("close", (code, signal) => resolveClosed({ code, signal }));
      holder.once("error", (error) => {
        holderFailed = true;
        holderError += `${holderError ? "\n" : ""}${error.message}`;
        resolveClosed({ code: null, signal: null });
      });
    },
  );
  const deadline = Date.now() + 30_000;
  while (!existsSync(readyPath)) {
    if (holderFailed || holder.exitCode !== null || holder.signalCode !== null) {
      await closed;
      throw new Error(holderError.trim() || "external-wait transition lock holder exited");
    }
    if (Date.now() >= deadline) {
      await releaseLockHolder(holder, closed);
      throw new Error("timed out acquiring external-wait transition lock");
    }
    await sleep(10);
  }

  let result: T | undefined;
  let transitionError: unknown;
  const context: TransitionContext = {
    agentId,
    active: true,
    lockAlive: () => !holderFailed && holder.exitCode === null && holder.signalCode === null,
  };
  try {
    result = await transitionContext.run(context, transition);
  } catch (error) {
    transitionError = error;
  } finally {
    context.active = false;
  }
  let cleanupError: unknown;
  try {
    unlinkSync(readyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
  }
  try {
    await releaseLockHolder(holder, closed);
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (transitionError) {
      const original = transitionError instanceof Error ? transitionError.message : String(transitionError);
      throw new Error(`${original}; external-wait lock release failed: ${detail}`);
    }
    throw cleanupError;
  }
  if (transitionError) throw transitionError;
  return result as T;
}

function requireTransition(agentId: string): void {
  const context = transitionContext.getStore();
  if (!context?.active || context.agentId !== agentId || !context.lockAlive()) {
    throw new Error(`external-wait operation for agent ${agentId} requires its transition lock`);
  }
}

function readClaim(path: string): ExternalWaitClaim {
  return JSON.parse(readFileSync(path, "utf8")) as ExternalWaitClaim;
}

function writeClaim(claim: ExternalWaitClaim): void {
  requireTransition(claim.agentId);
  const path = externalWaitClaimPath(claim.agentId);
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readExternalWaitClaim(agentId: string): ExternalWaitClaim | undefined {
  try {
    return readClaim(externalWaitClaimPath(agentId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function listExternalWaitClaims(kind?: ExternalWaitKind): ExternalWaitClaim[] {
  if (!existsSync(claimsDir())) return [];
  const claims: ExternalWaitClaim[] = [];
  for (const name of readdirSync(claimsDir()).filter((entry) => entry.endsWith(".json"))) {
    try {
      const claim = readClaim(join(claimsDir(), name));
      if (!kind || claim.kind === kind) claims.push(claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return claims;
}

function sameWait(
  left: Pick<ExternalWaitClaim, "agentId" | "waitId" | "kind">,
  right: Pick<ExternalWaitClaim, "agentId" | "waitId" | "kind">,
): boolean {
  return left.agentId === right.agentId && left.waitId === right.waitId && left.kind === right.kind;
}

function describeWait(wait: Pick<ExternalWaitClaim, "waitId" | "kind">): string {
  switch (wait.kind) {
    case "slurm-registration":
      return `Slurm registration ${wait.waitId}`;
    case "slurm-group":
      return `Slurm wait ${wait.waitId}`;
    case "paseo-local":
      return `paseo-local task ${wait.waitId}`;
  }
}

function activeExternalWaits(agentId: string): ActiveExternalWait[] {
  const active: ActiveExternalWait[] = [];
  for (const location of ACTIVE_STATE_LOCATIONS) {
    const directory = join(stateBase(), ...location.relativeDirectory);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        id: string;
        agentId: string;
        status: string;
      };
      if (record.agentId !== agentId || !location.statuses.has(record.status)) continue;
      active.push({ agentId, waitId: record.id, kind: location.kind });
    }
  }
  return active;
}

function publishClaim(claim: ExternalWaitClaim): boolean {
  requireTransition(claim.agentId);
  mkdirSync(claimsDir(), { recursive: true, mode: 0o700 });
  const path = externalWaitClaimPath(claim.agentId);
  const temporary = join(claimsDir(), `.${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    unlinkSync(temporary);
  }
}

export function claimExternalWait(options: {
  agentId: string;
  waitId: string;
  kind: ExternalWaitKind;
  /** Reuse a generation already persisted in the matching state record. */
  generation?: string;
  allowExisting?: boolean;
  /** Deterministic test hook invoked after EEXIST and before reading the owner. */
  onExistingClaim?: (path: string) => void;
}): ExternalWaitClaim {
  requireTransition(options.agentId);
  const persistedGeneration = options.generation?.trim();
  if (options.generation !== undefined && !persistedGeneration) {
    throw new Error("external-wait generation must not be empty");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requested: ExternalWaitClaim = {
      agentId: options.agentId,
      waitId: options.waitId,
      kind: options.kind,
      generation: persistedGeneration || randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const created = publishClaim(requested);
    let owner: ExternalWaitClaim;
    if (created) {
      owner = requested;
    } else {
      options.onExistingClaim?.(externalWaitClaimPath(options.agentId));
      try {
        owner = readClaim(externalWaitClaimPath(options.agentId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (!owner.generation && sameWait(owner, requested) && options.allowExisting) {
      owner.generation = randomUUID();
      writeClaim(owner);
    }
    if (!sameWait(owner, requested) || (!created && !options.allowExisting)) {
      throw new Error(`agent ${options.agentId} already owns active ${describeWait(owner)}`);
    }
    try {
      const conflict = activeExternalWaits(options.agentId).find(
        (wait) => !options.allowExisting || !sameWait(wait, requested),
      );
      if (conflict) {
        throw new Error(`agent ${options.agentId} already owns active ${describeWait(conflict)}`);
      }
    } catch (error) {
      if (created) releaseExternalWaitClaim(owner);
      throw error;
    }
    return owner;
  }
  throw new Error("external-wait claim changed repeatedly during acquisition");
}

export function assertExternalWaitOwnership(expected: ExternalWaitRef): ExternalWaitClaim {
  requireTransition(expected.agentId);
  const owner = readExternalWaitClaim(expected.agentId);
  if (!owner || !sameWait(owner, expected) || owner.generation !== expected.generation) {
    throw new Error(`external-wait ownership fence rejected ${expected.kind} ${expected.waitId}`);
  }
  return owner;
}

export function releaseExternalWaitClaim(expected: ExternalWaitRef): void {
  requireTransition(expected.agentId);
  assertExternalWaitOwnership(expected);
  const legacyReleaseLock = `${externalWaitClaimPath(expected.agentId)}.lock`;
  try {
    rmdirSync(legacyReleaseLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  unlinkSync(externalWaitClaimPath(expected.agentId));
  if (readExternalWaitClaim(expected.agentId)) {
    throw new Error(`external-wait claim release was not durable for agent ${expected.agentId}`);
  }
}
