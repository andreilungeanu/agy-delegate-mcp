import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { z } from "zod";
import { AcpClient, stampSettlement } from "../src/acp-client.js";
import { isChildAlive } from "../src/proc.js";
import { runDelegate as rawRunDelegate, readUsage, executionSummary, RECENT_COMMANDS, OLDER_FAILED_COMMANDS } from "../src/delegate.js";
import { delegateOutputShape } from "../src/server.js";
import { askingClientFactory } from "./fixtures/asking-client.js";

const require = createRequire(import.meta.url);

// Every result this suite produces is parsed against a strict copy of delegateOutputShape.
// Nothing else checks it: the shape is not declared to hosts, so a field added here but
// forgotten there would drift undocumented and no other test would notice.
const strictOutput = z.object(delegateOutputShape).strict();
// Short background waits by default: a replayed turn that leaves a tool running would otherwise
// wait out the real 10 min. Tests of the wait itself pass their own values.
const runDelegate = async (opts) => {
  const out = await rawRunDelegate({ backgroundWaitMs: 300, backgroundSettleMs: 20, backgroundContinueMs: 300, ...opts });
  strictOutput.parse(out);
  return out;
};

// A stub agent that completes an empty turn. Every factory below starts from this and
// overwrites only the methods its test exercises, so the ACP surface is declared once:
// adding a method to AcpClient means editing one place, not every stub.
function stubClient(sessionId = "sess") {
  const client = new EventEmitter();
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId });
  client.resumeSession = async () => ({ sessionId });
  client.listSessions = async () => ({ sessions: [] });
  client.setModel = async () => {};
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => ({ stopReason: "end_turn" });
  // The stubs script the turn by replacing prompt, so the task prompt is dispatched through it.
  client.sendTaskPrompt = (sid, blocks) => stampSettlement(client.prompt(sid, blocks));
  client.endTurn = () => {};
  client.getTranscript = () => "";
  client.stop = () => {};
  return client;
}

function thinkingFactory() {
  return () => {
    const client = stubClient("sess-think");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET-THOUGHT: planning" } } });
      client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit File", kind: "edit", status: "pending" } });
      client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

function fakeFactory() {
  return new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))],
      options: { shell: false },
    },
  });
}

// The fake agent behind a wire tap: each request the client puts on the wire goes through
// tap(method, params, send), and send() is the real request.
function tappedFactory(tap) {
  const client = fakeFactory();
  const start = client.start.bind(client);
  client.start = async (...args) => {
    await start(...args);
    const request = client.peer.request.bind(client.peer);
    client.peer.request = (method, params) => tap(method, params, () => request(method, params));
  };
  return client;
}

// A real spawn, not a stub emit: the crash this covers depends on where the frame is handled.
// A stub calling client.emit() from inside prompt() has its throw caught by the prompt promise
// and only fails that delegation. Off the wire the same throw runs in the readline callback,
// where nothing is awaiting it — an uncaught exception that takes the MCP server down.
function malformedContentFactory() {
  return new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/malformed-content-acp.js", import.meta.url))],
      options: { shell: false },
    },
  });
}

for (const scenario of ["non-object", "blocks"]) {
  test(`malformed ACP ${scenario} cannot terminate the bridge process`, () => {
    const runner = fileURLToPath(new URL("./fixtures/malformed-frame-runner.js", import.meta.url));
    const child = spawnSync(process.execPath, [runner, scenario], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const out = strictOutput.parse(JSON.parse(child.stdout));
    assert.equal(out.result, "done");
    if (scenario === "blocks") {
      assert.deepEqual(out.filesReportedByEditTools, ["valid.txt"]);
      assert.equal(out.protocolWarnings.length, 1, "malformed blocks share one diagnostic");
      assert.match(out.protocolWarnings[0], /tool content.*dropped/);
    }
  });
}

// hardCapMs keeps the failure fast. Without the guard this test does not fail, it hangs: the
// throw escapes the readline callback, so the end_turn reply on the next line is never read and
// the turn runs to the cap — an hour on the default.
test("a tool_call_update whose content is an object is ignored, not fatal", async () => {
  const out = await runDelegate({ workspace: process.cwd(),
    spec: "task",
    clientFactory: malformedContentFactory,
    hardCapMs: 8000,
  });
  assert.equal(out.result, "done");
  // The frame named a path, but it arrived in a shape ACP does not define. Nothing is reported
  // rather than reaching into it, and the turn still completes.
  assert.equal(out.filesReportedByEditTools, undefined);
});

// A stale non-terminal re-send for an already-completed tool call used to restart collection,
// demoting the collected final message to discardedResult and mislabeling it pre-tool-fallback.
function staleUpdateFactory() {
  const client = stubClient("sess-stale");
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit File", kind: "edit", status: "pending" } });
    client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final" } } });
    client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" } });
    return { stopReason: "end_turn" };
  };
  return client;
}

test("a stale non-terminal update for a finished tool call keeps the final message", async () => {
  const out = await runDelegate({ workspace: process.cwd(), spec: "task", clientFactory: staleUpdateFactory });
  assert.equal(out.result, "final");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

function oversizedFactory() {
  const client = stubClient("sess-big");
  client.prompt = async () => {
    // One byte over the former 10MB cap — the stream is unbounded here, so this must arrive whole.
    const OVER_CAP = 10 * 1024 * 1024 + 1;
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "x".repeat(OVER_CAP) } } });
    return { stopReason: "end_turn" };
  };
  return client;
}

test("runDelegate returns assembled result for a fresh session", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.stopReason, undefined);
  assert.equal(out.sessionId, "sess-1");
  assert.equal(out.result, "done");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.resumed, undefined);
  assert.equal(out.plan, undefined);
  assert.deepEqual(out.filesReportedByEditTools, ["hello.txt"]);
});

// The fake agent failing its first session/new requests, with each request counted off the wire.
function startupRaceFactory(sent, failures) {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))],
      options: { shell: false, env: { ...process.env, FAKE_ACP_NEW_SESSION_FAILURES: failures } },
    },
  });
  const start = client.start.bind(client);
  client.start = async (...args) => {
    await start(...args);
    const request = client.peer.request.bind(client.peer);
    client.peer.request = (method, params) => { sent.push(method); return request(method, params); };
  };
  return client;
}

test("an error agy answers with names the request and its JSON-RPC code", async () => {
  await assert.rejects(
    runDelegate({ spec: "do the thing", workspace: process.cwd(), clientFactory: () => startupRaceFactory([], "1|database is locked") }),
    (err) => {
      assert.equal(err.reason, "agent-error");
      assert.match(err.message, /^database is locked \(session\/new JSON-RPC -32603\)/);
      return true;
    },
  );
});

test("a session/new agy fails at startup is sent once more, and the delegation runs", async () => {
  const sent = [];
  const out = await runDelegate({ spec: "do the thing", workspace: process.cwd(), sessionRetryMs: 10, clientFactory: () => startupRaceFactory(sent, "1") });
  assert.equal(sent.filter((m) => m === "session/new").length, 2, sent.join());
  assert.equal(sent.filter((m) => m === "session/prompt").length, 1, sent.join());
  assert.match(out.sessionId, /^sess-/);
});

test("a second startup failure ends the delegation, naming the method and JSON-RPC code", async () => {
  const sent = [];
  await assert.rejects(
    runDelegate({ spec: "do the thing", workspace: process.cwd(), sessionRetryMs: 10, clientFactory: () => startupRaceFactory(sent, "2") }),
    (err) => {
      assert.equal(err.reason, "agent-error");
      assert.match(err.message, /^Failed to start Antigravity conversation \(session\/new JSON-RPC -32603\)/);
      return true;
    },
  );
  assert.equal(sent.filter((m) => m === "session/new").length, 2, sent.join());
});

test("a session/new failing with another -32603 is not sent again", async () => {
  const sent = [];
  await assert.rejects(runDelegate({ spec: "do the thing", workspace: process.cwd(), sessionRetryMs: 10, clientFactory: () => startupRaceFactory(sent, "1|database is locked") }));
  assert.equal(sent.filter((m) => m === "session/new").length, 1, sent.join());
});

test("a cancel during the session/new retry wait ends the delegation without sending it", async () => {
  const sent = [];
  const ac = new AbortController();
  const started = Date.now();
  await assert.rejects(runDelegate({
    spec: "do the thing", workspace: process.cwd(), sessionRetryMs: 3000, signal: ac.signal,
    clientFactory: () => {
      const client = startupRaceFactory(sent, "1");
      const newSession = client.newSession.bind(client);
      client.newSession = (...args) => newSession(...args).catch((err) => { setTimeout(() => ac.abort(), 500); throw err; });
      return client;
    },
  }));
  assert.ok(Date.now() - started < 2500, `settled ${Date.now() - started} ms in, after the retry wait`);
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.equal(sent.filter((m) => m === "session/new").length, 1, sent.join());
});

// A cancel with no call in flight for it to reject: the wire's own refusal is all that keeps the
// task prompt off it.
test("a cancel landing after setup's last reply sends no task prompt", async () => {
  const sent = [];
  let sessionId;
  let promptSent = false;
  const out = await runDelegate({
    spec: "do the thing", workspace: process.cwd(),
    onSessionReady: (id) => { sessionId = id; },
    onPromptSent: () => { promptSent = true; },
    clientFactory: () => {
      const client = tappedFactory((method, _params, send) => { sent.push(method); return send(); });
      const setMode = client.setMode.bind(client);
      client.setMode = async (...args) => {
        const res = await setMode(...args);
        client.cancel(sessionId);
        return res;
      };
      return client;
    },
  });
  assert.ok(sent.includes("session/set_mode"), sent.join());
  assert.ok(!sent.includes("session/prompt"), "the task prompt went out after the cancel");
  assert.equal(promptSent, false);
  assert.equal(out.stopReason, "cancelled");
  assert.equal(out.result, "");
  assert.equal(out.resultSource, "none");
});

// The held read stands in for a slow disk, with no request in flight on the wire.
test("a cancel while an attachment is read decides the delegation at once", async () => {
  const fsp = require("node:fs/promises");
  const readFile = fsp.readFile;
  let reading;
  const held = new Promise((resolve) => { reading = resolve; });
  let release;
  let released;
  fsp.readFile = (...args) => { reading(); return new Promise((r) => { release = () => { released = readFile(...args); r(released); }; }); };
  syncBuiltinESMExports();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-held-read-"));
  writeFileSync(path.join(dir, "shot.png"), Buffer.alloc(16));
  let client;
  let sessionId;
  try {
    const run = runDelegate({
      spec: "do the thing", workspace: dir, contextFiles: ["shot.png"],
      onSessionReady: (id) => { sessionId = id; },
      clientFactory: () => (client = fakeFactory()),
    });
    await held;
    client.cancel(sessionId);
    const out = await Promise.race([run, new Promise((r) => setTimeout(() => r("still reading"), 3000))]);
    assert.notEqual(out, "still reading", "the delegation waited for the attachment read after the cancel");
    assert.equal(out.stopReason, "cancelled");
    assert.equal(out.result, "");
  } finally {
    fsp.readFile = readFile;
    syncBuiltinESMExports();
    release?.();
    // Windows does not delete a file the released read still holds open.
    await released?.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancel before the first setup call keeps every setup call off the wire", async () => {
  const sent = [];
  // Neither is agy's default, so each would take a set_config_option.
  const out = await runDelegate({
    spec: "do the thing", workspace: process.cwd(), model: "gemini-3.8-flash", effort: "low",
    onSessionReady: (id, client) => { client.cancel(id); },
    clientFactory: () => tappedFactory((method, _params, send) => { sent.push(method); return send(); }),
  });
  assert.equal(out.stopReason, "cancelled");
  assert.deepEqual(sent.filter((m) => /^session\/(set_model|set_config_option|set_mode|prompt)$/.test(m)), []);
});

// The handshake timeout ends the delegation while initialize is on the wire, and its reply reaches
// setup only after that. Setup went on from it: it asked agy for a session that nothing would close
// and announced it after the call had failed.
test("a handshake reply that lands after the delegation failed opens no session", async () => {
  const sent = [];
  const ready = [];
  let failed;
  const done = new Promise((r) => { failed = r; });
  await assert.rejects(
    runDelegate({
      spec: "do the thing", workspace: process.cwd(), handshakeMs: 100,
      onSessionReady: (id) => { ready.push(id); },
      clientFactory: () => tappedFactory((method, _params, send) => {
        sent.push(method);
        const reply = send();
        return method === "initialize" ? reply.then(async (r) => { await done; return r; }) : reply;
      }),
    }),
    (err) => err.reason === "handshake-timeout",
  );
  failed();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, ["initialize"]);
  assert.deepEqual(ready, []);
});

