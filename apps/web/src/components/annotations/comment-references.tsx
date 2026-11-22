/**
 * What a comment's `[[references]]` resolve through, handed down to every
 * `CommentBody` below it. The rail, the panel and the canvas card each draw
 * the same message, so they take one bundle from the page rather than each
 * holding a loader: a surface that forgot to thread it would draw brackets
 * where its neighbour drew a title. Absent, nothing resolves and a body draws
 * as written.
 */
import type { ReferenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { createContext, useContext } from 'react'

const CommentReferencesContext = createContext<ReferenceSeams | undefined>(undefined)

export const CommentReferencesProvider = CommentReferencesContext.Provider

export function useCommentReferences(): ReferenceSeams | undefined {
  return useContext(CommentReferencesContext)
}
