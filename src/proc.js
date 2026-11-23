import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { spawnArgv, spawnCommandLine } from "./spawn.js";
import { makeError } from "./errors.js";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: detached makes the child a process group leader, so treeKill reaches its children.
// On win32 it would open a separate console, and taskkill /T walks the tree. Applied in
// spawnChild, so an injected spawnSpec gets it too.
export const DETACHED = process.platform !== "win32";

// Every process below pid, from one `ps` snapshot (Linux and macOS both have -A -o pid=,ppid=).
// Empty when ps is unavailable or fails: the group kill still runs.
function descendantPids(pid) {
  return /** @type {Promise<number[]>} */ (new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      const byParent = new Map();
      for (const line of String(stdout).split("\n")) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        if (!p || !Number.isFinite(pp)) continue;
        if (!byParent.has(pp)) byParent.set(pp, []);
        byParent.get(pp).push(p);
      }
      const out = [];
      const queue = [pid];
      while (queue.length) {
        for (const c of byParent.get(queue.shift()) ?? []) {
          if (!out.includes(c)) { out.push(c); queue.push(c); }
        }
      }
      resolve(out);
    });
  }));
}

// On win32 a plain kill reaches only the launched process (agy.exe, or the cmd.exe or PowerShell
// running a script); taskkill /T takes the tree, agy's commands included.
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    // An exited leader has no tree left for taskkill to walk, and its pid may be reused.
    if (!childAlive) return;
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    }));
    return;
  }
  // agy runs each shell command in its own session, outside its group (measured in WSL), so
  // descendants are walked and killed with their groups too, while the child is alive to hold them.
  const descendants = childAlive ? await descendantPids(pid) : [];
  // The group, even after the leader exited: members can outlive it.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  for (const d of descendants) {
    try { process.kill(-d, "SIGKILL"); } catch {}
    try { process.kill(d, "SIGKILL"); } catch {}
  }
  // A child that is not a group leader; skipped once reaped, as its pid may be reused.
  if (childAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
}

// How long one kill attempt waits for the exit and the tree kill; it elapses when the kill failed or
// the tree walk is slow.
export const KILL_WAIT_MS = 2000;

async function killAndSeeExit(child, timeoutMs) {
  if (!child.pid) return true;
  const alive = isChildAlive(child);
  // Subscribed before the kill, so an immediate exit is not missed.
  const exited = alive
    ? /** @type {Promise<boolean>} */ (new Promise((resolve) => child.once("exit", () => resolve(true))))
    : Promise.resolve(true);
  // Also for an exited child: on POSIX its commands can outlive it in its process group. A walk
  // still running from an earlier attempt is waited on too: only its ps snapshot saw the leader alive.
  const killed = Promise.all([treeKills.get(child), treeKill(child.pid, { childAlive: alive }).catch(() => {})]);
  treeKills.set(child, killed);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const bounded = /** @type {Promise<boolean>} */ (new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  }));
  const observed = await Promise.race([exited, bounded]);
  // The tree kill too, on the same deadline: on POSIX it walks the tree with ps first, and a child
  // exiting meanwhile would end the attempt before its commands were killed.
  const treeKilled = await Promise.race([killed.then(() => true), bounded]);
  clearTimeout(timer);
  return observed && treeKilled;
}

/** @type {WeakMap<import("node:child_process").ChildProcess, Promise<unknown>>} */
const treeKills = new WeakMap();

// Last resort for a process about to exit: no ps walk. POSIX only; on win32 the kill is taskkill,
// which a stop runs.
function killGroupNow(child) {
  if (!child.pid || process.platform === "win32") return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  if (isChildAlive(child)) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
}

/**
 * @typedef {{
 *   child: any,
 *   stop: (opts?: { timeoutMs?: number }) => Promise<boolean>,
 *   release: () => void,
 * }} TrackedChild
 * @typedef {{ child?: any, kill: (timeoutMs: number) => Promise<boolean>, killNow: () => void }} ChildKill
 * @typedef {ReturnType<typeof createChildRegistry>} ChildRegistry
 */

// The processes still to stop. An entry leaves once a stop saw its exit and its tree kill ended, or
// its owner releases it; until then a second signal kills it, and after it its pid may be reused.
export function createChildRegistry() {
  /** @type {Map<TrackedChild, ChildKill>} */
  const live = new Map();
  let closed = false;
  return {
    /**
     * @param {() => ChildKill | null} start
     * @returns {TrackedChild | null}
     */
    track(start) {
      if (closed) throw makeError("spawn-failed", "the server is shutting down, so no process was started");
      const kill = start();
      if (!kill) return null;
      /** @type {Promise<boolean> | null} */
      let stopping = null;
      const attempt = (timeoutMs) => {
        try { return Promise.resolve(kill.kill(timeoutMs)).catch(() => false); } catch { return Promise.resolve(false); }
      };
      /** @type {TrackedChild} */
      const entry = {
        child: kill.child,
        stop: ({ timeoutMs = KILL_WAIT_MS } = {}) => {
          if (!live.has(entry)) return Promise.resolve(true);
          stopping ??= attempt(timeoutMs).then((seen) => seen || attempt(timeoutMs)).then((seen) => {
            stopping = null;
            if (seen) live.delete(entry);
            return seen;
          });
          return stopping;
        },
        // For a child that closed by itself.
        release: () => { if (!stopping) live.delete(entry); },
      };
      live.set(entry, kill);
      return entry;
    },
    stopAll() {
      closed = true;
      return Promise.all([...live.keys()].map((entry) => entry.stop())).then(() => undefined);
    },
    // For a second signal, which exits at once.
    killAllNow() {
      closed = true;
      for (const kill of live.values()) kill.killNow();
    },
  };
}

export const children = createChildRegistry();

/**
 * The one place a process starts. Null when the launcher is not found, looked up before the spawn:
 * through cmd.exe a missing one still spawns, and would read as an agent crash, or to doctor as
 * found. Throws spawn-failed once shutdown began, before spawning.
 * @param {string} command @param {string[] | undefined} args @param {any} options
 * @param {{ cwd?: string, stdio: any }} where
 * @param {ChildRegistry} [registry]
 */
export function spawnChild(command, args, options, { cwd, stdio }, registry = children) {
  return registry.track(() => {
    const launch = spawnArgv(command, args, options);
    if (!launch) return null;
    const [file, argv] = spawnCommandLine(launch.command, launch.args, launch.options);
    const child = spawn(file, argv, { ...launch.options, ...(cwd ? { cwd } : {}), detached: DETACHED, stdio });
    return { child, kill: (timeoutMs) => killAndSeeExit(child, timeoutMs), killNow: () => killGroupNow(child) };
  });
}
