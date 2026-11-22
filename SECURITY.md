# Security

## What this plugin does

`agy-delegate-mcp` spawns **agy** (`agy acp --dangerously-skip-permissions --disable-telemetry`) in your workspace,
so agy approves its own tool calls, and the bridge **auto-approves every permission request**
that still arrives over ACP, in every mode — `agent`, `plan` and `ask`. Each request is answered
with the broadest allow option agy offered (`allow_always`, else `allow_once`).

`workspace` is the agent's working directory, and a run can reach outside it. `mode` is
passed to the agent as an instruction, so `plan` and `ask` describe how it behaves rather
than what it is permitted to do. Delegated tasks can create, modify, or delete files
anywhere your user account can reach, and reach the network.

Treat every `delegate` call like handing an engineer a shell on your machine. Your MCP host
is the orchestrator: it should scope the brief, then review `filesReportedByEditTools` and
the git diff. That field lists what the agent's edit tools reported touching; the git diff
is authoritative.

## Recommendations

- Point `workspace` at the smallest directory that contains the task (not `$HOME` or `/`).
  It scopes what the agent works on, not what it can reach.
- Review the git diff before committing, after every run — including `plan` and `ask` ones.
- Run verification (tests, lint) after delegation — the delegate skill asks the orchestrator
  to do this, but automated gates in CI are still your backstop.
- Do not commit secrets (`.env`, credentials, tokens). The bridge does not redact them from
  agent context.

## Reporting vulnerabilities

If you find a security issue in this bridge (not in agy or an MCP host),
please open a [GitHub Security Advisory](https://github.com/andreilungeanu/agy-delegate-mcp/security/advisories/new)
or email the maintainer listed in `package.json` instead of filing a public issue with
exploit details.
