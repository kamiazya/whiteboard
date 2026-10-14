# Distribution E2E Smoke Tests

This directory contains end-to-end smoke scripts that validate the packaged distribution
artifacts — npm tarball and Docker image — against real process boundaries.

## test:e2e:distribution

The `test:e2e:distribution` root script runs the full distribution verification chain:
`pnpm build`, then the distribution vitest suite (`pnpm --filter @kamiazya/whiteboard-mcp
test:distribution:only` — the packed tarball, plain and under `WHITEBOARD_DEV=1`, the Codex
config and the packaged checkpoint flow), then `pnpm --filter @kamiazya/whiteboard-mcp
check:release-artifacts`, then `test:e2e:distribution:only`.
`check:release-candidate` runs those first two itself and then `test:e2e:distribution:only`, so
the `:only` chain holds only what nothing else in the release candidate runs.
The chain has twelve steps:

1. `pnpm smoke:e2e` — full stdio MCP round-trip against the source entry point (canvas create → checkpoint → restore → export)
2. `pnpm smoke:packaged` — full e2e round-trip against `dist/server/mcp/stdio.js`
3. `pnpm smoke:claude` — end-to-end Claude CLI integration smoke
4. `pnpm smoke:codex` — end-to-end Codex CLI integration smoke
5. `pnpm smoke:read-plane` — real-browser proof of the read plane (ADR-0042) through the extension: a sealed replica in real IndexedDB, the locked page a cold start lands on with the daemon gone, and the daemon page back on Reconnect
6. packaged daemon backup/restore smoke
7. packaged daemon replica-key smoke — `daemon rotate-replica-key` / `set-replica-tier` against a running daemon
8. packaged daemon support-bundle smoke
9. packaged daemon token smoke
10. packaged server-mode app smoke
11. packaged server-mode CLI smoke
12. packaged server-mode entrypoint smoke

## Vitest-backed vs Node-script smokes

### Vitest-backed (`mcp-distribution` project, opt-in)

These run as Vitest tests under `vitest.distribution.config.ts`. They are **not**
included in `pnpm test`; `pnpm test:distribution` runs them, building first:

| Vitest test file | What it drives |
|---|---|
| `src/server/mcp/packaged.distribution.test.ts` | the checkpoint flow against `dist/server/mcp/stdio.js` |
| `src/server/mcp/tarball.distribution.test.ts` | the packed `.tgz` |
| `src/server/mcp/codex-config.distribution.test.ts` | the Codex plugin manifest and MCP config |

The shared TypeScript implementations live alongside the tests as `*.distribution-impl.ts`
files and are excluded from the server build (`tsconfig.server.json`).

The `pnpm smoke:packaged`, `pnpm smoke:tarball` and `pnpm smoke:codex-config` commands are
**not** these tests: each is a plain Node script under `packages/mcp-server/scripts/smoke/`.
`smoke:packaged` in particular runs the full e2e round-trip (`mcp-e2e-smoke.mjs`), a different
flow from `packaged.distribution.test.ts`'s checkpoint flow.

### Build prerequisite

Every packaged smoke reads `dist/`, and each one names the same remedy when it is missing:
`pnpm build`, which is what CI's `packaged-smoke` job runs. `pnpm build:mcp` is not a
substitute — it produces no `dist/web-app`, so a server-mode smoke run after it tests a
server serving no app. `smoke-helpers.test.mjs` holds every script to the one spelling.

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
| `packaged-daemon-replica-key-smoke.mjs` | `daemon rotate-replica-key` / `set-replica-tier` against a running daemon: the key pair changes, the tier override takes and clears |
| `packaged-daemon-support-bundle-smoke.mjs` | Daemon support bundle |
| `packaged-daemon-token-smoke.mjs` | Daemon token auth |

### Shared helpers

