/**
 * Finding the node at a path steps down through the children that lead to it
 * rather than walking the whole record, and must still answer what a walk
 * answers: the FIRST node in tree order whose derived path is the path, an
 * unreadable node skipped with its subtree, and a segment holding a `/`
 * matched where a walk's joined path matches it.
 *
 * The oracle walks the tree recursively over the raw node maps — machinery
 * the lookup under test does not share — and lists every node in tree order.
 */
import { LoroDoc, type LoroTreeNode, type TreeID } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { fc, withDefaults } from './test-utils/fast-check.js'
import {
  deleteWorkspaceNodeAtPath,
  ensureFolderPath,
  WORKSPACE_TREE_KEY,
} from './workspace-tree.js'

// A ceiling, not a delay: each run builds and searches a small tree.
const PROPERTY_TIMEOUT_MS = 60_000

const treeOf = (doc: LoroDoc) => doc.getTree(WORKSPACE_TREE_KEY)

const drawArbitrary = fc.record({
  parent: fc.nat(),
  root: fc.boolean(),
  kind: fc.constantFrom('folder', 'document', 'unreadable'),
  // Few distinct segments, so siblings share one and paths collide often.
  segment: fc.constantFrom('a', 'b', 'a/b'),
})
type Draw = typeof drawArbitrary extends fc.Arbitrary<infer T> ? T : never

const pathArbitrary = fc.record({
  drawn: fc
    .array(fc.constantFrom('a', 'b'), { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join('/')),
  // Half the runs ask for a path the tree holds, so a hit is common.
  existing: fc.option(fc.nat(), { nil: undefined }),
})
type PathDraw = typeof pathArbitrary extends fc.Arbitrary<infer T> ? T : never

function pathFor(draw: PathDraw, walked: ReturnType<typeof oracleWalk>): string {
  if (draw.existing === undefined || walked.length === 0) return draw.drawn
  return (walked[draw.existing % walked.length] as { readonly path: string }).path
}

function documentId(index: number): string {
  return `01BRWAAAAAAAAAAAAAAAAAA${String(index).padStart(3, '0')}`
}

function buildTree(doc: LoroDoc, drawn: readonly Draw[]): void {
  const nodes: LoroTreeNode[] = []
  drawn.forEach((draw, index) => {
    const parent = draw.root || nodes.length === 0 ? undefined : nodes[draw.parent % nodes.length]
    const node = parent === undefined ? treeOf(doc).createNode() : parent.createNode()
    node.data.set('segment', draw.segment)
    if (draw.kind === 'document') {
      node.data.set('documentId', documentId(index))
      node.data.set('kind', 'markdown')
    }
    // A key a folder may not carry, beside no document id.
    if (draw.kind === 'unreadable') node.data.set('note', 'x')
    nodes.push(node)
  })
  doc.commit()
}

/** Every readable node in tree order with its derived path, by recursion over the raw maps. */
function oracleWalk(doc: LoroDoc): Array<{ readonly id: TreeID; readonly path: string }> {
  const out: Array<{ readonly id: TreeID; readonly path: string }> = []
  const visit = (node: LoroTreeNode, prefix: string): void => {
    const raw = node.data.toJSON() as Record<string, unknown>
    const isDocument = typeof raw.documentId === 'string'
    const isFolder = Object.keys(raw).length === 1 && typeof raw.segment === 'string'
    if (!isDocument && !isFolder) return
    const path = prefix === '' ? (raw.segment as string) : `${prefix}/${raw.segment as string}`
    out.push({ id: node.id, path })
    for (const child of node.children() ?? []) visit(child, path)
  }
  for (const root of treeOf(doc).roots()) visit(root, '')
  return out
}

function liveIds(doc: LoroDoc): Set<TreeID> {
  const ids = new Set<TreeID>()
  const visit = (node: LoroTreeNode): void => {
    ids.add(node.id)
    for (const child of node.children() ?? []) visit(child)
  }
  for (const root of treeOf(doc).roots()) visit(root)
  return ids
}

/** The subtree rooted at `id`, unreadable nodes included. */
function subtreeIds(doc: LoroDoc, id: TreeID): Set<TreeID> {
  const ids = new Set<TreeID>()
  const visit = (node: LoroTreeNode): void => {
    ids.add(node.id)
    for (const child of node.children() ?? []) visit(child)
  }
  const top = treeOf(doc).getNodeByID(id)
  if (top !== undefined) visit(top)
  return ids
}

type Parent = TreeID | { readonly created: number } | undefined

/**
 * What placing folders along `segments` did before the lookup changed: per
 * prefix, the first node in tree order at it is reused, and a folder is
 * created under the current parent where there is none.
 */
function oracleEnsure(walked: ReturnType<typeof oracleWalk>, segments: readonly string[]) {
  const creations: Array<{ readonly parent: Parent; readonly segment: string }> = []
  let parent: Parent
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    const existing = walked.find((entry) => entry.path === prefix)
    if (existing !== undefined) {
      parent = existing.id
      continue
    }
    creations.push({ parent, segment })
    parent = { created: creations.length - 1 }
  }
  return { creations, result: parent }
}

