import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitArgs, resolveAcpSpawn, commandExists, spawnCommandLine, spawnArgv, DEFAULT_AGENT_ARGS } from "../src/spawn.js";

test("splitArgs splits plain whitespace-separated tokens", () => {
  assert.deepEqual(splitArgs("acp --verbose"), ["acp", "--verbose"]);
  assert.deepEqual(splitArgs("  acp   --verbose  "), ["acp", "--verbose"]);
});

test("splitArgs keeps double-quoted arguments with spaces intact", () => {
  assert.deepEqual(splitArgs('acp --config "C:\\Program Files\\agent\\acp.json"'), [
    "acp",
    "--config",
    "C:\\Program Files\\agent\\acp.json",
  ]);
});

test("splitArgs keeps single-quoted arguments intact", () => {
  assert.deepEqual(splitArgs("run 'a b c' end"), ["run", "a b c", "end"]);
});

// A quote inside a token split it: --log-file="C:\logs & traces\agy.log" became three args, and
// the bare & among them reached cmd.exe as a command separator.
test("splitArgs joins a quoted section to the token it sits in", () => {
  assert.deepEqual(splitArgs('acp --log-file="C:\\logs & traces\\agy.log"'), ["acp", "--log-file=C:\\logs & traces\\agy.log"]);
  assert.deepEqual(splitArgs('acp "" end'), ["acp", "", "end"]);
});

// A quote inside a word is a character of it: a path under O'Brien split in two.
test("splitArgs keeps a quote inside a word as part of the argument", () => {
  assert.deepEqual(splitArgs("--log C:\\Users\\O'Brien\\agy.log"), ["--log", "C:\\Users\\O'Brien\\agy.log"]);
  assert.deepEqual(splitArgs("--log=C:\\it's\\O'Brien.log end"), ["--log=C:\\it's\\O'Brien.log", "end"]);
  assert.deepEqual(splitArgs('say 5" "unclosed'), ["say", '5"', '"unclosed']);
});

