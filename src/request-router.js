/**
 * @param {{
 *   respond: (id: any, result: any) => void,
 *   respondError: (id: any, code: number, message: string) => void,
 * }} deps
 */
export function createRequestRouter({ respond, respondError }) {
  return async function handle(id, method, params) {
    try {
      if (method === "session/request_permission") {
        const opts = params?.options || [];
        // The two allow kinds only. Taking opts[0] when neither is offered returned a reject
        // id under a `selected` outcome, which the agent reads as an approval of the denial —
        // a silent skip from a bridge that advertises auto-approval. agy offers allow_once
        // ("allow") and reject_once ("deny").
        const pick =
          opts.find((o) => o.kind === "allow_always") ||
          opts.find((o) => o.kind === "allow_once");
        // Selecting nothing is not a selection: an options-less request answered with
        // optionId undefined is a malformed ACP response, and a request offering no allow
        // option is one this bridge can approve nothing in. Say cancelled to both and let the
        // agent decide what to do about it.
        if (!pick?.optionId) return respond(id, { outcome: { outcome: "cancelled" } });
        return respond(id, { outcome: { outcome: "selected", optionId: pick.optionId } });
      }
      return respondError(id, -32601, `Unhandled method: ${method}`);
    } catch (err) {
      // -32603, not -32000: ACP assigns -32000 to auth_required, and a bug on this side
      // reported as "authenticate" sends the agent down a recovery path that cannot work.
      if (id != null) return respondError(id, -32603, `Router error: ${err?.message || err}`);
    }
  };
}
