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

## Release / Publish

Releases are automated with [release-please](https://github.com/googleapis/release-please). Manual `npm publish` should not normally be needed.

1. Push to `main` using Conventional Commits.
2. The `release` GitHub Actions workflow opens or updates a `chore(main): release X.Y.Z` PR that bumps `package.json` and updates the changelog.
3. A maintainer reviews and merges that PR.
4. The workflow runs again from the merge with `release_created=true` and performs:
   - `pnpm install --frozen-lockfile`
   - `pnpm test` / `pnpm typecheck` / `pnpm smoke:e2e`
   - `pnpm build` → `npm publish`
   - GitHub Release + tag creation

### Local checks before merging a release PR

```bash
pnpm test
pnpm typecheck
pnpm smoke:e2e
npm pack --dry-run   # verify the tarball includes dist/, skills/, package README, and LICENSE
```

### Config files

- [`release-please-config.json`](release-please-config.json) — release type and tag format
- [`.release-please-manifest.json`](.release-please-manifest.json) — current version source of truth
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — workflow implementation

### PR title rule

The PR title becomes the squash-merge commit message that release-please reads. Use a Conventional Commit title (`fix:`, `feat(scope):`, `chore:`, …). CI rejects tool prefixes such as `[codex] ...`. Release-please PRs follow the same rule (`chore(main): release vX.Y.Z`, `chore(main): release mcp-server vX.Y.Z`).

## Security

Do **not** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your work is released under the [MIT License](LICENSE).
