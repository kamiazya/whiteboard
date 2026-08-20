import { describe, expect, it } from 'vitest'
import {
  CORPUS_WIDTHS_PX,
  createCorpusMeasure,
  TEXT_WRAPPING_CORPUS,
} from '../test-utils/text-wrapping-corpus.js'
import { sumMetrics, wrappingMetrics } from '../test-utils/text-wrapping-metrics.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

/**
 * The text-wrapping SCOREBOARD — the instrument, not a regression test.
 *
 * "Does text still escape its box?" cannot be answered by one canvas: a fix
 * that stops one string overflowing says nothing about whether the failure
 * moved to a string nobody looked at. So the corpus is scored in aggregate
 * and every number below is pinned EXACTLY, never as a ceiling — an
 * improvement has to be as loud as a regression, and someone has to say why
 * the number moved.
 *
 * The DEBT metrics (`overflow`, `max`, `bboxLies`) are all ZERO, and are
 * pinned at zero so the next regression is loud. The one thing still allowed
 * to overflow by contract is inline MATH, which is neither split nor cut:
 * `a + b + c` cut to `a + b` reads as a complete formula that is simply
 * wrong, where cut code reads as cut. No corpus case exercises it.
 *
 * The PRICE metrics (`runs`, `lines`, `measure`) have no target — they exist
 * so a wrapping strategy that buys its quality with a per-character measure
 * loop cannot do it silently.
 */

function scoreLine(name: string, maxWidth: number): string {
  const entry = TEXT_WRAPPING_CORPUS.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`no corpus case named ${name}`)
  const counting = createCorpusMeasure()
  const scene = layoutMdastBlocks(entry.root, {
    measure: counting.measure,
    maxWidth,
    fontFamily: 'Roboto',
  })
  const m = wrappingMetrics(scene, maxWidth, counting.calls())
  return `${name}@${maxWidth}: overflow=${m.overflowingRuns} max=+${m.maxOverflowPx}px bboxLies=${m.bboxUnderreports} runs=${m.runs} lines=${m.lines} measure=${m.measureCalls}`
}

function allScores(): readonly string[] {
  return TEXT_WRAPPING_CORPUS.flatMap((entry) =>
    CORPUS_WIDTHS_PX.map((width) => scoreLine(entry.name, width)),
  )
}

describe('text wrapping scoreboard', () => {
  it('scores the corpus exactly as pinned', () => {
    expect(allScores()).toEqual(PINNED_SCORES)
  })

  it('reports the aggregate debt', () => {
    const totals = sumMetrics(
      TEXT_WRAPPING_CORPUS.flatMap((entry) =>
        CORPUS_WIDTHS_PX.map((width) => {
          const counting = createCorpusMeasure()
          const scene = layoutMdastBlocks(entry.root, {
            measure: counting.measure,
            maxWidth: width,
            fontFamily: 'Roboto',
          })
          return wrappingMetrics(scene, width, counting.calls())
        }),
      ),
    )
    // Target: three zeroes. Until then this is a debt figure, and the whole
    // point of the aggregate is that it cannot be reduced in one place by
    // pushing the failure into another.
    expect({
      overflowingRuns: totals.overflowingRuns,
      maxOverflowPx: totals.maxOverflowPx,
      bboxUnderreports: totals.bboxUnderreports,
    }).toEqual(PINNED_DEBT)
    expect({
      runs: totals.runs,
      lines: totals.lines,
      measureCalls: totals.measureCalls,
    }).toEqual(PINNED_PRICE)
  })
})

const PINNED_SCORES: readonly string[] = [
  'en-prose@120: overflow=0 max=+0px bboxLies=0 runs=6 lines=6 measure=23',
  'en-prose@200: overflow=0 max=+0px bboxLies=0 runs=4 lines=4 measure=19',
  'en-prose@320: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=15',
  'ja-prose@120: overflow=0 max=+0px bboxLies=0 runs=9 lines=9 measure=41',
  'ja-prose@200: overflow=0 max=+0px bboxLies=0 runs=6 lines=6 measure=24',
  'ja-prose@320: overflow=0 max=+0px bboxLies=0 runs=3 lines=3 measure=18',
  'ja-en-mixed@120: overflow=0 max=+0px bboxLies=0 runs=6 lines=6 measure=41',
  'ja-en-mixed@200: overflow=0 max=+0px bboxLies=0 runs=4 lines=4 measure=14',
  'ja-en-mixed@320: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=10',
  'ja-kinsoku@120: overflow=0 max=+0px bboxLies=0 runs=6 lines=6 measure=19',
  'ja-kinsoku@200: overflow=0 max=+0px bboxLies=0 runs=3 lines=3 measure=13',
  'ja-kinsoku@320: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=11',
  'zh-prose@120: overflow=0 max=+0px bboxLies=0 runs=4 lines=4 measure=31',
  'zh-prose@200: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=27',
  'zh-prose@320: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=27',
  'long-url@120: overflow=0 max=+0px bboxLies=0 runs=8 lines=8 measure=28',
  'long-url@200: overflow=0 max=+0px bboxLies=0 runs=4 lines=4 measure=20',
  'long-url@320: overflow=0 max=+0px bboxLies=0 runs=3 lines=3 measure=18',
  'long-token@120: overflow=0 max=+0px bboxLies=0 runs=5 lines=5 measure=71',
  'long-token@200: overflow=0 max=+0px bboxLies=0 runs=3 lines=3 measure=67',
  'long-token@320: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=65',
  'inline-code@120: overflow=0 max=+0px bboxLies=0 runs=3 lines=2 measure=13',
  'inline-code@200: overflow=0 max=+0px bboxLies=0 runs=3 lines=2 measure=23',
  'inline-code@320: overflow=0 max=+0px bboxLies=0 runs=3 lines=2 measure=38',
  'ja-heading@120: overflow=0 max=+0px bboxLies=0 runs=11 lines=11 measure=49',
  'ja-heading@200: overflow=0 max=+0px bboxLies=0 runs=7 lines=7 measure=27',
  'ja-heading@320: overflow=0 max=+0px bboxLies=0 runs=4 lines=4 measure=21',
  'ja-list@120: overflow=0 max=+0px bboxLies=0 runs=14 lines=12 measure=52',
  'ja-list@200: overflow=0 max=+0px bboxLies=0 runs=9 lines=7 measure=40',
  'ja-list@320: overflow=0 max=+0px bboxLies=0 runs=6 lines=4 measure=23',
  'emoji@120: overflow=0 max=+0px bboxLies=0 runs=4 lines=4 measure=13',
  'emoji@200: overflow=0 max=+0px bboxLies=0 runs=2 lines=2 measure=9',
  'emoji@320: overflow=0 max=+0px bboxLies=0 runs=1 lines=1 measure=3',
]

const PINNED_DEBT = { overflowingRuns: 0, maxOverflowPx: 0, bboxUnderreports: 0 }
// The debt above is unchanged and still zero on every case. The price moved
// DOWN across the board when the type scale was compressed for node width,
// and each mover has one cause: `ja-heading` wraps fewer lines because the
// heading sizes shrank (32/24/20 -> 24/20/17), and `ja-list` wraps fewer
// because the list indent went 32 -> 22, which is a WIDER content column by
// definition. Nothing else in the corpus moved.
const PINNED_PRICE = { runs: 153, lines: 144, measureCalls: 913 }
