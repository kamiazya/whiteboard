/**
 * A test that parks an IndexedDB at an OLD version must own that database.
 *
 * IndexedDB is one object per origin and browser test files share an origin,
 * so `whiteboard` is global across every one of them. Opening it at the
 * current `DB_VERSION` is harmless — every file is asking for the same thing.
 * Opening it at a LOWER version is not: it holds the database there, and any
 * other file whose open triggers an upgrade meanwhile fails with `another tab
 * has this app open at an older version`, in whichever file happens to be
 * running. The report then names a test that did nothing wrong.
 *
 * `openWhiteboardDb(name)` and both stores take a database name for exactly
 * this reason, and for a long time nothing passed one.
 *
 * The rule is stated as "no version games ON THE SHARED NAME" rather than "no
 * literal `'whiteboard'` next to a version": a file that names its database in
 * a `const` — which is how one ends up written — defeats the literal form
 * entirely. That version of this guard passed while the file it was written
 * for sat on the shared database.
 *
 * Read as text via Vite's `?raw` glob, the same shape as
 * `App.lazy-coverage.test.ts`: apps/web is browser-only and has no `node:fs`.
 */
import { describe, expect, it } from 'vitest'
import { DB_VERSION } from './browser-idb.js'

const sources = import.meta.glob('../**/*.{test,browser.test}.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/** `indexedDB.open(<anything>, <version>)` — a version-pinned open, however the name is spelled. */
const VERSION_PINNED_OPEN = /indexedDB\.open\([^,)]+,\s*([^)]+)\)/g

