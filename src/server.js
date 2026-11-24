#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION, readPackageVersion } from "./version.js";
import { children } from "./proc.js";
import { installSignalCleanup } from "./shutdown.js";
import { TASKS_EXTENSION, createTaskStore, listsTasks, registerTaskHandlers, runAsTask } from "./tasks.js";

const ICON_BASE = `https://raw.githubusercontent.com/andreilungeanu/agy-delegate-mcp/v${VERSION}/assets`;
/** @type {Array<{ src: string, mimeType: string, sizes: string[], theme: "light" | "dark" }>} */
const SERVER_ICONS = [
  { src: `${ICON_BASE}/logo-light.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "light" },
  { src: `${ICON_BASE}/logo-dark.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "dark" },
];
const SERVER_INFO = {
  name: "agy-delegate-mcp",
  title: "Antigravity Delegate",
  description: "Bridge AI coding hosts to Google Antigravity's agy over the Agent Client Protocol.",
  version: VERSION,
  websiteUrl: "https://github.com/andreilungeanu/agy-delegate-mcp",
  icons: SERVER_ICONS,
};

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
// Session ids seen by this process, kept after the turn so cancel can tell a finished session
// (still resumable) from an unknown id.
const seenSessions = new Set();

// Delegations answered as MCP tasks. Module-level, as inFlight: a task outlives the request that
// started it, and serveStdio may build more than one server instance.
const taskStore = createTaskStore();

// Loaded at connect: only what a caller needs to decide whether to delegate. Call-time facts go on
// the parameter descriptions.
export const SERVER_INSTRUCTIONS = `Delegate coding work to Antigravity (agy) through the delegate tool. Every permission the agent requests is auto-approved, in every mode: agent/plan/ask reach any file the user account can, and mode instructs the agent rather than limiting it. Scope workspace tightly and review the git diff after every run — filesReportedByEditTools carries only what the agent's edit tools reported; the diff is authoritative.`;

// Strict: an unknown key is almost always a typo, and a dropped resumeSessionId starts a new session.
export const delegateInputSchema = z.object({
  spec: z.string().trim().min(1, "spec must not be blank").describe("Task brief: goal, scope, fixed decisions quoted exactly, acceptance criteria. Sent as written. Point at files to read rather than pasting code, or attach them with contextFiles."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("agent implements; plan writes a plan, returned as plan; ask answers. plan and ask are instructions to the agent, not limits."),
  resumeSessionId: z.string().trim().optional().describe("Continue an existing agy session. When delegate ran as an MCP task, its server-side task id works too."),
  workspace: z.string().trim().min(1, "workspace must not be blank").describe("The agent's working directory, not a limit. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call."),
  model: z.string().trim().min(1, "model must be a non-empty string").optional().describe("agy base model id, no level suffix: gemini-4-neon, gemini-3.8-flash. Omitted, agy's default runs (a resume keeps the model last set on the session) and effectiveModel names it. doctor deep:true lists every id."),
  // Open string: a model's levels are known only once it is selected, and are validated then.
  effort: z.string().trim().min(1).optional().describe("agy thinking level for the selected model (low, medium, high, xhigh). Levels differ per model; invalid values fail before the prompt and name the accepted set. Pass only when the user asks for agy effort — the host's own reasoning setting is unrelated."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting contents into spec. Text becomes references the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against workspace but are not limited to it. Skips are reported in protocolWarnings, never fatal."),
}).strict();

// Steers every turn the map holds under the id, as cancel does: a session id names all of them.
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

/** @returns {(message: string) => void} */
export function progressNotifier(ctx) {
  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  if (progressToken == null) return () => {};
  let progress = 0;
  return (message) => {
    // An unhandled rejection would exit the server; the try catches a sync throw.
    try {
      Promise.resolve(ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message },
      })).catch(() => {});
    } catch {}
  };
}

/**
 * @param {{
 *   args: any, ctx?: any,
 *   runDelegate: (opts: any) => Promise<any>,
 *   inFlight: Map<string, Set<any>>,
 *   seenSessions?: Set<string>,
 *   signal?: AbortSignal,
 *   onProgress?: (message: string) => void,
 *   onPromptSent?: (sessionId: string, handle: any, resumeNote?: string) => void,
 *   onTurnEnd?: () => void,
 * }} deps
 * @returns {Promise<import("@modelcontextprotocol/server").CallToolResult>}
 */
