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
 * One answer, one function.
 */

import {
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view'
import type { CommentThread, CommentThreadStatus } from '@kamiazya/whiteboard-model'
import { resolveTextAnchor } from '@/lib/text-anchor'

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
): readonly PlacedThread[] {
  const placed: PlacedThread[] = []
  for (const thread of threads) {
    // A spatial anchor on a markdown document is not lost — it is about a
    // surface this document has not got, and there is nothing here to draw
    // it over. `markdownAnchorResolver` says the same thing for the rail.
    if (thread.anchor.kind !== 'text') continue
    const resolved = resolveTextAnchor(body, thread.anchor)
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
}

export const setAnnotationProjection = StateEffect.define<AnnotationProjection>()

const EMPTY_PROJECTION: AnnotationProjection = { threads: [], selectedThreadId: null }

interface AnnotationState {
  readonly projection: AnnotationProjection
  readonly placed: readonly PlacedThread[]
  readonly marks: DecorationSet
}

class ThreadGutterMarker extends GutterMarker {
  constructor(
    private readonly threadId: string,
    private readonly status: CommentThreadStatus,
    private readonly selected: boolean,
    private readonly count: number,
  ) {
    super()
  }

  override eq(other: ThreadGutterMarker): boolean {
    return (
      other.threadId === this.threadId &&
      other.status === this.status &&
      other.selected === this.selected &&
      other.count === this.count
    )
  }

  override toDOM(): Node {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = 'cm-annotation-gutter-marker'
    dot.dataset.threadId = this.threadId
    if (this.status === 'resolved') dot.dataset.threadStatus = 'resolved'
    if (this.selected) dot.dataset.selected = 'true'
    // The count is the whole reason this is a label and not a bare dot: two
    // conversations about the same line are one marker, and a reader who is
    // not told so would think the second one had vanished.
    dot.textContent = this.count > 1 ? String(this.count) : ''
    dot.setAttribute(
      'aria-label',
      this.count > 1 ? `${this.count} conversations on this line` : 'A conversation on this line',
    )
    return dot
  }
}

function project(doc: string, projection: AnnotationProjection): AnnotationState {
  const placed = placeThreads(doc, projection.threads)
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
  return { projection, placed, marks: marks.finish() }
}

const annotationField = StateField.define<AnnotationState>({
  create: (state) => project(state.doc.toString(), EMPTY_PROJECTION),
  update(value, tr) {
    // `tr.newDoc`, never `tr.state.doc`: a state field's update runs WHILE
    // the new state is being built, so asking it for itself is the recursive
    // read CodeMirror provides this for.
    for (const effect of tr.effects) {
      if (effect.is(setAnnotationProjection)) return project(tr.newDoc.toString(), effect.value)
    }
    // Re-resolve rather than map through the change set: see the module note
    // — the rail reads the same resolver, and a mapped range would let the
    // two disagree about whether a thread still has a place.
    if (tr.docChanged) return project(tr.newDoc.toString(), value.projection)
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
})

export interface AnnotationHandlers {
  /** A gutter marker was pressed; the host opens that conversation. */
  readonly onSelectThread?: (threadId: string) => void
}

/**
 * The extension a host adds to the source pane. Static — the threads travel
 * in through `setAnnotationProjection`, because the view is created once per
 * mount and a changing extension array would not reach it.
 */
export function annotationDecorations(handlers: AnnotationHandlers = {}): Extension {
  return [
    annotationField,
    gutter({
      class: 'cm-annotation-gutter',
      markers: (view) => {
        const { placed } = view.state.field(annotationField)
        if (placed.length === 0) return RangeSet.empty
        const { selectedThreadId } = view.state.field(annotationField).projection
        const perLine = new Map<number, PlacedThread[]>()
        for (const one of placed) {
          const lineStart = view.state.doc.lineAt(one.from).from
          const bucket = perLine.get(lineStart)
          if (bucket === undefined) perLine.set(lineStart, [one])
          else bucket.push(one)
        }
        const builder = new RangeSetBuilder<GutterMarker>()
        for (const lineStart of [...perLine.keys()].sort((a, b) => a - b)) {
          const bucket = perLine.get(lineStart) as PlacedThread[]
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
              lead.status,
              lead.threadId === selectedThreadId,
              bucket.length,
            ),
          )
        }
        return builder.finish()
      },
      domEventHandlers: {
        mousedown: (_view, _line, event) => {
          const target = event.target
          const threadId =
            target instanceof HTMLElement
              ? (target.closest<HTMLElement>('[data-thread-id]')?.dataset.threadId ?? null)
              : null
          if (threadId === null) return false
          handlers.onSelectThread?.(threadId)
          // Swallowed so the press does not also move the caret to this line:
          // opening a conversation is not an edit, and a reader who lands
          // back in the text loses the caret they had.
          return true
        },
      },
    }),
  ]
}
