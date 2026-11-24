import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { isChildAlive } from "../src/proc.js";
import { runDelegate } from "../src/delegate.js";
import { buildServer } from "../src/server.js";
import { mkdtemp } from "./fixtures/temp-dir.mjs";

// The same file runs on trees built on MCP SDK v1 (@modelcontextprotocol/sdk) and v2.
async function loadSdk() {
  try {
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/client"), import("@modelcontextprotocol/server"),
    ]);
    return { Client, InMemoryTransport, callTool: (client, params, options) => client.callTool(params, options) };
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    return { Client, InMemoryTransport, callTool: (client, params, options) => client.callTool(params, undefined, options) };
  }
}
const sdk = await loadSdk();

const AGY = fileURLToPath(new URL("./fixtures/scripted-agy.js", import.meta.url));
const SPEC = "Do the phase task.";
const STEER_A = "Go left instead.";
const CHATTER = "setup chatter";
const DONE = "TASK DONE";
// Read one by one before the prompt goes out, which holds the attachment phase open long enough
// for a steer or a frame to land in it.
const IMAGES = 40;
const FORCE_GRACE_MS = 1000;
const HELD_SETUP_MS = 1000;
const CLOSE_CUT_MS = 1000;

// One barrier before the session id is announced, one in setup, and the turn with its background wait.
const BARRIERS = ["session/new", "set_mode", "turn", "background"];
const BEFORE_SESSION = ["session/new"];
const SETUP = ["set_mode"];
const TURN = ["turn", "background"];
const EVENTS = ["cancel", "cancel-force", "steer", "abort", "exit"];
const CASES = [
  ...BARRIERS.flatMap((barrier) => EVENTS.map((event) => ({ barrier, event }))),
  { barrier: "turn", event: "steer", steer: "rejected" },
];

const caseName = (c) => [c.event, c.steer && `(${c.steer})`, "at", c.barrier].filter(Boolean).join(" ");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, ms) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await sleep(5);
}
const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
const textOf = (frame) => frame.params?.prompt?.[0]?.text;
const message = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const modelOption = (current) => ({
  id: "model", name: "Model", category: "model", type: "select", currentValue: current,
  options: [{ value: "model-a", name: "model-a" }, { value: "model-b", name: "model-b" }],
});
const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { close: {}, resume: {}, list: {} } },
  agentInfo: { name: "scripted-agy", version: "0" },
};

function readResult(res) {
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { error: text, reason: /^delegate failed \[([^\]]+)\]/.exec(text)?.[1] };
  return { out: JSON.parse(text) };
}

// The test's end of scripted-agy.js: every frame the bridge sent agy, in order, and a way back.
class Agy {
  static async listen() {
    const agy = new Agy();
    await new Promise((resolve) => agy.server.listen(0, "127.0.0.1", () => resolve(undefined)));
    return agy;
  }
  constructor() {
    this.received = [];
    this.alive = false;
    this.onFrame = (_frame) => {};
    this.gone = new Promise((resolve) => { this._gone = resolve; });
    this.server = net.createServer({ noDelay: true }, (socket) => {
      this.socket = socket;
      this.alive = true;
      socket.on("error", () => {});
      socket.on("close", () => { this.alive = false; this.server.close(); this._gone(); });
      // readline re-emits the socket's error, a reset when the bridge kills agy.
      readline.createInterface({ input: socket }).on("error", () => {}).on("line", (line) => {
        const frame = JSON.parse(line);
        this.received.push(frame);
        this.onFrame(frame);
      });
    });
  }
  get port() { return /** @type {net.AddressInfo} */ (this.server.address()).port; }
  send(command) { if (this.alive) this.socket.write(JSON.stringify(command) + "\n"); }
  reply(frame, result) { this.send({ jsonrpc: "2.0", id: frame.id, result }); }
  fail(frame, code, text) { this.send({ jsonrpc: "2.0", id: frame.id, error: { code, message: text } }); }
  update(sessionId, update) { this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }); }
  exit(code) { this.send({ exit: code }); }
}