// The cancel goes out while the model request is on the wire, and its reply reaches setup only
// once the delegation has returned. Setup went on from that reply and recorded the cancelled
// delegation's model, so the next resume ran on it.
test("a setup reply that lands after a cancel leaves the session's remembered settings alone", async () => {
  const run = (args) => runDelegate({ spec: "do the thing", workspace: process.cwd(), resumeSessionId: "known-late", clientFactory: fakeFactory, ...args });
  await run({ model: "gemini-3.8-flash" });
  let returned;
  const done = new Promise((r) => { returned = r; });
  const cancelled = await run({
    model: "claude-sonnet-5-5",
    clientFactory: () => {
      const client = tappedFactory((method, params, send) => {
        if (method !== "session/set_config_option") return send();
        const reply = send();
        client.cancel(params.sessionId);
        return reply.then(async (r) => { await done; return r; });
      });
      return client;
    },
  });
  assert.equal(cancelled.stopReason, "cancelled");
  returned();
  await new Promise((r) => setTimeout(r, 50));
  const bare = await run({});
  assert.equal(bare.effectiveModel, "gemini-3.8-flash");
});

// Off the wire: the counts come from the session/prompt reply and the context from the
// usage_update frame, the two places agy 1.5.14 reports them.
test("runDelegate returns the turn's token usage and the session's context fill", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.deepEqual(out.usage, { scope: "turn", inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, totalTokens: 12 });
  assert.deepEqual(out.context, { used: 12, size: 1048576 });
});

// Returned while agy was still closing, a delegation left a process holding the workspace as its
// cwd: deleting the workspace right after failed with EBUSY on Windows (the live e2e suite).
test("a finished delegation returns only after the agent has closed its session and exited by itself", async () => {
  let client;
  const out = await runDelegate({
    spec: "do the thing", workspace: process.cwd(),
    clientFactory: () => (client = fakeFactory()),
  });
  assert.equal(out.result, "done");
  assert.ok(!isChildAlive(client.child), "the agent must be gone when the result arrives");
  assert.deepEqual({ code: client.child.exitCode, signal: client.child.signalCode }, { code: 0, signal: null },
    "the agent must exit on its own, not be killed");
});

test("a stalled delegation kills the agent without waiting out a grace", async () => {
  let client;
  const started = Date.now();
  await assert.rejects(
    runDelegate({
      spec: "task", workspace: process.cwd(), handshakeMs: 300,
      clientFactory: () => (client = new AcpClient({
        spawnSpec: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/handshake-hang-stub.js", import.meta.url))], options: { shell: false } },
      })),
    }),
    (err) => err.reason === "handshake-timeout",
  );
  assert.ok(!isChildAlive(client.child), "the agent must be gone when the failure arrives");
  assert.ok(Date.now() - started < 1800, `the failure took ${Date.now() - started} ms`);
});

test("usage keeps only ACP's numeric token fields, and context only a complete usage_update", async () => {
  const out = await runDelegate({
    spec: "task", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient();
      client.prompt = async () => {
        client.emit("update", { update: { sessionUpdate: "usage_update", used: 50, size: 1000 } });
        client.emit("update", { update: msgChunk("ok") });
        // A frame without numbers does not erase the last good reading.
        client.emit("update", { update: { sessionUpdate: "usage_update" } });
        client.emit("update", { update: { sessionUpdate: "usage_update", used: "60", size: 1000 } });
        return { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: -1, thoughtTokens: "3", costUsd: 0.01 } };
      };
      return client;
    },
  });
  assert.deepEqual(out.usage, { scope: "turn", inputTokens: 7 });
  assert.deepEqual(out.context, { used: 50, size: 1000 });
});

test("usage and context are absent when the agent reports neither", async () => {
  const out = await runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: () => stubClient() });
  assert.equal(out.usage, undefined);
  assert.equal(out.context, undefined);
});

test("runDelegate omits filesReportedByEditTools in plan mode when no diff events arrive", async () => {
  const out = await runDelegate({ spec: "draft a plan", mode: "plan", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.filesReportedByEditTools, undefined, "absence, not an empty list, means nothing was reported");
});

function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test("runDelegate leaves an existing reason alone and tags nothing without an rpc code", async () => {
  const factory = () => {
    const client = stubClient();
    client.start = async () => { throw new Error("spawn failed"); };
    return client;
  };
  await assert.rejects(
    runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: factory }),
    (err) => {
      assert.equal(err.reason, undefined);
      return true;
    }
  );
  await assert.rejects(
    runDelegate({
      spec: "task", model: "no-such-model", workspace: process.cwd(),
      clientFactory: modelOptionsFactory(["gemini-4-neon"]),
    }),
    (err) => {
      assert.equal(err.reason, "unknown-model");
      return true;
    }
  );
});

test("runDelegate surfaces the agent-assigned title as progress, not in the result", async () => {
  const progress = [];
  const factory = () => {
    const client = stubClient("sess-titled");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "session_info_update", title: "File Creator" } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    };
    return client;
  };
  const out = await runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: factory, onProgress: (m) => progress.push(m) });
  // The title is a live label (and timeout forensics); in the result it arrives too late to
  // help and has been measured contradicting the answer.
  assert.equal(out.sessionTitle, undefined);
  assert.ok(progress.includes("turn titled: File Creator"), `expected title progress line, got ${JSON.stringify(progress)}`);
  assert.equal(out.result, "done");
});

// agy's plan-mode turn: a write_file carrying ArtifactMetadata (shape from
// docs/captures/plan-mode.jsonl), then a short message pointing at the file.
const PLAN_PATH = path.join(tmpdir(), "brain", "sess-plan", "plan_add_changelog.md");
const PLAN_CONTENT = "# Plan\n\n1. Create CHANGELOG.md";
function planArtifactFactory({ message = "I have created the implementation plan artifact.", trailingTool = false } = {}) {
  return () => {
    const client = stubClient("sess-plan");
    client.prompt = async () => {
      const input = {
        ArtifactMetadata: { RequestFeedback: true, Summary: "Add a changelog file", UserFacing: true },
        Content: PLAN_CONTENT,
        Overwrite: true,
        Path: PLAN_PATH,
      };
      client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "w1", name: "write_file", kind: "edit", status: "in_progress", rawInput: input, args: input } });
      client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "w1", name: "write_file", kind: "edit", status: "completed", rawInput: input, args: input,
        content: [{ type: "diff", path: "/" + PLAN_PATH.split(path.sep).join("/"), oldText: "", newText: input.Content }] } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: message } } });
      if (trailingTool) {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "tool", status: "pending" } });
        client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      }
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

test("plan mode returns the plan artifact as plan, the message as result, and no edited files", async () => {
  const out = await runDelegate({ spec: "plan it", mode: "plan", workspace: process.cwd(), clientFactory: planArtifactFactory() });
  assert.equal(out.result, "I have created the implementation plan artifact.");
  assert.deepEqual(out.plan, { path: PLAN_PATH, overview: "Add a changelog file", detail: PLAN_CONTENT });
  assert.equal(out.filesReportedByEditTools, undefined, "the artifact is agy's file, not a workspace edit");
  assert.equal(out.artifacts, undefined);
});

test("agent mode lists an artifact by path and summary, without its content", async () => {
  const out = await runDelegate({ spec: "do it", mode: "agent", workspace: process.cwd(), clientFactory: planArtifactFactory() });
  assert.equal(out.plan, undefined);
  assert.deepEqual(out.artifacts, [{ path: PLAN_PATH, summary: "Add a changelog file" }]);
  assert.equal(out.filesReportedByEditTools, undefined);
});

test("runDelegate falls back to the pre-tool preamble when a trailing tool leaves no final message", async () => {
  const out = await runDelegate({
    spec: "plan it", mode: "plan", workspace: process.cwd(),
    clientFactory: planArtifactFactory({ message: "Reviewing the code.", trailingTool: true }),
  });
  assert.equal(out.result, "Reviewing the code.");
  assert.equal(out.resultSource, "pre-tool-fallback");
  assert.equal(out.plan.detail, PLAN_CONTENT);
  assert.ok(out.protocolWarnings.some((w) => /never spoke again/.test(w)));
});

test("runDelegate does not fold reasoning (thinking) into the result", async () => {
  const progress = [];
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: thinkingFactory(),
    onProgress: (m) => progress.push(m),
  });
  assert.equal(out.result, "done");
  assert.ok(!out.result.includes("SECRET-THOUGHT"), "reasoning must not appear in the result");
  assert.ok(progress.some((m) => m.startsWith("thinking:")), "expected thinking progress");
  assert.ok(progress.some((m) => m.startsWith("running:")), "expected tool_call start progress");
});

test("runDelegate calls onProgress on agent message chunks and tool-call updates", async () => {
  const progress = [];
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: fakeFactory,
    onProgress: (msg) => progress.push(msg),
  });
  assert.equal(out.result, "done");
  assert.ok(progress.some((m) => m.includes("done")), "expected message-chunk progress");
  assert.ok(progress.some((m) => m.includes("editing hello.txt")), "expected tool-call progress");
});

const replayFactory = (updates) => () => {
  const client = stubClient("sess-replay");
  client.prompt = async () => {
    for (const update of updates) client.emit("update", { update });
    return { stopReason: "end_turn" };
  };
  return client;
};

const msgChunk = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thoughtChunk = (text) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const toolCall = (toolCallId, status = "pending") => ({ sessionUpdate: "tool_call", toolCallId, title: "tool", status });
const toolUpdate = (toolCallId, status) => ({ sessionUpdate: "tool_call_update", toolCallId, status });

async function replayResult(updates) {
  return runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: replayFactory(updates),
  });
}

async function collectProgress(updates, opts = {}) {
  const progress = [];
  await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: replayFactory(updates),
    onProgress: (m) => progress.push(m),
    ...opts,
  });
  return progress;
}

// Frames as agy 1.5.14 sends them (docs/captures): run_command carries CommandLine in rawInput and
// exit_code in rawOutput, and a non-zero exit still finishes as completed.
const runCommand = (id, command, status = "in_progress", exitCode) => ({
  sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update", toolCallId: id, name: "run_command",
  kind: "execute", status, title: command, rawInput: { CommandLine: command, WaitMsBeforeAsync: 5000 },
  ...(exitCode !== undefined ? { rawOutput: { output: `Command exited with code ${exitCode}.`, exit_code: exitCode } } : {}),
});
const readFileCall = (id, status) => ({
  sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update", toolCallId: id, name: "read_file",
  kind: "read", status, title: "File a.js", rawInput: { Path: "a.js" },
});

test("execution counts a tool kind that names an Object property like any other", () => {
  const summary = executionSummary(new Map([["t1", { kind: "constructor" }], ["t2", { kind: "__proto__" }], ["t3", { kind: "constructor" }]]));
  assert.equal(JSON.stringify(summary.toolCalls), '{"constructor":2,"__proto__":1}');
});

test("execution keeps a finished command apart from a new one agy runs under the same id", async () => {
  const out = await replayResult([
    runCommand("t1", "npm test"), runCommand("t1", "npm test", "completed", 1),
    runCommand("t1", "npm run lint"),
    msgChunk("Done."),
  ]);
  assert.equal(out.execution.toolCalls.execute, 2);
  assert.deepEqual(out.execution.commands, [{ command: "npm test", exitCode: 1 }, { command: "npm run lint", status: "in_progress" }]);
});

