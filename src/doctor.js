import process from "node:process";
import { existsSync, statSync } from "node:fs";
import { AcpClient, GRACEFUL_STOP_MS } from "./acp-client.js";
import { commandExists, resolveAcpSpawn } from "./spawn.js";
import { children, spawnChild, stopChild } from "./proc.js";
import { readPackageVersion } from "./version.js";
import { allowedValues, describeOptions } from "./model-options.js";
import { DEFAULT_MODEL } from "./delegate.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Reported when set: each changes how the agent is launched or how long a run may take. */
const ENV_KNOBS = ["ACP_AGENT_COMMAND", "ACP_AGENT_ARGS", "AGY_DELEGATE_TRANSCRIPT", "AGY_DELEGATE_HANDSHAKE_MS", "AGY_DELEGATE_HARD_CAP_MS", "AGY_DELEGATE_BACKGROUND_WAIT_MS"];

function formatArg(value) {
  const s = String(value);
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function formatCommand({ command, args }) {
  const bits = [formatArg(command), ...(args || []).map(formatArg)];
  return args?.length ? bits.join(" ") : formatArg(command);
}

function isJsLauncher(command) {
  const trimmed = String(command || "").replace(/^["']|["']$/g, "");
  return /\.(?:cjs|mjs|js)$/i.test(trimmed);
}

function describeWorkspace(workspace, warnings) {
  let stat = null;
  try { stat = statSync(workspace); } catch {}
  const out = { path: workspace, exists: Boolean(stat), isDirectory: Boolean(stat?.isDirectory()) };
  if (!out.exists) warnings.push(`workspace does not exist: ${workspace}`);
  else if (!out.isDirectory) warnings.push(`workspace is not a directory: ${workspace}`);
  return out;
}

/**
 * Time-boxed: doctor runs when delegation is already broken, so it must survive a wedged launcher.
 * @param {{ command: string, args?: string[], options?: any }} spawnSpec
 * @param {number} [timeoutMs]
 * @param {{ signal?: AbortSignal, registry?: import("./proc.js").ChildRegistry }} [opts]
 */
export function probeAgentVersion(spawnSpec, timeoutMs = VERSION_PROBE_TIMEOUT_MS, { signal, registry = children } = {}) {
  const { command, args, options } = spawnSpec;
  const launcher = String(command || "").replace(/^["']|["']$/g, "");
  const isJsScript = isJsLauncher(launcher);
  const execCommand = isJsScript ? process.execPath : command;
  // --version replaces the acp subcommand, so a launcher prefix ("cmd /c agy acp") still reaches
  // agy. With no acp token, --version goes alone.
  const acpAt = Array.isArray(args) ? args.indexOf("acp") : -1;
  const versionArgs = [...(acpAt > 0 ? args.slice(0, acpAt) : []), "--version"];
  const execArgs = isJsScript ? [launcher, ...versionArgs] : versionArgs;
  const aborted = { version: null, error: "version probe aborted by MCP host" };
  // Interrupted already, or shutting down: nothing is spawned, and found comes from the lookup alone.
  const notRun = (error) => Promise.resolve({ found: isJsScript ? existsSync(launcher) : commandExists(launcher, options?.env), version: null, error });
  if (signal?.aborted) return notRun(aborted.error);
  let child;
  try {
    child = spawnChild(execCommand, execArgs, options, { stdio: ["ignore", "pipe", "pipe"] }, registry);
  } catch (err) {
    return notRun(err.message);
  }
  if (!child) return Promise.resolve({ found: false, version: null });
  return new Promise((resolve) => {
    let stdout = "";
    const finish = (result) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    // Drained: a full pipe blocks a noisy launcher, which would then read as a timeout.
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => {});
    child.on("error", () => finish({ found: false, version: null }));
    child.on("close", (code) => finish(code === 0 ? { found: true, version: stdout.trim() || null } : { found: true, version: null, error: `version probe exited ${code}` }));
    // It spawned, so it is installed; it did not answer.
    const timer = setTimeout(() => {
      stopChild(child);
      finish({ found: true, version: null, error: `version probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = () => {
      stopChild(child);
      finish({ found: true, ...aborted });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @returns {Promise<{ session: any, models?: any, plan?: string, signedOut?: boolean }>} */
async function runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs, signal }) {
  if (signal?.aborted) return { session: { ok: false, error: "Handshake aborted by MCP host" } };
  const client = clientFactory({ spawnSpec, cwd: workspace });
  let timer;
  let onAbort;
  try {
    const work = (async () => {
      await client.start();
      await client.initialize();
      await client.newSession(workspace);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Not awaited, so the timeout rejects on time; the finally awaits the same stop.
        try { Promise.resolve(client.stop()).catch(() => {}); } catch {}
        reject(new Error(`Handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    // A host interrupt stops the agent at once rather than leaving it to the handshake timeout.
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        try { Promise.resolve(client.stop()).catch(() => {}); } catch {}
        reject(new Error("Handshake aborted by MCP host"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([work, timeout, aborted]);
    // The base ids delegate accepts, from the model option. availableModels carries level
    // suffixes delegate does not take, so it is only the fallback.
    const modelOption = (client.configOptions ?? []).find((o) => o?.id === "model");
    const baseIds = allowedValues(modelOption);
    const available = baseIds.length
      ? baseIds
      : (client.sessionModels?.availableModels ?? []).map((m) => m?.modelId).filter((id) => typeof id === "string");
    const tier = client.sessionMeta?.antigravity?.tier;
    return {
      session: { ok: true, modes: (client.sessionModes?.availableModes ?? []).map((m) => m?.id).filter(Boolean) },
      models: {
        default: DEFAULT_MODEL,
        // null when the agent listed nothing: delegate checks nothing then either.
        defaultAvailable: available.length ? available.includes(DEFAULT_MODEL) : null,
        current: (typeof modelOption?.currentValue === "string" ? modelOption.currentValue : null)
          ?? client.sessionModels?.currentModelId ?? null,
        available,
        // The current model's options only: another model's need a model switch first.
        currentModelOptions: describeOptions(client.configOptions),
      },
      ...(typeof tier?.name === "string" ? { plan: tier.name } : {}),
    };
  } catch (err) {
    // -32000 is ACP's auth_required, which agy sends from session/new when signed out.
    return { session: { ok: false, error: err?.message || String(err) }, signedOut: err?.code === -32000 };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Awaited, so doctor returns once its agent is stopped or the stop's deadline passed. Graceful,
    // closing the handshake's session; after a timeout or abort it joins the kill already started.
    try { await Promise.resolve(client.stop({ graceMs: signal?.aborted ? 0 : GRACEFUL_STOP_MS })); } catch {}
  }
}

/**
 * @param {{
 *   getClientInfo?: () => { capabilities?: any, version?: any, protocolVersion?: string },
 *   deep?: boolean,
 *   spawnSpec?: { command: string, args: string[], options?: object },
 *   clientFactory?: (opts: any) => any,
 *   workspace?: string,
 *   handshakeTimeoutMs?: number,
 *   versionTimeoutMs?: number,
 *   readVersion?: () => string,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} [opts]
 */
export async function runDoctor({
  getClientInfo = () => ({ capabilities: {}, version: {} }),
  deep = false,
  spawnSpec = resolveAcpSpawn(),
  clientFactory = (opts) => new AcpClient(opts),
  workspace = process.cwd(),
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  versionTimeoutMs = VERSION_PROBE_TIMEOUT_MS,
  readVersion = readPackageVersion,
  env = process.env,
  signal,
} = {}) {
  const { version, protocolVersion } = getClientInfo();
  /** @type {string[]} */
  const warnings = [];
  const probe = await probeAgentVersion(spawnSpec, versionTimeoutMs, { signal });
  if (!probe.found) warnings.push("agy not found. Install Antigravity and sign in by running `agy` once.");
  else if (!probe.version) warnings.push(`agy did not answer --version: ${probe.error}`);

  /** @type {Record<string, any>} */
  const out = {
    plugin: { name: "agy-delegate-mcp", version: readVersion() },
    client: {
      name: version?.name ?? null,
      version: version?.version ?? null,
      // The MCP revision the host speaks: 2026-07-28 or a 2025-era one.
      ...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
    },
    agent: {
      found: probe.found,
      command: formatCommand(spawnSpec),
      version: probe.version,
      ...(probe.error ? { error: probe.error } : {}),
    },
    // agy has no status command; deep reads the login from the session it opens.
    auth: { status: "unknown" },
    workspace: describeWorkspace(workspace, warnings),
  };
  const set = ENV_KNOBS.filter((name) => env[name] !== undefined);
  if (set.length) out.env = Object.fromEntries(set.map((name) => [name, env[name]]));
  out.warnings = warnings;

  if (deep) {
    const { session, models, plan, signedOut } = await runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs: handshakeTimeoutMs, signal });
    out.session = session;
    if (session.ok) out.auth = { status: "ok", ...(plan ? { plan } : {}) };
    else if (signedOut) {
      out.auth = { status: "logged-out" };
      warnings.push("agy is not signed in. Run `agy` once in a terminal and sign in.");
    } else warnings.push(`The ACP handshake failed: ${session.error}`);
    if (models) {
      out.models = models;
      if (models.defaultAvailable === false) {
        warnings.push(`The default model ${DEFAULT_MODEL} is not among the models this account offers; a delegation that names no model runs agy's default (${models.current ?? "unknown"}).`);
      }
    }
  }

  return out;
}
