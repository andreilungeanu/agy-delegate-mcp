// Advertises session/close but never answers it, and keeps running after stdin closes: a wedged
// agent that only the kill after a graceful stop's grace can end. It completes a turn normally
// first, so a delegation reaches its teardown.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (m, result) => out({ jsonrpc: "2.0", id: m.id, result });
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") return reply(m, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });
  if (m.method === "session/new") return reply(m, { sessionId: "sess-wedged" });
  if (m.method === "session/set_mode" || m.method === "session/set_config_option") return reply(m, {});
  if (m.method === "session/prompt") {
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-wedged", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    return reply(m, { stopReason: "end_turn" });
  }
});
