import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

// The bin is a stdio server, so an unrecognised flag starts the transport and waits on stdin.
// The version has to come back without a host attached, and it has to be the version of this
// code rather than whatever a manifest pinned.
test("the binary answers --version and exits without starting the transport", async () => {
  // -v too: it is what a hand check reaches for, and falling through to the transport there
  // reads exactly like the wedged install the flag exists to rule out.
  for (const flag of ["--version", "-v"]) {
    const { stdout } = await run(process.execPath, [ENTRY, flag], { timeout: 10000 });
    assert.equal(stdout.trim(), PKG.version, `${flag} must print the version`);
  }
});

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// The launcher writes its pid and never answers --version; stdin EOF is a stdio host's shutdown.
// On win32 a child that is not detached dies with the server regardless.
test("a host shutdown during doctor's version probe stops the probe", { skip: process.platform === "win32" && "win32 kills it with the server" }, async () => {
  const pidFile = join(tmpdir(), `agy-shutdown-probe-${process.pid}-${Date.now()}`);
  const server = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      ACP_AGENT_COMMAND: fileURLToPath(new URL("./fixtures/version-hang-pid-stub.js", import.meta.url)),
      AGY_TEST_PIDFILE: pidFile,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  let pid;
  try {
    const send = (msg) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "doctor", arguments: {} } });
    const deadline = Date.now() + 10000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(isAlive(pid), "the probe is running when the host shuts down");
    server.stdin.end();
    await exited;
    assert.equal(isAlive(pid), false, "the probe must be gone when the server exits");
  } finally {
    if (pid && isAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    server.kill();
    rmSync(pidFile, { force: true });
  }
});
