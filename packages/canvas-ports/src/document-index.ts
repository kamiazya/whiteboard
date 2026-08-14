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
 */
export interface DocumentIndex {
  /**
   * Fails if the path is taken. Creating never silently adopts an existing
   * document, because the caller that wanted a new one would otherwise
   * start writing into somebody else's.
   */
  createDocument(input: CreateDocumentInput): Promise<DocumentEntry>
  resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null>
  listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]>
  /**
   * Moves a document, and with it every descendant — `a/b` moving to `c`
   * takes `a/b/d` to `c/d`, because a descendant's path is defined by its
   * ancestors' and nothing else records the relationship. Fails if the
   * destination is taken.
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
