# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.0.1] - 2026-11-24

### Changed

- A finished task is kept for its hour however many finish, where only the last 100 were kept.
- Every session the server has seen keeps the model and effort a resume re-applies, and `cancel`
  and `steer` tell it from an unknown id, where only the last 500 sessions were kept.

### Fixed

- The server shuts down, stopping agy, when its stdio transport closes. When the server's stdout
  broke, as it does when the host dies, the transport paused stdin, no stdin EOF arrived, and the
  server and agy kept running.
- A completed task's result carries `resultType: "complete"`, as the `tools/call` result it stands
  for, which the tasks extension's client schema requires.
- A task id resumes its session for as long as the server runs, not only for the hour its task is
  kept.
- A finished task's status message is its error, or none, instead of its last progress line.
- `tasks/update` refuses a request with no `inputResponses`.

## [2.0.0] - 2026-11-23

`delegate` no longer holds your agent while agy works. In an interactive Claude Code CLI session
it runs as an MCP task: your agent stays free to plan, review or start the next delegation, and
agy's result arrives when its turn ends. Codex and other hosts keep the blocking call. One thing
changes on upgrade in Claude Code: the `delegate` call returns before agy has finished, and its
result comes back as a task notification.

### Added

- The server serves the MCP Tasks extension (`io.modelcontextprotocol/tasks`, 2026-07-28) to a
  request that lists it: `tasks/get`, `tasks/update` and `tasks/cancel`. A finished task's result
  is kept for an hour, up to 100 tasks.
- `cancel` and `steer` take a `delegate` task's id in `sessionId`, and `delegate` takes one in
  `resumeSessionId`.

### Changed

- **Breaking: in an interactive Claude Code CLI session, `delegate` runs as an MCP task.** The call
  returns once agy has the prompt, and the same result arrives as a task notification when the
  turn ends. Progress shows as the task's status message in `/tasks`, and stopping the task
  cancels the turn and stops agy. A stopped task's status message names the session to resume
  (`cancelled; resume with resumeSessionId <id>`), with a note when the run had started a fresh
  session after a failed resume or when agy may still be running. An argument agy rejects still
  fails the call before the prompt. A request that does not list the extension, as Codex's does
  not and Claude Code's does not from a subagent, is answered with the result, as before.

## [1.9.0] - 2026-11-23

### Changed

- A process the server would start after shutdown began fails with `spawn-failed` instead of
  starting.
- A stop counts as done once agy's exit was seen and its tree kill finished. On POSIX it waits for
  the `ps` walk that reaches the commands agy started in their own sessions.
- An aborted `doctor` version probe returns once its stop saw the probe exit: up to 4 s, where it
  was 2 s.
- When a cancel and a host abort both land before the prompt, the result reports the abort.

### Fixed

- A shutdown signal during `doctor` with `deep: true` stops the agent doctor starts for its
  handshake, rather than exiting with it running.
- The exit note, the resume hint and the sign-in note reach the caller whatever agy's side threw, a
  frozen error or a value that is not an Error included.
- A delegation that fails during the handshake sends agy nothing more: an `initialize` reply that
  arrives after the failure no longer opens a session.

## [1.8.0] - 2026-11-23

### Fixed

- The SessionStart hook writes npm's install output to stderr, which stays out of the session
  context, and raises no DEP0190 warning on Node 24.
- A long command is cut to 200 characters in a stall error and the unfinished-tool warning.
- `doctor` reads agy's version through a launcher prefix in `ACP_AGENT_ARGS` (`cmd /c agy acp`),
  not the wrapper's.
- A server shutdown during `doctor`'s version probe stops the probe, on a second signal too.
- On a 2025-era connection `doctor` reports the client that `initialize` declared, whatever
  envelope keys a request carries.
- A stop that rejects is retried. A frozen error is thrown as is, without the bridge's notes,
  instead of a TypeError.
- The Claude plugin declares its logo as `icon`, the field Anthropic's directory reads.

## [1.7.0] - 2026-11-23

### Added

- `execution` in the delegate result: tool calls per kind, and the commands agy ran with exit codes
  (the last 8 plus older failures, repeats folded into `runs`).
- `questions`: agy's open questions as `{question, options, multiSelect?, recommended?}[]`. Answer
  by resuming with the answers in `spec`.
- `doctor` reports `client.protocolVersion`.

### Changed

- agy is launched with `--disable-telemetry`; `ACP_AGENT_ARGS` replaces the arguments.
- MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0): the server takes 2025-era and 2026-07-28
  hosts.

### Fixed

- A steer sent while agy's question is open is taken as its answer: the result is agy's reply, not
  the question. A steer agy rejects leaves the question open.

## [1.6.0] - 2026-11-22

### Changed

- On Windows the launcher is found first and started by file type. agy.exe runs directly rather
  than through cmd.exe, so its arguments arrive exactly; a `.ps1` runs through Windows PowerShell; a
  `.cmd` or `.bat` runs through cmd.exe with its arguments quoted. A Store app alias counts as
  found, a file with no extension never matches, and a bare name is no longer run from the
  workspace.
- In `ACP_AGENT_ARGS` a quoted section after `=` belongs to its argument, so
  `--log-file="C:\a b\x.log"` is one argument. A quote inside a word stays a character.
- A resume that omits `model` on a server with no record of the session says so in
  `protocolWarnings`.

### Fixed

- A launcher path or argument with spaces reaches a `.cmd` launcher whole.
- `force` cancel kills unsettled turns alongside the other turns' closes, not after them.
- A delegation cancelled during setup carries `resultSource: "none"`.
- The unfinished-tool warning and the background wait's progress line name the command still
  running. The wait's limit is named only when it ran out, and a cancel or steer in its last check
  is honoured.
