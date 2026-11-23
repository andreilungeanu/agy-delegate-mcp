import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { JsonRpcPeer } from "./jsonrpc.js";
import { createRequestRouter } from "./request-router.js";
import { resolveAcpSpawn } from "./spawn.js";
import { children, isChildAlive, spawnChild } from "./proc.js";
import { VERSION } from "./version.js";
import { makeError } from "./errors.js";

const STDERR_CAP = 64 * 1024;
// How long a graceful stop gives agy to exit by itself before the kill. agy took 200–400 ms.
export const GRACEFUL_STOP_MS = 2000;

// Settlement order of prompt replies: a refused steer settles before the turn it targets, one agy
// took over settles after it. Attached at request time, so it records when the reply came.
let settleSeq = 0;
/** @returns {Promise<{ ok: true, value: any, seq: number } | { ok: false, error: any, seq: number }>} */
export function stampSettlement(promise) {
  return promise.then((value) => ({ ok: true, value, seq: ++settleSeq }), (error) => ({ ok: false, error, seq: ++settleSeq }));
}

export class AcpClient extends EventEmitter {
  /** @param {{ spawnSpec?: any, cwd?: string, registry?: import("./proc.js").ChildRegistry }} [opts] */
  constructor({ spawnSpec, cwd, registry = children } = {}) {
    super();
    this.spawnSpec = spawnSpec || resolveAcpSpawn();
    this.registry = registry;
    /** @type {import("./proc.js").TrackedChild | null} */
    this._tracked = null;
    // agy treats its process directory as part of the workspace: started elsewhere, it ran git
    // status there (measured, agy 1.5.14).
    this.cwd = cwd;
    this._stderrChunks = [];
    this._stderrLength = 0;
    /** @type {Promise<boolean> | null} */
    this._stopping = null;
    // Sessions opened on this process, which a graceful stop closes.
    /** @type {Set<string>} */
    this._sessions = new Set();
    // setup until the prompt is on the wire, open while the turn runs, then closed for good.
    /** @type {"setup" | "open" | "closed"} */
    this._steerWindow = "setup";
    /** @type {Promise<any>[]} */
    this._steers = [];
  }

  get child() { return this._tracked?.child; }

  // The stderr tail an exit error quotes; not counted as activity. Kept as chunks and joined on
  // read, which is cheap for a noisy agent; the StringDecoder keeps split UTF-8 characters whole.
  get stderrBuffer() {
    const joined = this._stderrChunks.join("");
    return joined.length > STDERR_CAP ? joined.slice(-STDERR_CAP) : joined;
  }

