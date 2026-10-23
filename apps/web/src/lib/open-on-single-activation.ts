import { hasCoarsePointer } from './platform.js'

/**
 * Whether one activation of a document in a list opens it, or only selects.
 *
 * With a mouse a click selects (the preview follows) and a double-click or
 * Enter opens, because a click is also how you point at something to look at
 * it. A finger has no pointing without touching, and no second target to read
 * a preview from, so a tap opens. Every list surface asks here rather than
 * deciding for itself, so the cards, the rows, the Recent lane and the search
 * results cannot disagree about what one click means.
 *
 * `pointerType` is the event's own when a handler has one; without it the
 * primary pointer decides.
 */
export function openOnSingleActivation(pointerType?: string): boolean {
  return pointerType === 'touch' || hasCoarsePointer()
}
