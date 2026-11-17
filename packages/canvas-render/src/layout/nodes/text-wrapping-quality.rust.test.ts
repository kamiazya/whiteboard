import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { describeMeasure } from '../../measure.js'
import {
  CORPUS_WIDTHS_PX,
  corpusMarkdown,
  createCorpusMeasure,
  TEXT_WRAPPING_CORPUS,
} from '../../test-utils/text-wrapping-corpus.js'
import { sumMetrics, wrappingMetrics } from '../../test-utils/text-wrapping-metrics.js'
import { oracleLayoutCore } from '../../test-utils/wasm/oracle-layout-core.js'
import { SPATIAL_THEME_GEOMETRY } from '../../theme/spatial-geometry.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'

const PADDING_PX = SPATIAL_THEME_GEOMETRY.paddingPx

/**
 * A corpus case typeset by the core as a text node's body: a node whose
 * content box starts at the origin and is `maxWidth` wide, tall enough that
 * nothing is cut, measured by the counting measurer through the host import.
 */
function typeset(name: string, maxWidth: number): { scene: Scene; calls: number } {
  const entry = TEXT_WRAPPING_CORPUS.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`no corpus case named ${name}`)
  const counting = createCorpusMeasure()
  const node = textNode({
    id: 'n',
    x: -PADDING_PX,
    y: -PADDING_PX,
    width: maxWidth + 2 * PADDING_PX,
    height: 100_000,
    text: corpusMarkdown(entry.root),
  })
  const scene = layoutSpatialCanvas(
    { nodes: [node], edges: [] },
    {
      core: oracleLayoutCore(),
      measure: describeMeasure(counting.measure, { kind: 'host' }),
      appearance: createSpatialTheme({ mode: 'light' }),
    },
  )
  return { scene, calls: counting.calls() }
}

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
  const { scene, calls } = typeset(name, maxWidth)
  const m = wrappingMetrics(scene, maxWidth, calls)
  return `${name}@${maxWidth}: overflow=${m.overflowingRuns} max=+${m.maxOverflowPx}px bboxLies=${m.bboxUnderreports} badStart=${m.forbiddenLineStarts} runs=${m.runs} lines=${m.lines} measure=${m.measureCalls}`
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
          const { scene, calls } = typeset(entry.name, width)
          return wrappingMetrics(scene, width, calls)
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
      forbiddenLineStarts: totals.forbiddenLineStarts,
    }).toEqual(PINNED_DEBT)
    expect({
      runs: totals.runs,
      lines: totals.lines,
      measureCalls: totals.measureCalls,
    }).toEqual(PINNED_PRICE)
  })
})

const PINNED_SCORES: readonly string[] = [
  'en-prose@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=6 lines=6 measure=16',
  'en-prose@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=4 measure=16',
  'en-prose@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=9',
  'ja-prose@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=9 lines=9 measure=29',
  'ja-prose@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=6 lines=6 measure=17',
  'ja-prose@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=3 measure=13',
  'ja-en-mixed@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=6 lines=6 measure=27',
  'ja-en-mixed@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=4 measure=11',
  'ja-en-mixed@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=7',
  'ja-kinsoku@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=6 lines=6 measure=13',
  'ja-kinsoku@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=3 measure=9',
  'ja-kinsoku@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=7',
  'zh-prose@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=4 measure=15',
  'zh-prose@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=11',
  'zh-prose@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=10',
  'long-url@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=8 lines=8 measure=20',
  'long-url@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=4 measure=16',
  'long-url@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=3 measure=13',
  'long-token@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=5 lines=5 measure=17',
  'long-token@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=3 measure=15',
  'long-token@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=14',
  'ja-code-kinsoku@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=5 lines=4 measure=14',
  'ja-code-kinsoku@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=3 measure=8',
  'ja-code-kinsoku@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=2 measure=8',
  'ja-strong-kinsoku@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=5 lines=4 measure=11',
  'ja-strong-kinsoku@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=2 measure=10',
  'ja-strong-kinsoku@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=2 measure=9',
  'en-code-stop@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=5 lines=4 measure=10',
  'en-code-stop@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=2 measure=8',
  'en-code-stop@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=1 measure=4',
  'inline-code@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=2 measure=8',
  'inline-code@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=2 measure=12',
  'inline-code@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=3 lines=2 measure=13',
  'ja-heading@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=11 lines=11 measure=35',
  'ja-heading@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=7 lines=7 measure=19',
  'ja-heading@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=4 measure=15',
  'ja-list@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=14 lines=12 measure=35',
  'ja-list@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=9 lines=7 measure=24',
  'ja-list@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=6 lines=4 measure=15',
  'emoji@120: overflow=0 max=+0px bboxLies=0 badStart=0 runs=4 lines=4 measure=9',
  'emoji@200: overflow=0 max=+0px bboxLies=0 badStart=0 runs=2 lines=2 measure=6',
  'emoji@320: overflow=0 max=+0px bboxLies=0 badStart=0 runs=1 lines=1 measure=2',
]

// `forbiddenLineStarts` counts lines opened by a character UAX #14 forbids
// there — the kinsoku this package documents as coming free with
// `lineBreak: 'strict'`. It held inside a run and broke at every INLINE
// BOUNDARY, because the wrapper decides breaks one `emit` call at a time and
// each inline node is its own call; the three cases added to reach it read 4
// (the existing corpus was single-text-node prose and could not). Carrying
// the junction across those calls took it to zero, and the whole corpus is
// at zero on every debt column.
const PINNED_DEBT = {
  overflowingRuns: 0,
  maxOverflowPx: 0,
  bboxUnderreports: 0,
  forbiddenLineStarts: 0,
}
// Price is what refusing the forbidden break costs: +2 runs, +2 lines and +4
// measure calls, all of it on the two rows where the stretch that could not
// be parted from the incoming text had to come down a line to keep it
// (`ja-code-kinsoku@200`, `en-code-stop@120`). The other 40 rows are
// byte-identical, which is the claim worth having — a junction rule that
// re-wrapped prose it has no business touching would show up here.
// Measure calls fell 1054 -> 812 when the wrapper stopped scanning a line
// segment by segment and started searching for its length, with every
// other column on every row unchanged.
// Measure calls are the crossings to the HOST's measurer since the core lays
// the corpus out (ADR-0054 step 7, S18h): 580, where the TypeScript
// typesetter asked its measurer 812 times. The core keeps what it measured
// for the rest of a layout, so a repeated question never crosses; every other
// column on every row is what the TypeScript scored. How often the
// typesetter itself asks is the frozen `typeset.jsonl`'s `calls`, which the
// Rust typesetter replays exactly.
const PINNED_PRICE = { runs: 191, lines: 168, measureCalls: 580 }
