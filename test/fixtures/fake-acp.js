// A fake agy ACP server: newline JSON-RPC on stdin, replies on stdout. Frame shapes follow what
// agy 1.5.13 sent in docs/captures: tool calls carry name/args/rawInput, a finished edit reports
// its diff path as /C:/… on Windows, plan mode writes a plan artifact with write_file, and
// session/resume rejects an unknown id while reopening a known one at default settings.
import readline from "node:readline";
import path from "node:path";

const MODELS = {
  "gemini-4-neon": ["low", "medium", "high", "xhigh"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "claude-sonnet-5-5": ["low", "medium", "high"],
};
const MODES = ["default", "accept-edits", "auto", "plan"];
const DEFAULTS = { model: "gemini-4-neon", thought: "high", mode: "default" };
// A session agy knows from an earlier process, for resume.
// Separate ids, so tests of the bridge's per-session memory do not share one session.
const sessions = new Map([["known-old", { cwd: "" }], ["known-other", { cwd: "" }]]);
let counter = 0;
let state = { ...DEFAULTS };
let cwd = process.cwd();

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (m, result) => out({ jsonrpc: "2.0", id: m.id, result });
const fail = (m, code, message) => out({ jsonrpc: "2.0", id: m.id, error: { code, message } });
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

function configOptions() {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model,
      options: Object.keys(MODELS).map((value) => ({ value, name: value })) },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: state.thought,
      options: MODELS[state.model].map((value) => ({ value, name: value })) },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode,
      options: MODES.map((value) => ({ value, name: value })) },
  ];
}

function sessionResult(sessionId) {
  return {
    sessionId,
    models: {
      currentModelId: `${state.model}-${state.thought}`,
      availableModels: Object.entries(MODELS).flatMap(([id, levels]) => levels.map((l) => ({ modelId: `${id}-${l}`, name: `${id} (${l})` }))),
    },
    modes: { currentModeId: state.mode, availableModes: MODES.map((id) => ({ id, name: id })) },
    configOptions: configOptions(),
    _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } },
  };
}

// agy's two path spellings: args and the first locations use the native path, the finished
// frame's locations and diff path use /C:/Users/… on Windows.
const nativePath = (rel) => path.join(cwd, rel);
const reportedPath = (rel) => {
  const p = path.join(cwd, rel);
  return /^[A-Za-z]:/.test(p) ? "/" + p.replace(/\\/g, "/") : p;
};

function agentTurn(m) {
  const sid = m.params.sessionId;
  update(sid, { sessionUpdate: "session_info_update", title: "Create Hello File" });
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Creating the file." } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will create hello.txt." } });
  const args = { Path: nativePath("hello.txt"), Target: "", Replacement: "test" };
  update(sid, { sessionUpdate: "tool_call", toolCallId: "call_1", name: "edit_file", args, status: "in_progress", kind: "edit",
    title: "File hello.txt", locations: [{ path: nativePath("hello.txt") }], rawInput: args });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_1", name: "edit_file", args, status: "completed", kind: "edit",
    title: `File ${reportedPath("hello.txt")}`, locations: [{ path: reportedPath("hello.txt") }], rawInput: args, rawOutput: {},
    content: [{ type: "diff", path: reportedPath("hello.txt"), oldText: "", newText: "test" }] });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  update(sid, { sessionUpdate: "usage_update", used: 12, size: 1048576 });
  reply(m, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, totalTokens: 12 } });
}

// A turn held on a running command until a second prompt steers it, as agy 1.5.14 did: the held
// prompt settles at once with end_turn, the command fails, and the steering prompt's reply closes
// the redirected turn. A cancel settles the held prompt as cancelled.
let held = null;
function holdTurn(m) {
  held = m;
  update(m.params.sessionId, { sessionUpdate: "tool_call", toolCallId: "c-hold", name: "run_command", title: "sleep 60", kind: "execute", status: "in_progress" });
}
function steerTurn(m) {
  const sid = m.params.sessionId;
  const text = m.params.prompt?.[0]?.text ?? "";
  // A steer agy accepts (the held prompt settles at once) and that then fails, as a quota or
  // auth error would.
  if (/FAILLATER/.test(text)) {
    reply(held, { stopReason: "end_turn" });
    held = null;
    setTimeout(() => fail(m, -32603, "Internal error: quota exhausted"), 20);
    return;
  }
  // The held prompt fails on its own while the steer is queued; the steer then completes.
  if (/AFTERFAIL/.test(text)) {
    fail(held, -32603, "Internal error: first prompt failed");
    held = null;
    setTimeout(() => {
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "c-hold", status: "failed" });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STEERED after failure" } });
      reply(m, { stopReason: "end_turn" });
    }, 20);
    return;
  }
  // A steer this agent rejects: the held turn carries on and finishes by itself.
  if (/REJECT/.test(m.params.prompt?.[0]?.text ?? "")) {
    fail(m, -32602, "Invalid params: steer rejected");
    const h = held;
    held = null;
    setTimeout(() => {
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "c-hold", status: "completed" });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "held finished" } });
      reply(h, { stopReason: "end_turn", usage: { inputTokens: 5, totalTokens: 5 } });
    }, 20);
    return;
  }
  reply(held, { stopReason: "end_turn", usage: { inputTokens: 5, totalTokens: 5 } });
  held = null;
  setTimeout(() => {
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "c-hold", status: "failed" });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `STEERED: ${m.params.prompt?.[0]?.text}` } });
    update(sid, { sessionUpdate: "usage_update", used: 40, size: 1048576 });
    reply(m, { stopReason: "end_turn", usage: { inputTokens: 7, totalTokens: 7 } });
  }, 20);
}

