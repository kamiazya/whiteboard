import {
  canvasIdSchema,
  canvasKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

export const documentEntrySchema = z
  .object({
    canvasId: canvasIdSchema,
    path: documentPathSchema,
    kind: canvasKindSchema,
    /**
     * What a human reads, as opposed to `path`, which is an address. Absent
     * rather than defaulted to the last path segment: a reader that wants
     * that fallback can choose it, while a listing that invents one reads as
     * though somebody typed the slug in as a title.
     */
    name: z.string().min(1).optional(),
  })
  .strict()
export type DocumentEntry = z.infer<typeof documentEntrySchema>

export const createDocumentInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: documentPathSchema,
    kind: canvasKindSchema,
    name: z.string().min(1).optional(),
  })
  .strict()
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>

export const createWorkspaceInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>

export const resolveDocumentByIdInputSchema = z
  .object({ workspaceId: workspaceIdSchema, canvasId: canvasIdSchema })
  .strict()
export type ResolveDocumentByIdInput = z.infer<typeof resolveDocumentByIdInputSchema>

export const resolveDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema })
  .strict()
export type ResolveDocumentInput = z.infer<typeof resolveDocumentInputSchema>

export const listDocumentsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type ListDocumentsInput = z.infer<typeof listDocumentsInputSchema>

export const moveDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, from: documentPathSchema, to: documentPathSchema })
  .strict()
export type MoveDocumentInput = z.infer<typeof moveDocumentInputSchema>

export const setDocumentNameInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    name: z.string().min(1).optional(),
  })
  .strict()
export type SetDocumentNameInput = z.infer<typeof setDocumentNameInputSchema>

export const deleteDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema })
  .strict()
export type DeleteDocumentInput = z.infer<typeof deleteDocumentInputSchema>

/**
 * The `listDocuments` order, as a function, so two implementations cannot
 * write it two ways. Compares segment against segment by code point, and a
 * path sorts before every path it prefixes.
 *
 * A pure model-only helper in a contracts package for the same reason
 * `chunkSnapshot` is one: the rule is part of the contract, and a comparator
 * every store re-derives from prose is a comparator they will re-derive
 * differently.
 */
export function compareDocumentPaths(left: string, right: string): number {
  const a = left.split('/')
  const b = right.split('/')
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const segmentA = a[i] as string
    const segmentB = b[i] as string
    if (segmentA !== segmentB) return segmentA < segmentB ? -1 : 1
  }
  return a.length - b.length
}

/**
 * Thrown when an operation names a workspace that does not exist.
 *
 * Workspaces never materialize implicitly here. A typo'd or hallucinated
 * workspaceId is otherwise indistinguishable from a new one, and the caller
 * gets a workspace nobody asked for with its data quietly inside.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace not found: "${workspaceId}". Create it before adding documents to it.`)
    this.name = 'WorkspaceNotFoundError'
  }
}

/**
 * Thrown when a path the caller wanted to occupy is already occupied.
 *
 * Named in the contract rather than left to each implementation: "fails if the
 * path is taken" is not a guarantee a caller can act on if one store throws
 * this and another surfaces whatever its unique index raised. A store whose
 * backing has no unique constraint has to detect the collision itself, and
 * only a named error makes that difference visible instead of silent.
 */
export class DocumentPathTakenError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly path: string,
  ) {
    super(`Document path "${path}" already exists in workspace "${workspaceId}"`)
    this.name = 'DocumentPathTakenError'
  }
}

/**
 * Thrown when an operation names a document that is not there. Deleting an
 * absent path is deliberately NOT this — the caller wanted it gone and it is —
 * but moving one is: there is a destination involved, and silently doing
 * nothing would look identical to having moved it.
 */
export class DocumentNotFoundError extends Error {
  constructor(
    readonly workspaceId: string,
    /** The path or the id the caller named — whichever the operation takes. */
    readonly target: string,
  ) {
    super(`No document "${target}" in workspace "${workspaceId}"`)
    this.name = 'DocumentNotFoundError'
  }
}

/** Thrown when an operation would strand or swallow the documents below its target. */
export class DocumentHasDescendantsError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Document "${path}" has descendants. ${detail}`)
    this.name = 'DocumentHasDescendantsError'
  }
}

/** Thrown when a move's destination lies inside the subtree being moved. */
export class DocumentMoveIntoSelfError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Cannot move "${from}" to "${to}": the destination is inside the subtree being moved`)
    this.name = 'DocumentMoveIntoSelfError'
  }
}

/**
 * The workspace's index of the documents it holds: which paths exist, what
 * each one is, and which stored document each names.
 *
 * It is deliberately separate from `CanvasDocStore`, which owns a single
 * document's bytes and knows nothing about where that document sits. This
 * one owns placement and is the only thing that assigns a `canvasId`.
 *
 * **Mutating operations are serialized per workspace, and each takes effect as
 * one indivisible operation or has no effect at all.** Path uniqueness is the
 * entire mechanism enforcing sibling uniqueness here, so an implementation
 * that checks a path and then writes it as two separable steps can satisfy
 * this interface and still produce duplicates, and one that rewrites a subtree
 * without the same guarantee can leave a hierarchy half moved. Neither is
 * observable through the types, which is why it is stated — and stated as
 * serialization rather than as bare "atomicity", which would leave the
 * observable ordering to each implementation and make the guarantee untestable.
 */
