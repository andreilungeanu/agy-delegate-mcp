import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { AcpClient, GRACEFUL_STOP_MS } from "./acp-client.js";
import { commandExists, resolveAcpSpawn, spawnArgv, spawnCommandLine } from "./spawn.js";
import { DETACHED, treeKill } from "./proc.js";
import { readPackageVersion } from "./version.js";
import { allowedValues, describeOptions } from "./model-options.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const PROBE_STDOUT_CAP = 64 * 1024;
const PROBE_KILL_WAIT_MS = 2000;
const DEFAULT_LOG_SIZE = "2000";

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

function envReport(name, fallback = null) {
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

// Time-boxed: doctor runs when delegation is already broken, so it must survive a wedged launcher.
export function probeAgentVersion(spawnSpec, timeoutMs = VERSION_PROBE_TIMEOUT_MS, signal) {
  const { command, options } = spawnSpec;
  const launcher = String(command || "").replace(/^["']|["']$/g, "");
  const isJsScript = isJsLauncher(launcher);
  const execCommand = isJsScript ? process.execPath : command;
  const execArgs = isJsScript ? [launcher, "--version"] : ["--version"];
  // Through a shell, a missing launcher still spawns (the shell does) and would read as found.
  if (options?.shell && !isJsScript && !commandExists(launcher)) return Promise.resolve({ found: false, version: null });
  const aborted = { version: null, error: "version probe aborted by MCP host" };
  // Interrupted already: nothing is spawned, and found comes from the lookup alone.
  if (signal?.aborted) {
    return Promise.resolve({ found: isJsScript ? existsSync(launcher) : commandExists(launcher), ...aborted });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timer;
    let onAbort;
    let abortRequested = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const launch = spawnArgv(execCommand, execArgs, options);
    const [file, argv] = spawnCommandLine(launch.command, launch.args, launch.options);
    const child = spawn(file, argv, { ...launch.options, detached: DETACHED, stdio: ["ignore", "pipe", "pipe"] });
    // Capped: a version is one line.
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < PROBE_STDOUT_CAP) stdout += chunk.toString();
    });
    // Drained: a full pipe blocks a noisy launcher, which would then read as a timeout.
    child.stderr?.on("data", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", () => finish({ found: false, version: null }));
    const closed = new Promise((r) => child.once("close", r));
    child.on("close", (code) => {
      if (abortRequested) return;
      const version = code === 0 ? stdout.trim() || null : null;
      finish({
        found: true,
        version,
        ...(code !== 0 ? { error: `version probe exited ${code}` } : {}),
      });
    });
    timer = setTimeout(() => {
      // treeKill: on win32 a plain kill reaches only the shell wrapper.
      if (child.pid) treeKill(child.pid).catch(() => {});
      // It spawned, so it is installed; it did not answer.
      finish({ found: true, version: null, error: `version probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    // A host interrupt ends the probe at once rather than at its timeout.
    // Returns once the probe has closed, so doctor does not leave it running; bounded like stop().
    onAbort = () => {
      abortRequested = true;
      const killed = child.pid ? treeKill(child.pid).catch(() => {}) : Promise.resolve();
      const bound = new Promise((r) => setTimeout(r, PROBE_KILL_WAIT_MS).unref?.());
      Promise.race([Promise.all([killed, closed]), bound]).then(() => finish({ found: true, ...aborted }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs, signal, onClientReady }) {
  const workspaceDir = workspace || process.cwd();
  const client = clientFactory({ spawnSpec, cwd: workspaceDir });
  // Handed out before the spawn, so shutdown can stop it.
  onClientReady?.(client);
  let timer;
  let onAbort;
  try {
    const details = {};
    const work = (async () => {
      await client.start();
      await client.initialize();
      await client.newSession(workspaceDir);
      details.protocolVersion = client.protocolVersion ?? null;
      details.agentCapabilities = client.agentCapabilities ?? {};
      // The base ids delegate accepts, from the model option. availableModels carries level
      // suffixes delegate does not take, so it is only the fallback.
      const modelOption = (client.configOptions ?? []).find((o) => o?.id === "model");
      const baseIds = allowedValues(modelOption);
      details.models = baseIds.length
        ? baseIds
        : (client.sessionModels?.availableModels ?? []).map((m) => m?.modelId).filter(Boolean);
      details.currentModel = (typeof modelOption?.currentValue === "string" ? modelOption.currentValue : null)
        ?? client.sessionModels?.currentModelId ?? null;
      details.modes = (client.sessionModes?.availableModes ?? []).map((m) => m?.id).filter(Boolean);
      // The current model's options only: another model's need a model switch first.
      details.currentModelOptions = describeOptions(client.configOptions);
      details.tier = client.sessionMeta?.antigravity?.tier ?? null;
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
    return { ok: true, ...details };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
    // Awaited, so doctor returns once its agent is stopped or the stop's deadline passed. Graceful,
    // closing the handshake's session; after a timeout or abort it joins the kill already started.
    // The abort listener stays on through the close, so an abort there forces the kill.
    try { await Promise.resolve(client.stop({ graceMs: signal?.aborted ? 0 : GRACEFUL_STOP_MS })); } catch {}
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * @param {{
 *   getClientInfo?: () => { capabilities?: any, version?: any },
 *   deep?: boolean,
 *   spawnSpec?: { command: string, args: string[], options?: object },
 *   clientFactory?: (opts: any) => any,
 *   workspace?: string,
 *   handshakeTimeoutMs?: number,
 *   versionTimeoutMs?: number,
 *   readVersion?: () => string,
 *   signal?: AbortSignal,
 *   onClientReady?: (client: any) => void,
 * }} [opts]
 */
export async function runDoctor({
  getClientInfo = () => ({ capabilities: {}, version: {} }),
  deep = false,
  spawnSpec = resolveAcpSpawn(),
  clientFactory = (opts) => new AcpClient(opts),
  workspace,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  versionTimeoutMs = VERSION_PROBE_TIMEOUT_MS,
  readVersion = readPackageVersion,
  signal,
  onClientReady,
} = {}) {
  const { capabilities, version } = getClientInfo();
  const agentProbe = await probeAgentVersion(spawnSpec, versionTimeoutMs, signal);

  /** @type {{ plugin: any, client: any, agent: any & { handshake?: any }, runtime: any, env: any }} */
  const out = {
    plugin: { version: readVersion() },
    client: {
      name: version?.name ?? null,
      version: version?.version ?? null,
      capabilities: capabilities ?? {},
    },
    agent: {
      found: agentProbe.found,
      command: formatCommand(spawnSpec),
      version: agentProbe.version,
      ...(agentProbe.error ? { error: agentProbe.error } : {}),
    },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      transport: "stdio",
    },
    env: {
      ACP_LOG_SIZE: envReport("ACP_LOG_SIZE", DEFAULT_LOG_SIZE),
      ACP_AGENT_COMMAND: envReport("ACP_AGENT_COMMAND"),
      ACP_AGENT_ARGS: envReport("ACP_AGENT_ARGS"),
      AGY_DELEGATE_TRANSCRIPT: envReport("AGY_DELEGATE_TRANSCRIPT"),
      AGY_DELEGATE_HANDSHAKE_MS: envReport("AGY_DELEGATE_HANDSHAKE_MS"),
      AGY_DELEGATE_HARD_CAP_MS: envReport("AGY_DELEGATE_HARD_CAP_MS"),
      AGY_DELEGATE_IDLE_MS: envReport("AGY_DELEGATE_IDLE_MS"),
      AGY_DELEGATE_BACKGROUND_WAIT_MS: envReport("AGY_DELEGATE_BACKGROUND_WAIT_MS"),
    },
  };

  if (deep && signal?.aborted) {
    // Already interrupted: no agent is started.
    out.agent.handshake = { ok: false, error: "Handshake aborted by MCP host" };
  } else if (deep) {
    out.agent.handshake = await runDeepHandshake({
      spawnSpec,
      clientFactory,
      workspace,
      timeoutMs: handshakeTimeoutMs,
      signal,
      onClientReady,
    });
  }

  return out;
}
