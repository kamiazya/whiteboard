/**
 * The stored `docKey` of a document is spelled in ONE place, and this scan is
 * the executable half of that.
 *
 * `docRefKey` is the `docKey` column on the daemon's snapshot, chunk,
 * frontier and delta tables and the key into the browser's matching
 * IndexedDB stores, so two stores that spell it differently cannot read each
 * other's documents and nothing at compile time says so. Two test doubles
 * kept their own private copy for exactly as long as nothing looked: the
 * drift would have shown up as a fixture that agrees with itself.
 *
 * What is NOT a copy: a file that must keep writing the OLD or a deliberately
 * wrong key. They stay allowlisted, each pinned to the number of templates it
 * spells, because an exemption is a classification and an allowlisted file
 * must not be able to grow a second, unclassified copy.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { walkSourceFiles } from './source-scan.js'

/** Where the one spelling lives. Exempt by construction: it IS the place. */
const DECLARATION_SITE = 'packages/ports/src/doc-ref-key.ts'

/**
 * A key written or read back by spelling its prefix: a template, a quoted
 * prefix (a concatenation, a `slice('…'.length)`, a `startsWith`, a prefix
 * constant) or a regex literal. The inverse is as much a copy as the writer —
 * a parser that stops matching what `docRefKey` writes fails open.
 */
const KEY_SPELLING =
  /`(?:document|workspace-tree):\$\{|['"]\^?(?:document|workspace-tree):['"]|\/\^?(?:document|workspace-tree):/g

function spellings(source: string): number {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
  return code.match(KEY_SPELLING)?.length ?? 0
}

const ALLOWLIST: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  'apps/web/src/lib/browser-idb-upgrades.ts': {
    count: 5,
    reason:
      'an IndexedDB upgrade rewrites rows from the key shape an older database holds, so it must stay frozen rather than follow the live spelling',
  },
  'apps/web/src/test-utils/browser-document.ts': {
    count: 1,
    reason:
      'a test fixture listing the raw store keys strips the document prefix back to ids, because ports exports no inverse for the document arm of the key',
  },
  'apps/web/src/test-utils/seed-sync-document.ts': {
    count: 1,
    reason:
      'writes a raw malformed value straight into the object store, bypassing the store on purpose, so it cannot go through a DocRef',
  },
  'packages/mcp-server/src/server/store/workspace-doc-cache.ts': {
    count: 1,
    reason:
      'a corruption message labelling the workspace record; it never reads or writes a row by this key',
  },
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) => !/\.(test|spec)\.tsx?$/.test(path) && !isExcludedPath(path),
)

// Joined rather than written, so the fixtures below hold a real placeholder
// without the linter reading each one as a template that forgot its backticks.
const HOLE = ['$', '{id}'].join('')

describe('the stored document key is spelled in one place', () => {
  it('recognises a template and a concatenation and passes prose and other prefixes through', () => {
    expect(spellings(`const k = \`document:${HOLE}\``)).toBe(1)
    expect(spellings(`const k = \`workspace-tree:${HOLE}\``)).toBe(1)
    expect(spellings("const k = 'document:' + id")).toBe(1)
    expect(spellings(`// \`document:${HOLE}\` in a comment`)).toBe(0)
    expect(spellings(` * \`workspace-tree:${HOLE}\` in a doc block`)).toBe(0)
    expect(spellings(`const k = \`documents:${HOLE}\``)).toBe(0)
    expect(spellings(`const k = \`${HOLE}:${HOLE}\``)).toBe(0)
  })

  it('recognises the key parsed back with a regex, a slice or a prefix test', () => {
    expect(spellings('const m = /^workspace-tree:(.+)$/.exec(key)')).toBe(1)
    expect(spellings('const m = key.match(/^document:(.+)$/)')).toBe(1)
    expect(spellings("const id = key.slice('workspace-tree:'.length)")).toBe(1)
    expect(spellings("if (key.startsWith('document:')) return")).toBe(1)
    expect(spellings("const prefix = 'workspace-tree:'")).toBe(1)
    // A concatenation is one spelling, not two.
    expect(spellings("const k = 'document:' + id")).toBe(1)
    expect(spellings('// /^workspace-tree:(.+)$/ in a comment')).toBe(0)
    expect(spellings('const m = /^documents:(.+)$/.exec(key)')).toBe(0)
    expect(spellings("const k = 'workspace-tree-index'")).toBe(0)
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(files.length).toBeGreaterThan(800)
  })

  it('no file outside ports spells the key itself, allowlisted files included', () => {
    const hits: string[] = []
    for (const path of files) {
      const rel = relativeToRepo(path)
      if (rel === DECLARATION_SITE) continue
      const found = spellings(readFileSync(path, 'utf8'))
      if (found > (ALLOWLIST[rel]?.count ?? 0)) hits.push(`${rel}: ${found}`)
    }
    expect(hits).toEqual([])
  })

  it('every allowlisted file spells the key exactly as many times as claimed', () => {
    // Guarded from both sides: an entry that stopped being true exempts nothing
    // and reads exactly like a rule being kept.
    for (const [rel, { count, reason }] of Object.entries(ALLOWLIST)) {
      expect(spellings(readFileSync(join(REPO_ROOT, rel), 'utf8')), rel).toBe(count)
      expect(reason.split(/\s+/).length, `${rel}'s reason is too short to be one`).toBeGreaterThan(
        8,
      )
    }
  })

  it('the declaration site still spells both prefixes and the inverse that parses one back', () => {
    // Two templates in `docRefKey`, one regex in `workspaceIdOfStoredDocKey`.
    expect(spellings(readFileSync(join(REPO_ROOT, DECLARATION_SITE), 'utf8'))).toBe(3)
  })

  it('leaves the frozen migrations out of the scan, one of which still slices the prefix', () => {
    // `isExcludedPath` skips the migrations directory wholesale, so this is
    // how migration 0007's `slice('workspace-tree:'.length)` stays allowed: a
    // migration names the key as it stood when it ran and must not follow the
    // live spelling. Pinned on both sides so the exclusion is a claim that is
    // true rather than a directory that happens to be skipped.
    const migration = join(
      REPO_ROOT,
      'packages/mcp-server/src/server/store/db/migrations/0007-adopt-workspace-tree.ts',
    )
    expect(isExcludedPath(migration)).toBe(true)
    expect(spellings(readFileSync(migration, 'utf8'))).toBeGreaterThan(0)
  })
})
