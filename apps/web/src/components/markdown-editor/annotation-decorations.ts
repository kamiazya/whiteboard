/**
 * The annotation layer's in-place projection on a markdown body (ADR-0026
 * step 3): the passage a conversation is about, marked in the text, with a
 * reachable affordance in the gutter beside it.
 *
 * The rail answers "which conversations are open on this document"; this
 * answers "and where". Neither replaces the other — an ORPHANED thread has no
 * passage left to be drawn over, which is exactly why the rail exists and why
 * this surface can stay silent about one instead of inventing a place for it.
 *
 * **The gutter is the click target, not the highlight.** The passage is
 * ordinary editable text, so a click on it has to keep meaning "put the caret
 * here"; a second meaning would make the conversation's own subject the one
 * span in the document a reader cannot click into. The marker sits outside
 * the text flow where a click means nothing else.
 *
 * Placement goes through `resolveTextAnchor`, the same function the rail's
 * orphan badge reads. That is deliberate and load-bearing: if this surface
 * mapped positions through CodeMirror's change sets (which would let a
 * highlight follow an edit inside its own passage) the two would disagree,
 * and a thread the rail calls lost would still be highlighted in the body.
 * One answer, one function. What an edit carries forward is only where each
 * quote occurs (`quote-occurrences.ts`), which is what lets a keystroke skip
 * the search without changing the answer.
 */

import {
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  gutterLineClass,
} from '@codemirror/view'
import {
  type CommentThread,
  type CommentThreadStatus,
  DOCUMENT_MAX_OPEN_THREADS,
} from '@kamiazya/whiteboard-model'
import {
  advanceKnownQuotes,
  type KnownQuotes,
  NO_KNOWN_QUOTES,
  resolveRemembering,
  textEditsOf,
} from '../../lib/quote-occurrences.js'
import type { LivePassage } from '../../lib/text-anchor.js'
import { threadLastActivityAt } from '../../lib/thread-activity.js'
import { bucketByLine, buttonGutterHandlers } from './line-button-gutter.js'

/** Where one conversation sits in the body as it stands right now. */
export interface PlacedThread {
  readonly threadId: string
  readonly status: CommentThreadStatus
  readonly from: number
  readonly to: number
}

/**
 * Every thread that still finds its passage in `body`, in document order.
 *
 * Ordered because a `RangeSet` is built from it directly and CodeMirror
 * requires sorted input; sorting here rather than at the call site keeps the
 * two consumers (marks and gutter markers) from each having to remember.
 */
export function placeThreads(
  body: string,
  threads: readonly CommentThread[],
  marks?: ReadonlyMap<string, LivePassage>,
  known: KnownQuotes = NO_KNOWN_QUOTES,
  learnt: Map<string, readonly number[] | null> = new Map(),
): readonly PlacedThread[] {
  const placed: PlacedThread[] = []
  for (const thread of threads) {
    // A spatial anchor on a markdown document is not lost — it is about a
    // surface this document has not got, and there is nothing here to draw
    // it over. `markdownAnchorResolver` says the same thing for the rail.
    if (thread.anchor.kind !== 'text') continue
    const resolved = resolveRemembering(body, thread.anchor, marks?.get(thread.id), known, learnt)
    if (resolved.kind !== 'placed') continue
    placed.push({
      threadId: thread.id,
      status: thread.status,
      from: resolved.start,
      to: resolved.end,
    })
  }
  return placed.sort((a, b) => a.from - b.from || a.to - b.to)
}

/**
 * What the pane should draw. Sent as one effect rather than two so a thread
 * list and the selection it refers to can never be applied a frame apart —
 * a selected id naming a thread the pane has not been given yet would light
 * up nothing and read as the press being ignored.
 */
export interface AnnotationProjection {
  readonly threads: readonly CommentThread[]
  readonly selectedThreadId: string | null
  /**
   * Where the CRDT still holds each passage, by thread id.
   *
   * Travels in the same effect as the threads for the same reason the
   * selection does: a mark map applied a frame apart from the thread list it
   * describes would place a passage using a range that belongs to a document
   * the pane has not been shown yet.
   *
   * Absent for a host that has no marks to give — a document read out of a
   * markdown file, or one written before marks existed — which `placeThreads`
   * reads as "ask the quote".
   */
  readonly marks?: ReadonlyMap<string, LivePassage>
}

export const setAnnotationProjection = StateEffect.define<AnnotationProjection>()

const EMPTY_PROJECTION: AnnotationProjection = { threads: [], selectedThreadId: null }

interface AnnotationState {
  readonly projection: AnnotationProjection
  /** The projection's threads this pane places — see `threadsToDraw`. */
  readonly drawn: readonly CommentThread[]
  readonly placed: readonly PlacedThread[]
  readonly marks: DecorationSet
  /** Where the projected quotes occur in the doc this state holds. */
  readonly known: KnownQuotes
}

/**
 * What the marker beside a line says out loud. Two independent facts, and a
 * reader wants whichever applies: how much is in the conversation a press
 * will open, and whether that line carries more than one.
 */
