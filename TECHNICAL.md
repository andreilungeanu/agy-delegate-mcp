# Technical reference

Details for integrators and contributors. For a quick start, see [README.md](README.md).

## Architecture

MCP host (orchestrator) → MCP `delegate` tool → this bridge → **agy** over ACP (stdio JSON-RPC),
launched as `agy acp --dangerously-skip-permissions --disable-telemetry`.

The bridge auto-approves every permission request and returns named fields (`sessionId`, `filesReportedByEditTools`, optional `plan` and `artifacts`) instead of scraping stdout.

## `delegate` tool

Input fields are described in the tool schema. Result fields and failure reasons:
[skills/delegate/reference.md](skills/delegate/reference.md). Orchestration guidance is in
[skills/delegate/SKILL.md](skills/delegate/SKILL.md).

### Result envelope

Every tool returns its payload as one compact JSON text block and declares no MCP
`outputSchema`. Declaring one obliges the server to send the same object again as
`structuredContent`, and hosts that read both fields put both copies into the model's context.
The `cancel` and `steer` status vocabularies are published in their tool descriptions instead.
A failed `delegate` returns `isError: true` with plain text: `delegate failed [<reason>]: <message>`
(the bracket is absent when no reason was assigned). Invalid arguments, and unknown input fields, are
rejected by the MCP SDK before the tool runs.

### Other tools

- **`cancel`** — best-effort cancel of an in-flight delegation.
- **`steer`** — sends a new instruction into an in-flight delegation's running turn.
- **`doctor`** — setup diagnostics (see below).

## `doctor` tool

`doctor` reports what a diagnosis needs and lists what needs action in `warnings`; sections with
nothing to report are left out. It makes no model call.

