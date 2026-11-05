// The two exports of `tidy-units.ts` that nothing in the lane calls from
// inside a test. `tidyBoxes` is reached only at MODULE LOAD, by the drawing
// corpus — a broken one fails those files to import, which Stryker does not
// count as a kill, so it reported the whole function as a survivor. The work
// account is read only by the cost tests, which the lane excludes for run
// time; through the rest of the suite a broken account merely made a
// property slow enough to time out.
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  buildUnits,
  createTidyBudget,
  spendTidy,
  type TidyBudget,
  type TidyNode,
  tidyBoxes,
} from './tidy-units.js'

describe('the boxes a canvas gives tidy', () => {
  it("carries each node's rectangle and says which of them are frames", () => {
    const nodes = [
      groupNode({ id: 'f', x: 0, y: 8, width: 400, height: 300 }),
      textNode({ id: 'n', x: 16, y: 24, width: 100, height: 60, text: 'n' }),
    ]
    expect(tidyBoxes(nodes)).toEqual([
      { id: 'f', frame: true, x: 0, y: 8, width: 400, height: 300 },
      { id: 'n', frame: false, x: 16, y: 24, width: 100, height: 60 },
    ])
  })
})

describe("a tidy's work account", () => {
  it.each([
    'nesting',
    'levels',
  ] as const)('the %s account spends a request whole or not at all', (account: keyof TidyBudget) => {
    const budget = createTidyBudget()
    const all = budget[account]
    // Finite, so there is work a fresh account refuses.
    expect(Number.isFinite(all) && all > 0).toBe(true)
    expect(spendTidy(budget, account, all + 1)).toBe(false)
    expect(budget[account]).toBe(all)
    expect(spendTidy(budget, account, all)).toBe(true)
    expect(budget[account]).toBe(0)
    expect(spendTidy(budget, account, 1)).toBe(false)
  })
})

describe('who belongs to whom', () => {
  const frame = (id: string, x: number, y: number, width: number, height: number): TidyNode => ({
    id,
    frame: true,
    x,
    y,
    width,
    height,
  })

  it('assigns every node to exactly one unit, a root claimed through another root included', () => {
    // `f` is mostly inside `r`. `g` is larger than `f` and holds it, so
    // nothing encloses `g` and it is a root of its own; but `g` is also more
    // than half over `f`, so `r`'s scoop claims it through `f` first. A
    // second unit for `g` would move it twice.
    const nodes = [
      frame('r', 0, 0, 1000, 400),
      frame('f', 780, 100, 400, 100),
      frame('g', 780, 100, 720, 100),
    ]
    const members = buildUnits(nodes, {}).flatMap((u) => u.members.map((m) => m.id))
    expect([...members].sort()).toEqual(['f', 'g', 'r'])
  })
})
