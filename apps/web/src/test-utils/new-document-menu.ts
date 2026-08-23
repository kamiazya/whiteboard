import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { fireEvent, screen } from '@testing-library/react'

/**
 * Create a document through the document browser's `NewDocumentMenu`.
 *
 * Two presses, not one: the toolbar's entry opens a menu and the kind is
 * chosen against a word there, because `kind` cannot be changed afterwards
 * and must not be committed by a press on an unlabeled glyph.
 *
 * Radix opens its trigger on pointerDown and selects an item on pointerUp —
 * a plain click reaches neither.
 */
export async function pickNewDocumentKind(kind: DocumentKind): Promise<void> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New document' }), { button: 0 })
  fireEvent.pointerUp(await screen.findByTestId(`new-document-${kind}`))
}
