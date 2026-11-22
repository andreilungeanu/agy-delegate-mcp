#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION, readPackageVersion } from "./version.js";
import { DETACHED } from "./proc.js";

const ICON_BASE = `https://raw.githubusercontent.com/andreilungeanu/agy-delegate-mcp/v${VERSION}/assets`;
/** @type {Array<{ src: string, mimeType: string, sizes: string[], theme: "light" | "dark" }>} */
const SERVER_ICONS = [
  { src: `${ICON_BASE}/logo-light.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "light" },
  { src: `${ICON_BASE}/logo-dark.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "dark" },
];

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`agy-delegate-mcp requires Node 20+ (found ${process.versions.node})`);
  process.exit(1);
}

// sessionId -> the delegations running on it. A set: a resume can race the turn it resumes, and
// with one handle per id the first to finish would deregister the other.
const inFlight = new Map();
function registerInFlight(map, sessionId, handle) {
  const handles = map.get(sessionId);
  if (handles) handles.add(handle);
  else map.set(sessionId, new Set([handle]));
}
/** @returns {import("@modelcontextprotocol/server").CallToolResult} */
function statusResult(status, sessionId) {
  return { content: [{ type: "text", text: JSON.stringify({ status, sessionId }) }] };
}
function unregisterInFlight(map, sessionId, handle) {
  const handles = map.get(sessionId);
  if (!handles) return;
  handles.delete(handle);
  if (handles.size === 0) map.delete(sessionId);
}
// Delegations whose session has not opened yet (about 3.4 s after the spawn): a live agent that
// inFlight cannot name. Shutdown walks this; cancel cannot, having no id to pass.
const pendingDelegations = new Set();

// Session ids seen by this process, kept after the turn so cancel can tell a finished session
// (still resumable) from an unknown id. Bounded.
const seenSessions = new Set();
const SEEN_SESSIONS_CAP = 500;
function rememberSession(set, id) {
  if (id == null) return;
  // Delete-then-add makes the Set an LRU, so a session still being resumed does not age out.
  if (set.has(id)) set.delete(id);
  set.add(id);
  if (set.size > SEEN_SESSIONS_CAP) set.delete(set.values().next().value);
}

// Loaded at connect: only what a caller needs to decide whether to delegate. Call-time facts go on
// the parameter descriptions.
export const SERVER_INSTRUCTIONS = `Delegate coding work to Antigravity (agy) through the delegate tool. Every permission the agent requests is auto-approved, in every mode: agent/plan/ask reach any file the user account can, and mode instructs the agent rather than limiting it. Scope workspace tightly and review the git diff after every run — filesReportedByEditTools carries only what the agent's edit tools reported; the diff is authoritative.`;

// No outputSchema: it requires structuredContent too, and a host that reads both (Codex) puts the
// payload in context twice. The .strict() copy is in delegate.test.js; field meanings are in
// skills/delegate/reference.md.
export const delegateOutputShape = {
  result: z.string(),
  resultSource: z.enum(["pre-tool-fallback", "unfinished-tool", "none"]).optional(),
  effectiveModel: z.string().optional(),
  effectiveEffort: z.record(z.string(), z.string()).optional(),
  stopReason: z.string().optional(),
  usage: z.object({
    scope: z.literal("turn"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedReadTokens: z.number().optional(),
    cachedWriteTokens: z.number().optional(),
    thoughtTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).strict().optional(),
  context: z.object({ used: z.number(), size: z.number() }).strict().optional(),
  sessionId: z.string(),
  filesReportedByEditTools: z.array(z.string()).optional(),
  resumed: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  protocolWarnings: z.array(z.string()).optional(),
  plan: z.object({
    path: z.string(),
    overview: z.string().optional(),
    detail: z.string().optional(),
  }).optional(),
  artifacts: z.array(z.object({
    path: z.string(),
    summary: z.string().optional(),
  })).optional(),
};

// Same in-repo contract; the strict copy is in doctor.test.js. Relayed agent fields stay unknown,
// so an odd value is a diagnostic, not a failed call. Its own shape because .strict() on agent
// does not look inside it.
export const doctorHandshakeShape = {
  ok: z.boolean(),
  error: z.string().optional(),
  protocolVersion: z.unknown().optional(),
  agentCapabilities: z.unknown().optional(),
  models: z.array(z.unknown()).optional(),
  currentModel: z.unknown().optional(),
  modes: z.array(z.unknown()).optional(),
  tier: z.unknown().optional(),
  // Built here, not relayed, so it gets a real type.
  currentModelOptions: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    values: z.array(z.string()),
    currentValue: z.string().optional(),
  })).optional(),
};

