import process from "node:process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export function splitArgs(raw) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(raw || "").matchAll(re)) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

// --dangerously-skip-permissions makes agy approve its own tool calls. The request router approves
// any permission request too, but a subagent's command can wait without raising one (agy #1658),
// which only the flag covers.
export const DEFAULT_AGENT_ARGS = Object.freeze(["acp", "--dangerously-skip-permissions"]);

// shell:true on win32 lets a .cmd/.ps1 launcher resolve, and cmd.exe parses the line. Safe because
// both values come from the environment, as trusted as this process. Never route host or caller
// input into them: that would be command injection.
export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "agy";
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : [...DEFAULT_AGENT_ARGS];
  return { command, args, options: { shell: process.platform === "win32" } };
}

// Node 24 warns (DEP0190) on args passed with shell: true. Node joins them with spaces anyway, so
// joining here sends cmd.exe the same line without the warning.
/** @returns {[string, string[]]} */
export function spawnCommandLine(command, args, options) {
  const argv = args ?? [];
  return options?.shell ? [[command, ...argv].join(" "), []] : [command, argv];
}

// Through a shell the spawn always succeeds (cmd.exe starts, then fails to find the launcher), so a
// missing agy would read as an agent crash. Mirrors cmd's lookup: a path as given, a bare name in
// each PATH entry, each with and without every PATHEXT extension.
export function commandExists(command, env = process.env) {
  const name = String(command || "").replace(/^["']|["']$/g, "");
  if (!name) return false;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === "PATHEXT");
  const exts = ["", ...String((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const isFile = (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  const hit = (base) => exts.some((ext) => isFile(base + ext) || isFile(base + ext.toLowerCase()));
  if (/[\\/]/.test(name)) return hit(name);
  const dirs = String((pathKey && env[pathKey]) || "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => hit(path.join(dir.replace(/^"|"$/g, ""), name)));
}
