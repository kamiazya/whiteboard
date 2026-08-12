<p align="center">
  <!-- Absolute URL on purpose: npm renders this README and resolves no
       relative repo paths. -->
  <img src="https://raw.githubusercontent.com/kamiazya/whiteboard/main/docs/assets/readme-mark.svg" alt="Whiteboard" width="200" height="169" />
</p>

# `@kamiazya/whiteboard-mcp`

OpenCanvas-based whiteboard MCP server for Claude Code, Codex, and other MCP hosts.

## Requirements

- Node `>=22`

## Quick start

Run the stdio server directly with `npx`:

```bash
npx -y @kamiazya/whiteboard-mcp@latest
```

Example MCP config:

```json
{
  "mcpServers": {
    "whiteboard": {
      "command": "npx",
      "args": ["-y", "@kamiazya/whiteboard-mcp@latest"]
    }
  }
}
```

Shared skills are published in the package under `skills/`.

## What is in this package

- `dist/` contains the runnable MCP server and browser app assets.
- `skills/` contains the shared skill bundles that Claude Code and Codex wrappers reference as their source of truth.
- The repo-level plugin manifests are not shipped as separate release artifacts. Public distribution currently happens through this npm package.

## Development

For repo-local development, use the workspace root commands:

```bash
pnpm mcp:http:dev
pnpm mcp:inspect
```

## Links

- Repository: `https://github.com/kamiazya/whiteboard`
- Issues: `https://github.com/kamiazya/whiteboard/issues`
- Full docs: see the repository root `README.md`
