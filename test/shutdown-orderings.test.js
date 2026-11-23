import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { installSignalCleanup } from "../src/server.js";

// Signals are handled on POSIX only, where each agent has its own process group.
const SIGNAL_CODES = process.platform === "win32" ? {} : { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
const OUTCOMES = ["true", "false", "reject"];
const HANDLES = ["agent", "handshaking"];

function fakeAcpClientHandle(name, world) {
  const h = { name, attempts: [], kills: [], confirmed: false };
  let inflight = null;
  h.client = {
    stop: () => {
      if (h.confirmed) return Promise.resolve(true);
      if (inflight) return inflight;
      let settle;
      const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      h.attempts.push({ settle, outcome: null });
      inflight = result.then((seen) => {
        inflight = null;
        if (seen) { h.confirmed = true; world.delegationReturns(h); }
        return seen;
      }, (err) => { inflight = null; throw err; });
      return inflight;
    },
    killNow: () => { h.kills.push({ afterExitSeen: h.confirmed }); },
  };
  return h;
}

async function replay(choices) {
  const world = { exit: null, codes: [], signals: [], eof: false, scheduled: [], inScheduled: false, rejections: [], violations: [] };
  const [agent, handshaking] = HANDLES.map((name) => fakeAcpClientHandle(name, world));
  const handles = [agent, handshaking];
  const map = new Map([["sess-agent", new Set([agent])]]);
  const pending = new Set([handshaking]);
  world.delegationReturns = (h) => {
    h.returned = true;
    for (const set of map.values()) set.delete(h);
    pending.delete(h);
  };
  const onRejection = (err) => world.rejections.push(err);
  process.on("unhandledRejection", onRejection);
  const before = Object.fromEntries(Object.keys(SIGNAL_CODES).map((s) => [s, process.listeners(s)]));
  const expectedSoFar = () => (world.signals.length ? SIGNAL_CODES[world.signals[0]] : 0);
  try {
    installSignalCleanup(map, {
      pending,
      stdin: world.stdin = new EventEmitter(),
      exit: (code) => { world.exit ??= { code, signals: world.signals.length, waited: world.inScheduled }; },
      setExitCode: (code) => world.codes.push(code),
      schedule: (fn) => world.scheduled.push(fn),
    });
    const possible = () => {
      if (world.exit) return [];
      const out = [];
      if (!world.eof) out.push("eof");
      // The same signal twice too: a second Ctrl-C is the usual way to force an exit.
      if (world.signals.length < 2) out.push(...Object.keys(SIGNAL_CODES));
      if (world.scheduled.length) out.push("scheduled-exit");
      for (const h of handles) {
        const i = h.attempts.findIndex((a) => a.outcome === null);
        if (i !== -1) for (const o of OUTCOMES) out.push(`${h.name}.stop#${i}=${o}`);
        if (!h.returned && !h.confirmed && h.attempts.length && i === -1) out.push(`${h.name}.delegation-returns`);
      }
      if (!handshaking.sessionOpened && !handshaking.returned) out.push("handshaking.session-opens");
      return out;
    };
    for (const choice of choices) {
      const shuttingDown = world.eof || world.signals.length > 0;
      if (choice === "eof") { world.eof = true; world.stdin.emit("end"); }
      else if (choice in SIGNAL_CODES) { world.signals.push(choice); process.emit(choice); }
      else if (choice === "scheduled-exit") { world.inScheduled = true; world.scheduled.shift()(); world.inScheduled = false; }
      else if (choice === "handshaking.session-opens") {
        handshaking.sessionOpened = true;
        pending.delete(handshaking);
        map.set("sess-handshaking", new Set([handshaking]));
      } else if (choice.endsWith(".delegation-returns")) world.delegationReturns(handles.find((h) => choice.startsWith(`${h.name}.`)));
      else {
        const [, name, i, outcome] = /^(\w+)\.stop#(\d+)=(\w+)$/.exec(choice);
        const attempt = handles.find((h) => h.name === name).attempts[Number(i)];
        attempt.outcome = outcome;
        if (outcome === "reject") attempt.settle.reject(new Error("stop failed"));
        else attempt.settle.resolve(outcome === "true");
      }
      if (!shuttingDown && (world.eof || world.signals.length) && world.codes.at(-1) !== expectedSoFar()) {
        world.violations.push(`exit code not set when shutdown began (${world.codes.at(-1)})`);
      }
      if (choice in SIGNAL_CODES && world.signals.length === 2 && !world.exit) world.violations.push("a second signal did not exit at once");
      await new Promise((r) => setImmediate(r));
    }
    return { world, handles, next: possible() };
  } finally {
    process.off("unhandledRejection", onRejection);
    for (const [s, listeners] of Object.entries(before)) {
      for (const l of process.listeners(s)) if (!listeners.includes(l)) process.removeListener(s, l);
    }
  }
}

function check({ world, handles, next }) {
  const out = [...world.violations];
  if (world.rejections.length) out.push("an unhandled rejection");
  for (const h of handles) {
    if (h.kills.some((k) => k.afterExitSeen)) out.push(`killNow reached ${h.name} after its stop saw the exit (the bug 2801383 fixed)`);
  }
  const { exit } = world;
  if (!exit) {
    if (next.length === 0 && (world.eof || world.signals.length)) out.push("shutdown never exited once every stop settled");
    return out;
  }
  const bySecondSignal = exit.signals >= 2;
  const code = bySecondSignal ? SIGNAL_CODES[world.signals[1]] : world.signals.length ? SIGNAL_CODES[world.signals[0]] : 0;
  if (exit.code !== code) out.push(`exited ${exit.code}, expected ${code} (the bug 5629004 fixed)`);
  if (!bySecondSignal && world.codes.at(-1) !== code) out.push(`exit code left at ${world.codes.at(-1)}, expected ${code} (the bug 5629004 fixed)`);
  if (!bySecondSignal && !exit.waited) out.push("exited outside the scheduled exit");
  for (const h of handles) {
    if (!h.attempts.length && !h.kills.length) out.push(`${h.name} was never stopped`);
    if (h.confirmed) continue;
    if (bySecondSignal) {
      if (!h.kills.length) out.push(`the second signal exited without killing ${h.name} (the bug f041431 and 5629004 fixed)`);
    } else {
      if (h.attempts.some((a) => a.outcome === null)) out.push(`exited while ${h.name}'s stop was running (the bug 283e652 and 8633dd1 fixed)`);
      if (h.attempts.length < 2) out.push(`exited without retrying ${h.name}'s stop (the bug 8633dd1 fixed)`);
    }
  }
  return out;
}

const owner = (event) => HANDLES.find((name) => event?.startsWith(`${name}.`));
const swappedOrderExplored = (prev, next) => owner(prev) === "handshaking" && owner(next) === "agent";

function digest({ world, handles, next }) {
  return JSON.stringify({
    exit: world.exit, codes: world.codes, scheduled: world.scheduled.length, rejections: world.rejections.length,
    violations: world.violations, next: [...next].sort(),
    handles: handles.map((h) => [h.attempts.map((a) => a.outcome), h.kills, h.confirmed, !!h.returned, !!h.sessionOpened]),
  });
}

test("shutdown keeps its promises under every order of signals, stdin EOF and stop outcomes", { timeout: 300000 }, async () => {
  const found = new Map();
  let paths = 0;
  const stack = [[]];
  while (stack.length) {
    const path = stack.pop();
    const run = await replay(path);
    for (const v of check(run)) if (!found.has(v)) found.set(v, path.join(", "));
    const next = [];
    for (const c of run.next) {
      if (!swappedOrderExplored(path.at(-1), c)) { next.push(c); continue; }
      const [here, swapped] = [await replay([...path, c]), await replay([...path.slice(0, -1), c, path.at(-1)])];
      if (digest(here) !== digest(swapped)) found.set(`${path.at(-1)} and ${c} do not commute, so skipping one order hides states`, path.join(", "));
    }
    if (next.length === 0) paths++;
    else for (const c of next) stack.push([...path, c]);
  }
  const report = [...found].map(([v, path]) => `${v}\n  after: ${path}`).join("\n");
  assert.equal(found.size, 0, `${found.size} broken over ${paths} orderings:\n${report}`);
});
