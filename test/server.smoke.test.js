import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const GRANDCHILD_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-with-grandchild.js", import.meta.url));
const STREAMING_AGENT = fileURLToPath(new URL("./fixtures/streaming-stub.js", import.meta.url));

// The bin is a stdio server, so an unrecognised flag starts the transport and waits on stdin.
// The version has to come back without a host attached, and it has to be the version of this
// code rather than whatever a manifest pinned.
test("the binary answers --version and exits without starting the transport", async () => {
  // -v too: it is what a hand check reaches for, and falling through to the transport there
  // reads exactly like the wedged install the flag exists to rule out.
  for (const flag of ["--version", "-v"]) {
    const { stdout } = await run(process.execPath, [ENTRY, flag], { timeout: 10000 });
    assert.equal(stdout.trim(), PKG.version, `${flag} must print the version`);
  }
});

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// The real server with a doctor call held in its version probe: the launcher writes its pid and
// never answers --version, nor ACP when started as the agent.
async function serverInDoctorProbe(t, doctorArgs = {}) {
  const pidFile = join(tmpdir(), `agy-shutdown-probe-${process.pid}-${Date.now()}`);
  const stub = fileURLToPath(new URL("./fixtures/version-hang-pid-stub.js", import.meta.url));
  const server = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${stub}" acp`, AGY_TEST_PIDFILE: pidFile },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  let pid;
  t.after(() => {
    if (pid && isAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    server.kill();
    rmSync(pidFile, { force: true });
  });
  const send = (msg) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "doctor", arguments: doctorArgs } });
  const deadline = Date.now() + 10000;
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(isAlive(pid), "the probe is running when the host shuts down");
  return { server, exited, pid, pidFile };
}

// stdin EOF is a stdio host's shutdown. On win32 a child that is not detached dies with the server.
test("a host shutdown during doctor's version probe stops the probe", { skip: process.platform === "win32" && "win32 kills it with the server" }, async (t) => {
  const { server, exited, pid } = await serverInDoctorProbe(t);
  server.stdin.end();
  await exited;
  assert.equal(isAlive(pid), false, "the probe must be gone when the server exits");
});

// deep starts the agent once the signal ends the probe; the stub, started as the agent, writes its
// pid over the probe's within the 1 s wait.
test("a signal during doctor's deep probe leaves no agent running after the server exits", { skip: process.platform === "win32" && "POSIX signals" }, async (t) => {
  const { server, exited, pid, pidFile } = await serverInDoctorProbe(t, { deep: true });
  server.kill("SIGTERM");
  await exited;
  await new Promise((r) => setTimeout(r, 1000));
  const last = Number(readFileSync(pidFile, "utf8").trim());
  t.after(() => { if (isAlive(last)) try { process.kill(last, "SIGKILL"); } catch {} });
  assert.equal(isAlive(pid), false, "the probe must not outlive the server");
  assert.equal(isAlive(last), false, `doctor's agent (pid ${last}) outlived the server`);
});

// The bin over stdio in raw 2026-07-28 JSON-RPC, as Claude Code speaks it: the SDK client fails a
// call answered with a task.
function rawServer(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  // A test can still be writing when the server has already shut down: EPIPE, not a failure.
  child.stdin.on("error", () => {});
  const replies = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id != null && replies.has(m.id)) { replies.get(m.id)(m); replies.delete(m.id); }
  });
  const send = (method, params = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} in 15 s`)), 15000);
      replies.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } },
      "io.modelcontextprotocol/clientInfo": { name: "raw-host", version: "1" },
    } } }) + "\n");
    return reply;
  };
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, send, exited };
}

test("the binary answers a delegate call listing the tasks extension with a task that completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-task-"));
  const { child, send, exited } = rawServer({ ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${STREAMING_AGENT}"` });
  try {
    const discover = await send("server/discover");
    assert.deepEqual(discover.result.capabilities.extensions?.["io.modelcontextprotocol/tasks"], {});
    const call = await send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    let task;
    const deadline = Date.now() + 15000;
    do {
      await new Promise((r) => setTimeout(r, 100));
      task = (await send("tasks/get", { taskId: call.result.taskId })).result;
    } while (task.status === "working" && Date.now() < deadline);
    assert.equal(task.status, "completed");
    assert.equal(JSON.parse(task.result.content[0].text).sessionId, "sess-stream");
  } finally {
    child.stdin.end();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host that closes mid-task leaves no agent process behind", { skip: process.platform === "win32" && "win32 kills it with the server" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-task-close-"));
  const pidFile = join(dir, "pids");
  const { child, send, exited } = rawServer({
    ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${GRANDCHILD_AGENT}"`, AGENT_BASE: "./escalation-stub.js", PID_FILE: pidFile,
  });
  let pids = [];
  try {
    await send("server/discover");
    const call = await send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    assert.deepEqual(pids.filter(isAlive), pids, "the agent should be running when the host leaves");
    child.stdin.end();
    await exited;
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(pids.filter(isAlive), [], "the agent and its descendants must be gone");
  } finally {
    child.kill();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});

// A host that dies breaks the server's stdout first; the transport then pauses stdin, so no 'end'.
test("a host whose stdout pipe breaks mid-task leaves no agent process behind", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-task-epipe-"));
  const pidFile = join(dir, "pids");
  const { child, send, exited } = rawServer({
    ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${GRANDCHILD_AGENT}"`, AGENT_BASE: "./escalation-stub.js", PID_FILE: pidFile,
  });
  let pids = [];
  try {
    await send("server/discover");
    const call = await send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    pids = readFileSync(pidFile, "utf8").trim().split(/s+/).map(Number);
    child.stdout.destroy();
    for (let i = 0; i < 5; i++) {
      send("tasks/get", { taskId: call.result.taskId }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 20000))]);
    assert.notEqual(code, "still running", "the server outlived its host");
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(pids.filter(isAlive), [], "the agent and its descendants must be gone");
  } finally {
    child.kill();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    // A still-running agent holds the folder as its cwd on Windows until the kill lands.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
});
