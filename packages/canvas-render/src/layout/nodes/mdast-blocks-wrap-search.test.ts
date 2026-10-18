import type { MdastPhrasingContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { createCorpusMeasure } from '../../test-utils/text-wrapping-corpus.js'
import { typesetMdastBlocks } from './mdast-blocks.js'

/**
 * Line breaking asks `longestFittingCount` how many segments join a line.
 * The oracle is the scan it replaced — try one more until one does not fit —
 * swapped in for the search under the SAME wrapper, so the property isolates
 * exactly the claim the search makes: on a monotone measurer, which probes
 * are taken changes nothing that is laid out. The cut of an atomic run and
 * of a code line goes through the same seam, so it is compared too.
 */
const oracle = vi.hoisted(() => ({
  scan: false,
  firstFailure(fits: (n: number) => boolean, limit: number): number {
    let n = 0
    while (n < limit && fits(n + 1)) n += 1
    return n
  },
}))

vi.mock('./longest-fit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./longest-fit.js')>()
  return {
    longestFittingCount: (fits: (n: number) => boolean, limit: number, guess?: number) =>
      oracle.scan
        ? oracle.firstFailure(fits, limit)
        : actual.longestFittingCount(fits, limit, guess),
  }
})

const wordArb = fc.constantFrom(
  'the',
  'quick',
  'brown',
  'antidisestablishmentarianism',
  'これは日本語の文章です。',
  '中文句子',
  'https://example.com/a/very/long/path',
  '🎉',
  '「括弧」',
  '、',
)
const textArb = fc
  .array(wordArb, { minLength: 1, maxLength: 40, size: 'max' })
  .chain((words) =>
    fc
      .array(fc.constantFrom(' ', ''), { minLength: words.length, maxLength: words.length })
      .map((gaps) => words.map((word, i) => word + (gaps[i] ?? '')).join('')),
  )
const phrasingArb: fc.Arbitrary<MdastPhrasingContent> = fc.oneof(
  { weight: 4, arbitrary: textArb.map((value) => ({ type: 'text' as const, value })) },
  {
    weight: 1,
    arbitrary: textArb.map((value) => ({
      type: 'strong' as const,
      children: [{ type: 'text' as const, value }],
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('fn(a, b)', 'const x = 1', 'averyveryverylongidentifiername')
      .map((value) => ({ type: 'inlineCode' as const, value })),
  },
)
const rootArb: fc.Arbitrary<MdastRoot> = fc
  .tuple(fc.array(phrasingArb, { minLength: 1, maxLength: 6 }), fc.string({ maxLength: 120 }))
  .map(([children, code]) => ({
    type: 'root',
    children: [
      { type: 'paragraph', children },
      { type: 'code', value: code },
    ],
  }))

function layout(root: MdastRoot, maxWidth: number, scan: boolean) {
  oracle.scan = scan
  try {
    return typesetMdastBlocks(root, {
      measure: createCorpusMeasure().measure,
      maxWidth,
      fontFamily: 'Roboto',
    })
  } finally {
    oracle.scan = false
  }
}

const MANY_LINES = 4
let manyLineLayouts = 0

describe('line breaking by search', () => {
  afterAllFloor(['lays out exactly what the segment-by-segment scan laid out'], () => {
    // A paragraph that never wraps more than once cannot tell a search from
    // a scan; the domain has to reach long, many-line paragraphs.
    expect(manyLineLayouts).toBeGreaterThan(80)
  })

  fcTest.prop([rootArb, fc.integer({ min: 8, max: 600 })], withDefaults({ numRuns: 150 }))(
    'lays out exactly what the segment-by-segment scan laid out',
    (root, maxWidth) => {
      const searched = layout(root, maxWidth, false)
      const paragraph = searched.nodes[0]
      if (paragraph?.kind === 'paragraph') {
        const lines = new Set(paragraph.runs.map((run) => run.bbox.y))
        if (lines.size >= MANY_LINES) manyLineLayouts += 1
      }
      expect(searched).toEqual(layout(root, maxWidth, true))
    },
  )
})
