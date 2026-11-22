import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { isChildAlive } from "../src/proc.js";

// process.kill(pid, 0) probes without signalling. EPERM means the pid is taken by a process we
// may not signal, which still counts as alive; ESRCH is the only "gone". A killed orphan whose
// reaper has not run keeps its pid as a zombie, so on Linux the state decides — otherwise a
// suite run where the runner is itself pid 1 reads every dead descendant as alive.
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (err) { return err.code === "EPERM"; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return true; }
}

async function until(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function fakeSpawn() {
  // fileURLToPath (not .pathname) is required on Windows: pathname yields a
  // leading-slash form ("/D:/...") that node.exe mis-resolves as a relative
  // path, double-prefixing the drive letter when spawned.
  return { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))], options: { shell: false } };
}

test("client initializes, opens a session, prompts and emits updates", async () => {
  const updates = [];
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  client.on("update", (u) => updates.push(u));
  // The wire assertion below reads the flight recorder, which is opt-in and reads the flag when
  // start() builds the peer.
  const prevTranscript = process.env.AGY_DELEGATE_TRANSCRIPT;
  process.env.AGY_DELEGATE_TRANSCRIPT = "50";
  try { await client.start(); }
  finally {
    if (prevTranscript === undefined) delete process.env.AGY_DELEGATE_TRANSCRIPT;
    else process.env.AGY_DELEGATE_TRANSCRIPT = prevTranscript;
  }
  const caps = await client.initialize();
  assert.equal(caps.protocolVersion, 1);
  assert.equal(client.agentCapabilities.sessionCapabilities.resume !== undefined, true);
  const s = await client.newSession(process.cwd());
  assert.equal(s.sessionId, "sess-1");
  assert.equal(client.sessionMeta.antigravity.tier.name, "Google AI Pro");
  await client.setModel(s.sessionId, "gemini-3.8-flash");
  await client.setConfigOption(s.sessionId, "thought_level", "low");
  await client.setMode(s.sessionId, "accept-edits");
  const res = await client.prompt(s.sessionId, [{ type: "text", text: "do it" }]);
  assert.equal(res.stopReason, "end_turn");
  // agy closes a turn with a usage_update after its last message.
  assert.deepEqual(updates.slice(-2).map((u) => u.update.sessionUpdate), ["agent_message_chunk", "usage_update"]);
  const log = client.peer.getLog().filter((e) => e.dir === "out").map((e) => JSON.parse(e.line));
  const init = log.find((f) => f.method === "initialize");
  assert.equal(init.params.clientInfo.name, "agy-delegate-mcp");
  const cfg = log.find((f) => f.method === "session/set_config_option");
  assert.deepEqual(cfg.params, { sessionId: "sess-1", configId: "thought_level", value: "low" });
  client.stop();
});

// How the bridge launches agy on Windows: through cmd.exe, which always spawns. Without the PATH
// check a missing launcher surfaced as agent-exit quoting cmd's localized "is not recognized"
// line, and the reference's spawn-failed row (install agy) never fired. Measured live on 1.1.0.
test("start() reports a missing launcher as spawn-failed when it runs through a shell", async () => {
  const client = new AcpClient({
    spawnSpec: { command: "definitely-not-a-real-command-xyz", args: ["acp"], options: { shell: true } },
  });
  await assert.rejects(() => client.start(), (err) => {
    assert.equal(err.reason, "spawn-failed");
    assert.match(err.message, /not found on PATH. Install the Antigravity CLI/);
    return true;
  });
  await client.stop();
});

test("resumeSession reopens a known session and rejects an unknown one; listSessions lists ids", async () => {
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  await client.start();
  try {
    await client.initialize();
    const r = await client.resumeSession("known-old", process.cwd());
    assert.equal(r.sessionId, "known-old");
    assert.equal(client.configOptions.find((o) => o.id === "model").currentValue, "gemini-4-neon");
    await assert.rejects(() => client.resumeSession("nope", process.cwd()), (err) => {
      assert.equal(err.code, -32603);
      assert.match(err.message, /Failed to read session nope/);
      return true;
    });
    const listed = await client.listSessions();
    assert.ok(listed.sessions.some((x) => x.sessionId === "known-old"));
  } finally {
    await client.stop();
  }
});

test("captures stderr and surfaces it on exit", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: ["-e", "process.stderr.write('stderr-line\\n'); process.exit(3);"],
      options: { shell: false },
    },
  });
  const exit = new Promise((resolve) => client.once("exit", resolve));
  await client.start();
  const info = await exit;
  assert.equal(info.code, 3);
  assert.match(info.stderr, /stderr-line/);
  client.stop();
});

// Mirrors STDERR_CAP in src/acp-client.js. The cap is the contract this pins, so it is stated
// here rather than imported from the module under test.
const STDERR_CAP = 64 * 1024;

