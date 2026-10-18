import type { WorkspaceNode } from '@kamiazya/whiteboard-loro-adapter'
import { rebasePath } from '@kamiazya/whiteboard-model'

export type WorkspaceNodes = WorkspaceNode[]

interface Below {
  /** Nodes strictly below this path. */
  all: number
  /** Of those, the ones whose path the move frees. */
  moving: number
}

/** The path one segment up, or `undefined` for a path with none above it. */
function parentOf(path: string): string | undefined {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? undefined : path.slice(0, cut)
}

/**
 * Every path the move frees: the moving nodes' own, and every FOLDER the
 * move empties. The folder case is the one a row-backed index never meets:
 * it has no row at `a` at all, while the tree has a folder there holding the
 * very subtree that is leaving. Counting it as occupied refuses `a/b` -> `a`,
 * which the port says must succeed.
 *
 * A folder is emptied when something is below it and all of it is leaving.
 * Counted in one pass up from the deepest paths, rather than by filtering
 * every node for each folder: a record holds thousands of folders beside
 * thousands of documents, and that filter ran on every move. "Below" is the
 * path's string sense — every path with it and a `/` in front — so the
 * counts climb one segment at a time through every such prefix, held by a
 * node or not.
 */
function vacatedPaths(nodes: WorkspaceNodes, moving: WorkspaceNodes): Set<string> {
  const movingPaths = new Set(moving.map((node) => node.path))
  const below = new Map<string, Below>()
  const byDepth: string[][] = []
  const depthOf = (path: string): number => path.split('/').length - 1
  const enter = (path: string): Below => {
    const existing = below.get(path)
    if (existing !== undefined) return existing
    const fresh: Below = { all: 0, moving: 0 }
    below.set(path, fresh)
    const depth = depthOf(path)
    const level = byDepth[depth] ?? []
    level.push(path)
    byDepth[depth] = level
    return fresh
  }
  // Each node counts once toward its own path's parent; the deepest level
  // then hands its totals up, level by level, so a path's count is everything
  // below it.
  const own = new Map<string, Below>()
  for (const node of nodes) {
    const mine = own.get(node.path) ?? { all: 0, moving: 0 }
    mine.all += 1
    if (movingPaths.has(node.path)) mine.moving += 1
    own.set(node.path, mine)
    enter(node.path)
  }
  for (let depth = byDepth.length - 1; depth > 0; depth--) {
    for (const path of byDepth[depth] ?? []) {
      const parent = parentOf(path) as string
      const self = below.get(path) as Below
      const held = own.get(path) ?? { all: 0, moving: 0 }
      const into = enter(parent)
      into.all += self.all + held.all
      into.moving += self.moving + held.moving
    }
  }
  const vacated = new Set(movingPaths)
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    const under = below.get(node.path) as Below
    if (under.all > 0 && under.all === under.moving) vacated.add(node.path)
  }
  return vacated
}

/**
 * The produced path to refuse the move over, or `undefined` when it is free.
 *
 * Every collision is collected before one is named, because the FIRST one
 * found is often a folder the destination merely passes through (`a` -> `c`
 * hits the folder `c` before the document `c/d` under it), and naming the
 * folder sends the caller to retry a rename that was never the problem. A
 * document collision is the real conflict, so it wins the report; a
 * folder-only collision still refuses — the tree cannot hold two nodes at one
 * path — but is only named when nothing better exists.
 *
 * A path the move is itself emptying is free. `a/b` moving to `a` produces
 * `a/b` again from `a/b/b`, and treating that as occupied would refuse a move
 * that is perfectly well defined.
 */
export function moveCollision(
  nodes: WorkspaceNodes,
  moving: WorkspaceNodes,
  from: string,
  to: string,
): string | undefined {
  const vacated = vacatedPaths(nodes, moving)
  // The first node in listing order at each path, as a scan would find it.
  const occupants = new Map<string, WorkspaceNodes[number]>()
  for (const node of nodes) if (!occupants.has(node.path)) occupants.set(node.path, node)
  const collisions = moving
    .map((node) => rebasePath(node.path, from, to))
    .filter((produced) => !vacated.has(produced))
    .flatMap((produced) => {
      const occupant = occupants.get(produced)
      return occupant === undefined ? [] : [{ produced, withFolder: occupant.type === 'folder' }]
    })
  return (collisions.find((c) => !c.withFolder) ?? collisions[0])?.produced
}