- An effort reply that omits the model keeps the model recorded for the session.
- An aborted `doctor` spawns no version probe, and an aborted probe returns only once it has
  closed, also when the abort falls just before its timeout.
- A signal after stdin closes sets the exit code. A second signal kills every agent shutdown
  stopped, except one whose exit was already confirmed.

## [1.5.0] - 2026-11-22

### Changed

- A resume that leaves out `model` or `effort` uses what this server last set on that session; agy
  reopens a resumed session at its defaults.
- `cancel` and `steer` reject a blank `sessionId`. `resumeSessionId` is trimmed, and a blank one
  means no resume.

### Fixed

- A cancel during session setup sends no prompt and returns `stopReason: "cancelled"` at once, even
  if a config call hangs or fails. The prompt still ran in full.
- `steer` reports `not-running` once the turn has ended, been cancelled or lost its agent; it said
  `not-ready`. A steer agy accepted that then fails fails the delegation, and a steer queued behind a
  failed one supplies the result.
- `cancel` after the turn ended reports `not-running` and leaves the result alone; `force` cuts
  agy's close short as each turn settles.
- A host abort during agy's close, or during `doctor`'s probe, handshake or close, ends it at once.
  Shutdown stops `doctor`'s agent.
- The background wait runs only after `end_turn`, on one clock per delegation. A refusal or output
  cap that leaves a command open names the command, not a question.
- `usage` keeps a cached or thought count one reply left out. `context` ignores other sessions'
  frames, and frames sent while attachments are read stay out of the result.
- A delegation returns only once agy's descendants are killed. An exit the bridge does not see is
  retried and reported in `protocolWarnings`.
- No DEP0190 warning under Node 24 on Windows.
- On Linux and macOS, SIGHUP stops the agents, and only a second signal cuts shutdown short, killing
  their process groups first.

## [1.4.0] - 2026-11-22

### Added

- **`steer`** tool: sends a new instruction into a running delegation; the pending `delegate` call
  returns the redirected turn. Needs a host that can call a tool while `delegate` runs.
- `usage` (the turn's token counts) and `context` (`{used, size}` of the context window) in the
  result.

### Changed

- A delegation returns once agy has exited. agy first gets up to 2 s to close its session and exit
  by itself (about 0.4 s in practice), so its conversation database closes cleanly and the
  workspace is free when the result arrives. A stall, abort, agent exit, `force` cancel or shutdown
  still kills it at once.

## [1.3.0] - 2026-11-22

### Added

- A command agy moves to the background is waited for. agy ends the turn when a shell command
  outlasts the wait it set for it (`WaitMsBeforeAsync`); kept running, it finishes the command and
  reports on it, and that report is the result. Stopping agy at the end of the turn stopped the
  command: a 25 s `npm test` came back unfinished. `AGY_DELEGATE_BACKGROUND_WAIT_MS` bounds the wait
  (default 10 min); a command still running then comes back as `unfinished-tool`. A cancel ends the
  wait at once with `stopReason: "cancelled"`.
- `not-signed-in` failure reason: a signed-out agy is reported with the step to sign in. It read as
  `agent-error: Authentication required`.

### Fixed

- On Linux, stopping agy also stops the commands it runs in their own session. A command outlived a
  hard-cap teardown.

## [1.2.0] - 2026-11-22

### Added

- `resultSource: "unfinished-tool"`: a turn that ends with a tool call still running returns agy's
  message from while it ran, and `protocolWarnings` names the tool. agy ends a turn this way when
  it moves a shell command to the background after the wait it set for it (`WaitMsBeforeAsync`),
  which stops with agy when the delegation returns, and when it asks a question through
  `ask_question`, which a resume answers. The result was empty, with a warning that agy sent no
  message.

### Fixed

- agy starts in the workspace. Started in the MCP server's directory, it listed that directory and
  ran `git status` and `git diff` there during a delegation to another workspace.
- A missing agy on Windows is reported as `spawn-failed` with the install hint, and `doctor`
  reports `found: false`. Launched through cmd.exe it read as `agent-exit` quoting cmd's
  "is not recognized" line, and `doctor` reported `found: true`.
- `cancel` with `force` returns as soon as the turn settles, in about 60 ms, instead of waiting out
  its 5 s grace.

## [1.1.0] - 2026-11-22

### Changed

- The README lists install steps for Cursor (one-click deeplink), VS Code (one-click install),
  JetBrains AI Assistant, Devin Desktop, Visual Studio, OpenCode, Kilo Code and Kiro, and shows
  npm, MCP Registry, Glama, Node and test badges.

## [1.0.0] - 2026-11-21

First public release.

### Added

- MCP server that delegates coding tasks to Google Antigravity's CLI (`agy`) over the
  [Agent Client Protocol](https://agentclientprotocol.com/), through `agy acp`.
- **`delegate`** tool: inline brief, `agent`/`plan`/`ask` modes, session resume, `model` as a
  base id and `effort` as agy's thinking level, `contextFiles` as resource links and images.
  Returns the result, `sessionId`, `filesReportedByEditTools`, the plan agy writes in plan mode,
  and the model and thinking level that ran.
- **`cancel`** tool: cancels an in-flight delegation; `force` ends the agy process tree.
- **`doctor`** tool: reports the agy install, version, sign-in, account tier and the models agy
  offers.
- Plugins for Claude Code, Codex and GitHub Copilot CLI, with a shared `delegate` skill.
- Listed in the MCP Registry as `io.github.andreilungeanu/agy-delegate-mcp`.
