// This file pilots the vitest 4.1 `aroundEach` rollback pattern. Migrations
// run ONCE per file (file-scoped fixture); each `it` runs inside a
// transaction that is rolled back at the end so the next test sees a clean
// schema without paying for fresh migrations. Only safe for stores whose
// production code does not open transactions of its own — palette-store
// only does single-statement reads/writes, so it qualifies.

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { describe, expect, test as baseTest, vi } from 'vitest'

// File-scoped state the vi.mock getter and the fixture both share. Vitest
// invokes vi.mock factories before any fixture body, but the getter is read
// lazily on each property access, so wiring DATA_DIR through `tempDirRef`
// works as long as the fixture sets it before any production import touches
// the config module.
let tempDirRef = ''

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tempDirRef, 'data')
  },
}))

const {
  deletePaletteEntries,
  loadPalette,
  mergePaletteEntries,
} = await import('./palette-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

interface StoreFixture {
  // Exposed only so a future failure can sniff the underlying connection;
  // tests do not need it directly.
  db: Awaited<ReturnType<typeof createIsolatedDb>>['db']
}

const test = baseTest.extend<{ store: StoreFixture }>({
  store: [
    // vitest's test.extend parses the first parameter at runtime and
    // requires an object destructuring pattern; renaming to a plain
    // identifier throws FixtureParseError. The fixture genuinely takes
    // no per-test inputs.
    // biome-ignore lint/correctness/noEmptyPattern: vitest fixture API requires object destructuring
    async ({}, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'palette-store-test-'))
      tempDirRef = dir
      await mkdir(join(dir, 'data'), { recursive: true })
      const handle = await createIsolatedDb({ dataDir: join(dir, 'data') })
      await use({ db: handle.db })
      await handle.dispose()
      await rm(dir, { recursive: true, force: true })
      tempDirRef = ''
    },
    { scope: 'file' },
  ],
})

// Why raw BEGIN / ROLLBACK instead of `db.transaction().execute(...)`:
// Kysely's transaction API gives the caller a `trx` and runs the callback
// concurrently with — but isolated from — the outer `db`. With SqliteDialect
// the underlying connection is single-threaded, so any query on the outer
// `db` while the trx callback is running waits for the connection to release,
// which never happens until the test ends. Production code calls
// `getDb(DATA_DIR)` and queries through that outer `db`, so the high-level
// transaction wrapper deadlocks every test.
//
// Raw `BEGIN`/`ROLLBACK` over the outer `db` avoids the wrapper: every
// subsequent query reuses the same single connection that is already in a
// transaction, and the final ROLLBACK reverts everything atomically.
test.aroundEach(async (runTest, { store }) => {
  await sql`BEGIN`.execute(store.db)
  try {
    await runTest()
  } finally {
    await sql`ROLLBACK`.execute(store.db)
  }
})

describe('palette-store', () => {
  test('returns an empty palette for an uninitialized session', async () => {
    await expect(loadPalette('session1')).resolves.toEqual({})
  })

  test('mergePaletteEntries adds and overwrites while preserving existing keys', async () => {
    await mergePaletteEntries('session1', { 'plan.a': '#dbeafe' })
    const next = await mergePaletteEntries('session1', {
      'accent.target': '#1971c2',
      'plan.a': '#bfdbfe',
    })
    expect(next).toEqual({
      'accent.target': '#1971c2',
      'plan.a': '#bfdbfe',
    })
  })

  test('deletePaletteEntries removes only the requested keys', async () => {
    await mergePaletteEntries('session1', {
      'plan.a': '#dbeafe',
      'accent.target': '#1971c2',
    })
    const next = await deletePaletteEntries('session1', ['plan.a'])
    expect(next).toEqual({
      'accent.target': '#1971c2',
    })
  })

  test('rollback isolates writes between tests (sentinel)', async () => {
    // If the rollback wrap leaks state, the previous test's mutation under
    // 'session1' would still be visible here. The empty result is the
    // contract that lets us trust per-test isolation despite the shared
    // file-scoped DB.
    await expect(loadPalette('session1')).resolves.toEqual({})
  })
})
