# Technical reference

Details for integrators and contributors. For a quick start, see [README.md](README.md).

## Architecture

MCP host (orchestrator) → MCP `delegate` tool → this bridge → **agy** over ACP (stdio JSON-RPC),
launched as `agy acp --dangerously-skip-permissions`.

The bridge auto-approves every permission request and returns named fields (`sessionId`, `filesReportedByEditTools`, optional `plan` and `artifacts`) instead of scraping stdout.

## `delegate` tool

Parameters, return fields, failure reasons and timeouts:
[skills/delegate/reference.md](skills/delegate/reference.md) — the single source of truth
for the tool contract. Orchestration guidance is in
[skills/delegate/SKILL.md](skills/delegate/SKILL.md).

### Result envelope

Every tool returns its payload as one compact JSON text block and declares no MCP
`outputSchema`. Declaring one obliges the server to send the same object again as
`structuredContent`, and hosts that read both fields put both copies into the model's context.
The `cancel` and `steer` status vocabularies are published in their tool descriptions instead.

### Other tools

- **`cancel`** — best-effort cancel of an in-flight delegation.
- **`steer`** — sends a new instruction into an in-flight delegation's running turn.
- **`doctor`** — setup diagnostics (see below).

## `doctor` tool

| Field | Description |
| ----- | ----------- |
| `plugin.version` | Installed plugin version. |
| `client.name` / `client.version` | MCP client identity; `null` when the host sent none. |
| `client.capabilities` | Raw client capabilities. |
| `agent.found` | Whether the launcher could be spawned at all. |
| `agent.command` | Resolved launcher command line, with `ACP_AGENT_COMMAND` / `ACP_AGENT_ARGS` applied. |
| `agent.version` | `--version` output, or `null`. `found: false` means it is not installed; `found: true` with a `null` version means it exists but did not answer — `agent.error` says why. |
| `agent.error` | Present only when `version` is `null` on a launcher that does exist, e.g. the probe timed out or `--version` exited non-zero. |
| `runtime` | Node version, platform, architecture, cwd, and stdio transport. |
| `env.ACP_LOG_SIZE` | Flight recorder size (default `2000`). |
| `env.ACP_AGENT_COMMAND` / `env.ACP_AGENT_ARGS` | Launcher overrides, or `null` when unset. |
| `env.AGY_DELEGATE_TRANSCRIPT` | Transcript frame count, or `null` when unset. |
| `env.AGY_DELEGATE_HANDSHAKE_MS` / `HARD_CAP_MS` / `IDLE_MS` | Timeout knobs, or `null` when unset. |

Optional `deep: true` runs a bounded ACP handshake (15 s) and adds `agent.handshake`:
`{ ok: false, error }` on failure — not signed in, or a timeout — or `{ ok: true,
protocolVersion, agentCapabilities, models, currentModel, currentModelOptions, modes, tier }` on
success. `models` are the base ids `delegate`'s `model` accepts (the values of agy's `model`
config option); `modes` are agy's own mode ids. `currentModelOptions` is
`{ id, name?, category?, values, currentValue? }[]` for `currentModel` only — agy reports it as
`thought_level`. `tier` is `_meta.antigravity.tier` from `session/new`. `protocolVersion`,
`currentModel` and `tier` are `null` when agy reported none.

Fields relayed verbatim from the agent are typed as unknown in the schema on purpose: doctor is
what you run when the agent is already misbehaving, so a weird `protocolVersion` must read as a
diagnostic, not fail the call.

## ACP behavior (verified against agy 1.5.13–1.5.14)

- **Launch**: `agy acp --dangerously-skip-permissions`. agy then approves its own tool calls and
  sends no `session/request_permission`. Any request that does arrive is answered with the
  broadest allow option by `kind` (`allow_always`, else `allow_once`); if neither is offered the
  request is answered `cancelled` rather than selecting a reject.
- **Model and effort**: `session/set_config_option` with `configId: "model"` and a base id, sent
  only when the session reports a different current model; its reply carries the new model's
  `configOptions`, which are what `effort` is validated against. `effort` goes out as
  `configId: "thought_level"`. The levels on offer differ per model.
- **Mode**: `session/set_mode` before every prompt — `agent` and `ask` map to `default`, `plan`
  to `plan`. `ask` also prefixes the prompt with an answer-only instruction; agy has no ask mode.
- **Resume**: `session/resume`, which restores the conversation without replaying it. agy opens a
  resumed session at its default model, thinking level and mode, so all three are compared and
  re-sent. agy answers an unknown id and a failed read with the same `-32603`; the bridge checks
  `session/list` (every session the account has, one page) and starts fresh only for an id agy
  does not list.
- **Plan**: in plan mode agy writes the plan with a `write_file` call carrying `ArtifactMetadata`,
  to `~/.gemini/antigravity-cli/brain/<sessionId>/`. The bridge returns its `Content` as
  `plan.detail` and keeps artifact paths out of `filesReportedByEditTools`.
