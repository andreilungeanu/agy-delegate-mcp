import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { statSync, realpathSync } from "node:fs";
// Async: a sync read on the server's one thread stalls every other delegation. The statSync calls
// below are pre-spawn argument validation and stay sync.
import { readFile } from "node:fs/promises";
import { AcpClient, GRACEFUL_STOP_MS, stampSettlement } from "./acp-client.js";
import { DEFAULT_HARD_CAP_MS, SessionSupervisor } from "./session-supervisor.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";
import { makeTurnState } from "./turn-state.js";
import { makeError } from "./errors.js";
import { effortSettings, optionsFrom, resolveEffort, allowedValues } from "./model-options.js";
import { transcriptFrames } from "./jsonrpc.js";

export const DEFAULT_HANDSHAKE_MS = 60000;

// Model and effort last set on each session by this process. agy reopens a resumed session at its
// defaults (agy #1460, measured on 1.5.14), so a resume that omits them re-applies these. LRU,
// bounded like seenSessions in server.js; a restarted server starts empty.
const sessionSettings = new Map();
const SESSION_SETTINGS_CAP = 500;
function rememberSettings(id, settings) {
  sessionSettings.delete(id);
  sessionSettings.set(id, settings);
  if (sessionSettings.size > SESSION_SETTINGS_CAP) sessionSettings.delete(sessionSettings.keys().next().value);
}

export const DEFAULT_BACKGROUND_WAIT_MS = 10 * 60 * 1000;

// agy has no ask mode: ask runs in default with ASK_PREAMBLE ahead of the spec. default asks before
// edits and commands; the launch flag and the request router approve them.
const AGY_MODE = { agent: "default", plan: "plan", ask: "default" };
const ASK_PREAMBLE = "Answer the question below. Do not edit files or run commands that change state.";
export const DEFAULT_HEARTBEAT_MS = 30000;

// A malformed or non-positive value falls back to the default, so a blank var (Number("") is 0)
// cannot arm a zero-length deadline. The idle guard's 0 is its fallback, not an env value.
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

// A blank spec still costs a billed turn (agy replies "No prompt content provided").
function assertSpec(spec) {
  if (typeof spec === "string" && spec.trim() === "") {
    throw makeError("invalid-spec", "spec is empty. Provide a task brief.");
  }
}

// Required: under npx or a plugin the server's cwd is a cache directory or the user's home, the
// wrong tree for an auto-approved agent. Must exist: the agent's first write would create it, so a
// typo would start a parallel empty tree.
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

// A resource_link passes a path, so the agent spends prompt space only on what it opens; images
// have no link form and go inline (both measured on agy 1.5.13, links outside the workspace too).
// Images are gated on the advertised capability, since an agent may drop an unsupported block
// silently, and every skip is reported.
async function buildContextBlocks(contextFiles, workspace, client, warnings) {
  const blocks = [];
  // A glob plus an explicit path can resolve to one file; sending it twice wastes prompt space.
  const seen = new Set();
  // Grouped: a wrong workspace misses every attachment at once. Other skips are reported per entry.
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

// agy answers a resume of an unknown id and a failed read of a real one with the same -32603.
// session/list settles it: agy lists every session the account has, and only an id missing from it
// justifies a fresh session.
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
    // Kept, so the caller can tell a stale id from a mistyped one.
    const fresh = await client.newSession(workspace);
    return { ...fresh, resumeError: `agy has no session ${resumeSessionId}` };
  }
}

const isTokenCount = (v) => Number.isFinite(v) && v >= 0;