function planTurn(m) {
  const sid = m.params.sessionId;
  const planPath = path.join(cwd, ".brain", sid, "plan_add_changelog.md");
  const args = {
    ArtifactMetadata: { RequestFeedback: true, Summary: "Add a changelog file", UserFacing: true },
    Content: "# Plan\n\n1. Create CHANGELOG.md",
    Overwrite: true,
    Path: planPath,
  };
  update(sid, { sessionUpdate: "tool_call", toolCallId: "call_plan", name: "write_file", args, status: "in_progress", kind: "edit",
    title: "File plan_add_changelog.md", locations: [{ path: planPath }], rawInput: args });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_plan", name: "write_file", args, status: "completed", kind: "edit",
    title: "File plan_add_changelog.md", locations: [{ path: planPath }], rawInput: args, rawOutput: {},
    content: [{ type: "diff", path: planPath, oldText: "", newText: args.Content }] });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plan ready" } });
  reply(m, { stopReason: "end_turn" });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  const p = m.params || {};
  switch (m.method) {
    case "initialize":
      return reply(m, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      });
    case "session/new": {
      cwd = p.cwd || cwd;
      state = { ...DEFAULTS };
      const id = `sess-${++counter}`;
      sessions.set(id, { cwd });
      return reply(m, sessionResult(id));
    }
    case "session/resume":
      if (!sessions.has(p.sessionId)) {
        return fail(m, -32603, `Failed to read session ${p.sessionId}; retry, or load it with session/load`);
      }
      cwd = p.cwd || cwd;
      // agy issue #1460: a resumed session opens at the defaults, not at its saved settings.
      state = { ...DEFAULTS };
      return reply(m, sessionResult(p.sessionId));
    case "session/list":
      return reply(m, { sessions: [...sessions.keys()].map((sessionId) => ({ sessionId, cwd: sessions.get(sessionId).cwd, title: "t", updatedAt: "2026-11-21T00:00:00Z" })) });
    case "session/set_model":
      if (!MODELS[p.modelId]) return fail(m, -32602, `Unknown model ID: ${p.modelId}`);
      state.model = p.modelId;
      if (!MODELS[state.model].includes(state.thought)) state.thought = "high";
      return reply(m, {});
    case "session/set_config_option":
      if (p.configId === "model") {
        if (!MODELS[p.value]) return fail(m, -32602, `Unknown model ID: ${p.value}`);
        state.model = p.value;
        if (!MODELS[state.model].includes(state.thought)) state.thought = "high";
      } else if (p.configId === "thought_level") {
        if (!MODELS[state.model].includes(p.value)) {
          return fail(m, -32602, `Thinking level "${p.value}" is not offered for model "${state.model}"`);
        }
        state.thought = p.value;
      } else if (p.configId === "mode") {
        if (!MODES.includes(p.value)) return fail(m, -32602, `Unknown mode: ${p.value}`);
        state.mode = p.value;
      } else {
        return fail(m, -32602, `Unknown config option: ${p.configId}`);
      }
      return reply(m, { configOptions: configOptions() });
    case "session/set_mode":
      if (!MODES.includes(p.modeId)) return fail(m, -32602, `Unknown mode: ${p.modeId}`);
      state.mode = p.modeId;
      update(p.sessionId, { sessionUpdate: "current_mode_update", currentModeId: p.modeId });
      return reply(m, {});
    case "session/prompt":
      if (!Array.isArray(p.prompt)) return fail(m, -32603, "Internal error");
      if (held) return steerTurn(m);
      if (/STEERABLE/.test(p.prompt[0]?.text ?? "")) return holdTurn(m);
      return state.mode === "plan" ? planTurn(m) : agentTurn(m);
    case "session/cancel":
      if (held) { reply(held, { stopReason: "cancelled" }); held = null; }
      return;
    case "session/close":
      return reply(m, {});
    default:
      if (m.id != null) return fail(m, -32601, `Method not found: ${m.method}`);
  }
});
