# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