// The session/prompt reply's token counts cover that turn alone (measured, agy 1.5.14). Only ACP's
// numeric fields are kept. A steered turn has one reply per prompt; they are summed.
const USAGE_FIELDS = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"];
const BREAKDOWN_FIELDS = new Set(["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]);
export function readUsage(raws) {
  const reported = raws.filter((raw) => raw && typeof raw === "object" && USAGE_FIELDS.some((k) => isTokenCount(raw[k])));
  // The totals count only when every reply that reported usage carried them; summed from some of
  // them they would understate the turn. A breakdown field a reply left out is zero for it.
  const fields = USAGE_FIELDS.filter((k) => reported.length && (BREAKDOWN_FIELDS.has(k)
    ? reported.some((raw) => isTokenCount(raw[k]))
    : reported.every((raw) => isTokenCount(raw[k]))));
  if (!fields.length) return undefined;
  return { scope: "turn", ...Object.fromEntries(fields.map((k) => [k, reported.reduce((sum, raw) => sum + (isTokenCount(raw[k]) ? raw[k] : 0), 0)])) };
}

function modelOption(configOptions) {
  return (Array.isArray(configOptions) ? configOptions : []).find((o) => o?.id === "model");
}

function configOptionValue(configOptions, id) {
  const opt = (Array.isArray(configOptions) ? configOptions : []).find((o) => o?.id === id);
  return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
}

// The model option's values are the accepted base ids (the thinking level is set separately).
// Checked here because agy's -32602 "Unknown model ID" names none. No list, no check.
function assertKnownModel(configOptions, model) {
  const ids = allowedValues(modelOption(configOptions));
  if (ids.length === 0 || ids.includes(model)) return;
  throw makeError(
    "unknown-model",
    `Unknown model ${JSON.stringify(model)}. agy offers: ${ids.join(", ")}. Set the thinking level with effort, not a model id suffix.`
  );
}

// Sent only when the selected model advertises the exact value, so a bad one never reaches a billed
// prompt. Missing capability data is reported as such, not as a caller error.
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
 *   onTurnEnd?: () => void,
 *   onProgress?: (message: string) => void,
 *   progressThrottleMs?: number, heartbeatMs?: number, signal?: AbortSignal,
 *   backgroundSettleMs?: number, backgroundContinueMs?: number, backgroundWaitMs?: number,
 * }} [opts]
 */
