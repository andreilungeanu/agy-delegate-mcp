import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AcpClient, stampSettlement } from "../src/acp-client.js";
import { createChildRegistry, isChildAlive } from "../src/proc.js";
import { runDelegate as realRunDelegate } from "../src/delegate.js";
import { runDelegateTool, buildServer, delegateInputSchema, installSignalCleanup, steerSession } from "../src/server.js";
import { TASKS_EXTENSION, createTaskStore } from "../src/tasks.js";

// Every tool returns its payload as one compact JSON text block and no structuredContent, so
// every assertion on their fields goes through here.
const payload = (res) => JSON.parse(res.content[0].text);

// Real AcpClient over a stub subprocess, so force-kill exercises the actual treeKill path.
function stubClientFactory(stubFile, registry) {
  return () => new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL(`./fixtures/${stubFile}`, import.meta.url))],
      options: { shell: false },
    },
    registry,
  });
}

// Through serveStdio, the production entry, in each MCP era it serves: a 2025-era host opens with
// initialize; a 2026-07-28 one sends its identity and capabilities with every request.
const ERAS = [["2025", undefined], ["2026-07-28", { mode: { pin: "2026-07-28" } }]];
async function connectEra(versionNegotiation, serverOpts) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ ...serverOpts, era }), { transport: serverTransport });
  const client = new Client(
    { name: "era-host", version: "3" },
    { capabilities: { elicitation: { form: {} } }, ...(versionNegotiation ? { versionNegotiation } : {}) }
  );
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await served.close(); } };
}

for (const [era, versionNegotiation] of ERAS) {
  test(`doctor reports the host's identity and protocol revision on a ${era}-era connection`, async () => {
    const runDoctor = async ({ getClientInfo }) => getClientInfo();
    const { client, close } = await connectEra(versionNegotiation, { runDoctor });
    try {
      const info = payload(await client.callTool({ name: "doctor", arguments: {} }));
      assert.equal(info.version?.name, "era-host");
      assert.deepEqual(info.capabilities?.elicitation, { form: {} });
      if (era === "2025") assert.match(info.protocolVersion, /^2025-/);
      else assert.equal(info.protocolVersion, "2026-07-28");
    } finally {
      await close();
    }
  });

  if (era === "2025") {
    test("on a 2025-era connection initialize names the host, not envelope keys a request carries", async () => {
      const runDoctor = async ({ getClientInfo }) => getClientInfo();
      const { client, close } = await connectEra(versionNegotiation, { runDoctor });
      try {
        const _meta = {
          [CLIENT_INFO_META_KEY]: { name: "envelope-host", version: "9" },
          [CLIENT_CAPABILITIES_META_KEY]: { sampling: {} },
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        };
        const info = payload(await client.callTool({ name: "doctor", arguments: {}, _meta }));
        assert.equal(info.version?.name, "era-host");
        assert.deepEqual(info.capabilities, { elicitation: { form: {} } });
        assert.match(info.protocolVersion, /^2025-/);
      } finally {
        await close();
      }
    });
  }

  test(`delegate sends progress and sees the host's cancellation on a ${era}-era connection`, async () => {
    let aborted;
    const runDelegate = async ({ onProgress, onSessionReady, signal }) => {
      onSessionReady(`sess-${era}`, { cancel: async () => {}, stop: () => true });
      onProgress("tick");
      aborted = new Promise((resolve) => signal.addEventListener("abort", () => resolve(true), { once: true }));
      await aborted;
      return { result: "", sessionId: `sess-${era}` };
    };
    const { client, close } = await connectEra(versionNegotiation, { runDelegate });
    try {
      const host = new AbortController();
      const messages = [];
      let ticked;
      const tick = new Promise((resolve) => { ticked = resolve; });
      const call = client.callTool(
        { name: "delegate", arguments: { workspace: process.cwd(), spec: "x" } },
        { signal: host.signal, onprogress: (p) => { messages.push(p.message); if (p.message === "tick") ticked(); } }
      );
      await tick;
      assert.deepEqual(messages, [`session ready: sess-${era}`, "tick"]);
      host.abort();
      await assert.rejects(call);
      assert.equal(await aborted, true, "the host's cancellation must reach the delegation's signal");
    } finally {
      await close();
    }
  });
}

// Agents started through realOver. Closing a raw connection kills any still running, so a failed
// assertion cannot leave a hung agent holding the test process open.
const agentPids = [];

// A 2026-07-28 host in raw JSON-RPC: the SDK client fails a call answered with a task.
async function connectRaw(serverOpts) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ ...serverOpts, era }), { transport: serverTransport });
  const replies = new Map();
  const progress = [];
  let nextId = 0;
  clientTransport.onmessage = (m) => {
    if (m.id != null && replies.has(m.id)) { replies.get(m.id)(m); replies.delete(m.id); }
    else if (m.method === "notifications/progress") progress.push(m.params);
  };
  await clientTransport.start();
  const send = (method, params = {}, { tasks = true } = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve) => replies.set(id, resolve));
    clientTransport.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
      ...params._meta,
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: tasks ? { [TASKS_EXTENSION]: {} } : {} },
      [CLIENT_INFO_META_KEY]: { name: "raw-host", version: "1" },
    } } });
    return { id, reply };
  };
  await send("server/discover").reply;
  return {
    send,
    progress,
    call: (args = {}, { progressToken, tasks } = {}) => send("tools/call", {
      name: "delegate",
      arguments: { workspace: process.cwd(), spec: "x", ...args },
      ...(progressToken != null ? { _meta: { progressToken } } : {}),
    }, { tasks }),
    cancelRequest: (requestId) => clientTransport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "test" } }),
    close: async () => {
      await clientTransport.close();
      await served.close();
      for (const pid of agentPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    },
  };
}