test("execution counts each tool call once by kind and lists a repeated command once, at its last run", async () => {
  const plan = { ArtifactMetadata: { Summary: "plan" }, Content: "# plan", Path: path.join(tmpdir(), "brain", "plan.md") };
  const out = await replayResult([
    readFileCall("r1", "in_progress"),
    readFileCall("r1", "completed"),
    runCommand("c1", "npm test", "in_progress"),
    runCommand("c1", "npm test", "completed", 1),
    runCommand("c2", "npm test", "in_progress"),
    runCommand("c2", "npm test", "completed", 0),
    { sessionUpdate: "tool_call", toolCallId: "w1", name: "write_file", kind: "edit", status: "completed", rawInput: plan },
    { sessionUpdate: "tool_call", toolCallId: "q1", name: "ask_question", kind: "other", status: "completed", rawInput: { questions: [] } },
    // agy re-sends finished calls at the end of a turn; a stale in_progress does not reopen one.
    readFileCall("r1", "completed"),
    { ...runCommand("c1", "npm test", "completed", 1), sessionUpdate: "tool_call" },
    { ...runCommand("c2", "npm test", "in_progress"), sessionUpdate: "tool_call_update" },
    msgChunk("Tests pass."),
  ]);
  assert.deepEqual(out.execution, {
    toolCalls: { read: 1, execute: 2, other: 1 },
    commands: [{ command: "npm test", exitCode: 0, runs: 2 }],
  });
});

test("execution marks a command still running when the turn ended", async () => {
  const out = await replayResult([
    runCommand("bg", "npm run dev", "in_progress"),
    msgChunk("Started the dev server."),
  ]);
  assert.deepEqual(out.execution.commands, [{ command: "npm run dev", status: "in_progress" }]);
});

// Commands run once each, in order: i fails with exit 2 when failing(i), else passes.
const commandRun = (count, failing = () => false) => {
  const updates = [];
  for (let i = 0; i < count; i++) {
    updates.push(runCommand(`c${i}`, `step ${i}`, "in_progress"), runCommand(`c${i}`, `step ${i}`, "completed", failing(i) ? 2 : 0));
  }
  return updates;
};

test("execution lists the newest commands, passing ones included, and keeps older failures", async () => {
  const updates = commandRun(15, (i) => i === 1);
  // Started early and never finished: a failure for this purpose, kept though older.
  updates.splice(4, 0, runCommand("bg", "npm run dev", "in_progress"));
  updates.push(runCommand("long", "x".repeat(400), "in_progress"), runCommand("long", "x".repeat(400), "completed", 0));
  const out = await replayResult([...updates, msgChunk("done")]);
  assert.equal(out.execution.toolCalls.execute, 17);
  assert.deepEqual(out.execution.commands.slice(0, 2), [
    { command: "step 1", exitCode: 2 },
    { command: "npm run dev", status: "in_progress" },
  ]);
  const recent = out.execution.commands.slice(2);
  assert.equal(recent.length, RECENT_COMMANDS);
  assert.deepEqual(recent.slice(0, -1).map((c) => c.command), ["step 8", "step 9", "step 10", "step 11", "step 12", "step 13", "step 14"]);
  assert.deepEqual(recent.at(-1), { command: "x".repeat(150) + "…", exitCode: 0 });
  assert.equal(out.execution.commandsOmitted, 17 - 2 - RECENT_COMMANDS);
});

test("execution keeps at most a few older failures, the newest of them", async () => {
  const out = await replayResult([...commandRun(12 + RECENT_COMMANDS, (i) => i < 12), msgChunk("done")]);
  const older = out.execution.commands.slice(0, -RECENT_COMMANDS);
  assert.deepEqual(older.map((c) => c.command), ["step 7", "step 8", "step 9", "step 10", "step 11"]);
  assert.equal(older.length, OLDER_FAILED_COMMANDS);
  assert.equal(out.execution.commandsOmitted, 12 - OLDER_FAILED_COMMANDS);
});

test("execution is absent when the agent called no tools", async () => {
  const out = await replayResult([msgChunk("Nothing to do.")]);
  assert.equal("execution" in out, false);
});

// agy 1.5.14's ask_question as captured with probes/ask-question.mjs: it streams the question as
// prose, leaves the call pending and ends the turn.
const AGY_QUESTIONS = [
  { is_multi_select: false, options: ["(Recommended) Rename x in a.js", "Rename x in b.js", "Rename x in both a.js and b.js"], question: "Which file's variable `x` would you like to rename?" },
  { is_multi_select: false, options: ["(Recommended) count", "value", "num", "item"], question: "What new name should be used for the variable?" },
];
const askQuestion = (id, questions = AGY_QUESTIONS) => [
  { sessionUpdate: "tool_call", toolCallId: id, name: "ask_question", kind: "other", status: "in_progress", title: "Run ask_question", rawInput: { questions }, args: { questions } },
  { sessionUpdate: "tool_call_update", toolCallId: id, name: "ask_question", kind: "other", status: "pending", title: "Run ask_question", rawInput: { questions } },
];

test("questions carries agy's open ask_question, with the recommended option named", async () => {
  const out = await replayResult([...askQuestion("ask1"), msgChunk("Which variable would you like to rename?")]);
  assert.deepEqual(out.questions, [
    { question: "Which file's variable `x` would you like to rename?", options: ["Rename x in a.js", "Rename x in b.js", "Rename x in both a.js and b.js"], recommended: "Rename x in a.js" },
    { question: "What new name should be used for the variable?", options: ["count", "value", "num", "item"], recommended: "count" },
  ]);
  assert.equal(out.result, "Which variable would you like to rename?");
  assert.equal(out.resultSource, "unfinished-tool");
  assert.equal(out.protocolWarnings, undefined, "questions carries the question; no warning repeats it");
});

test("questions marks a multi-select question and omits recommended when agy marked none", async () => {
  const out = await replayResult(askQuestion("ask1", [{ is_multi_select: true, options: ["lint", "test"], question: "Which checks?" }]));
  assert.deepEqual(out.questions, [{ question: "Which checks?", options: ["lint", "test"], multiSelect: true }]);
});

test("questions is absent when agy's question was answered within the turn", async () => {
  const out = await replayResult([
    ...askQuestion("ask1"),
    { sessionUpdate: "tool_call_update", toolCallId: "ask1", name: "ask_question", status: "completed" },
    msgChunk("Renamed."),
  ]);
  assert.equal("questions" in out, false);
});

test("an ask_question whose questions cannot be read keeps the warning instead", async () => {
  const out = await replayResult(askQuestion("ask1", "not a list"));
  assert.equal("questions" in out, false);
  assert.match(out.protocolWarnings.join(" "), /agy is asking a question/);
});

test("questions are read from a tool_call_update when the opening frame had none", async () => {
  const out = await replayResult([
    { sessionUpdate: "tool_call", toolCallId: "ask1", name: "ask_question", kind: "other", status: "in_progress", title: "Run ask_question" },
    { sessionUpdate: "tool_call_update", toolCallId: "ask1", name: "ask_question", status: "pending", rawInput: { questions: AGY_QUESTIONS } },
    msgChunk("Which variable?"),
  ]);
  assert.equal(out.questions.length, 2);
});

test("a reused ask_question id reports the new call's questions, not the old one's", async () => {
  const out = await replayResult([
    ...askQuestion("ask1"),
    { sessionUpdate: "tool_call_update", toolCallId: "ask1", name: "ask_question", status: "completed" },
    { sessionUpdate: "tool_call", toolCallId: "ask1", name: "ask_question", kind: "other", status: "in_progress", title: "Run ask_question" },
    { sessionUpdate: "tool_call_update", toolCallId: "ask1", name: "ask_question", status: "pending", rawInput: { questions: [{ question: "Which name?", options: ["count", "value"] }] } },
    msgChunk("Which name?"),
  ]);
  assert.deepEqual(out.questions, [{ question: "Which name?", options: ["count", "value"] }]);
});

test("questions is reported alongside the warning for a background command still running", async () => {
  const out = await replayResult([
    runCommand("bg", "npm run dev", "in_progress"),
    ...askQuestion("ask1"),
    msgChunk("Which variable?"),
  ]);
  assert.equal(out.questions.length, 2);
  assert.match(out.protocolWarnings.join(" "), /npm run dev/);
});

// Steers while agy's question is open, before its turn ends; then is text agy sends after it.
const steerDuringAsk = (opts, { steers = 1, then } = {}) => {
  const factory = askingClientFactory(opts);
  return (o) => {
    const client = factory(o);
    const prompt = client.prompt;
    client.prompt = async (...args) => {
      const turn = await prompt(...args);
      for (let i = 0; i < steers; i++) client.steer("sess-ask", "use b.js");
      if (then) client.emit("update", { sessionId: "sess-ask", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: then } } });
      return turn;
    };
    return client;
  };
};

test("a steer closes the question agy leaves open, so it is not returned", async () => {
  const out = await runDelegate({ spec: "Rename the variable.", workspace: process.cwd(), clientFactory: steerDuringAsk() });
  assert.equal("questions" in out, false);
  assert.equal(out.result, "Renamed as answered.");
});

test("a steer agy rejects leaves its question open, and returned", async () => {
  const out = await runDelegate({ spec: "Rename the variable.", workspace: process.cwd(), clientFactory: steerDuringAsk({ rejects: 1 }) });
  assert.equal(out.questions.length, 2);
  assert.equal(out.result, "Which file?");
  assert.match(out.protocolWarnings.join(" "), /a steer was rejected by agy/);
});

test("text agy sends between a steer and its rejection stays with the reopened question", async () => {
  const out = await runDelegate({ spec: "Rename the variable.", workspace: process.cwd(), clientFactory: steerDuringAsk({ rejects: 1 }, { then: " Or both?" }) });
  assert.equal(out.result, "Which file? Or both?");
  assert.equal(out.questions.length, 2);
});

test("a question a rejected steer closed stays closed when a steer behind it gets through", async () => {
  const out = await runDelegate({ spec: "Rename the variable.", workspace: process.cwd(), clientFactory: steerDuringAsk({ rejects: 1 }, { steers: 2 }) });
  assert.equal("questions" in out, false);
  assert.equal(out.result, "Renamed as answered.");
});

test("a steer closes an open question whose questions could not be read", async () => {
  const out = await runDelegate({ spec: "Rename the variable.", workspace: process.cwd(), clientFactory: steerDuringAsk({ questions: "not a list" }) });
  assert.equal(out.result, "Renamed as answered.");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate joins streamed fragments into complete-sentence progress", async () => {
  const progress = await collectProgress([
    thoughtChunk("checking the call si"),
    thoughtChunk("tes in src/api. Then the tests"),
    msgChunk("Convert"),
    msgChunk("ing getUser to asy"),
    msgChunk("nc now. Updating expo"),
    msgChunk("rts next"),
  ]);
  assert.ok(progress.includes("thinking: checking the call sites in src/api."), "thought fragments joined at sentence boundary");
  assert.ok(progress.includes("agy: Converting getUser to async now."), "message fragments joined at sentence boundary");
  assert.ok(progress.includes("agy: Updating exports next"), "trailing buffer flushed at end of turn");
  assert.ok(!progress.some((m) => m.includes("asy") && !m.includes("async")), "no mid-word fragments emitted");
});

test("runDelegate splits thought summaries that arrive with no separator", async () => {
  const progress = await collectProgress([
    thoughtChunk("This mismatch prevents the utility from receiving its expected input."),
    thoughtChunk("A concrete bug was identified in write-settings-conf."),
    thoughtChunk("The script only reads from standard input."),
  ]);
  assert.ok(progress.includes("thinking: This mismatch prevents the utility from receiving its expected input."), "first summary emits as its own line");
  assert.ok(!progress.some((m) => m.includes("input.A")), "no jammed sentence boundaries");
});

