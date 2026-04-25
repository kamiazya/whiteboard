# Contributing to whiteboard

Thanks for considering a contribution. This repo is a pnpm monorepo for `@kamiazya/whiteboard-mcp` (the MCP server) plus thin Claude Code / Codex plugin wrappers.

## Quick start

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard
pnpm install
pnpm test         # unit tests (mcp-node + mcp-jsdom + mcp-browser)
pnpm typecheck
pnpm smoke:e2e    # stdio MCP smoke (no API quota)
```

For active MCP development, prefer the HTTP transport so a `tsx watch` daemon restart does not require reconnecting the MCP client:

```bash
pnpm mcp:http:dev
```

See [README.md](README.md) for the full setup including Claude Code / Codex auto-override (`.claude/settings.json` / `.codex/config.toml`).

## Workflow

This project follows a **test → patch → manual verify → regression test** loop. See [AGENTS.md](AGENTS.md) for the full development loop, including which test layer (mcp-node / mcp-jsdom / mcp-browser / E2E) to choose for which kind of change.

Short version:

1. Write the smallest failing test at the nearest layer.
2. Make the smallest patch that turns it green.
3. Manually verify the real behavior (browser open, MCP smoke, etc.).
4. Lock the verified flow into `mcp-browser` or E2E coverage.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature (minor bump)
- `fix:` — bug fix (patch bump)
- `feat!:` or `BREAKING CHANGE:` footer — major bump
- `chore:` / `docs:` / `refactor:` / `test:` — no version bump (still in CHANGELOG)

Releases are automated by [release-please](https://github.com/googleapis/release-please) — merge the auto-generated `chore(main): release X.Y.Z` PR to publish.

Keep published MCP wrapper configs on `@latest` unless you also update release-please sync rules. If you pin `@kamiazya/whiteboard-mcp@x.y.z` inside `.mcp.json` or plugin manifests, add the pinned fields to `release-please-config.json` `extra-files` at the same time.
When upgrading `@modelcontextprotocol/sdk`, re-check the supported MCP protocol matrix in `docs/mcp-debugging.md` and the initialize negotiation tests.

## Lint

[Biome](https://biomejs.dev/) is already configured (`biome.json`). Please try to keep new and modified files passing before you commit:

```bash
pnpm lint        # list violations
pnpm lint:fix    # apply auto-fixable changes
```

This is not yet enforced as a hard CI gate because the existing codebase still has many warnings. The expectation is to improve it incrementally.

## Pull request checklist

- `pnpm test` is green
- `pnpm typecheck` is green
- New behavior has at least one nearest-layer automated test
- For UI / browser-mode changes: `pnpm test:browser` is green
- For MCP tool / route changes: `pnpm smoke:e2e` is green
- README / AGENTS.md updated if the public surface changed
- No secrets, `.env`, or large binaries committed

## Security

Do **not** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your work is released under the [MIT License](LICENSE).
