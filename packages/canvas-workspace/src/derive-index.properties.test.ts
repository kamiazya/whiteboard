import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { deriveAliasResolutionRows, deriveWorkspaceIndexRows } from './derive-index.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { buildFixtureWorkspace } from './test-utils/index-fixtures.js'
import { WorkspaceTree } from './workspace-tree.js'

/** Valid-by-construction segment matching the workspace-tree slug pattern (see workspace-tree.ts). */
const segmentArbitrary = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9]$/),
    fc.stringMatching(/^[a-zA-Z0-9_-]{0,8}$/),
    fc.stringMatching(/^[a-zA-Z0-9]$/),
  )
  .map(([first, middle, last]) => first + middle + last)

/** Builds a single root-to-leaf chain (one child per level, so sibling-uniqueness never triggers). */
function buildChain(segments: readonly string[]): { tree: WorkspaceTree; leafAlias: string } {
  const doc = new LoroDoc()
  const tree = new WorkspaceTree(doc)
  let parent: ReturnType<WorkspaceTree['createNode']> | undefined
  segments.forEach((segment, index) => {
    parent = tree.createNode(`canvas-${index}`, segment, parent)
  })
  return { tree, leafAlias: segments.join('/') }
}

describe('derive-index properties', () => {
  fcTest.prop([fc.array(segmentArbitrary, { minLength: 1, maxLength: 6 })], withDefaults())(
    "alias-path purity: the derived alias for the leaf equals join('/') of its ancestor segments",
    (segments) => {
      const { tree, leafAlias } = buildChain(segments)
      const rows = deriveAliasResolutionRows(tree)
      const leafRow = rows.find((row) => row.alias === leafAlias)
      expect(leafRow).toBeDefined()
    },
  )

  fcTest.prop([fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 })], withDefaults())(
    'order-independence: shuffling the canvases array yields identical assembler output',
    (order) => {
      const { tree, canvases } = buildFixtureWorkspace()
      const forward = deriveWorkspaceIndexRows({ workspaceId: 'ws-1', tree, canvases })
      const shuffled = order.map((index) => canvases[index])
      const result = deriveWorkspaceIndexRows({ workspaceId: 'ws-1', tree, canvases: shuffled })
      expect(result).toEqual(forward)
    },
  )
})