// The trim only runs past the cap, which no other test reaches. What it bounds is retained memory:
// stderrBuffer slices to the cap on every read regardless, so deleting the trim changes nothing an
// exit message shows and is visible only in what the client still holds — hence the private read.
test("stderr past the cap keeps a full newest-bytes window without retaining the flood", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/stderr-flood.js", import.meta.url))],
      options: { shell: false },
    },
  });
  try {
    await client.start();
    await until(() => client.stderrBuffer.endsWith("FLOOD-END\n"), 10000, "the flood never arrived");
    assert.equal(client.stderrBuffer.length, STDERR_CAP, "the reported tail is exactly one cap window");
    assert.ok(!client.stderrBuffer.includes("FLOOD-START"), "the oldest stderr is gone from the tail");
    // An absolute bound rather than a comparison against the front chunk, which a single-chunk
    // delivery would satisfy with the trim deleted. Whole-chunk drops alone can leave almost two
    // caps when a pipe read is larger than 64KB; the overflow slice keeps retained memory to one.
    assert.ok(
      client._stderrLength <= STDERR_CAP,
      `retained ${client._stderrLength} bytes across ${client._stderrChunks.length} chunks`
    );
  } finally {
    await client.stop();
  }
});

// Spawn failure was the one untagged failure class: every other error carries a reason,
// so the server rendered this one as a bare "delegate failed:" with no [reason].
test("start() rejects a failed spawn with reason spawn-failed", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: "definitely-not-a-real-command-xyz",
      args: [],
      options: { shell: false },
    },
  });
  await assert.rejects(
    () => client.start(),
    (err) => {
      assert.equal(err.reason, "spawn-failed");
      assert.match(err.message, /Failed to spawn agent \(definitely-not-a-real-command-xyz\)/);
      return true;
    }
  );
  client.stop();
});

test("stop() terminates a live agent child (regression: Windows orphaned agent)", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/silent-stub.js", import.meta.url))],
      options: { shell: false },
    },
  });
  await client.start();
  assert.ok(isChildAlive(client.child), "child must be alive before stop()");
  const exited = new Promise((resolve) => client.child.once("exit", resolve));
  client.stop();
  await exited;
  assert.ok(!isChildAlive(client.child), "child must be dead after stop()");
});

// The agent spawns its own children; killing one pid orphans them. Windows taskkill /T already
// takes the tree, so this only fails on POSIX until treeKill kills the process group there.
test("stop() kills the agent's descendants, not only the direct child", async () => {
  const pidFile = join(tmpdir(), `cdm-grandchild-${process.pid}-${Date.now()}`);
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/spawns-grandchild.js", import.meta.url)), pidFile],
      options: { shell: false },
    },
  });
  let grandchildPid;
  try {
    await client.start();
    const readPid = () => {
      try {
        const raw = readFileSync(pidFile, "utf8");
        return raw.endsWith("\n") ? Number(raw.trim()) : undefined;
      } catch { return undefined; }
    };
    await until(() => readPid() !== undefined, 5000, "fixture never reported a grandchild pid");
    grandchildPid = readPid();
    assert.ok(pidAlive(grandchildPid), "grandchild must be alive before stop()");
    const exited = new Promise((resolve) => client.child.once("exit", resolve));
    client.stop();
    await exited;
    await until(() => !pidAlive(grandchildPid), 5000, "grandchild survived stop()");
  } finally {
    if (grandchildPid && pidAlive(grandchildPid)) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }
    rmSync(pidFile, { force: true });
  }
});

// Exit code 0 is the agent leaving by itself: taskkill /F exits it 1 and SIGKILL sets a signal.
test("a graceful stop closes the agent's sessions and lets it exit by itself", async () => {
  const prevTranscript = process.env.AGY_DELEGATE_TRANSCRIPT;
  process.env.AGY_DELEGATE_TRANSCRIPT = "50";
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  try { await client.start(); }
  finally {
    if (prevTranscript === undefined) delete process.env.AGY_DELEGATE_TRANSCRIPT;
    else process.env.AGY_DELEGATE_TRANSCRIPT = prevTranscript;
  }
  await client.initialize();
  const { sessionId } = await client.newSession(process.cwd());
  const exit = new Promise((resolve) => client.once("exit", resolve));
  assert.equal(await client.stop({ graceMs: 5000 }), true);
  const { code, signal } = await exit;
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, "the agent must exit on its own, not be killed");
  const sent = client.peer.getLog().filter((e) => e.dir === "out").map((e) => JSON.parse(e.line));
  assert.deepEqual(sent.find((f) => f.method === "session/close")?.params, { sessionId });
});

