import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createChildRegistry, isChildAlive, spawnChild, treeKill } from "../src/proc.js";

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

// ps answers 2.5 s after its snapshot, past KILL_WAIT_MS, as on a loaded machine. Returns the PATH
// to restore.
function slowPs() {
  const shim = mkdtempSync(path.join(tmpdir(), "slow-ps-"));
  const script = ["#!/bin/sh", `out=$(PATH='${process.env.PATH}' ps "$@")`, "sleep 2.5", `printf '%s\\n' "$out"`];
  writeFileSync(path.join(shim, "ps"), script.join("\n") + "\n", { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${shim}:${PATH}`;
  return PATH;
}

// The agent exits by itself during the slow walk, leaving its command in its own session for the
// walk's kill.
test("a stop is not done while the walk that reaches a command in its own session runs", posixOnly, async () => {
  const agentSrc = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });",
    "console.log(g.pid);",
    "setTimeout(() => process.exit(0), 500);",
  ].join("\n");
  const tracked = spawnChild(process.execPath, ["-e", agentSrc], { shell: false }, { stdio: ["ignore", "pipe", "ignore"] }, createChildRegistry());
  const grandchild = Number(await new Promise((resolve) => tracked.child.stdout.once("data", (d) => resolve(String(d).trim()))));
  const PATH = slowPs();
  try {
    assert.equal(await tracked.stop(), true);
    const reaped = Date.now() + 300;
    while (alive(grandchild) && Date.now() < reaped) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(grandchild), false, "the stop was done before the walk killed the command in its own session");
  } finally {
    process.env.PATH = PATH;
    try { process.kill(grandchild, "SIGKILL"); } catch {}
  }
});

// The agent stays up until the slow walk's kill, so the stop's first attempt sees no exit and the
// retry starts while that walk runs.
test("a stop retried during a slow walk sees the exit that walk brings", posixOnly, async () => {
  const tracked = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { shell: false }, { stdio: "ignore" }, createChildRegistry());
  const PATH = slowPs();
  try {
    assert.equal(await tracked.stop(), true, "the child exited, yet the stop reported it did not");
  } finally {
    process.env.PATH = PATH;
    try { process.kill(tracked.child.pid, "SIGKILL"); } catch {}
  }
});

// A tracked child whose kill attempts end as scripted: true or false is the exit seen or not,
// "reject" and "throw" a kill that failed.
function scripted(registry, outcomes) {
  const calls = { attempts: 0, killNow: 0 };
  const entry = registry.track(() => ({
    kill: () => {
      calls.attempts++;
      const outcome = outcomes.shift();
      if (outcome === "throw") throw new Error("kill threw");
      if (outcome === "reject") return Promise.reject(new Error("kill failed"));
      return outcome instanceof Promise ? outcome : Promise.resolve(outcome);
    },
    killNow: () => { calls.killNow++; },
  }));
  return { entry, calls };
}

test("a stop retries an attempt that missed the exit once, and the next stop kills again", async () => {
  const { entry, calls } = scripted(createChildRegistry(), [false, false, "reject", "throw", false, true]);
  assert.equal(await entry.stop(), false);
  assert.equal(calls.attempts, 2);
  assert.equal(await entry.stop(), false, "a rejected and a thrown kill are exits not seen");
  assert.equal(calls.attempts, 4);
  assert.equal(await entry.stop(), true);
  assert.equal(calls.attempts, 6);
  assert.equal(await entry.stop(), true);
  assert.equal(calls.attempts, 6, "a stop that saw the exit is not repeated");
});

test("callers join a stop in flight", async () => {
  let seen;
  const { entry, calls } = scripted(createChildRegistry(), [new Promise((r) => { seen = r; })]);
  const first = entry.stop();
  assert.equal(entry.stop(), first);
  seen(true);
  assert.equal(await first, true);
  assert.equal(calls.attempts, 1);
});

test("killNow reaches a child until a stop saw its exit", async () => {
  const registry = createChildRegistry();
  const missed = scripted(registry, [false, false]);
  const seen = scripted(registry, [true]);
  await Promise.all([missed.entry.stop(), seen.entry.stop()]);
  registry.killAllNow();
  assert.equal(missed.calls.killNow, 1);
  assert.equal(seen.calls.killNow, 0, "its pid may belong to another process by now");
});

test("killAllNow reaches every child when one kill throws", () => {
  const registry = createChildRegistry();
  registry.track(() => ({ kill: async () => false, killNow: () => { throw new Error("kill threw"); } }));
  const after = scripted(registry, []);
  registry.killAllNow();
  assert.equal(after.calls.killNow, 1);
});

test("release drops a child no stop is running on, and leaves one whose stop is under way to it", async () => {
  const registry = createChildRegistry();
  const closed = scripted(registry, []);
  closed.entry.release();
  assert.equal(await closed.entry.stop(), true);
  assert.equal(closed.calls.attempts, 0, "a released child is not killed");
  let seen;
  const stopping = scripted(registry, [new Promise((r) => { seen = r; })]);
  const stop = stopping.entry.stop();
  stopping.entry.release();
  registry.killAllNow();
  assert.equal(stopping.calls.killNow, 1, "its stop has not seen the exit yet");
  assert.equal(closed.calls.killNow, 0);
  seen(true);
  assert.equal(await stop, true);
});

test("stopAll waits for every stop, and the registry then refuses a spawn without starting it", async () => {
  const registry = createChildRegistry();
  const slow = scripted(registry, [new Promise((r) => setTimeout(() => r(true), 100))]);
  const missed = scripted(registry, [false, false]);
  const started = Date.now();
  await registry.stopAll();
  assert.ok(Date.now() - started >= 90, "stopAll resolved before the slow stop settled");
  assert.equal(missed.calls.attempts, 2);
  let spawned = false;
  assert.throws(() => registry.track(() => { spawned = true; return null; }), (err) => err.reason === "spawn-failed");
  assert.equal(spawned, false);
});

test("stopAll kills the process spawnChild started, and spawnChild refuses once it ran", async () => {
  const registry = createChildRegistry();
  const tracked = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { shell: false }, { stdio: "ignore" }, registry);
  await new Promise((r) => tracked.child.once("spawn", r));
  assert.ok(alive(tracked.child.pid));
  await registry.stopAll();
  assert.equal(isChildAlive(tracked.child), false);
  assert.throws(
    () => spawnChild(process.execPath, ["-e", ""], { shell: false }, { stdio: "ignore" }, registry),
    (err) => err.reason === "spawn-failed",
  );
});
