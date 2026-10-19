/**
 * The highlights an ordinary board draws do not move when the cost of
 * drawing them is bounded. The oracle is the implementation as it stood
 * before the bound — copied verbatim below — and the boards generated here
 * hold far fewer occurrences than resolution scores, so every difference
 * would be a change of behaviour rather than the bound at work.
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import {
  resolveTextAnchor,
  sharedContext,
  type TextQuoteSelector,
} from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { Appearance, ShapeSceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
import type { MeasureText } from '../measure.js'
import { clampAdvance } from '../measure.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest } from '../test-utils/fast-check.js'
import { type LooseSpan, looseOccurrences } from './loose-occurrences.js'
import { typesetMdastBlocks } from './nodes/mdast-blocks.js'
import { runFontOf } from './nodes/mdast-layout-options.js'
import { collectTextRuns, composePassageHighlights, type NodePassage } from './passage-highlight.js'

// ---- the oracle: passage-highlight.ts before the bound, verbatim but for
// the `reach` tally, which says which branches the boards reached ----

const reach = { passages: 0, drawn: 0, numbered: 0, scored: 0 }

interface Piece {
  readonly run: TextRunNode
  readonly at: number
}

const SPACE_GAP_RATIO = 0.15

function renderedTextOf(runs: readonly TextRunNode[]): { text: string; pieces: Piece[] } {
  let text = ''
  const pieces: Piece[] = []
  let previous: TextRunNode | undefined
  for (const run of runs) {
    if (previous !== undefined && !/\s$/.test(text) && separated(previous, run)) text += ' '
    pieces.push({ run, at: text.length })
    text += run.text
    previous = run
  }
  return { text, pieces }
}

function separated(previous: TextRunNode, run: TextRunNode): boolean {
  if (run.bbox.y !== previous.bbox.y) return true
  const gap = run.bbox.x - (previous.bbox.x + previous.bbox.w)
  return gap > run.bbox.h * SPACE_GAP_RATIO
}

const WHITESPACE = /\s/

const squash = (value: string): string => value.replace(/\s+/g, ' ')

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

interface PassageSource {
  readonly text: string
  readonly start: number
  readonly end: number
}

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
  const lead = quote.exact.length - quote.exact.trimStart().length
  const starts = looseOccurrences(source.text, quote.exact).map((span) => span.start)
  return { index: starts.indexOf(placed.start + lead), count: starts.length }
}

function findPassage(
  rendered: string,
  quote: TextQuoteSelector,
  source?: PassageSource,
): LooseSpan | null {
  const matches = looseOccurrences(rendered, quote.exact)
  if (matches.length === 0) return null
  if (source !== undefined) {
    const inSource = sourceOccurrence(source, quote)
    if (inSource === 'orphaned') return null
    const same = matches[inSource.index]
    if (inSource.count === matches.length && same !== undefined) {
      reach.numbered += 1
      return same
    }
  }
  if (matches.length > 1) reach.scored += 1
  return bestScored(rendered, matches, quote)
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

function passageBoxes(
  runs: readonly TextRunNode[],
  quote: TextQuoteSelector,
  measure: MeasureText,
  source?: PassageSource,
): readonly ShapeSceneNode['bbox'][] {
  const { text, pieces } = renderedTextOf(runs)
  const range = findPassage(text, quote, source)
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

function oracleHighlights(
  passages: readonly NodePassage[],
  runs: readonly TextRunNode[],
  measure: MeasureText,
  appearance: { readonly open?: Appearance; readonly resolved?: Appearance },
  sourceText: string,
): readonly ShapeSceneNode[] {
  const out: ShapeSceneNode[] = []
  for (const passage of passages) {
    const look = passage.resolved ? appearance.resolved : appearance.open
    const { quote, start, end } = passage.anchor
    const boxes = passageBoxes(runs, quote, measure, { text: sourceText, start, end })
    reach.passages += 1
    if (boxes.length > 0) reach.drawn += 1
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

// ---- the boards ----

const measure = createFakeMeasure()

/**
 * A markdown body of a few repeated words, so quotes recur, with the inline
 * markup that splits a line into runs — and a link and a comment, whose
 * text is in the source but not, or not wholly, on the canvas, so the
 * source and rendered counts often differ.
 */