test("runDelegate throttles progress: newest sentence wins, middle ones drop", async () => {
  const progress = await collectProgress(
    [msgChunk("First point. Second point. Third point. ")],
    { progressThrottleMs: 60000 },
  );
  assert.ok(progress.includes("agy: First point."), "first sentence emits immediately");
  assert.ok(!progress.includes("agy: Second point."), "throttled middle sentence is dropped");
  assert.ok(progress.includes("agy: Third point."), "latest pending sentence flushes at end of turn");
});

test("runDelegate skips markdown structure in progress (tables, headings, fences, bullets)", async () => {
  const progress = await collectProgress([
    msgChunk("| Privileged ops | 23 bash sbin scripts |\n"),
    msgChunk("## Assessment\n"),
    msgChunk("```\ncode line\n```\n"),
    msgChunk("- bullet item\n"),
    msgChunk("The build script downloads binaries without checksums.\n"),
  ]);
  assert.ok(!progress.some((m) => m.includes("Privileged ops")), "table rows are not progress");
  assert.ok(!progress.some((m) => m.includes("Assessment")), "headings are not progress");
  assert.ok(!progress.some((m) => m.includes("bullet item")), "bullets are not progress");
  assert.ok(progress.includes("agy: The build script downloads binaries without checksums."), "prose still flows through");
});

test("runDelegate includes the tool location in running: progress when present", async () => {
  const progress = await collectProgress([
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read File", kind: "read", status: "pending", locations: [{ path: "src/api/user.js" }] },
    { sessionUpdate: "tool_call", toolCallId: "t2", title: "grep", kind: "search", status: "pending", rawInput: {} },
  ]);
  assert.ok(progress.includes("running: Read File — src/api/user.js"), "location path shown");
  assert.ok(progress.includes("running: grep"), "bare label when the agent sends no location");
});

// agy 1.5.14's edit_file tool_call, as a live stdio run reported it: the title names the file with
// forward slashes, the location with backslashes. The path is shown once.
test("a title that already names the location is not followed by it again", async () => {
  const progress = await collectProgress([
    { sessionUpdate: "tool_call", toolCallId: "t1", name: "edit_file", title: "File C:/ws/notes.txt", kind: "edit", status: "in_progress",
      locations: [{ path: "C:\\ws\\notes.txt" }] },
  ]);
  assert.ok(progress.includes("running: File C:/ws/notes.txt"), JSON.stringify(progress));
});

test("a multi-line tool title is reported as one line", async () => {
  // A terminal tool's title is the command the agent sent, and it sends a multi-line script
  // verbatim. Both readers of this take one line: the progress notification, and the "last tool
  // call" line a stall error carries.
  const title = ["npm run build", "  --workspace=api", "", "  --silent"].join("\n");
  const progress = await collectProgress([
    { sessionUpdate: "tool_call", toolCallId: "t1", title, kind: "execute", status: "pending" },
  ]);
  const line = progress.find((m) => m.startsWith("running: "));
  assert.ok(line, "the tool call must be reported");
  assert.ok(!/[\r\n]/.test(line), `the reported command must be one line, got ${JSON.stringify(line)}`);
  assert.equal(line, "running: npm run build --workspace=api --silent");
});

test("runDelegate returns the complete stream when the turn uses no tools", async () => {
  const out = await replayResult([msgChunk("Code:\n"), msgChunk("```js\nrun();\n```")]);
  assert.equal(out.result, "Code:\n```js\nrun();\n```");
  assert.equal(out.resultSource, undefined);
});

test("runDelegate returns only text emitted after the final tool completes", async () => {
  const out = await replayResult([
    msgChunk("', '', raw, flags=re.DOTALL).strip()\n"),
    toolCall("edit-1"),
    msgChunk("text emitted while the tool is active"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Updated `sbin/setup-llm` and validated it."),
  ]);
  assert.equal(out.result, "Updated `sbin/setup-llm` and validated it.");
  assert.equal(out.resultSource, undefined);
});

test("runDelegate discards text that is followed by another tool call", async () => {
  const out = await replayResult([
    msgChunk("Inspecting the implementation."),
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk("Found the likely issue; checking callers."),
    toolCall("search-1"),
    toolUpdate("search-1", "completed"),
    msgChunk("The callers are updated and tests pass."),
  ]);
  assert.equal(out.result, "The callers are updated and tests pass.");
  assert.equal(out.resultSource, undefined);
});

test("runDelegate waits for all active tools before collecting final text", async () => {
  const out = await replayResult([
    toolCall("read-1"),
    toolCall("read-2"),
    toolUpdate("read-1", "completed"),
    msgChunk("one tool is still active"),
    toolUpdate("read-2", "completed"),
    msgChunk("Both reads completed; here is the answer."),
  ]);
  assert.equal(out.result, "Both reads completed; here is the answer.");
  assert.equal(out.resultSource, undefined);
});

// This shape used to return "" with stopReason end_turn and no error. The discarded text is
// as often the whole answer as a preamble, so label it, warn, and return it.
test("runDelegate falls back to the last message when a tool call ends the turn", async () => {
  const out = await replayResult([
    msgChunk("I will make the edit."),
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
  ]);
  assert.equal(out.result, "I will make the edit.");
  assert.equal(out.resultSource, "pre-tool-fallback");
  assert.ok(out.protocolWarnings.some((w) => /never spoke again/.test(w)), "the fallback is disclosed");
});

test("runDelegate falls back to the answer, not the preamble, when both were discarded", async () => {
  const out = await replayResult([
    msgChunk("Inspecting the implementation."),
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk("The parser drops the trailing byte."),
    toolCall("verify-1"),
    toolUpdate("verify-1", "completed"),
  ]);
  assert.equal(out.result, "The parser drops the trailing byte.");
  assert.equal(out.resultSource, "pre-tool-fallback");
});

test("runDelegate warns rather than returning a bare empty success", async () => {
  const out = await replayResult([toolCall("edit-1"), toolUpdate("edit-1", "completed")]);
  assert.equal(out.result, "");
  assert.equal(out.resultSource, "none");
  assert.ok(out.protocolWarnings.some((w) => /without emitting any message/.test(w)));
});

test("runDelegate prefers a real final message over the fallback", async () => {
  const out = await replayResult([
    msgChunk("I will make the edit."),
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Edited the parser."),
  ]);
  assert.equal(out.result, "Edited the parser.");
  assert.equal(out.resultSource, undefined);
  assert.ok(!(out.protocolWarnings || []).some((w) => /never spoke again/.test(w)));
});

test("runDelegate keeps the final message when a duplicate terminal tool update arrives late", async () => {
  const out = await replayResult([
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Fixed the parser and added a regression test."),
    toolUpdate("edit-1", "completed"),
  ]);
  assert.equal(out.result, "Fixed the parser and added a regression test.");
  assert.equal(out.resultSource, undefined);
});

test("runDelegate preserves a legitimate code-only final response", async () => {
  const code = "```js\nexport const answer = 42;\n```";
  const out = await replayResult([
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk(code),
  ]);
  assert.equal(out.result, code);
  assert.equal(out.resultSource, undefined);
});

test("runDelegate survives a throwing onProgress callback", async () => {
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: fakeFactory,
    onProgress: () => { throw new Error("progress boom"); },
  });
  assert.equal(out.result, "done");
});

function promptTextFactory(track) {
  return () => {
    const client = fakeFactory();
    const origPrompt = client.prompt.bind(client);
    client.prompt = async (sessionId, blocks) => {
      track.blocks = blocks;
      track.promptText = blocks.find((b) => b.type === "text")?.text;
      return origPrompt(sessionId, blocks);
    };
    return client;
  };
}

test("runDelegate sends only a text block when no contextFiles are given", async () => {
  const track = {};
  await runDelegate({ spec: "do it", mode: "agent", workspace: process.cwd(), clientFactory: promptTextFactory(track) });
  assert.deepEqual(track.blocks, [{ type: "text", text: "do it" }]);
});

test("runDelegate attaches contextFiles as resource_link blocks", async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", path.join(process.cwd(), "src", "delegate.js")],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.blocks[0].type, "text");
  const links = track.blocks.slice(1);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.type), ["resource_link", "resource_link"]);
  assert.deepEqual(links.map((l) => l.name), ["package.json", "delegate.js"]);
  // Relative entries resolve against workspace, and both arrive as absolute file:// URIs.
  assert.ok(links.every((l) => l.uri.startsWith("file:///")), JSON.stringify(links));
  assert.match(links[0].uri, /\/package\.json$/);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate deduplicates contextFiles that resolve to the same path", async () => {
  const track = {};
  const abs = path.join(process.cwd(), "package.json");
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", "package.json", "./package.json", abs],
    clientFactory: promptTextFactory(track),
  });
  const links = track.blocks.slice(1);
  assert.equal(links.length, 1, "equivalent entries collapse to one link");
  assert.match(links[0].uri, /\/package\.json$/);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate deduplicates contextFiles that differ only by case", {
  skip: process.platform === "win32" ? false : "case-insensitive fs",
}, async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", "PACKAGE.JSON"],
    clientFactory: promptTextFactory(track),
  });
  const links = track.blocks.slice(1);
  assert.equal(links.length, 1, "Win32 case variants must collapse to one link");
  assert.match(links[0].uri, /package\.json$/i);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate reports a missing contextFile instead of linking or failing", async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", "no-such-file-here.txt"],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(out.stopReason, undefined);
  assert.equal(track.blocks.length, 2, "the missing file must not be linked");
  assert.ok(out.protocolWarnings.some((w) => /contextFile skipped: 1 not found under .* — no-such-file-here\.txt/.test(w)));
});

// One warning for the whole batch, not one each: a wrong workspace misses every attachment at
// once, and a line apiece would repeat the same root for a single root cause.
test("runDelegate groups every missing contextFile into one warning", async () => {
  const track = {};
  const missing = Array.from({ length: 20 }, (_, i) => `missing-${String(i + 1).padStart(2, "0")}.js`);
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", ...missing],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.blocks.length, 2, "only the real file is linked");
  assert.equal(out.protocolWarnings.length, 1, "20 missing files produce one warning, not 20");
  const [warning] = out.protocolWarnings;
  assert.match(warning, /^contextFiles skipped: 20 not found under /);
  for (const name of missing) assert.ok(warning.includes(name), `${name} is named`);
  // The workspace root is the diagnostic — stated once, not once per file.
  assert.equal(warning.split(process.cwd()).length - 1, 1, "the root appears exactly once");
});

test("runDelegate skips a contextFile that is a directory", async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["src"],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.blocks.length, 1);
  assert.ok(out.protocolWarnings.some((w) => /contextFile src skipped: not a file/.test(w)));
});

// Smallest valid PNG bytes; only the extension and the capability gate are under test.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function imageCapableFactory(track, { image = true } = {}) {
  return () => {
    const client = fakeFactory();
    const origInit = client.initialize.bind(client);
    client.initialize = async () => {
      const res = await origInit();
      client.agentCapabilities = { promptCapabilities: { image } };
      return res;
    };
    const origPrompt = client.prompt.bind(client);
    client.prompt = async (sessionId, blocks) => {
      track.blocks = blocks;
      return origPrompt(sessionId, blocks);
    };
    return client;
  };
}

test("runDelegate sends an image contextFile inline when the agent accepts images", async () => {
  const imgPath = path.join(tmpdir(), `delegate-img-${process.pid}.png`);
  writeFileSync(imgPath, TINY_PNG);
  const track = {};
  try {
    const out = await runDelegate({
      spec: "look at this", mode: "agent", workspace: process.cwd(),
      contextFiles: [imgPath], clientFactory: imageCapableFactory(track),
    });
    assert.equal(track.blocks.length, 2);
    assert.equal(track.blocks[1].type, "image");
    assert.equal(track.blocks[1].mimeType, "image/png");
    assert.equal(track.blocks[1].data, TINY_PNG.toString("base64"));
    assert.equal(out.protocolWarnings, undefined);
  } finally {
    try { unlinkSync(imgPath); } catch {}
  }
});

