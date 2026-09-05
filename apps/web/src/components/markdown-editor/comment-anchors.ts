/**
 * The markdown editor's in-place projection of the annotation layer
 * (ADR-0026 decision 5): an inline highlight over each thread's passage and
 * a gutter marker on the line it starts on. The document-level panel lists
 * the conversations; this is where a reader finds one while reading.
 *
 * A CodeMirror extension rather than DOM laid over the pane, because the
 * passage MOVES: every keystroke above it shifts its offsets, and CodeMirror
 * maps a position through a change set for exactly this. Resolution
 * (`resolveTextAnchor`, quote first) runs when the host hands over the
 * threads; between hand-overs the ranges ride the document's own changes,
 * which is exact for local and remote edits alike since a CRDT binding
 * dispatches remote edits as changes too.
 *
 * An orphaned thread (its passage gone, ADR-0026 decision 4) draws nothing
 * here — there is no place in the column to draw it — and stays reachable
 * from the panel, which is the surface that exists for it.
 */
import {
  type EditorState,
  type Extension,
  Facet,
  type RangeSet,
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
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { resolveTextAnchor } from '../../lib/text-anchor.js'

export interface CommentAnchorRange {
  readonly threadId: string
  readonly from: number
  readonly to: number
  readonly status: CommentThread['status']
}

/** The host hands over the document's threads; each text anchor is resolved against the current body. */
export const setCommentThreads = StateEffect.define<readonly CommentThread[]>()
/** The conversation the reader has open, drawn stronger than the rest. Null clears it. */
export const setSelectedCommentThread = StateEffect.define<string | null>()

/**
 * What a press on a gutter marker calls, with the thread it marks. A facet
 * so the host installs it once with the extension and the marker never
 * closes over a stale callback.
 */
export const commentMarkerSelect = Facet.define<(threadId: string) => void>()

function resolveAll(body: string, threads: readonly CommentThread[]): CommentAnchorRange[] {
  const out: CommentAnchorRange[] = []
  for (const thread of threads) {
    if (thread.anchor.kind !== 'text') continue
    const resolved = resolveTextAnchor(body, thread.anchor)
    if (resolved.kind !== 'placed') continue
    out.push({ threadId: thread.id, from: resolved.start, to: resolved.end, status: thread.status })
  }
  // Decorations and gutter markers are built into RangeSets, which want
  // their ranges sorted by start.
  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

interface AnchorsState {
  readonly ranges: readonly CommentAnchorRange[]
  readonly selected: string | null
}

const commentAnchorsField = StateField.define<AnchorsState>({
  create: () => ({ ranges: [], selected: null }),
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      // Inward bias at both ends, like the link picker's pin: text typed at
      // either boundary stays outside the passage it was typed beside. A
      // range that collapses to nothing has lost its passage to a
      // deletion and is dropped until the next hand-over re-resolves it
      // (the quote may still find it elsewhere).
      const ranges = value.ranges.flatMap((range) => {
        const from = tr.changes.mapPos(range.from, 1)
        const to = tr.changes.mapPos(range.to, -1)
        return to > from ? [{ ...range, from, to }] : []
      })
      next = { ...next, ranges }
    }
    for (const effect of tr.effects) {
      if (effect.is(setCommentThreads)) {
        next = { ...next, ranges: resolveAll(tr.state.doc.toString(), effect.value) }
      } else if (effect.is(setSelectedCommentThread)) {
        next = { ...next, selected: effect.value }
      }
    }
    return next
  },
})

/** The resolved ranges, for a host or a test that wants to read them back. */
export function commentAnchorRanges(state: EditorState): readonly CommentAnchorRange[] {
  return state.field(commentAnchorsField).ranges
}

const OPEN_MARK = Decoration.mark({ class: 'cm-comment-anchor' })
const RESOLVED_MARK = Decoration.mark({ class: 'cm-comment-anchor cm-comment-anchor-resolved' })
const SELECTED_MARK = Decoration.mark({ class: 'cm-comment-anchor cm-comment-anchor-selected' })

function decorationsOf({ ranges, selected }: AnchorsState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of ranges) {
    const mark =
      range.threadId === selected
        ? SELECTED_MARK
        : range.status === 'resolved'
          ? RESOLVED_MARK
          : OPEN_MARK
    builder.add(range.from, range.to, mark)
  }
  return builder.finish()
}

