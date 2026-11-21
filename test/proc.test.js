import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { isChildAlive, treeKill } from "../src/proc.js";

const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups" : false };
const win32Only = { skip: process.platform === "win32" ? false : "windows taskkill" };

/** Record what treeKill signals on POSIX, without signalling anything. */
async function recordKills(pid, options) {
  const realKill = process.kill;
  const calls = [];
  process.kill = (target, signal) => {
    calls.push({ target, signal });
  };
  try {
    await treeKill(pid, options);
  } finally {
    process.kill = realKill;
  }
  return calls;
}

test("isChildAlive is false once the child has exited", () => {
  assert.equal(isChildAlive({ exitCode: null, signalCode: null }), true);
  assert.equal(isChildAlive({ exitCode: 0, signalCode: null }), false);
  assert.equal(isChildAlive({ exitCode: null, signalCode: "SIGKILL" }), false);
});

test("treeKill signals nothing without a pid", async () => {
  assert.deepEqual(await recordKills(undefined, { childAlive: true }), []);
  assert.deepEqual(await recordKills(0, { childAlive: true }), []);
});

test("the group is signalled even after the leader has exited", posixOnly, async () => {
  // The whole point of detaching: a group outlives its leader, so the agent can be gone while
  // the commands it started are still in the group, and the group is the only handle left.
  assert.deepEqual(await recordKills(4242, { childAlive: false }), [{ target: -4242, signal: "SIGKILL" }]);
});

test("the bare pid is only signalled while the child is alive", posixOnly, async () => {
  assert.deepEqual(await recordKills(4242, { childAlive: true }), [
    { target: -4242, signal: "SIGKILL" },
    { target: 4242, signal: "SIGKILL" },
  ]);
});

// Real processes below. Recording call shape would not notice that taskkill fired at all, which
// is the whole of the Windows gate: there is no group there, so the bare pid is all it ever has.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const startVictim = async () => {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(alive(victim.pid), "the victim must be running before the kill");
  return victim;
};

test("the windows kill does not fire once the child has exited", win32Only, async () => {
  // Stands in for a pid that was reaped and recycled: treeKill is told the child is gone, so
  // whatever holds that pid now is somebody else's process.
  const victim = await startVictim();
  try {
    await treeKill(victim.pid, { childAlive: false });
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(alive(victim.pid), true, "treeKill killed a pid it was told was no longer the child");
  } finally {
    try { victim.kill(); } catch {}
  }
});

test("the windows kill still fires while the child is alive", win32Only, async () => {
  const victim = await startVictim();
  try {
    await treeKill(victim.pid, { childAlive: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && alive(victim.pid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(victim.pid), false, "the gate swallowed a kill that should have landed");
  } finally {
    try { victim.kill(); } catch {}
  }
});

// agy runs each shell command in its own session (setsid): on Linux `sleep 131` had its own pgid
// and sid, apart from agy's group. The group kill missed it, and a hard-cap teardown left the
// command running (measured in WSL, agy 1.5.14). Real processes: a fake agent leads its group and
// starts a grandchild in a new session, as agy does.
test("treeKill reaches a descendant the agent started in its own session", posixOnly, async () => {
  const agentSrc = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });",
    "console.log(g.pid);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const agent = spawn(process.execPath, ["-e", agentSrc], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise((resolve) => agent.stdout.once("data", (d) => resolve(String(d).trim()))));
  assert.ok(alive(grandchild), "the grandchild must be running before the kill");
  try {
    await treeKill(agent.pid, { childAlive: true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alive(grandchild), false, "the grandchild in its own session survived the kill");
  } finally {
    try { process.kill(grandchild, "SIGKILL"); } catch {}
    try { process.kill(-agent.pid, "SIGKILL"); } catch {}
  }
});
