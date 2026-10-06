/**
 * The browser's per-document content store (`LoroStore`, apps/web) is
 * retired: every browser-kept document's content lives in the workspace
 * record, and readers ask the record first, falling back to the old store
 * only for an id the record lacks. A WRITE to the old store for a document
 * the record holds is therefore a second copy no reader sees while the
 * document lives — a rename's repointed reference saved there left every
 * link broken — and the one reader that does see it is the fallback, after
 * the document is deleted.
 *
 * So `save` on it has one production caller, ledgered with why: the seed for
 * an index with no workspace record behind it. Tests and `test-utils` seed
 * old-store fixtures on purpose (that is what the startup fold migrates) and
 * are out of scope.
 *
 * Read from the syntax tree: a receiver counts when the file binds its name
 * to the store — a declaration, parameter or property typed `LoroStore` /
 * `LoroStoreLike`, initialised with `new LoroStore(…)`, or initialised (or
 * defaulted, in a destructuring) with a name already bound that way — when it
 * IS `new LoroStore(…)`, or when it is the `.current` of a React ref built
 * over one (`useRef(store)`), which is how a hook holds the store a timer
 * callback writes through. A store reached under a name the file never binds
 * that way is past this guard; the spellings it does read are the ones the
 * codebase uses.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SCOPE = 'apps/web/src'
const STORE_TYPE = /\bLoroStore(Like)?\b/
const STORE_CONSTRUCTION = /\bnew\s+LoroStore\s*\(/

/** Shipped callers that write the per-document store, each with why. */
const LEGACY_WRITERS: Readonly<Record<string, string>> = {
  'apps/web/src/lib/create-seeded-document.ts':
    "the seed for an index with no workspace record behind it (an injected double); a tree-backed index's create only stamps the clock",
}

/** The names this file binds to the per-document store, and to a React ref over one. */
interface StoreBindings {
  readonly names: ReadonlySet<string>
  readonly refs: ReadonlySet<string>
}

/** `useRef(<store name>)`, the shape a hook keeps its store in for timer callbacks. */
function isRefOverStore(initializer: ts.Expression, names: ReadonlySet<string>): boolean {
  const call = unwrapExpression(initializer)
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return false
  if (call.expression.text !== 'useRef') return false
  const [held] = call.arguments
  return held !== undefined && ts.isIdentifier(held) && names.has(held.text)
}

function storeBindings(file: ts.SourceFile): StoreBindings {
  const names = new Set<string>()
  const refs = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const type = 'type' in node ? node.type : undefined
      const initializer = 'initializer' in node ? node.initializer : undefined
      const typed = type !== undefined && STORE_TYPE.test(type.getText(file))
      const built = initializer !== undefined && STORE_CONSTRUCTION.test(initializer.getText(file))
      const aliased =
        initializer !== undefined && ts.isIdentifier(initializer) && names.has(initializer.text)
      if (typed || built || aliased) names.add(node.name.text)
      else if (initializer !== undefined && isRefOverStore(initializer, names)) {
        refs.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  // One pass in source order: an alias or a ref reads a name declared above
  // it, which is how every binding of the store in this app is written.
  visit(file)
  return { names, refs }
}

function receiverIsStore(expression: ts.Expression, bindings: StoreBindings): boolean {
  const receiver = unwrapExpression(expression)
  if (ts.isNewExpression(receiver)) {
    return ts.isIdentifier(receiver.expression) && receiver.expression.text === 'LoroStore'
  }
  if (ts.isIdentifier(receiver)) return bindings.names.has(receiver.text)
  if (ts.isPropertyAccessExpression(receiver)) {
    const ref = unwrapExpression(receiver.expression)
    if (receiver.name.text === 'current' && ts.isIdentifier(ref) && bindings.refs.has(ref.text)) {
      return true
    }
    return bindings.names.has(receiver.name.text)
  }
  return false
}

function countLegacyWrites(fileName: string, source: string): number {
  if (!source.includes('save')) return 0
  const file = parseSource(fileName, source)
  const bindings = storeBindings(file)
  let writes = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'save' &&
      receiverIsStore(node.expression.expression, bindings)
    ) {
      writes += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return writes
}

const writes = (source: string): boolean => countLegacyWrites('fixture.ts', source) > 0

const production = walkSourceFiles(join(REPO_ROOT, SCOPE))
  .filter((path) => !isTestPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
const writers = production
  .filter(({ path }) => countLegacyWrites(path, readFileSync(path, 'utf8')) > 0)
  .map(({ rel }) => rel)

describe('the per-document content store has one production writer', () => {
  it('recognises a write however the store is bound, and not a read or another save', () => {
    expect(writes('function f(loro: LoroStoreLike) { return loro.save(id, bytes) }')).toBe(true)
    expect(writes('const store = deps.loro ?? new LoroStore()\nstore.save(id, bytes)')).toBe(true)
    expect(writes('await new LoroStore().save(id, bytes)')).toBe(true)
    expect(writes('function f(loro: LoroStoreLike) { return (loro as Store)!.save(i, b) }')).toBe(
      true,
    )
    expect(
      writes('class A { private readonly legacy: LoroStore\n m() { this.legacy.save(id, b) } }'),
    ).toBe(true)
    expect(
      writes('interface S { loro: LoroStoreLike }\nfunction f(s: S) { s.loro.save(i, b) }'),
    ).toBe(true)
    // A hook's ref over the store, and the controller's own shape: a store
    // defaulted in a destructuring, then held in a ref for timer callbacks.
    expect(
      writes('function h(loro: LoroStoreLike) { const r = useRef(loro); r.current.save(i, b) }'),
    ).toBe(true)
    expect(
      writes(
        'const store = new LoroStore()\nfunction h({ loro = store }: Deps) {\n  const loroRef = useRef(loro)\n  loroRef.current.save(i, b)\n}',
      ),
    ).toBe(true)
    expect(writes('const indexRef = useRef(index)\nindexRef.current.save(i, b)')).toBe(false)
    expect(writes('function f(loro: LoroStoreLike) { return loro.load(id) }')).toBe(false)
    expect(writes('await docs.save(workspaceId, record)')).toBe(false)
    expect(writes('// loro.save(id, bytes)\nconst loro = new LoroStore()')).toBe(false)
  })

  it('scans a tree that holds the store and its ledgered writer', () => {
    // An empty scan agrees with every rule; the ledgered writer keeps it honest.
    expect(production.length).toBeGreaterThan(500)
    expect(writers).toContain('apps/web/src/lib/create-seeded-document.ts')
  })

  it('has no writer outside the ledger', () => {
    const unlisted = writers.filter((rel) => LEGACY_WRITERS[rel] === undefined)
    expect(
      unlisted,
      'write browser content into the workspace record (documentContainers + saveAndAnnounce), not the per-document store',
    ).toEqual([])
  })

  it('every ledgered writer still writes', () => {
    const stale = Object.keys(LEGACY_WRITERS).filter((rel) => !writers.includes(rel))
    expect(stale, 'a writer that stopped writing the old store no longer needs its entry').toEqual(
      [],
    )
  })
})
