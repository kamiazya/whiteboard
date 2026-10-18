/**
 * A workspace tree, and the values its documents hold, are as deep as a
 * writer chose — a sync client chooses freely — so every walk over them has
 * to answer for any depth Loro stores, rather than overflow the call stack.
 * Each walk is held to the recursive form it replaced on small inputs, where
 * that form still answers, and to a depth that form could not reach.
 */
import { LoroDoc, LoroMap, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { stableStringify } from './content-digest.js'
import { jsonEqual } from './content-sync.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  exportWorkspaceSubtree,
  importWorkspaceSubtree,
  pruneEmptyFolders,
  readWorkspaceDocuments,
  unreadableWorkspaceNodes,
  WORKSPACE_TREE_KEY,
} from './workspace-tree.js'

/**
 * Past what each recursive walk survived under vitest on loro-crdt 1.13.6:
 * the tree walk failed at 1800 nested folders, the value stringify at 2500
 * nested objects — a value Loro itself stores, imports and reads back at
 * 3500 deep.
 */
const DEEP_TREE = 5000
const DEEP_VALUE = 3000
/** For the walks that never reach Loro: past what any call stack holds. */
const DEEPER_THAN_ANY_STACK = 100_000
const DEEP_TIMEOUT_MS = 30_000
// A ceiling, not a delay: each tree property builds and walks up to 200 small trees.
const PROPERTY_TIMEOUT_MS = 60_000

type Spec =
  | { readonly kind: 'folder'; readonly segment: string }
  | { readonly kind: 'document'; readonly segment: string; readonly documentId: string }
  | { readonly kind: 'unreadable'; readonly segment: string }

function documentId(index: number): string {
  return `01BRWAAAAAAAAAAAAAAAAAA${String(index).padStart(3, '0')}`
}

function writeSpec(node: LoroTreeNode, spec: Spec): void {
  node.data.set('segment', spec.segment)
  if (spec.kind === 'document') {
    node.data.set('documentId', spec.documentId)
    node.data.set('kind', 'markdown')
  }
  // A key a folder does not carry and a document needs its id beside.
  if (spec.kind === 'unreadable') node.data.set('note', 'x')
}

const treeOf = (doc: LoroDoc): LoroTree => doc.getTree(WORKSPACE_TREE_KEY)

/** The recursive walk this package used to take, over what the test wrote. */
function recursiveWalk(doc: LoroDoc, specs: ReadonlyMap<string, Spec>) {
  const documents: Array<readonly [string, string]> = []
  const unreadable: string[] = []
  const visit = (node: LoroTreeNode, prefix: string): void => {
    const spec = specs.get(node.id) as Spec
    if (spec.kind === 'unreadable') {
      unreadable.push(node.id)
      return
    }
    const path = prefix === '' ? spec.segment : `${prefix}/${spec.segment}`
    if (spec.kind === 'document') documents.push([spec.documentId, path])
    for (const child of node.children() ?? []) visit(child, path)
  }
  for (const root of treeOf(doc).roots()) visit(root, '')
  return { documents, unreadable }
}

const specArbitrary = fc.record({
  // Into an earlier node, or the root: the tree is built in order.
  parent: fc.nat(),
  root: fc.boolean(),
  kind: fc.constantFrom('folder', 'document', 'unreadable'),
  segment: fc.constantFrom('a', 'b', 'c'),
})

type Draw = typeof specArbitrary extends fc.Arbitrary<infer T> ? T : never

/** Builds the drawn nodes in order, each under an earlier one or under `top`. */
function buildTree(doc: LoroDoc, drawn: readonly Draw[], top?: LoroTreeNode) {
  const nodes: LoroTreeNode[] = []
  const specs = new Map<string, Spec>()
  drawn.forEach((draw, index) => {
    const parent = draw.root || nodes.length === 0 ? top : nodes[draw.parent % nodes.length]
    const node = parent === undefined ? treeOf(doc).createNode() : parent.createNode()
    const spec: Spec =
      draw.kind === 'document'
        ? { kind: 'document', segment: draw.segment, documentId: documentId(index + 1) }
        : { kind: draw.kind, segment: draw.segment }
    writeSpec(node, spec)
    specs.set(node.id, spec)
    nodes.push(node)
  })
  doc.commit()
  return specs
}

const listing = (doc: LoroDoc) =>
  readWorkspaceDocuments(doc).map((entry) => [entry.documentId, entry.path] as const)