test("runDelegate skips an unreadable image and continues with the remaining attachments", {
  skip: process.platform !== "win32" && process.getuid?.() === 0 ? "root bypasses file permissions" : false,
}, async () => {
  const imgPath = path.join(tmpdir(), `delegate-img-unreadable-${process.pid}.png`);
  writeFileSync(imgPath, TINY_PNG);
  let locker;
  let closed;
  const track = {};
  try {
    if (process.platform === "win32") {
      const script = fileURLToPath(new URL("./fixtures/lock-file.ps1", import.meta.url));
      // -File obeys the execution policy, and a default Windows client policy (Restricted) blocks
      // every script.
      locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, imgPath], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 10000,
      });
      closed = new Promise((resolve) => locker.once("close", resolve));
      await new Promise((resolve, reject) => {
        let stdout = "", stderr = "";
        locker.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("locked")) resolve();
        });
        locker.stderr.on("data", (chunk) => { stderr += chunk; });
        locker.once("error", reject);
        locker.once("exit", (code) => reject(new Error(`file locker exited ${code}: ${stderr}`)));
      });
    } else {
      chmodSync(imgPath, 0);
    }
    const out = await runDelegate({
      spec: "look at this", workspace: process.cwd(), contextFiles: [imgPath, "package.json"],
      clientFactory: imageCapableFactory(track), hardCapMs: 5000,
    });
    assert.equal(out.result, "done");
    assert.deepEqual(track.blocks.map((block) => block.type), ["text", "resource_link"]);
    assert.equal(track.blocks[1].name, "package.json");
    assert.equal(out.protocolWarnings.length, 1);
    assert.match(out.protocolWarnings[0], /contextFile .* skipped: could not read image/);
  } finally {
    if (locker) {
      locker.stdin.end("\n");
      await closed;
    } else {
      chmodSync(imgPath, 0o600);
    }
    unlinkSync(imgPath);
  }
});

test("runDelegate skips an image when the agent does not advertise image prompts", async () => {
  const imgPath = path.join(tmpdir(), `delegate-img-nocap-${process.pid}.png`);
  writeFileSync(imgPath, TINY_PNG);
  const track = {};
  try {
    const out = await runDelegate({
      spec: "look at this", mode: "agent", workspace: process.cwd(),
      contextFiles: [imgPath], clientFactory: imageCapableFactory(track, { image: false }),
    });
    // Silently sending it would vanish without error, so it must be dropped and reported.
    assert.equal(track.blocks.length, 1);
    assert.ok(out.protocolWarnings.some((w) => /does not accept image prompts/.test(w)));
  } finally {
    try { unlinkSync(imgPath); } catch {}
  }
});

test("runDelegate rejects a workspace that does not exist", async () => {
  const track = {};
  await assert.rejects(
    runDelegate({
      spec: "do it",
      mode: "agent",
      workspace: path.join(process.cwd(), "no_such_dir_12345"),
      clientFactory: promptTextFactory(track),
    }),
    (err) => err.reason === "invalid-workspace" && /does not exist/.test(err.message),
  );
  assert.equal(track.promptText, undefined, "rejected before the agent was spawned");
});

test("runDelegate rejects a workspace that is a file", async () => {
  await assert.rejects(
    runDelegate({
      spec: "do it",
      mode: "agent",
      workspace: fileURLToPath(import.meta.url),
      clientFactory: promptTextFactory({}),
    }),
    (err) => err.reason === "invalid-workspace" && /is not a directory/.test(err.message),
  );
});

test("runDelegate rejects a blank spec before spending a session", async () => {
  const track = {};
  await assert.rejects(
    runDelegate({
      spec: "   \n\t ",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory(track),
    }),
    (err) => err.reason === "invalid-spec" && /empty/.test(err.message),
  );
  assert.equal(track.promptText, undefined, "rejected before the agent was spawned");
});

test("runDelegate sends a brief that names a path as written", async () => {
  const track = {};
  await runDelegate({
    spec: "fix the bug in missing/brief.md",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.promptText, "fix the bug in missing/brief.md");
});

// The contract spec-as-path used to break: a brief is the prompt, whatever it looks like. This
// pins the case the old path detection got wrong — a spec that is itself an existing file name.
test("runDelegate sends a spec literally even when a file of that name exists", async () => {
  const inlineSpec = "brief.md";
  const specPath = path.join(process.cwd(), inlineSpec);
  writeFileSync(specPath, "file contents must not be used\n");
  const track = {};
  try {
    await runDelegate({
      spec: inlineSpec,
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory(track),
    });
    assert.equal(track.promptText, inlineSpec);
  } finally {
    try { unlinkSync(specPath); } catch {}
  }
});

function exitDuringPromptFactory() {
  return () => {
    const client = fakeFactory();
    client.prompt = () => new Promise(() => {
      client.emit("exit", { code: 1, signal: null, stderr: "boom-trace" });
    });
    return client;
  };
}

test("runDelegate rejects promptly when agent exits during prompt", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "do the thing",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: exitDuringPromptFactory(),
    }),
    (err) => {
      assert.equal(err.reason, "agent-exit");
      assert.match(err.message, /agent exited \(code=1\)/);
      assert.match(err.message, /boom-trace/);
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected fail-fast rejection, not full timeout");
});

test("runDelegate returns output above the former 10MB cap verbatim", async () => {
  const out = await runDelegate({
    spec: "big task",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: () => oversizedFactory(),
  });
  // One byte over the former ceiling, delivered whole — model output is bounded by the
  // model's own token limit, so there is nothing left to guard against.
  assert.equal(out.result.length, 10 * 1024 * 1024 + 1);
  assert.ok(!out.result.includes("[output truncated"));
});

function failingPromptFactory() {
  return () => {
    const client = fakeFactory();
    client.prompt = async () => { throw new Error("prompt failed"); };
    return client;
  };
}

test("runDelegate leaves the ACP transcript out of the error by default", async () => {
  delete process.env.AGY_DELEGATE_TRANSCRIPT;
  await assert.rejects(
    () => runDelegate({
      spec: "do the thing",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: failingPromptFactory(),
    }),
    (err) => {
      assert.match(err.message, /prompt failed/);
      assert.doesNotMatch(err.message, /recent ACP transcript/);
      return true;
    }
  );
});

test("runDelegate appends the transcript when AGY_DELEGATE_TRANSCRIPT is set", async () => {
  process.env.AGY_DELEGATE_TRANSCRIPT = "12";
  try {
    await assert.rejects(
      () => runDelegate({
        spec: "do the thing",
        mode: "agent",
        workspace: process.cwd(),
        clientFactory: failingPromptFactory(),
      }),
      (err) => {
        assert.match(err.message, /prompt failed/);
        assert.match(err.message, /--- recent ACP transcript \(last 12 frames\) ---/);
        assert.match(err.message, / out /);
        assert.match(err.message, / in /);
        return true;
      }
    );
  } finally {
    delete process.env.AGY_DELEGATE_TRANSCRIPT;
  }
});

// The same variable is read twice — recording in jsonrpc.js, attachment here. A non-numeric
// value must read as on at the default depth in both places, not on in one and off in the other.
test("runDelegate appends the transcript when AGY_DELEGATE_TRANSCRIPT is a non-numeric string", async () => {
  process.env.AGY_DELEGATE_TRANSCRIPT = "true";
  try {
    await assert.rejects(
      () => runDelegate({
        spec: "do the thing",
        mode: "agent",
        workspace: process.cwd(),
        clientFactory: failingPromptFactory(),
      }),
      (err) => {
        assert.match(err.message, /--- recent ACP transcript \(last 50 frames\) ---/);
        return true;
      }
    );
  } finally {
    delete process.env.AGY_DELEGATE_TRANSCRIPT;
  }
});

function scriptedFactory({ stopReason = "end_turn", message = "plan ready" }) {
  return () => {
    const client = stubClient("sess-scripted");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: message } } });
      return { stopReason };
    };
    return client;
  };
}

test("runDelegate surfaces a stop reason that is not end_turn", async () => {
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ stopReason: "refusal", message: "no" }),
  });
  assert.equal(out.stopReason, "refusal");
});

test("runDelegate drops a non-string stopReason with a protocol warning", async () => {
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ stopReason: { code: 7 }, message: "done" }),
  });
  assert.equal(out.stopReason, undefined);
  assert.equal(out.result, "done");
  assert.deepEqual(out.protocolWarnings, ["stopReason dropped: ACP requires a string stop reason"]);
});

test("runDelegate omits protocolWarnings when frames are well-formed", async () => {
  const out = await runDelegate({
    spec: "do it",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ message: "done" }),
  });
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate rejects immediately when signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  let factoryCalls = 0;
  await assert.rejects(
    () => runDelegate({
      spec: "task",
      mode: "agent",
      workspace: process.cwd(),
      signal: ac.signal,
      clientFactory: () => { factoryCalls++; return new EventEmitter(); },
    }),
    (err) => {
      assert.equal(err.reason, "aborted");
      return true;
    }
  );
  assert.equal(factoryCalls, 0);
});

function hangingFactory({ emit, title, resumeFails } = {}) {
  return () => {
    const client = stubClient("sess-forensics");
    client.resumeSession = async () => {
      if (resumeFails) throw rpcError(-32603, "Failed to read session stale-id; retry, or load it with session/load");
    };
    client.cancel = async () => {};
    client.prompt = () => {
      if (title) client.emit("update", { update: { sessionUpdate: "session_info_update", title } });
      emit?.(client);
      return new Promise(() => {});
    };
    return client;
  };
}

test("timeout error names the turn and a resume that had already failed", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      resumeSessionId: "stale-id",
      workspace: process.cwd(),
      clientFactory: hangingFactory({ title: "Auth Refactor", resumeFails: true }),
      handshakeMs: 10000,
      hardCapMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.match(err.message, /titled this turn "Auth Refactor"/);
      assert.match(err.message, /resuming stale-id had already failed \(agy has no session stale-id\)/);
      assert.match(err.message, /none of that earlier work was in context/);
      assert.match(err.message, /Resume with resumeSessionId sess-forensics/);
      return true;
    }
  );
});

test("timeout error stays quiet about resume and title when neither applies", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory(),
      handshakeMs: 10000,
      hardCapMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.doesNotMatch(err.message, /titled this turn/);
      assert.doesNotMatch(err.message, /had already failed/);
      return true;
    }
  );
});

test("an aborted error names its resume id without the stall forensics", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory({ title: "Auth Refactor" }),
      handshakeMs: 10000,
      hardCapMs: 10000,
      heartbeatMs: 0,
      signal: controller.signal,
    }),
    (err) => {
      assert.equal(err.reason, "aborted");
      assert.equal(err.message, "delegation aborted by MCP host. Resume with resumeSessionId sess-forensics.");
      return true;
    }
  );
});

// An edit tool_call carries title "Edit File" and no locations, so the file it touched is only
// knowable from the diff frame that follows — which still feeds filesReportedByEditTools, in any
// mode. (The mode is not an enforced boundary; the diff is the source of truth, so it is reported
// the same whether the agent was asked to plan or to implement.)
test("runDelegate reports a plan-mode edit via filesReportedByEditTools from its diff frame", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: replayFactory([
      { sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", title: "Edit File", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed",
        content: [{ type: "diff", path: path.join(process.cwd(), "docs", "plan.md") }] },
      msgChunk("Saved the plan."),
    ]),
  });
  assert.deepEqual(out.filesReportedByEditTools, ["docs/plan.md"]);
});

test("a non-positive hard cap falls back to the default instead of firing instantly", async () => {
  // Number("") is 0, so a blank env var would arm a zero-length deadline that fails every call.
  const prev = process.env.AGY_DELEGATE_HARD_CAP_MS;
  process.env.AGY_DELEGATE_HARD_CAP_MS = "0";
  try {
    const out = await runDelegate({ workspace: process.cwd(), spec: "hi", clientFactory: thinkingFactory(), heartbeatMs: 0 });
    assert.equal(out.result, "done");
  } finally {
    if (prev === undefined) delete process.env.AGY_DELEGATE_HARD_CAP_MS;
    else process.env.AGY_DELEGATE_HARD_CAP_MS = prev;
  }
});

