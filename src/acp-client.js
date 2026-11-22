import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { JsonRpcPeer } from "./jsonrpc.js";
import { createRequestRouter } from "./request-router.js";
import { commandExists, resolveAcpSpawn } from "./spawn.js";
import { DETACHED, isChildAlive, treeKill } from "./proc.js";
import { VERSION } from "./version.js";
import { makeError } from "./errors.js";

const STDERR_CAP = 64 * 1024;
// How long stop() waits for the child to actually exit after the kill is dispatched. SIGKILL and
// taskkill /F land in milliseconds, so this only ever elapses when the kill did not work.
const STOP_EXIT_TIMEOUT_MS = 2000;
// How long a graceful stop gives agy to exit by itself before the kill. agy took 200–400 ms.
export const GRACEFUL_STOP_MS = 2000;

export class AcpClient extends EventEmitter {
  /**
   * @param {{
   *   spawnSpec?: { command: string, args: string[], options?: object },
   * }} [opts]
   */
  /** @param {{ spawnSpec?: any, cwd?: string }} [opts] */
  constructor({ spawnSpec, cwd } = {}) {
    super();
    this.spawnSpec = spawnSpec || resolveAcpSpawn();
    // agy treats its process directory as part of the workspace, not only the session's cwd:
    // started from the MCP server's directory it listed that directory and ran git status and
    // git diff there (measured, agy 1.5.14). Started in the workspace, there is nothing else to see.
    this.cwd = cwd;
    this._stderrChunks = [];
    this._stderrLength = 0;
    /** @type {Promise<boolean> | null} */
    this._stopping = null;
    // Sessions opened on this process, which a graceful stop closes.
    /** @type {Set<string>} */
    this._sessions = new Set();
    this._steerable = false;
    /** @type {Promise<any>[]} */
    this._steers = [];
  }

  // stderr is captured but does not count as activity: the supervisor measures ACP frames, and
  // an agent writing diagnostics is not the same fact as a turn making progress.
  // The tail of stderr, which is what an exit error quotes. Kept as chunks and joined on read:
  // rebuilding a 64KB string per chunk was the whole cost of a noisy agent. A StringDecoder
  // holds partial UTF-8 across chunk boundaries, so a multi-byte character split by the pipe
  // does not land in the error message as a replacement char.
  get stderrBuffer() {
    const joined = this._stderrChunks.join("");
    return joined.length > STDERR_CAP ? joined.slice(-STDERR_CAP) : joined;
  }