export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model, effort, contextFiles, clientFactory,
  idleMs, handshakeMs, hardCapMs, timeoutMs,
  onClientReady, onSessionReady, onTurnEnd, onProgress, progressThrottleMs = 2000,
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
  // No await between here and the abort listener: addEventListener does not replay a past abort.
  // Thrown rather than supervisor.abort(), which before supervise() settles with nothing listening.
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
  // Handed over before the spawn, so the caller can stop the agent from client.start() on.
  onClientReady?.(client);
  const supervisor = new SessionSupervisor(client, { idleMs: turnIdleMs, handshakeMs: shakeMs, hardCapMs: capMs });
  const onAbort = () => supervisor.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  // A cancel before the prompt ends setup at once; setup checks cancelRequested between its calls.
  let promptSent = false;
  // The caller's cancel only: a supervisor trip (a deadline, an abort) cancels after settling.
  let cancelledInSetupByCaller = false;
  const onCancel = () => {
    if (promptSent || supervisor.settled) return;
    cancelledInSetupByCaller = true;
    supervisor.cancelSetup();
  };
  client.on?.("cancel", onCancel);
  const cancelledInSetup = { stopReason: "cancelled", replies: [], cancelledBeforePrompt: true };

  // The bridge cannot see inside a shell command, so silence is reported, not acted on.
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

  // Collected as frames arrive; merged into protocolWarnings at the end.
  const frameWarnings = [];
  const steerWarnings = [];

  // Diff blocks name the files an edit tool changed: agy sends them on the finished
  // tool_call_update, or on tool_call when the call arrives already finished.
  const recordDiffs = (content) => {
    // Array.isArray, not `|| []`: iterating a truthy non-array throws in the readline callback, an
    // uncaught exception that takes down the server.
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

  // Only frames inside the prompt count, not those sent while the session opens.
  client.on("update", (u) => {
    if (!promptInFlight) return;
    // One session per agy process today; the check keeps another session's frames out regardless.
    if (sessionId && typeof u?.sessionId === "string" && u.sessionId !== sessionId) return;
    const up = u?.update || {};
    state.lastFrameAt = Date.now();
    state.usageAfterActivity = up.sessionUpdate === "usage_update";
    if (up.sessionUpdate === "usage_update" && isTokenCount(up.used) && isTokenCount(up.size) && up.size > 0) {
      state.contextUsage = { used: up.used, size: up.size };
    }
    // agy titles the turn shortly after the prompt; shown live and in stall errors, not in the result.
    if (up.sessionUpdate === "session_info_update" && typeof up.title === "string" && up.title) {
      if (up.title !== state.sessionTitle) { try { onProgress?.(`turn titled: ${up.title}`.slice(0, 200)); } catch {} }
      state.sessionTitle = up.title;
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      state.thoughts.push(up.content.text);
    }
    if (up.sessionUpdate === "tool_call" || up.sessionUpdate === "tool_call_update") {
      // An artifact is agy's own file (the plan, in its brain directory), not a workspace edit.
      const isArtifact = state.recordArtifact(up.rawInput ?? up.args);
      if (up.sessionUpdate === "tool_call") {
        state.startTool(up.toolCallId, up.status, up.name ?? up.title);
        const label = String(up.title || up.kind || "tool");
        const path = up.locations?.[0]?.path;
        // One line, for the progress note and the stall error (a command title keeps its newlines).
        // agy's titles usually name the file, with forward slashes, so the path is appended only
        // when the title lacks it.
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

  // agy backgrounds a shell command that outlasts WaitMsBeforeAsync and ends the turn; kept alive, it
  // finishes the command and continues the turn unprompted, closing with a usage_update (measured,
  // agy 1.5.14). Stopping agy at end_turn would kill the command. The hard cap still bounds the wait.
  let backgroundWaited;
  // One clock per delegation, kept across steered turns.
  let backgroundStartedAt;
  const waitForBackground = async () => {
    try { onProgress?.(`waiting for agy's background command: ${state.lastToolLabel ?? "tool"}`.slice(0, 200)); } catch {}
    const startedAt = (backgroundStartedAt ??= Date.now());
    for (;;) {
      await new Promise((r) => setTimeout(r, Math.min(250, backgroundSettleMs)));
      backgroundWaited = Date.now() - startedAt;
      if (backgroundWaited >= backgroundWaitMs) return;
      // The delegation already failed (agent exit, abort, hard cap): nobody reads this wait.
      if (supervisor.settled) return;
      if (client.cancelRequested) return "cancelled";
      // A steer redirects the turn; its own prompt reply is what ends it now.
      if (client.hasSteer?.()) return;
      if (state.backgroundToolCalls().length) continue;
      const quietMs = Date.now() - state.lastFrameAt;
      if (state.usageAfterActivity && quietMs >= backgroundSettleMs) return;
      // Everything finished but agy never closed a continuation: stop waiting for one.
      if (quietMs >= backgroundContinueMs) return;
    }
  };

  let sessionId;
  let resumeError;
  let failed;
  /** @type {any} */
  let out;
  let servedModel;
  let effectiveEffort;
  let noSettingsRecord = false;
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
      // The options in force, replaced by each config reply. A resumed session opens at agy's
      // defaults (agy #1460), so model, effort and mode are compared and re-sent every time.
      let options = client.configOptions;
      if (client.cancelRequested) return cancelledInSetup;
      // Only a resume that took inherits: a fallback to a fresh session is a different session.
      const earlier = resumeSessionId && sessionId === resumeSessionId ? sessionSettings.get(sessionId) : undefined;
      // The record lives in memory: a server restarted since the session ran has none to apply.
      noSettingsRecord = !!resumeSessionId && sessionId === resumeSessionId && !earlier && model === undefined;
      const targetModel = model ?? earlier?.model;
      // A remembered effort holds only on the model it was set for: another model may not offer it.
      const targetEffort = effort ?? (targetModel === earlier?.model ? earlier?.effort : undefined);
      if (targetModel !== undefined) {
        assertKnownModel(options, targetModel);
        if (configOptionValue(options, "model") !== targetModel) {
          options = optionsFrom(await client.setConfigOption(sessionId, "model", targetModel));
        }
      }
      if (client.cancelRequested) return cancelledInSetup;
      if (targetEffort !== undefined) {
        const target = targetModel ?? configOptionValue(options, "model") ?? "the session's model";
        options = optionsFrom(await applyEffort(client, sessionId, target, targetEffort, options));
      }
      if (client.cancelRequested) return cancelledInSetup;
      servedModel = configOptionValue(options, "model");
      // Saved once agy accepted them, with the model agy reports, so an effort set on agy's default
      // is tied to that model.
      if (targetModel !== undefined || targetEffort !== undefined) rememberSettings(sessionId, { model: targetModel ?? servedModel, effort: targetEffort });
      // What agy reported in force, never the requested value.
      effectiveEffort = effortSettings(options);
      await client.setMode(sessionId, agyMode);
      if (client.cancelRequested) return cancelledInSetup;
      state.reset();
      supervisor.promptStarted();
      startHeartbeat();
      try {
        const blocks = await buildContextBlocks(contextFiles, workspace, client, contextWarnings);
        // A cancel that lands while attachments are read: the prompt is not sent.
        if (client.cancelRequested) return cancelledInSetup;
        // Raised with the prompt, so frames sent while attachments were read are not folded in.
        promptInFlight = true;
        promptSent = true;
        const first = stampSettlement(client.prompt(sessionId, [{ type: "text", text: promptText }, ...blocks]));
        // Opened once the prompt is on the wire (request writes synchronously): a steer sent first
        // makes agy read the brief as a redirect of it.
        client.acceptSteers?.(true, mode === "ask" ? ASK_PREAMBLE : undefined);
        const settled = await first;
        let turn = settled.ok ? settled.value : undefined;
        let turnError = "error" in settled ? settled.error : undefined;
        let turnSeq = settled.seq;
        const replies = settled.ok ? [turn] : [];
        // A steer settles the prompt before it at once with end_turn, so the turn ends with the
        // newest steer's reply. Each pass re-checks for a background command.
        for (;;) {
          // Only end_turn leaves a backgrounded command (measured); a refusal or output cap is not
          // waited on.
          if (turn?.stopReason === "end_turn" && !client.hasSteer?.() && state.backgroundToolCalls().length
            && await waitForBackground() === "cancelled") {
            return { ...turn, stopReason: "cancelled", replies };
          }
          const steer = client.takeSteer?.();
          if (!steer) break;
          const reply = await steer;
          if (reply.ok) {
            turn = reply.value;
            turnError = undefined;
            turnSeq = reply.seq;
            replies.push(turn);
          } else if (reply.seq < turnSeq) {
            // Refused before its target settled: that turn stands, and the warning tells the caller.
            steerWarnings.push(`a steer was rejected by agy and did not redirect the turn: ${reply.error?.message || String(reply.error)}`);
          } else {
            // Failed after taking the turn over: the turn failed, unless a steer queued behind it
            // succeeds.
            turn = undefined;
            turnError = reply.error;
            turnSeq = reply.seq;
          }
        }
        if (turnError) throw turnError;
        return { ...turn, replies };
      } finally {
        // Closed in the same tick as the last check above, so no steer lands unread.
        client.acceptSteers?.(false);
        // Cleared before the awaits below, so a frame trailing the settled turn is not folded in.
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
      // Measured cases (agy 1.5.14): a background command still running when the wait ran out, or an
      // ask_question waiting on the caller.
      result = state.unfinishedToolText;
      resultSource = result ? "unfinished-tool" : "none";
      // A refusal or output cap is not waited on, so a command can be open with no wait.
      const cause = !state.backgroundToolCalls().length
        ? " agy is asking a question (ask_question), which a resume answers."
        : backgroundWaited !== undefined
          ? ` agy moved it to the background, and it was still running after the bridge waited ${fmtDuration(backgroundWaited)}`
            + " (AGY_DELEGATE_BACKGROUND_WAIT_MS); it stops when the bridge stops agy."
          : ` agy ended the turn (${res?.stopReason}) with it still running; it stops when the bridge stops agy.`;
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
    } else if (!finalMessageAvailable && !res?.cancelledBeforePrompt) {
      protocolWarnings.push("the agent ended the turn without emitting any message; result is empty.");
    }
    let stopReason;
    if (res?.stopReason !== undefined) {
      if (typeof res.stopReason !== "string") {
        protocolWarnings.push("stopReason dropped: ACP requires a string stop reason");
      } else if (res.stopReason !== "end_turn") {
        // end_turn is the normal case; only other stop reasons are surfaced.
        stopReason = res.stopReason;
      }
    }
    out = {
      result,
      sessionId,
    };
    // Absent means nothing reported, not nothing changed: shell edits emit no diff.
    const filesReported = normalizeAgentReportedFiles([...state.touched], workspace);
    if (filesReported.length) out.filesReportedByEditTools = filesReported;
    // resultSource appears only as a caveat; resumed only when a resume took.
    if (resultSource !== "post-tool" && resultSource !== "tool-free-stream") out.resultSource = resultSource;
    if (!!resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
    // Present when the served model differs from the requested one, so always when model was omitted.
    if (servedModel !== undefined && servedModel !== model) out.effectiveModel = servedModel;
    if (effectiveEffort !== undefined) out.effectiveEffort = effectiveEffort;
    if (stopReason !== undefined) out.stopReason = stopReason;
    const usage = readUsage((res?.replies ?? [res]).map((r) => r?.usage));
    if (usage) out.usage = usage;
    if (state.contextUsage) out.context = state.contextUsage;
    // In plan mode agy's message points at the plan; the artifact's content is the plan. Other
    // artifacts are listed by path and summary.
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
    if (noSettingsRecord) {
      protocolWarnings.push(`agy reopened the session at its default model${servedModel ? ` (${servedModel})` : ""}: this server has no record of the model set earlier, as it keeps none across restarts. Pass model to choose one.`);
    }
    protocolWarnings.push(...contextWarnings);
    protocolWarnings.push(...frameWarnings);
    protocolWarnings.push(...steerWarnings);
    if (protocolWarnings.length) out.protocolWarnings = protocolWarnings;
    return out;
  } catch (err) {
    // A caller's cancel before the prompt is a cancelled result, even if a config call then failed.
    if (cancelledInSetupByCaller && sessionId) {
      out = { result: "", sessionId, resultSource: "none", stopReason: "cancelled" };
      if (resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
      if (resumeError) out.protocolWarnings = [`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`];
      return out;
    }
    failed = err;
    // A JSON-RPC code means agy rejected something (fix the arguments), not that the bridge broke
    // (retry). -32000 is ACP's auth_required, sent by agy from session/new when signed out.
    if (!err?.reason && err?.code === -32000) {
      err.reason = "not-signed-in";
      err.message += ". agy is not signed in: run agy once in a terminal and sign in, then retry.";
    }
    if (!err?.reason && typeof err?.code === "number") err.reason = "agent-error";
    // A bare duration cannot tell a wedged agent from a slow command, so name what was outstanding.
    const isTimeout = err?.reason === "hard-cap" || err?.reason === "idle-timeout";
    // A handshake timeout gets the forensics but not the long-command advice: no prompt was sent.
    const isStall = isTimeout || err?.reason === "handshake-timeout";
    if (isStall || err?.reason === "aborted" || err?.reason === "agent-exit") {
      const age = fmtDuration(supervisor.msSinceActivity());
      err.message += `\n\nLast ACP frame ${age} ago${state.lastToolLabel ? `; last tool call: ${state.lastToolLabel}` : ""}.`;
      if (state.sessionTitle) err.message += ` The agent titled this turn ${JSON.stringify(state.sessionTitle)}.`;
      const files = normalizeAgentReportedFiles([...state.touched], workspace);
      if (files.length) err.message += ` Files reported edited: ${files.join(", ")}.`;
    }
    // Any failure after the session opens leaves a live session, unknown-model and effort included.
    if (resumeError) {
      // Otherwise the resume hint reads as continuing work that was never in context.
      err.message += ` Note: resuming ${resumeSessionId} had already failed (${resumeError}),`
        + ` so this ran as a fresh session and none of that earlier work was in context.`;
    }
    if (sessionId) err.message += ` Resume with resumeSessionId ${sessionId}.`;
    if (isTimeout) {
      // Name the knob that fired: the hard cap does not govern an idle-timeout.
      const knob = err.reason === "idle-timeout" ? "AGY_DELEGATE_IDLE_MS" : "AGY_DELEGATE_HARD_CAP_MS";
      err.message += " agy does not stream shell output over ACP, so a long-running command emits"
        + ` nothing until it exits. Split the command, run it in the background and poll, or raise ${knob}.`;
    }
    // Opt-in: raw frames help only when debugging the bridge, and cost the caller context.
    const frames = transcriptFrames();
    if (frames > 0) {
      try {
        const transcript = client.getTranscript?.(frames);
        if (transcript) err.message += `\n\n--- recent ACP transcript (last ${frames} frames) ---\n` + transcript;
      } catch {}
    }
    throw err;
  } finally {
    // The turn is decided; what follows is teardown. The server stops treating a cancel as aimed
    // at a running turn.
    try { onTurnEnd?.(); } catch {}
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    client.off?.("cancel", onCancel);
    try { supervisor.finish(); } catch {}
    // Awaited, so agy has exited when the caller gets the result; otherwise agy still holds the
    // workspace as its cwd (deleting it fails with EBUSY on Windows). The handle stays registered
    // meanwhile, so force cancel and shutdown can cut the grace short. Graceful after a completed
    // turn, so agy closes its conversation database; a stall, abort or exit is killed at once.
    const killNow = signal?.aborted || ["handshake-timeout", "hard-cap", "idle-timeout", "aborted", "agent-exit"].includes(failed?.reason);
    // A host abort during the close is still an abort: a force stop ends the grace and kills.
    const abortClose = () => { Promise.resolve(client.stop()).catch(() => {}); };
    signal?.addEventListener("abort", abortClose, { once: true });
    let exited = false;
    try {
      exited = await client.stop({ graceMs: killNow ? 0 : GRACEFUL_STOP_MS });
      // A stop that did not see the exit is not memoized, so a second one dispatches a fresh kill.
      if (exited === false) exited = await client.stop();
    } catch {}
    finally { signal?.removeEventListener("abort", abortClose); }
    if (exited === false) {
      const pid = client.child?.pid;
      const note = `the bridge stopped agy${pid ? ` (pid ${pid})` : ""} but did not see agy exit; it may still be running.`;
      // The result or the error is already decided; the note rides on whichever is going out.
      if (failed) failed.message += ` Note: ${note}`;
      else if (out) (out.protocolWarnings ??= []).push(note);
    }
  }
}