test("splitArgs handles empty and undefined input", () => {
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test("resolveAcpSpawn defaults to agy acp with --dangerously-skip-permissions when env vars are unset", () => {
  const prevCmd = process.env.ACP_AGENT_COMMAND;
  const prevArgs = process.env.ACP_AGENT_ARGS;
  delete process.env.ACP_AGENT_COMMAND;
  delete process.env.ACP_AGENT_ARGS;
  try {
    const spec = resolveAcpSpawn();
    assert.equal(spec.command, "agy");
    assert.deepEqual(spec.args, ["acp", "--dangerously-skip-permissions"]);
  } finally {
    if (prevCmd !== undefined) process.env.ACP_AGENT_COMMAND = prevCmd;
    if (prevArgs !== undefined) process.env.ACP_AGENT_ARGS = prevArgs;
  }
});

test("resolveAcpSpawn honors ACP_AGENT_ARGS with quoted segments", () => {
  const prevArgs = process.env.ACP_AGENT_ARGS;
  process.env.ACP_AGENT_ARGS = 'acp --workdir "dir with spaces"';
  try {
    const spec = resolveAcpSpawn();
    assert.deepEqual(spec.args, ["acp", "--workdir", "dir with spaces"]);
  } finally {
    if (prevArgs !== undefined) process.env.ACP_AGENT_ARGS = prevArgs;
    else delete process.env.ACP_AGENT_ARGS;
  }
});

test("commandExists finds a launcher on PATH with and without a PATHEXT extension", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-exists-"));
  writeFileSync(path.join(dir, "fakeagy.cmd"), "@echo off\n");
  writeFileSync(path.join(dir, "plainagy"), "");
  mkdirSync(path.join(dir, "dironly"));
  const env = { Path: ["/nowhere", dir].join(path.delimiter), PATHEXT: ".EXE;.CMD" };
  assert.equal(commandExists("fakeagy", env), true, "bare name resolves through PATHEXT");
  assert.equal(commandExists("fakeagy.cmd", env), true, "name with its extension");
  // cmd does not run a file with no extension ("is not recognized", measured); npm installs an sh
  // script of that name beside the .cmd.
  assert.equal(commandExists("plainagy", env), process.platform !== "win32", "extensionless file");
  assert.equal(commandExists("dironly", env), false, "a directory is not a launcher");
  assert.equal(commandExists("missingagy", env), false);
  assert.equal(commandExists(path.join(dir, "fakeagy"), env), true, "a path is checked as given");
  assert.equal(commandExists(`"${path.join(dir, "fakeagy.cmd")}"`, env), true, "quotes are stripped");
  assert.equal(commandExists(path.join(dir, "missingagy"), env), false);
  assert.equal(commandExists("", env), false);
});

// spawn accepts a missing args array; the shell command line built for DEP0190 has to as well.
test("spawnCommandLine accepts a spec without args", () => {
  assert.deepEqual(spawnCommandLine("agy", undefined, { shell: true }), ["agy", []]);
  assert.deepEqual(spawnCommandLine("agy", undefined, { shell: false }), ["agy", []]);
});

// cmd.exe hands a .ps1 to its file association, an editor or an "open with" dialog, instead of
// running it, so an ACP_AGENT_COMMAND pointing at a .ps1 wrapper never started the agent. Each test
// checks the rewritten command before anything spawns: on the old route the spawn would open the
// script, not run it.
const PS1_AGENT = [
  "if ($args -contains '--version') { Write-Output 'ps1-agent 1.0'; exit 0 }",
  "[Console]::Error.Write((ConvertTo-Json -InputObject @($args) -Compress)); exit 3",
].join("\r\n");

function withAgentEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("a .ps1 ACP_AGENT_COMMAND runs through PowerShell with its arguments intact", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { AcpClient } = await import("../src/acp-client.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    const script = path.join(dir, "agent.ps1");
    writeFileSync(script, PS1_AGENT);
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: script, ACP_AGENT_ARGS: '"two words" acp' }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.match(argv.command, /powershell\.exe$/i, "the script must not go to cmd.exe");
    assert.deepEqual(argv.args.slice(-3), [script, "two words", "acp"]);
    const client = new AcpClient({ spawnSpec: spec });
    const exit = new Promise((resolve) => client.once("exit", resolve));
    await client.start();
    const info = await exit;
    assert.equal(info.code, 3, info.stderr);
    assert.deepEqual(JSON.parse(info.stderr), ["two words", "acp"]);
    await client.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reads a .ps1 launcher's version, and resolves a bare .ps1 name on PATH", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { runDoctor } = await import("../src/doctor.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const saved = process.env[pathKey];
  try {
    writeFileSync(path.join(dir, "agent.ps1"), PS1_AGENT);
    process.env[pathKey] = dir + path.delimiter + saved;
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: "agent.ps1", ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.match(argv.command, /powershell\.exe$/i);
    assert.equal(argv.args.at(-3), path.join(dir, "agent.ps1"), "the bare name resolves to the script on PATH");
    const out = await runDoctor({ spawnSpec: spec });
    assert.equal(out.agent.found, true);
    assert.equal(out.agent.version, "ps1-agent 1.0");
  } finally {
    process.env[pathKey] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The probe builds its --version args from the spec as configured. Rewritten earlier, in
// resolveAcpSpawn, the spec already carried the PowerShell flags and the probe lost the script.
test("doctor reads a .ps1 launcher's version from a spec whose args name no acp token", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { runDoctor } = await import("../src/doctor.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    const script = path.join(dir, "agent.ps1");
    writeFileSync(script, PS1_AGENT);
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: script, ACP_AGENT_ARGS: "--stdio" }, () => resolveAcpSpawn());
    assert.equal(spec.command, script, "the spec stays as configured; the rewrite happens at the spawn");
    assert.match(spawnArgv(script, ["--version"], spec.options).command, /powershell\.exe$/i, "the probe must not go to cmd.exe");
    const out = await runDoctor({ spawnSpec: spec });
    assert.equal(out.agent.error, undefined);
    assert.equal(out.agent.version, "ps1-agent 1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .ps1 ACP_AGENT_COMMAND that does not exist is reported as spawn-failed", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { AcpClient } = await import("../src/acp-client.js");
  const missing = path.join(tmpdir(), "no-such-dir-xyz", "agent.ps1");
  const spec = withAgentEnv({ ACP_AGENT_COMMAND: missing, ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
  assert.equal(spec.command, missing);
  assert.equal(spawnArgv(spec.command, spec.args, spec.options), null, "nothing to launch");
  await assert.rejects(() => new AcpClient({ spawnSpec: spec }).start(), (err) => err.reason === "spawn-failed");
});

// cmd runs x.ps1.cmd for "x.ps1" through PATHEXT; only the .ps1 file itself goes to PowerShell.
test("only an existing .ps1 file itself is run through PowerShell", { skip: process.platform !== "win32" && "Windows launcher" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    writeFileSync(path.join(dir, "agent.ps1.cmd"), "@echo off\r\n");
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: path.join(dir, "agent.ps1"), ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.doesNotMatch(argv.command, /powershell\.exe$/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// On win32 every launcher went through cmd.exe, which mangled arguments (%VAR%, ^, quotes) and left
// cmd.exe as the child the bridge killed. The command is now found first and started by file type.
test("a bare agy resolves to agy.exe and spawns without cmd.exe", { skip: process.platform !== "win32" && "Windows launcher" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "exe route "));
  try {
    // What an npm install leaves beside a native binary: an sh script, a .cmd and a .ps1.
    for (const name of ["agy", "agy.cmd", "agy.ps1", "agy.exe"]) writeFileSync(path.join(dir, name), "");
    const env = { Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    assert.deepEqual(spawnArgv("agy", ["acp"], { shell: true, env }), { command: path.join(dir, "agy.exe"), args: ["acp"], options: { shell: false, env } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare name never lands on the extensionless file beside its .cmd", { skip: process.platform !== "win32" && "Windows launcher" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd route "));
  try {
    for (const name of ["agy", "agy.cmd"]) writeFileSync(path.join(dir, name), "");
    const env = { Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const launch = spawnArgv("agy", ["acp"], { shell: true, env });
    assert.equal(launch?.command, path.join(dir, "agy.cmd"));
    assert.equal(launch?.options.shell, true, "a .cmd still goes to cmd.exe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The lookup ran in the server's directory and the spawn in the workspace, so a relative launcher
// could be found in one and started from the other.
test("a relative launcher path is resolved where it was looked up", { skip: process.platform !== "win32" && "Windows launcher" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rel route "));
  const cwd = process.cwd();
  try {
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin", "agent.exe"), "");
    process.chdir(dir);
    assert.equal(spawnArgv(path.join("bin", "agent.exe"), [], { shell: true })?.command, path.join(dir, "bin", "agent.exe"));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the installed agy resolves to agy.exe and doctor reads its version directly", { skip: process.platform !== "win32" ? "Windows launcher" : !commandExists("agy") && "agy is not installed" }, async () => {
  const { runDoctor } = await import("../src/doctor.js");
  const launch = spawnArgv("agy", [...DEFAULT_AGENT_ARGS], { shell: true });
  assert.match(launch.command, /\\agy\.exe$/i);
  assert.equal(launch.options.shell, false);
  const out = await withAgentEnv({ ACP_AGENT_COMMAND: undefined, ACP_AGENT_ARGS: undefined }, () => runDoctor());
  assert.equal(out.agent.found, true);
  assert.match(out.agent.version ?? "", /^\d+\.\d+/);
});

const ARG_TABLE = ["a!b", "", "x\\", 'he said "hi"', "%OS%", "a&b|c", "^caret", "ünï ✓", "a b", "$HOME", "--flag=val"];

test("an .exe launcher receives every argument intact", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { AcpClient } = await import("../src/acp-client.js");
  const dir = mkdtempSync(path.join(tmpdir(), "exe args "));
  try {
    const dump = path.join(dir, "argv-dump.js");
    writeFileSync(dump, "process.stderr.write(JSON.stringify(process.argv.slice(2))); process.exit(3);\n");
    const client = new AcpClient({ spawnSpec: { command: process.execPath, args: [dump, ...ARG_TABLE], options: { shell: true } } });
    const exit = new Promise((resolve) => client.once("exit", resolve));
    await client.start();
    const info = await exit;
    assert.equal(info.code, 3, info.stderr);
    assert.deepEqual(JSON.parse(info.stderr), ARG_TABLE);
    await client.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reads an .exe launcher's version without cmd.exe", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { runDoctor } = await import("../src/doctor.js");
  assert.equal(spawnArgv(process.execPath, ["--version"], { shell: true })?.options.shell, false);
  const out = await runDoctor({ spawnSpec: { command: process.execPath, args: [], options: { shell: true } } });
  assert.equal(out.agent.version, process.version);
});

function findAppExecAlias() {
  const dir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps");
  let names = [];
  try { names = readdirSync(dir).filter((n) => /\.exe$/i.test(n)); } catch {}
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!lstatSync(file).isSymbolicLink()) continue;
      statSync(file);
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") return { dir, name };
    }
  }
  return null;
}

// A Store app's alias is a link into a folder this user cannot stat; stat fails, yet cmd runs it.
test("commandExists finds a Store app execution alias", { skip: process.platform !== "win32" ? "Windows launcher" : !findAppExecAlias() && "no app execution alias on this machine" }, () => {
  const { dir, name } = findAppExecAlias();
  const env = { Path: dir, PATHEXT: ".EXE" };
  assert.equal(commandExists(name.replace(/\.exe$/i, ""), env), true, "bare name resolves through PATHEXT");
  assert.equal(commandExists(name, env), true, "name with its extension");
  assert.equal(commandExists(path.join(dir, name), env), true, "a path is checked as given");
});

test("commandExists does not find a link whose target is gone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-exists-"));
  try {
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(path.join(dir, "missing"), path.join(dir, "gone.exe"), "junction");
    const env = { Path: dir, PATHEXT: ".EXE" };
    assert.equal(commandExists("gone", env), false);
    assert.equal(commandExists(path.join(dir, "gone.exe"), env), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
