/**
 * The words the editor uses for the things a person can create, in ONE place
 * so the two surfaces that offer them — the dock's "+" menu and the canvas
 * context menu — cannot drift apart.
 *
 * Object names, not sentences: the surface already says what will happen
 * (a menu called "Add", or a press on empty canvas), so "Add note here"
 * repeated the context twice and made the same object read differently
 * depending on where it was offered.
 *
 * `document` follows ADR-0009: what a workspace holds is a Document, and
 * Canvas is the spatial surface and its file format. The picker behind this
 * entry lists markdown documents too, so the old "Canvas" was not only
 * off-vocabulary, it was untrue.
 */
export const CREATION_LABELS = {
  note: 'Note',
  link: 'Link',
  group: 'Group',
  document: 'Document',
  image: 'Image',
} as const

export type CreationLabel = (typeof CREATION_LABELS)[keyof typeof CREATION_LABELS]