export async function runDelegateTool({
  args, ctx, runDelegate, inFlight, seenSessions = new Set(),
  signal = ctx?.mcpReq?.signal, onProgress = progressNotifier(ctx), onPromptSent, onTurnEnd,
}) {
  const { spec, mode, resumeSessionId, workspace, model, effort, contextFiles } = args;

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
      signal,
      onPromptSent: onPromptSent && ((sessionId, resumeNote) => onPromptSent(sessionId, handle, resumeNote)),
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        handle = { client, cancelRequested: false };
        registerInFlight(inFlight, sessionId, handle);
        seenSessions.add(sessionId);
        // Sent as the session opens, so a host that calls tools concurrently can cancel or steer
        // mid-run.
        onProgress(`session ready: ${sessionId}`);
      },
      onTurnEnd: () => {
        if (handle) handle.ended = true;
        onTurnEnd?.();
      },
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
    if (capturedSessionId) unregisterInFlight(inFlight, capturedSessionId, handle);
  }
}

// cancel and steer take the id delegate announces; a blank one is a malformed call, not a stale id.
const sessionIdInput = z.string().trim().min(1).describe("From delegate's \"session ready: <id>\" progress notification or its result. When delegate runs as an MCP task, its server-side task id works too.");

/**
 * @param {{
 *   runDelegate?: (opts: any) => Promise<any>,
 *   runDoctor?: (opts: any) => Promise<any>,
 *   forceGraceMs?: number,
 *   inFlight?: Map<string, Set<any>>,
 *   era?: "legacy" | "modern",
 *   tasks?: ReturnType<typeof createTaskStore>,
 * }} [opts]
 */