`smoke-helpers.mjs` is the one home for what the scripts share: leak patterns,
failure reporting (`createFail`), the ES256 JWT and TLS fixtures the server-mode
smokes build their mock identity provider from, the CLI and container runners,
and the readiness polls. A script binds a helper to its own label or entry point
with a `create*` factory instead of re-declaring it; a function name declared at
the top level of two scripts fails `tools/arch-lint`'s
`distribution-smoke-helpers-one-place.test.ts`. The helpers' own unit coverage is
`smoke-helpers.test.mjs`, part of `pnpm test:scripts`. The scripts' length is held
by the `.mjs` ledger in `file-size-budget.test.ts` beside the TypeScript ones.

### External CLI smokes

`pnpm smoke:claude` and `pnpm smoke:codex` consume API quota and require the respective
CLI to be installed and authenticated. They are never part of `pnpm test` or
`pnpm test:distribution`.

`pnpm smoke:distribution:packaged:node` runs only the seven packaged node scripts, with no CLI
smoke, so it is the quota-free way to reproduce CI's `packaged-smoke` job after a build.
`pnpm smoke:distribution:packaged` is the two CLI smokes followed by that script.

## Smoke script naming

Each `.mjs` script in this directory targets a specific packaged deployment scenario:

- `packaged-daemon-*` — tests the daemon mode (`whiteboard --daemon`)
- `packaged-server-mode-*` — tests server mode (`whiteboard --server-mode`)

## Release gate matrix

The gates in `release-gate-matrix.json` reference commands from the root `package.json`.
A tier runs each gate once. `smoke:packaged` runs inside `test:e2e:distribution:only`.
`smoke:tarball` and `smoke:codex-config` do not appear in `check:release-candidate`'s chain at
all: they drive the same `*.distribution-impl.ts` flows as `tarball.distribution.test.ts` and
`codex-config.distribution.test.ts`, which the `test:distribution` gate's vitest suite already
runs (the tarball under `WHITEBOARD_DEV=1` too), so the suite is the one invocation. The standalone
scripts remain for running one smoke by hand and for CI's `verify` steps.
`release-gate-matrix.test.ts` expands each tier's chain through every script it names and fails
when a command, or a smoke implementation, is reached twice.

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

### The Docker gates on a pull request

`ci.yml`'s `dry-run-docker` job builds the server image once (buildx with the
GHA layer cache) and then runs `smoke:docker` and `smoke:docker-backup-restore`
against that same image, handed over through `WHITEBOARD_SMOKE_IMAGE`. A named
image that is not present is a hard failure rather than a rebuild — a fallback
there would turn one build per commit back into two while every log still read
as success.

Both run there now. `smoke:docker-backup-restore` was held back one increment:
running it for the first time showed it saved a workspace palette through a
route the server no longer has. That assertion moved to the workspace display
name — a `workspaces`-table row, so it still covers the category the palette
stood for: state that lives outside any document and has to survive the volume
round-trip. It also needs the `dist/` build the image dry-run does not produce,
which is why the job builds mcp-server before running it.

Both were `docker-release`-only before, so the container boundary — auth,
graceful stop, volume remount, log redaction — was first exercised during a
publish. Promoting them found six defects that a build-only dry-run cannot see:
three of the four image builds omitted the required `NODE_VERSION` build arg (the
image could not build), the musl libsql prebuild could not load on Alpine (it
could not start), scenario 8's leak check was scanning an empty string, scenario
4 asserted a `pid` the ping contract had dropped, `dist/server/server-mode-backup-restore.js`
was not a tsdown entry so no build produced it, and the palette route above.
`docker-contract.test.ts` classifies every file reaching the image build and
checks each passes the arg; `smoke-dist-entries.test.ts` checks every dist path a
smoke imports is a tsdown entry.

Whether a gate is exercised on a pull request is the separate `prCoverage` axis,
checked structurally against `ci.yml` by `gate-isomorphism.test.ts`. Its
`conditional-workflow-step` kind is for a step that runs on SOME pull requests:
the declared `condition` is compared against the step's real `if:`, so the two
cannot drift, and `conditionReason` has to argue why the pull requests it skips
cannot change the gate's answer. `publish:dry-run:docker` and both Docker smokes are on it —
`tools/checks/src/docker-build-inputs.mjs` decides whether a diff reaches what
`Dockerfile.server` compiles, deriving that set from the Dockerfile's own
`pnpm --filter` targets rather than a list.
