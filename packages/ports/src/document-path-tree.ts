/**
 * The subtree arithmetic behind moving a document path, over plain rows.
 *
 * Its one caller is `InMemoryDocumentIndex`, the row-backed double: every
 * production index is the workspace tree, which answers moves structurally.
 * What keeps the two answering alike is not this file but
 * `describeDocumentIndexConformance`, which both run — so a rule here that
 * drifts from the tree (a folder-only path taken as free, a not-found asked
 * after into-self) fails that suite rather than a test that used the double.
 */

import { isSelfOrDescendant, rebasePath } from '@kamiazya/whiteboard-model'

/** How many segments a path has. */
function depth(path: string): number {
  return path.split('/').length
}

export interface PathRow {
  readonly id: string
  readonly path: string
}

interface PlannedMove {
  readonly id: string
  readonly from: string
  readonly path: string
}

export type MovePlan =
  | { readonly ok: true; readonly moves: readonly PlannedMove[] }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'taken'; readonly path: string }

/**
 * Works out every row a move touches and the order to write them in.
 * Returns a result rather than throwing so each caller can raise the error
 * class its own surface already maps to a status code.
 *
 * `to` being inside `from` is the caller's check, not this one's — the two
 * stores disagree about whether it is an error or simply refused, and this
 * function has no opinion worth imposing.
 */
export function planSubtreeMove(rows: readonly PathRow[], from: string, to: string): MovePlan {
  // `from` need not name a document: a prefix that only has descendants is a
  // legitimate source, and moving it relocates the subtree under it. That is
  // what makes renaming a FOLDER expressible at all, since a folder is only
  // ever a shared prefix here — see the depth-ordering conformance case,
  // which moves `a/b` while no `a/b` document exists.
  const moving = rows.filter((row) => isSelfOrDescendant(row.path, from))
  if (moving.length === 0) return { ok: false, reason: 'not-found' }

  const occupied = new Set(rows.map((row) => row.path))
  const vacating = new Set(moving.map((row) => row.path))
  const moves = moving.map((row) => ({
    id: row.id,
    from: row.path,
    path: rebasePath(row.path, from, to),
  }))

  // Every PRODUCED path, not just `to`: moving `a` onto a free `c` still
  // collides when `a/x` and `c/x` both exist. Paths the move is vacating do
  // not count as occupied, or relocating a subtree would always collide
  // with itself.
  for (const move of moves) {
    if (occupied.has(move.path) && !vacating.has(move.path)) {
      return { ok: false, reason: 'taken', path: move.path }
    }
  }
  const folderTaken = folderCollision(rows, from, to)
  if (folderTaken !== undefined) return { ok: false, reason: 'taken', path: folderTaken }

  // Shallowest source first, by DEPTH — not by path order. A move up into
  // its own ancestor namespace sends a deeper row onto the path a shallower
  // one is vacating, so the shallower write has to land first or the unique
  // index rejects a move the contract requires to succeed. The two
  // contending rows need not be ancestor and descendant of each other
  // (`a/b/x` and `a/b/b/x` both branch below `a/b`), which is why
  // segment-wise path order is not enough: it would put `a/b/b/x` first
  // because `b` precedes `x`. Only the depth difference is guaranteed, and
  // it is — the row producing a contested path is always deeper than the row
  // vacating it, by exactly the number of segments the move removes.
  return { ok: true, moves: [...moves].sort((left, right) => depth(left.from) - depth(right.from)) }
}

/** Every proper prefix of `path`: the folders a row implies above itself. */
function foldersAbove(path: string): string[] {
  const segments = path.split('/')
  return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('/'))
}

/**
 * A FOLDER is a path that only prefixes rows. Rows alone never collide with
 * one, but the tree-backed index holds it as a node and cannot land a second
 * node on its path, so a move it refuses must be refused here too, or a
 * double passes over what production refuses. Two shapes: a produced path
 * meets a folder the move does not empty (a document onto `f`, or folder
 * `f` merged into folder `g`), and a moving folder lands on a document.
 * Shallowest first within each kind, so the path named is where the two meet.
 */
function folderCollision(rows: readonly PathRow[], from: string, to: string): string | undefined {
  const documents = new Set(rows.map((row) => row.path))
  const staying = rows.filter((row) => !isSelfOrDescendant(row.path, from))
  // A folder survives the move when a row that stays is still below it.
  const keptFolders = new Set(staying.flatMap((row) => foldersAbove(row.path)))
  const movingFolders = new Set(
    rows.flatMap((row) => foldersAbove(row.path)).filter((f) => isSelfOrDescendant(f, from)),
  )
  const produced = [
    ...rows.filter((row) => isSelfOrDescendant(row.path, from)).map((row) => row.path),
    ...movingFolders,
  ]
    .map((path) => rebasePath(path, from, to))
    .sort((left, right) => depth(left) - depth(right))
  // A document met is the real conflict and is named first, as the tree names it.
  return (
    produced.find((path) => documents.has(path) && !isSelfOrDescendant(path, from)) ??
    produced.find((path) => keptFolders.has(path))
  )
}
