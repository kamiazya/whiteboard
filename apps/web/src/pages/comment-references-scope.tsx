/**
 * Hands every comment surface of one document page a reference bundle. The
 * rail, the panel and the canvas card draw comment prose, whose `[[references]]`
 * resolve through the same keeper loader the body's do.
 */
import type { ReactNode } from 'react'
import { CommentReferencesProvider } from '../components/annotations/comment-references.js'
import { useReferenceSeams } from '../hooks/use-reference-seams.js'
import type { DocumentPageModel } from './document-page-model.js'

export function CommentReferencesScope({
  model,
  children,
}: {
  model: DocumentPageModel
  children: ReactNode
}) {
  const { files, threads } = model
  const body = threads.annotations
    .flatMap((thread) => thread.messages.map((message) => message.body))
    .join('\n\n')
  const references = useReferenceSeams({
    body,
    resolveAlias: files.resolveAlias,
    resolveTitle: files.resolveTitle,
    load: files.loadReference,
  })
  return <CommentReferencesProvider value={references}>{children}</CommentReferencesProvider>
}
