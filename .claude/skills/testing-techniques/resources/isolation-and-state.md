# Isolation and state

A worker runs many test FILES, a file runs many tests, and a browser page runs beside other
pages. Anything not scoped to the test that made it is inherited by whatever runs next.

## Mocks

- **Call history must not leak between tests.** `test.clearMocks: true` runs
  `vi.clearAllMocks()` before every test (history cleared, implementations kept);
  `mockReset` also drops implementations; `restoreMocks` restores spied originals. Set
  `clearMocks: true` explicitly on Vitest 4 — it is the Vitest 5 default `[v5]`, and turning
  it on as its own slice makes an order-dependent test surface on its own rather than inside
  the upgrade diff. `clearMocks: false` restores the v4 behaviour.
- **`vi.mock` / `vi.unmock` / `vi.hoisted` are top-level only.** Vitest 4 warns on a call
  nested in a function or block; Vitest 5 throws with the location `[v5]`. Dynamic mocking
  inside a test is `vi.doMock` + a dynamic import after it — the one legitimate reason for an
  in-body `await import()`.
- **A test file imports statically unless it mocks what it imports.** An in-body
  `await import()` of a literal specifier charges that module graph's transform-and-load to
  the per-test timeout (blows first under a full parallel run); at module scope it can still
  be in flight when the environment is torn down (`EnvironmentTeardownError: Cannot load
  ... after the environment was torn down`, every test green, exit 1).
  `tools/arch-lint/src/test-lazy-import-check.test.ts` scans for it; `vi.mock` / `doMock` /
  `resetModules` in the file or a computed specifier (`pathToFileURL(...)`) are recognised
  structurally, anything else deliberate carries `// lazy-import: <reason>` on the line above.

### Conditional mocking: `vi.when` `[v5]`

```ts
const findById = vi.fn()
vi.when(findById)
  .calledWith(1).thenResolve({ id: 1, name: 'Ella' })
  .calledWith(2).thenResolve({ id: 2, name: 'Gracie' })
  .calledWith(expect.any(Number)).thenReject(new Error('not found'))

expect(findById).toHaveBeenExhausted()   // every registered behaviour was consumed
```

Replaces a `mockImplementation` that branches on its arguments. Arguments match by deep
equality and accept asymmetric matchers; `thenReturn` / `thenResolve` / `thenReject`, with
`thenReturnOnce` and a `times` option to bound a behaviour to N calls. `toHaveBeenExhausted`
turns "this mock was set up for a call that never came" into a failure instead of silence.

### Browser-mode automocks stay automocked `[v5]`

`vi.mock('./module')` with no factory in a browser test now returns `undefined` from every
export rather than falling through to the real implementation (the Vitest 4 behaviour).
`vi.mock('./module', { spy: true })` keeps the real calls while tracking them. Eight
`web-browser` files call `vi.mock`, all with factories today, so nothing here changes at
the upgrade.

## Storage and the filesystem

- **`localStorage` outlives a test and a worker runs many files.** `apps/web/vitest.setup.ts`
  clears it in the shared `afterEach`; measured before that, one test switching a layout
  preference made an element vanish for the thirteen tests after it, none naming the mover.
- **The mcp-node suite never touches the real data dir.** `packages/mcp-server/vitest.node.config.ts`
  points `WHITEBOARD_DATA_DIR` at `tmp/test-data-dir` inside the checkout (so two worktrees
  can run at once) and `globalSetup` empties it before every run — a database migrated by an
  older branch once died with unhandled `IncompatibleDatabaseError` while every test passed.
  `vitest-data-dir.test.ts` guards the isolation.
- **Per-worker names**: Vitest 5 makes `VITEST_POOL_ID` / `VITEST_WORKER_ID` 1-based. Nothing
  in the repo reads them today (measured); anything that derives a database or port from one
  re-checks its arithmetic at upgrade.
- `vi.stubEnv` / `vi.stubGlobal` restore with `vi.unstubAllEnvs()` / `vi.unstubAllGlobals()`
  or the `unstubEnvs` / `unstubGlobals` config; an env left set is the same leak as a fake
  clock.

## Shared globals across tests

- **A `SharedWorker` cannot be terminated**, so earlier tests' workers keep opening streams.
  `expect(streamOpens).toBe(1)` or a single `pushFrame` variable holding whichever stream
  opened LAST reads someone else's traffic as its own. Scope every assertion to a handle the
  test itself minted — a document id, and the stream correlated from that document's own
  request. Note the direction: only a LATER open breaks a "most recent" handle, so a
  reproduction has to get the order right (the first attempt did not, and its mutation check
  passed against the unfixed code).
- Module-level state in production code (`clearCache`, `clearWorkspaceIdCache`) is reset
  explicitly by the tests that depend on it; a test that forgets inherits the previous file's
  cache.

## Project filters and counts

- **vitest errors only when a `--project` filter set is EMPTY.** A name that matches nothing
  beside a sibling that does is silent: `--project web-jsdom --project web-browser` once ran
  only the browser project, reported its ~540 tests and exited 0, and let a real regression
  reach CI twice in one session. Match the local command to the CI job
  (`pnpm --filter @kamiazya/whiteboard-web test` for `test-jsdom`, which also runs
  `web-node`), and **treat a test count far below CI's as evidence the filter missed**.
- Every project config carries a `name:`; `tools/checks/src/vitest-projects.mjs` throws on
  one without, because the shared-layer CI step derives its `--project` list from them.
- Filters, the `-p` shorthand and nested projects, pools and caches are
  `resources/configuration.md` — including why nested `projects` must wait for that
  derivation to understand them.

## Environment premises

A test whose premise this environment cannot establish SKIPS and says so — **probed, never
inferred** — because a skipped test reads exactly like a passing one. `CAN_DENY_FILE_READ`
(`packages/mcp-server/src/shared/test-utils/can-deny-file-read.ts`) writes a file, closes it
off and tries to read it, rather than asking `getuid() === 0`, and on CI it MUST be true so
the skip cannot quietly disable those paths for everyone. `local-node-version.test.ts` fails
naming the consequence of the wrong Node major (nine `web-jsdom` tests fail with a message
about `Blob` that names neither Node nor the guard).