// The bridge sends no appended system prompt today; the option stays for a caller that needs it.
test("newSession sends an appended system prompt only when asked for one", async () => {
  const prev = process.env.AGY_DELEGATE_TRANSCRIPT;
  process.env.AGY_DELEGATE_TRANSCRIPT = "50";
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  try { await client.start(); }
  finally {
    if (prev === undefined) delete process.env.AGY_DELEGATE_TRANSCRIPT;
    else process.env.AGY_DELEGATE_TRANSCRIPT = prev;
  }
  try {
    await client.initialize();
    await client.newSession(process.cwd());
    await client.newSession(process.cwd(), { appendSystemPrompt: "Be brief." });
    const opens = client.peer.getLog().filter((e) => e.dir === "out").map((e) => JSON.parse(e.line))
      .filter((f) => f.method === "session/new");
    assert.equal(opens[0].params._meta, undefined);
    assert.deepEqual(opens[1].params._meta, { antigravity: { systemPrompt: { append: "Be brief." } } });
  } finally {
    await client.stop();
  }
});

test("a force stop cuts a graceful stop's grace short", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/close-ignoring-stub.js", import.meta.url))],
      options: { shell: false },
    },
  });
  await client.start();
  await client.initialize();
  await client.newSession(process.cwd());
  const graceful = client.stop({ graceMs: 10000 });
  await new Promise((r) => setTimeout(r, 100));
  const started = Date.now();
  assert.equal(await client.stop(), true, "the force stop must observe the exit");
  assert.ok(Date.now() - started < 3000, `the force stop waited ${Date.now() - started} ms on the grace`);
  assert.equal(await graceful, true);
});

test("an agent that exits closes the steer window", async () => {
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  await client.start();
  await client.initialize();
  const { sessionId } = await client.newSession(process.cwd());
  client.acceptSteers(true);
  const exited = new Promise((resolve) => client.once("exit", resolve));
  process.kill(client.child.pid);
  await exited;
  assert.equal(client.steer(sessionId, "go left"), "not-running");
  await client.stop();
});

// Collapsed into one flag, "not opened yet" and "closed for good" both read as not-ready, which
// tells the caller to retry a turn that has already ended.
test("steer reports not-ready before the window opens and not-running once it has closed", async () => {
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  await client.start();
  await client.initialize();
  const { sessionId } = await client.newSession(process.cwd());
  assert.equal(client.steer(sessionId, "x"), "not-ready");
  client.cancel(sessionId);
  assert.equal(client.steer(sessionId, "x"), "not-running");
  client.acceptSteers(true);
  assert.equal(client.steer(sessionId, "x"), "not-running", "a cancelled window must not reopen");
  await client.stop();
});

test("a graceful stop still kills an agent that ignores session/close and EOF", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/close-ignoring-stub.js", import.meta.url))],
      options: { shell: false },
    },
  });
  await client.start();
  await client.initialize();
  await client.newSession(process.cwd());
  const started = Date.now();
  assert.equal(await client.stop({ graceMs: 300 }), true, "the kill after the grace must be observed");
  assert.ok(!isChildAlive(client.child));
  assert.ok(Date.now() - started < 3000, `stop took ${Date.now() - started} ms`);
});

function silentStub() {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/silent-stub.js", import.meta.url))],
    options: { shell: false },
  };
}

test("stop() is idempotent and reports the exit it observed", async () => {
  const client = new AcpClient({ spawnSpec: silentStub() });
  await client.start();
  const first = client.stop();
  assert.equal(client.stop(), first, "a second caller must join the same teardown, not start one");
  assert.equal(await first, true, "the child was observed to exit");
  assert.equal(await client.stop(), true, "a later caller gets the same answer");
});

// A real agent cannot swallow SIGKILL, so the exit event is withheld: the pid stays real and
// is still killed; only the notification this waits on goes missing. A missed exit is not memoized.
test("stop() retries teardown after a missed exit", async () => {
  const client = new AcpClient({ spawnSpec: silentStub() });
  await client.start();
  const child = client.child;
  const reallyExited = new Promise((resolve) => child.once("exit", resolve));
  client.child = { pid: child.pid, exitCode: null, signalCode: null, once: () => {} };
  const first = client.stop({ timeoutMs: 25 });
  assert.equal(await first, false, "an exit that never arrives is not observed");
  assert.equal(client._stopping, null, "a missed exit must not stay memoized");
  const second = client.stop({ timeoutMs: 25 });
  assert.notEqual(second, first, "force-retry must dispatch a new teardown");
  assert.equal(await second, false);
  await reallyExited;
});