  start() {
    const { command, args, options } = this.spawnSpec;
    if (/** @type {{ shell?: boolean }} */ (options)?.shell && !commandExists(command)) {
      return Promise.reject(makeError("spawn-failed", `Failed to spawn agent (${command}): not found on PATH. Install the Antigravity CLI (agy) and sign in by running agy once.`));
    }
    this._stderrChunks = [];
    this._stderrLength = 0;
    const stderrDecoder = new StringDecoder("utf8");
    this._exitEmitted = false;
    this.child = spawn(command, args, { ...options, ...(this.cwd ? { cwd: this.cwd } : {}), detached: DETACHED, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => {
      const text = stderrDecoder.write(chunk);
      if (text) {
        this._stderrChunks.push(text);
        this._stderrLength += text.length;
        // Drop whole chunks from the front only once well past the cap, so the common case
        // costs one push. The joined tail is trimmed exactly on read.
        while (this._stderrChunks.length > 1 && this._stderrLength - this._stderrChunks[0].length >= STDERR_CAP) {
          this._stderrLength -= this._stderrChunks.shift().length;
        }
        // Whole-chunk drops leave a remainder when one pipe read is itself larger than the cap
        // (observed on GitHub Windows runners). Slice that first chunk so retained memory cannot
        // grow with the flood; the public tail is still exactly one cap on read.
        const overflow = this._stderrLength - STDERR_CAP;
        if (overflow > 0) {
          this._stderrChunks[0] = this._stderrChunks[0].slice(overflow);
          this._stderrLength -= overflow;
        }
      }
    });
    this.child.stderr.on("error", () => {});
    // A supervisor trip writes session/cancel, which can land after the agent is already gone.
    // Without a handler that surfaces as an unhandled 'error' event on some platforms, taking
    // the whole MCP server down with it. stdout needs the same guard; readline adds none.
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    const emitExit = (code, signal) => {
      if (this._exitEmitted) return;
      this._exitEmitted = true;
      // A steer to an exited agent has nowhere to go.
      this._steerable = false;
      const stderr = this.stderrBuffer;
      const err = makeError(
        "agent-exit",
        // stderr kept whole. This is the one string that says why the agent died — the model
        // that was rejected, the quota that ran out, the login that expired — and the part that
        // names it can sit anywhere in it. The 64KB ring buffer above is the bound.
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
      // The router is async and its result discarded, so a throw from its own catch would reject
      // unobserved and exit the process. Promise.resolve covers a sync router in tests.
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
        // Tagged like every other failure class so the caller gets
        // "delegate failed [spawn-failed]: ..." instead of the one untagged prose error.
        const err = makeError("spawn-failed", `Failed to spawn agent (${command}): ${e.message}. Install the Antigravity CLI (agy) and sign in by running agy once.`);
        reject(err);
      });
      this.child.once("spawn", () => resolve());
    }));
  }

  // Stashed so the unknown-model pre-flight and doctor --deep can read the agent's real
  // capability and model lists without paying for a second handshake.
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
  // appendSystemPrompt goes in _meta.antigravity.systemPrompt.append, which agy advertises at
  // initialize. agy stores it with the session: it holds across session/resume in a new process,
  // and a _meta sent on resume is ignored (measured, agy 1.5.14).
  /** @param {string} cwd @param {{ appendSystemPrompt?: string }} [opts] */
  async newSession(cwd, { appendSystemPrompt } = {}) {
    const params = { cwd, mcpServers: [] };
    if (appendSystemPrompt) params._meta = { antigravity: { systemPrompt: { append: appendSystemPrompt } } };
    const res = this._captureSession(await this.peer.request("session/new", params));
    if (typeof res?.sessionId === "string") this._sessions.add(res.sessionId);
    return res;
  }
  // resume reopens a session without replaying it. Unlike session/load, which agy answers with a
  // fresh session for an id it has never seen, resume rejects an unknown id.
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
  // agy takes a session/prompt sent while a turn runs as a redirect of that turn: the prompt in
  // flight settles at once with end_turn, and the new one settles when the redirected turn ends
  // (measured, agy 1.5.14). The delegation opens this window only while its prompt runs, so a
  // steer can neither precede the task nor land after the delegation has read its result.
  // prefix goes ahead of every steer's text, as ask mode's instruction goes ahead of the spec.
  acceptSteers(on, prefix) { this._steerable = on; this._steerPrefix = prefix; }
  steer(sessionId, text) {
    if (!this._steerable || !this.peer) return false;
    const body = this._steerPrefix ? `${this._steerPrefix}\n\n${text}` : text;
    const reply = this.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: body }] });
    // The delegation awaits it; this keeps a rejection it never reaches from going unhandled.
    reply.catch(() => {});
    this._steers.push(reply);
    return true;
  }
  hasSteer() { return this._steers.length > 0; }
  takeSteer() { return this._steers.shift(); }
  // Recorded so a delegation waiting on a backgrounded command can stop waiting: after a cancel
  // agy closes the call without the usage_update that ends a continuation.
  // A cancel also closes the steer window: a steer accepted after it restarted the cancelled turn.
  cancel(sessionId) { this.cancelRequested = true; this._steerable = false; this.peer.notify("session/cancel", { sessionId }); return Promise.resolve(); }

  getTranscript(n) { return this.peer ? this.peer.formatLog(n) : ""; }

  // Idempotent while teardown is in flight and after a confirmed exit. A missed exit is not
  // memoized — force retries with a new treeKill. A confirmed exit stays so later callers join.
  // graceMs > 0 first closes agy's sessions and its stdin and gives it that long to exit by
  // itself; the tree kill follows either way. agy exits 0 in 200–400 ms that way and closes its
  // conversation database, where a kill leaves its -shm and -wal files (measured, agy 1.5.14).
  stop({ timeoutMs = STOP_EXIT_TIMEOUT_MS, graceMs = 0 } = {}) {
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

  // session/close stops the session's background commands and subagents, which a cancel leaves
  // running (agy 1.5.10 changelog); closing stdin then ends agy. Bounded as a whole by graceMs.
  async _closeGracefully(child, graceMs) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, graceMs); });
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
    }
  }

  async _teardown(timeoutMs, graceMs = 0) {
    const child = this.child;
    if (!child?.pid) {
      try { this.peer?.close(); } catch {}
      return true;
    }
    if (graceMs > 0 && isChildAlive(child)) await this._closeGracefully(child, graceMs);
    const alive = isChildAlive(child);
    // Subscribed before the kill is dispatched. A child that dies immediately would otherwise
    // exit in the gap and leave this waiting on an event that has already fired.
    const exited = alive
      ? /** @type {Promise<boolean>} */ (new Promise((resolve) => child.once("exit", () => resolve(true))))
      : Promise.resolve(true);
    // Runs for an exited child too: the agent can be gone while the commands it spawned are still
    // running, and on POSIX they stay in its process group, which is the only handle left on them.
    treeKill(child.pid, { childAlive: alive }).catch(() => {});
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const bounded = /** @type {Promise<boolean>} */ (new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }));
    const observed = await Promise.race([exited, bounded]);
    clearTimeout(timer);
    // The exit handler rejects in-flight RPCs with stderr. Doing that here on a confirmed
    // exit would race it and the first settlement would drop the forensics. A stop that
    // did not see the child die never gets that handler, so settle those RPCs only when
    // the process is still alive and emitExit has not run.
    if (!observed && !this._exitEmitted && isChildAlive(child)) {
      try {
        this.peer?.rejectAllPending(makeError("agent-exit", "agent process did not exit after stop"));
      } catch {}
    }
    try { this.peer?.close(); } catch {}
    return observed;
  }
}
