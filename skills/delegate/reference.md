# delegate tool reference

Architecture: MCP host → MCP `delegate` → agy-delegate-mcp → **agy** (Antigravity CLI) over ACP,
launched as `agy acp --dangerously-skip-permissions --disable-telemetry`.

## Input

| Field | Default | Description |
| ----- | ------- | ----------- |
| `spec` | — | The task brief, sent as written. Name files in it for the agent to read, or attach them with `contextFiles`. |
| `mode` | `agent` | `agent`, `plan`, or `ask`. |
| `model` | agy's default | Base model id (`gemini-4-neon`, `gemini-3.8-flash`). Rejected before the turn starts if agy does not offer it; the error names the ids it does. |
| `effort` | — | agy thinking level for the selected model (`low`, `medium`, `high`, `xhigh`). Exact and model-specific. |
| `workspace` | required | Working directory for the agent. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call. |
| `resumeSessionId` | — | Resume an existing agy session. |
| `contextFiles` | — | Paths to attach instead of pasting contents into `spec`. Text files become `resource_link`s the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against `workspace` but are **not restricted to it**. Attachments are untrusted — the bridge does not scan for prompt injection. Skips are reported in `protocolWarnings`, never fatal. |

agy offers each model in two spellings: `agy models` and ACP's model list carry the level as a
suffix (`gemini-4-neon-high`), while the model config option carries the base id
(`gemini-4-neon`). `model` takes the base id and `effort` the level; a suffixed id fails as
`unknown-model`. `doctor` with `deep: true` lists the base ids.

`effort` is sent as agy's `thought_level` option, matched exactly against the levels the selected
model advertises — `claude-sonnet-5-5` offers no `xhigh`, for example. A level the model does
not advertise fails as `invalid-effort` with `Accepted: [...]`; a missing or unusable option list
fails as `effort-options-unavailable`. Both happen before `session/prompt`. For `invalid-effort`,
retry with the returned `resumeSessionId`, the complete original `spec`, and a listed value. For
`effort-options-unavailable`, keep the same session and complete spec but do not guess a value.

## Return value

