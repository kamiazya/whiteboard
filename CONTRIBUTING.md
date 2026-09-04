# Contributing to whiteboard

Thanks for considering a contribution. This repo is a pnpm monorepo for `@kamiazya/whiteboard-mcp` (the MCP server) plus thin Claude Code / Codex plugin wrappers.

## Quick start

```bash
git clone https://github.com/kamiazya/whiteboard.git
cd whiteboard      # Node: match .node-version (currently 24) — use nvm / fnm / Volta
                   # ImageMagick (convert/identify) is also required — pnpm test:scripts and pnpm check:local call it;
                   # full prerequisites: docs/contributing/development.md
pnpm install
pnpm exec playwright install --with-deps chromium   # required for the browser test projects (canvas-viewer-browser / web-browser)
pnpm test         # all 22 vitest projects (listed under Workflow below)
pnpm typecheck
pnpm smoke:e2e    # stdio MCP smoke (no API quota)
```

For active MCP development, prefer the HTTP transport so a `tsx watch` daemon restart does not require reconnecting the MCP client:

```bash
pnpm mcp:http:dev
```

See [README.md](README.md) for the full setup including Claude Code / Codex auto-override (`.claude/settings.json` / `.codex/config.toml`).

## Workflow

This project follows a **test → patch → manual verify → regression test** loop. See [AGENTS.md](AGENTS.md) for the full development loop, including which test layer to choose for which kind of change.

`pnpm test` runs 22 vitest projects. The names below are what `--project` accepts — worth copying rather than typing, because **vitest only errors when a `--project` filter set is empty**: a name that matches nothing alongside one that matches runs the smaller set and exits 0, which reads exactly like both suites passing.

| runtime | projects |
|---|---|
| node | `mcp-node`, `mcp-smoke`, `model-node`, `ports-node`, `facet-engine-node`, `plugin-visual-node`, `codec-node`, `arch-lint-node`, `loro-adapter-node`, `search-node`, `server-core-node`, `workspace-index-node`, `canvas-render-node`, `canvas-viewer-node`, `web-node` |
| jsdom | `facet-ui-jsdom`, `plugin-visual-jsdom`, `canvas-viewer-jsdom`, `web-jsdom` |
| real browser | `canvas-render-browser`, `canvas-viewer-browser`, `web-browser` |

`apps/web`'s two non-browser projects are `web-jsdom` and `web-node`; running only `--project web-jsdom` omits `web-node`'s build and deploy-config guards, so use `pnpm --filter @kamiazya/whiteboard-web test` when the question is "does this match CI".

Short version:

1. Write the smallest failing test at the nearest layer.
2. Make the smallest patch that turns it green.
3. Manually verify the real behavior (browser open, MCP smoke, etc.).
4. Lock the verified flow into `canvas-viewer-browser` / `web-browser` or E2E coverage.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature (minor bump)
- `fix:` — bug fix (patch bump)
- `feat!:` or `BREAKING CHANGE:` footer — major bump
- `chore:` / `docs:` / `refactor:` / `test:` — no version bump (still in CHANGELOG)

