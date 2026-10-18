import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from './pipeline.js'

/**
 * How parse time scales with body size, per shape. A body is the shape's
 * unit repeated to a target length, timed at two lengths sixteen times apart,
 * and the scaling exponent fitted from the pair: ~1 is linear, ~2 quadratic.
 * A ratio, not a duration, so the verdict does not depend on how fast or
 * loaded the machine is — only on the shape of the cost curve.
 *
 * `scaling` is the verdict this tree gives, and every shape here once read
 * `superlinear`: a body far inside MARKDOWN_MAX_CHARS whose parse grew with
 * the square of its size, so one stored body could hold the event loop of
 * whoever rendered it for minutes. Each is bounded now, in codec's delimiter
 * budget or in the patched parser packages (pnpm-workspace.yaml's
 * patchedDependencies); a shape found superlinear again is recorded as
 * `superlinear` here until it is fixed, rather than left out.
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
   * there, and still finishes at sixteen times the size before the fix.
   */
  small?: number
}

const DEFAULT_SMALL = 8_000
const GROWTH = 16
/**
 * Fitted exponents land near 1 or near 2; this splits them with margin. The
 * wide growth is what keeps the margin under load: a timing disturbed by a
 * factor r moves the exponent by log(r)/log(GROWTH), so a 2.3x burst on one
 * side costs 0.3 here and cost 0.6 at a growth of four, where shapes that
 * read 0.9 alone failed under five parallel copies.
 */
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
    scaling: 'linear',
  },
  {
    name: 'a long underscore run pair',
    unit: () => '_',
    wrap: (u) => `${u}x${u}`,
    small: 2_000,
    scaling: 'linear',
  },
  // Emphasis: closers with no opener each walk back over the whole paragraph.
  { name: 'unmatched emphasis closers', unit: () => 'a* ', scaling: 'linear' },
  { name: 'mixed emphasis openers and closers', unit: () => '*a_ ', scaling: 'linear' },
  { name: 'unmatched strikethrough closers', unit: () => 'a~ ', scaling: 'linear' },
  // Labels: each `]` walks back over the paragraph looking for its `[`.
  { name: 'unmatched label ends', unit: () => 'a] ', scaling: 'linear' },
  { name: 'balanced brackets', unit: () => '[a]', scaling: 'linear' },
  // Adjacent text merges once per group of data tokens, splicing the whole run.
  { name: 'text between code spans', unit: () => 'a&b`c`', scaling: 'linear' },
  // GFM literal autolinks: a regex retried at every position of a long word.
  { name: 'a long dotted word', unit: () => 'a.', scaling: 'linear' },
  { name: 'www inside a long word', unit: () => 'awww.', scaling: 'linear' },
  { name: 'www with a refused domain', unit: () => 'www._', scaling: 'linear' },
  // ...and a trailing-punctuation check re-run at every marker of a run.
  {
    name: 'trailing punctuation in a URL',
    unit: () => '!',
    wrap: (u) => `www.a.com/${u}x`,
    scaling: 'linear',
  },
  { name: 'dots in a www domain', unit: () => '.', wrap: (u) => `www.a${u}b`, scaling: 'linear' },
  // Containers opened on one line nest as deep as the line is long.
  {
    name: 'one-line nested lists',
    unit: () => '- ',
    wrap: (u) => `${u}x`,
    small: 1_000,
    scaling: 'linear',
  },
  {
    name: 'one-line nested quotes and lists',
    unit: () => '> - ',
    wrap: (u) => `${u}x`,
    small: 2_000,
    scaling: 'linear',
  },
  // Lazy continuation: every lazy line rescans the paragraph it continues.
  { name: 'lazy blockquote continuation', unit: () => '> a\nb\n', scaling: 'linear' },
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

/** One timed parse, floored so a sub-millisecond one cannot divide by zero. */
function parseMillis(body: string): number {
  const started = performance.now()
  parseMarkdownBody(body)
  return Math.max(performance.now() - started, 0.05)
}

/**
 * Fastest of up to three parses at each size, the two sizes taken in turn:
 * the minimum is the run least disturbed by the rest of the machine, and
 * alternating means a burst of load lands on both sizes rather than on
 * whichever was being timed then. A large
 * parse that already takes half a second is dominated by its own work, so
 * it is not repeated.
 */
function scalingExponent(shape: Shape): number {
  const length = shape.small ?? DEFAULT_SMALL
  const smallBody = bodyOf(shape, length)
  const largeBody = bodyOf(shape, length * GROWTH)
  // One untimed parse first, so the small body is not charged the JIT warm-up
  // that the large one then skips.
  parseMarkdownBody(smallBody)
  let small = Number.POSITIVE_INFINITY
  let large = Number.POSITIVE_INFINITY
  for (let run = 0; run < 3; run++) {
    small = Math.min(small, parseMillis(smallBody))
    if (run > 0 && large > 500) continue
    large = Math.min(large, parseMillis(largeBody))
  }
  return Math.log(large / small) / Math.log(GROWTH)
}

describe('markdown parse cost scaling', () => {
  it.each(SHAPES)('$name scales $scaling', (shape) => {
    const exponent = scalingExponent(shape)
    if (shape.scaling === 'linear') expect(exponent).toBeLessThan(LINEAR_EXPONENT_CEILING)
    else expect(exponent).toBeGreaterThanOrEqual(LINEAR_EXPONENT_CEILING)
  }, 120_000)
})