async function waitForTask(raw, taskId, done = (t) => t.status !== "working", timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { result, error } = await raw.send("tasks/get", { taskId }).reply;
    if (error) throw new Error(`tasks/get ${taskId}: ${JSON.stringify(error)}`);
    if (done(result)) return result;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${result.status}: ${result.statusMessage}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
async function waitUntil(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return check();
}

// The real runDelegate over a fixture process, recording each agent's pid.
function realOver(stubFile, extra = {}, pids = [], registry = undefined) {
  return (opts) => realRunDelegate({
    ...opts,
    handshakeMs: 10000,
    backgroundWaitMs: 300, backgroundSettleMs: 20, backgroundContinueMs: 300,
    ...extra,
    clientFactory: (o) => {
      const client = stubClientFactory(stubFile, registry)(o);
      const start = client.start.bind(client);
      client.start = async () => { const r = await start(); pids.push(client.child.pid); agentPids.push(client.child.pid); return r; };
      return client;
    },
  });
}

test("a 2026-07-28 connection advertises the tasks extension and a 2025-era one does not", async () => {
  const raw = await connectRaw({});
  try {
    const { result } = await raw.send("server/discover").reply;
    assert.deepEqual(result.capabilities.extensions?.[TASKS_EXTENSION], {});
  } finally {
    await raw.close();
  }
  const { client, close } = await connectEra(undefined, {});
  try {
    assert.equal(client.getServerCapabilities()?.extensions, undefined);
  } finally {
    await close();
  }
});

test("delegate answers a request listing the tasks extension with a task whose result matches a blocking call", async () => {
  const raw = await connectRaw({ runDelegate: realOver("fake-acp.js"), tasks: createTaskStore() });
  try {
    const answers = await Promise.all([raw.call().reply, raw.call().reply]);
    for (const { result } of answers) {
      assert.equal(result.resultType, "task");
      assert.match(result.taskId, /^[\x21-\x7e]{1,128}$/);
      assert.equal(result.status, "working");
      assert.equal(result.statusMessage, "session ready: sess-1");
      assert.equal(result.ttlMs, null);
      assert.equal(result.pollIntervalMs, 3000);
    }
    assert.notEqual(answers[0].result.taskId, answers[1].result.taskId);
    const blocking = await raw.call({}, { tasks: false }).reply;
    assert.equal(blocking.result.resultType, "complete");
    for (const { result } of answers) {
      const done = await waitForTask(raw, result.taskId);
      assert.equal(done.status, "completed");
      assert.deepEqual(done.result.content, blocking.result.content);
      assert.equal(typeof done.ttlMs, "number");
    }
  } finally {
    await raw.close();
  }
});

test("a task's progress goes to the request until the task is answered, then to its statusMessage", async () => {
  const raw = await connectRaw({ runDelegate: realOver("streaming-stub.js", { heartbeatMs: 100 }), tasks: createTaskStore() });
  try {
    const { result } = await raw.call({}, { progressToken: "tok" }).reply;
    assert.equal(result.resultType, "task");
    const beat = await waitForTask(raw, result.taskId, (t) => /^still working — /.test(t.statusMessage ?? ""));
    assert.equal(beat.status, "working");
    await waitForTask(raw, result.taskId);
    assert.deepEqual(raw.progress.filter((p) => p.progressToken === "tok").map((p) => p.message), ["session ready: sess-stream"]);
  } finally {
    await raw.close();
  }
});

test("cancelling a task request before its prompt is sent stops the agent and answers nothing", async () => {
  const pids = [];
  const raw = await connectRaw({ runDelegate: realOver("session-then-hang-stub.js", { handshakeMs: 30000 }, pids), tasks: createTaskStore() });
  try {
    const call = raw.call({}, { progressToken: "setup" });
    // The stub answers session/new, then nothing: the delegation is past spawn but short of its prompt.
    assert.ok(await waitUntil(() => raw.progress.some((p) => p.message === "session ready: sess-half-open")), "the session should open");
    raw.cancelRequest(call.id);
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    const answered = await Promise.race([call.reply.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
    assert.equal(answered, false);
  } finally {
    await raw.close();
  }
});

test("an argument the agent rejects before the prompt comes back at once, not as a task", async () => {
  const raw = await connectRaw({ runDelegate: realOver("fake-acp.js"), tasks: createTaskStore() });
  try {
    const { result } = await raw.call({ model: "no-such-model" }).reply;
    assert.equal(result.resultType, "complete");
    assert.equal(result.isError, true);
  } finally {
    await raw.close();
  }
});

// The run's own error, "delegate failed [aborted]: …", replaced the hint once the run settled: a
// reason no blocking call ever returns, which the failure table does not list.
test("tasks/cancel stops the agent and leaves the task cancelled with a resume hint", async () => {
  const pids = [];
  const tasks = createTaskStore();
  const finish = tasks.finish;
  const settled = new Promise((resolve) => { tasks.finish = (...args) => { finish(...args); resolve(undefined); }; });
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids), tasks });
  try {
    const { result } = await raw.call().reply;
    assert.equal(result.resultType, "task");
    assert.equal((await raw.send("tasks/update", { taskId: result.taskId, inputResponses: { q: { action: "accept" } } }).reply).error, undefined);
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const { error } = await raw.send(method, { taskId: result.taskId }, { tasks: false }).reply;
      assert.equal(error?.code, -32021, `${method} from a request without the extension`);
    }
    const ack = await raw.send("tasks/cancel", { taskId: result.taskId }).reply;
    assert.equal(ack.error, undefined);
    const cancelled = (await raw.send("tasks/get", { taskId: result.taskId }).reply).result;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.statusMessage, "cancelled; resume with resumeSessionId sess-escalate");
    assert.equal(typeof cancelled.ttlMs, "number");
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    await settled;
    const ended = (await raw.send("tasks/get", { taskId: result.taskId }).reply).result;
    assert.equal(ended.status, "cancelled");
    assert.equal(ended.statusMessage, "cancelled; resume with resumeSessionId sess-escalate");
    assert.equal(ended.ttlMs, cancelled.ttlMs);
    await raw.send("tasks/cancel", { taskId: result.taskId }).reply;
    assert.equal((await raw.send("tasks/get", { taskId: result.taskId }).reply).result.status, "cancelled");
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const { error } = await raw.send(method, { taskId: "no-such-task" }).reply;
      assert.equal(error?.code, -32602, method);
    }
  } finally {
    await raw.close();
  }
});

