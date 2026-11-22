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

// shell:true on win32 lets a .cmd or .bat launcher resolve, and cmd.exe parses the line; a .ps1 is
// started through PowerShell at the spawn (spawnArgv). Safe because both values come from the
// environment, as trusted as this process. Never route host or caller input into them: that would
// be command injection.
export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "agy";
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : [...DEFAULT_AGENT_ARGS];
  return { command, args, options: { shell: process.platform === "win32" } };
}

// Under shell: true Node hands cmd.exe one joined line and quotes nothing, so a launcher path or an
// argument with a space or a cmd metacharacter split there. A value already holding a quote passes
// as given: cmd cannot nest them, and a pre-quoted path is how one with a space had to be written.
// %VAR% still expands, inside quotes too.
function cmdQuote(value) {
  const s = String(value);
  if (s.includes('"') || (s !== "" && !/[\s&|<>^(),;=]/.test(s))) return s;
  // Doubled so the child's argv parser does not read a trailing backslash as escaping the quote.
  return `"${s.replace(/(\\+)$/, "$1$1")}"`;
}

// The line is built here, quoted for cmd.exe, and passed alone: Node 24 warns (DEP0190) on args
// passed with shell: true.
/** @returns {[string, string[]]} */
export function spawnCommandLine(command, args, options) {
  const argv = args ?? [];
  if (!options?.shell) return [command, argv];
  const quote = process.platform === "win32" ? cmdQuote : String;
  return [[command, ...argv].map(quote).join(" "), []];
}

/**
 * What to hand spawn() for a spec. Applied at each spawn site, after doctor has built its
 * --version args from the spec as configured.
 * @param {string} command @param {string[] | undefined} args
 * @param {{ shell?: boolean, env?: NodeJS.ProcessEnv } | undefined} options
 * @returns {{ command: string, args: string[], options: any }}
 */
export function spawnArgv(command, args, options) {
  const argv = args ?? [];
  if (!(options?.shell && process.platform === "win32")) return { command, args: argv, options };
  const env = options.env || process.env;
  // cmd.exe hands a .ps1 to its file association (an editor or an "open with" dialog) instead of
  // running it. Only that exact file: x.ps1.cmd is cmd's to run.
  const name = String(command).replace(/^["']|["']$/g, "");
  const script = /\.ps1$/i.test(name) ? findCommand(name, env, true) : null;
  if (!script) return { command, args: argv, options };
  const rootKey = Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT");
  const powershell = rootKey && env[rootKey]
    ? path.win32.join(env[rootKey], "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return {
    command: powershell,
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...argv],
    options: { ...options, shell: false },
  };
}

// Through a shell the spawn always succeeds (cmd.exe starts, then fails to find the launcher), so a
// missing agy would read as an agent crash.
export function commandExists(command, env = process.env) {
  return findCommand(command, env) !== null;
}

// The file cmd's lookup lands on, or null: a path as given, a bare name in each PATH entry, each
// with and without every PATHEXT extension. exact skips the extensions.
function findCommand(command, env, exact = false) {
  const name = String(command || "").replace(/^["']|["']$/g, "");
  if (!name) return null;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === "PATHEXT");
  const exts = exact ? [""] : ["", ...String((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const isFile = (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  const hit = (base) => {
    for (const ext of exts) {
      for (const p of [base + ext, base + ext.toLowerCase()]) if (isFile(p)) return p;
    }
    return null;
  };
  if (/[\\/]/.test(name)) return hit(name);
  const dirs = String((pathKey && env[pathKey]) || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = hit(path.join(dir.replace(/^"|"$/g, ""), name));
    if (found) return found;
  }
  return null;
}
