# delegate reference

What a result field or failure `reason` means and what to do next.

## Inputs

`model` takes the base id (`gemini-4-neon`) and `effort` the level. Omitted on a new session,
`model` is `gemini-4-hydrogen`; an account that does not offer it runs agy's default, with a
`protocolWarnings` entry. `agy models` and ACP's model
list spell each model with the level as a suffix (`gemini-4-neon-high`); a suffixed id fails as
`unknown-model`. `doctor` with `deep: true` lists the base ids.

`effort` is matched exactly against the levels the selected model advertises; `claude-sonnet-5-5`
offers no `xhigh`, for example.

## Result

| Field | Meaning |
| ----- | ------- |
| `result` | The final agent text: the whole stream for a tool-free turn, otherwise the text after the last tool call. |
| `resultSource` | Absent on the happy path. `"pre-tool-fallback"`: no final message closed the turn, so `result` is the last message before the final tool call; read `protocolWarnings` before trusting it. `"unfinished-tool"`: the turn ended with a tool call still running (a background command outlasted the wait, a cancel, a refusal or output cap, or a question asked through agy's question tool); `result` is agy's message from while it ran, and `protocolWarnings` names a command left running. `"none"`: no message, `result` is empty. A refusal with no tool left running is not a `resultSource` caveat: its text is the `result` and `stopReason` is set; judge by the diff. |
| `stopReason` | Present only when the turn did not end normally: a refusal, a cancel, or an output cap. A cancel before the prompt was sent: `cancelled` with an empty `result`. |
| `sessionId` | Pass as `resumeSessionId` (or to `cancel` and `steer`). |
| `resumed` | `true` only when a resume took. Absent after a fresh session or a resume that fell back; `protocolWarnings` says why. |
| `questions` | agy's open questions when the turn ended on its question tool: `{question, options, multiSelect?, recommended?}[]`. Answer by resuming with the answers in `spec`; you are not limited to the options. A question asked in prose is in `result`. |
| `plan` | `plan` mode, when agy wrote a plan artifact: `{path, overview?, detail?}`. `detail` is the plan's markdown. |
| `artifacts` | Other artifacts agy wrote this turn, `{path, summary?}[]`. The content stays in the file. |
| `filesReportedByEditTools` | Workspace files agy's edit tools reported, relative to `workspace` when inside it. Absent when none did, which does not mean nothing changed: shell edits leave no record. Artifacts are not listed. The git diff is authoritative. |
| `execution` | `toolCalls`: count per kind (`read`, `edit`, `execute`, …). `commands`: `{command, exitCode?, status?, runs?}`, the last 8, after up to 5 older ones that failed or did not complete; `commandsOmitted` counts the rest. A command run more than once appears once, at its last run; artifact writes are not counted. `status` appears only for a command that did not complete; a failed command still finishes as completed, so `exitCode` is the outcome. |
| `effectiveModel` | The base model id agy ran, when it differs from `model` and always when `model` was omitted. |
| `effectiveEffort` | The thinking level agy reported when the prompt went out: `{"thought_level": "high"}`. Absent when unconfirmed; never read absence as a level. |
| `usage` | Token counts for this turn (`scope: "turn"`): `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, `totalTokens`. A steered turn sums its replies. Excludes agy's continuation after a command it moved to the background. |
| `context` | `{used, size}`: the session's context fill and the model's window. Carries over a resume; near `size`, start a fresh session. |
| `cancelRequested` | A cancel was issued mid-run. Tells a clean finish from one where agy ignored the cancel. |
| `protocolWarnings` | Non-fatal diagnostics: dropped or sanitized fields, a failed resume, skipped `contextFiles`, a refused steer. Read it whenever present. |

## Failures

Errors come back as `delegate failed [<reason>]: …`.

| Reason | Next step |
| ------ | --------- |
| `invalid-spec`, `invalid-workspace`, `invalid-mode` | Fix the argument; nothing was spawned. |
| `unknown-model` | No prompt was sent; the message names the valid base ids. Fix `model`. |
| `invalid-effort` | No prompt was sent. With `Accepted: [...]`, retry the named session with the complete original `spec` and a listed value. With `Advertised: [...]`, report that the bridge failed to recognize the option rather than retrying. |
| `effort-options-unavailable` | No prompt was sent. Retry the named session once with the complete original `spec`; if it repeats, run `doctor` and report it rather than guessing a value. |
| `not-signed-in` | agy has no stored sign-in. Ask the user to run `agy` once in a terminal and sign in, then retry. |
| `resume-failed` | agy still lists the session (or its list could not be read) but it could not be resumed; nothing was started. Retry, or omit `resumeSessionId` to start fresh. (A session agy does not list starts fresh with a `protocolWarnings` entry.) |
| `agent-error` | agy returned a JSON-RPC error. Fix the argument if the message names one. |
| `hard-cap` | The 6 h cap elapsed. Resume the id in the message. |
| `spawn-failed` | agy could not be started. Install the Antigravity CLI and sign in by running `agy` once; `doctor` shows the launcher resolution. |
| `agent-exit` | The agent process died; stderr is included. Resume once; run `doctor` if it repeats. |
| `handshake-timeout` | agy wedged during setup. Resume the id if the message names one; otherwise, or if it repeats, run `doctor`. |

Timeout and exit failures also name the last tool call, the time since the last frame, the turn
title, files reported edited and the `resumeSessionId`, plus a note if an earlier resume had
failed, meaning none of that work was in context.

## Resume

agy reopens a resumed session at its defaults, so the bridge re-sends `mode` every time, and
`model` and `effort` when it has them. A resume that omits `model` uses the model this server
process last set on the session; an omitted `effort` uses the last one set, unless `model`
changes. A server with no record of the session (restarted, or not the one that ran it) runs
`gemini-4-hydrogen` when `model` is omitted, and says so in `protocolWarnings`. For a `delegate`
run as an MCP task, the task id works as `resumeSessionId` while this server process runs.

## Running turns

agy sends nothing while a shell command runs, so mid-turn silence is normal and is not timed
out. Only the 60 s setup deadline and the 6 h cap apply. When agy moves a long command to the
background and ends its turn, the bridge waits up to 10 min for the command to finish and agy to
report on it, then returns that report.

The first progress notification is `session ready: <sessionId>`, the id `cancel` and `steer`
take while the turn runs. `cancel` is advisory; call again with `force: true` to kill the
process after a grace period; a force that cannot confirm the exit reports `cancelled`. After a
`steer`, agy stops a running command to follow it and finishes a reply it is already writing,
so `result` can open with the end of that reply. A refused steer lands in `protocolWarnings` and
the turn continues; in ask mode the steer message carries ask mode's instruction.
