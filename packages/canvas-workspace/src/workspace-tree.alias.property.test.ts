import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { WorkspaceTree } from './workspace-tree.js'

/** Valid-by-construction segment matching the workspace-tree slug pattern. */
const segmentArbitrary = fc
  .tuple(fc.stringMatching(/^[a-zA-Z0-9]$/), fc.stringMatching(/^[a-zA-Z0-9]$/))
  .map(([first, last]) => first + last)

/**
 * Draws segments from a tiny pool (two possible single-character values) so
 * a group of siblings collides on a shared segment far more often than a
 * realistic random string would — this is what makes the uniqueness /
 * order-independence properties below exercise the collision path instead
 * of passing vacuously on an almost-always-distinct generated tree.
 */
const collisionProneSegmentArbitrary = fc.constantFrom('aa', 'bb')

const canvasIdArbitrary = fc.stringMatching(/^[a-z0-9]{6}$/)

interface PlantedNode {
  readonly canvasId: string
  readonly segment: string
}

/** One flat sibling group planted at the root of a fresh doc, in insertion order. */
const siblingGroupArbitrary = fc
  .uniqueArray(canvasIdArbitrary, { minLength: 2, maxLength: 5 })
  .chain((canvasIds) =>
    fc
      .array(collisionProneSegmentArbitrary, {
        minLength: canvasIds.length,
        maxLength: canvasIds.length,
      })
      .map((segments): readonly PlantedNode[] =>
        canvasIds.map((canvasId, i) => ({ canvasId, segment: segments[i]! })),
      ),
  )

function buildTree(nodes: readonly PlantedNode[]): WorkspaceTree {
  const doc = new LoroDoc()
  const tree = new WorkspaceTree(doc)
  // #assertNoSiblingConflict only guards a single doc's local mutations —
  // creating every planted node in its own doc and merging bypasses it,
  // exactly like two peers each creating a node concurrently.
  for (const node of nodes) {
    const peerDoc = new LoroDoc()
    const peerTree = new WorkspaceTree(peerDoc)
    peerTree.createNode(node.canvasId, node.segment)
    doc.import(peerDoc.export({ mode: 'snapshot' }))
  }
  return tree
}

/** Builds the same logical tree by merging in the opposite peer order. */
function buildTreeReversed(nodes: readonly PlantedNode[]): WorkspaceTree {
  return buildTree([...nodes].reverse())
}

function aliasByCanvasId(tree: WorkspaceTree): ReadonlyMap<string, string | undefined> {
  const result = new Map<string, string | undefined>()
  for (const node of tree.children()) {
    result.set(node.canvasId, tree.resolveAlias(node.id))
  }
  return result
}

describe('WorkspaceTree alias disambiguation properties (ADR-0008 point 5)', () => {
  fcTest.prop([siblingGroupArbitrary], withDefaults())(
    'order-independence: merge direction never changes the alias derived for a given canvasId',
    (nodes) => {
      const forward = aliasByCanvasId(buildTree(nodes))
      const reversed = aliasByCanvasId(buildTreeReversed(nodes))
      expect(reversed).toEqual(forward)
    },
  )

  fcTest.prop([siblingGroupArbitrary], withDefaults())(
    'uniqueness: no two live siblings ever derive the same alias',
    (nodes) => {
      const tree = buildTree(nodes)
      const aliases = tree.children().map((node) => tree.resolveAlias(node.id))
      expect(new Set(aliases).size).toBe(aliases.length)
    },
  )

  fcTest.prop(
    [
      fc.uniqueArray(fc.tuple(canvasIdArbitrary, segmentArbitrary), {
        minLength: 0,
        maxLength: 6,
        selector: ([canvasId]) => canvasId,
      }),
    ],
    withDefaults(),
  )('identity: a collision-free tree derives exactly the un-suffixed segments', (pairs) => {
    // De-dup by segment too, so this generator never accidentally plants a collision.
    const seenSegments = new Set<string>()
    const nodes: PlantedNode[] = []
    for (const [canvasId, segment] of pairs) {
      if (seenSegments.has(segment)) continue
      seenSegments.add(segment)
      nodes.push({ canvasId, segment })
    }
    const tree = buildTree(nodes)
    for (const node of tree.children()) {
      const planted = nodes.find((n) => n.canvasId === node.canvasId)!
      expect(tree.resolveAlias(node.id)).toBe(planted.segment)
    }
  })

  fcTest.prop([siblingGroupArbitrary], withDefaults())(
    'tie-break direction: the colliding node with the smallest canvasId keeps the bare segment',
    (nodes) => {
      const tree = buildTree(nodes)
      const bySegment = new Map<string, PlantedNode[]>()
      for (const node of nodes) {
        const group = bySegment.get(node.segment) ?? []
        group.push(node)
        bySegment.set(node.segment, group)
      }
      for (const [segment, group] of bySegment) {
        if (group.length < 2) continue
        const [winner] = [...group].sort((a, b) =>
          a.canvasId < b.canvasId ? -1 : a.canvasId > b.canvasId ? 1 : 0,
        )
        const winnerNode = tree.children().find((n) => n.canvasId === winner!.canvasId)!
        expect(tree.resolveAlias(winnerNode.id)).toBe(segment)
      }
    },
  )

  fcTest.prop([siblingGroupArbitrary], withDefaults())(
    'round-trip: findByAlias(resolveAlias(id)) returns the same node for every live node',
    (nodes) => {
      const tree = buildTree(nodes)
      for (const node of tree.children()) {
        const alias = tree.resolveAlias(node.id)
        expect(alias).toBeDefined()
        expect(tree.findByAlias(alias!)?.id).toBe(node.id)
      }
    },
  )
})
