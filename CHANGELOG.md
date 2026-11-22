# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
