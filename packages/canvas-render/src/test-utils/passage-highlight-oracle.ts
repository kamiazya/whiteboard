import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import {
  resolveTextAnchor,
  scoredOccurrenceRange,
  type TextQuoteSelector,
  textOccurrences,
} from '@kamiazya/whiteboard-model'
import { looseOccurrences } from '../layout/loose-occurrences.js'
import { typesetMdastBlocks } from '../layout/nodes/mdast-blocks.js'
import {
  collectTextRuns,
  composePassageHighlights,
  type NodePassage,
  type PlacedRun,
} from '../layout/passage-highlight.js'
import type { FontDescriptor, MeasureText, TextMetrics } from '../measure.js'
import { createFakeMeasure } from './fake-measure.js'
import { f64Hex } from './render-oracle/scene-dump.js'

/**
 * The recorded answers of the passage highlights (`layout/passage-highlight.ts`)
 * and what they search with: the model's `textOccurrences`,
 * `scoredOccurrenceRange` and `resolveTextAnchor`, and `looseOccurrences`.
 * Inputs are drawn by a linear congruential generator over small alphabets, so
 * quotes recur, overlap and tie; the highlight boards are markdown bodies of a
 * few repeated words with the inline markup that splits a line into runs, a
 * link and an HTML comment (in the source, not on the canvas, so the counts
 * differ), plus hand-built runs for the gaps, heights and fonts layout never
 * produces. Every double is the hex of its bits.
 */

type Measured = 'fake' | 'odd'

interface RunWire {
  readonly text: string
  readonly bbox: readonly string[]
  readonly emphasis: boolean
  readonly strong: boolean
  /** The family and size the run's paint carries, null when it has no paint. */
  readonly paint: { readonly family?: string; readonly size?: string } | null
  /** What enclosing list items and table cells shift it by, when anything. */
  readonly offsetX?: string
}

interface PassageWire {
  readonly threadId: string
  readonly quote: TextQuoteSelector
  readonly start: number
  readonly end: number
  readonly resolved: boolean
}

export type PassageHighlightRecord =
  | {
      readonly kind: 'occurrences'
      readonly haystack: string
      readonly needle: string
      readonly answer: readonly number[]
    }
  | {
      readonly kind: 'scored'
      readonly sorted: readonly number[]
      readonly around: number
      readonly max: number
      readonly answer: readonly [number, number]
    }
  | {
      readonly kind: 'resolve'
      readonly body: string
      readonly quote: TextQuoteSelector
      readonly start: number
      readonly end: number
      readonly answer: readonly [number, number] | null
    }
  | {
      readonly kind: 'loose'
      readonly text: string
      readonly quote: string
      readonly answer: readonly (readonly [number, number])[]
    }
  | {
      readonly kind: 'highlights'
      readonly runs: readonly RunWire[]
      readonly passages: readonly PassageWire[]
      readonly source: string
      readonly measure: Measured
      readonly answer: {
        /** Id, box, and which paint it took. */
        readonly shapes: readonly (readonly [string, readonly string[], string | null])[]
        /** What was measured: text, family, size, weight and slant. */
        readonly calls: readonly (readonly [string, string, string, number, string])[]
      }
    }

/** A linear congruential generator: the same sequence on every run. */
function lcg(seed: number) {
  let state = seed >>> 0
  return (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % n
  }
}

type Draw = ReturnType<typeof lcg>

const pick = <T>(draw: Draw, from: readonly T[]): T => from[draw(from.length)] as T

const stringOf = (draw: Draw, alphabet: readonly string[], max: number): string =>
  Array.from({ length: draw(max + 1) }, () => pick(draw, alphabet)).join('')

function occurrences(): PassageHighlightRecord[] {
  const draw = lcg(11)
  const cases: [string, string][] = [
    ['aaa', 'aa'],
    ['abababab', 'abab'],
    ['aabaabaaab', 'aab'],
    ['abcabd', 'abd'],
    ['', 'a'],
    ['a', 'ab'],
    ['\u{1F600}a\u{1F600}', '\u{1F600}'],
    ['a'.repeat(600), 'a'.repeat(300)],
    [`${'ab'.repeat(200)}c`, `${'ab'.repeat(140)}c`],
  ]
  for (let i = 0; i < 120; i += 1) {
    const haystack = stringOf(draw, ['a', 'b', 'c'], 30)
    const needle = stringOf(draw, ['a', 'b'], 5) || 'a'
    cases.push([haystack, needle])
  }
  return cases.map(([haystack, needle]) => ({
    kind: 'occurrences',
    haystack,
    needle,
    answer: textOccurrences(haystack, needle),
  }))
}