function gutterLabel(messages: number, threads: number): string {
  if (messages > 1 && threads > 1) {
    return `A conversation of ${messages} messages, one of ${threads} on this line`
  }
  if (messages > 1) return `A conversation of ${messages} messages`
  if (threads > 1) return `${threads} conversations on this line`
  return 'A conversation on this line'
}

class ThreadGutterMarker extends GutterMarker {
  constructor(
    private readonly threadId: string,
    private readonly selected: boolean,
    private readonly messages: number,
    private readonly threads: number,
  ) {
    super()
  }

  /**
   * Status is deliberately absent, and `elementClass` below is why.
   *
   * CodeMirror REPLACES a marker's DOM when `eq` is false — measured across
   * one resolve, the dot came back as a different element — and a fresh
   * element has no value to transition from, so the colour cut however the
   * CSS was written. The `.cm-gutterElement` wrapper is the same element
   * throughout (measured in the same run), so the state rides there and the
   * dot, now reused, crosses.
   */
  override eq(other: ThreadGutterMarker): boolean {
    return (
      other.threadId === this.threadId &&
      other.selected === this.selected &&
      other.messages === this.messages &&
      other.threads === this.threads
    )
  }

  override toDOM(): Node {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = 'cm-annotation-gutter-marker'
    dot.dataset.threadId = this.threadId
    if (this.selected) dot.dataset.selected = 'true'
    // The one digit this dot can hold belongs to the CONVERSATION, not to
    // the line: a reader scanning a body is deciding whether to open this
    // one, and "four messages" answers that where "two conversations here"
    // does not. The line's own count is the rarer fact and keeps its own
    // channel — `data-threads` for the stacked ring, and the label for
    // anyone who cannot see it — so the second conversation is still never
    // silently dropped.
    //
    // The dot is an INNER element and the button is the press area. A 12px
    // dot is right beside prose and half of WCAG 2.5.8's 24x24 minimum in
    // each dimension, a quarter of its area; growing the button keeps the picture and
    // fixes the target. Measured first: a `::after` overhanging an 18px
    // gutter did not work — `.cm-gutterElement` clips it, and where it did
    // reach, the toolbar above and the content beside it won the hit test.
    if (this.threads > 1) dot.dataset.threads = String(this.threads)
    const inner = document.createElement('span')
    inner.className = 'cm-annotation-gutter-dot'
    inner.textContent = this.messages > 1 ? String(this.messages) : ''
    dot.append(inner)
    dot.setAttribute('aria-label', gutterLabel(this.messages, this.threads))
    return dot
  }
}

/**
 * The RESOLVED state of the line, carried by a marker of its own.
 *
 * It cannot ride `ThreadGutterMarker`: CodeMirror only re-reads
 * `elementClass` when a line's marker set actually differs, and it decides
 * that with the same `eq` that governs whether the dot's DOM is reused. One
 * marker cannot both keep its element and announce a new class — measured,
 * an `elementClass` getter on the dot's own marker never reached the wrapper.
 * `gutterLineClass` is the facet CodeMirror provides for exactly this, and
 * its contract is what this class satisfies: an `elementClass`, no `toDOM`.
 */
class ResolvedLineMarker extends GutterMarker {
  override elementClass = 'cm-annotation-resolved-line'
}

const RESOLVED_LINE_MARKER = new ResolvedLineMarker()

/**
 * The most RESOLVED conversations the pane places, beyond the selected one.
 *
 * Open threads are bounded by `DOCUMENT_MAX_OPEN_THREADS`; resolved ones are
 * not, since resolving is how a document at that bound takes another. And
 * every placed thread is work on every keystroke — its quote is searched for
 * near each edit, and an orphan's across the whole body when first placed —
 * so without a bound here one member's history of resolved orphans would
 * set the price of typing for everyone.
 */
const DRAWN_RESOLVED_MAX = DOCUMENT_MAX_OPEN_THREADS

/**
 * Every open thread, the selected one, and the most recently active
 * resolved ones up to `DRAWN_RESOLVED_MAX`. An older resolved conversation
 * is still the rail's to list, and selecting it there draws it.
 *
 * Computed when a projection ARRIVES rather than per keystroke, so the
 * ranking is not a cost an edit pays.
 */
