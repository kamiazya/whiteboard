// Guard for the measured-vs-declared font invariant on markdown body runs.
//
// Body runs are positioned per word at absolute x coordinates computed from
// `measure`, so the SVG must declare the same family the measurement used —
// a run drawn in any other family renders each word at a width the layout
// did not account for, and the error shows up as visibly uneven word gaps
// (the defect this file exists to pin). Labels already hold this invariant
// via `resolveLabel()`; this covers the markdown body path.
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { MeasureText } from '../../measure.js'
import type { Scene, SceneNode, TextRunNode } from '../../scene-graph.js'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { MARKDOWN_THEME_NODE } from '../../theme/markdown-theme.js'
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

/**
 * A measurer that records which family every string was measured in. The
 * invariant is per-RUN, not per-scene: a code run is deliberately measured
 * AND declared in the mono family, so "one family everywhere" would now be
 * the wrong assertion. Recording the pairs pins the thing that actually
 * matters — a run declares the family its own x coordinates came from.
 */
function recordingMeasure() {
  const base = createFakeMeasure()
  const seen = new Map<string, Set<string>>()
  const spy: MeasureText = (text, font) => {
    const families = seen.get(text) ?? new Set<string>()
    families.add(font.family)
    seen.set(text, families)
    return base(text, font)
  }
  return { measure: spy, seen }
}

describe('layoutMdastBlocks — declared font family matches the measured one', () => {
  it('declares, on every run at every depth, a family that run was measured in', () => {
    const { measure: spy, seen } = recordingMeasure()
    const scene = layoutMdastBlocks(root, {
      measure: spy,
      maxWidth: 600,
      fontFamily: 'GuardFamily',
    })
    const runs = collectRuns(scene)
    expect(runs.length).toBeGreaterThan(8)
    for (const run of runs) {
      const declared = run.appearance?.fontFamily
      expect(declared, `run "${run.text}" declares no family`).toBeDefined()
      expect(
        seen.get(run.text)?.has(declared as string),
        `run "${run.text}" declares ${declared} but was never measured in it`,
      ).toBe(true)
    }
  })

  it("uses exactly two families: the caller's for prose, the mono one for code", () => {
    const scene = layoutMdastBlocks(root, {
      measure,
      maxWidth: 600,
      fontFamily: 'OneFamily',
    })
    const runs = collectRuns(scene)
    // Code runs are the ONLY exception to the caller's family, and they are
    // the reason the old "one family per scene" form of this guard had to
    // go. Splitting by the `code` flag keeps the exception explicit: a
    // prose run picking up the mono family would still fail here.
    for (const run of runs) {
      expect(run.appearance?.fontFamily, `run "${run.text}"`).toBe(
        run.code === true ? MARKDOWN_THEME_NODE.monoFontFamily : 'OneFamily',
      )
    }
    expect(runs.some((run) => run.code === true)).toBe(true)
    expect(runs.some((run) => run.code !== true)).toBe(true)
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
    expect(heading?.appearance?.fontSize).toBe(MARKDOWN_THEME_NODE.headingFontSizePx[1])
    expect(body?.appearance?.fontSize).toBe(MARKDOWN_THEME_NODE.bodyFontSizePx)
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

describe('emphasis flags reach the measurer — bold is wider, so it must be measured bold', () => {
  const root = (md: { strong?: boolean; emphasis?: boolean }): MdastRoot => ({
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'plain ' },
          md.strong
            ? { type: 'strong', children: [{ type: 'text', value: 'loud' }] }
            : { type: 'emphasis', children: [{ type: 'text', value: 'lean' }] },
        ],
      },
    ],
  })

  it('a strong run is measured at weight 700 and an emphasis run at style italic', () => {
    const seen: { text: string; weight: number; style: string }[] = []
    const spy: typeof measure = (text, font) => {
      seen.push({ text, weight: font.weight, style: font.style })
      return measure(text, font)
    }
    layoutMdastBlocks(root({ strong: true }), {
      measure: spy,
      maxWidth: 600,
      fontFamily: 'Test',
    })
    expect(seen.find((s) => s.text === 'loud')?.weight).toBe(700)
    expect(seen.find((s) => s.text === 'plain')?.weight).toBe(400)

    seen.length = 0
    layoutMdastBlocks(root({ emphasis: true }), {
      measure: spy,
      maxWidth: 600,
      fontFamily: 'Test',
    })
    expect(seen.find((s) => s.text === 'lean')?.style).toBe('italic')
    expect(seen.find((s) => s.text === 'plain')?.style).toBe('normal')
  })

  it('a boundary space inside a styled span is measured with that style too', () => {
    const seen: { text: string; weight: number }[] = []
    const spy: typeof measure = (text, font) => {
      seen.push({ text, weight: font.weight })
      return measure(text, font)
    }
    // **a *i* b** — the ' b' chunk starts with a boundary space and is
    // walked under { strong: true }; its space ADVANCE must be bold-width,
    // or the gap next to a styled run comes out regular-sized.
    layoutMdastBlocks(
      {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'strong',
                children: [
                  { type: 'text', value: 'a ' },
                  { type: 'emphasis', children: [{ type: 'text', value: 'i' }] },
                  { type: 'text', value: ' b' },
                ],
              },
            ],
          },
        ],
      },
      { measure: spy, maxWidth: 600, fontFamily: 'Test' },
    )
    const spaceMeasurements = seen.filter((s) => s.text === ' ')
    expect(spaceMeasurements.length).toBeGreaterThan(0)
    expect(spaceMeasurements.every((s) => s.weight === 700)).toBe(true)
  })
})