Releases are automated by [release-please](https://github.com/googleapis/release-please) — merge the auto-generated `chore(main): release X.Y.Z` PR to publish.

Keep published MCP wrapper configs on `@latest` unless you also update release-please sync rules. If you pin `@kamiazya/whiteboard-mcp@x.y.z` inside `.mcp.json` or plugin manifests, add the pinned fields to `release-please-config.json` `extra-files` at the same time.
When upgrading `@modelcontextprotocol/sdk`, re-check the supported MCP protocol matrix in `docs/contributing/mcp-debugging.md` and the initialize negotiation tests.

## Lint

[Biome](https://biomejs.dev/) is already configured (`biome.json`). Please try to keep new and modified files passing before you commit:

```bash
pnpm lint        # list violations
pnpm lint:fix    # apply auto-fixable changes
```

The codebase is warning-free and `pnpm lint` runs as part of the pre-push gate (see Git hooks below), so a new warning blocks the push. Intentional exceptions carry a `biome-ignore` comment with a reason.

## Git hooks

[Lefthook](https://lefthook.dev) installs git hooks automatically on `pnpm install` (via the `prepare` script):

- **pre-commit** (fast): formats the staged files with Biome and re-stages them, then runs **secretlint**, which BLOCKS the commit on a secret or an absolute home-dir path. It deliberately does NOT run lint/typecheck/tests, so it never slows the many automated commits the dev flow makes.
- **pre-push** (the gate): runs five checks in parallel — `pnpm verify:git-hooks`, `pnpm -r typecheck`, `pnpm lint:noconsole`, `pnpm lint`, and `pnpm vitest run --project canvas-render-node packages/canvas-render/src/mutation-lane-coverage.test.ts` — static gates only, so a broken build or a stray `console.*` in server code is caught before it leaves your machine. Test SUITES deliberately do not run here: the dev loop already ran the nearest layer for what changed, and CI runs everything on the push — running a suite a third time at push, on a machine saturated by the push itself, was double work and the origin of a load-dependent flake class. The last check is the only one anywhere that notices the mutation lane going stale: the lane covers a list of modules, so a new module is simply not covered and the weekly report still looks healthy.

`pnpm verify:git-hooks` checks the hooks themselves rather than your code. A tool that appends its own block to `.git/hooks/<name>` — several editor and code-intelligence integrations install that way — makes *its* exit status the script's, which silently reduces every lefthook command above to advisory while still printing failures as if they blocked. Run `pnpm verify:git-hooks --fix` to move an appended block ahead of lefthook's invocation.

Hooks are a local safety net, **not** a replacement for CI (the authoritative gate). Bypass a run when you must with `LEFTHOOK=0 git …` or `git push --no-verify` (e.g. a docs-only push). If the hooks didn't install, run `pnpm lefthook install`.

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

The PR title becomes the squash-merge commit message that release-please reads. Use a Conventional Commit title (`fix:`, `feat(scope):`, `chore:`, …). CI rejects tool prefixes such as `[codex] ...`. Release-please PRs follow the same rule (`chore(main): release X.Y.Z`, `chore(main): release mcp-server X.Y.Z`) — the `v` prefix only applies to the resulting tag (`include-v-in-tag: true`), not the commit / PR title.

## AI dev-flow tooling (`.claude/`)

This repo ships its local AI-orchestrated dev flow under `.claude/` (Claude Code workflows, agents, skills, rules, and the `new-worktree` helper). It is optional — you can develop without it — but it is tracked so the flow is shared and reviewable.

**Tracked** (shared): `.claude/workflows/`, `.claude/agents/`, `.claude/skills/`, `.claude/rules/`, `.claude/scripts/`, and `.claude/settings.json`.
**Local-only** (gitignored, never commit): `.claude/settings.local.json` (your personal hooks/env), `.claude/worktrees/` (ephemeral full worktrees with `node_modules`, recreated per run), `.claude/**/*.log`, and `CLAUDE.local.md`.

### First-clone setup

1. `pnpm install` (required before anything else — the dev daemon and tests need the workspace installed).
2. The MCP dev daemon is auto-started. `.claude/settings.json` wires a `SessionStart` hook to `ensure-http-dev-daemon.mjs`, which probes this checkout's derived dev port (3099 on the main checkout) and, if nothing is listening, launches `pnpm mcp:http:dev` detached and waits up to ~30s for it to bind.
3. **Register the stdio proxy once per checkout** so Claude Code actually talks to that daemon instead of the published npm package. `.claude/settings.json` has no `mcpServers` field in its schema — a definition there is silently ignored — so this is a one-time `--scope local` CLI registration (machine-private `~/.claude.json`) per checkout:

   ```bash
   claude mcp add --scope local --transport stdio whiteboard -- \
     node "$(git rev-parse --show-toplevel)/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs"
   ```

   Local scope shadows the repo-tracked `.mcp.json` (precedence: local > project), which stays pointed at the published `npx @kamiazya/whiteboard-mcp@latest` package — do not repoint `.mcp.json` at dev tooling. The proxy runs the ensure hook itself and retries each request across daemon watch-restarts, so registering it as stdio (rather than the HTTP URL directly) survives a `tsx watch` restart mid-session.
4. **Self-check — am I hitting my checkout, not npx?** Run `claude mcp get whiteboard`: it should show the `node .../mcp-http-stdio-proxy.mjs` command, not `npx -y @kamiazya/whiteboard-mcp@latest`. If it shows the `npx` command, step 3's local-scope registration did not take (or is missing) and your MCP calls are silently hitting the published package instead of your local code changes.
5. **If the daemon is not up** — hooks disabled, project not trusted yet, or the port is already taken — the `whiteboard` MCP server shows a connection error. This is **not fatal**: ordinary development (tests, build, lint) is unaffected. Start it manually with `pnpm mcp:http:dev` in another terminal.

See AGENTS.md's "MCP Development Mode" section for the full daemon/proxy design (per-worktree ports, the spawn lock, why stdio wraps HTTP) and `docs/contributing/mcp-debugging.md` for debugging the endpoint itself.

### Discipline (if you author/run workflows)

- **Never `cd` away from the repo root while a workflow is running.** Workflows compose child workflows with a repo-root-relative `scriptPath` (e.g. `.claude/workflows/review.workflow.mjs`) resolved against the session cwd; a mid-run `cd` breaks composition. Pass absolute paths to shell commands / use `git -C <dir>` instead.
- **Reload the session before relying on a newly-authored custom agent.** A new `.claude/agents/foo.md` is not registered as an `agentType` until the session reloads; a workflow calling `agent({agentType:'foo'})` before then fails.

## Architecture decisions

Significant technical decisions are recorded as Architecture Decision Records (ADRs) under [`docs/contributing/adr/`](docs/contributing/adr/). Read them before proposing a change that touches architecture, cross-cutting contracts, or transport choices — they explain the why behind non-obvious constraints.

## Security

Do **not** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your work is released under the [Apache License 2.0](LICENSE). Per Section 5 of the license, any contribution intentionally submitted for inclusion is licensed under Apache-2.0, without any additional terms.
