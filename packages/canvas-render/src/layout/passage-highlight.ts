/**
 * The annotation layer's projection onto a text node's laid-out text: the
 * passage a thread is about, highlighted behind the words it quotes.
 *
 * The passage is re-found in the RENDERED text rather than mapped from its
 * stored offsets, because the offsets are into the node's markdown source
 * and the runs hold what that source rendered to (markers gone, lines
 * wrapped). A quote survives that projection the way it survives an edit —
 * it is the selector W3C Web Annotation's TextQuoteSelector exists for —
 * and `resolveTextAnchor` in the web app already trusts it over offsets.
 * A quote that spans a marker (`**plan**` selected with its stars) is not
 * found here and draws nothing; the pin at the node's corner still says
 * the conversation exists.
 *
 * Whitespace is compared loosely: wrapping trims a line's trailing space,
 * so a passage across a wrap has one space fewer in the runs than in the
 * source, and a strict search would miss exactly the passages long enough
 * to wrap.
 */
import type { CommentThread, TextQuoteSelector } from '@kamiazya/whiteboard-model'
import type { MeasureText } from '../measure.js'
import { clampAdvance } from '../measure.js'
import type { Appearance, SceneNode, ShapeSceneNode, TextRunNode } from '../scene-graph.js'
import { runFontOf } from './nodes/mdast-blocks.js'

/** A thread about a passage of a node's text, as the layout needs it. */
export interface NodePassage {
  readonly threadId: string
  readonly nodeId: string
  readonly quote: TextQuoteSelector
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
      quote: thread.anchor.quote,
      resolved: thread.status === 'resolved',
    })
  }
  return out
}

/** Every text run under `nodes`, in reading order. */
export function collectTextRuns(nodes: readonly SceneNode[]): TextRunNode[] {
  const out: TextRunNode[] = []
  const visit = (node: SceneNode): void => {
    switch (node.kind) {
      case 'textRun':
        out.push(node)
        return
      case 'paragraph':
      case 'heading':
        out.push(...node.runs)
        return
      case 'codeBlock':
        out.push(...(node.runs ?? []))
        return
      case 'list':
        for (const item of node.items) for (const child of item.children) visit(child)
        return
      case 'table':
        for (const row of node.rows) for (const cell of row.cells) out.push(...cell.runs)
        return
      case 'blockquote':
      case 'embedResolved':
      case 'group':
        for (const child of node.children) visit(child)
        return
      default:
        return
    }
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
 * The runs read as one string, with a space standing in for each wrap:
 * a run that starts a new line lost the space that preceded it in the
 * source, and the search below needs somewhere to match it.
 */
function renderedTextOf(runs: readonly TextRunNode[]): { text: string; pieces: Piece[] } {
  let text = ''
  const pieces: Piece[] = []
  let previous: TextRunNode | undefined
  for (const run of runs) {
    if (previous !== undefined && run.bbox.y !== previous.bbox.y && !/\s$/.test(text)) text += ' '
    pieces.push({ run, at: text.length })
    text += run.text
    previous = run
  }
  return { text, pieces }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `quote` as a pattern that tolerates any whitespace where it has some. */
function loosePattern(quote: string): RegExp {
  const body = quote.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
  return new RegExp(body, 'g')
}

const squash = (value: string): string => value.replace(/\s+/g, ' ')

/**
 * Where the quote sits in the rendered text, or null. Several occurrences
 * are told apart by how much of the remembered surroundings each has —
 * the same rule `resolveTextAnchor` applies to the source.
 */
export function findPassage(
  rendered: string,
  quote: TextQuoteSelector,
): { readonly start: number; readonly end: number } | null {
  if (quote.exact.trim() === '') return null
  const pattern = loosePattern(quote.exact)
  const prefix = squash(quote.prefix ?? '')
  const suffix = squash(quote.suffix ?? '')
  let best: { start: number; end: number } | null = null
  let bestScore = -1
  for (const match of rendered.matchAll(pattern)) {
    const start = match.index
    const end = start + match[0].length
    const before = squash(rendered.slice(0, start))
    const after = squash(rendered.slice(end))
    let score = 0
    while (
      score < prefix.length &&
      score < before.length &&
      before[before.length - 1 - score] === prefix[prefix.length - 1 - score]
    ) {
      score += 1
    }
    let afterScore = 0
    while (
      afterScore < suffix.length &&
      afterScore < after.length &&
      after[afterScore] === suffix[afterScore]
    ) {
      afterScore += 1
    }
    score += afterScore
    if (score > bestScore) {
      best = { start, end }
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
): readonly ShapeSceneNode['bbox'][] {
  const { text, pieces } = renderedTextOf(runs)
  const range = findPassage(text, quote)
  if (range === null) return []
  const boxes: ShapeSceneNode['bbox'][] = []
  for (const { run, at } of pieces) {
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

/**
 * The highlight shapes for every passage of one node, laid in the same
 * origin-relative space as `runs` so they travel into the node with them.
 * Painted BEFORE the runs (the caller puts them first), and marked
 * `commentChrome` so `sceneDigest` leaves them out and the editor hit-tests
 * them as the thread's own chrome — `${threadId}/passage-<n>`.
 */
export function composePassageHighlights(
  passages: readonly NodePassage[],
  runs: readonly TextRunNode[],
  measure: MeasureText,
  appearance: { readonly open?: Appearance; readonly resolved?: Appearance },
): readonly ShapeSceneNode[] {
  const out: ShapeSceneNode[] = []
  for (const passage of passages) {
    const look = passage.resolved ? appearance.resolved : appearance.open
    passageBoxes(runs, passage.quote, measure).forEach((bbox, index) => {
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
