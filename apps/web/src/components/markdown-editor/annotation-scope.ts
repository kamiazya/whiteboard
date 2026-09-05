/**
 * What a conversation opened from a markdown body would be about.
 *
 * The reader's SELECTION when there is one, and otherwise the block their
 * caret is in. The fallback is what makes the annotation entry pressable at
 * all on a phone: selecting a passage there is a drag between two handles,
 * the most awkward gesture the platform has, and a reader who wants to say
 * something about a paragraph has already put the caret in it.
 *
 * That is a different claim from the one every formatting verb makes about
 * the word under a caret. A word is a guess at what someone meant, kept
 * forever as though they had said it; a paragraph is a unit they have
 * already pointed at.
 *
 * `blockRangeNear` rather than `blockRangeAt`, so a caret on a blank line
 * takes the neighbour instead of nothing — see its own comment for why the
 * case is removed here rather than raced in a control's enabled state. The
 * one null left is a body with no prose, which a caller can see in the
 * value it already re-renders on.
 *
 * Read from the live view at press time rather than held in state: a caret
 * MOVE re-renders nothing, so anything derived from it and held would be
 * stale exactly when a reader had just moved.
 */
import { type MutableRefObject, useCallback } from 'react'
import { blockRangeNear } from '../../lib/block-range-at.js'
import type { TextAnchor } from '../../lib/text-anchor.js'
import { textAnchorForSelection } from '../../lib/text-anchor-for-selection.js'

export interface AnnotationScopeSource {
  readonly selectedRange: () => { from: number; to: number } | null
  readonly caretOffset: () => number
}

export function annotationAnchorFrom(
  body: string,
  source: AnnotationScopeSource | null,
): TextAnchor | null {
  if (source === null) return null
  const range = source.selectedRange() ?? blockRangeNear(body, source.caretOffset())
  if (range === null) return null
  return textAnchorForSelection(body, range.from, range.to)
}

export interface AnnotationEntry {
  /** The scope a conversation opened right now would quote, or null. */
  readonly anchor: () => TextAnchor | null
  /** Opens one, or undefined where the host has no annotation layer. */
  readonly open: (() => void) | undefined
}

export function useAnnotationEntry(
  body: string,
  sourceRef: MutableRefObject<AnnotationScopeSource | null>,
  onComposeThread: ((anchor: TextAnchor) => void) | undefined,
): AnnotationEntry {
  const anchor = useCallback(() => annotationAnchorFrom(body, sourceRef.current), [body, sourceRef])
  const open = useCallback(() => {
    const found = anchor()
    if (found !== null) onComposeThread?.(found)
  }, [anchor, onComposeThread])
  return { anchor, open: onComposeThread === undefined ? undefined : open }
}