function threadsToDraw(
  threads: readonly CommentThread[],
  selectedThreadId: string | null,
): readonly CommentThread[] {
  const resolved = threads.filter((t) => t.status === 'resolved' && t.anchor.kind === 'text')
  if (resolved.length <= DRAWN_RESOLVED_MAX) return threads
  const activity = (thread: CommentThread): number => {
    const at = Date.parse(threadLastActivityAt(thread) ?? '')
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
  }
  const newest = resolved
    .map((thread) => ({ id: thread.id, at: activity(thread) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, DRAWN_RESOLVED_MAX)
  const kept = new Set(newest.map((one) => one.id))
  return threads.filter(
    (t) => t.status !== 'resolved' || kept.has(t.id) || t.id === selectedThreadId,
  )
}

function project(
  doc: string,
  projection: AnnotationProjection,
  drawn: readonly CommentThread[],
  known: KnownQuotes,
): AnnotationState {
  const learnt = new Map<string, readonly number[] | null>()
  const placed = placeThreads(doc, drawn, projection.marks, known, learnt)
  const marks = new RangeSetBuilder<Decoration>()
  // No empty-range branch, and that is a decision rather than an oversight:
  // CodeMirror throws on an empty mark decoration, and what stops one here is
  // `textQuoteSelectorSchema`'s `exact: z.string().min(1)` — every thread the
  // app reads is `commentThreadSchema.safeParse`d, and a placed range is
  // always `exact.length` wide. Loosening that rule would need a branch here.
  for (const one of placed) {
    marks.add(
      one.from,
      one.to,
      Decoration.mark({
        class:
          one.threadId === projection.selectedThreadId
            ? 'cm-annotation cm-annotation-selected'
            : one.status === 'resolved'
              ? 'cm-annotation cm-annotation-resolved'
              : 'cm-annotation',
        attributes: { 'data-thread-id': one.threadId },
      }),
    )
  }
  return { projection, drawn, placed, marks: marks.finish(), known: learnt }
}

const annotationField = StateField.define<AnnotationState>({
  create: (state) => project(state.doc.toString(), EMPTY_PROJECTION, [], NO_KNOWN_QUOTES),
  update(value, tr) {
    const projection = tr.effects.reduce<AnnotationProjection | null>(
      (found, effect) => found ?? (effect.is(setAnnotationProjection) ? effect.value : null),
      null,
    )
    if (projection === null && !tr.docChanged) return value
    // `tr.newDoc`, never `tr.state.doc`: a state field's update runs WHILE
    // the new state is being built, so asking it for itself is the recursive
    // read CodeMirror provides this for.
    const doc = tr.newDoc.toString()
    // Re-resolve rather than map through the change set: see the module note
    // — the rail reads the same resolver, and a mapped range would let the
    // two disagree about whether a thread still has a place.
    const known = tr.docChanged
      ? advanceKnownQuotes(value.known, doc, textEditsOf(tr.changes))
      : value.known
    if (projection === null) return project(doc, value.projection, value.drawn, known)
    return project(
      doc,
      projection,
      threadsToDraw(projection.threads, projection.selectedThreadId),
      known,
    )
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
})

export interface AnnotationHandlers {
  /** A gutter marker was pressed; the host opens that conversation. */
  readonly onSelectThread?: (threadId: string) => void
}

/**
 * The marks alone, for a host with no margin to put a gutter in — a text
 * node's editor sits in the node's own box, and a gutter there shifts the
 * words away from where the committed render draws them. The projection
 * still travels in through `setAnnotationProjection`.
 */
export function annotationMarks(): Extension {
  return annotationField
}

/**
 * The extension a host adds to the source pane. Static — the threads travel
 * in through `setAnnotationProjection`, because the view is created once per
 * mount and a changing extension array would not reach it.
 */
export function annotationDecorations(handlers: AnnotationHandlers = {}): Extension {
  return [
    annotationField,
    // The line's state, separate from the dot that sits on it — see
    // `ResolvedLineMarker`.
    gutterLineClass.compute([annotationField], (state) => {
      const resolved = state
        .field(annotationField)
        .placed.filter((one) => one.status === 'resolved')
      const builder = new RangeSetBuilder<GutterMarker>()
      for (const [lineStart] of bucketByLine(state.doc, resolved)) {
        builder.add(lineStart, lineStart, RESOLVED_LINE_MARKER)
      }
      return builder.finish()
    }),
    gutter({
      class: 'cm-annotation-gutter',
      markers: (view) => {
        const { placed } = view.state.field(annotationField)
        if (placed.length === 0) return RangeSet.empty
        const { selectedThreadId, threads } = view.state.field(annotationField).projection
        // Read from the projection rather than carried on `PlacedThread`:
        // placement is about WHERE a passage is, and how many messages it
        // holds is not a property of that.
        const messageCounts = new Map(threads.map((one) => [one.id, one.messages.length]))
        const builder = new RangeSetBuilder<GutterMarker>()
        for (const [lineStart, bucket] of bucketByLine(view.state.doc, placed)) {
          // The line speaks for the conversation a reader is looking at when
          // one of its threads is selected, and otherwise for the first —
          // which is the one a press will open.
          const lead =
            bucket.find((one) => one.threadId === selectedThreadId) ?? (bucket[0] as PlacedThread)
          builder.add(
            lineStart,
            lineStart,
            new ThreadGutterMarker(
              lead.threadId,
              lead.threadId === selectedThreadId,
              messageCounts.get(lead.threadId) ?? 1,
              bucket.length,
            ),
          )
        }
        return builder.finish()
      },
      // Opening a conversation is not an edit, so the press holds the caret
      // where it was: a reader who lands back in the text keeps their place.
      domEventHandlers: buttonGutterHandlers('.cm-annotation-gutter-marker', (marker) => {
        const { threadId } = marker.dataset
        if (threadId === undefined) return false
        handlers.onSelectThread?.(threadId)
        return true
      }),
    }),
  ]
}
