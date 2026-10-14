/**
 * The daemon builds its blob store in ONE place, `daemonBlobStore` in
 * `backup-guarded-blob-store.ts`, and this scan is the executable half of that.
 *
 * Why it needs a scan. The guard defers a delete while a backup assembles the
 * data directory, and a deferred blob reads as gone at once. A raw
 * `FsBlobStore` over the same directory sees neither: a delete through it
 * unlinks bytes the backup's rows still name, and a read through it answers
 * bytes every guarded reader has already been told are deleted. Nothing about
 * the raw constructor looks wrong at its call site, and the module most likely
 * to hold the next blob deleter — the one that collects storage — is the one
 * that kept the last raw constructor.
 *
 * It reads the syntax tree for `new` of a binding imported from the
 * `fs-blob-store` module (named, aliased, or off a namespace), so a class that
 * happens to share the name elsewhere is not a hit. Tests construct the raw
 * store on purpose — it is how they read past the guard — and are not scanned.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SCANNED = 'packages/mcp-server/src'
const FACTORY = 'packages/mcp-server/src/server/store/backup-guarded-blob-store.ts'
const CLASS_NAME = 'FsBlobStore'

/** Relative path -> how many raw constructions the file holds, and why. Both-sided. */
const ALLOWLIST: Readonly<Record<string, { calls: number; why: string }>> = {
  [FACTORY]: {
    calls: 1,
    why: '`daemonBlobStore` wraps the raw store in the backup guard; this is the one construction',
  },
}

function isBlobStoreModule(specifier: string): boolean {
  return /(^|\/)fs-blob-store(\.js|\.ts)?$/.test(specifier)
}

/** Every `new` of the raw blob store the file imports, as its source text. */
function rawConstructions(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const named = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isBlobStoreModule(statement.moduleSpecifier.text)
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
      if ((element.propertyName ?? element.name).text === CLASS_NAME) named.add(element.name.text)
    }
  }
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression
      const hit =
        (ts.isIdentifier(callee) && named.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === CLASS_NAME &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text))
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

describe('the daemon builds its blob store in one place', () => {
  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(150)
    expect(files.map(relOf)).toContain(FACTORY)
  })

  it('no other production source constructs the raw blob store', () => {
    const hits = files
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .flatMap((rel) => rawConstructions(rel, sourceOf(rel)).map((call) => `${rel}: ${call}`))
    expect(
      hits,
      'use `daemonBlobStore(dataDir, tenantId)`: a raw `FsBlobStore` unlinks behind a running backup and reads bytes the guard has already called deleted',
    ).toEqual([])
  })

  it.each([
    [
      'a named import',
      "import { FsBlobStore } from './fs/fs-blob-store.js'\nnew FsBlobStore(dir, dataDir)",
    ],
    [
      'an aliased import',
      "import { FsBlobStore as Raw } from '../store/fs/fs-blob-store.js'\nnew Raw(dir, dataDir)",
    ],
    [
      'a namespace import',
      "import * as blobs from './fs/fs-blob-store.js'\nnew blobs.FsBlobStore(dir, dataDir)",
    ],
  ])('recognises %s', (_label, source) => {
    expect(rawConstructions('fixture.ts', source)).toHaveLength(1)
  })

  it('does not read a same-named class from another module', () => {
    expect(
      rawConstructions(
        'fixture.ts',
        "import { FsBlobStore } from './other-store.js'\nnew FsBlobStore(dir)",
      ),
    ).toEqual([])
    expect(
      rawConstructions(
        'fixture.ts',
        "import type { FsBlobStore } from './fs/fs-blob-store.js'\nlet s: FsBlobStore",
      ),
    ).toEqual([])
  })

  it('an allowlisted file constructs exactly as often as its entry records', () => {
    const drift = Object.entries(ALLOWLIST).flatMap(([rel, { calls }]) => {
      const found = rawConstructions(rel, sourceOf(rel))
      return found.length === calls ? [] : [`${rel}: ${calls} recorded, ${found.length} found`]
    })
    expect(drift, 'an allowlist entry covers the sites it names, not the whole file').toEqual([])
  })

  it('every allowlist entry still constructs', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (rel) => rawConstructions(rel, sourceOf(rel)).length === 0,
    )
    expect(stale, 'an entry that outlives its site is how an allowlist stops being read').toEqual(
      [],
    )
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(1)
  })
})
