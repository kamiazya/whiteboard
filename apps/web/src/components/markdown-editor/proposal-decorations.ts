/**
 * The proposal layer's in-place projection on a markdown body (ADR-0029
 * decision 1, for prose): the passage a change would replace, drawn over the
 * words it means, with a reachable affordance in the gutter beside it.
 *
 * The canvas draws a proposal as chrome on a bubble the renderer placed.
 * Prose has no bubble, so this is the other half of decision 1 — and it is
 * shaped like the annotation layer's projection deliberately, because a
 * reader looking at a body should not have to learn two ways of being shown
 * "something is about these words".
 *
 * **The gutter is the click target, not the highlight**, for the reason
 * `annotation-decorations` gives: the passage is ordinary editable text, so a
 * click on it has to keep meaning "put the caret here". A proposed passage is
 * text the reader may well want to edit BEFORE deciding, which makes the rule
 * stronger here rather than weaker.
 *
 * Placement goes through `resolveTextAnchor`, the same function the
 * annotation projection and the adopt write path both read. One answer, so
 * what is highlighted and what adoption rewrites cannot disagree.
 */

import {
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view'
import type { Proposal } from '@kamiazya/whiteboard-model'
import { resolveTextAnchor } from '@kamiazya/whiteboard-model'

/** Where one open proposed passage sits in the body as it stands right now. */
export interface PlacedPassage {
  readonly proposalId: string
  readonly changeId: string
  readonly from: number
  readonly to: number
  /** What the change would put there. */
  readonly text: string
  /**
   * Whether the passage still reads what the change assumed.
   *
   * Decision 5: a proposal FOLLOWS the document, so this is not a reason to
   * hide it — the person is the one who decides. It is a reason to say so
   * where they can see it, since adopting would replace words the agent
   * never read.
   */
  readonly conflicted: boolean
}

/**
 * Every open passage change that still finds its place, in document order.
 *
 * Ordered because a `RangeSet` is built from it directly and CodeMirror
 * requires sorted input; sorting here rather than at the call site keeps the
 * two consumers (marks and gutter markers) from each having to remember.
 *
 * A DECIDED change is not drawn: the person answered it, and re-offering the
 * question is the one thing a decision has to stop. A canvas change is not
 * drawn either — its subject is a surface this document has not got, which is
 * what `placeThreads` says about a spatial anchor.
 */
export function placePassages(
  body: string,
  proposals: readonly Proposal[],
): readonly PlacedPassage[] {
  const placed: PlacedPassage[] = []
  for (const proposal of proposals) {
    for (const change of proposal.changes) {
      if (change.op !== 'body.replace' || change.status !== 'open') continue
      const resolved = resolveTextAnchor(body, change.anchor)
      if (resolved.kind !== 'placed') continue
      placed.push({
        proposalId: proposal.id,
        changeId: change.id,
        from: resolved.start,
        to: resolved.end,
        text: change.text,
        conflicted: body.slice(resolved.start, resolved.end) !== change.assumed,
      })
    }
  }
  return placed.sort((a, b) => a.from - b.from || a.to - b.to)
}

/**
 * What the pane should draw. One effect rather than two, for the reason the
 * annotation projection gives: a passage list and the selection naming one of
 * its entries applied a frame apart would light up nothing and read as the
 * press being ignored.
 */
export interface ProposalProjection {
  readonly proposals: readonly Proposal[]
  readonly selectedChangeId: string | null
}

export const setProposalProjection = StateEffect.define<ProposalProjection>()

const EMPTY_PROJECTION: ProposalProjection = { proposals: [], selectedChangeId: null }

interface ProposalState {
  readonly projection: ProposalProjection
  readonly placed: readonly PlacedPassage[]
  readonly marks: DecorationSet
}

function project(doc: string, projection: ProposalProjection): ProposalState {
  const placed = placePassages(doc, projection.proposals)
  const marks = new RangeSetBuilder<Decoration>()
  // No empty-range branch, for `annotation-decorations`' reason: CodeMirror
  // throws on an empty mark, and `textQuoteSelectorSchema`'s `exact` carries
  // a `min(1)`, so a placed range is always at least one character wide.
  for (const one of placed) {
    const selected = one.changeId === projection.selectedChangeId
    marks.add(
      one.from,
      one.to,
      Decoration.mark({
        class: [
          'cm-proposal',
          one.conflicted ? 'cm-proposal-conflicted' : '',
          selected ? 'cm-proposal-selected' : '',
        ]
          .filter(Boolean)
          .join(' '),
        attributes: { 'data-change-id': one.changeId },
      }),
    )
  }
  return { projection, placed, marks: marks.finish() }
}

const proposalField = StateField.define<ProposalState>({
  create: (state) => project(state.doc.toString(), EMPTY_PROJECTION),
  update(value, tr) {
    // `tr.newDoc`, never `tr.state.doc` — a state field's update runs while
    // the new state is being built.
    for (const effect of tr.effects) {
      if (effect.is(setProposalProjection)) return project(tr.newDoc.toString(), effect.value)
    }
    // Re-resolve rather than map through the change set: the adopt write path
    // reads the same resolver, and a mapped range would let the two disagree
    // about where a passage is — including about whether it still exists.
    if (tr.docChanged) return project(tr.newDoc.toString(), value.projection)
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
})

/** Where the press landed, so the host can put its card beside the words. */
export interface PassagePressPoint {
  readonly clientX: number
  readonly clientY: number
}

export interface ProposalHandlers {
  /** A gutter marker was pressed; the host opens that passage's card. */
  readonly onSelectPassage?: (proposalId: string, changeId: string, at: PassagePressPoint) => void
}

/** What the marker beside a line says out loud. */
function gutterLabel(passages: number, conflicted: boolean): string {
  const subject = passages > 1 ? `${passages} proposed changes on this line` : 'A proposed change'
  return conflicted ? `${subject}, on words that have since changed` : subject
}

class PassageGutterMarker extends GutterMarker {
  constructor(
    private readonly proposalId: string,
    private readonly changeId: string,
    private readonly selected: boolean,
    private readonly passages: number,
    private readonly conflicted: boolean,
  ) {
    super()
  }

  override eq(other: PassageGutterMarker): boolean {
    return (
      other.changeId === this.changeId &&
      other.selected === this.selected &&
      other.passages === this.passages &&
      other.conflicted === this.conflicted
    )
  }

  override toDOM(): Node {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-proposal-gutter-marker'
    button.dataset.proposalId = this.proposalId
    button.dataset.changeId = this.changeId
    if (this.selected) button.dataset.selected = 'true'
    if (this.conflicted) button.dataset.conflicted = 'true'
    if (this.passages > 1) button.dataset.passages = String(this.passages)
    button.setAttribute('aria-label', gutterLabel(this.passages, this.conflicted))
    button.title = gutterLabel(this.passages, this.conflicted)
    const glyph = document.createElement('span')
    glyph.className = 'cm-proposal-gutter-glyph'
    glyph.setAttribute('aria-hidden', 'true')
    button.append(glyph)
    return button
  }
}

/**
 * The extension a host adds to the source pane. Static — the proposals travel
 * in through `setProposalProjection`, because the view is created once per
 * mount and a changing extension array would not reach it.
 */
function markerOf(event: Event): HTMLElement | undefined {
  return (
    (event.target as HTMLElement | null)?.closest<HTMLElement>('.cm-proposal-gutter-marker') ??
    undefined
  )
}

export function proposalDecorations(handlers: ProposalHandlers = {}): Extension {
  return [
    proposalField,
    gutter({
      class: 'cm-proposal-gutter',
      markers: (view) => {
        const { placed } = view.state.field(proposalField)
        if (placed.length === 0) return RangeSet.empty
        const { selectedChangeId } = view.state.field(proposalField).projection
        const perLine = new Map<number, PlacedPassage[]>()
        for (const one of placed) {
          const lineStart = view.state.doc.lineAt(one.from).from
          const forLine = perLine.get(lineStart)
          if (forLine === undefined) perLine.set(lineStart, [one])
          else forLine.push(one)
        }
        const builder = new RangeSetBuilder<GutterMarker>()
        for (const [lineStart, forLine] of [...perLine.entries()].sort((a, b) => a[0] - b[0])) {
          // The line's marker names the FIRST passage on it, which is the one
          // a reader reaching for the gutter is looking at. A second on the
          // same line keeps its own highlight and is reachable through the
          // card the first one opens.
          const first = forLine[0] as PlacedPassage
          builder.add(
            lineStart,
            lineStart,
            new PassageGutterMarker(
              first.proposalId,
              first.changeId,
              forLine.some((one) => one.changeId === selectedChangeId),
              forLine.length,
              forLine.some((one) => one.conflicted),
            ),
          )
        }
        return builder.finish()
      },
      domEventHandlers: {
        // The two halves are deliberately split. `mousedown` only holds the
        // caret back; the ACTIVATION is on `click`, which is the event a
        // native button answers to however it was reached — pointer, Enter,
        // or Space. Handling it on `mousedown` alone made a tab-focusable
        // button that no keyboard could press.
        mousedown: (_view, _line, event) => {
          if (markerOf(event) === undefined) return false
          // Before the default, which would move the caret into the line and
          // take focus off the card that is about to open. It does not stop
          // the `click` that follows.
          event.preventDefault()
          return true
        },
        click: (_view, _line, event) => {
          const button = markerOf(event)
          if (button === undefined) return false
          const { proposalId, changeId } = button.dataset
          if (proposalId === undefined || changeId === undefined) return false
          const rect = button.getBoundingClientRect()
          // The MARKER's box, not the pointer: a card anchored to where the
          // finger happened to land drifts by up to the target's size, and
          // this target is deliberately large enough for a thumb. It is also
          // the only anchor a keyboard press has.
          handlers.onSelectPassage?.(proposalId, changeId, {
            clientX: rect.right,
            clientY: rect.top,
          })
          return true
        },
      },
    }),
  ]
}