let caseCount = 0;
// Cases whose chatter reached the bridge before the task prompt went out, the only ones the 5c3ba7d
// rule applies to.
let chatterChecked = 0;
async function runCase(c) {
  const baseline = timers();
  const agy = await Agy.listen();
  const sid = `sess-phases-${process.pid}-${++caseCount}`;
  const o = { received: agy.received, sid };
  let order = 0;

  let bridgeExited;
  const bridgeExit = new Promise((resolve) => { bridgeExited = resolve; });
  let serverSettled;
  const serverDone = new Promise((resolve) => { serverSettled = resolve; });
  const runInCase = (opts) => {
    const run = runDelegate({
      ...opts,
      clientFactory: ({ cwd } = {}) => {
        const env = { ...process.env, SCRIPTED_AGY_PORT: String(agy.port) };
        const bridge = new AcpClient({ cwd, spawnSpec: { command: process.execPath, args: [AGY], options: { shell: false, env } } });
        bridge.once("exit", () => bridgeExited());
        o.bridge = bridge;
        // Orders the chatter's arrival against the task prompt going out, so a frame that crossed
        // the prompt on the wire is not mistaken for one sent before it.
        bridge.on("update", (u) => { if (u?.update?.content?.text === CHATTER) o.chatterAt ??= ++order; });
        const prompt = bridge.prompt.bind(bridge);
        bridge.prompt = (...args) => { o.promptAt ??= ++order; return prompt(...args); };
        return bridge;
      },
      heartbeatMs: 0, handshakeMs: 15000,
      backgroundSettleMs: 50, backgroundContinueMs: 5000, backgroundWaitMs: 10000,
    });
    run.then((value) => ({ value }), (error) => ({ error })).then((outcome) => {
      // Read as the delegation returns: agy's socket closes a moment after its process exits.
      o.agyExitedAtReturn = !isChildAlive(o.bridge?.child);
      o.server = outcome;
      o.serverSettledAt = Date.now();
      serverSettled();
    });
    return run;
  };

  const mcp = buildServer({ runDelegate: runInCase, forceGraceMs: FORCE_GRACE_MS });
  const [serverTransport, clientTransport] = sdk.InMemoryTransport.createLinkedPair();
  const host = new sdk.Client({ name: "phases-host", version: "1" });
  await Promise.all([mcp.connect(serverTransport), host.connect(clientTransport)]);
  const status = async (name, args) => JSON.parse((await sdk.callTool(host, { name, arguments: args })).content[0].text).status;

  const abort = new AbortController();
  const progress = [];
  const hostDone = sdk.callTool(
    host,
    { name: "delegate", arguments: { spec: SPEC, workspace, model: "model-b", contextFiles } },
    { signal: abort.signal, timeout: 30000, onprogress: (p) => progress.push(String(p.message ?? "")) },
  ).then(readResult, (error) => ({ rejected: String(error?.message ?? error) }));
  hostDone.then((result) => { o.result = result; });

  let eventStarted = false;
  let eventSettled = Promise.resolve();
  const unanswered = new Set();
  let task;
  const steers = [];
  let backgroundOpen = false;
  const answer = (frame, result) => { if (unanswered.delete(frame)) agy.reply(frame, result); };
  const answerError = (frame, code, text) => { if (unanswered.delete(frame)) agy.fail(frame, code, text); };
  const later = (fn) => setTimeout(fn, 10);

  // Fires the case's event, then probes with a steer. release() lets agy answer the request it
  // holds; the first call wins.
  async function fire(release) {
    o.eventAt = Date.now();
    // agy acts on what the bridge sent before it carries on with the turn.
    const arrived = (match) => until(() => agy.received.some(match), 1000);
    const steer = async (text) => {
      const result = await status("steer", { sessionId: sid, message: text });
      if (result === "steered") await arrived((f) => f.method === "session/prompt" && textOf(f) === text);
      return result;
    };
    const probe = async () => { o.probe = await status("steer", { sessionId: sid, message: STEER_A }); };
    if (c.event === "cancel" || c.event === "cancel-force") {
      o.cancel = await status("cancel", { sessionId: sid, force: c.event === "cancel-force" });
      await probe();
      if (o.cancel === "cancelled") await arrived((f) => f.method === "session/cancel");
      if (c.event === "cancel" && SETUP.includes(c.barrier)) o.endedWithSetupHeld = await within(hostDone, HELD_SETUP_MS);
    } else if (c.event === "steer") {
      o.steerFirst = o.steerLast = await steer(STEER_A);
      o.steerTries = 1;
      // A host told not-ready retries, while agy answers the setup call it held.
      if (o.steerFirst === "not-ready") release("reply");
      const end = Date.now() + 3000;
      while (o.steerLast === "not-ready" && !o.result && Date.now() < end) {
        await new Promise((resolve) => setImmediate(resolve));
        o.steerLast = await steer(STEER_A);
        o.steerTries++;
      }
    } else if (c.event === "abort") {
      abort.abort();
      await within(serverDone, 5000);
      await probe();
    } else {
      agy.exit(1);
      await within(bridgeExit, 5000);
      await probe();
    }
    release("reply");
  }

  // At the case's barrier, fires its event; resolves to how agy answers the request it holds.
  function gate(phase) {
    if (phase !== c.barrier) return Promise.resolve("reply");
    eventStarted = true;
    return new Promise((release) => { eventSettled = fire(release); });
  }

  async function held(phase, frame, result) {
    await gate(phase);
    agy.reply(frame, result);
  }

  async function onTask(frame) {
    task = frame;
    unanswered.add(frame);
    if (!agy.alive) return;
    agy.update(sid, message("Working. "));
    if (c.barrier === "background") return backgroundTurn(frame);
    await gate("turn");
    if (eventStarted) await eventSettled;
    if (!unanswered.has(frame)) return;
    agy.update(sid, message(DONE));
    answer(frame, { stopReason: "end_turn" });
  }

  async function backgroundTurn(frame) {
    backgroundOpen = true;
    agy.update(sid, { sessionUpdate: "tool_call", toolCallId: "bg", title: "npm run build", kind: "execute", status: "in_progress" });
    answer(frame, { stopReason: "end_turn" });
    await until(() => progress.some((m) => m.startsWith("waiting for agy's background command")), 5000);
    await gate("background");
    if (eventStarted) await eventSettled;
    if (!backgroundOpen) return;
    backgroundOpen = false;
    agy.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "completed" });
    agy.update(sid, message("Build finished."));
    agy.update(sid, { sessionUpdate: "usage_update", used: 10, size: 1000 });
  }

  // agy settles the prompt a steer redirects at once with end_turn, and answers the steer when the
  // redirected turn ends.
  function onSteer(frame) {
    unanswered.add(frame);
    steers.push(frame);
    const redirect = () => { for (const p of [task, ...steers.slice(0, -1)]) if (p) answer(p, { stopReason: "end_turn" }); };
    const finish = () => {
      if (!unanswered.has(frame)) return;
      if (backgroundOpen) {
        backgroundOpen = false;
        agy.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "failed" });
      }
      agy.update(sid, message(`STEERED: ${textOf(frame)}`));
      answer(frame, { stopReason: "end_turn" });
    };
    if (c.steer === "rejected") return answerError(frame, -32602, "Invalid params: steer rejected");
    redirect();
    later(finish);
  }

  function onCancel() {
    for (const frame of [...unanswered]) answer(frame, { stopReason: "cancelled" });
    if (backgroundOpen) {
      backgroundOpen = false;
      agy.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "cancelled" });
    }
  }

  agy.onFrame = (frame) => {
    switch (frame.method) {
      case "initialize": return agy.reply(frame, INITIALIZE);
      case "session/new": return held("session/new", frame, { sessionId: sid, configOptions: [modelOption("model-a")] });
      case "session/set_config_option": return agy.reply(frame, { configOptions: [modelOption(frame.params.value)] });
      case "session/set_mode":
        return held("set_mode", frame, {}).then(() => {
          // Lands while the bridge reads the attachments, before the task prompt is out.
          setTimeout(() => agy.update(sid, message(CHATTER)), 2);
        });
      case "session/prompt": return textOf(frame) === SPEC ? onTask(frame) : onSteer(frame);
      case "session/cancel": return onCancel();
      case "session/close": return agy.reply(frame, {});
      default: if (frame.id !== undefined) agy.fail(frame, -32601, `Method not found: ${frame.method}`);
    }
  };

  await hostDone;
  await eventSettled;
  await within(serverDone, 10000);
  o.settledMs = o.serverSettledAt - o.eventAt;
  o.agyExited = await within(agy.gone, 5000);
  if (!o.agyExited) { agy.exit(1); await within(agy.gone, 2000); }
  o.announced = progress.includes(`session ready: ${sid}`);
  o.cancelAfter = await status("cancel", { sessionId: sid, force: false });
  o.steerAfter = await status("steer", { sessionId: sid, message: STEER_A });
  await host.close();
  // The background wait polls every 50 ms and ends on its next poll once the delegation is decided.
  await until(() => timers() <= baseline, 1000);
  o.leftoverTimers = timers() - baseline;
  return o;
}

