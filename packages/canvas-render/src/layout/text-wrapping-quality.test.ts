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
 * The DEBT metrics (`overflow`, `max`, `bboxLies`) target zero; they record
 * what today's greedy space-only wrapping actually does. The PRICE metrics
 * (`runs`, `lines`, `measure`) have no target — they exist so a wrapping
 * strategy that buys its quality with a per-character measure loop cannot do
 * it silently.
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
  'en-prose@120: overflow=0 max=+0px bboxLies=0 runs=10 lines=6 measure=23',
  'en-prose@200: overflow=0 max=+0px bboxLies=0 runs=10 lines=4 measure=23',
  'en-prose@320: overflow=0 max=+0px bboxLies=0 runs=10 lines=2 measure=23',
  'ja-prose@120: overflow=1 max=+680px bboxLies=1 runs=1 lines=1 measure=3',
  'ja-prose@200: overflow=1 max=+600px bboxLies=1 runs=1 lines=1 measure=3',
  'ja-prose@320: overflow=1 max=+480px bboxLies=1 runs=1 lines=1 measure=3',
  'ja-en-mixed@120: overflow=3 max=+43px bboxLies=1 runs=7 lines=5 measure=17',
  'ja-en-mixed@200: overflow=0 max=+0px bboxLies=0 runs=7 lines=4 measure=17',
  'ja-en-mixed@320: overflow=0 max=+0px bboxLies=0 runs=7 lines=2 measure=17',
  'ja-kinsoku@120: overflow=1 max=+392px bboxLies=1 runs=1 lines=1 measure=3',
  'ja-kinsoku@200: overflow=1 max=+312px bboxLies=1 runs=1 lines=1 measure=3',
  'ja-kinsoku@320: overflow=1 max=+192px bboxLies=1 runs=1 lines=1 measure=3',
  'zh-prose@120: overflow=1 max=+264px bboxLies=1 runs=1 lines=1 measure=3',
  'zh-prose@200: overflow=1 max=+184px bboxLies=1 runs=1 lines=1 measure=3',
  'zh-prose@320: overflow=1 max=+64px bboxLies=1 runs=1 lines=1 measure=3',
  'long-url@120: overflow=1 max=+533px bboxLies=1 runs=1 lines=1 measure=3',
  'long-url@200: overflow=1 max=+453px bboxLies=1 runs=1 lines=1 measure=3',
  'long-url@320: overflow=1 max=+333px bboxLies=1 runs=1 lines=1 measure=3',
  'long-token@120: overflow=1 max=+446px bboxLies=1 runs=1 lines=1 measure=3',
  'long-token@200: overflow=1 max=+366px bboxLies=1 runs=1 lines=1 measure=3',
  'long-token@320: overflow=1 max=+246px bboxLies=1 runs=1 lines=1 measure=3',
  'inline-code@120: overflow=2 max=+334px bboxLies=1 runs=3 lines=1 measure=7',
  'inline-code@200: overflow=2 max=+254px bboxLies=1 runs=3 lines=1 measure=7',
  'inline-code@320: overflow=2 max=+134px bboxLies=1 runs=3 lines=1 measure=7',
  'ja-heading@120: overflow=2 max=+680px bboxLies=2 runs=2 lines=2 measure=6',
  'ja-heading@200: overflow=2 max=+600px bboxLies=2 runs=2 lines=2 measure=6',
  'ja-heading@320: overflow=1 max=+480px bboxLies=1 runs=2 lines=2 measure=6',
  'ja-list@120: overflow=2 max=+704px bboxLies=2 runs=4 lines=2 measure=8',
  'ja-list@200: overflow=1 max=+624px bboxLies=1 runs=4 lines=2 measure=8',
  'ja-list@320: overflow=1 max=+504px bboxLies=1 runs=4 lines=2 measure=8',
  'emoji@120: overflow=0 max=+0px bboxLies=0 runs=5 lines=3 measure=13',
  'emoji@200: overflow=0 max=+0px bboxLies=0 runs=5 lines=2 measure=13',
  'emoji@320: overflow=0 max=+0px bboxLies=0 runs=1 lines=1 measure=3',
]
const PINNED_DEBT = { overflowingRuns: 33, maxOverflowPx: 704, bboxUnderreports: 28 }
const PINNED_PRICE = { runs: 104, lines: 59, measureCalls: 257 }
