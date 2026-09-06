/**
 * A document's branches, read and written on the workspace record itself.
 *
 * This is the half of ADR-0022 that the daemon's SQLite `branches` table
 * stood in for. A branch is a name and a frontier OF THE RECORD, so the
 * record is where it belongs: it already travels to every replica, which
 * means the browser keeper gets variations without a second transport, a
 * second schema, or a second set of rules.
 *
 * `head` is NOT here. It already lives on the node's meta as
 * `currentBranch`, written through `updateWorkspaceDocumentMeta`, and one
 * pointer in two places is a pointer that disagrees with itself. So this
 * module reads the branches from the plane and the head from the meta, and
 * `resolveHead` reconciles a pointer whose branch is gone.
 *
 * Keys are branch NAMES. That is what makes two replicas that each add a
 * branch converge on both: different names are different keys, and a
 * mergeable plane means they are the same container. Two replicas moving the
 * SAME branch's tip is a register — last writer wins, which is what a
 * pointer wants.
 */
import {
  openWorkspaceDocumentPlane,
  readWorkspaceDocumentPlane,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  updateWorkspaceDocumentMeta,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc, LoroMap } from 'loro-crdt'
import {
  type BranchMeta,
  branchMetaSchema,
  type DocumentBranchesState,
  defaultMain,
  resolveHead,
} from './schema.js'

/** The node-data key the branch plane hangs off. */
export const BRANCHES_PLANE_KEY = 'branches'

/**
 * The stored form of one branch: everything a `BranchMeta` is except its
 * name, which is the key it is filed under. Storing the name twice would
 * let a rename half-land.
 */
const storedBranchSchema = branchMetaSchema.omit({ name: true })

/**
 * Oldest first, ties broken by name — the order the daemon's rows already
 * came back in, so a keeper swap does not reorder anybody's list.
 */
function compareBranches(a: BranchMeta, b: BranchMeta): number {
  return a.createdAt === b.createdAt
    ? a.name.localeCompare(b.name)
    : a.createdAt.localeCompare(b.createdAt)
}

/**
 * The branches this document holds, plus the head its meta points at.
 *
 * A document with no plane — every document written before this, and every
 * one nobody has branched — reads as `main` alone. That default is invented
 * on READ and never written: a document acquires a stored `main` the first
 * time somebody writes branches to it, exactly as the daemon's rows behaved.
 */
export function readBranchesFromRecord(
  doc: LoroDoc,
  documentId: string,
  now: Date = new Date(),
): DocumentBranchesState {
  const entry = resolveWorkspaceDocumentById(doc, documentId)
  const plane = readWorkspaceDocumentPlane(doc, documentId, BRANCHES_PLANE_KEY)
  const branches = plane === null ? [] : branchesOf(plane)
  if (branches.length === 0) return { branches: [defaultMain(now)], head: 'main' }
  return { branches, head: resolveHead(branches, entry?.currentBranch) }
}

/** One branch's tip, with the document it belongs to. */
export interface WorkspaceBranchTip {
  readonly documentId: string
  readonly name: string
  readonly tipFrontiers: string
}

/**
 * Every branch tip the whole workspace holds, across every document.
 *
 * Compaction needs this and nothing else: a cut that drops history a branch
 * tip still needs makes that variation uncheckoutable, so the earliest point
 * anybody can compact to is bounded by the OLDEST tip anywhere in the
 * workspace. It is a workspace-wide question, which is the one thing a
 * per-document read cannot answer, so it lives here beside what it reads
 * rather than as a walk each keeper writes for itself.
 *
 * Empty tips are included; a caller that treats "no tip yet" as pinning
 * nothing says so at its own use, where the reason belongs.
 */
export function readWorkspaceBranchTips(doc: LoroDoc): WorkspaceBranchTip[] {
  const out: WorkspaceBranchTip[] = []
  for (const entry of readWorkspaceDocuments(doc)) {
    const plane = readWorkspaceDocumentPlane(doc, entry.documentId, BRANCHES_PLANE_KEY)
    if (plane === null) continue
    for (const branch of branchesOf(plane)) {
      out.push({
        documentId: entry.documentId,
        name: branch.name,
        tipFrontiers: branch.tipFrontiers,
      })
    }
  }
  return out
}

/**
 * Whether this document's branches are on the record YET.
 *
 * `readBranchesFromRecord` invents `main` for a document that has none, which
 * is right for a reader and useless to a keeper migrating off another store:
 * it cannot tell an empty plane from a plane holding only `main`. This
 * answers that one question, so a keeper's fallback to its old rows is a
 * decision about where the data IS rather than a guess from a default.
 */
export function hasBranchesOnRecord(doc: LoroDoc, documentId: string): boolean {
  const plane = readWorkspaceDocumentPlane(doc, documentId, BRANCHES_PLANE_KEY)
  return plane !== null && branchesOf(plane).length > 0
}

/**
 * A branch whose stored fields no longer parse is DROPPED rather than
 * repaired: what a corrupt entry names is a variation nothing can check out,
 * and inventing a tip for it would point a checkout at the wrong history.
 */
function branchesOf(plane: LoroMap): BranchMeta[] {
  const out: BranchMeta[] = []
  for (const [name, raw] of Object.entries(plane.toJSON() as Record<string, unknown>)) {
    const parsed = storedBranchSchema.safeParse(raw)
    if (parsed.success) out.push({ name, ...parsed.data })
  }
  return out.sort(compareBranches)
}

/**
 * Replaces the plane with `state` and points the meta's head at `state.head`.
 *
 * Replaces rather than patches, because that is the shape every caller has:
 * `@kamiazya/whiteboard-history`'s branch operations each answer a whole next
 * state. A key the next state does not name is deleted, so a branch that was
 * removed does not survive as a tip that pins compaction forever.
 *
 * Answers false when no document carries the id — the caller decides whether
 * that is an error, the same contract `updateWorkspaceDocumentMeta` has.
 */
export function writeBranchesToRecord(
  doc: LoroDoc,
  documentId: string,
  state: DocumentBranchesState,
): boolean {
  const plane = openWorkspaceDocumentPlane(doc, documentId, BRANCHES_PLANE_KEY)
  if (plane === null) return false
  const wanted = new Map(state.branches.map((b) => [b.name, b]))
  for (const name of Object.keys(plane.toJSON() as Record<string, unknown>)) {
    if (!wanted.has(name)) plane.delete(name)
  }
  for (const [name, branch] of wanted) {
    const { name: _name, ...stored } = branch
    // Guarded by a read so an unchanged branch does not append a same-value
    // op per save: a tip update writes one branch, not the whole plane.
    const current = plane.get(name)
    if (!sameStoredBranch(current, stored)) plane.set(name, stored)
  }
  updateWorkspaceDocumentMeta(doc, documentId, { currentBranch: state.head })
  doc.commit()
  return true
}

function sameStoredBranch(current: unknown, next: Record<string, unknown>): boolean {
  const parsed = storedBranchSchema.safeParse(current)
  if (!parsed.success) return false
  const keys = new Set([...Object.keys(parsed.data), ...Object.keys(next)])
  for (const key of keys) {
    if ((parsed.data as Record<string, unknown>)[key] !== next[key]) return false
  }
  return true
}