  async start() {
    const { command, args, options } = this.spawnSpec;
    const tracked = spawnChild(command, args, options, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] }, this.registry);
    if (!tracked) {
      throw makeError("spawn-failed", `Failed to spawn agent (${command}): not found on PATH. Install the Antigravity CLI (agy) and sign in by running agy once.`);
    }
    this._tracked = tracked;
    this._stderrChunks = [];
    this._stderrLength = 0;
    const stderrDecoder = new StringDecoder("utf8");
    this._exitEmitted = false;
    this.child.stderr.on("data", (chunk) => {
      const text = stderrDecoder.write(chunk);
      if (text) {
        this._stderrChunks.push(text);
        this._stderrLength += text.length;
        // Whole chunks are dropped once past the cap; the tail is trimmed exactly on read.
        while (this._stderrChunks.length > 1 && this._stderrLength - this._stderrChunks[0].length >= STDERR_CAP) {
          this._stderrLength -= this._stderrChunks.shift().length;
        }
        // A single read larger than the cap (seen on GitHub Windows runners) is sliced.
        const overflow = this._stderrLength - STDERR_CAP;
        if (overflow > 0) {
          this._stderrChunks[0] = this._stderrChunks[0].slice(overflow);
          this._stderrLength -= overflow;
        }
      }
    });
    this.child.stderr.on("error", () => {});
    // A write after the agent is gone raises 'error' on stdin. readline forwards stdout's errors only
    // until it closes. Unhandled, either takes down the server.
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    const emitExit = (code, signal) => {
      if (this._exitEmitted) return;
      this._exitEmitted = true;
      // A steer to an exited agent has nowhere to go.
      this._steerWindow = "closed";
      const stderr = this.stderrBuffer;
      const err = makeError(
        "agent-exit",
        // All of the (capped) stderr: the reason the agent died can sit anywhere in it.
        `agent exited (code=${code}${signal ? ", signal=" + signal : ""})${stderr ? ": " + String(stderr) : ""}`
      );
      // exit + rejectAllPending both settle the same Promise.race; second rejection is intentional.
      this.peer?.rejectAllPending(err);
      this.emit("exit", { code, signal, stderr });
    };
    this.child.once("exit", emitExit);
    this.child.once("close", emitExit);
    this.router = null;
    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      onNotification: (method, params) => {
        if (method === "session/update") this.emit("update", params);
      },
      // Caught: an unobserved rejection would exit the process. Promise.resolve covers a sync router.
      onRequest: (id, method, params) => {
        if (this.router) Promise.resolve(this.router(id, method, params)).catch(() => {});
      },
      onActivity: () => this.emit("activity"),
    });
    this.router = createRequestRouter({
      respond: (id, r) => this.peer.respond(id, r),
      respondError: (id, c, m) => this.peer.respondError(id, c, m),
    });
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.child.once("error", (e) => {
        const err = makeError("spawn-failed", `Failed to spawn agent (${command}): ${e.message}. Install the Antigravity CLI (agy) and sign in by running agy once.`);
        reject(err);
      });
      this.child.once("spawn", () => resolve());
    }));
  }

  // Kept for the model check and doctor, without a second handshake.
  async initialize() {
    const res = await this.peer.request("initialize", { protocolVersion: 1, clientInfo: { name: "agy-delegate-mcp", version: VERSION }, clientCapabilities: {} });
    this.protocolVersion = res?.protocolVersion;
    this.agentCapabilities = res?.agentCapabilities;
    return res;
  }
  _captureSession(res) {
    this.sessionModels = res?.models;
    this.sessionModes = res?.modes;
    this.configOptions = res?.configOptions;
    // _meta.antigravity.tier names the account's plan; doctor reports it.
    this.sessionMeta = res?._meta;
    return res;
  }
  // appendSystemPrompt goes in _meta.antigravity.systemPrompt.append. agy stores it with the session
  // and ignores a _meta sent on resume (measured, agy 1.5.14).
  /** @param {string} cwd @param {{ appendSystemPrompt?: string }} [opts] */
  async newSession(cwd, { appendSystemPrompt } = {}) {
    const params = { cwd, mcpServers: [] };
    if (appendSystemPrompt) params._meta = { antigravity: { systemPrompt: { append: appendSystemPrompt } } };
    const res = this._captureSession(await this.peer.request("session/new", params));
    if (typeof res?.sessionId === "string") this._sessions.add(res.sessionId);
    return res;
  }
  // resume reopens a session without replaying it, and rejects an id agy has never seen.
  async resumeSession(sessionId, cwd) {
    const res = this._captureSession(await this.peer.request("session/resume", { sessionId, cwd, mcpServers: [] }));
    this._sessions.add(sessionId);
    return res;
  }
  // agy returns every session the account has, ignoring cwd, in one page.
  listSessions(params = {}) { return this.peer.request("session/list", params); }
  setModel(sessionId, modelId) { return this.peer.request("session/set_model", { sessionId, modelId }); }
  setConfigOption(sessionId, configId, value) { return this.peer.request("session/set_config_option", { sessionId, configId, value: String(value) }); } // configId, not optionId; ACP wants a string value
  setMode(sessionId, modeId) { return this.peer.request("session/set_mode", { sessionId, modeId }); }
  prompt(sessionId, blocks) { return this.peer.request("session/prompt", { sessionId, prompt: blocks }); }
  // agy takes a session/prompt sent mid-turn as a redirect: the prompt in flight settles at once
  // with end_turn, the new one when the redirected turn ends (measured, agy 1.5.14). The window is
  // open only while the delegation's prompt runs, and a cancel or exit closes it for good. prefix
  // goes ahead of each steer, as ask mode's instruction goes ahead of the spec.
  acceptSteers(on, prefix) {
    if (!on) { this._steerWindow = "closed"; return; }
    if (this._steerWindow === "setup" && !this.cancelRequested && !this._exitEmitted) {
      this._steerWindow = "open";
      this._steerPrefix = prefix;
    }
  }
  /** @returns {"steered" | "not-ready" | "not-running"} */
  steer(sessionId, text) {
    if (this._steerWindow === "setup") return "not-ready";
    if (this._steerWindow !== "open" || !this.peer) return "not-running";
    const body = this._steerPrefix ? `${this._steerPrefix}\n\n${text}` : text;
    // Stamped, so it never rejects unobserved.
    this._steers.push(stampSettlement(this.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: body }] })));
    this.emit("steer");
    return "steered";
  }
  hasSteer() { return this._steers.length > 0; }
  takeSteer() { return this._steers.shift(); }
  // Read by the background wait: after a cancel agy closes the call without the usage_update that
  // ends a continuation. Closes the steer window: a later steer would restart the cancelled turn.
  // delegate listens for the event to end its setup when no prompt has gone out.
  cancel(sessionId) {
    this.cancelRequested = true;
    this._steerWindow = "closed";
    this.peer.notify("session/cancel", { sessionId });
    this.emit("cancel");
    return Promise.resolve();
  }

  getTranscript(n) { return this.peer ? this.peer.formatLog(n) : ""; }

  // graceMs > 0 first closes the sessions and stdin and waits that long: agy then exits 0 in
  // 200–400 ms with its database closed, where a kill leaves -shm and -wal files (measured, agy
  // 1.5.14). A force stop ends a grace in progress.
  /** @param {{ timeoutMs?: number, graceMs?: number }} [opts] */
  stop({ timeoutMs, graceMs = 0 } = {}) {
    if (this._stopping && graceMs <= 0) this._endGrace?.();
    if (!this._stopping) {
      this._stopping = this._teardown(timeoutMs, graceMs).then((observed) => {
        if (!observed) this._stopping = null;
        return observed;
      }, (err) => {
        this._stopping = null;
        throw err;
      });
    }
    return this._stopping;
  }

  // session/close stops background commands and subagents a cancel leaves running (agy 1.5.10
  // changelog); stdin EOF then ends agy. Bounded by graceMs.
  async _closeGracefully(child, graceMs) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, graceMs);
      /** @type {(() => void) | null} */
      this._endGrace = () => resolve(undefined);
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      if (this.agentCapabilities?.sessionCapabilities?.close && this.peer) {
        const closes = [...this._sessions].map((sessionId) => this.peer.request("session/close", { sessionId }).catch(() => {}));
        await Promise.race([Promise.all(closes), deadline, exited]);
      }
      try { child.stdin.end(); } catch {}
      await Promise.race([deadline, exited]);
    } finally {
      clearTimeout(timer);
      this._endGrace = null;
    }
  }

  async _teardown(timeoutMs, graceMs = 0) {
    const tracked = this._tracked;
    if (!tracked) {
      try { this.peer?.close(); } catch {}
      return true;
    }
    const { child } = tracked;
    if (graceMs > 0 && isChildAlive(child)) await this._closeGracefully(child, graceMs);
    const observed = await tracked.stop({ timeoutMs });
    // On an exit, emitExit rejects pending RPCs with stderr; rejecting here first would lose it.
    // Only an unobserved exit settles them here.
    if (!observed && !this._exitEmitted && isChildAlive(child)) {
      try {
        this.peer?.rejectAllPending(makeError("agent-exit", "agent process did not exit after stop"));
      } catch {}
    }
    try { this.peer?.close(); } catch {}
    return observed;
  }
}
