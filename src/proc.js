import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: detached makes the child a process group leader (setsid), which is what lets
// treeKill reach the agent's own children. On win32 it would mean a separate console instead,
// and taskkill /T already walks the tree. Every spawn site applies it, not resolveAcpSpawn —
// an injected spawnSpec has to become a group leader too or the group kill finds nothing.
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

// On win32 a plain child.kill() only reaches the shell wrapper (spawn uses shell: true);
// taskkill /T takes the whole tree so the agent itself dies too.
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    // taskkill /T walks parent links, which an exited leader no longer has: what it started is
    // either gone with it or detached and out of reach. So a post-exit kill has nothing left to
    // reach, and a reaped pid can already belong to somebody else — which makes the gate the
    // whole of it here, where POSIX still has the group to aim at.
    if (!childAlive) return;
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    }));
    return;
  }
  // agy runs each shell command in its own session, outside the agent's group, so the group kill
  // alone left a command running (a sleep outlived a hard-cap teardown in WSL). Walk the parent
  // links first, while the agent is still there to hold them, and kill each descendant and its
  // group too. Only while the child is alive: after a reap its pid can belong to someone else.
  const descendants = childAlive ? await descendantPids(pid) : [];
  // Negative pid signals the whole group, so the agent's descendants go with it. A group outlives
  // its leader while any member is left, which is why this runs even for an exited child: that is
  // the case where descendants are the only thing still running.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  for (const d of descendants) {
    try { process.kill(-d, "SIGKILL"); } catch {}
    try { process.kill(d, "SIGKILL"); } catch {}
  }
  // Reaches a child that is not a group leader, where the group kill raised ESRCH. Skipped once
  // the child is gone, since a reaped pid can already belong to something else.
  if (childAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