export const doctorAgentShape = {
  found: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
  handshake: z.object(doctorHandshakeShape).passthrough().optional(),
};

// agent is split out because a top-level .strict() does not look inside a nested object.
export const doctorOutputShape = {
  plugin: z.object({ version: z.string() }).passthrough(),
  client: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    capabilities: z.record(z.string(), z.unknown()),
    protocolVersion: z.string().optional(),
  }).passthrough(),
  agent: z.object(doctorAgentShape).passthrough(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    cwd: z.string(),
    transport: z.literal("stdio"),
  }),
  env: z.record(z.string(), z.unknown()),
};

export const delegateInputSchema = z.object({
  spec: z.string().trim().min(1, "spec must not be blank").describe("Task brief: goal, scope, fixed decisions quoted exactly, acceptance criteria. Sent as written. Point at files to read rather than pasting code, or attach them with contextFiles."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("agent implements; plan writes a plan, returned as plan; ask answers. plan and ask are instructions to the agent, not limits."),
  resumeSessionId: z.string().trim().optional().describe("Continue an existing agy session."),
  workspace: z.string().trim().min(1, "workspace must not be blank").describe("The agent's working directory, not a limit. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call."),
  model: z.string().trim().min(1, "model must be a non-empty string").optional().describe("agy base model id, no level suffix: gemini-4-neon, gemini-3.8-flash. Omitted, agy's default runs (a resume keeps the model last set on the session) and effectiveModel names it. doctor deep:true lists every id."),
  // Open string: a model's levels are known only once it is selected, and are validated then.
  effort: z.string().trim().min(1).optional().describe("agy thinking level for the selected model (low, medium, high, xhigh). Levels differ per model; invalid values fail before the prompt and name the accepted set. Pass only when the user asks for agy effort — the host's own reasoning setting is unrelated."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting contents into spec. Text becomes references the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against workspace but are not limited to it. Skips are reported in protocolWarnings, never fatal."),
});

// Steers every turn running on the id, as cancel does: the caller named a session.
export function steerSession(map, seen, sessionId, message) {
  const handles = map.get(sessionId);
  if (!handles || handles.size === 0) return seen.has(sessionId) ? "not-running" : "not-found";
  const statuses = new Set();
  for (const handle of handles) {
    // A turn that has ended is only tearing down, whatever state its window was left in.
    if (handle.ended) { statuses.add("not-running"); continue; }
    try { statuses.add(handle.client.steer?.(sessionId, message) ?? "not-running"); } catch { statuses.add("not-running"); }
  }
  for (const status of ["steered", "not-ready"]) if (statuses.has(status)) return status;
  return "not-running";
}

/**
 * @param {{
 *   args: any, ctx?: any,
 *   runDelegate: (opts: any) => Promise<any>,
 *   inFlight: Map<string, Set<any>>,
 *   pending?: Set<any>,
 *   seenSessions?: Set<string>,
 * }} deps
 * @returns {Promise<import("@modelcontextprotocol/server").CallToolResult>}
 */
export async function runDelegateTool({ args, ctx, runDelegate, inFlight, pending = new Set(), seenSessions = new Set() }) {
  const { spec, mode, resumeSessionId, workspace, model, effort, contextFiles } = args;

  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  /** @type {(message: string) => void} */
  let onProgress = () => {};
  if (progressToken != null) {
    let progress = 0;
    onProgress = (message) => {
      // An unhandled rejection would exit the server; the try catches a sync throw.
      try {
        Promise.resolve(ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress, message },
        })).catch(() => {});
      } catch {}
    };
  }

  let capturedSessionId;
  let handle;
  try {
    const out = await runDelegate({
      spec,
      mode,
      // Blank is no resume: hosts fill optional fields with "".
      resumeSessionId: resumeSessionId || undefined,
      workspace,
      model,
      effort,
      contextFiles,
      onProgress,
      signal: ctx?.mcpReq?.signal,
      onClientReady: (client) => {
        handle = { client, cancelRequested: false };
        pending.add(handle);
      },
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        // The same handle moves across, so a racing shutdown finds it on one side.
        handle ??= { client, cancelRequested: false };
        pending.delete(handle);
        registerInFlight(inFlight, sessionId, handle);
        rememberSession(seenSessions, sessionId);
        // Sent as the session opens, so a host that calls tools concurrently can cancel or steer
        // mid-run.
        onProgress(`session ready: ${sessionId}`);
      },
      onTurnEnd: () => { if (handle) handle.ended = true; },
    });
    if (handle?.cancelRequested) out.cancelRequested = true;
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  } catch (err) {
    return {
      // The reason in brackets spares the caller parsing prose.
      content: [{ type: "text", text: `delegate failed${err?.reason ? ` [${err.reason}]` : ""}: ` + (err?.message || String(err)) }],
      isError: true,
    };
  } finally {
    // Only this delegation's handle; the id stays registered while another turn runs on it.
    if (handle) pending.delete(handle);
    if (capturedSessionId) unregisterInFlight(inFlight, capturedSessionId, handle);
  }
}