test("tasks/cancel stops only its own task when two run on one session", async () => {
  const pids = [];
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids), tasks: createTaskStore() });
  try {
    const [a, b] = await Promise.all([raw.call().reply, raw.call().reply]);
    await raw.send("tasks/cancel", { taskId: a.result.taskId }).reply;
    assert.ok(await waitUntil(() => pids.filter(isAlive).length === 1), "the cancelled task's agent must stop");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pids.filter(isAlive).length, 1, "the other task's agent must keep running");
    assert.equal((await raw.send("tasks/get", { taskId: b.result.taskId }).reply).result.status, "working");
    await raw.send("tasks/cancel", { taskId: b.result.taskId }).reply;
    assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid))));
  } finally {
    await raw.close();
  }
});

test("the shutdown on stdin EOF stops the agent of a task already answered", async () => {
  const pids = [];
  const registry = createChildRegistry();
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids, registry), tasks: createTaskStore() });
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    const { result } = await raw.call().reply;
    assert.equal(result.resultType, "task");
    installSignalCleanup(registry, { exit: () => {}, setExitCode: () => {}, stdin });
    stdin.emit("end");
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the task's agent outlived the shutdown");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    await raw.close();
  }
});

test("a delegation that fails after its prompt completes its task with the error result", async () => {
  const runDelegate = async ({ onSessionReady, onPromptSent }) => {
    onSessionReady("sess-fail", { cancel: async () => {}, stop: () => true });
    onPromptSent("sess-fail");
    await new Promise((r) => setTimeout(r, 50));
    throw Object.assign(new Error("agent died"), { reason: "agent-exit" });
  };
  const raw = await connectRaw({ runDelegate, tasks: createTaskStore() });
  try {
    const { result } = await raw.call().reply;
    const done = await waitForTask(raw, result.taskId);
    assert.equal(done.status, "completed");
    assert.equal(done.result.isError, true);
    assert.equal(done.result.content[0].text, "delegate failed [agent-exit]: agent died");
  } finally {
    await raw.close();
  }
});

test("tasks/cancel after the turn has ended leaves the task to complete", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let turnEnded;
  const ended = new Promise((r) => { turnEnded = r; });
  const runDelegate = async ({ onSessionReady, onPromptSent, onTurnEnd, signal }) => {
    onSessionReady("sess-ended", { cancel: async () => {}, stop: () => true });
    onPromptSent("sess-ended");
    onTurnEnd();
    turnEnded();
    await gate;
    return { result: "kept", sessionId: "sess-ended", aborted: signal.aborted };
  };
  const raw = await connectRaw({ runDelegate, tasks: createTaskStore() });
  try {
    const { result } = await raw.call().reply;
    await ended;
    await raw.send("tasks/cancel", { taskId: result.taskId }).reply;
    release();
    const done = await waitForTask(raw, result.taskId);
    assert.equal(done.status, "completed");
    assert.deepEqual(payload(done.result), { result: "kept", sessionId: "sess-ended", aborted: false });
  } finally {
    await raw.close();
  }
});

test("a 2025-era request that lists the tasks extension in _meta still gets a plain result", async () => {
  const runDelegate = async ({ onSessionReady, onPromptSent }) => {
    onSessionReady("sess-2025", { cancel: async () => {}, stop: () => true });
    onPromptSent?.("sess-2025");
    return { result: "plain", sessionId: "sess-2025" };
  };
  const { client, close } = await connectEra(undefined, { runDelegate, tasks: createTaskStore() });
  try {
    const res = await client.callTool({
      name: "delegate",
      arguments: { workspace: process.cwd(), spec: "x" },
      _meta: {
        [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION]: {} } },
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      },
    });
    assert.equal(payload(res).result, "plain");
  } finally {
    await close();
  }
});

test("steer and cancel by task id reach only that task's run, and a finished task's id reaches none", async () => {
  const raw = await connectRaw({ runDelegate: realOver("fake-acp.js"), tasks: createTaskStore() });
  const tool = async (name, args) => JSON.parse((await raw.send("tools/call", { name, arguments: args }).reply).result.content[0].text);
  const status = async (taskId) => (await raw.send("tasks/get", { taskId }).reply).result.status;
  try {
    // Two agents, each opening its own sess-1: one session id, two runs.
    const [a, b] = (await Promise.all([raw.call({ spec: "STEERABLE task" }).reply, raw.call({ spec: "STEERABLE task" }).reply])).map((r) => r.result);
    assert.deepEqual(await tool("steer", { sessionId: a.taskId, message: "go left" }), { status: "steered", sessionId: "sess-1" });
    const doneA = await waitForTask(raw, a.taskId);
    assert.equal(JSON.parse(doneA.result.content[0].text).result, "STEERED: go left");
    assert.equal(await status(b.taskId), "working");
    assert.deepEqual(await tool("steer", { sessionId: a.taskId, message: "go right" }), { status: "not-running", sessionId: "sess-1" });
    assert.deepEqual(await tool("cancel", { sessionId: a.taskId, force: true }), { status: "not-running", sessionId: "sess-1" });
    assert.equal(await status(b.taskId), "working");
    assert.deepEqual(await tool("cancel", { sessionId: b.taskId }), { status: "cancelled", sessionId: "sess-1" });
    const doneB = await waitForTask(raw, b.taskId);
    assert.equal(JSON.parse(doneB.result.content[0].text).cancelRequested, true);
  } finally {
    await raw.close();
  }
});

