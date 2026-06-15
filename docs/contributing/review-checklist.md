# Pull Request Review Checklist

Use this checklist when reviewing or self-reviewing a pull request in this repository.

## Correctness

- [ ] The change does what the PR description says it does.
- [ ] Edge cases and error paths are handled.
- [ ] No regression against existing tests; all CI checks pass.

## Tests

- [ ] At least one nearest-layer test covers the root cause or new behavior.
- [ ] Tests follow the red-first TDD loop (written before the implementation).
- [ ] The correct test layer is used (`mcp-node` / `mcp-jsdom` / `mcp-browser` / `web-browser` / E2E).
- [ ] No test has been weakened or deleted to make the build pass.

## Schema and contracts

- [ ] Any cross-boundary contract (MCP tool, HTTP route, persisted JSON, WebSocket message) is backed by a Zod schema.
- [ ] Types are derived via `z.infer<>` — no hand-written parallel interfaces.
- [ ] If a new MCP tool is added, `pnpm smoke:e2e` is extended to call it at least once.

## Code quality

- [ ] Server code uses `getLogger(...)` — no `console.*` calls in `src/server/**`.
- [ ] Updates are immutable — no in-place mutation of inputs.
- [ ] Files stay under 800 lines; functions stay under 50 lines.
- [ ] Comments explain the enduring *why*, not the narrative of how the PR came about.

## Documentation

- [ ] User-visible changes are documented in `docs/` (Diataxis quadrants).
- [ ] Developer-facing changes are reflected in root OSS files or `docs/contributing/`.
- [ ] No aspirational documentation — docs describe the shipped state only.

## Security

- [ ] No secrets or credentials are hardcoded.
- [ ] User input is validated at system boundaries.
- [ ] Auth paths are reviewed if touched.

## Commit hygiene

- [ ] Commits are logically split by concern (not one monolithic squash).
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, etc.).
- [ ] PR title is a valid Conventional Commit title (used as the squash-merge commit message).

← Back to [Contributing](README.md)
