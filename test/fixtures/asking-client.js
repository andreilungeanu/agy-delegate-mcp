// A stub agy asking as agy 1.5.14 does: the ask_question call stays pending and the turn ends. It
// takes a steer as the answer and leaves the call open. questions is the call's payload.
import { EventEmitter } from "node:events";
import { stampSettlement } from "../../src/acp-client.js";

const ASKED = [
  { is_multi_select: false, options: ["(Recommended) Rename x in a.js", "Rename x in b.js", "Rename x in both a.js and b.js"], question: "Which file's variable `x` would you like to rename?" },
  { is_multi_select: true, options: ["node b.js", "npm test"], question: "Which checks should run?" },
];

export function askingClientFactory({ questions = ASKED } = {}) {
  return () => {
    const client = new EventEmitter();
    let open = false;
    const steers = [];
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const update = (u) => client.emit("update", { sessionId: "sess-ask", update: u });
    Object.assign(client, {
      start: async () => {},
      initialize: async () => {},
      newSession: async () => ({ sessionId: "sess-ask" }),
      setMode: async () => {},
      stop: async () => true,
      prompt: async () => {
        update({ sessionUpdate: "tool_call", toolCallId: "ask1", name: "ask_question", kind: "other", status: "in_progress", title: "Run ask_question", rawInput: { questions } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "ask1", name: "ask_question", kind: "other", status: "pending", title: "Run ask_question" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Which file?" } });
        return { stopReason: "end_turn", usage };
      },
      acceptSteers: (on) => { open = on; },
      hasSteer: () => steers.length > 0,
      takeSteer: () => steers.shift(),
      steer: () => {
        if (!open) return "not-running";
        client.emit("steer");
        steers.push(stampSettlement((async () => {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Renamed as answered." } });
          return { stopReason: "end_turn", usage };
        })()));
        return "steered";
      },
    });
    return client;
  };
}
