import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

/**
 * How parse time scales with body size, per shape. A body is the shape's
 * unit repeated to a target length, timed at two lengths four times apart,
 * and the scaling exponent fitted from the pair: ~1 is linear, ~2 quadratic.
 * A ratio, not a duration, so the verdict does not depend on how fast or
 * loaded the machine is — only on the shape of the cost curve.
 *
 * `scaling` is the verdict this tree gives today. Every shape that reads
 * `superlinear` is a body far inside MARKDOWN_MAX_CHARS whose parse grows
 * with the square (or worse) of its size, and therefore one stored body that
 * holds the event loop of whoever renders it.
 */
type Shape = {
  name: string
  unit: (index: number) => string
  /** Fixed text around the repeated units, for shapes that need a closer. */
  wrap?: (units: string) => string
  scaling: 'linear' | 'superlinear'
  /**
   * Length of the repeated text at the smaller of the two sizes. Sized per
   * shape so a superlinear one is already dominated by its superlinear term
   * there, and still finishes at four times the size before the fix.
   */
  small?: number
}

const DEFAULT_SMALL = 8_000
const GROWTH = 4
/** Fitted exponents land near 1 or near 2; this splits them with margin. */
const LINEAR_EXPONENT_CEILING = 1.5

const SHAPES: Shape[] = [
  // Controls: ordinary markdown, which has always been linear. They keep the
  // instrument honest — a broken timer would misjudge these too.
  { name: 'plain paragraphs', unit: (i) => `word ${i} and more words\n\n`, scaling: 'linear' },
  {
    name: 'ordinary mixed markdown',
    unit: (i) =>
      `## Heading ${i}\n\nSome *em* and **strong** text, \`code\`, [a link](https://x.y/${i}).\n\n- item\n- item\n\n> quoted\n\n`,
    scaling: 'linear',
  },
  // Emphasis: two long delimiter runs resolve into thousands of nested pairs.
  {
    name: 'a long emphasis run pair',
    unit: () => '*',
    wrap: (u) => `${u}x${u}`,
    small: 2_000,
    scaling: 'superlinear',
  },
  {
    name: 'a long underscore run pair',
    unit: () => '_',
    wrap: (u) => `${u}x${u}`,
    small: 2_000,
    scaling: 'superlinear',
  },
  // Emphasis: closers with no opener each walk back over the whole paragraph.
  { name: 'unmatched emphasis closers', unit: () => 'a* ', scaling: 'superlinear' },
  { name: 'mixed emphasis openers and closers', unit: () => '*a_ ', scaling: 'superlinear' },
  { name: 'unmatched strikethrough closers', unit: () => 'a~ ', scaling: 'superlinear' },
  // Labels: each `]` walks back over the paragraph looking for its `[`.
  { name: 'unmatched label ends', unit: () => 'a] ', scaling: 'superlinear' },
  { name: 'balanced brackets', unit: () => '[a]', scaling: 'superlinear' },
  // Containers opened on one line nest as deep as the line is long.
  {
    name: 'one-line nested lists',
    unit: () => '- ',
    wrap: (u) => `${u}x`,
    small: 1_000,
    scaling: 'superlinear',
  },
  {
    name: 'one-line nested quotes and lists',
    unit: () => '> - ',
    wrap: (u) => `${u}x`,
    small: 2_000,
    scaling: 'superlinear',
  },
  // Lazy continuation: every lazy line rescans the paragraph it continues.
  { name: 'lazy blockquote continuation', unit: () => '> a\nb\n', scaling: 'superlinear' },
  // A long table is ordinary content, not an attack.
  {
    name: 'a long table',
    unit: () => '|x|y|\n',
    wrap: (u) => `|a|b|\n|-|-|\n${u}`,
    scaling: 'linear',
  },
]

/** The shape's unit repeated to `length` characters, then wrapped. */
function bodyOf(shape: Shape, length: number): string {
  let units = ''
  for (let index = 0; units.length < length; index++) units += shape.unit(index)
  return shape.wrap ? shape.wrap(units) : units
}

/**
 * Fastest of up to three parses: the minimum is the run least disturbed by
 * the rest of the machine. A parse that already takes half a second is
 * dominated by its own work, so it is not repeated.
 */
function parseMillis(body: string): number {
  let fastest = Number.POSITIVE_INFINITY
  for (let run = 0; run < 3; run++) {
    const started = performance.now()
    parseMarkdownBody(body)
    fastest = Math.min(fastest, performance.now() - started)
    if (fastest > 500) break
  }
  // A clock floor, so a sub-millisecond parse cannot divide by zero.
  return Math.max(fastest, 0.05)
}

function scalingExponent(shape: Shape): number {
  // One untimed parse first, so the small body is not charged the JIT warm-up
  // that the large one then skips.
  const length = shape.small ?? DEFAULT_SMALL
  parseMarkdownBody(bodyOf(shape, length))
  const small = parseMillis(bodyOf(shape, length))
  const large = parseMillis(bodyOf(shape, length * GROWTH))
  return Math.log(large / small) / Math.log(GROWTH)
}

describe('markdown parse cost scaling', () => {
  it.each(SHAPES)('$name scales $scaling', (shape) => {
    const exponent = scalingExponent(shape)
    if (shape.scaling === 'linear') expect(exponent).toBeLessThan(LINEAR_EXPONENT_CEILING)
    else expect(exponent).toBeGreaterThanOrEqual(LINEAR_EXPONENT_CEILING)
  }, 120_000)
})
