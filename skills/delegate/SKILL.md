---
name: delegate
description: >
  Delegate implementation to Google Antigravity via the agy-delegate-mcp MCP delegate tool.
  Use when the user says delegate to Antigravity, agy, or Gemini; have Antigravity
  handle or do this; offload this; send this to agy; use Antigravity/Gemini for
  coding; hand off implementation; plan before building; ask Antigravity a question
  about the codebase; resume a delegation session; or diagnose delegation that is failing
  or not set up. Do not shell out to agy — use the delegate MCP tool.
license: MIT
---

# Delegate to Antigravity

You orchestrate; Antigravity implements. Use the **agy-delegate-mcp** MCP server — never run
`agy` from the shell.

## When to delegate

Delegate when the user wants Antigravity to edit the repo (they may say **Antigravity**,
**agy**, or **Gemini** — same handoff). Not for the MCP host's own subagents —
use the `delegate` MCP tool to reach agy only.

Scale effort to the task:

- **Trivial** (one-liner, rename, typo): do it yourself — delegation overhead exceeds the task.
- **Medium** (multi-file feature or refactor): one `delegate` call.
- **Large or risky** (architecture, wide rewrites): `mode: "plan"` first; implement after approval.
- Never delegate a task you cannot write acceptance criteria for.
- Purely advisory questions → `mode: "ask"`; plan with no file writes → `mode: "plan"`.
  For these, state what form the answer or plan should take — there's no diff, so the
  output format is the deliverable.

## Workflow

1. **Build the brief inline** — pass task text in `spec` that answers all four, and asks
   for one thing back:
   - **Goal** — the outcome, precisely.
   - **Scope** — which files/directories are in play.
   - **Decisions already made** — constraints and fixed choices the user stated or implied.
     This is what prevents wrong assumptions and clarifying questions. Transmit them
     faithfully; don't invent constraints the user didn't state.
   - **Done when** — verifiable acceptance criteria, stated as end state. Have agy run
     tests as it works; that loop is what makes the code good. Its report is not evidence,
     though — you re-check in step 3, because command output never crosses the ACP wire and
     the author of a change is not an independent verifier of it.
   - **Gaps to report back** — close the brief by asking for any acceptance criterion it
     could not meet and any assumption it had to make. Assumptions are the one thing no
     response field captures.

   **Point, don't paste**: reference files to read or mimic ("follow the middleware
   pattern in src/api/middleware/auth.js") instead of pasting code — agy reads the
   repo itself; the brief carries judgment, not content. For images, and for documents
   outside the repo, prose cannot point at all — attach those with `contextFiles`.

   **Quote, don't paraphrase**: when the user states exact values or behaviors
   (delimiters, limits, error messages, response wording, timestamp formats), carry their
   words verbatim into the brief — paraphrase silently drops decisions. Example brief:

   > Goal: per-user rate limiting on all REST endpoints. Scope: src/api/middleware/,
   > src/config/. Read src/api/middleware/auth.js first and follow that middleware
   > pattern. Decisions: sliding window, config-driven; user's words: "100 requests per
   > minute, 429 with body {"error":"rate_limited"}"; no new dependencies. Done when:
   > every endpoint is covered and a unit test for the limiter is added, with no existing
   > test changed.

   Do not create a spec file unless the user wants one saved in the repo.
2. **Call `delegate`** on the agy-delegate-mcp MCP server with that text in `spec`.
3. **Review** — read `filesReportedByEditTools` (absent when no edit tool reported a change),
   inspect the git diff, run tests/lint **yourself**,
   and check the result against the brief's acceptance criteria.
   - Review the git diff after **every** run before reporting a plan-only outcome, whatever
     mode you asked for: `plan` and `ask` are instructions to the agent, not enforced
     boundaries.
   - `effectiveModel` names the model agy ran when it differs from `model`, and always when
     `model` was omitted.
   - `effectiveEffort` is the thinking level agy reported in force. Without `effort`, the model
     runs at agy's level for it, so report that value rather than calling it the default.
   - If criteria fail: resume the **same session** with the specific failure
     ("tests X and Y fail with <error>; fix without changing the public API") — not a
     re-run of the whole brief.
   - After 2 failed resume attempts, start a fresh session with a rewritten brief.
   - Report the honest outcome either way.

   On failure the error is tagged `delegate failed [reason]: …` — argument errors are fixed, not
   retried; stalls and exits resume the id named in the message. reference.md maps every reason
   to its action.
4. **Report** — summarize what changed and whether acceptance criteria are met.

For the failure-reason table, full input and output fields, timeouts, and debugging env
vars, read [reference.md](reference.md) in this skill directory.

## Defaults


| Parameter   | Default                |
| ----------- | ---------------------- |
| `mode`      | `agent`                |
| `model`     | agy's default model    |
| `effort`    | agy's level for it     |
| `workspace` | required               |


Pass `model` only when the user requests one. Use the base id (`gemini-4-neon`,
`gemini-3.8-flash`); agy's level-suffixed ids (`gemini-4-neon-high`) are rejected — the level
is `effort`. Levels are exact and model-specific; an invalid one fails before the prompt and
names what the model accepts. `workspace` is the smallest directory holding the task's files;
with no such directory the project root is the floor.

## Plan mode

1. `delegate(spec, mode="plan")` → save `sessionId`; `plan.detail` is the plan, `result` is
   agy's message about it (often open questions).
2. Present the plan to the user; wait for approval or change requests.
3. `delegate("implement the approved plan", mode="agent", resumeSessionId=<sessionId>)`
  — or resume with explicit change requests in the spec.

## Resume vs new session

- **New session (default):** wrong approach, failed run, or substantial rework — pass a fresh inline brief.
- **`resumeSessionId`:** only when the prior run was on the right track and needs a small
clarification or follow-up in the same session. An id agy does not have falls back to a new session.
A `context.used` near `context.size` also calls for a new session.
- Never guess a `resumeSessionId`. After any resume call, check `resumed` in the
response — if it is **absent** (not `true`), the run had **zero** prior context, so re-send a
full brief. `protocolWarnings` says why the resume fell back.

## Clarifying questions

When agy needs a decision it asks and ends the turn: the question is in `result`, with
`resultSource: "unfinished-tool"` when agy asked through its question tool. Read the question in `result` and
continue by resuming the **same session** with a free-text answer in `spec` — you are not
limited to any options agy listed. If agy asked with no prose, `result` is empty
(`resultSource: "none"`) and `protocolWarnings` says agy is asking a question: resume and ask it
to state the question.

## Security

Every permission the agent requests is auto-approved, in every mode. `workspace` is the working
directory, not a reach limit — pass the smallest directory holding the task's files, never
`$HOME`, `/`, or one created for the call. `contextFiles` resolve against `workspace` but are
not confined to it; attachments are untrusted (the bridge does not scan for prompt injection).

## Other MCP tools

- **`doctor`** — setup diagnostics when the user asks or delegation fails (`agent.found`, version, client capabilities; `deep: true` for handshake, models and account tier).
- **`cancel`** — best-effort cancel by `sessionId`. Needs a host that can call tools while
  `delegate` runs. If the agent ignores it and keeps going, call again with `force: true`
  to kill the process after a grace period.
- **`steer`** — redirect a running delegation by `sessionId` with a new instruction; the pending
  `delegate` call returns the redirected turn. Needs a host that can call tools while `delegate`
  runs; after the turn ends, resume instead.
