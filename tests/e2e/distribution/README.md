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
5. `pnpm smoke:template` — template tool render and content checks
6. `pnpm smoke:claude` — end-to-end Claude CLI integration smoke
7. `pnpm smoke:codex` — end-to-end Codex CLI integration smoke
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
