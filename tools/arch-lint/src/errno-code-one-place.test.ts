/**
 * What an error's `code` says is read in ONE place, `shared/errno.ts`, and
 * this scan is the executable half of that.
 *
 * Why it needs a scan. `isMissingFileError` existed under `server/store/`,
 * which `cli/` and `shared/` cannot reasonably import, and the check spread
 * as 20 hand-written `code === 'ENOENT'` in 14 files plus 27 casts to
 * `NodeJS.ErrnoException`. The cast is the dangerous half: it reads `.code`
 * off whatever was thrown, so a `null` or a primitive throw becomes a
 * `TypeError` raised INSIDE the catch that was meant to classify it, masking
 * the original failure. `errnoCode` is total over `unknown`.
 *
 * The scan reads the syntax tree (`errno-spelling-scan.ts`), so a comment
 * naming `ENOENT` is not a hit and neither is a spelling a text pattern
 * would have keyed past. It looks for two families: what makes `.code`
 * readable off a thrown value (an assertion to `ErrnoException` under any
 * alias, or a variable declared as one), and a comparison of a `code` read
 * against an errno literal in any order, as a `switch` case, or through an
 * `includes` over a list of them. POSIX names carry no underscore, which is
 * what keeps Node's own `ERR_*` codes out of it.
 *
 * Only migrations are allowlisted, as history: their text is not edited
 * after the fact. Every other site in the daemon package goes through the
 * helper, and an entry that stops matching fails as stale, like every
 * allowlist here.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { errnoSpellings as spellingsIn } from './errno-spelling-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SCANNED = 'packages/mcp-server/src'
const HELPER = 'packages/mcp-server/src/shared/errno.ts'

/** Relative path -> why this file may still spell it. Both-sided. */
const MIGRATION_HISTORY =
  "a migration's text is what it ran with, and a step already recorded as applied is not edited after the fact"
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/store/db/migrations/0008-ulid-legacy-canvas-ids.ts':
    MIGRATION_HISTORY,
  'packages/mcp-server/src/server/store/db/migrations/0011-import-fs-blobs.ts': MIGRATION_HISTORY,
  'packages/mcp-server/src/server/store/db/migrations/0012-ulid-remaining-document-ids.ts':
    MIGRATION_HISTORY,
  'packages/mcp-server/src/server/store/db/migrations/0019-workspace-canonical-id.ts':
    MIGRATION_HISTORY,
}

const errnoSpellings = (source: string, fileName = 'fixture.ts'): string[] =>
  spellingsIn(fileName, source)

const files = walkSourceFiles(join(REPO_ROOT, SCANNED)).filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const sourceOf = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('an error code is read in one place', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(files.length).toBeGreaterThan(150)
    expect(files.map(relOf)).toContain(HELPER)
  })

  it('no production source reads an errno by hand', () => {
    const hits = files
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .flatMap((rel) => errnoSpellings(sourceOf(rel), rel).map((spelling) => `${rel}: ${spelling}`))
    expect(
      hits,
      'use `isMissingFileError` / `isErrnoCode` / `errnoCode` from shared/errno.ts: a cast reads `.code` off a null throw and raises inside the catch',
    ).toEqual([])
  })

  it('names the spellings it looks for', () => {
    expect(
      errnoSpellings("if ((err as NodeJS.ErrnoException).code === 'ENOENT') x()"),
    ).toHaveLength(2)
    expect(errnoSpellings("if (code !== 'EEXIST') throw err")).toHaveLength(1)
    expect(
      errnoSpellings('if ((err as NodeJS.ErrnoException | undefined)?.code) x()'),
    ).toHaveLength(1)
  })

  it.each([
    ['a reversed comparison', "if ('ENOENT' === err.code) x()"],
    ['a bracket read', "if (err['code'] === 'ENOENT') x()"],
    ['a switch on the code', "switch (err.code) { case 'ENOENT': return null }"],
    ['an includes over errno literals', "if (['ENOENT', 'EEXIST'].includes(code)) x()"],
    ['a cast under an alias type', 'const c = (err as ErrnoException).code'],
    ['a cast read later', 'const e = err as NodeJS.ErrnoException\nthrow e'],
    ['an angle-bracket cast', 'const c = (<NodeJS.ErrnoException>err).code'],
    ['a typed local', 'const e: NodeJS.ErrnoException = err\nreturn e.code'],
  ])('recognises %s', (_label, source) => {
    expect(errnoSpellings(source)).not.toEqual([])
  })

  it('does not read a comment, or a Node ERR_ code, as an errno', () => {
    expect(errnoSpellings("// code === 'ENOENT'\nconst x = 1")).toEqual([])
    expect(errnoSpellings("if (code === 'ERR_MODULE_NOT_FOUND') x()")).toEqual([])
    expect(errnoSpellings("if (kind === 'ENOENT') x()")).toEqual([])
    expect(errnoSpellings("switch (kind) { case 'ENOENT': return null }")).toEqual([])
    expect(errnoSpellings("if (['ENOENT'].includes(kind)) x()")).toEqual([])
    expect(errnoSpellings("if (['READY', 'DONE'].includes(code)) x()")).toEqual([])
    // A list is an errno spelling only when EVERY element is one, and a list
    // has to have one.
    expect(errnoSpellings("if (['ENOENT', 'READY'].includes(code)) x()")).toEqual([])
    expect(errnoSpellings('if ([].includes(code)) x()')).toEqual([])
    expect(errnoSpellings("const m = { code: 'ENOENT' }")).toEqual([])
    expect(
      errnoSpellings('const t = (err: unknown): err is NodeJS.ErrnoException => !!err'),
    ).toEqual([])
  })

  it('every allowlist entry still spells one', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (rel) => errnoSpellings(sourceOf(rel), rel).length === 0,
    )
    expect(stale, 'an entry that outlives its site is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(4)
  })
})
