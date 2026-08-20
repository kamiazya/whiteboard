/**
 * The subtree arithmetic behind moving and deleting a document path.
 *
 * Two stores write the daemon's `documents` table — `document-store.ts` for
 * the HTTP surface and `sqlite-document-index.ts` for the MCP one — and they
 * are deliberately kept from importing each other. That is what let them grow
 * two different answers to the same question: the index moved a whole
 * subtree while the HTTP path renamed one row and stranded its children,
 * and the index refused to delete a document with descendants while the
 * HTTP path stranded them again.
 *
 * The rules live here, as pure functions over rows, so every store keeps its
 * own storage and none owns the semantics alone. That is now literally every
 * store rather than both of two: the browser's IndexedDB `DocumentIndex` is
 * the third, which is what moved this file out of the daemon and beside
 * `compareDocumentPaths` — a rule each implementation re-derives from prose
 * is a rule they will re-derive differently.
 */

/** How many segments a path has. */
function depth(path: string): number {
  return path.split('/').length
}

/**
 * Whether `path` is `ancestor` itself or sits below it. Anchored at a
 * SEGMENT boundary, which is the whole point: `design-system` starts with
 * `design` and is not inside it.
 */
export function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
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
    path: `${to}${row.path.slice(from.length)}`,
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

/**
 * The first path strictly below `path`, or `undefined`. Both stores refuse
 * to delete a document that still has one: every document can hold children,
 * so a cascade is reachable from a single call naming one path, and deletion
 * is the operation with nothing to undo it.
 */
export function findDescendantPath(rows: readonly PathRow[], path: string): string | undefined {
  return rows.find((row) => row.path !== path && isSelfOrDescendant(row.path, path))?.path
}