test("frames arriving after the prompt settles do not mutate the finished turn", async () => {
  // A late tool_call_update carrying a diff used to be folded into the result while it was
  // still being assembled across awaits.
  let emitLate;
  const clientFactory = () => {
    const client = stubClient("sess-late");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "answer" } } });
      emitLate = () => client.emit("update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "late",
          status: "completed",
          content: [{ type: "diff", path: "ghost.js" }],
        },
      });
      return { stopReason: "end_turn" };
    };
    return client;
  };
  const out = await runDelegate({
    spec: "task",
    workspace: process.cwd(),
    clientFactory,
    heartbeatMs: 0,
    onProgress: () => emitLate?.(),
  });
  assert.equal(out.result, "answer");
  assert.equal(out.filesReportedByEditTools, undefined, "a frame after the turn belongs to no turn");
});

test("a delegation without a workspace is refused before anything is spawned", async () => {
  // The server's own cwd under npx or a plugin launch is a cache directory or the user's home,
  // so a defaulted workspace put an auto-approved agent to work on a tree nobody asked about
  // while every layer reported success.
  let spawned = false;
  const clientFactory = () => { spawned = true; return {}; };
  for (const workspace of [undefined, "", "   "]) {
    await assert.rejects(
      () => runDelegate({ spec: "task", workspace, clientFactory }),
      (err) => err.reason === "invalid-workspace" && /workspace is required/.test(err.message)
    );
  }
  assert.equal(spawned, false, "the workspace check must run before the agent is spawned");
});

// agy's session options, shaped like session/new on 1.5.13: base model ids under "model", the
// thinking level under "thought_level" (category thought_level), each model with its own levels.
const AGY_LEVELS = { "gemini-4-neon": ["low", "medium", "high", "xhigh"], "gemini-3.8-flash": ["low", "medium", "high"], "claude-sonnet-5-5": ["low", "medium", "high"] };
function agyOptions(model, thought, mode = "default", models = Object.keys(AGY_LEVELS)) {
  return [
    { id: "model", name: "Model", category: "model", currentValue: model, options: models.map((value) => ({ value })) },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", currentValue: thought, options: (AGY_LEVELS[model] || ["high"]).map((value) => ({ value })) },
    { id: "mode", name: "Mode", category: "mode", currentValue: mode, options: ["default", "accept-edits", "auto", "plan"].map((value) => ({ value })) },
  ];
}

// Records every config, mode and prompt call. Each set echoes the full option list the way agy
// does, and a thinking level the model does not offer is refused with agy's -32602.
function modelOptionsFactory(models = Object.keys(AGY_LEVELS), { opened = "gemini-4-neon", thought = "high", calls = [] } = {}) {
  return () => {
    const client = stubClient("sess-models");
    let model = opened, level = thought;
    client.newSession = async () => {
      client.configOptions = agyOptions(model, level, "default", models);
      return { sessionId: "sess-models" };
    };
    client.setConfigOption = async (_sid, configId, value) => {
      calls.push(["config", configId, value]);
      if (configId === "model") { model = value; if (!(AGY_LEVELS[model] || []).includes(level)) level = "high"; }
      if (configId === "thought_level") {
        if (!(AGY_LEVELS[model] || []).includes(value)) throw rpcError(-32602, `Thinking level "${value}" is not offered for model "${model}"`);
        level = value;
      }
      return { configOptions: agyOptions(model, level, "default", models) };
    };
    client.setMode = async (_sid, modeId) => { calls.push(["mode", modeId]); };
    client.prompt = async (_sid, blocks) => {
      calls.push(["prompt", blocks[0].text]);
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } });
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

test("runDelegate rejects an unknown model before prompting and names agy's base ids", async () => {
  const calls = [];
  await assert.rejects(
    runDelegate({ spec: "task", model: "gemini-4-neon-high", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) }),
    (err) => {
      assert.equal(err.reason, "unknown-model");
      assert.match(err.message, /agy offers: gemini-4-neon, gemini-3\.8-flash, claude-sonnet-5-5/);
      assert.match(err.message, /thinking level with effort/);
      // The id is assigned at session/new, before the config calls that raise this.
      assert.match(err.message, /Resume with resumeSessionId sess-models/);
      return true;
    }
  );
  assert.deepEqual(calls, []);
});

test("onPromptSent fires once with the session id, after the session opens and before the turn ends", async () => {
  const events = [];
  await runDelegate({
    spec: "do the thing",
    workspace: process.cwd(),
    clientFactory: fakeFactory,
    onSessionReady: (id) => events.push(`session ${id}`),
    onPromptSent: (id) => events.push(`prompt ${id}`),
    onTurnEnd: () => events.push("turn end"),
  });
  events.push("settled");
  assert.deepEqual(events, ["session sess-1", "prompt sess-1", "turn end", "settled"]);
});

test("onPromptSent carries why a resumed id ran as a fresh session, and nothing for one that did not", async () => {
  const notes = [];
  const run = (resumeSessionId) => runDelegate({
    spec: "do the thing", workspace: process.cwd(), resumeSessionId, clientFactory: fakeFactory,
    onPromptSent: (_id, note) => notes.push(note),
  });
  await run("never-seen");
  await run(undefined);
  assert.match(notes[0], /^resuming never-seen had already failed \(.+\), so this ran as a fresh session and none of that earlier work was in context\.$/);
  assert.equal(notes[1], undefined);
});

test("onUnseenExit carries the note when the stop could not confirm that agy and its processes exited", async () => {
  const notes = [];
  const out = await runDelegate({
    spec: "task", workspace: process.cwd(),
    clientFactory: () => { const client = stubClient("sess-x"); client.stop = async () => false; return client; },
    onUnseenExit: (note) => notes.push(note),
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /could not confirm that agy and its processes exited/);
  assert.ok(out.protocolWarnings.includes(notes[0]));
});

test("onPromptSent does not fire for a delegation whose model is rejected", async () => {
  let sent = 0;
  await assert.rejects(runDelegate({
    spec: "task", model: "gemini-4-neon-high", workspace: process.cwd(),
    clientFactory: modelOptionsFactory(undefined, { calls: [] }),
    onPromptSent: () => { sent++; },
  }), (err) => err.reason === "unknown-model");
  assert.equal(sent, 0);
});

test("runDelegate skips the model round-trip when the session already runs that model", async () => {
  const calls = [];
  const out = await runDelegate({ spec: "task", model: "gemini-4-neon", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) });
  assert.deepEqual(calls.filter((c) => c[0] === "config"), []);
  assert.equal(out.effectiveModel, undefined);
  assert.deepEqual(out.effectiveEffort, { thought_level: "high" });
});

test("runDelegate switches model through the model config option", async () => {
  const calls = [];
  const out = await runDelegate({ spec: "task", model: "gemini-3.8-flash", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) });
  assert.deepEqual(calls.filter((c) => c[0] === "config"), [["config", "model", "gemini-3.8-flash"]]);
  assert.equal(out.effectiveModel, undefined, "silence means the request was honored");
});

test("runDelegate reports the session's model as effectiveModel when model is omitted", async () => {
  const calls = [];
  const out = await runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) });
  assert.deepEqual(calls.filter((c) => c[0] === "config"), []);
  assert.equal(out.effectiveModel, "gemini-4-neon");
});

test("runDelegate sends effort as thought_level and reports what agy echoes", async () => {
  const calls = [];
  const out = await runDelegate({ spec: "task", model: "gemini-3.8-flash", effort: "low", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) });
  assert.deepEqual(calls.filter((c) => c[0] === "config"), [["config", "model", "gemini-3.8-flash"], ["config", "thought_level", "low"]]);
  assert.deepEqual(out.effectiveEffort, { thought_level: "low" });
});

// Sonnet 5.5 on agy 1.5.13 offers no xhigh. The level is checked against the list the model
// switch echoed, so the refusal comes from the bridge before agy or a prompt is involved.
test("runDelegate rejects an effort the selected model does not offer, before prompting", async () => {
  const calls = [];
  await assert.rejects(
    runDelegate({ spec: "task", model: "claude-sonnet-5-5", effort: "xhigh", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) }),
    (err) => {
      assert.equal(err.reason, "invalid-effort");
      assert.match(err.message, /Accepted: \["low","medium","high"\]/);
      return true;
    }
  );
  assert.ok(!calls.some((c) => c[0] === "prompt"));
  assert.ok(!calls.some((c) => c[1] === "thought_level"));
});

test("runDelegate sends no thinking level when effort is omitted", async () => {
  const calls = [];
  await runDelegate({ spec: "task", model: "gemini-3.8-flash", workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) });
  assert.ok(!calls.some((c) => c[1] === "thought_level"));
});

test("runDelegate skips model validation when the session reports no model option", async () => {
  const out = await runDelegate({ spec: "task", model: "anything", workspace: process.cwd(), clientFactory: () => stubClient("sess-bare") });
  assert.equal(out.sessionId, "sess-bare");
});

for (const [mode, agyMode] of [["agent", "default"], ["plan", "plan"], ["ask", "default"]]) {
  test(`mode ${mode} sets agy mode ${agyMode}`, async () => {
    const calls = [];
    await runDelegate({ spec: "the task", mode, workspace: process.cwd(), clientFactory: modelOptionsFactory(undefined, { calls }) });
    assert.deepEqual(calls.find((c) => c[0] === "mode"), ["mode", agyMode]);
    const prompt = calls.find((c) => c[0] === "prompt")[1];
    if (mode === "ask") {
      assert.match(prompt, /^Answer the question below\. Do not edit files/);
      assert.ok(prompt.endsWith("\n\nthe task"));
    } else {
      assert.equal(prompt, "the task");
    }
  });
}

test("an unknown mode is refused before anything is spawned", async () => {
  let made = 0;
  await assert.rejects(
    runDelegate({ spec: "task", mode: "review", workspace: process.cwd(), clientFactory: () => { made++; return stubClient(); } }),
    (err) => { assert.equal(err.reason, "invalid-mode"); return true; }
  );
  assert.equal(made, 0);
});

// Resume against the fake agy: a known id reopens at agy's defaults (issue #1460), so the bridge
// has to send the requested model, effort and mode again.
test("runDelegate resumes a known session and re-applies model, effort and mode", async () => {
  const sent = [];
  const factory = () => {
    const client = fakeFactory();
    for (const name of ["setConfigOption", "setMode"]) {
      const orig = client[name].bind(client);
      client[name] = async (...args) => { sent.push([name, ...args.slice(1)]); return orig(...args); };
    }
    return client;
  };
  const out = await runDelegate({
    spec: "continue", mode: "plan", resumeSessionId: "known-old", model: "gemini-3.8-flash", effort: "low",
    workspace: process.cwd(), clientFactory: factory,
  });
  assert.equal(out.sessionId, "known-old");
  assert.equal(out.resumed, true);
  assert.deepEqual(sent, [
    ["setConfigOption", "model", "gemini-3.8-flash"],
    ["setConfigOption", "thought_level", "low"],
    ["setMode", "plan"],
  ]);
  assert.deepEqual(out.effectiveEffort, { thought_level: "low" });
});

