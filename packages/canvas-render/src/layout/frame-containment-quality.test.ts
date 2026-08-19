import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import {
  CORPUS_WIDTHS_PX,
  createCorpusMeasure,
  TEXT_WRAPPING_CORPUS,
} from '../test-utils/text-wrapping-corpus.js'
import { layoutSpatialCanvas, naturalNodeContentSize } from './spatial-canvas.js'

/**
 * The frame-containment SCOREBOARD — how much content is HIDDEN to keep the
 * containment law, and how often the law's escape is taken.
 *
 * The properties in `spatial-canvas.properties.test.ts` state the law: at
 * most one element may cross the frame, and only when nothing fits. That is
 * a BOUND, and a bound says nothing about frequency — every node in the
 * product could start taking that escape and the properties would stay
 * green. This is the instrument that would notice, the same reason the
 * routing scoreboard counts violations instead of asserting one canvas.
 *
 * DEBT, both pinned EXACTLY rather than as a ceiling so an improvement is as
 * loud as a regression:
 *
 * - `hidden`  blocks trimmed away, i.e. prose a reader cannot see.
 * - `crossed` nodes where an element still crosses the frame, i.e. the box
 *             could not hold even one block.
 *
 * Neither targets zero. Truncating is what the law trades for never painting
 * outside the frame, and a node smaller than one line has no third option —
 * `apps/web` answers both by GROWING the node on commit, and these numbers
 * are what that safety net catches when growth never happened (an
 * agent-authored node, one shrunk by hand).
 *
 * Box heights are drawn as fractions of each case's OWN natural content
 * height, never as flat pixels: a flat height is roomy for a one-line case
 * and impossible for a ten-line one, so the same number would mean a
 * different thing per case and the total would measure the corpus rather
 * than the layout.
 */

const HEIGHT_FRACTIONS: readonly number[] = [1.2, 0.8, 0.4]

/** The corpus bodies are mdast; the node carries its case NAME as text. */
function parseByName(text: string): MdastRoot {
  const entry = TEXT_WRAPPING_CORPUS.find((candidate) => candidate.name === text)
  if (entry === undefined) throw new Error(`no corpus case named ${text}`)
  return entry.root
}

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

interface Debt {
  readonly hidden: number
  readonly crossed: number
}

function scoreCase(name: string, width: number, fraction: number): Debt {
  const measure = createCorpusMeasure().measure
  const options = { measure, parseBody: parseByName, appearance: APPEARANCE }
  const node = (height: number) => ({
    id: 'n',
    type: 'text' as const,
    x: 0,
    y: 0,
    width,
    height,
    text: name,
  })

  const natural = naturalNodeContentSize(node(1), options)
  // +2 padding is what `naturalNodeContentSize` documents as containing it.
  const height = Math.max(1, Math.round((natural.h + 16) * fraction))
  const canvas: SpatialCanvas = { nodes: [node(height)], edges: [] }

  const painted = layoutSpatialCanvas(canvas, options).nodes.filter(
    (entry) => entry.kind !== 'shape' && entry.kind !== 'edge',
  )
  const whole = layoutSpatialCanvas({ nodes: [node(100_000)], edges: [] }, options).nodes.filter(
    (entry) => entry.kind !== 'shape' && entry.kind !== 'edge',
  )
  const crossed = painted.some((entry) => entry.bbox.y + entry.bbox.h > height)

  return { hidden: whole.length - painted.length, crossed: crossed ? 1 : 0 }
}

function totalDebt(): Debt {
  let hidden = 0
  let crossed = 0
  for (const entry of TEXT_WRAPPING_CORPUS) {
    for (const width of CORPUS_WIDTHS_PX) {
      for (const fraction of HEIGHT_FRACTIONS) {
        const debt = scoreCase(entry.name, width, fraction)
        hidden += debt.hidden
        crossed += debt.crossed
      }
    }
  }
  return { hidden, crossed }
}

describe('frame containment scoreboard', () => {
  it('reports the aggregate debt', () => {
    expect(totalDebt()).toEqual(PINNED_DEBT)
  })

  it('hides nothing when every box is roomy, so the corpus is not reporting a constant', () => {
    // Guards the whole instrument against the failure it cannot otherwise
    // show: if truncation ran unconditionally, the numbers above would still
    // look like a stable pin.
    let hidden = 0
    for (const entry of TEXT_WRAPPING_CORPUS) {
      for (const width of CORPUS_WIDTHS_PX) {
        hidden += scoreCase(entry.name, width, 1.2).hidden
      }
    }
    expect(hidden).toBe(0)
  })
})

/**
 * 11 corpus cases x 3 widths x 3 height fractions = 99 cells.
 *
 * `crossed: 10` is the cells whose box is 40% of the natural height, i.e.
 * too small for even one LINE — keep-first paints that line and there is no
 * third option short of not rendering the node. Every 0.8 cell is contained,
 * which was not true before lists were trimmed to their fitting items: a
 * list escaped its frame at 0.8 while every prose case survived.
 *
 * It was 13 until keep-first's unit became a LINE rather than a BLOCK
 * (`firstLineOfBlocks`): three of those cells were a multi-line first block
 * painted whole, so they crossed by the height of every line after the
 * first. That is a real improvement in this debt figure, not a re-pin — the
 * three cells are contained now, and the remaining ten are the irreducible
 * case where a single line is taller than the box.
 *
 * `hidden` was 3 — `ja-heading` at 0.4, where a whole heading block is
 * dropped rather than shown crossing the frame. Compressing the heading
 * scale for node width (32/24/20 -> 24/20/17) made that heading short enough
 * to keep, so it is 2. An improvement in the figure, not a re-pin: nothing
 * about hiding changed, the content simply fits now.
 */
const PINNED_DEBT: Debt = { hidden: 2, crossed: 10 }
