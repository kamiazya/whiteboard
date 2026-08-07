// Guard for the measured-vs-declared font invariant on markdown body runs.
//
// Body runs are positioned per word at absolute x coordinates computed from
// `measure`, so the SVG must declare the same family the measurement used —
// a run drawn in any other family renders each word at a width the layout
// did not account for, and the error shows up as visibly uneven word gaps
// (the defect this file exists to pin). Labels already hold this invariant
// via `resolveLabel()`; this covers the markdown body path.
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect, it } from 'vitest'
import type { Scene, SceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const measure = createFakeMeasure()

/**
 * Every text run in the scene, at any depth. Walks every array-valued field
 * whose elements carry a `kind` (paragraphs/headings hold `runs`, list items
 * and table cells hold `children`), so a new nesting shape cannot silently
 * escape this guard.
 */
function collectRuns(scene: Scene): TextRunNode[] {
  const out: TextRunNode[] = []
  const stack: SceneNode[] = [...scene.nodes]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.kind === 'textRun') out.push(node)
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue
      for (const entry of value) {
        if (typeof entry === 'object' && entry !== null && 'kind' in entry) {
          stack.push(entry as SceneNode)
        }
      }
    }
  }
  return out
}

// Exercises every run-producing construct: headings, paragraph phrasing
// (plain/strong/code/link), a nested list, and a table.
const root: MdastRoot = {
  type: 'root',
  children: [
    { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title words here' }] },
    {
      type: 'paragraph',
      children: [
        { type: 'text', value: 'plain then ' },
        { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
        { type: 'text', value: ' then ' },
        { type: 'inlineCode', value: 'code()' },
        { type: 'text', value: ' then a ' },
        {
          type: 'link',
          url: 'https://example.com',
          children: [{ type: 'text', value: 'link label' }],
        },
      ],
    },
    {
      type: 'list',
      ordered: false,
      children: [
        {
          type: 'listItem',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item words' }] }],
        },
      ],
    },
    {
      type: 'table',
      children: [
        {
          type: 'tableRow',
          children: [
            { type: 'tableCell', children: [{ type: 'text', value: 'cell one' }] },
            { type: 'tableCell', children: [{ type: 'text', value: 'cell two' }] },
          ],
        },
      ],
    },
  ],
}

describe('layoutMdastBlocks — declared font family matches the measured one', () => {
  it('stamps the measuring family onto every emitted text run, at every depth', () => {
    const scene = layoutMdastBlocks(root, {
      measure,
      maxWidth: 600,
      fontFamily: 'GuardFamily',
    })
    const runs = collectRuns(scene)
    expect(runs.length).toBeGreaterThan(8)
    for (const run of runs) {
      expect(run.appearance?.fontFamily, `run "${run.text}"`).toBe('GuardFamily')
    }
  })

  it('never emits a run whose declared family differs from another run in the same scene', () => {
    const scene = layoutMdastBlocks(root, {
      measure,
      maxWidth: 600,
      fontFamily: 'OneFamily',
    })
    const families = new Set(collectRuns(scene).map((run) => run.appearance?.fontFamily))
    expect([...families]).toEqual(['OneFamily'])
  })
})

describe('measured-vs-declared font SIZE on markdown runs', () => {
  it('a heading run declares the size it was measured at, not the inherited default', () => {
    // Headings are measured at HEADING_FONT_SIZE_PX[depth]; a run that then
    // draws at the host's inherited size renders every wrap width and block
    // height wrong AND flattens the visual hierarchy (h1 == body). Same
    // invariant class as the fontFamily guard above, for size.
    const root: MdastRoot = {
      type: 'root',
      children: [
        { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] },
        { type: 'paragraph', children: [{ type: 'text', value: 'body' }] },
      ],
    }
    const runs = collectRuns(
      layoutMdastBlocks(root, { measure, maxWidth: 400, fontFamily: 'Roboto' }),
    )
    const heading = runs.find((run) => run.text === 'Title')
    const body = runs.find((run) => run.text === 'body')
    expect(heading?.appearance?.fontSize).toBe(32)
    expect(body?.appearance?.fontSize).toBe(16)
  })

  it('list items draw their marker glyph (bullet / ordinal) as a measured run', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'alpha' }] }],
            },
          ],
        },
        {
          type: 'list',
          ordered: true,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'first' }] }],
            },
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'second' }] }],
            },
          ],
        },
      ],
    }
    const runs = collectRuns(
      layoutMdastBlocks(root, { measure, maxWidth: 400, fontFamily: 'Roboto' }),
    )
    const texts = runs.map((run) => run.text)
    expect(texts).toContain('\u2022')
    expect(texts).toContain('1.')
    expect(texts).toContain('2.')
    // Markers sit in the indent gutter, left of the content (wrapper-relative
    // negative x, since the listItem wrapper translates by its own bbox.x).
    const bullet = runs.find((run) => run.text === '\u2022')
    expect((bullet?.bbox.x ?? 0) < 0).toBe(true)
  })
})
