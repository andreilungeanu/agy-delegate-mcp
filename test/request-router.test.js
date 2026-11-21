import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestRouter } from "../src/request-router.js";

function harness() {
  const responses = [];
  const router = createRequestRouter({
    respond: (id, result) => responses.push({ id, result }),
    respondError: (id, code, message) => responses.push({ id, error: { code, message } }),
  });
  return { router, responses };
}

// The request agy 1.5.13 sent for a run_command in default mode, options verbatim
// (docs/captures/edit-default-mode.jsonl). Its ids are strings.
test("request_permission selects agy's allow option", async () => {
  const { router, responses } = harness();
  await router("1", "session/request_permission", {
    sessionId: "s",
    toolCall: { toolCallId: "call_1", kind: "execute", status: "pending" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  assert.deepEqual(responses[0], { id: "1", result: { outcome: { outcome: "selected", optionId: "allow" } } });
});

test("request_permission prefers allow_always when offered", async () => {
  const { router, responses } = harness();
  await router(5, "session/request_permission", {
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  });
  assert.deepEqual(responses[0], { id: 5, result: { outcome: { outcome: "selected", optionId: "allow-always" } } });
});

test("request_permission with no options answers cancelled, not a selection without an id", async () => {
  const { router, responses } = harness();
  await router(7, "session/request_permission", { options: [] });
  assert.deepEqual(responses[0], { id: 7, result: { outcome: { outcome: "cancelled" } } });
});

// A request offering no allow kind must not fall through to opts[0] and return a reject id as a
// `selected` outcome: that is a silent denial dressed as an approval, against a bridge that
// advertises auto-approval.
test("request_permission with only reject options answers cancelled, never selects a reject", async () => {
  const { router, responses } = harness();
  await router(14, "session/request_permission", {
    options: [
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "reject-always", kind: "reject_always" },
    ],
  });
  assert.deepEqual(responses[0], { id: 14, result: { outcome: { outcome: "cancelled" } } });
});

test("unknown method fails safe with -32601, never hangs", async () => {
  const { router, responses } = harness();
  await router(8, "_antigravity/some_future_method", { weird: true });
  assert.equal(responses[0].id, 8);
  assert.equal(responses[0].error.code, -32601);
});

// -32603 is JSON-RPC's internal error. ACP assigns -32000 to auth_required, so answering a
// router exception with -32000 would tell the agent to authenticate.
test("catch path: a malformed request returns -32603, not ACP's -32000 auth_required", async () => {
  const { router, responses } = harness();
  await router(13, "session/request_permission", { options: "not-an-array" });
  assert.equal(responses[0].id, 13);
  assert.equal(responses[0].error.code, -32603);
});
