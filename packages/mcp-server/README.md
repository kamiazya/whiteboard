<p align="center">
  <!-- Absolute URL on purpose: npm renders this README and resolves no
       relative repo paths. -->
  <img src="https://raw.githubusercontent.com/kamiazya/whiteboard/main/docs/assets/readme-mark.svg" alt="Whiteboard" width="200" height="169" />
</p>

# `@kamiazya/whiteboard-mcp`

Whiteboard MCP server for Claude Code, Codex, and other MCP hosts. Documents are
stored as OKF Markdown or [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/).

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

The product skills are NOT part of this package: skills ship with the
Claude Code / Codex plugin, whose manifests point at the repository's
`skills/` directory as the single source of truth.

## What is in this package

- `dist/` contains the runnable MCP server and browser app assets.
- The repo-level plugin manifests (and the skills they reference) are distributed through the plugin, not this npm package.

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