// cancel and steer take the id delegate announces; a blank one is a malformed call, not a stale id.
const sessionIdInput = z.string().trim().min(1).describe("From delegate's \"session ready: <id>\" progress notification or its result.");

/**
 * @param {{
 *   runDelegate?: (opts: any) => Promise<any>,
 *   runDoctor?: (opts: any) => Promise<any>,
 *   forceGraceMs?: number,
 *   pending?: Set<any>,
 * }} [opts]
 */
export function buildServer({ runDelegate: runDelegateInjected, runDoctor: runDoctorInjected, forceGraceMs = 5000, pending = pendingDelegations } = {}) {
  const runDelegate = runDelegateInjected || runDelegateDefault;
  const runDoctor = runDoctorInjected || runDoctorDefault;
  const server = new McpServer(
    { name: "agy-delegate-mcp", version: VERSION, icons: SERVER_ICONS },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "delegate",
    {
      description:
        "Delegate a coding task to Antigravity's agy over ACP. Never shell out to agy — use this tool only. Auto-approves every permission the agent requests, in any mode and anywhere on disk. Clarifying questions arrive as prose in result — resume with resumeSessionId to answer. Leave model and effort unset unless the user explicitly asks. See the delegate skill.",
      inputSchema: delegateInputSchema,
      annotations: {
        title: "Delegate coding task to Antigravity",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => runDelegateTool({ args, ctx, runDelegate, inFlight, pending, seenSessions })
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Best-effort cancel of an in-flight delegation by sessionId. session/cancel is advisory — the agent may finish the turn anyway, and the delegate result then carries cancelRequested. Status: cancelled, killed (agent process observed to exit), not-running (turn already ended, still resumable), not-found (id not in this process's recent session history).",
      inputSchema: z.object({
        sessionId: sessionIdInput,
        force: z.boolean().default(false).describe("Kill the agent process if the turn is still running after a short grace period."),
      }),
      annotations: {
        title: "Cancel Antigravity delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, force }) => {
      const handles = inFlight.get(sessionId);
      if (!handles || handles.size === 0) {
        // A finished session is still resumable, unlike an unknown id.
        const known = seenSessions.has(sessionId);
        return statusResult(known ? "not-running" : "not-found", sessionId);
      }
      // A handle whose turn ended stays registered while agy closes. A cancel leaves its result
      // alone; force only cuts the close short.
      const ending = [...handles].filter((handle) => handle.ended);
      const live = [...handles].filter((handle) => !handle.ended);
      const stopQuietly = (handle) => Promise.resolve(handle.client.stop()).catch(() => false);
      if (live.length === 0) {
        if (force) await Promise.all(ending.map(stopQuietly));
        return statusResult("not-running", sessionId);
      }
      // Every turn running on the id: the caller named a session.
      for (const handle of live) handle.cancelRequested = true;
      await Promise.all(live.map((handle) => handle.client.cancel(sessionId).catch(() => {})));
      if (!force) {
        // The handles stay registered: session/cancel is best-effort, and a follow-up force must
        // still find a turn that kept running.
        return statusResult("cancelled", sessionId);
      }
      // Each turn's close is cut as soon as it settles (agy stops a cancelled turn in milliseconds);
      // what still runs when the grace ends is killed.
      const closing = ending.map(stopQuietly);
      const cut = new Set();
      const graceEnds = Date.now() + forceGraceMs;
      for (;;) {
        for (const handle of live) {
          if (!cut.has(handle) && (handle.ended || !inFlight.get(sessionId)?.has(handle))) {
            cut.add(handle);
            closing.push(stopQuietly(handle));
          }
        }
        if (cut.size === live.length || Date.now() >= graceEnds) break;
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, graceEnds - Date.now()))));
      }
      // Classified the moment the grace ends and killed alongside the closes, not after them: a slow
      // close would delay the kill, and a turn ending meanwhile would be reported killed. A snapshot,
      // so a resume registering during teardown is not swept from the map.
      const toKill = live.filter((handle) => !cut.has(handle));
      const [observed] = await Promise.all([Promise.all(toKill.map(stopQuietly)), Promise.all(closing)]);
      if (toKill.length === 0) return statusResult("cancelled", sessionId);
      // "killed" needs an observed exit; without one the handles stay and force can be retried.
      if (!observed.every(Boolean)) return statusResult("cancelled", sessionId);
      for (const handle of toKill) unregisterInFlight(inFlight, sessionId, handle);
      return statusResult("killed", sessionId);
    }
  );

  server.registerTool(
    "steer",
    {
      description:
        "Redirect an in-flight delegation by sessionId: message goes to agy as a new instruction for the running turn, and the delegate call returns the redirected turn's result. Status: steered (sent), not-ready (prompt not sent yet; retry), not-running (turn already ended — resume instead), not-found (id not in this process's recent session history).",
      inputSchema: z.object({
        sessionId: sessionIdInput,
        message: z.string().trim().min(1, "message must not be blank").describe("The new instruction for agy."),
      }),
      annotations: {
        title: "Steer Antigravity delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, message }) => statusResult(steerSession(inFlight, seenSessions, sessionId, message), sessionId)
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Setup diagnostics: plugin version, MCP client capabilities, agy launcher resolution. Run when delegation fails or agent.found is false.",
      inputSchema: z.object({
        deep: z
          .boolean()
          .default(false)
          .describe("Run an ACP handshake (start → initialize → newSession) to verify the agent is usable and signed in; adds models, modes, the current model's options and the account tier."),
      }),
      annotations: {
        title: "Diagnose Antigravity delegation setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deep }, ctx) => {
      // In pending while it runs, so shutdown stops doctor's agent too.
      let handle;
      try {
        const out = await runDoctor({
          deep,
          signal: ctx?.mcpReq?.signal,
          onClientReady: (client) => { handle = { client }; pending.add(handle); },
          getClientInfo: () => clientInfoOf(server, ctx),
        });
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } finally {
        if (handle) pending.delete(handle);
      }
    }
  );

  return server;
}

// A 2026-07-28 client sends its identity with each request; a 2025-era one sent it once, in
// initialize, which the server's getters return.
export function clientInfoOf(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  return {
    capabilities: envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities(),
    version: envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion(),
    protocolVersion: envelope?.[PROTOCOL_VERSION_META_KEY] ?? server.server.getNegotiatedProtocolVersion(),
  };
}

const __filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    // An imported module must not fail just because argv[1] is not a file.
  }
}