export interface DocumentIndex {
  /**
   * Idempotent: creating a workspace that exists is not an error, because the
   * caller wants it to be there and it is. Explicit because `createDocument`
   * refuses an absent workspace rather than conjuring one.
   */
  createWorkspace(input: CreateWorkspaceInput): Promise<void>
  /**
   * Fails `WorkspaceNotFoundError` if the workspace does not exist. Fails if
   * the path is taken. Creating never silently adopts an existing
   * document, because the caller that wanted a new one would otherwise
   * start writing into somebody else's. Claiming the path and assigning the
   * `canvasId` is one step, not a check followed by a write.
   */
  createDocument(input: CreateDocumentInput): Promise<DocumentEntry>
  resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null>
  /**
   * The same lookup keyed by the id the index assigned. Still workspace-scoped:
   * an id is a handle within a workspace, not a capability that reaches across
   * them, so the wrong workspace resolves to null rather than to the document.
   */
  resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null>
  /**
   * Fails `WorkspaceNotFoundError` for a workspace that does not exist,
   * rather than answering with an empty list. A typo'd workspaceId is
   * otherwise indistinguishable from a workspace that genuinely holds
   * nothing, and the caller most likely to hit it is a listing.
   *
   * Ordered by path, compared SEGMENT BY SEGMENT — not as whole strings.
   * A hierarchical listing is the point of this index, and leaving the order
   * to whatever a store's rows come back in would put a storage detail in
   * front of a user.
   *
   * Which comparison is not a detail: `-` (0x2D) sorts before `/` (0x2F), so
   * comparing whole strings puts `a-b` between `a` and its own child `a/b`
   * and splits a subtree apart. Segment-wise gives `a`, `a/b`, `a-b`, keeping
   * every subtree contiguous, which is the only order a tree can be rendered
   * from without re-sorting.
   *
   * Segment-wise alone still leaves two choices, so both are fixed here:
   * segments compare by Unicode code point (`a/10` before `a/2`, since `1`
   * precedes `2` — NOT natural/numeric collation, which would reorder them
   * and is locale-shaped), and a path sorts before every path it prefixes
   * (`x` before `x/y`). Descendants-first would also keep subtrees
   * contiguous, so it has to be ruled out rather than left to the example.
   */
  listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]>
  /**
   * Moves a document, and with it every descendant — `a/b` moving to `c`
   * takes `a/b/d` to `c/d`, because a descendant's path is defined by its
   * ancestors' and nothing else records the relationship.
   *
   * Fails if **any** path the move would produce is already taken, not only
   * `to` itself: moving `a` to `c` collides when `a/d` and `c/d` both exist
   * even though `c` is free. The move is rejected whole in that case — a
   * partial move would silently merge two hierarchies, and the caller asked
   * to relocate one.
   *
   * Fails when `from` names nothing — unlike a delete, which is content with
   * an absent path, a move has a destination and doing nothing quietly would
   * be indistinguishable from succeeding.
   *
   * Also fails when `to` is inside `from`'s own subtree (`a` to `a/b`). The
   * produced paths do not actually collide there — prefix replacement keeps
   * distinct suffixes distinct — so this is a deliberate refusal rather than
   * a consequence of the rule above: without it, whether the moving subtree's
   * own paths count as "taken" during its own move is left to each
   * implementation, and two of them would disagree observably.
   *
   * This is a real limitation, not a meaningless case being tidied away:
   * `a` to `a/archive` is a coherent "wrap this subtree in a new level"
   * reorganisation. It is refused because the exemption rule that would
   * permit it is intricate and nothing needs it yet. A restructuring flow
   * that wants it should get its own operation rather than an exception
   * carved into this one.
   */
  moveDocument(input: MoveDocumentInput): Promise<void>
  /**
   * Sets — or, with no `name`, clears — a document's display name. Keyed by
   * id rather than by path because a name is not a placement: renaming must
   * leave the document exactly where it is, and a caller that has to name the
   * path to change the name would eventually move one by accident.
   *
   * Fails `DocumentNotFoundError` for an id this workspace does not hold, on
   * the same reasoning as `moveDocument`: a rename has a target, and quietly
   * doing nothing is indistinguishable from having renamed it.
   */
  setDocumentName(input: SetDocumentNameInput): Promise<void>
  /**
   * Deleting an absent path succeeds; the caller wants it gone either way.
   *
   * Deleting one that still has descendants does NOT: every document here can
   * hold children, so a cascade is reachable from a single call naming one
   * path, and deletion is the operation with nothing to undo it. Refusing
   * makes the caller name what it is destroying. `moveDocument` carries
   * descendants precisely because a move loses nothing.
   */
  deleteDocument(input: DeleteDocumentInput): Promise<void>
}