describe('the workspace tree walk', () => {
  fcTest.prop([fc.array(specArbitrary, { minLength: 1, maxLength: 24 })], withDefaults())(
    'lists documents and skips unreadable subtrees in the order the recursive walk did',
    (drawn) => {
      const doc = new LoroDoc()
      const specs = buildTree(doc, drawn)

      const expected = recursiveWalk(doc, specs)
      expect(listing(doc)).toEqual(expected.documents)
      expect(unreadableWorkspaceNodes(doc)).toEqual(expected.unreadable)
    },
    PROPERTY_TIMEOUT_MS,
  )

  fcTest.prop([fc.array(specArbitrary, { maxLength: 24 })], withDefaults())(
    'exports and restores a document with its subtree in tree order',
    (drawn) => {
      const doc = new LoroDoc()
      const top = treeOf(doc).createNode()
      writeSpec(top, { kind: 'document', segment: 'top', documentId: documentId(0) })
      buildTree(doc, drawn, top)

      const restored = new LoroDoc()
      importWorkspaceSubtree(restored, exportWorkspaceSubtree(doc, 'top') as Uint8Array)

      expect(listing(restored)).toEqual(listing(doc))
    },
    PROPERTY_TIMEOUT_MS,
  )

  fcTest.prop([fc.array(specArbitrary, { minLength: 1, maxLength: 24 })], withDefaults())(
    'prunes exactly the folders with no document or unreadable node below them',
    (drawn) => {
      const doc = new LoroDoc()
      const specs = buildTree(doc, drawn)
      // A folder survives when something below it is not a folder; a node
      // below an unreadable one is never reached, so it is never pruned.
      const survivors = new Set<string>()
      const keep = (node: LoroTreeNode, reached: boolean): boolean => {
        const spec = specs.get(node.id) as Spec
        const below = (node.children() ?? []).map((child) =>
          keep(child, reached && spec.kind !== 'unreadable'),
        )
        const kept = !reached || spec.kind !== 'folder' || below.some(Boolean)
        if (kept) survivors.add(node.id)
        return kept
      }
      for (const root of treeOf(doc).roots()) keep(root, true)

      pruneEmptyFolders(doc)

      const live = new Set<string>()
      const visit = (node: LoroTreeNode): void => {
        live.add(node.id)
        for (const child of node.children() ?? []) visit(child)
      }
      for (const root of treeOf(doc).roots()) visit(root)
      expect(live).toEqual(survivors)
    },
    PROPERTY_TIMEOUT_MS,
  )

  it('prunes a thousand empty folders in one pass', () => {
    const doc = new LoroDoc()
    for (let i = 0; i < 1000; i++) treeOf(doc).createNode().data.set('segment', `f${i}`)
    doc.commit()

    pruneEmptyFolders(doc)

    expect(treeOf(doc).roots()).toEqual([])
  })

  it(
    'lists a document at the bottom of a folder chain deeper than the recursive walk reached',
    () => {
      const doc = new LoroDoc()
      let parent = treeOf(doc).createNode()
      writeSpec(parent, { kind: 'folder', segment: 'a' })
      for (let depth = 1; depth < DEEP_TREE; depth++) {
        parent = parent.createNode()
        writeSpec(parent, { kind: 'folder', segment: 'a' })
      }
      writeSpec(parent.createNode(), {
        kind: 'document',
        segment: 'end',
        documentId: documentId(0),
      })
      doc.commit()

      const listed = readWorkspaceDocuments(doc)
      expect(listed.map((entry) => entry.documentId)).toEqual([documentId(0)])
      expect(listed[0]?.path).toBe(`${'a/'.repeat(DEEP_TREE)}end`)
      expect(unreadableWorkspaceNodes(doc)).toEqual([])
    },
    DEEP_TIMEOUT_MS,
  )
})

/** Nested `depth` objects deep around one number. */
function nested(depth: number): unknown {
  let value: unknown = 1
  for (let i = 0; i < depth; i++) value = { a: value }
  return value
}

/** The recursive stringify the digest used to take. */
function recursiveStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(recursiveStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${keys.map((key) => `${JSON.stringify(key)}:${recursiveStringify(record[key])}`).join(',')}}`
}

/** The recursive equality the content sync used to take. */
function recursiveEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aRec = a as Record<string, unknown>
  const bRec = b as Record<string, unknown>
  const aKeys = Object.keys(aRec)
  if (aKeys.length !== Object.keys(bRec).length) return false
  return aKeys.every((key) => key in bRec && recursiveEqual(aRec[key], bRec[key]))
}

describe('a stored value nested deep', () => {
  fcTest.prop([fc.jsonValue()], withDefaults())(
    'stringifies with sorted keys exactly as the recursive form did',
    (value) => {
      expect(stableStringify(value)).toBe(recursiveStringify(value))
    },
  )

  // Past the depth the digest stops recursing at, so what is drawn is
  // written by the stack form, beside siblings either form writes.
  fcTest.prop([fc.jsonValue(), fc.jsonValue({ maxDepth: 1 })], withDefaults())(
    'stringifies a value wrapped deeper than recursion goes exactly as the recursive form did',
    (inner, sibling) => {
      let value: unknown = inner
      for (let level = 0; level < 300; level++) {
        value = level % 2 === 0 ? { z: value, a: sibling } : [sibling, value]
      }
      expect(stableStringify(value)).toBe(recursiveStringify(value))
    },
  )

  fcTest.prop(
    [fc.jsonValue({ maxDepth: 3 }), fc.jsonValue({ maxDepth: 3 }), fc.boolean()],
    withDefaults(),
  )('compares exactly as the recursive form did', (a, b, same) => {
    const right = same ? structuredClone(a) : b
    expect(jsonEqual(a, right)).toBe(recursiveEqual(a, right))
  })

  it('stringifies and compares at a depth no recursion survives', () => {
    const value = nested(DEEPER_THAN_ANY_STACK)
    expect(stableStringify(value)).toBe(
      `${'{"a":'.repeat(DEEPER_THAN_ANY_STACK)}1${'}'.repeat(DEEPER_THAN_ANY_STACK)}`,
    )
    expect(jsonEqual(value, nested(DEEPER_THAN_ANY_STACK))).toBe(true)
    expect(jsonEqual(value, nested(DEEPER_THAN_ANY_STACK - 1))).toBe(false)
  })

  it(
    'leaves a workspace listable when a document holds one, after a sync round trip',
    () => {
      const client = new LoroDoc()
      const node = treeOf(client).createNode()
      writeSpec(node, { kind: 'document', segment: 'board', documentId: documentId(0) })
      node.data.setContainer('nodes', new LoroMap()).set('n1', nested(DEEP_VALUE) as never)
      client.commit()
      const keeper = new LoroDoc()
      keeper.import(client.export({ mode: 'update' }))

      expect(readWorkspaceDocuments(keeper).map((entry) => entry.path)).toEqual(['board'])
    },
    DEEP_TIMEOUT_MS,
  )
})
