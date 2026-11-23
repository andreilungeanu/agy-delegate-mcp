import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { runDelegate } from "../src/delegate.js";

const DEFAULT_MODEL = "gemini-4-neon";
const DEFAULT_LEVEL = "high";
const LEVELS = { "gemini-4-neon": ["low", "medium", "high", "xhigh"], "gemini-3.8-flash": ["low", "medium", "high"] };

function agyOptions(model, level) {
  return [
    { id: "model", category: "model", currentValue: model, options: Object.keys(LEVELS).map((value) => ({ value })) },
    { id: "thought_level", category: "thought_level", currentValue: level, options: LEVELS[model].map((value) => ({ value })) },
  ];
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

// A resumed session opens at agy's defaults, as a new one does (agy #1460).
function fakeAgy({ freshId, agySessions, effortReplyOmitsModel, sent }) {
  return () => {
    const client = new EventEmitter();
    let model = DEFAULT_MODEL;
    let level = DEFAULT_LEVEL;
    const openAtDefaults = () => { model = DEFAULT_MODEL; level = DEFAULT_LEVEL; client.configOptions = agyOptions(model, level); };
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => { openAtDefaults(); agySessions.add(freshId); return { sessionId: freshId }; };
    client.resumeSession = async (id) => {
      if (!agySessions.has(id)) throw rpcError(-32603, "Internal error");
      openAtDefaults();
      return {};
    };
    client.listSessions = async () => ({ sessions: [...agySessions].map((sessionId) => ({ sessionId })) });
    client.setConfigOption = async (_sid, id, value) => {
      sent.push([id, value]);
      if (id === "model") { model = value; if (!LEVELS[model].includes(level)) level = DEFAULT_LEVEL; }
      if (id === "thought_level") level = value;
      const options = agyOptions(model, level);
      return { configOptions: effortReplyOmitsModel && id === "thought_level" ? options.filter((o) => o.id === id) : options };
    };
    client.setModel = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = async () => true;
    return client;
  };
}

function expected({ first, kind, second }) {
  const record = kind !== "takes" ? undefined
    : first.model === undefined && first.effort === undefined ? {}
    : { model: first.model ?? DEFAULT_MODEL, effort: first.effort };
  const model = second.model ?? record?.model;
  const effort = second.effort ?? (model === record?.model ? record?.effort : undefined);
  const sent = [];
  if (model !== undefined && model !== DEFAULT_MODEL) sent.push(["model", model]);
  if (effort !== undefined) sent.push(["thought_level", effort]);
  const served = model ?? DEFAULT_MODEL;
  // What the second call leaves on record for the session it ran on, which a bare resume applies.
  const kept = model !== undefined || effort !== undefined ? { model: served, effort } : {};
  const thirdSent = [];
  if (kept.model !== undefined && kept.model !== DEFAULT_MODEL) thirdSent.push(["model", kept.model]);
  if (kept.effort !== undefined) thirdSent.push(["thought_level", kept.effort]);
  return {
    sent,
    resumed: kind !== "falls-back" ? true : undefined,
    effectiveModel: served !== second.model ? served : undefined,
    effectiveEffort: { thought_level: effort ?? DEFAULT_LEVEL },
    warnsNoRecord: kind === "no-record" && second.model === undefined,
    noRecordNamesModel: true,
    warnsFellBack: kind === "falls-back",
    third: { sent: thirdSent, resumed: true, effectiveModel: kept.model ?? DEFAULT_MODEL, effectiveEffort: { thought_level: kept.effort ?? DEFAULT_LEVEL } },
  };
}

const MODELS = [undefined, "gemini-4-neon", "gemini-3.8-flash"];
const cases = [];
for (const effortReplyOmitsModel of [false, true]) {
  for (const kind of ["takes", "falls-back", "no-record"]) {
    for (const firstModel of kind === "no-record" ? [undefined] : MODELS) {
      for (const firstEffort of kind === "no-record" ? [undefined] : [undefined, "low"]) {
        for (const secondModel of MODELS) {
          for (const secondEffort of [undefined, "medium"]) {
            cases.push({ effortReplyOmitsModel, kind, first: { model: firstModel, effort: firstEffort }, second: { model: secondModel, effort: secondEffort } });
          }
        }
      }
    }
  }
}

test("a resume applies the settings the rules call for, in every combination", async () => {
  const failures = [];
  let n = 0;
  for (const c of cases) {
    const id = `sess-${process.pid}-${n++}`;
    const agySessions = new Set();
    const sent = [];
    const run = (resumeSessionId, freshId, { model, effort }) => runDelegate({
      spec: "x", workspace: process.cwd(), resumeSessionId, model, effort, heartbeatMs: 0,
      clientFactory: fakeAgy({ freshId, agySessions, effortReplyOmitsModel: c.effortReplyOmitsModel, sent }),
    });
    if (c.kind === "no-record") agySessions.add(id);
    else await run(undefined, id, c.first);
    // agy no longer has the session the bridge remembers settings for.
    if (c.kind === "falls-back") agySessions.delete(id);
    sent.length = 0;
    const out = await run(id, `${id}-fresh`, c.second);
    const secondSent = [...sent];
    sent.length = 0;
    const third = await run(out.sessionId, `${id}-third`, {});
    const want = expected(c);
    const noRecord = (out.protocolWarnings ?? []).filter((w) => /no record of the model/.test(w));
    const got = {
      sent: secondSent,
      resumed: out.resumed,
      effectiveModel: out.effectiveModel,
      effectiveEffort: out.effectiveEffort,
      warnsNoRecord: noRecord.length > 0,
      noRecordNamesModel: noRecord.every((w) => w.includes(`(${out.effectiveModel ?? c.second.model})`)),
      warnsFellBack: (out.protocolWarnings ?? []).some((w) => /failed, started a fresh session/.test(w)),
      third: { sent, resumed: third.resumed, effectiveModel: third.effectiveModel, effectiveEffort: third.effectiveEffort },
    };
    try { assert.deepEqual(got, want); } catch {
      failures.push(`${JSON.stringify(c)}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
    }
  }
  assert.equal(failures.length, 0, `${failures.length} of ${cases.length} combinations broke the rules:\n${failures.slice(0, 8).join("\n")}`);
});
