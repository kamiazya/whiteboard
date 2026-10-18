/**
 * The move collision check counts what is below each path in one pass, and
 * must answer exactly what the pairwise form it replaced answered. That form
 * is copied here as the oracle — a folder is emptied when every node below it
 * is moving, checked by filtering every node for every folder — so the two
 * share nothing but the model's path helpers.
 */
import type { WorkspaceNode } from '@kamiazya/whiteboard-loro-adapter'
import { isSelfOrDescendant, rebasePath } from '@kamiazya/whiteboard-model'
import { fc } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { moveCollision } from './move-collision.js'

function oracleVacated(
  nodes: readonly WorkspaceNode[],
  moving: readonly WorkspaceNode[],
  foldersToo: boolean,
): Set<string> {
  const movingPaths = new Set(moving.map((node) => node.path))
  const vacated = new Set(movingPaths)
  if (!foldersToo) return vacated
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    const below = nodes.filter(
      (other) => other.path !== node.path && isSelfOrDescendant(other.path, node.path),
    )
    if (below.length > 0 && below.every((other) => movingPaths.has(other.path))) {
      vacated.add(node.path)
    }
  }
  return vacated
}

function oracleCollision(
  nodes: readonly WorkspaceNode[],
  moving: readonly WorkspaceNode[],
  from: string,
  to: string,
  foldersToo = true,
): string | undefined {
  const vacated = oracleVacated(nodes, moving, foldersToo)
  const collisions = moving
    .map((node) => rebasePath(node.path, from, to))
    .filter((produced) => !vacated.has(produced))
    .flatMap((produced) => {
      const occupant = nodes.find((other) => other.path === produced)
      return occupant === undefined ? [] : [{ produced, withFolder: occupant.type === 'folder' }]
    })
  return (collisions.find((c) => !c.withFolder) ?? collisions[0])?.produced
}

// Two segments and shallow paths, so prefixes, duplicates and collisions are common.
const pathArbitrary = fc
  .array(fc.constantFrom('a', 'b'), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'))

const nodeArbitrary = fc
  .record({ path: pathArbitrary, folder: fc.boolean() })
  .map(({ path, folder }, index = 0): WorkspaceNode => {
    const segment = path.split('/').at(-1) as string
    return folder
      ? { type: 'folder', segment, path }
      : {
          type: 'document',
          meta: { documentId: `01BRWAAAAAAAAAAAAAAAAAA${index}`, segment, kind: 'markdown' },
          path,
        }
  })

describe('a move collision check', () => {
  it('names the same produced path the pairwise check named', () => {
    let refused = 0
    let freedByFolder = 0
    fc.assert(
      fc.property(
        fc.array(nodeArbitrary, { maxLength: 10 }),
        fc.option(fc.nat(), { nil: undefined, freq: 4 }),
        pathArbitrary,
        pathArbitrary,
        fc.boolean(),
        (nodes, existing, drawnFrom, drawnTo, upOne) => {
          // Mostly a path the list holds, so something moves.
          const picked = existing === undefined ? undefined : nodes[existing % nodes.length]
          const from = picked?.path ?? drawnFrom
          // Up one level half the time: `a/b` -> `a` is the move an emptied
          // folder frees, and a drawn destination rarely produces it.
          const to = upOne && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : drawnTo
          const moving = nodes.filter((node) => isSelfOrDescendant(node.path, from))
          const expected = oracleCollision(nodes, moving, from, to)

          expect(moveCollision(nodes, moving, from, to)).toBe(expected)

          if (expected !== undefined) refused += 1
          if (oracleCollision(nodes, moving, from, to, false) !== expected) freedByFolder += 1
        },
      ),
      { numRuns: 1000 },
    )
    // Reachability, floors under five measured runs (180-213 and 32-41 of
    // 1000): moves were refused, and an emptied folder changed the answer.
    expect(refused).toBeGreaterThan(100)
    expect(freedByFolder).toBeGreaterThan(15)
  })
})
