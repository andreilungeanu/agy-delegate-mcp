import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { statSync, realpathSync } from "node:fs";
// Async: a sync read on the server's only thread stalls every other in-flight delegation and
// its progress stream. The statSync calls below stay sync — they are argument validation and
// run before the spawn.
import { readFile } from "node:fs/promises";
import { AcpClient } from "./acp-client.js";
import { DEFAULT_HARD_CAP_MS, SessionSupervisor } from "./session-supervisor.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";
import { makeTurnState } from "./turn-state.js";
import { makeError } from "./errors.js";
import { effortSettings, optionsFrom, resolveEffort, allowedValues } from "./model-options.js";
import { transcriptFrames } from "./jsonrpc.js";

export const DEFAULT_HANDSHAKE_MS = 60000;
export const DEFAULT_BACKGROUND_WAIT_MS = 10 * 60 * 1000;

// The bridge's modes onto agy's. agy has no ask mode: ask runs in default with ASK_PREAMBLE
// ahead of the spec. default asks before edits and commands, which the launch flag and the
// request router both approve.
const AGY_MODE = { agent: "default", plan: "plan", ask: "default" };
const ASK_PREAMBLE = "Answer the question below. Do not edit files or run commands that change state.";
export const DEFAULT_HEARTBEAT_MS = 30000;

// Malformed values fall back to the default rather than failing the call. Only a positive value
// counts, so a blank var (Number("") is 0) cannot arm a zero-length deadline. The idle guard's
// documented 0 comes from its own fallback being 0, not from an env value.
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// A blank spec spins up a live session that only replies "No prompt content provided" —
// a billed turn for nothing. Reject it before the spawn, like a bad workspace.
function assertSpec(spec) {
  if (typeof spec === "string" && spec.trim() === "") {
    throw makeError("invalid-spec", "spec is empty. Provide a task brief.");
  }
}

// Named, never defaulted: under npx or a plugin launch the server's own cwd is a cache directory
// or the user's home, so a defaulted workspace put an auto-approved agent to work on a tree
// nobody asked about while every layer reported success. And without the existence check the
// agent's first write creates the directory, so a typo spawns a parallel empty tree. Same check
// contextFiles applies.
function assertWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.trim() === "") {
    throw makeError("invalid-workspace", "workspace is required. Name the directory the agent should work in.");
  }
  let stat;
  try {
    stat = statSync(workspace);
  } catch {
    throw makeError("invalid-workspace", `workspace ${workspace} does not exist. Create it first, or point at an existing directory.`);
  }
  if (!stat.isDirectory()) {
    throw makeError("invalid-workspace", `workspace ${workspace} is not a directory.`);
  }
}

const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};
// Base64 inflates by a third and every byte lands in the prompt, unlike a link.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A resource_link hands the agent a path, not the file's bytes, so a large brief costs prompt
// space only for what the agent opens. Images have no such form — they go inline. Both are
// measured working on agy 1.5.13, including a link outside the workspace and both together.
//   - gate images on the advertised capability: an agent that takes an unsupported block
//     without error would drop the image silently;
//   - report anything skipped — a dropped attachment is otherwise invisible.
async function buildContextBlocks(contextFiles, workspace, client, warnings) {
  const blocks = [];
  // A glob plus an explicit path can resolve to one file; sending it twice wastes prompt space.
  const seen = new Set();
  // Grouped, not one warning per file: a wrong workspace misses every attachment at once, and a
  // line each would repeat the same root N times for one root cause. The other skip reasons stay
  // per-entry — they are individually distinct and never arrive in bulk.
  const notFound = [];
  const root = path.resolve(workspace || process.cwd());
  const identKey = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const entry of contextFiles || []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.resolve(workspace || process.cwd(), entry);
    let canonical;
    try {
      canonical = realpathSync(abs);
    } catch {
      const missKey = identKey(abs);
      if (seen.has(missKey)) continue;
      seen.add(missKey);
      notFound.push(entry);
      continue;
    }
    const key = identKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = statSync(canonical);
    } catch {
      notFound.push(entry);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`contextFile ${entry} skipped: not a file`);
      continue;
    }
    const mimeType = IMAGE_MIME[path.extname(canonical).toLowerCase()];
    if (mimeType) {
      if (!client?.agentCapabilities?.promptCapabilities?.image) {
        warnings.push(`contextFile ${entry} skipped: this agent does not accept image prompts`);
        continue;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`contextFile ${entry} skipped: ${Math.round(stat.size / 1024)}KB exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB image limit`);
        continue;
      }
      try {
        blocks.push({ type: "image", mimeType, data: (await readFile(canonical)).toString("base64") });
      } catch (err) {
        warnings.push(`contextFile ${entry} skipped: could not read image (${err?.code || "read failed"})`);
      }
      continue;
    }
    blocks.push({ type: "resource_link", uri: pathToFileURL(canonical).href, name: path.basename(canonical) });
  }
  if (notFound.length) {
    warnings.push(
      `contextFile${notFound.length > 1 ? "s" : ""} skipped: ${notFound.length} not found under ${root}`
      + ` — ${notFound.join(", ")}`
    );
  }
  return blocks;
}

