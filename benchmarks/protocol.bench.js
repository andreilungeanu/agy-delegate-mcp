import { PassThrough } from "node:stream";
import { test } from "vitest";
import { JsonRpcPeer } from "../src/jsonrpc.js";
import { makeTurnState } from "../src/turn-state.js";
import { streamedChunks, turnFrames, turnUpdates } from "./fixtures.js";

// Lines go straight to the peer's line handler: readline's own splitting is Node's cost, not ours.
const frames = turnFrames({ steps: 40 });
let notified = 0;
const peer = new JsonRpcPeer(new PassThrough(), new PassThrough(), { onNotification: () => { notified++; } });

const updates = turnUpdates({ steps: 40 });
const longAnswer = streamedChunks(4000);

test("JsonRpcPeer", async ({ bench }) => {
  await bench(`parse and dispatch a turn (${frames.length} frames)`, () => {
    for (const line of frames) peer._onLine(line);
  }).run();
});

test("turn state", async ({ bench }) => {
  await bench("stream a long answer through progress (1000 chunks)", () => {
    const state = makeTurnState({ onProgress: () => {}, progressThrottleMs: 0 });
    for (const text of longAnswer) {
      state.appendResult(text);
      state.messages.push(text);
    }
    state.messages.end();
    state.text();
  }).run();

  await bench(`track tool calls of a turn (${updates.length} updates)`, () => {
    const state = makeTurnState();
    for (const { update: up } of updates) {
      if (up.sessionUpdate === "tool_call") {
        state.recordToolCall(up, false);
        state.startTool(up.toolCallId, up.status, up.title);
      } else if (up.sessionUpdate === "tool_call_update") {
        state.recordToolCall(up, false);
        state.updateToolStatus(up.toolCallId, up.status);
      } else if (up.sessionUpdate === "agent_message_chunk" && state.collectingResult()) {
        state.appendResult(up.content.text);
      }
    }
    state.text();
  }).run();
});