test("a task's id resumes the session its run opened, after tasks/cancel stopped it", async () => {
  const pids = [];
  const stopped = realOver("escalation-stub.js", {}, pids);
  const resumes = [];
  const resumed = async (opts) => { resumes.push(opts.resumeSessionId); return { result: "ok", sessionId: opts.resumeSessionId, resumed: true }; };
  const raw = await connectRaw({ runDelegate: (opts) => (opts.resumeSessionId ? resumed : stopped)(opts), tasks: createTaskStore() });
  try {
    const { result: task } = await raw.call().reply;
    await raw.send("tasks/cancel", { taskId: task.taskId }).reply;
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    await raw.call({ resumeSessionId: task.taskId }, { tasks: false }).reply;
    assert.deepEqual(resumes, ["sess-escalate"]);
  } finally {
    await raw.close();
  }
});

test("a task's id still resumes its session once the task itself is dropped", async () => {
  let t = Date.now();
  const pids = [];
  const stopped = realOver("escalation-stub.js", {}, pids);
  const resumes = [];
  const resumed = async (opts) => { resumes.push(opts.resumeSessionId); return { result: "ok", sessionId: opts.resumeSessionId, resumed: true }; };
  const tasks = createTaskStore({ now: () => t });
  const raw = await connectRaw({ runDelegate: (opts) => (opts.resumeSessionId ? resumed : stopped)(opts), tasks });
  try {
    const { result: task } = await raw.call().reply;
    await raw.send("tasks/cancel", { taskId: task.taskId }).reply;
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    t += 60 * 60 * 1000 + 1;
    assert.equal(tasks.get(task.taskId), undefined, "the task should have been dropped");
    await raw.call({ resumeSessionId: task.taskId }, { tasks: false }).reply;
    assert.deepEqual(resumes, ["sess-escalate"]);
  } finally {
    await raw.close();
  }
});

test("a finished delegation does not evict a concurrent one holding the same session id", async () => {
  // A resume can race the turn it resumes, so two live delegations can share a session id.
  // The one that finishes first must not deregister the other — cancel then reported a
  // running session as already ended.
  const inFlight = new Map();
  const seenSessions = new Set();
  const mkDelegate = (delayMs) => async ({ onSessionReady }) => {
    onSessionReady("sess-shared", { cancel: async () => {}, stop: () => {} });
    await new Promise((r) => setTimeout(r, delayMs));
    return { result: "ok", sessionId: "sess-shared" };
  };
  const args = { spec: "task", mode: "agent" };
  const slow = runDelegateTool({ args, ctx: {}, runDelegate: mkDelegate(300), inFlight, seenSessions });
  const quick = runDelegateTool({ args, ctx: {}, runDelegate: mkDelegate(25), inFlight, seenSessions });

  await quick;
  assert.equal(inFlight.has("sess-shared"), true, "the still-running delegation must stay registered");
  await slow;
  assert.equal(inFlight.has("sess-shared"), false, "the last one out clears the entry");
});

test("runDelegateTool cleans up inFlight and returns isError when runDelegate throws", async () => {
  const inFlight = new Map();
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-x", { cancel: async () => {} });
    throw new Error("boom");
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "gemini-4-neon" },
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /delegate failed: boom/);
  assert.equal(inFlight.has("sess-x"), false);
});

test("runDelegateTool tags a failure with its reason so callers need not parse prose", async () => {
  const runDelegate = async () => {
    const err = new Error("Session hard-cap exceeded after 400ms");
    err.reason = "hard-cap";
    throw err;
  };
  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "gemini-4-neon" },
    runDelegate,
    inFlight: new Map(),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^delegate failed \[hard-cap\]: Session hard-cap exceeded/);
});

test('delegate tool rejects empty model before runDelegate is called', async () => {
  let called = false;
  const runDelegate = async () => {
    called = true;
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-empty-model", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent", model: "" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /model must be a non-empty string/);
    assert.equal(called, false);
  } finally {
    await client.close();
  }
});

test('delegate tool trims whitespace from model before runDelegate', async () => {
  const captured = [];
  const runDelegate = async (args) => {
    captured.push(args);
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-trim-model", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent", model: "  gemini-4-neon  " } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, "gemini-4-neon");
  } finally {
    await client.close();
  }
});

// No default: an omitted model runs agy's own default, which the result names as effectiveModel.
test('delegate tool leaves model unset when omitted', async () => {
  const captured = [];
  const runDelegate = async (args) => {
    captured.push(args);
    return { result: "ok", sessionId: "sess-default-model" };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent" } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, undefined);
    assert.equal("fast" in captured[0], false);
  } finally {
    await client.close();
  }
});