/** Any deletion at all, however the database is named. */
const ANY_DELETE = /indexedDB\s*\.\s*deleteDatabase\(/

/**
 * The one place a test may delete a database, and the one reasoned exception.
 *
 * `clearWhiteboardDb` is the definition; everything else awaits it. The
 * exception deletes a name NO LATER CASE REUSES, so a blocked deletion there
 * cannot hand anyone stale rows — and it must stay best-effort, because it
 * does not own when its collaborators close their connections and waiting
 * could hang instead.
 *
 * Both sides are checked below, so an entry cannot outlive what it names.
 */
const MAY_DELETE = [
  '../test-utils/browser-document.ts',
  './folding-browser-index.conformance.browser.test.tsx',
]

/** The shared database's name as a standalone literal, not a prefix of another one. */
const SHARED_NAME_LITERAL = /'whiteboard'/

function pinnedVersions(source: string): string[] {
  return (
    [...source.matchAll(VERSION_PINNED_OPEN)]
      .map((match) => (match[1] ?? '').trim())
      // Everyone agreeing on the current version can block nobody. Anything
      // else — a literal, or `DB_VERSION ± n` — can.
      .filter((version) => version !== 'DB_VERSION')
  )
}

/** Files that hold a database at some other version AND name the shared one. */
function offendingFiles(entries: Record<string, string>): string[] {
  return Object.entries(entries)
    .filter(([, source]) => pinnedVersions(source).length > 0)
    .filter(([, source]) => SHARED_NAME_LITERAL.test(source))
    .map(([path]) => path)
    .sort()
}

/** Touching the SHARED database by its literal name, in either destructive form. */
const DELETES_SHARED = /deleteDatabase\(\s*['"]whiteboard['"]\s*\)/
const OPENS_SHARED = /indexedDB\s*\.\s*open\(\s*['"]whiteboard['"]/

function handRolledDeleters(entries: Record<string, string>): string[] {
  return Object.entries(entries)
    .filter(([path]) => !MAY_DELETE.includes(path))
    .filter(([, source]) => ANY_DELETE.test(source))
    .map(([path]) => path)
    .sort()
}

function sharedDbTouchers(entries: Record<string, string>): string[] {
  return Object.entries(entries)
    .filter(([, source]) => DELETES_SHARED.test(source) || OPENS_SHARED.test(source))
    .map(([path]) => path)
    .sort()
}

describe('a test that parks IndexedDB at an old version', () => {
  it('is compared against a real current version', () => {
    expect(DB_VERSION).toBeGreaterThan(0)
  })

  it('never does it to the database every other browser test shares', () => {
    expect(offendingFiles(sources)).toEqual([])
  })

  it('is actually detected — an empty result means clean, not blind', () => {
    // Both halves, because either one silently passing makes the guard useless:
    // the version scan surviving a formatter, and the name check seeing a
    // database named in a const rather than inline.
    expect(pinnedVersions('indexedDB.open(NAME, 7)')).toEqual(['7'])
    expect(pinnedVersions('indexedDB.open(NAME, DB_VERSION)')).toEqual([])
    expect(pinnedVersions('indexedDB.open(NAME, DB_VERSION - 1)')).toEqual(['DB_VERSION - 1'])
    expect(
      offendingFiles({ 'x.test.ts': "const NAME = 'whiteboard'\nindexedDB.open(NAME, 7)" }),
    ).toEqual(['x.test.ts'])
    expect(
      offendingFiles({ 'x.test.ts': "const NAME = 'whiteboard-mine'\nindexedDB.open(NAME, 7)" }),
    ).toEqual([])
  })
})

describe('the shared whiteboard database, by name', () => {
  // Ten files used to deleteDatabase('whiteboard') in beforeEach — each one
  // destroying whatever a concurrently-running neighbour had just seeded,
  // with the failure surfacing in the neighbour. The seam is
  // claimIsolatedWhiteboardDb(fileTag): the file's whole module graph (page
  // stores included) resolves a private name, and its deletes hit that name.
  it('is never opened or deleted by literal name in a browser test', () => {
    expect(sharedDbTouchers(sources)).toEqual([])
  })

  it('detects both destructive forms, so clean means clean rather than blind', () => {
    expect(
      sharedDbTouchers({ 'x.browser.test.tsx': "indexedDB.deleteDatabase('whiteboard')" }),
    ).toEqual(['x.browser.test.tsx'])
    expect(
      sharedDbTouchers({ 'x.browser.test.tsx': "indexedDB.open('whiteboard', DB_VERSION)" }),
    ).toEqual(['x.browser.test.tsx'])
    // The PNG iTXt keyword is also the literal 'whiteboard' — a keyword
    // argument, not a database touch, and must stay legal.
    expect(
      sharedDbTouchers({ 'x.browser.test.tsx': "extractTextFromPng(bytes, 'whiteboard')" }),
    ).toEqual([])
  })
})

describe('deleting a database between cases', () => {
  // 26 files hand-rolled this, and 20 of them got `blocked` wrong the same
  // way: they resolved on it. `blocked` fires INSTEAD of success or error
  // while another connection is open, so resolving there tells the next test
  // a database was cleared when it was not — and the failure surfaces
  // somewhere else entirely, as a page reporting it could not read its own
  // data. It took two files showing that symptom before anyone looked here.
  //
  // The five that had it right said so in a comment each. The knowledge was
  // in the repo the whole time; what was missing was one definition for it
  // to live in.
  it('goes through clearWhiteboardDb, which is the only definition', () => {
    expect(handRolledDeleters(sources)).toEqual([])
  })

  it('exempts only files that exist, so an entry cannot outlive what it names', () => {
    // The other half. A path that stops matching any file is an exemption
    // nobody can trip over — and reads exactly like a rule being obeyed.
    expect(MAY_DELETE.filter((path) => !(path in sources))).toEqual([
      // The definition itself is not a test file, so the glob never sees it.
      '../test-utils/browser-document.ts',
    ])
  })

  it('is actually detected — an empty result means clean, not blind', () => {
    expect(handRolledDeleters({ 'x.browser.test.tsx': 'indexedDB.deleteDatabase(NAME)' })).toEqual([
      'x.browser.test.tsx',
    ])
    expect(handRolledDeleters({ 'x.browser.test.tsx': 'await clearNamedDb(NAME)' })).toEqual([])
  })
})