function scored(): PassageHighlightRecord[] {
  const draw = lcg(23)
  const out: PassageHighlightRecord[] = []
  for (let i = 0; i < 200; i += 1) {
    const sorted = [...new Set(Array.from({ length: draw(13) }, () => draw(40)))].sort(
      (a, b) => a - b,
    )
    const around = draw(46)
    const max = 1 + draw(6)
    const { from, to } = scoredOccurrenceRange(sorted, around, max)
    out.push({ kind: 'scored', sorted, around, max, answer: [from, to] })
  }
  return out
}

/** A body of a few letters, spaces and an astral character, so quotes recur. */
const BODY_ALPHABET = ['a', 'b', 'a', 'b', ' ', 'c', '\u{1F600}']

/** `String.prototype.toWellFormed`, which this package's `lib` does not declare. */
const wellFormed = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')

function quoteOn(draw: Draw, body: string): TextQuoteSelector & { start: number } {
  const start = draw(body.length + 1)
  // A slice may cut the astral character in two; the port reads well-formed
  // text only, so a cut half is replaced, as a quote never stores one.
  const exact = wellFormed(body.slice(start, start + 1 + draw(4))) || pick(draw, ['a', 'ab', 'zz'])
  const prefixLength = pick(draw, [0, 0, 1, 3, 8, 34, 40])
  const suffixLength = pick(draw, [0, 0, 1, 3, 8, 34, 40])
  const noise = draw(4) === 0
  const prefix = wellFormed(body.slice(Math.max(0, start - prefixLength), start))
  const suffix = wellFormed(body.slice(start + exact.length, start + exact.length + suffixLength))
  return {
    exact,
    ...(prefixLength > 0 ? { prefix: noise ? `x${prefix}` : prefix } : {}),
    ...(suffixLength > 0
      ? { suffix: noise ? wellFormed(`${suffix.slice(0, 2)}x${suffix}`) : suffix }
      : {}),
    start,
  }
}

function resolves(): PassageHighlightRecord[] {
  const draw = lcg(37)
  const out: PassageHighlightRecord[] = []
  for (let i = 0; i < 400; i += 1) {
    const body = stringOf(draw, BODY_ALPHABET, i % 4 === 0 ? 90 : 30)
    const { start: at, ...quote } = quoteOn(draw, body)
    const start = Math.max(0, at + pick(draw, [0, 0, 0, -3, 2, 7, 60]))
    const end = start + quote.exact.length + pick(draw, [0, 0, 0, 0, 1, -1])
    const placed = resolveTextAnchor(body, {
      kind: 'text',
      quote,
      start,
      end: Math.max(start, end),
    })
    out.push({
      kind: 'resolve',
      body,
      quote,
      start,
      end: Math.max(start, end),
      answer: placed.kind === 'placed' ? [placed.start, placed.end] : null,
    })
  }
  return out
}

function looses(): PassageHighlightRecord[] {
  const draw = lcg(41)
  const spaces = [' ', ' ', '\n', '\t', '　', ' ']
  const cases: [string, string][] = [
    ['a  b', ' a b '],
    ['a b', '   '],
    ['', 'a'],
    ['aaa', 'aa'],
    ['a \n b a b', 'a\tb'],
    ['ab', 'abc'],
  ]
  for (let i = 0; i < 200; i += 1) {
    const text = stringOf(draw, ['a', 'b', ...spaces], 24)
    const quote = stringOf(draw, ['a', 'b', ...spaces], 6)
    cases.push([text, quote])
  }
  return cases.map(([text, quote]) => ({
    kind: 'loose',
    text,
    quote,
    answer: looseOccurrences(text, quote).map(({ start, end }) => [start, end] as const),
  }))
}

/** Words that recur, and the markup that splits them into runs. */
const WORDS = ['a', 'b', 'ab', 'ba', 'a b']

function bodyOf(draw: Draw): string {
  const wrap: ((w: string) => string)[] = [
    (w) => w,
    (w) => w,
    (w) => `*${w}*`,
    (w) => `**${w}**`,
    (w) => `\`${w}\``,
    (w) => `[${w}](${w.replace(' ', '')})`,
    (w) => `<!-- ${w} -->`,
  ]
  const separators = [' ', ' ', '  ', '\n', '\n\n']
  return Array.from(
    { length: 1 + draw(30) },
    () => pick(draw, wrap)(pick(draw, WORDS)) + pick(draw, separators),
  ).join('')
}