test("server advertises instructions, output schemas, and conservative tool annotations", async () => {
  const server = buildServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // SEP-973 icons on initialize must match the registry listing — HTTPS URLs, not file://.
    const registry = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    const advertised = client.getServerVersion();
    assert.equal(advertised.name, "agy-delegate-mcp");
    assert.equal(advertised.version, registry.version);
    assert.equal(advertised.icons?.length, registry.icons?.length);
    for (const [i, icon] of advertised.icons.entries()) {
      const listed = registry.icons[i];
      assert.equal(icon.src, listed.src);
      assert.equal(icon.mimeType, listed.mimeType);
      assert.deepEqual(icon.sizes, listed.sizes);
      assert.equal(icon.theme, listed.theme);
    }
    // Assert the invariants a host cannot infer, not the prose carrying them: hosts that
    // never load the skill see only this string.
    const instructions = client.getInstructions();
    assert.match(instructions, /auto-approved, in every mode/);
    assert.match(instructions, /review the git diff after every run/);
    assert.match(instructions, /filesReportedByEditTools/);
    const listed = await client.listTools();
    const tools = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(tools).sort(), ["cancel", "delegate", "doctor", "steer"]);
    // The description is what a host reads immediately before calling, so it must not
    // reassert the workspace confinement the instructions just denied.
    assert.match(tools.delegate.description, /every permission the agent requests, in any mode and anywhere on disk/i);
    assert.match(tools.delegate.description, /clarifying questions arrive in questions.*resumeSessionId/i);
    assert.ok(!/uses MCP elicitation/i.test(tools.delegate.description));
    assert.match(tools.delegate.description, /Leave model and effort unset unless the user explicitly asks/);
    assert.equal(delegateInputSchema.parse({ spec: "x", workspace: "." }).model, undefined);
    assert.equal("fast" in tools.delegate.inputSchema.properties, false);
    assert.equal("context" in tools.delegate.inputSchema.properties, false);
    assert.equal(delegateInputSchema.parse({ spec: "x", workspace: ".", effort: "  xhigh  " }).effort, "xhigh");
    // Required, not defaulted: the server's own cwd under npx or a plugin launch is a cache
    // directory or the user's home, and a defaulted workspace sent the agent there.
    assert.ok(!delegateInputSchema.safeParse({ spec: "x" }).success);
    assert.ok(!delegateInputSchema.safeParse({ spec: "x", workspace: "   " }).success);
    const effortDescription = tools.delegate.inputSchema.properties.effort.description;
    assert.match(effortDescription, /agy thinking level for the selected model/);
    assert.match(effortDescription, /invalid values fail before the prompt/);
    assert.match(effortDescription, /host's own reasoning setting is unrelated/);
    assert.doesNotMatch(effortDescription, /gpt-5\.x|extra-high/);
    // No outputSchema on any tool: declaring one forces structuredContent alongside the text
    // block, which puts the payload in the caller's context twice.
    assert.equal(tools.delegate.outputSchema, undefined);
    assert.equal(tools.doctor.outputSchema, undefined);
    assert.equal(tools.cancel.outputSchema, undefined);
    assert.equal(tools.steer.outputSchema, undefined);
    for (const status of ["steered", "not-ready", "not-running", "not-found"]) {
      assert.ok(tools.steer.description.includes(status), `steer description names ${status}`);
    }
    assert.equal(tools.steer.annotations.destructiveHint, true);
    assert.equal(tools.steer.annotations.idempotentHint, false);
    assert.equal(tools.steer.annotations.openWorldHint, true, "a steer can send the agent anywhere delegate can");
    // With the schema gone, the description is the only published source of cancel's statuses.
    for (const status of ["cancelled", "killed", "not-running", "not-found"]) {
      assert.ok(tools.cancel.description.includes(status), `cancel description names ${status}`);
    }
    assert.equal(tools.delegate.annotations.readOnlyHint, false);
    assert.equal(tools.delegate.annotations.destructiveHint, true);
    assert.equal(tools.delegate.annotations.idempotentHint, false);
    assert.equal(tools.delegate.annotations.openWorldHint, true);
    assert.equal(tools.doctor.annotations.readOnlyHint, true);
    assert.equal(tools.cancel.annotations.idempotentHint, true);
  } finally {
    await client.close();
  }
});

test("runDelegateTool sends progress notifications when progressToken is set", async () => {
  const inFlight = new Map();
  const notifications = [];
  const ctx = { mcpReq: {
    _meta: { progressToken: "tok-1" },
    notify: (n) => { notifications.push(n); },
  } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-p", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-p", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "gemini-4-neon" },
    ctx,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  // The first notification surfaces the session id (for a mid-run cancel), then "tick".
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].method, "notifications/progress");
  assert.equal(notifications[0].params.progressToken, "tok-1");
  assert.equal(notifications[0].params.progress, 1);
  assert.match(notifications[0].params.message, /^session ready: sess-p$/);
  assert.equal(notifications[1].params.progress, 2);
  assert.equal(notifications[1].params.message, "tick");
});

test("runDelegateTool skips progress notifications when progressToken is absent", async () => {
  const inFlight = new Map();
  let notifyCalls = 0;
  const ctx = { mcpReq: { notify: () => { notifyCalls++; } } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-q", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-q", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "gemini-4-neon" },
    ctx,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(notifyCalls, 0);
  assert.equal(payload(result).result, "ok");
});

test("runDelegateTool survives notify failures", async () => {
  const inFlight = new Map();
  const ctx = { mcpReq: {
    _meta: { progressToken: "tok-1" },
    notify: () => { throw new Error("notify failed"); },
  } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-r", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-r", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "gemini-4-neon" },
    ctx,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(payload(result).result, "ok");
});

// The sync-throwing stub above never exercised the path that fails: the SDK declares
// notify async, and a rejection settles outside the try. The assertion is the absence
// of an unhandledRejection, not the return value.
test("runDelegateTool survives async notify rejections", async () => {
  const inFlight = new Map();
  const ctx = { mcpReq: {
    _meta: { progressToken: "tok-1" },
    notify: async () => { throw new Error("Not connected"); },
  } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-s", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-s", filesReportedByEditTools: [] };
  };

  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await runDelegateTool({
      args: { spec: "test", mode: "agent", model: "gemini-4-neon" },
      ctx,
      runDelegate,
      inFlight,
    });
    // A rejection queued by the notification settles on a later microtask than the tool result.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.isError, undefined);
    assert.equal(payload(result).result, "ok");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});

test("cancel tool with force kills the agent when delegation does not settle", async () => {
  let cancelledWith;
  let stopCalled = false;
  let releaseStop;
  const gate = new Promise((r) => { releaseStop = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-force-kill", {
      cancel: async (sid) => { cancelledWith = sid; },
      stop: () => { stopCalled = true; releaseStop(); return true; },
    });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-force-kill", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const cancelRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-force-kill", force: true } });
    assert.equal(payload(cancelRes).status, "killed");
    assert.deepEqual(payload(cancelRes), { status: "killed", sessionId: "sess-force-kill" });
    assert.equal(cancelledWith, "sess-force-kill");
    assert.equal(stopCalled, true);
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(payload(delegateRes).cancelRequested, true);
  } finally {
    await client.close();
  }
});