// agy answers session/resume for an unknown id with -32603 "Failed to read session <id>; retry,
// or load it with session/load", the same code and wording a failed read of a real session would
// carry. session/list settles it: agy lists every session the account has, so an id missing from
// it is one agy does not have. Only that justifies a fresh session; anything else runs the task
// without the context the caller asked for.
async function sessionExists(client, sessionId) {
  try {
    const listed = await client.listSessions();
    if (!Array.isArray(listed?.sessions)) return undefined;
    return listed.sessions.some((s) => s?.sessionId === sessionId);
  } catch {
    return undefined;
  }
}

async function openSession(client, resumeSessionId, workspace) {
  if (!resumeSessionId) return client.newSession(workspace);
  try {
    await client.resumeSession(resumeSessionId, workspace);
    return { sessionId: resumeSessionId };
  } catch (err) {
    if ((await sessionExists(client, resumeSessionId)) !== false) {
      throw makeError(
        "resume-failed",
        `session ${resumeSessionId} could not be resumed: ${err?.message || String(err)}.`
        + ` The session was not resumed and no fresh session was started — retry, or omit`
        + ` resumeSessionId to start fresh deliberately.`
      );
    }
    // Starting fresh is right, but silently doing so leaves the caller unable to tell a
    // stale id from a typo'd one — keep why the resume failed.
    const fresh = await client.newSession(workspace);
    return { ...fresh, resumeError: `agy has no session ${resumeSessionId}` };
  }
}

function modelOption(configOptions) {
  return (Array.isArray(configOptions) ? configOptions : []).find((o) => o?.id === "model");
}

function configOptionValue(configOptions, id) {
  const opt = (Array.isArray(configOptions) ? configOptions : []).find((o) => o?.id === id);
  return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
}

// The model ids a session accepts are the values of its model config option: base ids such as
// gemini-4-neon, with the thinking level set separately. Reject anything else here, where the
// list can be named — agy's own -32602 "Unknown model ID" names none. An agent that reports no
// list is left alone.
function assertKnownModel(configOptions, model) {
  const ids = allowedValues(modelOption(configOptions));
  if (ids.length === 0 || ids.includes(model)) return;
  throw makeError(
    "unknown-model",
    `Unknown model ${JSON.stringify(model)}. agy offers: ${ids.join(", ")}. Set the thinking level with effort, not a model id suffix.`
  );
}

// Sent only when the exact value appears under a thought-level option the selected model
// advertised. Local validation keeps a bad token out of ACP and, more importantly, out of a
// billed prompt. Missing capability data is not mislabeled as a caller mistake.
async function applyEffort(client, sessionId, model, value, modelOptions) {
  const resolved = resolveEffort(modelOptions, value);
  if (resolved.status === "unavailable") {
    throw makeError(
      "effort-options-unavailable",
      `Cannot validate effort ${JSON.stringify(value)} for ${JSON.stringify(model)}:`
        + " the selected model did not report a usable effort option list."
    );
  }
  if (resolved.status === "unrecognized") {
    throw makeError(
      "invalid-effort",
      `Model ${JSON.stringify(model)} advertised no option the bridge recognizes as effort.`
        + ` Advertised: ${JSON.stringify(resolved.advertised)}.`
        + " If one of these is an effort setting, the bridge failed to recognize it — report that rather than retrying."
    );
  }
  if (resolved.status === "invalid") {
    throw makeError(
      "invalid-effort",
      `Invalid effort ${JSON.stringify(value)} for ${JSON.stringify(model)}.`
        + ` Accepted: ${JSON.stringify(resolved.accepted)}.`
    );
  }
  return client.setConfigOption(sessionId, resolved.id, resolved.value);
}

