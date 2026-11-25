# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.3.0] - 2026-11-25

### Added

- `doctor deep` reports whether agy is signed in (`auth.status`: `ok`, or `logged-out` on ACP's
  `auth_required`) and the account tier as `auth.plan`, and checks that the account offers the
  default model.
- `doctor` takes a `workspace` argument it checks and opens the deep session in, and lists what
  needs action in `warnings`: launcher missing or silent, not signed in, a missing workspace, a
  failed handshake, a default model the account lacks.

### Changed

- `doctor` output follows the shape shared with `codex-delegate-mcp` and `cursor-delegate-mcp`.
  `agent.handshake` is replaced by top-level `session` (`ok`, `error`, `modes`) and `models`
  (`default`, `defaultAvailable`, `current`, `available`, `currentModelOptions`); the tier moves to
  `auth.plan`.
- `doctor` leaves out what rarely changes a diagnosis: the client's capabilities, the runtime
  section, the agent's ACP protocol version and capabilities, and unset environment variables.
- The package, plugin and server descriptions present the plugin as bringing Gemini into a
  council: second opinions first, then handoff.

## [2.2.0] - 2026-11-25

### Added

- Server info carries a title, a description and the repository URL, and each tool has a title.
  The server advertises `tools.listChanged: false`.

### Changed

- With no `model`, a new session runs `gemini-4-hydrogen`, where it ran agy's default. A resume
  keeps the model last set on the session; after a server restart it runs `gemini-4-hydrogen`.
  An account that does not offer `gemini-4-hydrogen` runs agy's default, with a
  `protocolWarnings` entry.
- `delegate`, `cancel`, `steer` and `doctor` reject an unknown input field instead of dropping it.
  A misspelled `resumeSessionId` started a new session.
- The delegate skill covers second opinions and model comparisons as well as handoff, at about a
  third of its former length. It no longer scales delegation by task size or carries a Security
  section. `reference.md` keeps result fields, failure reasons and resume rules; the progress
  format moved to TECHNICAL.md, and the `contextFiles` trust note to SECURITY.md.
- The `delegate` description and the server instructions open with asking agy as well as
  delegating to it: `mode: "ask"` gives a second opinion, and parallel calls with the same brief
  compare views.
- The plugin, marketplace, npm and MCP Registry descriptions name both uses.
- The MCP SDK is pinned to 2.4.0.

## [2.1.0] - 2026-11-24

### Changed

- A stop kills agy's process tree once and waits up to 5 s for agy to exit; on Windows
  `taskkill` first gets up to 5 s of its own. A stop that cannot confirm the exit is final, and the
  result warns `the bridge stopped agy (pid <pid>) but could not confirm that agy and its
  processes exited; they may still be running.`, where it said the bridge did not see agy exit
  and a later stop tried again.
- `cancel` with `force` on a session whose turn has ended returns `not-running` and lets agy's
  close finish, up to 2 s, where it cut the close short; a host abort during the close lets it
  finish too. A force cancel whose kill cannot confirm the exit reports `cancelled`, and the
  session is no longer kept for another force.
- Shutdown stops every agent, waits for the stops, and exits with the code of whatever triggered it
  first. SIGINT, SIGTERM and SIGHUP trigger it on Windows too. A later signal waits for the same
  stop, where a second signal killed each agent's process group and exited at once.
- A stopped task's status message carries a note only when the run started a fresh session after a
  failed resume. A stop that cannot confirm agy exited is reported in the delegate result's
  `protocolWarnings`.
- An `agent-error` message ends with the request and JSON-RPC code agy answered with, as in
  `(session/new JSON-RPC -32603)`, and so does the note of a resume that failed for a session that
  still exists. The skill reference describes `agent-error` as an error answer named with its code,
  where it called every such code a rejected argument.

### Removed

- `AGY_DELEGATE_IDLE_MS`, the opt-in mid-turn idle guard (off by default), and its `idle-timeout`
  reason. doctor no longer reports it.
- `ACP_LOG_SIZE`. The flight recorder keeps exactly the frames `AGY_DELEGATE_TRANSCRIPT` shows, and
  records only while it is set. doctor no longer reports it.

### Fixed

- On Windows a `taskkill` that fails or runs past 5 s is followed by a kill of the launcher by its
  handle, and the result warns that agy and its processes may still be running. A failed
  `taskkill` went unreported.
- agy's `session/new` is sent once more, 500 ms later, when agy fails it with `Failed to start
  Antigravity conversation` (JSON-RPC -32603), as it does when agy processes start at the same
  time.

### Internal

- `src/proc.js` and `src/shutdown.js` are the same in agy-delegate-mcp, cursor-delegate-mcp and
  codex-delegate-mcp.
- `npm test` runs the test files named on the command line, without a deadline.
- The result and doctor shapes the tests check are in `test/output-shapes.js`.
- Tests of limits, options and source layout the code no longer has are removed.

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