class CommentMarker extends GutterMarker {
  constructor(
    readonly threadIds: readonly string[],
    readonly selected: boolean,
  ) {
    super()
  }
  override eq(other: CommentMarker): boolean {
    return (
      this.selected === other.selected &&
      this.threadIds.length === other.threadIds.length &&
      this.threadIds.every((id, i) => id === other.threadIds[i])
    )
  }
  override toDOM(): Node {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `cm-comment-marker${this.selected ? ' cm-comment-marker-selected' : ''}`
    button.dataset.testid = 'comment-gutter-marker'
    // CodeMirror marks its gutters aria-hidden, so this is a pointer
    // shortcut by construction: the accessible path to the same
    // conversation is the document-level panel, which lists every thread.
    // Out of the tab order for the same reason — a stop nothing announces.
    button.tabIndex = -1
    button.dataset.threadId = this.threadIds[0] ?? ''
    const count = this.threadIds.length
    button.setAttribute('aria-label', count === 1 ? 'Open comment' : `Open comments (${count})`)
    button.title = button.getAttribute('aria-label') ?? ''
    // lucide's message-square, drawn inline: the gutter is CodeMirror's DOM,
    // not React's, and one glyph does not earn a renderer.
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    return button
  }
}

/** One marker per line that starts a passage; a line starting several carries a count. */
function markersOf(view: EditorView): RangeSet<GutterMarker> {
  const { ranges, selected } = view.state.field(commentAnchorsField)
  const byLine = new Map<number, string[]>()
  for (const range of ranges) {
    const line = view.state.doc.lineAt(range.from)
    const ids = byLine.get(line.from) ?? []
    ids.push(range.threadId)
    byLine.set(line.from, ids)
  }
  const builder = new RangeSetBuilder<GutterMarker>()
  for (const [pos, ids] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    builder.add(pos, pos, new CommentMarker(ids, selected !== null && ids.includes(selected)))
  }
  return builder.finish()
}

/** Whether `pos` is drawn inside the scroller's visible strip. */
function onScreen(view: EditorView, pos: number): boolean {
  // An environment with no layout (jsdom) cannot measure and so cannot
  // scroll; answering "on screen" keeps it from trying.
  if (typeof Range.prototype.getClientRects !== 'function') return true
  const coords = view.coordsAtPos(pos)
  if (coords === null) return false
  const scroller = view.scrollDOM.getBoundingClientRect()
  return coords.top >= scroller.top && coords.bottom <= scroller.bottom
}

/**
 * Selecting a conversation from the panel brings its passage on screen —
 * centred, for the reason the rail's seek centres: a press on a conversation
 * says "show me here". A passage already in view stays where it is, so
 * selecting from the gutter marker beside it does not jump the text under
 * the reader's eye. Deferred to a microtask because an update handler may
 * neither read the view's layout nor dispatch into it.
 */
const revealOnSelect = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate): void {
      const before = update.startState.field(commentAnchorsField).selected
      const { selected, ranges } = update.state.field(commentAnchorsField)
      if (selected === null || selected === before) return
      const range = ranges.find((r) => r.threadId === selected)
      if (range === undefined) return
      const { view } = this
      // Layout may not be read during an update either, so the visibility
      // check waits with the dispatch.
      queueMicrotask(() => {
        if (onScreen(view, range.from)) return
        view.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) })
      })
    }
  },
)

export function commentAnchors(onSelect?: (threadId: string) => void): Extension {
  return [
    commentAnchorsField,
    revealOnSelect,
    ...(onSelect === undefined ? [] : [commentMarkerSelect.of(onSelect)]),
    EditorView.decorations.from(commentAnchorsField, decorationsOf),
    gutter({
      class: 'cm-comment-gutter',
      markers: markersOf,
      // The gutter is a StateField projection: CodeMirror re-asks `markers`
      // when the field or the doc changes, which `updateSpacer` and the
      // default `lineMarkerChange` already cover.
      domEventHandlers: {
        mousedown(view, line) {
          const { ranges } = view.state.field(commentAnchorsField)
          const hit = ranges.find((range) => view.state.doc.lineAt(range.from).from === line.from)
          if (hit === undefined) return false
          for (const select of view.state.facet(commentMarkerSelect)) select(hit.threadId)
          return true
        },
      },
    }),
    EditorView.theme({
      '.cm-comment-gutter': { width: '22px', minWidth: '22px' },
      '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
    }),
  ]
}
