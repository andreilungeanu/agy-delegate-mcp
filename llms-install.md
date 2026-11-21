# Installing agy-delegate-mcp

Instructions for an AI agent setting this server up on the user's machine.

## Prerequisites

1. **Node.js 20+** — `node --version`.
2. **Antigravity CLI** — `agy --version`. If missing, ask the user to install Google Antigravity's CLI.
3. **A signed-in agy** — the user runs `agy` and signs in. This opens a browser and is interactive: **ask the user to run it themselves**, do not attempt it in a background shell.

The server itself needs no install step; `npx` fetches it on first run.

## Configuration

Add a local stdio server. Many hosts use a top-level `mcpServers` object (Claude Desktop, Cline, Windsurf, Kiro, …):

```json
{
  "mcpServers": {
    "agy-delegate": {
      "command": "npx",
      "args": ["-y", "agy-delegate-mcp"]
    }
  }
}
```

Cline ends a tool call after 60 s; add `"timeout": 3600`, its maximum.

OpenCode and Kilo Code use `mcp` + `type: "local"` + `command` as one array. Do not paste `mcpServers` into those two.

No API keys and no environment variables are required. Auth is agy's own sign-in.

## Verify

Call the `doctor` tool. It reports the Node version and how `agy` resolves on PATH, naming whatever is missing. Call it with `deep: true` to run an ACP handshake — that is what proves agy is signed in, and a clean deep `doctor` means `delegate` is ready.

## Optional environment variables

| Variable | Purpose |
| --- | --- |
| `AGY_DELEGATE_IDLE_MS` | Mid-turn idle guard; unset or `0` = off. |
| `AGY_DELEGATE_HARD_CAP_MS` | Absolute cap on a single delegation (default 6 h). |
| `AGY_DELEGATE_HANDSHAKE_MS` | Handshake deadline (default 60 s). |
| `AGY_DELEGATE_BACKGROUND_WAIT_MS` | Wait for a command agy moved to the background (default 10 min). |
| `AGY_DELEGATE_TRANSCRIPT` | Frames of raw ACP transcript to append to failure messages; unset = none. |

Defaults are documented in [TECHNICAL.md](TECHNICAL.md); leave them unset unless the user asks.