- **`filesReportedByEditTools`**: built solely from ACP `diff` content blocks on `tool_call` and
  `tool_call_update`; no git inference. agy writes a finished diff's path as `/C:/…` on Windows;
  the bridge strips the slash before resolving it against the workspace.
- `session/prompt` takes a content-block array: the text block, then `resource_link` blocks for
  text `contextFiles` and inline `image` blocks for images, gated on
  `promptCapabilities.image`.
- **Long runs**: when the client passes a progress token, the bridge sends a progress notification every 30 s and on agent activity. Copilot CLI restarts its 180 s tool-call timer on each notification, Claude Code its 30 min idle window, and MCP TypeScript SDK clients only with `resetTimeoutOnProgress`. Deadlines that ignore progress: Codex `tool_timeout_sec` (default 300 s), Claude Code `MCP_TOOL_TIMEOUT` (default about 28 h). The Codex plugin sets `tool_timeout_sec` to 21660 s, so an `AGY_DELEGATE_HARD_CAP_MS` above 6 h 1 min still ends at Codex's deadline. Child exit fails fast with stderr.
- **`ACP_LOG_SIZE`**: ring buffer of JSON-RPC frames (default `2000`; `0` disables). Bounds what `AGY_DELEGATE_TRANSCRIPT` can return, and frames are recorded only while that is set.

## Environment variables

| Variable | Description |
| -------- | ----------- |
| `ACP_AGENT_COMMAND` | Override agent launcher command (default `agy`). |
| `ACP_AGENT_ARGS` | Override agent launcher args (default `acp --dangerously-skip-permissions`). |
| `ACP_LOG_SIZE` | Flight recorder frame count (`0` = off). Recording runs only while `AGY_DELEGATE_TRANSCRIPT` is set. |
| `AGY_DELEGATE_TRANSCRIPT` | Frames of raw ACP transcript to append to failure messages; unset = none. Contains prompts, tool inputs/outputs and agent messages — use it only when debugging the bridge itself. |
| `AGY_DELEGATE_HANDSHAKE_MS` | Handshake deadline (default 60 s). |
| `AGY_DELEGATE_HARD_CAP_MS` | Absolute delegation cap (default 6 h). |
| `AGY_DELEGATE_IDLE_MS` | Opt-in mid-turn idle guard; unset or `0` = off. |
| `AGY_DELEGATE_BACKGROUND_WAIT_MS` | How long to wait for a command agy moved to the background (default 10 min). |
| `ACP_E2E` | Set to `1` to run the live e2e tests locally; they spend agy quota. |

## Source layout

| Path | Purpose |
| ---- | ------- |
| `src/server.js` | MCP server (`delegate`, `cancel`, `steer`, `doctor`). |
| `src/delegate.js` | One delegation lifecycle. |
| `src/acp-client.js` | ACP client. |
| `src/request-router.js` | Permission request routing. |
| `src/jsonrpc.js` | NDJSON JSON-RPC peer. |
| `src/spawn.js` | `agy acp` launcher resolution. |
| `src/session-supervisor.js` | Handshake/idle/hard-cap timeouts. |
| `src/agent-reported-files.js` | Path normalization for `filesReportedByEditTools`. |
| `src/doctor.js` | Diagnostics. |
| `src/turn-state.js` | Per-turn accumulation, artifacts, and the `reset()` declaration. |
| `src/model-options.js` | Thinking-level option resolution (`effort`). |
| `src/proc.js` | Liveness check and process kill. |
| `src/errors.js` | Reason-tagged errors. |
| `src/version.js` | Version read from `package.json`. |
| `.claude-plugin/hooks.json`, `.claude-plugin/ensure-deps.mjs` | Claude/VS Code SessionStart dependency bootstrap. |
| `skills/` | Shared plugin skill for host orchestration. |
| `.mcp.copilot.json` | Version-pinned Copilot MCP server registration. |
| `.claude-plugin/`, `.codex-plugin/`, `.github/plugin/plugin.json` | Claude, Codex, and Copilot plugin manifests. |
| `.agents/plugins/`, `.github/plugin/marketplace.json` | Codex and Copilot marketplace catalogs. |

## Local development

```shell
npm ci
npm test
npm run test:pack
ACP_E2E=1 npm test
claude --plugin-dir .
claude plugin validate .
```

## Publishing (maintainers)

1. Public repo: [andreilungeanu/agy-delegate-mcp](https://github.com/andreilungeanu/agy-delegate-mcp)
2. Keep the package, lockfile, all plugin/marketplace manifests, and npm launcher pins synchronized.
3. Run the Codex plugin validator, `claude plugin validate .`, `npm test`, and `npm run test:pack`.
4. Complete the maintainer release gate, kept locally with the release checklist.
5. Tag the release and publish npm before publishing version-pinned plugin catalogs.
