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
      const children = new Map();
      for (const line of String(stdout).split("\n")) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        if (!p || !Number.isFinite(pp)) continue;
        if (!children.has(pp)) children.set(pp, []);
        children.get(pp).push(p);
      }
      const out = [];
      const queue = [pid];
      while (queue.length) {
        for (const c of children.get(queue.shift()) ?? []) {
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

// One kill attempt: true when the exit was seen.
async function killTree(child, timeoutMs) {
  if (!child.pid) return true;
  const alive = isChildAlive(child);
  // Subscribed before the kill, so an immediate exit is not missed.
  const exited = alive
    ? /** @type {Promise<boolean>} */ (new Promise((resolve) => child.once("exit", () => resolve(true))))
    : Promise.resolve(true);
  // Also for an exited child: on POSIX its commands can outlive it in its process group.
  const killed = treeKill(child.pid, { childAlive: alive }).catch(() => {});
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const bounded = /** @type {Promise<boolean>} */ (new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  }));
  const observed = await Promise.race([exited, bounded]);
  // The tree kill too, on the same deadline: on POSIX it walks the tree with ps first, and a child
  // exiting meanwhile would end the attempt before its commands were killed.
  await Promise.race([killed, bounded]);
  clearTimeout(timer);
  return observed;
}

// Last resort for a process about to exit: SIGKILL to the group and the child, no ps walk. POSIX
// only; on win32 the kill is taskkill, which a stop runs.
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

// The processes still to stop. An entry leaves once a stop saw its exit, after the tree kill, or
// when its owner releases it; until then a second signal reaches it.
export function createChildRegistry() {
  /** @type {Map<TrackedChild, ChildKill>} */
  const live = new Map();
  let closed = false;
  return {
    /**
     * Calls start, which spawns, only while the registry is open, and tracks what it started.
     * @param {() => ChildKill | null} start
     * @returns {TrackedChild | null}
     */
    track(start) {
      if (closed) throw makeError("spawn-failed", "the server is shutting down, so no process was started");
      const kill = start();
      if (!kill) return null;
      /** @type {Promise<boolean> | null} */
      let stopping = null;
      // A rejection or a throw counts as an exit not seen.
      const attempt = (timeoutMs) => {
        try { return Promise.resolve(kill.kill(timeoutMs)).catch(() => false); } catch { return Promise.resolve(false); }
      };
      /** @type {TrackedChild} */
      const entry = {
        child: kill.child,
        // Memoized while in flight. An attempt that did not see the exit is retried once; a stop that
        // still did not is not memoized, so the next one kills again.
        stop: ({ timeoutMs = KILL_WAIT_MS } = {}) => {
          if (!live.has(entry)) return Promise.resolve(true);
          stopping ??= attempt(timeoutMs).then((seen) => seen || attempt(timeoutMs)).then((seen) => {
            stopping = null;
            if (seen) live.delete(entry);
            return seen;
          });
          return stopping;
        },
        // For a child that closed by itself. A stop under way keeps it until the stop settles.
        release: () => { if (!stopping) live.delete(entry); },
      };
      live.set(entry, kill);
      return entry;
    },
    // Refuses every later spawn and resolves once every stop settled.
    stopAll() {
      closed = true;
      return Promise.all([...live.keys()].map((entry) => entry.stop())).then(() => undefined);
    },
    // For a second signal, which exits at once. A child whose stop saw its exit has left: its pid
    // may be reused by then.
    killAllNow() {
      closed = true;
      for (const kill of live.values()) kill.killNow();
    },
  };
}

export const children = createChildRegistry();

/**
 * The one place a process starts. Null when the launcher is not found; throws spawn-failed once
 * shutdown began, before spawning.
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
    return { child, kill: (timeoutMs) => killTree(child, timeoutMs), killNow: () => killGroupNow(child) };
  });
}
