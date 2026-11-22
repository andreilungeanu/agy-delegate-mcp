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
        // The allow kinds only: selecting a reject option would read as approving the denial.
        // agy offers allow_once and reject_once.
        const pick =
          opts.find((o) => o.kind === "allow_always") ||
          opts.find((o) => o.kind === "allow_once");
        // No allow option: answered cancelled rather than a selection with no optionId.
        if (!pick?.optionId) return respond(id, { outcome: { outcome: "cancelled" } });
        return respond(id, { outcome: { outcome: "selected", optionId: pick.optionId } });
      }
      return respondError(id, -32601, `Unhandled method: ${method}`);
    } catch (err) {
      // -32603, not -32000, which ACP reserves for auth_required.
      if (id != null) return respondError(id, -32603, `Router error: ${err?.message || err}`);
    }
  };
}
