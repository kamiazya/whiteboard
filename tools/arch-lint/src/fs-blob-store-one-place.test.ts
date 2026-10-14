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
 * `fs-blob-store` module (named, aliased, or off a namespace), for a subclass
 * of it and a local name bound to it, and for a re-export that would carry it
 * past this scan under another name — so a class that happens to share the
 * name elsewhere is not a hit. Tests construct the raw
 * store on purpose — it is how they read past the guard — and are not scanned.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { importedBindings, parseSource, unwrapExpression } from './ast-helpers.js'
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

/** The class a class node extends, if it has an `extends` clause. */
function extendedBy(node: ts.ClassLikeDeclaration): ts.Expression | undefined {
  const clause = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
  return clause?.types[0]?.expression
}

/**
 * Every way the file reaches the raw blob store it imports, as source text: a
 * `new` of it, a subclass of it, and a re-export of it. A local name bound to
 * it — `const R = FsBlobStore`, or a subclass's own name — is followed, since
 * "a raw store with one extra method" is the natural next deleter.
 */
function rawConstructions(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const { locals, namespaces, reexports } = importedBindings(file, isBlobStoreModule, CLASS_NAME)
  const raw = new Set(locals.keys())
  const isRaw = (expression: ts.Expression | undefined): boolean => {
    const inner = expression === undefined ? undefined : unwrapExpression(expression)
    if (inner !== undefined && ts.isIdentifier(inner)) return raw.has(inner.text)
    return (
      inner !== undefined &&
      ts.isPropertyAccessExpression(inner) &&
      inner.name.text === CLASS_NAME &&
      ts.isIdentifier(inner.expression) &&
      namespaces.has(inner.expression.text)
    )
  }
  const isRawClass = (node: ts.Node): node is ts.ClassLikeDeclaration =>
    ts.isClassLike(node) && isRaw(extendedBy(node))
  const bindsRaw = (node: ts.Node): string | undefined => {
    if (isRawClass(node)) return node.name?.text
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined
    const value = node.initializer && unwrapExpression(node.initializer)
    return value !== undefined && (isRaw(value) || isRawClass(value)) ? node.name.text : undefined
  }
  for (let before = -1; before !== raw.size; ) {
    before = raw.size
    const grow = (node: ts.Node): void => {
      const name = bindsRaw(node)
      if (name !== undefined) raw.add(name)
      ts.forEachChild(node, grow)
    }
    grow(file)
  }
  const found = [...reexports].map((name) => `re-exports ${CLASS_NAME} as ${name}`)
  const visit = (node: ts.Node): void => {
    if ((ts.isNewExpression(node) && isRaw(node.expression)) || isRawClass(node)) {
      found.push(node.getText(file))
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

  it.each([
    [
      'a subclass, and a construction of it',
      "import { FsBlobStore } from './fs/fs-blob-store.js'\nclass Raw extends FsBlobStore {}\nnew Raw(dir, dataDir)",
      ['class Raw extends FsBlobStore {}', 'new Raw(dir, dataDir)'],
    ],
    [
      'a subclass off a namespace',
      "import * as blobs from './fs/fs-blob-store.js'\nconst Raw = class extends blobs.FsBlobStore {}",
      ['class extends blobs.FsBlobStore {}'],
    ],
    [
      'a construction through a local alias',
      "import { FsBlobStore } from './fs/fs-blob-store.js'\nconst R = FsBlobStore\nconst S = R\nnew S(dir, dataDir)",
      ['new S(dir, dataDir)'],
    ],
    [
      'a re-export under another name',
      "export { FsBlobStore as Raw } from './fs/fs-blob-store.js'",
      ['re-exports FsBlobStore as Raw'],
    ],
  ])('recognises %s', (_label, source, expected) => {
    expect(rawConstructions('fixture.ts', source)).toEqual(expected)
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