test("a plain cancel keeps the session cancellable, so force still escalates", async () => {
  let stopCalled = false;
  let releaseStop;
  const gate = new Promise((r) => { releaseStop = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    // An agent that ignores session/cancel: the turn keeps running after the plain cancel.
    onSessionReady("sess-escalate", {
      cancel: async () => {},
      stop: () => { stopCalled = true; releaseStop(); return true; },
    });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-escalate", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const first = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate" } });
    assert.equal(payload(first).status, "cancelled");
    // Second, plain: the turn is still in flight, so this must not report not-found.
    const second = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate" } });
    assert.equal(payload(second).status, "cancelled");
    const escalated = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate", force: true } });
    assert.equal(payload(escalated).status, "killed");
    assert.equal(stopCalled, true);
    const delegateRes = await delegateP;
    assert.equal(payload(delegateRes).cancelRequested, true);
  } finally {
    await client.close();
  }
});

// stop() resolves false when the kill was dispatched and no exit followed. Reporting that as
// killed would tell the caller the agent is gone while it is still running and still holding
// the workspace.
test("force cancel reports cancelled and keeps the handle when no exit follows the kill", async () => {
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  let releaseTurn;
  const gate = new Promise((r) => { releaseTurn = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-stubborn", { cancel: async () => {}, stop: async () => false });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-stubborn", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const first = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-stubborn", force: true } });
    assert.equal(payload(first).status, "cancelled");
    // Still registered, so the caller can force again instead of being told the id is unknown.
    const second = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-stubborn", force: true } });
    assert.equal(payload(second).status, "cancelled");
    releaseTurn();
    await delegateP;
  } finally {
    await client.close();
  }
});

test("force cancel does not untrack a resume that registers during stop()", async () => {
  let calls = 0;
  let firstReady, secondReady, firstRelease, secondRelease, enteredStop;
  const ready1 = new Promise((r) => { firstReady = r; });
  const ready2 = new Promise((r) => { secondReady = r; });
  const gate1 = new Promise((r) => { firstRelease = r; });
  const gate2 = new Promise((r) => { secondRelease = r; });
  const inStop = new Promise((r) => { enteredStop = r; });
  let resumeStopCalled = false;
  const runDelegate = async ({ onSessionReady }) => {
    calls++;
    if (calls === 1) {
      onSessionReady("sess-race", {
        cancel: async () => {},
        stop: async () => {
          enteredStop();
          await new Promise((r) => setTimeout(r, 80));
          return true;
        },
      });
      firstReady();
      await gate1;
      return { result: "one", sessionId: "sess-race" };
    }
    onSessionReady("sess-race", {
      cancel: async () => {},
      stop: async () => { resumeStopCalled = true; return true; },
    });
    secondReady();
    await gate2;
    return { result: "two", sessionId: "sess-race" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 20 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const firstP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "first turn" } });
    await ready1;
    const cancelP = client.callTool({ name: "cancel", arguments: { sessionId: "sess-race", force: true } });
    await inStop;
    const secondP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "resume turn" } });
    await ready2;
    const killed = await cancelP;
    assert.equal(payload(killed).status, "killed");
    const still = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-race" } });
    assert.equal(payload(still).status, "cancelled", "the resume must still be in flight");
    assert.equal(resumeStopCalled, false);
    firstRelease();
    secondRelease();
    await firstP;
    await secondP;
  } finally {
    await client.close();
  }
});

test("cancel force kills a real stub agent whose prompt never finishes", async () => {
  // The live MCP host serializes tool calls, so force-kill can only be exercised here: a real
  // AcpClient drives infinite-stream-stub.js (handshakes, then streams forever), and the
  // non-serializing InMemoryTransport lets cancel run while delegate is in flight.
  // A cancel before the prompt ends the delegation as cancelled, so the force cancel waits until
  // the prompt is on the wire rather than probing with a plain cancel.
  let promptSent;
  const prompted = new Promise((r) => { promptSent = r; });
  const runDelegate = (opts) => realRunDelegate({
    ...opts,
    clientFactory: (factoryOpts) => {
      const agent = stubClientFactory("infinite-stream-stub.js")(factoryOpts);
      const prompt = agent.prompt.bind(agent);
      agent.prompt = (...a) => { const reply = prompt(...a); promptSent(); return reply; };
      return agent;
    },
    idleMs: 0,          // no idle timeout — the stub streams steadily
    hardCapMs: 60000,   // far beyond the test, so the kill is what ends the turn
    handshakeMs: 10000,
  });
  const server = buildServer({ runDelegate, forceGraceMs: 100 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "stream forever" } });
    await prompted;

    const killedAt = Date.now();
    const killRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-infinite", force: true } });
    assert.equal(payload(killRes).status, "killed");

    const delegateRes = await delegateP;
    assert.equal(delegateRes.isError, true);
    assert.match(delegateRes.content[0].text, /agent-exit/);
    assert.ok(Date.now() - killedAt < 10000, "the kill, not the 60s hard cap, ended the turn");
  } finally {
    await client.close();
  }
});

test("doctor tool passes deep and client info through to runDoctor", async () => {
  let captured;
  const runDoctor = async (opts) => {
    captured = opts;
    return {
      plugin: { version: "test" },
      client: {
        name: "doctor-test-client",
        version: "9.9",
        capabilities: {},
      },
      agent: { found: true, command: "agy acp --dangerously-skip-permissions", version: "1.5.13" },
      runtime: { node: "22.0.0", platform: "test", arch: "test", cwd: "/test", transport: "stdio" },
      env: {},
    };
  };
  const server = buildServer({ runDoctor });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "doctor-test-client", version: "9.9" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "doctor", arguments: { deep: true } });
    assert.equal(captured.deep, true);
    const info = captured.getClientInfo();
    assert.equal(info.version.name, "doctor-test-client");
    assert.equal(info.version.version, "9.9");
    assert.ok(info.capabilities, "expected client capabilities to be exposed");
    assert.equal(payload(res).runtime.transport, "stdio");
  } finally {
    await client.close();
  }
});

