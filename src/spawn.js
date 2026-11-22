import process from "node:process";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";

// Splits on whitespace outside quotes. A quoted section joins the token it sits in, quotes removed,
// as a shell reads --log-file="C:\a b\x.log". Backslashes are literal.
export function splitArgs(raw) {
  const args = [];
  const re = /(?:"[^"]*"|'[^']*'|[^\s"']+)+/g;
  for (const m of String(raw || "").matchAll(re)) {
    args.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (_, d, q) => d ?? q));
  }
  return args;
}

// --dangerously-skip-permissions makes agy approve its own tool calls. The request router approves
// any permission request too, but a subagent's command can wait without raising one (agy #1658),
// which only the flag covers.
export const DEFAULT_AGENT_ARGS = Object.freeze(["acp", "--dangerously-skip-permissions"]);

// shell:true on win32 marks the spec for the Windows launch at each spawn site (spawnArgv): the
// command is found first and started by file type, and only a .cmd or .bat reaches cmd.exe, which
// parses its line. Safe because both values come from the environment, as trusted as this process.
// Never route host or caller input into them: that would be command injection.
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
 * What to hand spawn() for a spec, or null when the launcher is not found. Applied at each spawn
 * site, after doctor has built its --version args from the spec as configured. On win32 the command
 * is looked up on every spawn (an update can move it) and started by the type of the file found:
 * an .exe or .com directly, a .ps1 through PowerShell, anything else through cmd.exe.
 * @param {string} command @param {string[] | undefined} args
 * @param {{ shell?: boolean, env?: NodeJS.ProcessEnv } | undefined} options
 * @returns {{ command: string, args: string[], options: any } | null}
 */
export function spawnArgv(command, args, options) {
  const argv = args ?? [];
  if (!options?.shell) return { command, args: argv, options };
  const env = options.env || process.env;
  if (process.platform !== "win32") return commandExists(command, env) ? { command, args: argv, options } : null;
  const file = findCommand(command, env);
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  // Exact arguments: cmd.exe would expand %VAR% and strip quotes and carets.
  if (ext === ".exe" || ext === ".com") return { command: file, args: argv, options: { ...options, shell: false } };
  // cmd.exe hands a .ps1 to its file association (an editor or an "open with" dialog) instead of
  // running it.
  if (ext === ".ps1") {
    const rootKey = Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT");
    const powershell = rootKey && env[rootKey]
      ? path.win32.join(env[rootKey], "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return {
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...argv],
      options: { ...options, shell: false },
    };
  }
  return { command: file, args: argv, options };
}

export function commandExists(command, env = process.env) {
  return findCommand(command, env) !== null;
}

// The file cmd's lookup lands on, as an absolute path (the spawn may run in another directory), or
// null: a path as given, a bare name in each PATH entry, each with and without every PATHEXT
// extension. On win32 a file with no extension never matches: cmd reports it "not recognized"
// (measured), and npm installs an sh script of that name beside the .cmd.
function findCommand(command, env) {
  const name = String(command || "").replace(/^["']|["']$/g, "");
  if (!name) return null;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === "PATHEXT");
  const exts = ["", ...String((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const win32 = process.platform === "win32";
  const isFile = (p) => {
    if (win32 && !path.extname(p)) return false;
    try {
      return statSync(p).isFile();
    } catch (e) {
      // A Store app's alias (WindowsApps\pwsh.exe) is a link into a folder this user cannot stat,
      // so stat fails with EACCES, yet cmd runs it. A link to a missing file fails with ENOENT.
      if (!win32 || (e.code !== "EACCES" && e.code !== "EPERM")) return false;
      try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
    }
  };
  const hit = (base) => {
    for (const ext of exts) {
      for (const p of [base + ext.toLowerCase(), base + ext]) if (isFile(p)) return path.resolve(p);
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
