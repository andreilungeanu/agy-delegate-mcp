import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitArgs, resolveAcpSpawn, commandExists } from "../src/spawn.js";

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