// Kill what is still running, then exit, on any way the host has of going away.
export function installSignalCleanup(map, {
  pending = new Set(),
  exit = (code) => process.exit(code),
  setExitCode = (code) => { process.exitCode = code; },
  schedule = (fn) => setImmediate(fn),
  stdin = process.stdin,
} = {}) {
  let shuttingDown = false;
  let signalsSeen = 0;
  // The code shutdown exits with: a signal's, even when it follows the stdin EOF.
  let exitCode = 0;
  // Every handle a stop went to, so a second signal still reaches one that has since unregistered.
  const dispatched = new Set();
  const shutdown = (code, fromSignal = false) => {
    // Only a second signal skips the wait for the kills: a hangup closes stdin and sends SIGHUP,
    // in either order. The first stops may still be in their ps walk, so the groups are killed
    // synchronously before leaving.
    if (fromSignal) signalsSeen++;
    if (shuttingDown) {
      if (fromSignal && signalsSeen === 1) { exitCode = code; setExitCode(code); }
      if (signalsSeen < 2) return undefined;
      for (const handle of new Set([...dispatched, ...[...map.values()].flatMap((h) => [...h]), ...pending])) {
        try { handle.client.killNow?.(); } catch {}
      }
      return exit(code);
    }
    shuttingDown = true;
    exitCode = code;
    // Set now: if the loop runs dry before the scheduled exit, the process still exits with it.
    setExitCode(code);
    const stops = [];
    // A stop that did not see the exit is retried once, as the delegation does.
    const stopOnce = (handle) => Promise.resolve(handle.client.stop()).catch(() => false);
    const dispatch = (handle) => {
      dispatched.add(handle);
      try {
        stops.push(stopOnce(handle).then((exited) => (exited === false ? stopOnce(handle) : exited)).then((exited) => {
          // Its group is killed and its id may be reused: a second signal must not kill it again.
          if (exited !== false) dispatched.delete(handle);
          return exited;
        }));
      } catch {}
    };
    for (const handles of map.values()) for (const handle of handles) dispatch(handle);
    // Delegations still in their handshake, with no session id yet.
    for (const handle of pending) dispatch(handle);
    // Exit waits for the kills: on Windows taskkill is a separate process, and exiting first left
    // the launcher and agent running (measured). stop() bounds itself. The exit is scheduled onto
    // a clean loop turn, off the settlement stack.
    const leave = () => schedule(() => exit(exitCode));
    Promise.all(stops).then(leave, leave);
  };
  // On POSIX each agent has its own process group, so a signal to this process does not reach it.
  // The handler replaces Node's default and must exit, not swallow the signal.
  if (DETACHED) {
    // SIGHUP is a closed terminal; its default would end the server without stopping the agents.
    const signals = /** @type {[NodeJS.Signals, number][]} */ ([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]);
    for (const [signal, code] of signals) process.on(signal, () => shutdown(code, true));
  }
  // A stdio host shuts down by closing stdin, which the SDK transport does not watch.
  stdin.on("end", () => shutdown(0));
}

if (isMain) {
  // Confirms an install without a host. Reads the package.json beside this file, so it reports the
  // code that runs, not a manifest pin.
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(readPackageVersion());
  } else {
    installSignalCleanup(inFlight, { pending: pendingDelegations });
    // One factory serves both protocol eras: a 2025-era initialize pins a legacy instance.
    serveStdio(() => buildServer());
  }
}
