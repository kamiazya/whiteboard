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
 * The scan reads code with comments and prose blanked, so a comment naming
 * `ENOENT` is not a hit. It looks for the two spellings a copy takes: the
 * cast, and a comparison of something called `code` against an errno literal
 * (POSIX names carry no underscore, which is what keeps Node's own
 * `ERR_*` codes out of it).
 *
 * Only migrations are allowlisted, as history: their text is not edited
 * after the fact. Every other site in the daemon package goes through the
 * helper, and an entry that stops matching fails as stale, like every
 * allowlist here.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const SCANNED = 'packages/mcp-server/src'
const HELPER = 'packages/mcp-server/src/shared/errno.ts'

/** `(x as NodeJS.ErrnoException).code`, with or without `| undefined` or `?.`. */
const CAST = /NodeJS\.ErrnoException[^)]*\)\s*\??\.code\b/
/** `code === 'ENOENT'`, `err.code !== 'EEXIST'`, `error?.code == "EPERM"`. */
const COMPARISON = /\bcode\s*[!=]==?\s*['"]E[A-Z0-9]+['"]/

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

function errnoSpellings(source: string): string[] {
  const code = stripCommentsAndStrings(source)
  return [CAST, COMPARISON].flatMap((pattern) => {
    const hit = pattern.exec(code)
    return hit ? [hit[0]] : []
  })
}

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
      .flatMap((rel) => errnoSpellings(sourceOf(rel)).map((spelling) => `${rel}: ${spelling}`))
    expect(
      hits,
      'use `isMissingFileError` / `isErrnoCode` / `errnoCode` from shared/errno.ts: a cast reads `.code` off a null throw and raises inside the catch',
    ).toEqual([])
  })

  it('names the two spellings it looks for', () => {
    expect(
      errnoSpellings("if ((err as NodeJS.ErrnoException).code === 'ENOENT') x()"),
    ).toHaveLength(2)
    expect(errnoSpellings("if (code !== 'EEXIST') throw err")).toHaveLength(1)
    expect(
      errnoSpellings('if ((err as NodeJS.ErrnoException | undefined)?.code) x()'),
    ).toHaveLength(1)
  })

  it('does not read a comment, or a Node ERR_ code, as an errno', () => {
    expect(errnoSpellings("// code === 'ENOENT'\nconst x = 1")).toEqual([])
    expect(errnoSpellings("if (code === 'ERR_MODULE_NOT_FOUND') x()")).toEqual([])
  })

  it('every allowlist entry still spells one', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => errnoSpellings(sourceOf(rel)).length === 0)
    expect(stale, 'an entry that outlives its site is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(4)
  })
})
