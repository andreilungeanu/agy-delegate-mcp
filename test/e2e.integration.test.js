import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { mkdtemp } from "./fixtures/temp-dir.mjs";
import { tmpdir } from "node:os";
import { runDelegate } from "../src/delegate.js";

// Live agy: opt-in, spends quota. The cheapest model at its lowest level keeps a run small.
const RUN = process.env.ACP_E2E === "1";
const LIVE = { model: "gemini-3.8-flash", effort: "low" };

// A solid-colour PNG, built here so the test carries no binary fixture.
function solidPng(r, g, b, size = 16) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("e2e: agent edit reports the file, and a resume carries the conversation", { skip: !RUN }, async () => {
  const ws = await mkdtemp(join(tmpdir(), "agy-e2e-"));
  const first = await runDelegate({
    ...LIVE, workspace: ws, mode: "agent",
    spec: "Create a file named hello.txt containing exactly the word: marmalade",
  });
  assert.equal(first.stopReason, undefined);
  assert.ok(existsSync(join(ws, "hello.txt")), "hello.txt should exist");
  // agy reports the diff path as /C:/… on Windows; the bridge must resolve it to the workspace.
  assert.deepEqual(first.filesReportedByEditTools, ["hello.txt"]);
  assert.deepEqual(first.effectiveEffort, { thought_level: "low" });

  // A resume runs in a new agy process, which reopens the session at agy's defaults (#1460).
  const second = await runDelegate({
    ...LIVE, workspace: ws, mode: "ask", resumeSessionId: first.sessionId,
    spec: "Without reading any file: which word did you write into hello.txt in this conversation? Reply with the word only.",
  });
  assert.equal(second.resumed, true);
  assert.equal(second.effectiveModel, undefined, "the requested model was re-applied");
  assert.deepEqual(second.effectiveEffort, { thought_level: "low" });
  assert.match(second.result.toLowerCase(), /marmalade/);
});

test("e2e: plan mode returns the plan artifact and leaves the workspace alone", { skip: !RUN }, async () => {
  const ws = await mkdtemp(join(tmpdir(), "agy-e2e-plan-"));
  writeFileSync(join(ws, "calc.py"), "def add(a, b):\n    return a - b\n");
  const out = await runDelegate({
    ...LIVE, workspace: ws, mode: "plan",
    spec: "Plan how to fix add() in calc.py and add a unit test for it. Write the plan; do not change the code.",
  });
  assert.ok(out.plan, `expected a plan, got ${JSON.stringify(out)}`);
  assert.ok(out.plan.detail.length > 20);
  assert.ok(existsSync(out.plan.path), "the plan artifact exists on disk");
  assert.deepEqual(readdirSync(ws), ["calc.py"]);
  assert.equal(out.filesReportedByEditTools, undefined);
});

test("e2e: contextFiles reach agy as a resource link and an inline image", { skip: !RUN }, async () => {
  const ws = await mkdtemp(join(tmpdir(), "agy-e2e-ctx-"));
  const outside = await mkdtemp(join(tmpdir(), "agy-e2e-ctx-outside-"));
  writeFileSync(join(outside, "brief.txt"), "The project codename is HELIOTROPE.\n");
  writeFileSync(join(ws, "swatch.png"), solidPng(220, 20, 20));
  const out = await runDelegate({
    ...LIVE, workspace: ws, mode: "ask",
    contextFiles: [join(outside, "brief.txt"), "swatch.png"],
    spec: "Two questions. 1) What is the project codename in the attached brief? 2) What colour is the attached image? Answer as: codename, colour.",
  });
  assert.equal(out.protocolWarnings, undefined, JSON.stringify(out.protocolWarnings));
  assert.match(out.result, /HELIOTROPE/i);
  assert.match(out.result, /red/i);
});

test("e2e: an effort the model does not offer fails before the prompt", { skip: !RUN }, async () => {
  const ws = await mkdtemp(join(tmpdir(), "agy-e2e-effort-"));
  await assert.rejects(
    runDelegate({ model: "claude-sonnet-5-5", effort: "xhigh", workspace: ws, spec: "Say hi." }),
    (err) => {
      assert.equal(err.reason, "invalid-effort");
      assert.match(err.message, /Accepted: \[/);
      return true;
    }
  );
});