const drawsArbitrary = fc.array(drawArbitrary, { minLength: 1, maxLength: 24 })

describe('finding the node at a path', () => {
  it(
    'deletes the first node in tree order at the path, with its subtree',
    () => {
      let found = 0
      let notUnderFirstParent = 0
      fc.assert(
        fc.property(drawsArbitrary, pathArbitrary, (drawn, pathDraw) => {
          const doc = new LoroDoc()
          buildTree(doc, drawn)
          const walked = oracleWalk(doc)
          const path = pathFor(pathDraw, walked)
          const first = walked.find((entry) => entry.path === path)
          const before = liveIds(doc)
          const expected = first === undefined ? new Set<TreeID>() : subtreeIds(doc, first.id)
          if (first !== undefined) {
            found += 1
            const parentPath = path.split('/').slice(0, -1).join('/')
            const firstParent = walked.find((entry) => entry.path === parentPath)
            const parent = treeOf(doc).getNodeByID(first.id)?.parent()
            if (firstParent !== undefined && parent?.id !== firstParent.id) notUnderFirstParent += 1
          }

          expect(deleteWorkspaceNodeAtPath(doc, path)).toBe(first !== undefined)

          const after = liveIds(doc)
          expect(new Set([...before].filter((id) => !after.has(id)))).toEqual(expected)
        }),
        withDefaults(),
      )
      // Reachability: the property met the path, and met the arrangement a
      // descent through only the first node at each prefix gets wrong.
      expect(found).toBeGreaterThan(80)
      expect(notUnderFirstParent).toBeGreaterThan(0)
    },
    PROPERTY_TIMEOUT_MS,
  )

  it(
    'reuses the first node in tree order at each prefix and creates folders for the rest',
    () => {
      let reused = 0
      let created = 0
      fc.assert(
        fc.property(drawsArbitrary, pathArbitrary, (drawn, pathDraw) => {
          const doc = new LoroDoc()
          buildTree(doc, drawn)
          const walked = oracleWalk(doc)
          // A child below the drawn path, so an existing path still creates.
          const segments = [...pathFor(pathDraw, walked).split('/'), 'new']
          const { creations, result } = oracleEnsure(walked, segments)
          const before = liveIds(doc)

          const answered = ensureFolderPath(doc, segments)

          const fresh = [...liveIds(doc)].filter((id) => !before.has(id))
          expect(fresh).toHaveLength(creations.length)
          const actualOf: TreeID[] = []
          const resolve = (parent: Parent): TreeID | undefined =>
            parent === undefined || typeof parent === 'string' ? parent : actualOf[parent.created]
          for (const creation of creations) {
            const want = resolve(creation.parent)
            const match = fresh.find((id) => {
              const node = treeOf(doc).getNodeByID(id)
              return (
                !actualOf.includes(id) &&
                node?.parent()?.id === want &&
                node?.data.get('segment') === creation.segment
              )
            })
            expect(match).toBeDefined()
            actualOf.push(match as TreeID)
          }
          expect(answered).toBe(resolve(result))
          if (creations.length > 0) created += 1
          if (creations.length < segments.length) reused += 1
        }),
        withDefaults(),
      )
      expect(reused).toBeGreaterThan(40)
      expect(created).toBeGreaterThan(40)
    },
    PROPERTY_TIMEOUT_MS,
  )
})
