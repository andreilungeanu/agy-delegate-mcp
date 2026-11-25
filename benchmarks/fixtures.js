// Synthetic but realistic agy turns: the session/update frames a delegation streams back, in the
// shapes agy 1.5.x sends them. Deterministic, so every benchmark run sees the same input.

const WORDS = (
  "The handler reads the config once at startup and caches it for every request. "
  + "I will split the parser so the tests can drive it without a socket! "
  + "Does the retry loop need a backoff here? It does, because the registry rate-limits bursts. "
).split(" ");

// Text streamed the way agy streams it: a few words per chunk, sentences running across chunks.
export function streamedChunks(words) {
  const chunks = [];
  for (let i = 0; i < words; i += 4) {
    chunks.push(WORDS.slice(i % WORDS.length, (i % WORDS.length) + 4).join(" ") + " ");
  }
  return chunks;
}

const textUpdate = (sessionUpdate, text) => ({ sessionUpdate, content: { type: "text", text } });

/**
 * One delegated turn: per step a burst of thinking, a tool call (edits and commands alternate),
 * its completion with a diff or an exit code, and a short message; then the final answer and the
 * closing usage_update.
 * @param {{ steps?: number, sessionId?: string }} [opts]
 */
export function turnUpdates({ steps = 40, sessionId = "bench-session" } = {}) {
  const updates = [{ sessionUpdate: "session_info_update", title: "Refactor the request parser" }];
  for (let s = 0; s < steps; s++) {
    for (const t of streamedChunks(24)) updates.push(textUpdate("agent_thought_chunk", t));
    const id = `call-${s}`;
    if (s % 2 === 0) {
      const file = `src/module-${s % 7}/file-${s}.js`;
      updates.push({ sessionUpdate: "tool_call", toolCallId: id, title: `Edit ${file}`, kind: "edit", status: "pending", locations: [{ path: `/workspace/project/${file}` }] });
      updates.push({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
      updates.push({
        sessionUpdate: "tool_call_update", toolCallId: id, status: "completed",
        content: [{ type: "diff", path: `/workspace/project/${file}`, oldText: "const a = 1;\n", newText: "const a = 2;\n" }],
      });
    } else {
      const command = `npm test -- test/module-${s % 5}.test.js`;
      updates.push({ sessionUpdate: "tool_call", toolCallId: id, title: command, kind: "execute", status: "pending", rawInput: { CommandLine: command } });
      updates.push({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { exit_code: s % 9 === 0 ? 1 : 0 } });
    }
    for (const t of streamedChunks(12)) updates.push(textUpdate("agent_message_chunk", t));
  }
  for (const t of streamedChunks(200)) updates.push(textUpdate("agent_message_chunk", t));
  updates.push({ sessionUpdate: "usage_update", used: 48213, size: 1048576 });
  return updates.map((update) => ({ sessionId, update }));
}

// The same turn as the newline-delimited JSON-RPC lines agy writes on stdout.
export function turnFrames(opts) {
  return turnUpdates(opts).map((params) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }));
}