test("runDelegate starts fresh, with a warning, when agy has no such session", async () => {
  const out = await runDelegate({ spec: "task", resumeSessionId: "gone", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.sessionId, "sess-1");
  assert.equal(out.resumed, undefined);
  assert.ok(out.protocolWarnings.some((w) => w === "resuming gone failed, started a fresh session: agy has no session gone"));
});

// agy answers a missing id and a failed read with the same -32603, so the bridge checks the list:
// a session agy still has is never silently replaced by a fresh one.
for (const [label, listSessions] of [
  ["agy still lists the session", async () => ({ sessions: [{ sessionId: "old-id" }] })],
  ["the session list cannot be read", async () => { throw rpcError(-32603, "list failed"); }],
]) {
  test(`runDelegate fails rather than starting fresh when ${label}`, async () => {
    let newSessions = 0;
    const factory = () => {
      const client = stubClient("sess-fresh");
      client.newSession = async () => { newSessions++; return { sessionId: "sess-fresh" }; };
      client.resumeSession = async () => { throw Object.assign(rpcError(-32603, "Failed to read session old-id; retry, or load it with session/load"), { method: "session/resume" }); };
      client.listSessions = listSessions;
      return client;
    };
    await assert.rejects(
      () => runDelegate({ spec: "task", resumeSessionId: "old-id", workspace: process.cwd(), clientFactory: factory }),
      (err) => {
        assert.equal(err.reason, "resume-failed");
        assert.ok(err.message.includes("Failed to read session old-id; retry, or load it with session/load (session/resume JSON-RPC -32603)."), err.message);
        return true;
      }
    );
    assert.equal(newSessions, 0, "a failed resume must not silently spend a fresh session");
  });
}

// Anything the session sends while it opens belongs to an earlier turn or to setup. Only frames
// inside the prompt feed the result and the reported files.
test("frames sent while the session opens stay out of the result and reported files", async () => {
  const client = stubClient("known");
  client.resumeSession = async () => {
    client.emit("update", { update: { sessionUpdate: "user_message_chunk", content: { text: "earlier request" } } });
    client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "old", title: "Edit", kind: "edit", status: "completed",
      content: [{ type: "diff", path: "from-a-previous-turn.txt" }] } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "stale result text" } } });
    return {};
  };
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "fresh answer" } } });
    return { stopReason: "end_turn" };
  };
  const out = await runDelegate({ spec: "task", resumeSessionId: "known", workspace: process.cwd(), clientFactory: () => client });
  assert.equal(out.result, "fresh answer");
  assert.equal(out.filesReportedByEditTools, undefined);
});

// A tool_call frame that arrives already completed carries its diff on the tool_call itself.
test("a diff on a completed tool_call frame is reported", async () => {
  const client = stubClient("sess-done");
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", title: "File a.txt", status: "completed",
      content: [{ type: "diff", path: path.join(process.cwd(), "a.txt") }] } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } });
    return { stopReason: "end_turn" };
  };
  const out = await runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: () => client });
  assert.deepEqual(out.filesReportedByEditTools, ["a.txt"]);
});

// agy 1.5.14 moves a shell command to the background once it outlasts the call's WaitMsBeforeAsync
// (a wait agy picks per command; about 12 s for this ping) and ends the turn:
// the execute tool_call never reaches a terminal status, and agy's only message arrives while it
// counts as running. Measured live (docs/captures/scenarios.jsonl, backgrounded-command): the
// bridge returned result "" with a warning that agy sent no message at all.
test("a turn that ends while a tool is still running returns agy's message about it", async () => {
  const out = await replayResult([
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "ping -n 113 127.0.0.1", kind: "execute", status: "in_progress" },
    msgChunk("Running `ping -n 113 127.0.0.1` in the background; waiting for it to finish."),
  ]);
  assert.equal(out.result, "Running `ping -n 113 127.0.0.1` in the background; waiting for it to finish.");
  assert.equal(out.resultSource, "unfinished-tool");
  assert.ok(out.protocolWarnings.some((w) => /still running \(ping -n 113 127\.0\.0\.1\)/.test(w)), JSON.stringify(out.protocolWarnings));
  assert.ok(!out.protocolWarnings.some((w) => /without emitting any message/.test(w)));
});

test("a tool left running with no message still names the tool instead of reporting silence", async () => {
  const out = await replayResult([
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "npm run build", kind: "execute", status: "in_progress" },
  ]);
  assert.equal(out.result, "");
  assert.equal(out.resultSource, "none");
  assert.ok(out.protocolWarnings.some((w) => /still running \(npm run build\)/.test(w)), JSON.stringify(out.protocolWarnings));
});

test("text sent while a tool ran is dropped once the tool finishes and a final message follows", async () => {
  const out = await replayResult([
    toolCall("t1", "in_progress"),
    msgChunk("Still working."),
    toolUpdate("t1", "completed"),
    msgChunk("Done."),
  ]);
  assert.equal(out.result, "Done.");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

// The same unfinished-call shape, captured live once through the bridge: agy put its clarifying
// question to ask_question and ended the turn waiting for the answer.
test("a question agy leaves open through ask_question comes back as the result", async () => {
  const question = "Which variable would you like to rename, and what should its new name be?\n- [1] Rename 'x' in a.js\n- [2] Rename 'y' in b.js";
  const out = await replayResult([
    { sessionUpdate: "tool_call", toolCallId: "q1", title: "Run ask_question", kind: "other", status: "in_progress" },
    msgChunk(question),
  ]);
  assert.equal(out.result, question);
  assert.equal(out.resultSource, "unfinished-tool");
  assert.ok(out.protocolWarnings.some((w) => /still running \(Run ask_question\)/.test(w) && /a resume answers/.test(w)));
});

test("runDelegate starts the agent in the workspace, not the server's directory", async () => {
  const seen = [];
  const workspace = mkdtempSync(path.join(tmpdir(), "delegate-cwd-"));
  await runDelegate({
    spec: "do the thing", mode: "agent", workspace,
    clientFactory: (opts) => { seen.push(opts); return replayFactory([msgChunk("ok")])(); },
  });
  assert.equal(seen[0]?.cwd, workspace);
});

// A signed-out agy answers session/new with ACP's auth error, captured live on a fresh WSL install:
// {"code":-32000,"message":"Authentication required"}. It read as a generic agent-error with no
// way forward.
test("a signed-out agy fails as not-signed-in with the sign-in step", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "say hi", mode: "agent", workspace: process.cwd(),
      clientFactory: () => {
        const client = stubClient();
        client.newSession = async () => {
          throw Object.assign(new Error("Authentication required"), { code: -32000 });
        };
        return client;
      },
    }),
    (err) => {
      assert.equal(err.reason, "not-signed-in");
      assert.match(err.message, /Authentication required/);
      assert.match(err.message, /run agy once in a terminal and sign in/);
      return true;
    },
  );
});