export function buildServer({
  runDelegate: runDelegateInjected, runDoctor: runDoctorInjected, forceGraceMs = 5000,
  inFlight: flights = inFlight, era, tasks = taskStore,
} = {}) {
  const runDelegate = runDelegateInjected || runDelegateDefault;
  const runDoctor = runDoctorInjected || runDoctorDefault;
  // Tasks only on a 2026-07-28 instance: the SDK also lifts envelope keys off 2025-era requests.
  const servesTasks = era === "modern";
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: {
      // The tool list never changes, and the SDK advertises listChanged unless told otherwise.
      tools: { listChanged: false },
      ...(servesTasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
    },
  });
  if (servesTasks) registerTaskHandlers(server, tasks);
  // A task id names its own run, which a later turn on the same session is not; a session id names
  // every turn running on it.
  /** @param {string} id */
  const targetOf = (id) => {
    const task = tasks.get(id);
    if (!task?.sessionId) return { sessionId: id, handles: flights.get(id) };
    const running = task.status === "working" && flights.get(task.sessionId)?.has(task.handle);
    return { sessionId: task.sessionId, handles: new Set(running ? [task.handle] : []) };
  };

  server.registerTool(
    "delegate",
    {
      description:
        "Delegate a coding task to Antigravity's agy over ACP. Never shell out to agy — use this tool only. Auto-approves every permission the agent requests, in any mode and anywhere on disk. agy's clarifying questions arrive in questions — resume with resumeSessionId and the answers in spec. Leave model and effort unset unless the user explicitly asks. See the delegate skill.",
      inputSchema: delegateInputSchema,
      title: "Delegate coding task to Antigravity",
      annotations: {
        title: "Delegate coding task to Antigravity",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      // Claude Code tells the model a task's id and never its session id, even after a stop.
      const resumeSessionId = tasks.sessionOf(args.resumeSessionId) ?? args.resumeSessionId;
      /** @param {Record<string, any>} [over] */
      const run = (over) => runDelegateTool({ args: { ...args, resumeSessionId }, ctx, runDelegate, inFlight: flights, seenSessions, ...over });
      if (!servesTasks || !listsTasks(ctx)) return run();
      return /** @type {any} */ (runAsTask({ run, signal: ctx?.mcpReq?.signal, notify: progressNotifier(ctx), store: tasks }));
    }
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Best-effort cancel of an in-flight delegation by sessionId. session/cancel is advisory — the agent may finish the turn anyway, and the delegate result then carries cancelRequested. Status: cancelled, killed (agent process observed to exit), not-running (turn already ended, still resumable), not-found (id not in this process's session history).",
      inputSchema: z.object({
        sessionId: sessionIdInput,
        force: z.boolean().default(false).describe("Kill the agent process if the turn is still running after a short grace period."),
      }).strict(),
      title: "Cancel Antigravity delegation",
      annotations: {
        title: "Cancel Antigravity delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId: id, force }) => {
      const { sessionId, handles } = targetOf(id);
      if (!handles || handles.size === 0) {
        // A finished session is still resumable, unlike an unknown id.
        const known = seenSessions.has(sessionId);
        return statusResult(known ? "not-running" : "not-found", sessionId);
      }
      // An ended turn stays registered while agy closes; its result is decided, so a cancel leaves
      // it alone. Taken now, so a resume that registers during the grace is not swept in.
      const targeted = [...handles].filter((handle) => !handle.ended);
      if (targeted.length === 0) return statusResult("not-running", sessionId);
      for (const handle of targeted) handle.cancelRequested = true;
      await Promise.all(targeted.map((handle) => handle.client.cancel(sessionId).catch(() => {})));
      if (!force) {
        // The handles stay registered: session/cancel is best-effort, and a follow-up force must
        // still find a turn that kept running.
        return statusResult("cancelled", sessionId);
      }
      // Polled, not slept through: agy stops a cancelled turn in milliseconds.
      const running = () => targeted.filter((handle) => !handle.ended && flights.get(sessionId)?.has(handle));
      const graceEnds = Date.now() + forceGraceMs;
      while (Date.now() < graceEnds && running().length) {
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, graceEnds - Date.now()))));
      }
      const toKill = running();
      if (toKill.length === 0) return statusResult("cancelled", sessionId);
      const observed = await Promise.all(toKill.map((handle) => Promise.resolve(handle.client.stop()).catch(() => false)));
      // "killed" needs an observed exit.
      if (!observed.every(Boolean)) return statusResult("cancelled", sessionId);
      for (const handle of toKill) unregisterInFlight(flights, sessionId, handle);
      return statusResult("killed", sessionId);
    }
  );

  server.registerTool(
    "steer",
    {
      description:
        "Redirect an in-flight delegation by sessionId: message goes to agy as a new instruction for the running turn, and the delegate call returns the redirected turn's result. Status: steered (sent), not-ready (prompt not sent yet; retry), not-running (turn already ended — resume instead), not-found (id not in this process's session history).",
      inputSchema: z.object({
        sessionId: sessionIdInput,
        message: z.string().trim().min(1, "message must not be blank").describe("The new instruction for agy."),
      }).strict(),
      title: "Steer Antigravity delegation",
      annotations: {
        title: "Steer Antigravity delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId: id, message }) => {
      const { sessionId, handles } = targetOf(id);
      return statusResult(steerSession(new Map([[sessionId, handles ?? new Set()]]), seenSessions, sessionId, message), sessionId);
    }
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
      }).strict(),
      title: "Diagnose Antigravity delegation setup",
      annotations: {
        title: "Diagnose Antigravity delegation setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deep }, ctx) => {
      const out = await runDoctor({ deep, signal: ctx?.mcpReq?.signal, getClientInfo: () => clientInfoOf(server, ctx) });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
  );

  return server;
}

// A 2025-era client sends its identity once, in initialize, which stays authoritative on that
// connection even if a request carries envelope keys; a 2026-07-28 one sends it with each request.
export function clientInfoOf(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  return {
    capabilities: server.server.getClientCapabilities() ?? envelope?.[CLIENT_CAPABILITIES_META_KEY],
    version: server.server.getClientVersion() ?? envelope?.[CLIENT_INFO_META_KEY],
    protocolVersion: server.server.getNegotiatedProtocolVersion() ?? envelope?.[PROTOCOL_VERSION_META_KEY],
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

if (isMain) {
  // Confirms an install without a host. Reads the package.json beside this file, so it reports the
  // code that runs, not a manifest pin.
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(readPackageVersion());
  } else {
    const hostGone = installSignalCleanup(() => children.stopAll());
    const transport = new StdioServerTransport();
    // One factory serves both protocol eras: a 2025-era initialize pins a legacy instance, and only
    // a modern one answers with tasks.
    serveStdio(({ era }) => buildServer({ era }), { transport });
    // The transport also closes on a broken stdout, and then pauses stdin, so no 'end' arrives.
    const closeServers = transport.onclose;
    transport.onclose = () => {
      closeServers?.();
      hostGone();
    };
  }
}