/** A passage a writer selected in `source`: words, the context either side, offsets kept or moved. */
function passageOn(draw: Draw, source: string, index: number): PassageWire {
  const starts = [...source].flatMap((char, at) => (/[ab]/.test(char) ? [at] : []))
  const start = starts.length > 0 ? pick(draw, starts) : 0
  let end = start + 1
  const length = 1 + draw(5)
  while (end < Math.min(source.length, start + length) && /[ab ]/.test(source[end] ?? '')) end += 1
  const exact = source.slice(start, end) || 'a'
  const prefix = draw(13)
  const suffix = draw(13)
  const at = Math.max(0, start + pick(draw, [0, 0, -8, -2, 3, 8]))
  return {
    threadId: `t${index}`,
    quote: {
      exact,
      ...(prefix > 0 ? { prefix: source.slice(Math.max(0, start - prefix), start) } : {}),
      ...(suffix > 0 ? { suffix: source.slice(end, end + suffix) } : {}),
    },
    start: at,
    end: at + exact.length,
    resolved: draw(3) === 0,
  }
}

const fake = createFakeMeasure()

/** What the odd measurer answers: NaN for a `b`, a negative for a `z`. */
function oddAdvance(text: string): number {
  if (text.includes('b')) return Number.NaN
  const advance = text.length * 7
  return text.includes('z') ? advance - 1000 : advance
}

/** A measurer answering what layout must clamp. */
const odd: MeasureText = (text, font) => ({ ...fake(text, font), advanceWidth: oddAdvance(text) })

const PAINT = { open: { fill: '#ff0' }, resolved: { fill: '#888' } }

/** Which paint a shape took, by identity. */
function paintOf(appearance: unknown): 'open' | 'resolved' | null {
  if (appearance === PAINT.open) return 'open'
  if (appearance === PAINT.resolved) return 'resolved'
  return null
}

const runWire = ({ run, offsetX }: PlacedRun): RunWire => {
  const family = run.appearance?.fontFamily
  const size = run.appearance?.fontSize
  return {
    text: run.text,
    bbox: [run.bbox.x, run.bbox.y, run.bbox.w, run.bbox.h].map(f64Hex),
    emphasis: run.emphasis === true,
    strong: run.strong === true,
    paint:
      run.appearance === undefined
        ? null
        : {
            ...(family === undefined ? {} : { family }),
            ...(size === undefined ? {} : { size: f64Hex(size) }),
          },
    ...(offsetX === 0 ? {} : { offsetX: f64Hex(offsetX) }),
  }
}

function highlight(
  runs: readonly PlacedRun[],
  passages: readonly PassageWire[],
  source: string,
  measured: Measured,
): PassageHighlightRecord {
  const calls: [string, string, string, number, string][] = []
  const base = measured === 'fake' ? fake : odd
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    calls.push([text, font.family, f64Hex(font.sizePx), font.weight ?? 400, font.style ?? 'normal'])
    return base(text, font)
  }
  const nodePassages: NodePassage[] = passages.map((p) => ({
    threadId: p.threadId,
    nodeId: 'n',
    anchor: { kind: 'text', quote: p.quote, start: p.start, end: p.end },
    resolved: p.resolved,
  }))
  const shapes = composePassageHighlights(nodePassages, runs, measure, PAINT, source).map(
    (shape) =>
      [
        shape.id ?? '',
        [shape.bbox.x, shape.bbox.y, shape.bbox.w, shape.bbox.h].map(f64Hex),
        paintOf(shape.appearance),
      ] as const,
  )
  return {
    kind: 'highlights',
    runs: runs.map(runWire),
    passages,
    source,
    measure: measured,
    answer: { shapes, calls },
  }
}

function boards(): PassageHighlightRecord[] {
  const draw = lcg(53)
  const out: PassageHighlightRecord[] = []
  for (let i = 0; i < 120; i += 1) {
    const source = bodyOf(draw)
    const runs = collectTextRuns(
      typesetMdastBlocks(parseMarkdownBody(source), {
        measure: fake,
        maxWidth: 30 + draw(371),
        fontFamily: 'sans-serif',
      }).nodes,
    )
    const passages = Array.from({ length: 1 + draw(8) }, (_, n) => passageOn(draw, source, n))
    out.push(highlight(runs, passages, source, i % 10 === 0 ? 'odd' : 'fake'))
  }
  return [...out, ...wrapped()]
}

