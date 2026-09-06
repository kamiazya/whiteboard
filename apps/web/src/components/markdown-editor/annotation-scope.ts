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
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { type MutableRefObject, useCallback } from 'react'
import { blockRangeNear } from '../../lib/block-range-at.js'
import type { TextAnchor } from '../../lib/text-anchor.js'
import { textAnchorForSelection } from '../../lib/text-anchor-for-selection.js'
import { placeThreads } from './annotation-decorations.js'

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

export interface AnnotationEntryHost {
  readonly threads: readonly CommentThread[]
  readonly onComposeThread: ((anchor: TextAnchor) => void) | undefined
  readonly onSelectThread: ((threadId: string) => void) | undefined
}

/**
 * One press, two meanings, and the reader is asking for the same thing
 * either way: talk about this block. A block a conversation is ALREADY
 * about opens that conversation; a block with none starts one.
 *
 * The first half is what makes the layer reachable on a phone at all. The
 * gutter marker is a 12px dot three pixels from the screen edge — a quarter
 * of WCAG 2.5.8's minimum in each dimension, and inside the strip the OS
 * keeps for its own back gesture — so it cannot be the only way in. A caret
 * in the paragraph plus a toolbar button is the same act with a target the
 * size of the paragraph.
 */
export function useAnnotationEntry(
  body: string,
  sourceRef: MutableRefObject<AnnotationScopeSource | null>,
  host: AnnotationEntryHost,
): AnnotationEntry {
  const { threads, onComposeThread, onSelectThread } = host
  const anchor = useCallback(() => annotationAnchorFrom(body, sourceRef.current), [body, sourceRef])
  const open = useCallback(() => {
    const found = anchor()
    if (found === null) return
    // Overlap, not equality: the stored quote is whatever passage the thread
    // was opened on, which is usually a phrase inside the block rather than
    // the block itself.
    const covering = placeThreads(body, threads).find(
      (placed) => placed.from < found.end && placed.to > found.start,
    )
    if (covering !== undefined && onSelectThread !== undefined) {
      onSelectThread(covering.threadId)
      return
    }
    onComposeThread?.(found)
  }, [anchor, body, threads, onComposeThread, onSelectThread])
  return { anchor, open: onComposeThread === undefined ? undefined : open }
}
