# Privacy

Antigravity Delegate runs as a local stdio MCP server. The project author does not operate a backend for the plugin and does not receive your code, prompts, workspace contents, session identifiers, diagnostics, or usage telemetry.

Claude Code installs run the server bundled in the plugin cache. On first session, the plugin may run `npm install --omit=dev` inside that cache to fetch its open-source runtime dependencies; it does not install them into your project. Codex, Copilot, VS Code, and standalone MCP configurations start the published package through `npx`, so npm may apply its own registry logging under npm's policies.

When you delegate, the local server starts `agy`. Task prompts, selected workspace content, model requests, and Google account usage are handled by Google under the terms and privacy policy that apply to Google Antigravity. agy keeps its own session history and artifacts under `~/.gemini/antigravity-cli/`. Your MCP host may separately process the prompt and tool results under its own terms.

The MCP response can contain file paths, agent output, plan text, diagnostic information, and session identifiers. Review that output before sharing logs or bug reports. The plugin does not redact secrets found in prompts, files, agent output, or diagnostics.

For security issues, see [SECURITY.md](SECURITY.md) or open a [GitHub Security Advisory](https://github.com/andreilungeanu/agy-delegate-mcp/security/advisories/new).
