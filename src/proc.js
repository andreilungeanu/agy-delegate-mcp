import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: detached makes the child a process group leader, so treeKill reaches its children.
// On win32 it would open a separate console, and taskkill /T walks the tree. Applied at every
// spawn site, so an injected spawnSpec gets it too.
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

// On win32 a plain kill reaches only the shell wrapper; taskkill /T takes the tree.
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