// The continuation agy runs by itself once a backgrounded command finishes, as measured live
// (agy 1.5.14, probe A): end_turn with the run_command unfinished, then tool_call_update completed,
// the closing message and a usage_update — all after the prompt has already returned.
function backgroundFactory({ completeAfterMs, continuation = ["Minimum = 0ms, Maximum = 0ms, Average = 0ms"], contextAfter }) {
  return () => {
    const client = stubClient("sess-bg");
    const emit = (update) => client.emit("update", { update });
    client.prompt = async () => {
      emit({ sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", title: "ping -n 25 127.0.0.1", kind: "execute", status: "in_progress" });
      emit(msgChunk("The command has been launched and is running. I am waiting for it to finish."));
      emit({ sessionUpdate: "usage_update" });
      if (completeAfterMs !== undefined) {
        setTimeout(() => {
          emit({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
          for (const text of continuation) emit(msgChunk(text));
          emit({ sessionUpdate: "usage_update", ...contextAfter });
        }, completeAfterMs);
      }
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

test("a backgrounded command is waited for, and agy's continuation is the result", async () => {
  const out = await runDelegate({
    spec: "run it", mode: "agent", workspace: process.cwd(),
    clientFactory: backgroundFactory({ completeAfterMs: 150 }),
    backgroundWaitMs: 5000, backgroundSettleMs: 50, backgroundContinueMs: 2000,
  });
  assert.equal(out.result, "Minimum = 0ms, Maximum = 0ms, Average = 0ms");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

// The prompt reply's usage is settled before the continuation runs, so only context sees it.
test("context reflects agy's continuation after a backgrounded command", async () => {
  const out = await runDelegate({
    spec: "run it", mode: "agent", workspace: process.cwd(),
    clientFactory: backgroundFactory({ completeAfterMs: 100, contextAfter: { used: 900, size: 1000 } }),
    backgroundWaitMs: 5000, backgroundSettleMs: 50, backgroundContinueMs: 2000,
  });
  assert.deepEqual(out.context, { used: 900, size: 1000 });
});

test("a backgrounded command that outlasts the wait comes back as unfinished-tool, naming the wait", async () => {
  const started = Date.now();
  const out = await runDelegate({
    spec: "start the dev server", mode: "agent", workspace: process.cwd(),
    clientFactory: backgroundFactory({}),
    backgroundWaitMs: 200, backgroundSettleMs: 20, backgroundContinueMs: 2000,
  });
  assert.ok(Date.now() - started < 2000);
  assert.equal(out.resultSource, "unfinished-tool");
  assert.match(out.result, /launched and is running/);
  assert.ok(out.protocolWarnings.some((w) => /still running after the bridge waited/.test(w) && /AGY_DELEGATE_BACKGROUND_WAIT_MS/.test(w)), JSON.stringify(out.protocolWarnings));
});

test("an open ask_question is returned at once, not waited for", async () => {
  const started = Date.now();
  const out = await runDelegate({
    spec: "rename it", mode: "agent", workspace: process.cwd(),
    clientFactory: replayFactory([
      { sessionUpdate: "tool_call", toolCallId: "q1", name: "ask_question", title: "Run ask_question", status: "in_progress" },
      msgChunk("Which variable?"),
    ]),
    backgroundWaitMs: 5000, backgroundSettleMs: 20, backgroundContinueMs: 5000,
  });
  assert.ok(Date.now() - started < 1000, "an ask_question must not hold the delegation");
  assert.equal(out.result, "Which variable?");
  assert.equal(out.resultSource, "unfinished-tool");
});

// Steering, as agy 1.5.14 did it: a second session/prompt settles the first at once with end_turn,
// and the redirected turn ends with the second prompt's reply.
async function steerWhenOpen(getClient, sessionId, text) {
  for (let i = 0; i < 200; i++) {
    const client = getClient();
    if (client?.steer(sessionId, text) === "steered") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("the delegation never accepted a steer");
}

test("a steered delegation returns the redirected turn, not the end_turn the steer forced", async () => {
  let client;
  let steered;
  const out = await runDelegate({
    spec: "STEERABLE task", workspace: process.cwd(),
    clientFactory: () => (client = fakeFactory()),
    onSessionReady: (sid) => { steered = steerWhenOpen(() => client, sid, "go left"); },
  });
  await steered;
  assert.equal(out.result, "STEERED: go left");
  assert.equal(out.resultSource, undefined);
  assert.deepEqual(out.usage, { scope: "turn", inputTokens: 12, totalTokens: 12 }, "both replies' usage is summed");
  assert.deepEqual(out.context, { used: 40, size: 1048576 });
});

test("a steer agy rejects leaves the turn's own result, with the rejection in protocolWarnings", async () => {
  let client;
  let steered;
  const out = await runDelegate({
    spec: "STEERABLE task", workspace: process.cwd(),
    clientFactory: () => (client = fakeFactory()),
    onSessionReady: (sid) => { steered = steerWhenOpen(() => client, sid, "REJECT this"); },
  });
  await steered;
  assert.equal(out.result, "held finished");
  assert.deepEqual(out.usage, { scope: "turn", inputTokens: 5, totalTokens: 5 });
  assert.ok(out.protocolWarnings?.some((w) => /steer was rejected/.test(w) && /steer rejected/.test(w)), JSON.stringify(out.protocolWarnings));
});

test("in ask mode a steer carries the same read-only instruction as the prompt", async () => {
  let client;
  let steered;
  const prev = process.env.AGY_DELEGATE_TRANSCRIPT;
  process.env.AGY_DELEGATE_TRANSCRIPT = "50";
  try {
    await runDelegate({
      spec: "STEERABLE question", mode: "ask", workspace: process.cwd(),
      clientFactory: () => (client = fakeFactory()),
      onSessionReady: (sid) => { steered = steerWhenOpen(() => client, sid, "look at b.js instead"); },
    });
    await steered;
  } finally {
    if (prev === undefined) delete process.env.AGY_DELEGATE_TRANSCRIPT;
    else process.env.AGY_DELEGATE_TRANSCRIPT = prev;
  }
  const texts = client.peer.getLog().filter((e) => e.dir === "out").map((e) => JSON.parse(e.line))
    .filter((f) => f.method === "session/prompt").map((f) => f.params.prompt[0].text);
  assert.equal(texts.length, 2);
  const preamble = texts[0].split("\n\n")[0];
  assert.match(preamble, /Do not edit files/);
  assert.equal(texts[1], `${preamble}\n\nlook at b.js instead`);
});

// Summed per field over whichever replies had it, a field one reply left out was a partial sum
// presented as the turn's. A reply with no usage at all (a prompt a steer settled before any
// model call finished, measured) counts nothing and does not thin out the fields.
test("summed usage keeps only fields every reply with usage reported", () => {
  assert.deepEqual(
    readUsage([{ inputTokens: 5, totalTokens: 5 }, undefined, { inputTokens: 7 }]),
    { scope: "turn", inputTokens: 12 },
  );
  assert.deepEqual(readUsage([{ inputTokens: 5, totalTokens: 5 }, {}]), { scope: "turn", inputTokens: 5, totalTokens: 5 });
  assert.equal(readUsage([undefined]), undefined);
});

// agy moves a command to the background with end_turn (measured). A refusal or an output cap
// that leaves a tool open is no such case, and waited up to AGY_DELEGATE_BACKGROUND_WAIT_MS.
test("only an end_turn with a tool still running waits for a background command", async () => {
  const started = Date.now();
  const out = await runDelegate({
    spec: "run it", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-refusal");
      client.prompt = async () => {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", title: "npm test", status: "in_progress" } });
        return { stopReason: "refusal" };
      };
      return client;
    },
    backgroundWaitMs: 5000, backgroundSettleMs: 20, backgroundContinueMs: 5000,
  });
  assert.ok(Date.now() - started < 1000, `a refusal waited ${Date.now() - started} ms`);
  assert.equal(out.stopReason, "refusal");
  // A command left open is not a question: the warning must not send the caller to answer one.
  const warning = (out.protocolWarnings ?? []).find((w) => /tool call still running/.test(w)) ?? "";
  assert.doesNotMatch(warning, /ask_question/);
  assert.match(warning, /npm test/);
});

// One bound for the delegation: a steered turn that leaves the command running resumed the wait
// with a fresh clock.
test("the background wait keeps one clock across a steered turn", async () => {
  const started = Date.now();
  let clientRef;
  await runDelegate({
    spec: "run it", mode: "agent", workspace: process.cwd(),
    clientFactory: () => {
      const client = backgroundFactory({})();
      let open = false;
      const steers = [];
      const send = client.sendTaskPrompt;
      client.sendTaskPrompt = (...args) => { open = true; return send(...args); };
      client.endTurn = () => { open = false; };
      client.hasSteer = () => steers.length > 0;
      client.takeSteer = () => steers.shift();
      client.steer = () => {
        if (!open) return "not-ready";
        // Accepted, and the command keeps running: agy ends the redirected turn with it open.
        steers.push(stampSettlement(Promise.resolve({ stopReason: "end_turn" })));
        return "steered";
      };
      clientRef = client;
      return client;
    },
    onSessionReady: () => { setTimeout(() => clientRef.steer("sess-bg", "keep going"), 400); },
    backgroundWaitMs: 700, backgroundSettleMs: 20, backgroundContinueMs: 10000,
  });
  const took = Date.now() - started;
  assert.ok(took < 1000, `the wait ran ${took} ms against a 700 ms bound`);
});

// A breakdown field (cached, thought) a reply leaves out is zero for that reply; the totals that
// the caller compares against still need every reply.
test("summed usage keeps a breakdown field one reply left out", () => {
  assert.deepEqual(
    readUsage([{ inputTokens: 1, totalTokens: 1, thoughtTokens: 3 }, { inputTokens: 2, totalTokens: 2 }]),
    { scope: "turn", inputTokens: 3, thoughtTokens: 3, totalTokens: 3 },
  );
});

test("context ignores a usage_update addressed to another session", async () => {
  const out = await runDelegate({
    spec: "task", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-own");
      client.prompt = async () => {
        client.emit("update", { sessionId: "sess-own", update: { sessionUpdate: "usage_update", used: 10, size: 100 } });
        client.emit("update", { sessionId: "sess-other", update: { sessionUpdate: "usage_update", used: 99, size: 100 } });
        client.emit("update", { sessionId: "sess-own", update: msgChunk("ok") });
        return { stopReason: "end_turn" };
      };
      return client;
    },
  });
  assert.deepEqual(out.context, { used: 10, size: 100 });
});

// stop() reports whether it saw the agent exit. Ignored, a surviving agent went unmentioned and,
// with the handle dropped, unreachable through cancel.
test("an agent that does not exit after the stop is reported", async () => {
  let stops = 0;
  const out = await runDelegate({
    spec: "task", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-stuck");
      client.prompt = async () => {
        client.emit("update", { update: msgChunk("ok") });
        return { stopReason: "end_turn" };
      };
      client.stop = async () => { stops++; return false; };
      return client;
    },
  });
  assert.equal(stops, 1, "the stop retries its own kill");
  assert.ok(out.protocolWarnings?.some((w) => /could not confirm that agy and its processes exited/.test(w)), JSON.stringify(out.protocolWarnings));
});

test("a stop that rejects is reported like one that could not confirm the exit", async () => {
  let stops = 0;
  const out = await runDelegate({
    spec: "task", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-reject");
      client.prompt = async () => {
        client.emit("update", { update: msgChunk("ok") });
        return { stopReason: "end_turn" };
      };
      client.stop = async () => { stops++; throw new Error("taskkill failed"); };
      return client;
    },
  });
  assert.equal(stops, 1);
  assert.ok(out.protocolWarnings?.some((w) => /could not confirm that agy and its processes exited/.test(w)), JSON.stringify(out.protocolWarnings));
});

// One case per note: the exit note (thrown before the session, stop sees no exit), the resume hint
// (thrown once the session is open), and the reason and sign-in note (a JSON-RPC -32000).
test("every note the bridge adds reaches the caller, whatever agy's side threw", async () => {
  const cases = [
    { at: "start", thrown: Object.freeze(new Error("boom")), exited: false, notes: ["boom", "could not confirm that agy and its processes exited"] },
    { at: "prompt", thrown: Object.freeze(new Error("boom")), notes: ["boom", "Resume with resumeSessionId sess-frozen"] },
    { at: "prompt", thrown: "a bare string", notes: ["a bare string", "Resume with resumeSessionId sess-frozen"] },
    { at: "newSession", thrown: Object.freeze(Object.assign(new Error("auth required"), { code: -32000 })), reason: "not-signed-in", code: -32000, notes: ["auth required", "agy is not signed in"] },
    { at: "newSession", thrown: Object.assign(new Error("auth required"), { code: -32000, reason: "" }), reason: "not-signed-in", code: -32000, notes: ["agy is not signed in"] },
  ];
  for (const { at, thrown, exited = true, reason, code, notes } of cases) {
    await assert.rejects(
      () => runDelegate({
        spec: "task", workspace: process.cwd(),
        clientFactory: () => {
          const client = stubClient("sess-frozen");
          client[at] = async () => { throw thrown; };
          client.stop = async () => exited;
          return client;
        },
      }),
      (err) => {
        assert.equal(err.reason, reason, `${at}: ${err?.message}`);
        assert.equal(err.code, code);
        for (const note of notes) assert.ok(err.message.includes(note), `${at}: "${note}" missing from: ${err.message}`);
        return true;
      }
    );
  }
});

// The cause said the wait had run out whenever any wait had started, so a cancel during the wait
// blamed AGY_DELEGATE_BACKGROUND_WAIT_MS.
test("a cancel during the background wait does not blame the wait's limit", async () => {
  let client;
  const out = await runDelegate({
    spec: "run it", workspace: process.cwd(),
    clientFactory: () => {
      client = stubClient("sess-bgc");
      client.prompt = async () => {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", title: "npm test", status: "in_progress" } });
        return { stopReason: "end_turn" };
      };
      return client;
    },
    onSessionReady: () => { setTimeout(() => { client.phase = "cancelled"; }, 400); },
    backgroundWaitMs: 5000, backgroundSettleMs: 20, backgroundContinueMs: 5000,
  });
  assert.equal(out.stopReason, "cancelled");
  const warning = (out.protocolWarnings ?? []).find((w) => /tool call still running/.test(w)) ?? "";
  assert.doesNotMatch(warning, /AGY_DELEGATE_BACKGROUND_WAIT_MS/);
});

// The label was the newest tool's, so a command left open beside a later ask_question was named
// as the question.
test("the unfinished-tool warning names the open command, not a later question", async () => {
  const out = await runDelegate({
    spec: "run it", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-two");
      client.prompt = async () => {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", title: "npm test", status: "in_progress" } });
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c2", name: "ask_question", title: "Ask a question", status: "pending" } });
        return { stopReason: "refusal" };
      };
      return client;
    },
  });
  const warning = (out.protocolWarnings ?? []).find((w) => /tool call still running/.test(w)) ?? "";
  assert.match(warning, /npm test/);
});

// agy's run_command title is the whole command line, here a 6 KB heredoc.
test("a long command is cut to 200 characters in the stall error and the unfinished-tool warning", async () => {
  const script = "python - <<'EOF'\n" + "print('x' * 80)\n".repeat(400) + "print('tail-marker')\nEOF";
  const openCommand = (client) => client.emit("update", {
    update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", kind: "execute", title: script, status: "in_progress" },
  });
  await assert.rejects(
    () => runDelegate({
      spec: "hang", workspace: process.cwd(), handshakeMs: 10000, hardCapMs: 300, heartbeatMs: 0,
      clientFactory: hangingFactory({ emit: openCommand }),
    }),
    (err) => {
      const label = /last tool call: (.*?)\. Resume with/s.exec(err.message)?.[1];
      assert.ok(label?.startsWith("python - <<'EOF' print("), err.message.slice(0, 300));
      assert.ok(label.length <= 200, `label is ${label.length} chars`);
      return true;
    }
  );
  const out = await runDelegate({
    spec: "run it", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-long");
      client.prompt = async () => { openCommand(client); return { stopReason: "refusal" }; };
      return client;
    },
  });
  const warning = (out.protocolWarnings ?? []).find((w) => /tool call still running/.test(w)) ?? "";
  assert.match(warning, /python - <<'EOF' print\(/);
  assert.doesNotMatch(warning, /tail-marker/);
});

// The deadline was checked before the cancel, so a cancel that landed in the wait's last tick was
// dropped: the delegation reported end_turn and blamed AGY_DELEGATE_BACKGROUND_WAIT_MS.
test("a cancel that lands as the background wait runs out still cancels", async () => {
  let client;
  const out = await runDelegate({
    spec: "run it", workspace: process.cwd(),
    clientFactory: () => {
      client = stubClient("sess-bglast");
      client.prompt = async () => {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", title: "npm test", status: "in_progress" } });
        client.phase = "cancelled";
        return { stopReason: "end_turn" };
      };
      return client;
    },
    backgroundWaitMs: 1, backgroundSettleMs: 20, backgroundContinueMs: 5000,
  });
  assert.equal(out.stopReason, "cancelled");
  const warning = (out.protocolWarnings ?? []).find((w) => /tool call still running/.test(w)) ?? "";
  assert.doesNotMatch(warning, /AGY_DELEGATE_BACKGROUND_WAIT_MS/);
});

// The progress line named the newest tool, not the command the wait is for.
test("the background wait's progress line names the backgrounded command", async () => {
  const notes = [];
  await runDelegate({
    spec: "run it", workspace: process.cwd(),
    onProgress: (m) => notes.push(m),
    clientFactory: () => {
      const client = stubClient("sess-bglabel");
      client.prompt = async () => {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", title: "npm test", status: "in_progress" } });
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "c2", name: "view_file", title: "README.md", status: "in_progress" } });
        client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed" } });
        return { stopReason: "end_turn" };
      };
      return client;
    },
    backgroundWaitMs: 50, backgroundSettleMs: 20, backgroundContinueMs: 5000,
  });
  const line = notes.find((m) => /waiting for agy's background command/.test(m)) ?? "";
  assert.match(line, /npm test/);
});
