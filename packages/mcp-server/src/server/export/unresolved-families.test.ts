import type { Scene } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { unresolvedFamilies } from './unresolved-families.js'

const run = (fontFamily: string) => ({
  kind: 'textRun' as const,
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  baseline: 8,
  text: 'x',
  appearance: { fontFamily },
})
const scene = (...families: string[]): Scene => ({ nodes: families.map(run) }) as unknown as Scene

describe('the families a render declared but could not resolve', () => {
  it('says nothing when every declared family is loaded', () => {
    expect(unresolvedFamilies(scene('Roboto'), ['Roboto'])).toEqual([])
  })

  it('names a family no loaded face provides', () => {
    expect(unresolvedFamilies(scene('Roboto', 'Comic Sans'), ['Roboto'])).toEqual(['Comic Sans'])
  })

  it('accepts a CSS chain when ANY name in it is loaded, as resvg does', () => {
    expect(unresolvedFamilies(scene('Menlo, Roboto, monospace'), ['Roboto'])).toEqual([])
  })

  // The case that exists today: a fenced code run declares the mono chain the
  // markdown theme carries, and the export has only the vendored Latin face.
  it('reports the markdown mono chain against a Roboto-only export', () => {
    const mono =
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    expect(unresolvedFamilies(scene('Roboto', mono), ['Roboto'])).toEqual([mono])
  })

  it('does not count a generic keyword as a resolution, because no face backs it', () => {
    expect(unresolvedFamilies(scene('monospace'), ['Roboto'])).toEqual(['monospace'])
  })

  it('strips quotes and matches case-insensitively', () => {
    expect(unresolvedFamilies(scene('"Roboto Mono"'), ['roboto mono'])).toEqual([])
  })

  it('reports each distinct declaration once, in first-seen order', () => {
    const s = scene('A', 'B', 'A')
    expect(unresolvedFamilies(s, ['Roboto'])).toEqual(['A', 'B'])
  })

  it('walks nested runs, which is where code and table text live', () => {
    const nested = {
      nodes: [
        { kind: 'codeBlock', bbox: { x: 0, y: 0, w: 1, h: 1 }, runs: [run('Mono')] },
        {
          kind: 'table',
          bbox: { x: 0, y: 0, w: 1, h: 1 },
          rows: [{ cells: [{ runs: [run('Cell')] }] }],
        },
      ],
    } as unknown as Scene
    expect(unresolvedFamilies(nested, ['Roboto'])).toEqual(['Mono', 'Cell'])
  })

  it('says nothing when no face was loaded at all, matching undrawable', () => {
    // No parsed face means the render already degraded to system fonts, which
    // is logged where it happens; a second, louder report there would be wrong.
    expect(unresolvedFamilies(scene('Roboto'), [])).toEqual([])
  })
})
