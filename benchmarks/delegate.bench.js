import process from "node:process";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { stampSettlement } from "../src/acp-client.js";
import { runDelegate, executionSummary, readUsage } from "../src/delegate.js";
import { makeTurnState } from "../src/turn-state.js";
import { normalizeAgentReportedFiles } from "../src/agent-reported-files.js";
import { turnUpdates } from "./fixtures.js";

// An in-process agy: the session opens at once and the prompt replays a recorded turn through the
// same "update" events AcpClient emits, so the bridge's own work is all that is measured.
function replayClient(updates) {
  const client = new EventEmitter();
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId: "bench-session" });
  client.resumeSession = async () => ({ sessionId: "bench-session" });
  client.listSessions = async () => ({ sessions: [] });
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => {
    for (const u of updates) client.emit("update", u);
    return { stopReason: "end_turn", usage: { inputTokens: 41000, outputTokens: 5200, thoughtTokens: 2100, totalTokens: 48300 } };
  };
  client.sendTaskPrompt = (sid, blocks) => stampSettlement(client.prompt(sid, blocks));
  client.endTurn = () => {};
  client.getTranscript = () => "";
  client.stop = async () => true;
  return client;
}

const workspace = process.cwd();
const smallTurn = turnUpdates({ steps: 4 });
const largeTurn = turnUpdates({ steps: 60 });
const progress = [];
const onProgress = (message) => { progress.push(message); };

test("runDelegate", async ({ bench }) => {
  await bench("short turn (4 tool calls)", async () => {
    await runDelegate({ spec: "Fix the parser", workspace, clientFactory: () => replayClient(smallTurn), heartbeatMs: 0 });
  }).run();

  await bench("long turn (60 tool calls, progress on)", async () => {
    progress.length = 0;
    await runDelegate({ spec: "Fix the parser", workspace, clientFactory: () => replayClient(largeTurn), heartbeatMs: 0, onProgress, progressThrottleMs: 0 });
  }).run();
});

// The turn state that runDelegate's update handler fills, for the result-shaping benchmarks.
function recordedState(steps) {
  const state = makeTurnState();
  for (const { update: up } of turnUpdates({ steps })) {
    if (up.sessionUpdate === "tool_call" || up.sessionUpdate === "tool_call_update") {
      state.recordToolCall(up, false);
      for (const c of up.content ?? []) if (c.type === "diff") state.touched.add(c.path);
    }
  }
  return state;
}

const bigState = recordedState(200);
const touched = [...bigState.touched];
const replies = Array.from({ length: 20 }, (_, i) => ({ inputTokens: 1000 + i, outputTokens: 200 + i, cachedReadTokens: i % 3 ? 50 : undefined, totalTokens: 1200 + 2 * i }));

test("result shaping", async ({ bench }) => {
  await bench("executionSummary (200 tool calls)", () => {
    executionSummary(bigState.toolCallRecords);
  }).run();

  await bench("normalizeAgentReportedFiles (100 paths)", () => {
    normalizeAgentReportedFiles(touched, "/workspace/project");
  }).run();

  await bench("readUsage (20 replies)", () => {
    readUsage(replies);
  }).run();
});
