# `@kamiazya/whiteboard-mcp`

Excalidraw-based whiteboard MCP server for Claude Code, Codex, and other MCP hosts.

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
