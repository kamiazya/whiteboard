import type { DocumentKind } from '@kamiazya/whiteboard-model'

/**
 * What user-visible copy calls a document of this kind. "canvas" is correct
 * ONLY when the kind is known to be spatial (vocabulary.md: the container
 * sense of the word is retired); an unrecorded kind gets the honest generic.
 */
export function kindNoun(kind: DocumentKind | undefined): 'canvas' | 'note' | 'document' {
  if (kind === 'spatial') return 'canvas'
  if (kind === 'markdown') return 'note'
  return 'document'
}
