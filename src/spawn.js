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

// --dangerously-skip-permissions makes agy approve its own tool calls instead of asking. The
// request router still approves any session/request_permission that arrives, but agy issue
// #1658 reports a subagent's command raising none and waiting for an approval that cannot come,
// which only the flag reaches. With the flag, a probe turn raised no permission request at all.
export const DEFAULT_AGENT_ARGS = Object.freeze(["acp", "--dangerously-skip-permissions"]);

// shell:true on win32 is what lets a .cmd/.ps1 launcher resolve at all, and it means the
// command and args are parsed by cmd.exe. Safe only because both come from the environment,
// which is already as trusted as this process: anything that can set them can run code here
// anyway. Routing host- or caller-supplied values into either variable would turn this into a
// command-injection path, so don't.
export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "agy";
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : [...DEFAULT_AGENT_ARGS];
  return { command, args, options: { shell: process.platform === "win32" } };
}

// Node 24 deprecates args passed alongside shell: true (DEP0190) and warns on the server's stderr.
// Through a shell Node joins command and args with spaces and hands cmd.exe that line, so the
// line is built here the same way and passed alone: cmd.exe receives the same bytes.
/** @returns {[string, string[]]} */
export function spawnCommandLine(command, args, options) {
  return options?.shell ? [[command, ...args].join(" "), []] : [command, args];
}

// Through a shell the spawn itself always succeeds: cmd.exe starts, fails to find the launcher and
// exits 1 with a localized "is not recognized" line, so Node's spawn 'error' event never fires and
// a missing agy reads as an agent crash. Resolving the launcher first is what lets that case be
// reported as not installed. Mirrors cmd's lookup: a path is checked as given, a bare name against
// each PATH entry, both with and without each PATHEXT extension.
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
