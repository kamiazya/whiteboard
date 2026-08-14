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
  })
  .strict()
export type DocumentEntry = z.infer<typeof documentEntrySchema>

export const createDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema, kind: canvasKindSchema })
  .strict()
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>

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

export const deleteDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema })
  .strict()
export type DeleteDocumentInput = z.infer<typeof deleteDocumentInputSchema>

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
   * Fails if the path is taken. Creating never silently adopts an existing
   * document, because the caller that wanted a new one would otherwise
   * start writing into somebody else's. Claiming the path and assigning the
   * `canvasId` is one step, not a check followed by a write.
   */
  createDocument(input: CreateDocumentInput): Promise<DocumentEntry>
  resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null>
  /**
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
   * Also fails when `to` is inside `from`'s own subtree (`a` to `a/b`). The
   * produced paths do not actually collide there — prefix replacement keeps
   * distinct suffixes distinct — so this is a deliberate refusal rather than
   * a consequence of the rule above: the result would be a document nested
   * under a path derived from itself, which no caller means to ask for, and
   * whether the subtree's own paths count as "taken" during its own move is
   * a question better refused than answered.
   */
  moveDocument(input: MoveDocumentInput): Promise<void>
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