// The missed-exit tests above still let emitExit run on the real child, so they cannot see a
// hung prompt: the live process dies and the exit handler settles the RPC. This one drops
// those listeners first, which is the kill-failed path — stop() times out, the child is
// still treated as alive, and nothing else will reject session/prompt.
test("stop() rejects in-flight RPCs when the child does not exit", async () => {
  const client = new AcpClient({ spawnSpec: silentStub() });
  await client.start();
  await client.initialize();
  const session = await client.newSession(process.cwd());
  const prompt = client.prompt(session.sessionId, [{ type: "text", text: "hang" }]);
  prompt.catch(() => {});
  const real = client.child;
  for (const evt of ["exit", "close"]) real.removeAllListeners(evt);
  const reallyExited = new Promise((resolve) => real.once("exit", resolve));
  client.child = { pid: real.pid, exitCode: null, signalCode: null, once: () => {} };
  try {
    assert.equal(client.peer.pending.size, 1, "session/prompt must still be in flight");
    assert.equal(await client.stop({ timeoutMs: 50 }), false, "an exit that never arrives is not observed");
    let timeoutId;
    try {
      const err = await Promise.race([
        prompt.then(
          () => { throw new Error("session/prompt resolved after a missed exit"); },
          (e) => e
        ),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("session/prompt still pending after stop()")), 200);
        }),
      ]);
      assert.equal(err.reason, "agent-exit");
      assert.match(err.message, /did not exit after stop/);
      assert.equal(client.peer.pending.size, 0, "the missed exit must not leave the RPC pending");
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    try { client.peer?.rejectAllPending(new Error("test cleanup")); } catch {}
    await reallyExited;
  }
});

test("cancel sends session/cancel as a notification without id", async () => {
  const written = [];
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  await client.start();
  const origWrite = client.peer.output.write.bind(client.peer.output);
  client.peer.output.write = (chunk) => {
    written.push(chunk.toString());
    return origWrite(chunk);
  };
  await client.cancel("sess-1");
  const msg = JSON.parse(written.at(-1).trim());
  assert.equal(msg.method, "session/cancel");
  assert.deepEqual(msg.params, { sessionId: "sess-1" });
  assert.equal(msg.id, undefined);
  client.stop();
});

test("stderr is captured but is not reported as agent activity", async () => {
  // The supervisor's clock feeds two strings the caller reads — the heartbeat's "last agent frame
  // N ago" and the stall error's "Last ACP frame N ago" — and drives the opt-in idle guard. A
  // launcher writing diagnostics on stderr is not the turn progressing, and while it counted, a
  // noisy launcher could hold that guard open for as long as it kept talking.
  const script = 'setInterval(() => process.stderr.write("still booting\\n"), 20);';
  const client = new AcpClient({ spawnSpec: { command: process.execPath, args: ["-e", script] } });
  let activity = 0;
  client.on("activity", () => { activity++; });
  await client.start();
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(activity, 0, "stderr chatter must not read as agent activity");
    assert.match(client.stderrBuffer, /still booting/, "and it must still be captured for the exit error");
  } finally {
    // The stub never exits on its own, so a failed assertion above would otherwise leave it
    // running and the runner waiting on its pipes.
    await client.stop();
  }
});

test("the exit error carries the whole of stderr, not a tail of it", async () => {
  // The reason a run failed can sit anywhere in the agent's stderr — a rejected model, an
  // expired login, a quota and when it resets. A byte cut here drops the half that names it.
  // The 64KB ring buffer is what bounds this; nothing below it needs a second cut. Read off
  // the rejection the client raises, not off a message the test builds.
  const marker = "REASON-AT-THE-FRONT";
  const noisy = marker + "M".repeat(4000);
  const script = `process.stderr.write(${JSON.stringify(noisy)}); setTimeout(() => process.exit(3), 150);`;
  const client = new AcpClient({ spawnSpec: { command: process.execPath, args: ["-e", script] } });
  await client.start();

  // Never answered, so the exit handler is what settles it.
  const err = await client.peer.request("initialize", {}).then(() => null, (e) => e);

  assert.equal(err?.reason, "agent-exit");
  assert.ok(err.message.includes(marker), "the front of stderr must survive into the exit error");
  assert.ok(err.message.length > 2000, `the whole of stderr must be carried, got ${err.message.length} chars`);
});

// agy reads its process directory as workspace too: started from the MCP server's directory it
// listed it and ran git status/diff there. The agent process has to start in the workspace.
test("start() runs the agent in the cwd it was given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-cwd-"));
  const client = new AcpClient({
    cwd: dir,
    spawnSpec: { command: process.execPath, args: ["-e", "process.stderr.write(process.cwd())"], options: { shell: false } },
  });
  const exited = new Promise((resolve) => client.once("exit", resolve));
  await client.start();
  await exited;
  assert.equal(realpathSync(client.stderrBuffer), realpathSync(dir));
  await client.stop();
});