/**
 * Bodies whose runs sit under a list item or a table cell, which translate
 * their subtree: a passage there is drawn at the run's x plus every enclosing
 * wrapper's, and two cells' runs are each at their own cell's origin.
 */
function wrapped(): PassageHighlightRecord[] {
  const bodies: readonly (readonly [string, readonly string[]])[] = [
    ['- one target two\n  - nested target words\n    - deeper target', ['nested target', 'target']],
    ['1. ab\n2. ba **ab** ba', ['ba', 'ab']],
    ['| a | b |\n| --- | --- |\n| one | two |\n| ab ab | ba |', ['two', 'b ab', 'ba']],
    ['- | x | y |\n  | --- | --- |\n  | in | cell |', ['cell', 'in']],
  ]
  return bodies.map(([source, quotes], i) => {
    const runs = collectTextRuns(
      typesetMdastBlocks(parseMarkdownBody(source), {
        measure: fake,
        maxWidth: 400,
        fontFamily: 'sans-serif',
      }).nodes,
    )
    const passages = quotes.map((exact, n) => {
      const start = Math.max(0, source.lastIndexOf(exact))
      return { ...at(exact, start), threadId: `w${n}`, resolved: n === 1 }
    })
    return highlight(runs, passages, source, i === 3 ? 'odd' : 'fake')
  })
}

const run = (
  text: string,
  [x, y, w, h]: readonly [number, number, number, number],
  font: { family?: string; size?: number; strong?: boolean; emphasis?: boolean } = {},
  offsetX = 0,
): PlacedRun => ({
  run: {
    kind: 'textRun',
    text,
    bbox: { x, y, w, h },
    ...(font.strong === true ? { strong: true } : {}),
    ...(font.emphasis === true ? { emphasis: true } : {}),
    appearance: {
      ...(font.family === undefined ? {} : { fontFamily: font.family }),
      ...(font.size === undefined ? {} : { fontSize: font.size }),
    },
  },
  offsetX,
})

type HandBuilt = readonly [readonly PlacedRun[], readonly PassageWire[], string, Measured]

const hand = (...entry: HandBuilt): HandBuilt => entry

const sans = { family: 'sans-serif', size: 20 }

const at = (text: string, start: number, extra: Partial<PassageWire> = {}): PassageWire => ({
  threadId: 'h',
  quote: { exact: text },
  start,
  end: start + text.length,
  resolved: false,
  ...extra,
})

