/**
 * What ONE layout hands highlight.js, summed over every fence it lays out.
 *
 * The default tokeniser prices each fence on its own (lowlight-budget.test.ts),
 * which bounds one fence and nothing more: a document of many fences, each
 * just under the per-fence price, is laid out by a canvas file node or a
 * `![[…]]` embed with every fence tokenised in turn, synchronously. So the
 * cost is counted across the layout — the sum of squared identifier-run
 * lengths handed to highlight.js, the quantity its javascript/typescript/bash
 * grammars are quadratic in — rather than timed.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const handed = vi.hoisted(() => [] as string[])

vi.mock('lowlight', async (importOriginal) => {
  const original = await importOriginal<typeof import('lowlight')>()
  return {
    ...original,
    createLowlight: (...args: Parameters<typeof original.createLowlight>) => {
      const instance = original.createLowlight(...args)
      return {
        ...instance,
        highlight: (
          lang: string,
          value: string,
          options?: Parameters<typeof instance.highlight>[2],
        ) => {
          handed.push(value)
          return instance.highlight(lang, value, options)
        },
      }
    },
  }
})

beforeEach(() => {
  handed.length = 0
})

/** The quantity highlight.js's cost is quadratic in, summed over what it was handed. */
function squaredWordRuns(values: readonly string[]): number {
  let total = 0
  for (const value of values) {
    for (const match of value.matchAll(/[A-Za-z0-9_$]+/g)) total += match[0].length ** 2
  }
  return total
}

/** Four fences at the per-fence price: about 0.4s of typescript, the most one layout may spend. */
const ONE_LAYOUT_BUDGET = 4 * 4096 * 4096

const fence = (value: string): MdastRoot['children'][number] => ({
  type: 'code',
  lang: 'ts',
  value,
})

function layOutFileNodeShowing(body: MdastRoot): void {
  const canvas: SpatialCanvas = {
    nodes: [fileNode({ id: 'f1', x: 0, y: 0, width: 4000, height: 40_000, file: 'notes' })],
    edges: [],
  }
  const options: SpatialLayoutOptions = {
    measure: createFakeMeasure(),
    appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
    resolveReference: (ref) => (ref === 'notes' ? { markdown: body } : undefined),
  }
  layoutSpatialCanvas(canvas, options)
}

describe('the tokeniser budget of one layout', () => {
  it('stops tokenising once the fences of one document have spent it', () => {
    const fences = Array.from({ length: 63 }, () => fence(`const ${'a'.repeat(4095)} = 1`))
    layOutFileNodeShowing({ type: 'root', children: fences })
    // Present before bounded: a layout that tokenised nothing would pass the bound.
    expect(handed.length).toBeGreaterThan(0)
    expect(squaredWordRuns(handed)).toBeLessThanOrEqual(ONE_LAYOUT_BUDGET)
  }, 30_000)

  it('still tokenises every fence of an ordinary document', () => {
    const line = 'export const someLongerIdentifierName = computeValue(input, "text") // note\n'
    const fences = Array.from({ length: 63 }, () => fence(line.repeat(40)))
    layOutFileNodeShowing({ type: 'root', children: fences })
    expect(handed).toHaveLength(63)
  })
})