/**
 * @param {{
 *   spec?: string, mode?: string, resumeSessionId?: string, workspace?: string,
 *   model?: string, effort?: string,
 *   contextFiles?: string[], clientFactory?: (opts: any) => any,
 *   idleMs?: number, handshakeMs?: number, hardCapMs?: number, timeoutMs?: number,
 *   onClientReady?: (client: any) => void,
 *   onSessionReady?: (sessionId: string, client: any) => void,
 *   onProgress?: (message: string) => void,
 *   progressThrottleMs?: number, heartbeatMs?: number, signal?: AbortSignal,
 *   backgroundSettleMs?: number, backgroundContinueMs?: number, backgroundWaitMs?: number,
 * }} [opts]
 */
export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model, effort, contextFiles, clientFactory,
  idleMs, handshakeMs, hardCapMs, timeoutMs,
  onClientReady, onSessionReady, onProgress, progressThrottleMs = 2000,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  signal,
  // Quiet after agy's closing usage_update before its continuation counts as over, and how long
  // to wait for a continuation that never starts once every background call has finished.
  backgroundSettleMs = 2000,
  backgroundContinueMs = 60000,
  // A backgrounded command that never ends (a dev server) would otherwise hold the delegation to
  // the hard cap.
  backgroundWaitMs = envMs("AGY_DELEGATE_BACKGROUND_WAIT_MS", DEFAULT_BACKGROUND_WAIT_MS),
} = {}) {
  // Nothing between here and the abort listener below may await: addEventListener does not
  // replay an abort that already fired, so an abort landing in that window would be lost.
  // Throwing, not supervisor.abort(): tripping before supervise() installs its reject settles the
  // supervisor with nothing listening.
  if (signal?.aborted) {
    throw makeError("aborted", "delegation aborted by MCP host");
  }
  // Before the spawn: validating later costs a process, a handshake and a billed turn.
  assertWorkspace(workspace);
  assertSpec(spec);
  const agyMode = AGY_MODE[mode];
  if (!agyMode) throw makeError("invalid-mode", `mode must be agent, plan or ask; got ${JSON.stringify(mode)}.`);
  const promptText = mode === "ask" ? `${ASK_PREAMBLE}\n\n${spec}` : spec;
  const capMs = hardCapMs ?? timeoutMs ?? envMs("AGY_DELEGATE_HARD_CAP_MS", DEFAULT_HARD_CAP_MS);
  const shakeMs = handshakeMs ?? envMs("AGY_DELEGATE_HANDSHAKE_MS", DEFAULT_HANDSHAKE_MS);
  const turnIdleMs = idleMs ?? envMs("AGY_DELEGATE_IDLE_MS", 0);
  const state = makeTurnState({ onProgress, progressThrottleMs });

  const make = clientFactory || ((opts) => new AcpClient(opts));
  const client = make({ cwd: workspace });
  // Handed over before the spawn, because from client.start() there is an agent process and the
  // caller needs something that can stop it.
  onClientReady?.(client);
  const supervisor = new SessionSupervisor(client, { idleMs: turnIdleMs, handshakeMs: shakeMs, hardCapMs: capMs });
  const onAbort = () => supervisor.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  // The bridge cannot see inside a running shell command, so a long silence is reported
  // rather than acted on: the caller gets elapsed time and frame age and can decide.
  let promptInFlight = false;
  let heartbeat = null;
  const startHeartbeat = () => {
    if (!(heartbeatMs > 0)) return;
    const startedAt = Date.now();
    heartbeat = setInterval(() => {
      const parts = [
        `still working — ${fmtDuration(Date.now() - startedAt)} elapsed`,
        `last agent frame ${fmtDuration(supervisor.msSinceActivity())} ago`,
      ];
      if (state.lastToolLabel) parts.push(`running: ${state.lastToolLabel}`);
      try { onProgress?.(parts.join(", ").slice(0, 200)); } catch {}
    }, heartbeatMs);
    heartbeat.unref?.();
  };

  // Malformed frames noticed as they arrive, where protocolWarnings does not exist yet. Merged
  // into it with the rest below.
  const frameWarnings = [];

  // Diff blocks name the files an edit tool changed. agy sends them on the finished
  // tool_call_update; tool_call is read too, since a frame that arrives already finished carries
  // its content there.
  const recordDiffs = (content) => {
    // Array.isArray, not `|| []`: a non-array content is truthy and iterating it throws here, in
    // the readline callback, where nothing awaits it. That is an uncaught exception — the whole
    // server, not this one turn — and it also stops the reply after it from being read.
    for (const c of Array.isArray(content) ? content : []) {
      if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.type !== "string"
        || (c.type === "diff" && (typeof c.path !== "string" || !c.path))) {
        const warning = "malformed tool content dropped: expected content blocks with string diff paths";
        if (!frameWarnings.includes(warning)) frameWarnings.push(warning);
        continue;
      }
      if (c.type === "diff") {
        state.touched.add(c.path);
        // Named as the result names it: agy's /C:/… spelling, resolved against the workspace.
        try { onProgress?.("editing " + normalizeAgentReportedFiles([c.path], workspace)[0]); } catch {}
      }
    }
  };

  // Only frames inside the prompt are read, so nothing the session sends while it opens is
  // folded into this turn.
  client.on("update", (u) => {
    if (!promptInFlight) return;
    const up = u?.update || {};
    state.lastFrameAt = Date.now();
    state.usageAfterActivity = up.sessionUpdate === "usage_update";
    // The agent titles the turn a beat after the prompt lands — useful live, when several
    // delegations run, and in timeout forensics. Kept out of the result.
    if (up.sessionUpdate === "session_info_update" && typeof up.title === "string" && up.title) {
      if (up.title !== state.sessionTitle) { try { onProgress?.(`turn titled: ${up.title}`.slice(0, 200)); } catch {} }
      state.sessionTitle = up.title;
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      state.thoughts.push(up.content.text);
    }
    if (up.sessionUpdate === "tool_call" || up.sessionUpdate === "tool_call_update") {
      // An artifact is agy's own file (the plan, under its brain directory), reported as an
      // artifact rather than as a workspace edit.
      const isArtifact = state.recordArtifact(up.rawInput ?? up.args);
      if (up.sessionUpdate === "tool_call") {
        state.startTool(up.toolCallId, up.status, up.name ?? up.title);
        const label = String(up.title || up.kind || "tool");
        const path = up.locations?.[0]?.path;
        // Collapsed onto one line the way both readers of this take it: a progress notification
        // and the "last tool call" line in a stall error. A command title arrives verbatim, so a
        // multi-line script arrives with its newlines.
        // agy's titles already name the file, with forward slashes where the location has
        // backslashes, so the path is appended only when the title does not carry it.
        const slashed = (s) => String(s).replace(/\\/g, "/");
        const named = path && slashed(label).includes(slashed(path));
        state.lastToolLabel = (label + (path && !named ? " — " + path : "")).replace(/\s+/g, " ").trim();
        try { onProgress?.(("running: " + state.lastToolLabel).slice(0, 200)); } catch {}
      } else {
        state.updateToolStatus(up.toolCallId, up.status);
      }
      if (!isArtifact) recordDiffs(up.content);
    }
    if (up.sessionUpdate === "agent_message_chunk" && up.content?.text) {
      const text = up.content.text;
      if (state.collectingResult()) state.appendResult(text);
      else if (state.activeToolCalls.size > 0) state.unfinishedToolText += text;
      state.messages.push(text);
    }
  });

  // agy moves a shell command to the background once it outlasts the call's WaitMsBeforeAsync and
  // ends the turn; kept alive, it finishes the command, marks the call completed and continues the
  // turn unprompted, closing with a usage_update (measured, agy 1.5.14). Stopping agy at end_turn
  // killed the command, so wait for that continuation instead. The hard cap still bounds it.
  let backgroundWaited;
  const waitForBackground = async () => {
    try { onProgress?.(`waiting for agy's background command: ${state.lastToolLabel ?? "tool"}`.slice(0, 200)); } catch {}
    const startedAt = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, Math.min(250, backgroundSettleMs)));
      backgroundWaited = Date.now() - startedAt;
      if (backgroundWaited >= backgroundWaitMs) return;
      if (client.cancelRequested) return "cancelled";
      if (state.backgroundToolCalls().length) continue;
      const quietMs = Date.now() - state.lastFrameAt;
      if (state.usageAfterActivity && quietMs >= backgroundSettleMs) return;
      // Everything finished but agy never closed a continuation: stop waiting for one.
      if (quietMs >= backgroundContinueMs) return;
    }
  };

  let sessionId;
  let resumeError;
  let servedModel;
  let effectiveEffort;
  const contextWarnings = [];
  try {
    const res = await supervisor.supervise(async () => {
      await client.start();
      await client.initialize();
      const sess = await openSession(client, resumeSessionId, workspace);
      sessionId = sess.sessionId;
      resumeError = sess.resumeError;
      supervisor.setSessionId(sessionId);
      onSessionReady?.(sessionId, client);
      // The options the session reports in force, replaced by each config reply. A resumed
      // session opens at agy's defaults rather than its saved settings (agy issue #1460,
      // reproduced on 1.5.13), so model, effort and mode are compared and re-sent every time
      // rather than assumed to have carried over.
      let options = client.configOptions;
      if (model !== undefined) {
        assertKnownModel(options, model);
        if (configOptionValue(options, "model") !== model) {
          options = optionsFrom(await client.setConfigOption(sessionId, "model", model));
        }
      }
      if (effort !== undefined) {
        const target = model ?? configOptionValue(options, "model") ?? "the session's model";
        options = optionsFrom(await applyEffort(client, sessionId, target, effort, options));
      }
      servedModel = configOptionValue(options, "model");
      // What the agent reported in force as the prompt goes out — never the requested value
      // standing in for a reply that did not confirm it.
      effectiveEffort = effortSettings(options);
      await client.setMode(sessionId, agyMode);
      state.reset();
      supervisor.promptStarted();
      startHeartbeat();
      promptInFlight = true;
      try {
        const blocks = await buildContextBlocks(contextFiles, workspace, client, contextWarnings);
        const turn = await client.prompt(sessionId, [{ type: "text", text: promptText }, ...blocks]);
        if (state.backgroundToolCalls().length && await waitForBackground() === "cancelled") {
          return { ...turn, stopReason: "cancelled" };
        }
        return turn;
      } finally {
        // The result is assembled across awaits below, so without this a frame trailing the
        // settled turn is still folded into it.
        promptInFlight = false;
      }
    });
    state.thoughts.end();
    state.messages.end();
    let result = state.text();
    const finalMessageAvailable = result.length > 0;
    let resultSource = finalMessageAvailable
      ? (state.sawToolCall ? "post-tool" : "tool-free-stream")
      : "none";
    const protocolWarnings = [];
    if (!finalMessageAvailable && state.activeToolCalls.size > 0) {
      // Two measured cases (agy 1.5.14): a backgrounded command still running when the wait for it
      // ran out, or an ask_question, which waits on the caller. The bridge stops agy when the
      // delegation returns, so a backgrounded command stops with it.
      result = state.unfinishedToolText;
      resultSource = result ? "unfinished-tool" : "none";
      const cause = backgroundWaited !== undefined && state.backgroundToolCalls().length
        ? ` agy moved it to the background, and it was still running after the bridge waited ${fmtDuration(backgroundWaited)}`
          + " (AGY_DELEGATE_BACKGROUND_WAIT_MS); it stops when the bridge stops agy."
        : " agy is asking a question (ask_question), which a resume answers.";
      protocolWarnings.push(
        `the turn ended with a tool call still running (${state.lastToolLabel ?? "unnamed tool"}).`
        + cause
        + (result ? " result is agy's message from while it ran." : " agy sent no message while it ran.")
      );
    } else if (!finalMessageAvailable && state.discardedResult) {
      result = state.discardedResult;
      resultSource = "pre-tool-fallback";
      protocolWarnings.push(
        "the agent ran a tool after its last message and never spoke again, so no final message closed the turn."
        + " result carries the last message before that tool call — it may be a preamble rather than the answer."
      );
    } else if (!finalMessageAvailable) {
      protocolWarnings.push("the agent ended the turn without emitting any message; result is empty.");
    }
    let stopReason;
    if (res?.stopReason !== undefined) {
      if (typeof res.stopReason !== "string") {
        protocolWarnings.push("stopReason dropped: ACP requires a string stop reason");
      } else if (res.stopReason !== "end_turn") {
        // end_turn carries no signal. Surface a stop reason only when something happened: a
        // refusal, a cancel, an output cap.
        stopReason = res.stopReason;
      }
    }
    const out = {
      result,
      sessionId,
    };
    // Absence means "nothing reported", not "nothing changed" — a claim this field cannot make,
    // since shell-driven edits leave no diff event.
    const filesReported = normalizeAgentReportedFiles([...state.touched], workspace);
    if (filesReported.length) out.filesReportedByEditTools = filesReported;
    // resultSource is a caveat, not a fact: on the happy path result is just the answer. Emit it
    // only when it warns. resumed likewise appears only when a resume took.
    if (resultSource !== "post-tool" && resultSource !== "tool-free-stream") out.resultSource = resultSource;
    if (!!resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
    // Present when the session ran a different model than asked, and always when model was
    // omitted: then it is the only place the caller sees which model agy used.
    if (servedModel !== undefined && servedModel !== model) out.effectiveModel = servedModel;
    if (effectiveEffort !== undefined) out.effectiveEffort = effectiveEffort;
    if (stopReason !== undefined) out.stopReason = stopReason;
    // In plan mode agy's message points at the plan rather than containing it, so the plan
    // artifact's content is the plan. Any other artifact is listed by path and summary; its
    // content stays in the file.
    const artifacts = [...state.artifacts.values()];
    const planArtifact = mode === "plan" ? artifacts.at(-1) : undefined;
    if (planArtifact) {
      out.plan = {
        path: planArtifact.path,
        ...(planArtifact.summary !== undefined ? { overview: planArtifact.summary } : {}),
        ...(planArtifact.content !== undefined ? { detail: planArtifact.content } : {}),
      };
    }
    const others = artifacts
      .filter((a) => a !== planArtifact)
      .map((a) => ({ path: a.path, ...(a.summary !== undefined ? { summary: a.summary } : {}) }));
    if (others.length) out.artifacts = others;
    if (resumeError) protocolWarnings.push(`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`);
    protocolWarnings.push(...contextWarnings);
    protocolWarnings.push(...frameWarnings);
    if (protocolWarnings.length) out.protocolWarnings = protocolWarnings;
    return out;
  } catch (err) {
    // A JSON-RPC code means the agent rejected something rather than the bridge breaking — the
    // distinction a caller needs to tell "fix your arguments" from "retry".
    // -32000 is ACP's auth_required. agy sends it from session/new when no sign-in is stored.
    if (!err?.reason && err?.code === -32000) {
      err.reason = "not-signed-in";
      err.message += ". agy is not signed in: run agy once in a terminal and sign in, then retry.";
    }
    if (!err?.reason && typeof err?.code === "number") err.reason = "agent-error";
    // A bare duration cannot distinguish a wedged agent from a slow command, so name what was
    // outstanding — it also lets a retry resume the work already done.
    const isTimeout = err?.reason === "hard-cap" || err?.reason === "idle-timeout";
    // A handshake timeout gets the forensics but not the long-command advice: no prompt was sent,
    // so no shell command explains the silence.
    const isStall = isTimeout || err?.reason === "handshake-timeout";
    if (isStall || err?.reason === "aborted" || err?.reason === "agent-exit") {
      const age = fmtDuration(supervisor.msSinceActivity());
      err.message += `\n\nLast ACP frame ${age} ago${state.lastToolLabel ? `; last tool call: ${state.lastToolLabel}` : ""}.`;
      if (state.sessionTitle) err.message += ` The agent titled this turn ${JSON.stringify(state.sessionTitle)}.`;
      const files = normalizeAgentReportedFiles([...state.touched], workspace);
      if (files.length) err.message += ` Files reported edited: ${files.join(", ")}.`;
    }
    // Every failure after the session opens leaves a live session, not just the stalls: the id is
    // set before the config calls, so unknown-model and a rejected effort land here too.
    if (resumeError) {
      // Without this the resume hint reads as "carry on from where you were", when the requested
      // session was never resumed.
      err.message += ` Note: resuming ${resumeSessionId} had already failed (${resumeError}),`
        + ` so this ran as a fresh session and none of that earlier work was in context.`;
    }
    if (sessionId) err.message += ` Resume with resumeSessionId ${sessionId}.`;
    if (isTimeout) {
      // Name the knob that actually fired: raising the hard cap does nothing for an
      // idle-timeout, whose ceiling is AGY_DELEGATE_IDLE_MS.
      const knob = err.reason === "idle-timeout" ? "AGY_DELEGATE_IDLE_MS" : "AGY_DELEGATE_HARD_CAP_MS";
      err.message += " agy does not stream shell output over ACP, so a long-running command emits"
        + ` nothing until it exits. Split the command, run it in the background and poll, or raise ${knob}.`;
    }
    // Opt-in: the frames land in the caller's context and nothing there is actionable — the
    // forensics above already carry that. Raw frames only help someone debugging the bridge.
    const frames = transcriptFrames();
    if (frames > 0) {
      try {
        const transcript = client.getTranscript?.(frames);
        if (transcript) err.message += `\n\n--- recent ACP transcript (last ${frames} frames) ---\n` + transcript;
      } catch {}
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    try { supervisor.finish(); } catch {}
    // Deliberately not awaited: stop() waits for the child to exit, and every turn — success as
    // much as failure — would pay that before returning. Nothing here reads whether it landed.
    Promise.resolve(client.stop()).catch(() => {});
  }
}