| Field | Description |
| ----- | ----------- |
| `result` | Final agent text: the complete stream for tool-free turns, or only text emitted after the final tool completes. Empty when no final message was emitted. |
| `resultSource` | Present only as a caveat on `result`; **absent on the happy path**, where `result` is simply the answer. `"pre-tool-fallback"` (no final message closed the turn; `result` is the last message before the agent's final tool call — read `protocolWarnings` before trusting it), `"unfinished-tool"` (the turn ended with a tool call still running: a command agy moved to the background was still running when the background wait ran out, a cancel arrived, or a refusal or output cap ended the turn, and it stopped with agy, or agy asked a question through `ask_question`, which a resume answers; `result` is agy's message from while it ran, and `protocolWarnings` names the tool) or `"none"` (no message; `result` is empty). A refusal with no tool left running is not a caveat here — its text is the `result`; judge by the diff. |
| `stopReason` | Present only when it is not the ordinary `end_turn` — a refusal, a cancel, or an output cap. Absence means the turn ended normally. A cancel before the prompt was sent sends no prompt: `cancelled` with an empty `result`. |
| `sessionId` | Session id for resume. |
| `effectiveModel` | The base model id agy ran, present when it differs from `model` and always when `model` was omitted. |
| `effectiveEffort` | The thinking level in force, as agy reported it when the prompt went out — `{"thought_level": "high"}`. Present whenever known, even when `effort` was omitted. Absent when agy did not confirm a value, so never read absence as a level. |
| `usage` | Token counts agy reported for this turn, labelled `scope: "turn"`: `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, `totalTokens`. A steered turn sums its replies: `inputTokens`, `outputTokens` and `totalTokens` appear only when every reply that reported usage carried them; a cached or thought count a reply left out counts as 0. Does not include agy's continuation after a command it moved to the background. Absent when agy reported none. |
| `context` | `{used, size}`: tokens the session's conversation occupies and the model's context window, from agy's last `usage_update` of the turn. Absent when agy sent none. Carries over a resume, so a session near `size` is a candidate for a fresh session with a rewritten brief. |
| `filesReportedByEditTools` | Workspace files the agent reported editing (native ACP diff events), relative to `workspace` when inside it. Omitted when empty — absence means no edit tool reported a change, **not** that nothing changed: shell-driven edits leave no diff event; the git diff is authoritative. agy's own artifacts are not listed here. |
| `resumed` | Present and **`true` only** when a resume took (the returned session id matched `resumeSessionId`). Absent for a fresh session or a resume that fell back — the fallback is explained in `protocolWarnings`. |
| `cancelRequested` | `true` when a cancel was issued mid-run. Distinguishes a clean finish from one where the agent ignored the cancel and completed anyway. |
| `plan` | Plan mode only, when agy wrote a plan artifact: `{path, overview?, detail?}`. |
| `artifacts` | Other artifacts agy wrote this turn, `{path, summary?}[]`. Content stays in the file. |
| `protocolWarnings` | Non-fatal diagnostics that did not justify failing the call: dropped or sanitized ACP fields, a failed resume, skipped `contextFiles`. Read it whenever it is present. |

### Artifacts and `plan`

agy writes plans as artifacts: files under `~/.gemini/antigravity-cli/brain/<sessionId>/`,
outside the workspace, created by a `write_file` call that carries `ArtifactMetadata`. In plan
mode agy's message points at the artifact instead of containing it, so the bridge returns the
last artifact of the turn as `plan`:

| Field | Description |
| ----- | ----------- |
| `plan.path` | Where agy saved the plan. |
| `plan.overview` | agy's one-line summary of the artifact (may be absent). |
| `plan.detail` | The plan's markdown (may be absent). |

## Mode behavior

agy's modes are `default`, `accept-edits`, `auto` and `plan`. The bridge sets one via
`session/set_mode` before every prompt, and agy runs with `--dangerously-skip-permissions`; any
`session/request_permission` that still arrives is approved too. `plan` and `ask` describe how
the agent behaves, not what the bridge permits, so **review the git diff after every run**,
whatever mode you asked for.

- **`agent`** — agy `default`; implements.
- **`plan`** — agy `plan`; writes a plan artifact. agy still runs read-only commands to explore.
- **`ask`** — agy `default` with `Answer the question below. Do not edit files or run commands
  that change state.` placed before `spec`. agy has no ask mode.

## Failures

Errors come back as `delegate failed [<reason>]: …`.

| Reason | Meaning | Action |
| ------ | ------- | ------ |
| `invalid-spec` | `spec` was blank. Nothing was spawned. | Fix the argument. |
| `invalid-workspace` | `workspace` was omitted, blank, does not exist, or is not a directory. Nothing was spawned. | Fix the argument. |
| `invalid-mode` | `mode` was not `agent`, `plan` or `ask`. Nothing was spawned. | Fix the argument. |
| `unknown-model` | `model` is not a base id agy offers; the message names the valid ids. | Fix the argument. |
| `invalid-effort` | `effort` is not a level the selected model advertises (`Accepted: [...]`), or no option the model advertises was recognized as effort (`Advertised: [...]`). No prompt was sent. | With `Accepted`, retry the named session with the complete original `spec` and one of those values. With `Advertised`, report that the bridge failed to recognize the option rather than retrying. |
| `effort-options-unavailable` | The selected model did not report a usable thinking-level list. No prompt was sent. | Retry the named session once with the complete original `spec`; if it repeats, run `doctor` and report the capability failure rather than guessing. |
| `resume-failed` | `resumeSessionId` could not be resumed, and agy still lists that session (or its session list could not be read) — no fresh session was started. | Retry; omit `resumeSessionId` to start fresh deliberately. A session agy does not have is not this: it starts fresh and reports a `protocolWarnings` entry. |
| `agent-error` | agy rejected a request (JSON-RPC error). | Read the message; fix the argument if it names one. |
| `hard-cap` | The 6h absolute cap elapsed. | Resume the id in the message. |
| `idle-timeout` | Opt-in mid-turn idle guard tripped (off by default). | Resume the id in the message. |
| `spawn-failed` | The agent process could not be started at all (launcher missing or not executable). | Install the Antigravity CLI and sign in by running `agy` once; `doctor` shows the launcher resolution. |
| `not-signed-in` | agy has no stored sign-in and rejected the session (ACP `-32000`, "Authentication required"). Nothing was prompted. | Ask the user to run `agy` once in a terminal and sign in, then retry. |
| `agent-exit` | The agent process died; stderr is included. | Resume once; run `doctor` if it repeats. |
| `handshake-timeout` | No prompt ever went in flight — the agent wedged during setup. Setup runs past `session/new`, so a session may already exist. | Resume the id if the message names one; run `doctor` if it names none, or if resuming repeats the stall. |
| `aborted` | The MCP host interrupted the request (e.g. Esc in Claude Code). Usually fires mid-turn against a live session, so a `resumeSessionId` is supplied; only an abort that arrives before the session exists has none. | Deliberate, so normally stop — but resume the id if the work should continue. |

Timeout, abort and exit failures additionally name the last tool call, how long the wire has
been quiet, the turn title, files reported edited, and a `resumeSessionId` — plus a note if an
earlier resume had already failed, meaning none of that work was in context. The raw ACP
transcript is not included: nothing in it changes what you can do, and it is large. Set
`AGY_DELEGATE_TRANSCRIPT=<frames>` to append it when debugging the bridge itself.
`ACP_LOG_SIZE` bounds retention (2000 frames) and so caps what this can return; at `0` nothing
is recorded and it returns nothing at all.

## Resume

Cross-process resume via `session/resume`, which restores the conversation without replaying it.
agy reopens a resumed session at its default model, thinking level and mode, so the bridge sends
`mode` again on every resume, and `model` and `effort` whenever it has them. A resume that leaves
`model` out uses the model this server process recorded for that session (the one agy ran when
`model` or `effort` was last set); one that leaves `effort` out uses the effort last set, unless
`model` changes. A server with no record of the session (restarted, or not the one that ran it)
leaves agy's defaults; a resume that then omits `model` says so in `protocolWarnings`. An id agy does not list starts a fresh
session with a `protocolWarnings` entry; any other resume failure is `resume-failed` and starts
nothing.

## Progress

The first notification is `session ready: <sessionId>`, the id `cancel` and `steer` take while the
turn runs. Thinking, streamed response sentences, tool starts, edited files, and the turn title the agent
picks (`turn titled: …`) arrive as ephemeral MCP progress notifications — separate from
`result`. The title is a live label for telling concurrent delegations apart and is also named
in timeout errors; it is not returned in the result.

While a turn is running, a `still working — <elapsed>, last agent frame <age> ago, running: <tool>`
heartbeat is emitted periodically. A large frame age is normal during a long shell command; it is
not by itself a sign of trouble.

## Timeouts

agy does not stream shell output over ACP: a command emits nothing until it exits, so mid-turn
silence carries no information about liveness. The bridge therefore reports silence rather than
acting on it.

| Guard | Default | Scope |
| ----- | ------- | ----- |
| Handshake deadline | 60 s | Spawn through session setup only, where silence really does mean a wedged agent. |
| Hard cap | 6 h | Whole delegation, absolute. |
| Mid-turn idle guard | off | Opt-in; silence during a turn does not settle the session. |
| Background wait | 10 min | agy moves a shell command that outlasts the wait it set for it (`WaitMsBeforeAsync`) to the background and ends the turn. The bridge keeps agy running until the command finishes and agy reports on it, then returns that report. |

Overrides: `AGY_DELEGATE_HANDSHAKE_MS`, `AGY_DELEGATE_HARD_CAP_MS`, `AGY_DELEGATE_BACKGROUND_WAIT_MS`,
`AGY_DELEGATE_IDLE_MS` (unset or `0` = disabled). On the other three, a non-positive or malformed value falls back to the
default. Agent process exit is detected directly and fails fast regardless of these.

A delegation is still cancellable at any time via the `cancel` tool or a host interrupt.

## Other tools

**`cancel`** — `{sessionId, force?}` → `status: "cancelled" | "killed" | "not-running" | "not-found"`.
`session/cancel` is best-effort and the agent may finish the turn; the session stays
cancellable afterwards, so a follow-up call with `force: true` kills the process after a
grace period. `killed` means the process was observed to exit; a force that cannot confirm the
exit reports `cancelled` and keeps the session cancellable, so force can be retried.
`not-running` means the turn already ended — the session is still resumable via
`resumeSessionId`, and with `force` the agent's shutdown is cut short; `not-found` means the id is
not in this process's recent session history.

**`steer`** — `{sessionId, message}` → `status: "steered" | "not-ready" | "not-running" | "not-found"`.
Sends `message` into the running turn as a new instruction; the pending `delegate` call returns
the redirected turn's result, with `usage` summed over the turn's replies. agy stops a running
command to follow it and finishes a reply it is already writing first, so `result` can open with
the end of that reply. In ask mode the message carries ask mode's instruction. `steered` means the
message was sent. agy refusing it lands in the delegate result's `protocolWarnings` and the turn
continues unredirected; a steered turn that then fails fails the `delegate` call, as the turn would.
`not-ready` means the delegation has not sent its prompt yet — retry; `not-running` means the turn
ended, was cancelled or lost its agent — resume instead; `not-found` means the id is not in this
process's recent session history. Usable only from a host that can call a tool while `delegate` is
still running.

**`doctor`** — `{deep?}`. Always reports plugin version, MCP client `capabilities`,
launcher resolution and `agent.found`, plus runtime info. With
`deep: true` it adds `agent.handshake`: `{ok, protocolVersion, agentCapabilities, models,
currentModel, currentModelOptions, modes, tier}`, or `{ok: false, error}` — not signed in, or a
timeout. `agent.handshake.models` is the list of base ids `model` accepts; `currentModelOptions`
is `{id, name?, category?, values, currentValue?}[]` for `currentModel` only, not for a `model`
you are about to pass; `tier` is the account plan agy reports. `protocolVersion`,
`currentModel` and `tier` are `null` when agy reported none.

`agent.version` is the launcher's `--version` output, or `null`. `found: false` means it is not
installed; `found: true` with a `null` version means it exists but did not answer, and
`agent.error` says why (e.g. the probe timed out).