| Field | Description |
| ----- | ----------- |
| `plugin.name` / `plugin.version` | Installed plugin, version read fresh on each call. |
| `client.name` / `client.version` | MCP client identity; `null` when the host sent none. |
| `client.protocolVersion` | MCP revision the host speaks: `2026-07-28`, or the 2025-era version it negotiated. Absent when unknown. |
| `agent.found` | Whether the launcher could be spawned at all. |
| `agent.command` | Resolved launcher command line, with `ACP_AGENT_COMMAND` / `ACP_AGENT_ARGS` applied. |
| `agent.version` | `--version` output, or `null`. `found: false` means it is not installed; `found: true` with a `null` version means it exists but did not answer — `agent.error` says why. |
| `agent.error` | Present only when `version` is `null` on a launcher that does exist, e.g. the probe timed out or `--version` exited non-zero. |
| `auth.status` | `unknown` without `deep` (agy has no status command). With `deep`: `ok` once a session opened, `logged-out` when agy answered `session/new` with ACP's `auth_required` (-32000). |
| `auth.plan` | With `deep`: the account tier agy reports in `session/new`'s `_meta.antigravity.tier`, e.g. `Google AI Pro`. |
| `workspace` | `path` (the `workspace` argument, default the server's cwd), `exists`, `isDirectory`. |
| `env` | The launcher and timeout variables that are set, by name. Absent when none is. |
| `warnings` | One sentence per thing to act on: launcher missing or silent, not signed in, a missing workspace, a failed handshake, a default model the account lacks (a delegation that names no model then runs agy's default). |

`deep: true` also opens an ACP session (start → initialize → newSession, bounded at 15 s) in the
workspace and adds:

| Field | Description |
| ----- | ----------- |
| `session` | `{ ok: true, modes }`, or `{ ok: false, error }` — not signed in, or a timeout. `modes` are the ids this agent offers for a new session. |
| `models.available` | The model ids this account offers — the base ids `delegate`'s `model` takes, from the model config option (`availableModels` carries level suffixes and is only the fallback). |
| `models.current` | The model a new session opens on; `null` when the agent reported none. |
| `models.default` / `models.defaultAvailable` | The model a delegation that names none asks for, and whether `available` holds it (`null` when the agent listed no models). |
| `models.currentModelOptions` | `{ id, name?, category?, values, currentValue? }[]` for `models.current` only — any other model needs a `set_model` this handshake does not send. |

Fields relayed verbatim from the agent are typed as unknown in the schema on purpose: doctor is
what you run when the agent is already misbehaving, so an odd value must read as a diagnostic,
not fail the call.

## ACP behavior (verified against agy 1.5.13–1.5.15)

- **Launch**: `agy acp --dangerously-skip-permissions --disable-telemetry`. agy then approves its own tool calls and
  sends no `session/request_permission`. Any request that does arrive is answered with the
  broadest allow option by `kind` (`allow_always`, else `allow_once`); if neither is offered the
  request is answered `cancelled` rather than selecting a reject.
- **Model and effort**: `session/set_config_option` with `configId: "model"` and a base id, sent
  only when the session reports a different current model; its reply carries the new model's
  `configOptions`, which are what `effort` is validated against. With no `model` and nothing on
  record for the session, the bridge sends `gemini-4-hydrogen` (`DEFAULT_MODEL` in
  `src/delegate.js`), or leaves agy's current model, with a warning, when agy does not list it. `effort` goes out as
  `configId: "thought_level"`. The levels on offer differ per model.
- **Mode**: `session/set_mode` before every prompt — `agent` and `ask` map to `default`, `plan`
  to `plan`. `ask` also prefixes the prompt with an answer-only instruction; agy has no ask mode.
- **Resume**: `session/resume`, which restores the conversation without replaying it. agy opens a
  resumed session at its default model, thinking level and mode, so all three are compared and
  re-sent; a `model` the caller leaves out is taken from what this process recorded for the session
  (the model agy ran when model or effort was last set), and an omitted `effort` likewise unless
  `model` changes. agy answers an unknown id and a failed read with the same `-32603`; the bridge
  checks `session/list` (every session the account has, one page) and starts fresh only for an id agy
  does not list.
- **Plan**: in plan mode agy writes the plan with a `write_file` call carrying `ArtifactMetadata`,
  to `~/.gemini/antigravity-cli/brain/<sessionId>/`. The bridge returns its `Content` as
  `plan.detail` and keeps artifact paths out of `filesReportedByEditTools`.
- **`filesReportedByEditTools`**: built solely from ACP `diff` content blocks on `tool_call` and
  `tool_call_update`; no git inference. agy writes a finished diff's path as `/C:/…` on Windows;
  the bridge strips the slash before resolving it against the workspace.
- **Steer**: a second `session/prompt` on the running session. agy settles the prompt it redirects
  at once with `end_turn`, so the turn ends with the newest steer's reply. A steer reply that fails
  before the turn it targets settles is a refusal (a warning); one that fails after is the turn
  failing.
- **Usage**: the `session/prompt` reply carries the turn's token counts (`usage`); `usage_update`
  frames carry the session's context fill (`used`, `size`). A steered turn sums its replies:
  `inputTokens`, `outputTokens` and `totalTokens` appear only when every reply that reported usage
  carried them; a cached or thought count a reply left out counts as 0.
- **Progress**: thinking, streamed response sentences, tool starts, edited files and the turn
  title (`turn titled: …`) arrive as MCP progress notifications, or as the task's status message
  for an MCP task. The title labels concurrent delegations and is named in timeout errors; it is
  not returned in the result. While a turn runs, a `still working — <elapsed>, last agent frame
  <age> ago, running: <tool>` heartbeat is emitted. After the hard cap, stopping the agent takes
  up to 10 s more.
- **Teardown**: `session/close` for each session when `sessionCapabilities.close` is advertised,
  then stdin EOF; agy exits by itself within the 2 s grace, then the tree is killed. A stall,
  abort, agent exit, force cancel or shutdown skips the grace.
- `session/prompt` takes a content-block array: the text block, then `resource_link` blocks for
  text `contextFiles` and inline `image` blocks for images, gated on
  `promptCapabilities.image`.
- **Long runs**: when the client passes a progress token, the bridge sends a progress notification every 30 s and on agent activity. Copilot CLI restarts its 180 s tool-call timer on each notification, Claude Code its 30 min idle window, and MCP TypeScript SDK clients only with `resetTimeoutOnProgress`. Deadlines that ignore progress: Codex `tool_timeout_sec` (default 300 s), Claude Code `MCP_TOOL_TIMEOUT` (default about 28 h). The Codex plugin sets `tool_timeout_sec` to 21660 s, so an `AGY_DELEGATE_HARD_CAP_MS` above 6 h 1 min still ends at Codex's deadline. Child exit fails fast with stderr.

## Environment variables

| Variable | Description |
| -------- | ----------- |
| `ACP_AGENT_COMMAND` | Override agent launcher command (default `agy`). |
| `ACP_AGENT_ARGS` | Override agent launcher args (default `acp --dangerously-skip-permissions --disable-telemetry`). |
| `AGY_DELEGATE_TRANSCRIPT` | Frames of raw ACP transcript to append to failure messages; unset = none. Contains prompts, tool inputs/outputs and agent messages — use it only when debugging the bridge itself. |
| `AGY_DELEGATE_HANDSHAKE_MS` | Handshake deadline (default 60 s). |
| `AGY_DELEGATE_HARD_CAP_MS` | Absolute delegation cap (default 6 h). |
| `AGY_DELEGATE_BACKGROUND_WAIT_MS` | How long to wait for a command agy moved to the background (default 10 min). |
| `ACP_E2E` | Set to `1` to run the live e2e tests locally; they spend agy quota. |

A non-positive or malformed timeout value falls back to its default.

## Source layout

| Path | Purpose |
| ---- | ------- |
| `src/server.js` | MCP server (`delegate`, `cancel`, `steer`, `doctor`). |
| `src/delegate.js` | One delegation lifecycle. |
| `src/acp-client.js` | ACP client. |
| `src/request-router.js` | Permission request routing. |
| `src/jsonrpc.js` | NDJSON JSON-RPC peer. |
| `src/spawn.js` | `agy acp` launcher resolution. |
| `src/session-supervisor.js` | Handshake and hard-cap timeouts. |
| `src/agent-reported-files.js` | Path normalization for `filesReportedByEditTools`. |
| `src/doctor.js` | Diagnostics. |
| `src/turn-state.js` | Per-turn accumulation, artifacts, and the `reset()` declaration. |
| `src/model-options.js` | Thinking-level option resolution (`effort`). |
| `src/proc.js` | Liveness check and process kill. |
| `src/shutdown.js` | Stops every agent, then exits, when the host goes away. |
| `src/tasks.js` | MCP tasks a `delegate` call is answered with. |
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
