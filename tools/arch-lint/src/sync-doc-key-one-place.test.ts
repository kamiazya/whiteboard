/**
 * The sync wire's doc key is spelled in ONE place, and this scan is the
 * executable half of that.
 *
 * A page follows a workspace's record as `workspace:<id>` and a document as
 * `<handle>/<path>`; `sse-stream-hub.ts` in daemon-client builds and parses
 * both (`workspaceDocKey` and `documentSyncKey` build, the `*OfSyncKey`
 * functions parse). That grammar is not the STORED key (`workspace-tree:<id>`, ports'
 * `docRefKey` — see `doc-ref-key-one-place.test.ts`): the two answer
 * different questions and a reader holding the wrong parser fails open, so a
 * second hand spelling of the wire prefix is a parser that agrees with
 * itself.
 *
 * The prefix constant is deliberately not exported, so a consumer cannot
 * reach it at all; what this scan finds is the literal spelled by hand. The
 * per-document half has no prefix to hide, so it is found by its join: a
 * template that is exactly a workspace handle, a slash and a path.
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

/**
 * The per-document key spelled by hand: a whole template of
 * `<…workspaceId or …handle>/<…path>`. Closing the backtick right after the
 * path is what separates a key from a message that merely names a document
 * (`Document "${workspaceId}/${path}" already exists`) or a longer URL.
 */
const DOCUMENT_KEY_JOIN = /`\$\{[\w.]*(?:[wW]orkspaceId|[hH]andle)\}\/\$\{[\w.]*[pP]ath\}`/g

/**
 * Files that join a handle and a path into a key of their own, one that is
 * never parsed by `workspaceHandleOfSyncKey` and never leaves the process.
 * `history` cannot import daemon-client, and the scheduler's map key is
 * private to it.
 */
const PRIVATE_DOCUMENT_KEYS = new Set(['packages/history/src/checkpoints/scheduler.ts'])

function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

function spellings(source: string): number {
  return code(source).match(WIRE_SPELLING)?.length ?? 0
}

function documentJoins(source: string): number {
  return code(source).match(DOCUMENT_KEY_JOIN)?.length ?? 0
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

  it('recognises a handle-and-path join under every name in use, and passes messages and URLs through', () => {
    const hole = (name: string) => ['$', `{${name}}`].join('')
    const join = (a: string, b: string) => `${hole(a)}/${hole(b)}`
    expect(documentJoins(`const k = \`${join('workspaceId', 'path')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('handle', 'path')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('canvas.workspaceId', 'canvas.path')}\``)).toBe(1)
    expect(documentJoins(`key = \`${join('this.workspaceId', 'documentPath')}\``)).toBe(1)
    expect(
      documentJoins(`throw new Error(\`Document "${join('workspaceId', 'path')}" exists\`)`),
    ).toBe(0)
    expect(documentJoins(`const url = \`${join('base', 'path')}\``)).toBe(0)
    expect(documentJoins(`const url = \`/api/w/${join('workspaceId', 'path')}\``)).toBe(0)
    expect(documentJoins(`// \`${join('workspaceId', 'path')}\` in a comment`)).toBe(0)
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

  it('no file outside the declaration site joins a handle and a path into a key by hand', () => {
    const hits: string[] = []
    for (const path of files) {
      const rel = relativeToRepo(path)
      if (rel === DECLARATION_SITE || PRIVATE_DOCUMENT_KEYS.has(rel)) continue
      const found = documentJoins(readFileSync(path, 'utf8'))
      if (found > 0) hits.push(`${rel}: ${found}`)
    }
    expect(hits).toEqual([])
  })

  it('the private-key exemptions still join one, and the declaration site joins exactly once', () => {
    // An exemption whose file stopped spelling the join is a stale entry; a
    // declaration site at zero would mean the builder moved.
    for (const rel of PRIVATE_DOCUMENT_KEYS) {
      expect(documentJoins(readFileSync(join(REPO_ROOT, rel), 'utf8'))).toBeGreaterThan(0)
    }
    expect(documentJoins(readFileSync(join(REPO_ROOT, DECLARATION_SITE), 'utf8'))).toBe(1)
  })

  it('the declaration site spells it exactly as often as the grammar needs', () => {
    // The constant's declaration counts twice (identifier and literal), then
    // one use each in the builder, `workspaceIdOfSyncKey` (two) and
    // `workspaceHandleOfSyncKey`. A count that fell to zero would mean the
    // grammar moved and this scan guards a file that no longer holds it.
    expect(spellings(readFileSync(join(REPO_ROOT, DECLARATION_SITE), 'utf8'))).toBe(6)
  })
})
