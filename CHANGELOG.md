# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