/** Runs layout never produces: gaps either side of the threshold, fonts missing, a run ending in a space. */
const HAND_BUILT: readonly HandBuilt[] = [
  // A gap of exactly 0.15 x 20 = 3 is no space; 3.5 is one.
  hand(
    [run('see', [0, 0, 36, 20], sans), run('a', [39, 0, 12, 20], sans)],
    [at('seea', 0)],
    'seea',
    'fake',
  ),
  hand(
    [run('see', [0, 0, 36, 20], sans), run('a', [39.5, 0, 12, 20], sans)],
    [at('see a', 0)],
    'see a',
    'fake',
  ),
  hand(
    [run('see', [0, 0, 36, 20], sans), run('a', [39.5, 0, 12, 10], sans)],
    [at('see a', 0)],
    'see a',
    'fake',
  ),
  // A new line is a space however close; a run ending in one takes no other.
  hand(
    [run('see', [0, 0, 36, 20], sans), run('a', [0, 20, 12, 20], sans)],
    [at('see a', 0)],
    'see a',
    'fake',
  ),
  hand(
    [run('see ', [0, 0, 48, 20], sans), run('a', [0, 20, 12, 20], sans)],
    [at('see a', 0)],
    'see a',
    'fake',
  ),
  hand(
    [run('see', [0, -0, 36, 20], sans), run('a', [36, 0, 12, 20], sans)],
    [at('seea', 0)],
    'seea',
    'fake',
  ),
  // A run with no family, or no size, is not measured; the next one is.
  hand(
    [
      run('ab', [0, 0, 24, 20], { size: 20 }),
      run('ab', [0, 20, 24, 20], { family: 'serif' }),
      run('ab', [0, 40, 24, 20], sans),
    ],
    [at('ab ab ab', 0)],
    'ab ab ab',
    'fake',
  ),
  // Weight and slant reach the measurer.
  hand(
    [
      run('aa', [0, 0, 24, 20], { ...sans, strong: true }),
      run('aa', [0, 20, 24, 20], { ...sans, emphasis: true }),
    ],
    [at('aa aa', 0)],
    'aa aa',
    'fake',
  ),
  // A passage beginning mid-run, crossing three runs and ending mid-run.
  hand(
    [
      run('xxaa', [0, 0, 48, 20], sans),
      run('aa', [0, 20, 24, 20], sans),
      run('aaxx', [0, 40, 48, 20], sans),
    ],
    [at('aa aa aa', 2, { resolved: true }), at('xx', 0), at('xx', 13)],
    'xxaa aa aaxx',
    'fake',
  ),
  // Clamped advances: NaN and negative widths draw nothing; a zero lead stays.
  hand(
    [run('zab', [0, 0, 36, 20], sans), run('zz', [0, 20, 24, 20], sans)],
    [at('ab', 1), at('zz', 4), at('za', 0)],
    'zab zz',
    'odd',
  ),
  // An empty run inside a passage is skipped before it is measured.
  hand(
    [
      run('ab', [0, 0, 24, 20], sans),
      run('', [0, 20, 0, 20], sans),
      run('ab', [0, 40, 24, 20], sans),
    ],
    [at('ab ab', 0)],
    'ab ab',
    'fake',
  ),
  // Context read outward over whitespace runs, which read as one space each way.
  hand(
    [run('a  b   a  b', [0, 0, 132, 20], sans)],
    [at('b', 0, { quote: { exact: 'b', prefix: 'a\t ', suffix: ' \n a' } })],
    'b',
    'fake',
  ),
  // A run of spaces is one space: read space by space, the first occurrence
  // would lose its tie with the second, before it and after it.
  hand(
    [run('a  b a b', [0, 0, 96, 20], sans)],
    [at('b', 0, { quote: { exact: 'b', prefix: 'a ' } })],
    'b',
    'fake',
  ),
  hand(
    [run('b  a b a', [0, 0, 96, 20], sans)],
    [at('b', 0, { quote: { exact: 'b', suffix: ' a' } })],
    'b',
    'fake',
  ),
  // The rendered text holds the quote and the source no longer does: orphaned.
  hand([run('ab', [0, 0, 24, 20], sans)], [at('ab', 0)], 'xy', 'fake'),
  // A run whose paint names a family and no size, or a size and no family.
  hand(
    [run('ab', [0, 0, 24, 20], { family: 'serif' }), run('ab', [0, 20, 24, 20], { size: 20 })],
    [at('ab ab', 0)],
    'ab ab',
    'fake',
  ),
  // Source counts that disagree with the rendered ones, both ways round.
  hand(
    [run('a a a', [0, 0, 60, 20], sans)],
    [at('a', 10, { quote: { exact: 'a', prefix: 'a ' } })],
    '<!-- a --> a a a',
    'fake',
  ),
  hand(
    [run('a', [0, 0, 12, 20], sans)],
    [at('a', 4, { quote: { exact: 'a', suffix: 'x' } })],
    'a a a',
    'fake',
  ),
  hand(
    [run('ab ab ab', [0, 0, 96, 20], sans)],
    [at(' ab', 2), at('  ', 0), at('ba', 0)],
    'ab ab ab',
    'fake',
  ),
  // Two cells' runs, each at its own cell's origin: the gap is judged where
  // they are drawn — flush at 36 is one word, 3.5 apart is a space.
  hand(
    [run('see', [0, 0, 36, 20], sans, 10), run('a', [0, 0, 12, 20], sans, 46)],
    [at('seea', 0)],
    'seea',
    'fake',
  ),
  hand(
    [run('see', [0, 0, 36, 20], sans, 10), run('a', [0, 0, 12, 20], sans, 49.5)],
    [at('see a', 0)],
    'see a',
    'fake',
  ),
  // A wrapper offset under a stored x: the box is drawn at their sum plus the lead.
  hand([run('xxab', [4.25, 0, 48, 20], sans, 0.1)], [at('ab', 2)], 'xxab', 'fake'),
]

const handBuilt = (): PassageHighlightRecord[] =>
  HAND_BUILT.map(([runs, passages, source, measured]) =>
    highlight(runs, passages, source, measured),
  )

/** Every record, in file order. */
export function passageHighlightRecords(): readonly PassageHighlightRecord[] {
  return [...occurrences(), ...scored(), ...resolves(), ...looses(), ...boards(), ...handBuilt()]
}
