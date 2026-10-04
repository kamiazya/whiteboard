/**
 * The sync wire's doc key is spelled in ONE place, and this scan is the
 * executable half of that.
 *
 * A page follows a workspace's record as `workspace:<id>` and a document as
 * `<handle>/<path>`; `sse-stream-hub.ts` in daemon-client builds and parses
 * both. That grammar is not the STORED key (`workspace-tree:<id>`, ports'
 * `docRefKey` — see `doc-ref-key-one-place.test.ts`): the two answer
 * different questions and a reader holding the wrong parser fails open, so a
 * second hand spelling of the wire prefix is a parser that agrees with
 * itself.
 *
 * The prefix constant is deliberately not exported, so a consumer cannot
 * reach it at all; what this scan finds is the literal spelled by hand.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { walkSourceFiles } from './source-scan.js'

/** Where the one spelling lives. Exempt by construction: it IS the place. */
const DECLARATION_SITE = 'packages/daemon-client/src/sse-stream-hub.ts'

/**
 * The wire prefix spelled by hand: a template with a hole after it, the
 * prefix as a whole quoted string (a `startsWith`, a `slice('…'.length)`, a
 * constant), a regex literal, or the constant's identifier. A quoted
 * `workspace:read` is an auth scope, not this key, so the quote must close
 * right after the colon.
 */
const WIRE_SPELLING =
  /`workspace:\$\{|['"]\^?workspace:['"]|\/\^?workspace:|\bWORKSPACE_DOC_KEY_PREFIX\b/g

function spellings(source: string): number {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
  return code.match(WIRE_SPELLING)?.length ?? 0
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) => !/\.(test|spec)\.tsx?$/.test(path) && !isExcludedPath(path),
)

const HOLE = ['$', '{id}'].join('')

describe('the sync wire doc key is spelled in one place', () => {
  it('recognises a template, a quoted prefix, a regex and the constant, and passes scopes and prose through', () => {
    expect(spellings(`const k = \`workspace:${HOLE}\``)).toBe(1)
    expect(spellings("if (key.startsWith('workspace:')) return")).toBe(1)
    expect(spellings("const id = key.slice('workspace:'.length)")).toBe(1)
    expect(spellings('const m = /^workspace:(.+)$/.exec(key)')).toBe(1)
    expect(spellings('if (key.startsWith(WORKSPACE_DOC_KEY_PREFIX)) return')).toBe(1)
    expect(spellings("const scope = 'workspace:read'")).toBe(0)
    expect(spellings(`// \`workspace:${HOLE}\` in a comment`)).toBe(0)
    expect(spellings(` * a \`workspace:\` key in a doc block`)).toBe(0)
    expect(spellings(`const k = \`workspaces:${HOLE}\``)).toBe(0)
  })

  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(800)
  })

  it('no file outside the declaration site spells the wire prefix', () => {
    const hits: string[] = []
    for (const path of files) {
      const rel = relativeToRepo(path)
      if (rel === DECLARATION_SITE) continue
      const found = spellings(readFileSync(path, 'utf8'))
      if (found > 0) hits.push(`${rel}: ${found}`)
    }
    expect(hits).toEqual([])
  })

  it('the declaration site spells it exactly as often as the grammar needs', () => {
    // The constant's declaration counts twice (identifier and literal), then
    // one use each in the builder, `workspaceIdOfSyncKey` (two) and
    // `workspaceHandleOfSyncKey`. A count that fell to zero would mean the
    // grammar moved and this scan guards a file that no longer holds it.
    expect(spellings(readFileSync(join(REPO_ROOT, DECLARATION_SITE), 'utf8'))).toBe(6)
  })
})
