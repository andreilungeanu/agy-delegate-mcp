import readline from "node:readline";
import { makeError } from "./errors.js";

const FRAME_CAP = 2048;
const DEFAULT_LOG_SIZE = 2000;

function readLogSize(raw) {
  if (raw === undefined) return DEFAULT_LOG_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOG_SIZE;
  return Math.floor(n);
}

// Depth for an unparseable AGY_DELEGATE_TRANSCRIPT. Not DEFAULT_LOG_SIZE: that bounds memory, this
// bounds what lands in the caller's context.
const TRANSCRIPT_DEFAULT_FRAMES = 50;

// Unset or blank is none, a number is the count; anything else ("true", "yes") is the default depth.
export function transcriptFrames(raw = process.env.AGY_DELEGATE_TRANSCRIPT) {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return TRANSCRIPT_DEFAULT_FRAMES;
  return Math.max(0, Math.floor(n));
}

export class JsonRpcPeer {
  /**
   * @param {import("node:stream").Readable} input
   * @param {import("node:stream").Writable} output
   * @param {{
   *   onNotification?: (method: string, params: any) => void,
   *   onRequest?: (id: any, method: string, params: any) => void,
   *   onActivity?: () => void,
   * }} handlers
   */
  constructor(input, output, { onNotification, onRequest, onActivity } = {}) {
    this.output = output;
    this.onNotification = onNotification || (() => {});
    this.onRequest = onRequest || (() => {});
    this.onActivity = onActivity || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    // 0 disables recording; a typo keeps the default rather than disabling it.
    this._logSize = readLogSize(process.env.ACP_LOG_SIZE);
    // Only the opt-in failure transcript reads these frames, so they are recorded only when it is on.
    this._recording = this._logSize > 0 && transcriptFrames() > 0;
    this._log = [];
    this.rl = readline.createInterface({ input });
    // readline re-emits the stream's error; unhandled, it takes down the server.
    this.rl.on("error", () => {});
    this.rl.on("line", (line) => this._onLine(line));
  }

  // Trimmed in batches once a quarter over the cap; readers take the last _logSize.
  _record(dir, line) {
    if (!this._recording) return;
    const truncated = line.length > FRAME_CAP ? line.slice(0, FRAME_CAP) : line;
    this._log.push({ t: Date.now(), dir, line: truncated });
    if (this._log.length > this._logSize + (this._logSize >> 2)) {
      this._log = this._log.slice(-this._logSize);
    }
  }

  _entries() {
    return this._log.length > this._logSize ? this._log.slice(-this._logSize) : this._log;
  }

  getLog() { return [...this._entries()]; }

  formatLog(n) {
    const entries = n !== undefined ? this._entries().slice(-n) : this._entries();
    return entries.map((e) => `${new Date(e.t).toISOString()} ${e.dir} ${e.line}`).join("\n");
  }

  _onLine(line) {
    this._record("in", line);
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
    // Only a parsed frame counts as activity, not a banner or blank line.
    this.onActivity();
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      // Keyed by string: a peer may echo the id 1 as "1".
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        // The reason can be in error.data.message; error.message may be a bare "Invalid params".
        if (msg.error) {
          p.reject(makeError(undefined, [msg.error.message || "rpc error", msg.error.data?.message].filter(Boolean).join(": "), { code: msg.error.code }));
        }
        else p.resolve(msg.result);
      }
    } else if (msg.method && hasId) {
      this.onRequest(msg.id, msg.method, msg.params);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params);
    }
  }

  _write(obj) {
    const serialized = JSON.stringify(obj) + "\n";
    this._record("out", serialized);
    this.output.write(serialized);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) { this._write({ jsonrpc: "2.0", method, params }); }
  respond(id, result) { this._write({ jsonrpc: "2.0", id, result }); }
  respondError(id, code, message) { this._write({ jsonrpc: "2.0", id, error: { code, message } }); }

  rejectAllPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  close() { this.rl.close(); }
}
