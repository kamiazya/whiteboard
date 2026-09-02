/**
 * Indent / outdent as moves on a list's TREE, checked by command sequences
 * and judged on the parsed document.
 *
 * Nesting is the one place a line's markdown meaning depends on the lines
 * above it: a child item must start at its parent's content column (`- `
 * puts that at 2, `1. ` at 3), and anything less is a sibling or a new list.
 * So the model is not one line but a list — items with depths, the caret on
 * the last one — and the oracle flattens codec's mdast back into that same
 * (depth, ordered, text) sequence. The model never spells out an indent
 * width; whether the real side chose a width the parser reads as nesting is
 * exactly what is under test.
 *
 * The table:
 *   indent  — the last item becomes a child of the sibling above it. With
 *             no sibling above (it is its parent's first child, or the
 *             first item of all) there is nothing to nest under and the
 *             press reports unhandled: the alternative writes an indent the
 *             parser ignores.
 *   outdent — the last item moves up one level; at the top level it reports
 *             unhandled. (Leaving the list from here is the bullet button's
 *             job; a marker removed under another item would be read as
 *             that item's continuation text.)
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { normalizeMdast, parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { selfContainedCommand, verb } from './editor-verbs.js'

interface Item {
  depth: number
  readonly ordered: boolean
  readonly text: string
}

interface Model {
  readonly items: Item[]
}

interface Real {
  state: EditorState
}

/** The test's own rendering: each item at its parent's content column. */
function render(items: readonly Item[]): string {
  const lines: string[] = []
  const contentColumnAtDepth: number[] = []
  for (const item of items) {
    const indent = item.depth === 0 ? 0 : contentColumnAtDepth[item.depth - 1]
    const marker = item.ordered ? '1. ' : '- '
    contentColumnAtDepth[item.depth] = indent + marker.length
    lines.push(`${' '.repeat(indent)}${marker}${item.text}`)
  }
  return lines.join('\n')
}

interface Node {
  readonly type: string
  readonly ordered?: boolean
  readonly value?: string
  readonly children?: readonly Node[]
}

function plainOf(node: Node): string {
  return (node.value ?? '') + (node.children ?? []).map(plainOf).join('')
}

/** Every list item in document order, with the depth of the list it sits in. */
function flatten(doc: string): Item[] {
  const out: Item[] = []
  const walkList = (list: Node, depth: number) => {
    for (const item of list.children ?? []) {
      const text = (item.children ?? [])
        .filter((child) => child.type !== 'list')
        .map(plainOf)
        .join('')
      out.push({ depth, ordered: list.ordered === true, text })
      for (const child of item.children ?? []) if (child.type === 'list') walkList(child, depth + 1)
    }
  }
  const root = normalizeMdast(parseMarkdownBody(doc)) as unknown as Node
  for (const block of root.children ?? []) {
    if (block.type === 'list') walkList(block, 0)
    else
      out.push({ depth: -1, ordered: false, text: `not a list: ${block.type} ${plainOf(block)}` })
  }
  return out
}

function press(real: Real, id: 'indent' | 'outdent'): boolean {
  const command = selfContainedCommand(verb(id))
  if (command === null) throw new Error(`${id} lost its command`)
  return command({
    state: real.state,
    dispatch: (tr) => {
      real.state = tr.state
    },
  })
}

function judge(model: Model, real: Real): void {
  expect(flatten(real.state.doc.toString())).toEqual(model.items)
}

/** Whether the last item has a sibling above it: the nearest shallower-or-equal item is at its own depth. */
function hasSiblingAbove(items: readonly Item[]): boolean {
  const last = items[items.length - 1]
  for (let i = items.length - 2; i >= 0; i--) {
    if (items[i].depth <= last.depth) return items[i].depth === last.depth
  }
  return false
}

class Indent implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    const handled = press(real, 'indent')
    const last = model.items[model.items.length - 1]
    if (hasSiblingAbove(model.items)) {
      expect(handled, 'a sibling above and nothing happened').toBe(true)
      last.depth += 1
    } else {
      expect(handled, 'nothing to nest under, yet the press claimed to act').toBe(false)
    }
    judge(model, real)
  }
  toString(): string {
    return 'indent'
  }
}

class Outdent implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    const handled = press(real, 'outdent')
    const last = model.items[model.items.length - 1]
    if (last.depth > 0) {
      expect(handled, 'nested, and nothing happened').toBe(true)
      last.depth -= 1
    } else {
      expect(handled, 'already at the top, yet the press claimed to act').toBe(false)
    }
    judge(model, real)
  }
  toString(): string {
    return 'outdent'
  }
}

/** A valid tree as a depth sequence: starts at 0, each step climbs by at most one. */
const initialItems: fc.Arbitrary<Item[]> = fc
  .array(
    fc.record({
      climb: fc.integer({ min: 0, max: 4 }),
      ordered: fc.boolean(),
      text: fc.constantFrom('milk', 'tea', 'bread'),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((rows) => {
    const items: Item[] = []
    for (const [index, row] of rows.entries()) {
      const previous = index === 0 ? -1 : items[index - 1].depth
      // climb 4 -> one deeper; 3 -> same depth; lower -> shallower, so
      // deep trees and returns to the top are both common.
      const depth = Math.max(0, Math.min(previous + 1, previous + 1 - (4 - row.climb)))
      items.push({ depth: index === 0 ? 0 : depth, ordered: row.ordered, text: row.text })
    }
    return items
  })

const presses = fc.commands([fc.constant(new Indent()), fc.constant(new Outdent())], {
  size: '+1',
})

/**
 * Measured: 200 runs take 5.4s on an idle machine — about 27ms per run, a
 * full remark parse after every press. Sixty runs keep it near 2s alone;
 * the ceiling is for the parallel suite, where a 5s default reads as a
 * property failure (see integrator-flow.md, CI flakes).
 */
const RUNS = 60
const CEILING_MS = 30_000

describe('indent and outdent as moves on the list tree', () => {
  fcTest.prop([initialItems, presses], withDefaults({ numRuns: RUNS }))(
    'after every press the parsed list has the depths the table says',
    (initial, cmds) => {
      fc.modelRun(() => {
        const doc = render(initial)
        const model: Model = { items: initial.map((item) => ({ ...item })) }
        const real: Real = {
          state: EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) }),
        }
        judge(model, real)
        return { model, real }
      }, cmds)
    },
    CEILING_MS,
  )
})
