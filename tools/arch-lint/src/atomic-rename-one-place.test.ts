/**
 * A file is renamed into place in ONE place, `shared/write-file-atomic.ts`'s
 * `commitStagedWrite`, and this scan is the executable half of that.
 *
 * Why it needs a scan. The daemon had three write-then-rename helpers and a
 * durability fix reached one: a filesystem need not order a new file's data
 * before a rename of it, so a helper that renames without an fsync can leave
 * the final name on a zero-length file after a crash. Two siblings kept doing
 * exactly that — one under the backup blob mirror, which skipped the torn
 * entry as occupied on every later pass. A new `rename` beside the helper is
 * how a fourth sibling would start.
 *
 * It reads the syntax tree for a call through a binding imported from
 * `node:fs` / `node:fs/promises` (named, aliased, or off a namespace import),
 * so a method that happens to be called `rename` is not a hit. Every other
 * site is allowlisted with its reason, both-sided.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SCANNED = 'packages/mcp-server/src'
const HELPER = 'packages/mcp-server/src/shared/write-file-atomic.ts'

const FS_MODULES: ReadonlySet<string> = new Set([
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
])
const RENAMES: ReadonlySet<string> = new Set(['rename', 'renameSync'])

const MIGRATION_HISTORY =
  "a migration's text is what it ran with, and a step already recorded as applied is not edited after the fact"
/** Relative path -> why this file may still rename. Both-sided. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  [HELPER]: 'the one durable commit tail: fsync before the rename, directory fsync after',
  'packages/mcp-server/src/server/security/secret-file-mode.ts':
    "the synchronous secret writer; it fsyncs before the rename and syncs the directory through the helper module's syncDirectorySync",
  'packages/mcp-server/src/server/tenant/data-layout.ts':
    'moves a whole legacy directory into the tenant layout; no file data is staged',
  'packages/mcp-server/src/server/store/backup-pass.ts':
    'seals a finished backup by renaming its staging DIRECTORY; every file in it was written by its own store',
  'packages/mcp-server/src/server/store/db/migrations/0008-ulid-legacy-canvas-ids.ts':
    MIGRATION_HISTORY,
  'packages/mcp-server/src/server/store/db/migrations/0012-ulid-remaining-document-ids.ts':
    MIGRATION_HISTORY,
  'packages/mcp-server/src/server/store/db/migrations/0019-workspace-canonical-id.ts':
    MIGRATION_HISTORY,
}

/** Every call to an fs `rename`/`renameSync` the file imports, as its source text. */
function fsRenames(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const named = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !FS_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      if (RENAMES.has((element.propertyName ?? element.name).text)) named.add(element.name.text)
    }
  }
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const hit =
        (ts.isIdentifier(callee) && named.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) &&
          RENAMES.has(callee.name.text))
      if (hit) found.push(node.getText(file))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const files = walkSourceFiles(join(REPO_ROOT, SCANNED)).filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const sourceOf = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('a file is renamed into place in one place', () => {
  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(150)
    expect(files.map(relOf)).toContain(HELPER)
  })

  it('no other production source renames through fs', () => {
    const hits = files
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .flatMap((rel) => fsRenames(rel, sourceOf(rel)).map((call) => `${rel}: ${call}`))
    expect(
      hits,
      'write through `writeFileAtomic` / `writeFileAtomicStaged`: a rename without an fsync before it can leave the name on a zero-length file after a crash',
    ).toEqual([])
  })

  it.each([
    ['a named import', "import { rename } from 'node:fs/promises'\nawait rename(a, b)"],
    ['an aliased import', "import { rename as mv } from 'node:fs/promises'\nawait mv(a, b)"],
    ['the sync form', "import { renameSync } from 'node:fs'\nrenameSync(a, b)"],
    ['a namespace import', "import * as fs from 'node:fs/promises'\nawait fs.rename(a, b)"],
  ])('recognises %s', (_label, source) => {
    expect(fsRenames('fixture.ts', source)).toHaveLength(1)
  })

  it('does not read a method that happens to be called rename', () => {
    expect(fsRenames('fixture.ts', 'await store.rename(id, a, b)')).toEqual([])
    expect(
      fsRenames('fixture.ts', "import { rename } from './documents.js'\nawait rename(a, b)"),
    ).toEqual([])
  })

  it('every allowlist entry still renames', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => fsRenames(rel, sourceOf(rel)).length === 0)
    expect(stale, 'an entry that outlives its site is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(7)
  })
})
