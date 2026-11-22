// Advertises session/close but never answers it, and keeps running after stdin closes: a wedged
// agent that only the kill after a graceful stop's grace can end.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });
  }
  if (m.method === "session/new") return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-wedged" } });
});
