// Checks the installed Paseo supervisor's respawn rules with a dummy worker, in isolation from
// the live daemon (no port, no ~/.paseo). Expected from scripts/supervisor.ts:
//   SIGKILL of a ready worker -> "crashed" -> a new worker is spawned;
//   SIGTERM of a ready worker -> not a crash -> the supervisor exits.
// Usage: node supervisor-respawn-check.mjs [SERVER_PACKAGE_DIR]
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const self = fileURLToPath(import.meta.url);
const [mode, pkgArg] = process.argv.slice(2);
const pkg =
  pkgArg ??
  path.join(os.homedir(), ".nvm/versions/node/v24.15.0/lib/node_modules/@getpaseo/server");

if (mode === "worker") {
  process.send?.({ type: "paseo:ready", listen: "127.0.0.1:0", serverId: "srv_respawn_check" });
  process.on("message", (message) => {
    if (message?.type === "paseo:graceful-shutdown") process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (mode === "host") {
  const { runSupervisor } = await import(path.join(pkg, "dist/scripts/supervisor.js"));
  runSupervisor({
    name: "RespawnCheck",
    startupMessage: "respawn check supervisor",
    resolveWorkerEntry: () => self,
    workerArgs: ["worker"],
    workerExecArgv: [],
    restartOnCrash: true,
  });
} else {
  const host = spawn(process.execPath, [self, "host", pkg], { stdio: ["ignore", "ignore", "pipe"] });
  let hostExit = null;
  host.on("exit", (code, signal) => (hostExit = { code, signal }));
  const children = () => {
    try {
      return execFileSync("ps", ["-o", "pid=", "--ppid", String(host.pid)], { encoding: "utf8" })
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const waitForWorker = async (not) => {
    for (let i = 0; i < 100; i += 1) {
      const pid = children().find((candidate) => candidate !== not);
      if (pid) return pid;
      await delay(100);
    }
    return null;
  };
  const results = [];
  const first = await waitForWorker(null);
  await delay(500); // let the ready message arrive
  process.kill(first, "SIGKILL");
  const second = await waitForWorker(first);
  results.push(["SIGKILL of a ready worker respawns it", second !== null, `${first} -> ${second}`]);
  if (second) {
    await delay(500);
    process.kill(second, "SIGTERM");
    for (let i = 0; i < 50 && hostExit === null; i += 1) await delay(100);
    results.push([
      "SIGTERM of the worker makes the supervisor exit",
      hostExit !== null && children().length === 0,
      JSON.stringify(hostExit),
    ]);
  }
  if (hostExit === null) host.kill("SIGKILL");
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${detail})`);
    if (!ok) failed += 1;
  }
  process.exitCode = failed === 0 && results.length === 2 ? 0 : 1;
}