// Each rule names the fix that last restored it.
function violations(c, o) {
  const v = [];
  const rule = (holds, text) => { if (!holds) v.push(text); };
  const show = JSON.stringify;
  const prompts = o.received.filter((f) => f.method === "session/prompt").map(textOf);
  const cancelAt = o.received.findIndex((f) => f.method === "session/cancel");
  const afterCancel = cancelAt < 0 ? [] : o.received.slice(cancelAt + 1).filter((f) => f.method === "session/prompt").map(textOf);
  const { out, reason } = o.result;
  const result = out?.result ?? "";
  const warnings = out?.protocolWarnings ?? [];
  const got = out
    ? show({ result: out.result, stopReason: out.stopReason, resultSource: out.resultSource, cancelRequested: out.cancelRequested })
    : show(o.result).slice(0, 300);
  const registered = !BEFORE_SESSION.includes(c.barrier);
  const finishedTask = () => result.includes(DONE) && out.stopReason === undefined && out.cancelRequested === undefined;

  rule(prompts.length === 0 || prompts[0] === SPEC, `agy receives the task prompt before any steer (9a73be1); agy got prompts ${show(prompts)}`);
  rule(!afterCancel.includes(SPEC), "agy receives no task prompt after a cancel during setup (be92164)");
  rule(afterCancel.every((text) => text === SPEC), `agy receives no steer after a cancel (6afbf10); after session/cancel agy got ${show(afterCancel)}`);
  if (o.chatterAt !== undefined && !(o.promptAt < o.chatterAt)) {
    chatterChecked++;
    rule(!result.includes(CHATTER), `a frame agy sent while attachments were read stays out of the result (5c3ba7d); result ${show(result)}`);
  }
  rule(o.agyExitedAtReturn, "agy has exited by the time the delegation returns (ed7de7b)");
  rule(o.leftoverTimers <= 0, `the delegation leaves no timer running once it has returned (cea5ca0); ${o.leftoverTimers} left 1 s after`);
  const afterReturn = o.announced ? "not-running" : "not-found";
  // A session agy opened after the call returned registers a turn nothing will end.
  rule(o.cancelAfter === afterReturn && o.steerAfter === afterReturn,
    `cancel and steer report ${afterReturn} once the delegate call has returned (ed7de7b); got ${o.cancelAfter}, ${o.steerAfter}`);
  const cancels = o.received.filter((f) => f.method === "session/cancel");
  rule(cancels.every((f) => f.id === undefined && f.params?.sessionId === o.sid),
    `a cancel reaches agy as a session/cancel notification naming the session (40ac9a4); agy got ${show(cancels)}`);

  if (c.event === "cancel" || c.event === "cancel-force") {
    if (!registered) {
      rule(o.cancel === "not-found", `cancel before the session id is announced reports not-found (40ac9a4); got ${o.cancel}`);
      rule(cancelAt < 0 && finishedTask(), `a cancel for an id not yet announced leaves the delegation running (40ac9a4); got ${got}`);
    } else if (SETUP.includes(c.barrier)) {
      // A force cancel ends in a kill when the held setup call keeps the delegation from settling.
      rule(o.cancel === "cancelled", `cancel during setup reports cancelled (${c.event === "cancel-force" ? "719fb8a" : "40ac9a4"}); got ${o.cancel}`);
      if (o.endedWithSetupHeld !== undefined) {
        rule(o.endedWithSetupHeld, `a cancel before the prompt ends setup at once, with agy's ${c.barrier} reply still held (719fb8a)`);
      }
      rule(out?.stopReason === "cancelled", `a cancel before the prompt returns stopReason cancelled (be92164); got ${got}`);
      rule(out?.result === "" && out?.resultSource === "none", `a setup-cancelled delegation returns an empty result with resultSource none (d712105); got ${got}`);
      rule(out && !out.protocolWarnings && !out.filesReportedByEditTools,
        `a setup-cancelled delegation reports no warnings and no files (be92164); got ${show(out?.protocolWarnings)} ${show(out?.filesReportedByEditTools)}`);
    } else {
      rule(o.cancel === "cancelled", `cancel while the turn runs reports cancelled (${c.event === "cancel-force" ? "fd89088" : "40ac9a4"}); got ${o.cancel}`);
      rule(cancelAt >= 0, "a cancel while the turn runs reaches agy as session/cancel (40ac9a4)");
      rule(out?.stopReason === "cancelled" && out.cancelRequested === true,
        `a cancelled turn returns stopReason cancelled and cancelRequested, with no steer to restart it (6afbf10); got ${got}`);
      if (c.barrier === "background" && c.event === "cancel") {
        rule(o.settledMs < CLOSE_CUT_MS, `a cancel ends the background wait at once (564816e); the delegation returned ${o.settledMs} ms after it`);
      }
    }
  }

  if (c.event === "steer") {
    const steeredResult = (text) => result.includes(`STEERED: ${text}`) && out.stopReason === undefined && out.resultSource === undefined;
    if (!registered) {
      rule(o.steerFirst === "not-found", `steer before the session id is announced reports not-found (50b41a3); got ${o.steerFirst}`);
      rule(prompts.length === 1 && finishedTask(), `a steer for an id not yet announced leaves the delegation running (50b41a3); got ${got}`);
    } else if (SETUP.includes(c.barrier)) {
      rule(o.steerFirst === "not-ready", `steer before the task prompt is out reports not-ready (afbf039); got ${o.steerFirst}`);
      rule(o.steerLast === "steered", `a host retrying a not-ready steer gets steered once the task prompt is out (9a73be1); got ${o.steerLast} after ${o.steerTries} tries`);
      rule(out && steeredResult(STEER_A), `the steered turn's reply is the result (50b41a3); got ${got}`);
    } else {
      rule(o.steerFirst === "steered", `steer while the turn runs reports steered (9a73be1); got ${o.steerFirst}`);
      if (c.barrier === "background") {
        rule(o.settledMs < CLOSE_CUT_MS, `a steer ends the background wait at once (50b41a3); the delegation returned ${o.settledMs} ms after it`);
      }
      if (c.steer === "rejected") {
        rule(finishedTask() && warnings.some((w) => /steer was rejected/.test(w)),
          `a steer agy rejects leaves the turn's own result and reports the rejection (6b23413); got ${got} ${show(warnings)}`);
      } else {
        rule(out && steeredResult(STEER_A), `the steered turn's reply is the result (50b41a3); got ${got}`);
      }
    }
  }

  if (c.event === "abort") {
    rule(o.server?.error?.reason === "aborted", `an abort fails the delegation as aborted (40ac9a4); got ${show(o.server).slice(0, 300)}`);
    if (!TURN.includes(c.barrier)) {
      rule(prompts.length === 0, `agy receives no task prompt after an abort during setup (40ac9a4); agy got prompts ${show(prompts)}`);
    }
  }

  if (c.event === "exit") rule(reason === "agent-exit", `agy exiting fails the delegation as agent-exit (e0ed965); got ${got}`);

  if (c.event !== "steer") {
    const expected = registered ? "not-running" : "not-found";
    const closedBy = { cancel: "6afbf10", "cancel-force": "6afbf10", exit: "cea5ca0", abort: "6afbf10" }[c.event];
    rule(o.probe !== "steered", `no steer is accepted after ${c.event} (${closedBy}); a steer after it reported steered`);
    rule(o.probe === expected, `a steer after ${c.event} reports ${expected} (afbf039); got ${o.probe}`);
  }
  return v;
}

const workspace = await mkdtemp(path.join(tmpdir(), "agy-phases-"));
const contextFiles = Array.from({ length: IMAGES }, (_, i) => {
  writeFileSync(path.join(workspace, `shot-${i}.png`), Buffer.alloc(64, i));
  return `shot-${i}.png`;
});

test("every host event in every phase of a delegation keeps the delegation's rules", async (t) => {
  const started = Date.now();
  for (const c of CASES) {
    await t.test(caseName(c), async () => {
      const found = violations(c, await runCase(c));
      if (found.length) assert.fail(found.join("\n"));
    });
  }
  t.diagnostic(`${CASES.length} cases in ${Date.now() - started} ms, ${chatterChecked} with agy's chatter before the prompt`);
  assert.ok(chatterChecked > 0, "no case had agy's chatter arrive before the task prompt, so the 5c3ba7d rule never ran");
});
