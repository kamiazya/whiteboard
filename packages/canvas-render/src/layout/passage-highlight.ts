/**
 * The annotation layer's projection onto a text node's laid-out text: the
 * passage a thread is about, highlighted behind the words it quotes.
 *
 * The passage is re-found in the RENDERED text rather than mapped from its
 * stored offsets, because the offsets are into the node's markdown source
 * and the runs hold what that source rendered to (markers gone, lines
 * wrapped). A quote survives that projection the way it survives an edit —
 * it is the selector W3C Web Annotation's TextQuoteSelector exists for —
 * and `resolveTextAnchor` (model's `text-anchor.ts`) trusts it over offsets
 * the same way when it re-finds a passage in the source.
 * A quote that spans a marker (`**plan**` selected with its stars) is not
 * found here and draws nothing; the pin at the node's corner still says
 * the conversation exists.
 *
 * Whitespace is compared loosely: wrapping trims a line's trailing space,
 * so a passage across a wrap has one space fewer in the runs than in the
 * source, and a strict search would miss exactly the passages long enough
 * to wrap.
 */
import {
  type CommentThread,
  resolveTextAnchor,
  scoredOccurrenceRange,
  sharedContext,
  type TextAnchor,
  type TextQuoteSelector,
} from '@kamiazya/whiteboard-model'
import type { Appearance, SceneNode, ShapeSceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import type { MeasureText } from '../measure.js'
import { clampAdvance } from '../measure.js'
import { type SceneWalkNode, sceneChildrenOf } from '../scene-children.js'
import { type LooseSpan, looseOccurrences } from './loose-occurrences.js'
import { runFontOf } from './nodes/mdast-layout-options.js'

/** A thread about a passage of a node's text, as the layout needs it. */
export interface NodePassage {
  readonly threadId: string
  readonly nodeId: string
  readonly anchor: TextAnchor
  readonly resolved: boolean
}

/** The passages among `threads`: the text arm naming a node. */
export function nodePassagesOf(threads: readonly CommentThread[]): readonly NodePassage[] {
  const out: NodePassage[] = []
  for (const thread of threads) {
    if (thread.anchor.kind !== 'text' || thread.anchor.nodeId === undefined) continue
    out.push({
      threadId: thread.id,
      nodeId: thread.anchor.nodeId,
      anchor: thread.anchor,
      resolved: thread.status === 'resolved',
    })
  }
  return out
}

/** Every text run under `nodes`, in reading order. */
export function collectTextRuns(nodes: readonly SceneNode[]): TextRunNode[] {
  const out: TextRunNode[] = []
  const visit = (node: SceneWalkNode): void => {
    if (node.kind === 'textRun') out.push(node)
    for (const child of sceneChildrenOf(node) ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

interface Piece {
  readonly run: TextRunNode
  /** Where the run's text starts in the rendered string. */
  readonly at: number
}

/**
 * The runs read as one string, with a space standing in for each space the
 * layout dropped — because layout encodes the gap between two words as an
 * x OFFSET, not as text, and the search below needs somewhere to match it.
 *
 * Two ways a space goes missing, and both have to be put back:
 *
 * - a run that starts a NEW LINE lost the space that preceded it;
 * - a run split from its neighbour at an INLINE BOUNDARY — emphasis,
 *   strong, a link, inline code, an image — lost it the same way, on the
 *   same line.
 *
 * The second was missing, and a comment on a sentence containing a bold
 * word silently lost its highlight. Measured: `see *a diagram* here` came
 * out as three runs reading `seea diagramhere`, so the quote
 * `see\s+a\s+diagram\s+here` matched nothing, against one run and a clean
 * match for the same sentence written without the emphasis.
 *
 * A GAP is what distinguishes the two cases, not the boundary itself:
 * `**bold**face` is one word and its runs are flush, so nothing is
 * inserted — inserting there would mis-place the highlight and let a quote
 * match text the document does not contain. The threshold is a fraction of
 * the run's own height rather than an absolute: a space at 12px is not a
 * space at 48px, and the height is the only size the run carries.
 */
const SPACE_GAP_RATIO = 0.15

const WHITESPACE = /\s/

interface RenderedText {
  readonly text: string
  readonly pieces: readonly Piece[]
}

function renderedTextOf(runs: readonly TextRunNode[]): RenderedText {
  let text = ''
  const pieces: Piece[] = []
  let previous: TextRunNode | undefined
  for (const run of runs) {
    // The last character only: a regex anchored at the end still tries
    // every position of the string, which made building the text runs x
    // text.
    if (previous !== undefined && !WHITESPACE.test(text.at(-1) ?? '') && separated(previous, run)) {
      text += ' '
    }
    pieces.push({ run, at: text.length })
    text += run.text
    previous = run
  }
  return { text, pieces }
}

/** Whether the source had whitespace between two adjacent runs. */
function separated(previous: TextRunNode, run: TextRunNode): boolean {
  if (run.bbox.y !== previous.bbox.y) return true
  const gap = run.bbox.x - (previous.bbox.x + previous.bbox.w)
  return gap > run.bbox.h * SPACE_GAP_RATIO
}

const squash = (value: string): string => value.replace(/\s+/g, ' ')

/**
 * The rendered text read outward from `from` one step at a time, a run of
 * whitespace read as one space — the squashed text, produced only as far as
 * the comparison asks for it, so an occurrence never costs the whole string.
 */
function readOutward(text: string, from: number, step: 1 | -1): (k: number) => string | undefined {
  const seen: string[] = []
  let at = from
  return (k) => {
    while (seen.length <= k) {
      const char = text[at]
      if (char === undefined) return undefined
      if (WHITESPACE.test(char)) {
        seen.push(' ')
        do at += step
        while (text[at] !== undefined && WHITESPACE.test(text[at] as string))
      } else {
        seen.push(char)
        at += step
      }
    }
    return seen[k]
  }
}

/** The node's markdown source and the anchor's stored offsets into it. */
export interface PassageSource {
  readonly text: string
  readonly start: number
  readonly end: number
}

/**
 * Which of the quote's occurrences in the SOURCE the model resolves the
 * anchor to, and how many there are — or `orphaned` when the source no
 * longer holds the quote at all.
 *
 * Asked of the source because that is where the anchor's evidence lives:
 * its stored offsets index the source, and `resolveTextAnchor` keeps them
 * whenever they still select the quote, which is what keeps the occurrence
 * the writer chose when several share the same surroundings. The rendered
 * text cannot answer that question, only count.
 */
function sourceOccurrence(
  source: PassageSource,
  quote: TextQuoteSelector,
): { readonly index: number; readonly count: number } | 'orphaned' {
  const placed = resolveTextAnchor(source.text, {
    kind: 'text',
    quote,
    start: source.start,
    end: source.end,
  })
  if (placed.kind === 'orphaned') return 'orphaned'
  // A loose occurrence starts at the quote's first non-blank character.
  const lead = quote.exact.length - quote.exact.trimStart().length
  const starts = looseOccurrences(source.text, quote.exact).map((span) => span.start)
  return { index: starts.indexOf(placed.start + lead), count: starts.length }
}

/**
 * Where the quote sits in the rendered text, or null.
 *
 * With the source, the passage is the SAME-NUMBERED occurrence as the one
 * `resolveTextAnchor` places in it, so the canvas highlights the words the
 * editor's thread is about. That holds while rendering keeps every
 * occurrence; when it does not (one inside an HTML comment, say), the counts
 * differ and the numbering means nothing.
 *
 * Then, and without a source, occurrences are told apart by `sharedContext`
 * — the comparison the resolver scores with: the nearest characters of the
 * remembered prefix and suffix, at most the context window of each. What
 * differs is what it reads — rendered text, whitespace-loose on both sides —
 * and the tie-break: the resolver prefers the occurrence nearest the stored
 * offsets, which index the source and not these runs, so a tie here goes to
 * the first occurrence.
 */
function findPassage(
  rendered: string,
  quote: TextQuoteSelector,
  source?: PassageSource,
): LooseSpan | null {
  const matches = looseOccurrences(rendered, quote.exact)
  if (matches.length === 0) return null
  let around = 0
  if (source !== undefined) {
    const inSource = sourceOccurrence(source, quote)
    if (inSource === 'orphaned') return null
    const same = matches[inSource.index]
    if (inSource.count === matches.length && same !== undefined) return same
    const scaled = Math.round((Math.max(0, inSource.index) * matches.length) / inSource.count)
    around = matches[Math.min(matches.length - 1, scaled)]?.start ?? 0
  }
  return bestScored(rendered, nearestScored(matches, around), quote)
}

/**
 * The rendered occurrences worth scoring: at most the number the model's
 * resolver scores, nearest where the anchor sits — so a quote that occurs
 * everywhere costs a bounded comparison per passage, as it does there.
 *
 * Where it sits is mapped by occurrence NUMBER, the source's scaled to the
 * rendered count: the stored offsets index the source and not these runs,
 * and the number is the part of them that survives rendering. Without a
 * source the first occurrences are kept, where the tie-break looks first.
 * A quote with at most that many occurrences is scored exactly as before.
 */
function nearestScored(matches: readonly LooseSpan[], around: number): readonly LooseSpan[] {
  const { from, to } = scoredOccurrenceRange(
    matches.map((span) => span.start),
    around,
  )
  return from === 0 && to === matches.length ? matches : matches.slice(from, to)
}

function bestScored(
  rendered: string,
  matches: readonly LooseSpan[],
  quote: TextQuoteSelector,
): LooseSpan | null {
  const prefix = squash(quote.prefix ?? '')
  const suffix = squash(quote.suffix ?? '')
  let best: LooseSpan | null = null
  let bestScore = -1
  for (const match of matches) {
    const score =
      sharedContext(prefix, 'before', readOutward(rendered, match.start - 1, -1)) +
      sharedContext(suffix, 'after', readOutward(rendered, match.end, 1))
    if (score > bestScore) {
      best = match
      bestScore = score
    }
  }
  return best
}

/**
 * The boxes behind the words of one passage, one per run it crosses. The
 * horizontal extent inside a run is measured the way the run itself was —
 * same family, size, weight and slant — so the box sits under the glyphs
 * and not under where a different font would have put them.
 */
export function passageBoxes(
  runs: readonly TextRunNode[],
  quote: TextQuoteSelector,
  measure: MeasureText,
  source?: PassageSource,
  // Built once per node by a caller drawing several passages over `runs`.
  { text, pieces }: RenderedText = renderedTextOf(runs),
): readonly ShapeSceneNode['bbox'][] {
  const range = findPassage(text, quote, source)
  if (range === null) return []
  const boxes: ShapeSceneNode['bbox'][] = []
  // From the last piece starting at or before the passage, so a passage
  // visits only the runs it may cross rather than every run of the node.
  for (let index = lastPieceAtOrBefore(pieces, range.start); index < pieces.length; index += 1) {
    const { run, at } = pieces[index] as Piece
    if (at >= range.end) break
    const runEnd = at + run.text.length
    const from = Math.max(range.start, at) - at
    const to = Math.min(range.end, runEnd) - at
    if (to <= from) continue
    const font = runFontOf(run)
    if (font === undefined) continue
    const lead = clampAdvance(measure(run.text.slice(0, from), font).advanceWidth)
    const width = clampAdvance(measure(run.text.slice(from, to), font).advanceWidth)
    if (width <= 0) continue
    boxes.push({ x: run.bbox.x + lead, y: run.bbox.y, w: width, h: run.bbox.h })
  }
  return boxes
}

function lastPieceAtOrBefore(pieces: readonly Piece[], offset: number): number {
  let low = 0
  let high = pieces.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((pieces[mid] as Piece).at <= offset) low = mid + 1
    else high = mid
  }
  return Math.max(0, low - 1)
}

/**
 * The highlight shapes for every passage of one node, laid in the same
 * origin-relative space as `runs` so they travel into the node with them.
 * Painted BEFORE the runs (the caller puts them first), and marked
 * `commentChrome` so `sceneDigest` leaves them out and the editor hit-tests
 * them as the thread's own chrome — `${threadId}/passage-<n>`.
 * `sourceText` is the node's markdown source, the text the anchors' stored
 * offsets index.
 */
export function composePassageHighlights(
  passages: readonly NodePassage[],
  runs: readonly TextRunNode[],
  measure: MeasureText,
  appearance: { readonly open?: Appearance; readonly resolved?: Appearance },
  sourceText: string,
): readonly ShapeSceneNode[] {
  const out: ShapeSceneNode[] = []
  const rendered = renderedTextOf(runs)
  for (const passage of passages) {
    const look = passage.resolved ? appearance.resolved : appearance.open
    const { quote, start, end } = passage.anchor
    const boxes = passageBoxes(runs, quote, measure, { text: sourceText, start, end }, rendered)
    boxes.forEach((bbox, index) => {
      out.push({
        kind: 'shape',
        id: `${passage.threadId}/passage-${index}`,
        commentChrome: true,
        bbox,
        radius: 2,
        ...(look === undefined ? {} : { appearance: look }),
      })
    })
  }
  return out
}
