# @kamiazya/whiteboard-web

Hosted browser app for whiteboard. This is the Cloudflare Pages deploy target.

## Development

```bash
# Install deps (from repo root)
pnpm install

# Dev server (hot reload)
pnpm --filter @kamiazya/whiteboard-web dev

# Production build
pnpm --filter @kamiazya/whiteboard-web build

# Unit tests
pnpm --filter @kamiazya/whiteboard-web test
```

## Package boundary

This package is a **deploy target**, not an npm distribution artifact.

- `packages/mcp-server` (`@kamiazya/whiteboard-mcp`) owns the CLI, daemon, server-mode,
  MCP transport, diagnostics, and all npm-published artifacts.
- `apps/web` owns the hosted browser UI, Cloudflare Pages build/deploy config,
  browser CSP policy, and hosted runtime config resolution.

`apps/web` assets must never appear in the `@kamiazya/whiteboard-mcp` npm tarball.

## Runtime config

`src/runtime-config.ts` provides a Zod schema seam for resolving public origin and
daemon base URL at startup. Cloudflare Pages deployment and daemon pairing are
future work — the seam is intentionally minimal today.

Local fixed-origin HTTPS development via `wrangler pages dev` is a candidate future
option for testing Cloudflare-specific behavior locally. It is not currently implemented
or part of any CI or production deployment flow.

## Source boundary rules

`apps/web/src` must not import:
- Node.js builtins (`node:fs`, `crypto`, etc.)
- Anything from `packages/mcp-server/src/server`, `src/cli`, or `src/daemon`
- Unlisted `packages/mcp-server/src/shared` modules

Boundary violations are caught automatically by `web-app-boundary.test.ts`.