test("delegate tool returns a plan-mode artifact as plan end-to-end", async () => {
  const { runDelegate } = await import("../src/delegate.js");
  const { EventEmitter } = await import("node:events");
  const clientFactory = () => {
    const acp = new EventEmitter();
    acp.start = async () => {};
    acp.initialize = async () => {};
    acp.newSession = async () => ({ sessionId: "sess-plan" });
    acp.setConfigOption = async () => {};
    acp.setMode = async () => {};
    acp.prompt = async () => {
      const rawInput = { ArtifactMetadata: { Summary: "Plan summary" }, Content: "# Plan", Path: "/brain/sess-plan/plan.md" };
      acp.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "w", name: "write_file", kind: "edit", status: "completed", rawInput } });
      acp.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "plan written" } } });
      return { stopReason: "end_turn" };
    };
    acp.sendTaskPrompt = (sid, blocks) => stampSettlement(acp.prompt(sid, blocks));
    acp.endTurn = () => {};
    acp.getTranscript = () => "";
    acp.stop = () => {};
    return acp;
  };
  const server = buildServer({
    runDelegate: (opts) => runDelegate({ ...opts, clientFactory }),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "plan-e2e", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "plan it", mode: "plan" } });
    assert.equal(res.isError ?? false, false);
    const out = payload(res);
    assert.equal(out.result, "plan written");
    assert.deepEqual(out.plan, { path: "/brain/sess-plan/plan.md", overview: "Plan summary", detail: "# Plan" });
  } finally {
    await client.close();
  }
});

test("a shutdown during the handshake still kills the agent it spawned", async () => {
  const inFlight = new Map();
  const registry = createChildRegistry();
  let child;
  const started = new Promise((resolve) => {
    // The stub answers nothing, so the delegation sits in initialize for the whole test.
    setTimeout(function poll() {
      if (child?.pid) resolve();
      else setTimeout(poll, 20);
    }, 20);
  });

  const delegation = runDelegateTool({
    args: { spec: "x", mode: "agent", workspace: process.cwd(), model: "gemini-4-neon" },
    ctx: {},
    runDelegate: (opts) => realRunDelegate({
      ...opts,
      handshakeMs: 30000,
      clientFactory: (o) => {
        const client = stubClientFactory("handshake-hang-stub.js", registry)(o);
        const start = client.start.bind(client);
        client.start = async () => { const r = await start(); child = client.child; return r; };
        return client;
      },
    }),
    inFlight,
  });

  await started;
  const pid = child.pid;
  assert.equal(inFlight.size, 0, "no session id yet, so the map cannot hold it");

  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM"), SIGHUP: process.listeners("SIGHUP") };
  try {
    installSignalCleanup(registry, { exit: () => {}, setExitCode: () => {}, stdin });
    stdin.emit("end");
    const deadline = Date.now() + 8000;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(), false, "the agent spawned during the handshake outlived the shutdown");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    await delegation.catch(() => {});
  }
});

// agy stops a cancelled turn in milliseconds (16 ms live), but force waited out the whole grace
// before looking: a caller paid 5 s for a cancel that had already landed.
test("cancel with force returns as soon as the turn settles, not after the whole grace", async () => {
  let settle;
  const gate = new Promise((r) => { settle = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-force-fast", { cancel: async () => { settle(); }, stop: () => {} });
    sessionReady();
    await gate;
    return { result: "", stopReason: "cancelled", sessionId: "sess-force-fast" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 5000 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await ready;
    const started = Date.now();
    const cancelRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-force-fast", force: true } });
    const elapsed = Date.now() - started;
    assert.equal(payload(cancelRes).status, "cancelled");
    assert.ok(elapsed < 1000, `force cancel took ${elapsed} ms for a turn that settled at once`);
    await delegateP;
  } finally {
    await client.close();
  }
});

test("steer tool forwards the message to a running delegation and reports each status", async () => {
  let accepting = false;
  const received = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-steer", {
      cancel: async () => {},
      steer: (sid, text) => { if (!accepting) return "not-ready"; received.push([sid, text]); return "steered"; },
    });
    sessionReady();
    await gate;
    return { result: "steered result", sessionId: "sess-steer" };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const steer = async (sessionId, message = "go left") =>
    payload(await client.callTool({ name: "steer", arguments: { sessionId, message } })).status;
  try {
    assert.equal(await steer("never-seen"), "not-found");
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    assert.equal(await steer("sess-steer"), "not-ready", "a delegation still setting up takes no steer");
    accepting = true;
    assert.equal(await steer("sess-steer"), "steered");
    assert.deepEqual(received, [["sess-steer", "go left"]]);
    release();
    assert.equal(payload(await delegateP).result, "steered result");
    assert.equal(await steer("sess-steer"), "not-running");
    const blank = await client.callTool({ name: "steer", arguments: { sessionId: "sess-steer", message: "   " } });
    assert.equal(blank.isError, true);
  } finally {
    await client.close();
  }
});

test("shutdown kills an agent that is in its graceful stop instead of waiting out the grace", async () => {
  const registry = createChildRegistry();
  const client = stubClientFactory("close-ignoring-stub.js", registry)();
  await client.start();
  await client.initialize();
  await client.newSession(process.cwd());
  client.stop({ graceMs: 10000 });
  const stdin = new EventEmitter();
  let exitedAt;
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM"), SIGHUP: process.listeners("SIGHUP") };
  try {
    const started = Date.now();
    installSignalCleanup(registry, { exit: () => { exitedAt = Date.now(); }, stdin });
    stdin.emit("end");
    for (let i = 0; i < 200 && exitedAt === undefined; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(exitedAt !== undefined, "shutdown never exited");
    assert.ok(!isChildAlive(client.child), "the agent must be dead when the server exits");
    assert.ok(exitedAt - started < 3000, `shutdown took ${exitedAt - started} ms`);
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    if (isChildAlive(client.child)) await client.stop();
  }
});

test("the doctor tool passes the host's abort signal", async () => {
  let seen;
  const runDoctor = async ({ signal }) => {
    seen = { signal };
    return { plugin: { version: "x" }, client: { name: null, version: null, capabilities: {} }, agent: { found: true, command: "agy", version: null }, runtime: { node: "", platform: "", arch: "", cwd: "", transport: "stdio" }, env: {} };
  };
  const server = buildServer({ runDoctor });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "doctor", arguments: { deep: true } });
    assert.ok(seen.signal instanceof AbortSignal);
  } finally {
    await client.close();
  }
});

