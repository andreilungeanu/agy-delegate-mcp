import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitArgs, resolveAcpSpawn, commandExists, spawnCommandLine, spawnArgv } from "../src/spawn.js";

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
  assert.equal(commandExists("plainagy", env), true, "extensionless file");
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
  assert.doesNotMatch(spawnArgv(spec.command, spec.args, spec.options).command, /powershell\.exe$/i);
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