const word = fc.constantFrom('a', 'b', 'ab', 'ba', 'a b')
const piece = fc.oneof(
  word,
  word.map((w) => `*${w}*`),
  word.map((w) => `**${w}**`),
  word.map((w) => `\`${w}\``),
  word.map((w) => `[${w}](${w.replace(' ', '')})`),
  word.map((w) => `<!-- ${w} -->`),
)
const separator = fc.constantFrom(' ', ' ', '  ', '\n', '\n\n')
const body = fc
  .array(fc.tuple(piece, separator), { minLength: 1, maxLength: 40 })
  .map((parts) => parts.map(([p, s]) => p + s).join(''))

/**
 * A passage the writer selected: a stretch of words in the source, markup
 * excluded so that most of them are drawn, with the context either side.
 */
const passageOn = (source: string) => {
  const wordStarts = [...source].flatMap((char, at) => (/[ab]/.test(char) ? [at] : []))
  return fc
    .record({
      start: wordStarts.length > 0 ? fc.constantFrom(...wordStarts) : fc.constant(0),
      length: fc.integer({ min: 1, max: 5 }),
      prefix: fc.nat({ max: 12 }),
      suffix: fc.nat({ max: 12 }),
      // Offsets that still select the quote, or that moved.
      drift: fc.oneof(fc.constant(0), fc.integer({ min: -8, max: 8 })),
      resolved: fc.boolean(),
    })
    .map(({ start, length, prefix, suffix, drift, resolved }) => {
      let end = start + 1
      while (end < Math.min(source.length, start + length) && /[ab ]/.test(source[end] ?? ''))
        end += 1
      const exact = source.slice(start, end)
      const quote: TextQuoteSelector = {
        exact,
        ...(prefix > 0 ? { prefix: source.slice(Math.max(0, start - prefix), start) } : {}),
        ...(suffix > 0 ? { suffix: source.slice(end, end + suffix) } : {}),
      }
      const at = Math.max(0, start + drift)
      return { quote, start: at, end: at + exact.length, resolved }
    })
}

const board = body.chain((source) =>
  fc.record({
    source: fc.constant(source),
    maxWidth: fc.integer({ min: 30, max: 400 }),
    anchors: fc.array(passageOn(source), { minLength: 1, maxLength: 8 }),
  }),
)

describe('passage highlights on an ordinary board', () => {
  fcTest.prop([board])(
    'are the ones drawn before the cost bound',
    ({ source, maxWidth, anchors }) => {
      const runs = collectTextRuns(
        typesetMdastBlocks(parseMarkdownBody(source), {
          measure,
          maxWidth,
          fontFamily: 'sans-serif',
        }).nodes,
      )
      const passages: NodePassage[] = anchors.map((anchor, index) => ({
        threadId: `t${index}`,
        nodeId: 'n',
        anchor: { kind: 'text', quote: anchor.quote, start: anchor.start, end: anchor.end },
        resolved: anchor.resolved,
      }))
      const appearance = { open: { fill: '#ff0' }, resolved: { fill: '#888' } }
      expect(composePassageHighlights(passages, runs, measure, appearance, source)).toEqual(
        oracleHighlights(passages, runs, measure, appearance, source),
      )
    },
  )

  afterAllFloor(['are the ones drawn before the cost bound'], () => {
    // The boards draw a highlight often, and reach both ways of choosing
    // one: the same-numbered occurrence, and scoring several by context.
    // Measured over three runs: 0.88-0.98 drawn, 0.32-0.40 numbered,
    // 0.46-0.52 scored.
    expect(reach.drawn / reach.passages).toBeGreaterThan(0.6)
    expect(reach.numbered / reach.passages).toBeGreaterThan(0.2)
    expect(reach.scored / reach.passages).toBeGreaterThan(0.3)
  })
})
