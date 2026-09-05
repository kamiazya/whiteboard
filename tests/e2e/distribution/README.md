# Distribution E2E Smoke Tests

This directory contains end-to-end smoke scripts that validate the packaged distribution
artifacts — npm tarball and Docker image — against real process boundaries.

## test:e2e:distribution

The `test:e2e:distribution` root script runs the full distribution verification chain.
The chain has fifteen steps after the initial build prerequisite:

1. `pnpm smoke:e2e` — full stdio MCP round-trip against the source entry point (canvas create → checkpoint → restore → export)
2. `pnpm smoke:tarball` — validates the packed `.tgz` is installable and functional
3. `pnpm smoke:packaged` — full e2e round-trip against `dist/server/mcp/index.js`
4. `pnpm smoke:codex-config` — validates the Codex plugin manifest and published MCP config
5. `pnpm smoke:claude` — end-to-end Claude CLI integration smoke
6. `pnpm smoke:codex` — end-to-end Codex CLI integration smoke
7. `pnpm smoke:daemon-origin` — real-browser proof the daemon origin serves a connected apps/web app (seeded canvas, no pairing CTA, token-gated mutation)
8. `pnpm --filter @kamiazya/whiteboard-mcp check:release-artifacts` — artifact content checks
9. packaged daemon backup/restore smoke
10. packaged daemon logs smoke
11. packaged daemon support-bundle smoke
12. packaged daemon token smoke
13. packaged server-mode app smoke
14. packaged server-mode CLI smoke
15. packaged server-mode entrypoint smoke

## Vitest-backed vs Node-script smokes

### Vitest-backed (`mcp-distribution` project, opt-in)

These smokes run as Vitest tests under `vitest.distribution.config.ts`. They are **not**
included in `pnpm test`; use `pnpm test:distribution` (includes build) or individual
`pnpm smoke:*` commands:

| Command | Vitest test file |
|---|---|
| `pnpm smoke:packaged` | `src/server/mcp/packaged.distribution.test.ts` |
| `pnpm smoke:tarball` | `src/server/mcp/tarball.distribution.test.ts` |
| `pnpm smoke:codex-config` | `src/server/mcp/codex-config.distribution.test.ts` |

The shared TypeScript implementations live alongside the tests as `*.distribution-impl.ts`
files and are excluded from the server build (`tsconfig.server.json`).

### Remaining Node-script smokes

The scripts in `tests/e2e/distribution/` are plain Node scripts, not Vitest tests.
They are run individually or via the CI release workflow:

| Script | What it tests |
|---|---|
| `packaged-server-mode-docker-smoke.mjs` | Docker image build and server-mode startup (requires Docker daemon) |
| `packaged-server-mode-backup-restore-smoke.mjs` | Server-mode backup/restore over HTTP |
| `packaged-server-mode-entrypoint-smoke.mjs` | Server-mode entrypoint and route smoke |
| `packaged-server-mode-cli-smoke.mjs` | Server-mode CLI behavior |
| `packaged-server-mode-app-smoke.mjs` | Server-mode app surface |
| `packaged-daemon-backup-restore-smoke.mjs` | Daemon backup/restore |
| `packaged-daemon-logs-smoke.mjs` | Daemon log endpoint |
| `packaged-daemon-support-bundle-smoke.mjs` | Daemon support bundle |
| `packaged-daemon-token-smoke.mjs` | Daemon token auth |

### External CLI smokes

`pnpm smoke:claude` and `pnpm smoke:codex` consume API quota and require the respective
CLI to be installed and authenticated. They are never part of `pnpm test` or
`pnpm test:distribution`.

## Smoke script naming

Each `.mjs` script in this directory targets a specific packaged deployment scenario:

- `packaged-daemon-*` — tests the daemon mode (`whiteboard --daemon`)
- `packaged-server-mode-*` — tests server mode (`whiteboard --server-mode`)

## Release gate matrix

The gates in `release-gate-matrix.json` reference commands from the root `package.json`.
Two gates — `smoke:tarball` and `smoke:packaged` — are covered transitively through
`test:e2e:distribution` rather than appearing directly in `check:release-candidate`.

A gate's `requiredFor` tiers name the aggregate **script** that must invoke it, not
where it happens to run. Each tier has exactly one runner:

| tier | runner |
|---|---|
| `ci` | `pnpm check:release-candidate` |
| `local-release` | `pnpm check:release-candidate:local` |
| `docker-release` | `pnpm check:release-candidate:docker` |
| `publish` | `pnpm publish-gate` (`tools/checks/src/publish-gate.mjs`) |
| `pages-release` | `pnpm check:pages-release` (`tools/checks/src/pages-release.mjs`) |
| `publish-dry-run` | `pnpm publish:dry-run` |

`publish-dry-run` is disjoint from every other tier by design. Rehearsing a publish
does not belong in a release-candidate check, and `publish-gate.mjs` executes every
`publish` gate — so tagging a rehearsal `publish` would re-run it during the real
publish. Its two gates are the only Docker-capable gates outside `docker-release`;
that is allowed because `publish:dry-run:docker` exits 0 with a skip line when no
daemon answers, a fail-soft the `ci` and `local-release` aggregates must not have.

Whether a gate is exercised on a pull request is the separate `prCoverage` axis,
checked structurally against `ci.yml` by `gate-isomorphism.test.ts`. Its
`conditional-workflow-step` kind is for a step that runs on SOME pull requests:
the declared `condition` is compared against the step's real `if:`, so the two
cannot drift, and `conditionReason` has to argue why the pull requests it skips
cannot change the gate's answer. `publish:dry-run:docker` is the one gate on it —
`tools/checks/src/docker-build-inputs.mjs` decides whether a diff reaches what
`Dockerfile.server` compiles, deriving that set from the Dockerfile's own
`pnpm --filter` targets rather than a list.