// A blank id matched nothing and came back not-found, which reads as a stale session rather than
// a malformed call.
test("cancel and steer reject a blank sessionId, and trim one with stray whitespace", async () => {
  const server = buildServer({ runDelegate: async () => ({}) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    for (const [name, extra] of [["cancel", {}], ["steer", { message: "go" }]]) {
      const blank = await client.callTool({ name, arguments: { sessionId: "  ", ...extra } });
      assert.equal(blank.isError, true, `${name} must reject a blank id`);
      const padded = await client.callTool({ name, arguments: { sessionId: " sess-x ", ...extra } });
      assert.deepEqual(payload(padded), { status: "not-found", sessionId: "sess-x" });
    }
  } finally {
    await client.close();
  }
});

// Two turns on one id: A stops on the cancel, B ignores it. A's close ran on until the poll for
// B gave up, so a turn that had settled spent the whole force grace closing.
test("force cancel cuts the close of a turn that settles at once, while another turn on the id runs on", async () => {
  let ready = 0;
  let bothReady;
  const allReady = new Promise((r) => { bothReady = r; });
  const stoppedAt = {};
  const makeRun = (name, settlesOnCancel) => async ({ onSessionReady, onTurnEnd }) => {
    let settle;
    const settled = new Promise((r) => { settle = r; });
    let killed;
    const dead = new Promise((r) => { killed = r; });
    onSessionReady("sess-shared", {
      cancel: async () => { if (settlesOnCancel) settle(); },
      stop: () => { stoppedAt[name] ??= Date.now(); settle(); killed(); return true; },
    });
    if (++ready === 2) bothReady();
    await settled;
    onTurnEnd();
    await dead;
    return { result: name, sessionId: "sess-shared" };
  };
  let call = 0;
  const runDelegate = (opts) => (call++ === 0 ? makeRun("A", true) : makeRun("B", false))(opts);
  const server = buildServer({ runDelegate, forceGraceMs: 1000 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const a = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "a" } });
    const b = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "b" } });
    await allReady;
    const started = Date.now();
    const res = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-shared", force: true } });
    assert.equal(payload(res).status, "killed");
    assert.ok(stoppedAt.A - started < 400, `A's close was cut ${stoppedAt.A - started} ms after the cancel`);
    await Promise.all([a, b]);
  } finally {
    await client.close();
  }
});

// An untrimmed id missed the session and started a fresh one without its context; a blank one
// spawned agy to fail a resume of "".
test("delegate trims resumeSessionId and treats a blank one as none", async () => {
  const seen = [];
  const runDelegate = async ({ resumeSessionId }) => { seen.push(resumeSessionId); return { result: "ok", sessionId: "s" }; };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", resumeSessionId: " sess-1 " } });
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", resumeSessionId: "   " } });
    assert.deepEqual(seen, ["sess-1", undefined]);
  } finally {
    await client.close();
  }
});

// A second signal exits at once, and on POSIX the first stop was still walking the tree with ps
// then, with nothing signalled yet: the agent outlived the server. The groups are now killed
// synchronously on the way out. A ps that answers late holds the first stop in that walk.
test("a second signal kills the agents before exiting", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-ps-shim-"));
  writeFileSync(join(dir, "ps"), '#!/bin/sh\nout=$(/bin/ps "$@")\nsleep 2\nprintf "%s\n" "$out"\n');
  chmodSync(join(dir, "ps"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  const registry = createChildRegistry();
  const client = new AcpClient({
    spawnSpec: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/silent-stub.js", import.meta.url))], options: { shell: false } },
    registry,
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const before = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]));
  try {
    await client.start();
    const exited = [];
    installSignalCleanup(registry, { exit: (code) => exited.push(code), setExitCode: () => {}, stdin: new EventEmitter() });
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    process.emit("SIGINT");
    assert.deepEqual(exited, [130]);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!isChildAlive(client.child), "the agent must be killed before the server exits");
  } finally {
    process.env.PATH = savedPath;
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The kill for a turn that ignored the cancel waited behind the other turns' closes, so it came
// late, and a turn that finished on its own meanwhile was reported killed.
test("force cancel kills a turn that ignored it without waiting for another turn's slow close", async () => {
  let ready = 0;
  let bothReady;
  const allReady = new Promise((r) => { bothReady = r; });
  const stoppedAt = {};
  const makeRun = (name) => async ({ onSessionReady, onTurnEnd }) => {
    let settle;
    const settled = new Promise((r) => { settle = r; });
    onSessionReady("sess-slow", {
      // A settles on the cancel and then takes 600 ms to close; B ignores the cancel.
      cancel: async () => { if (name === "A") settle(); },
      stop: () => {
        stoppedAt[name] ??= Date.now();
        settle();
        return name === "A" ? new Promise((r) => setTimeout(() => r(true), 600)) : true;
      },
    });
    if (++ready === 2) bothReady();
    await settled;
    onTurnEnd();
    return { result: name, sessionId: "sess-slow" };
  };
  let call = 0;
  const runDelegate = (opts) => makeRun(call++ === 0 ? "A" : "B")(opts);
  const server = buildServer({ runDelegate, forceGraceMs: 100 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const a = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "a" } });
    const b = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "b" } });
    await allReady;
    const started = Date.now();
    await client.callTool({ name: "cancel", arguments: { sessionId: "sess-slow", force: true } });
    assert.ok(stoppedAt.B - started < 400, `B was killed ${stoppedAt.B - started} ms after the cancel`);
    await Promise.all([a, b]);
  } finally {
    await client.close();
  }
});
