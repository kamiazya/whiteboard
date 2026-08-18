import { describe, expect, it } from 'vitest'
import type { Scene, TextRunNode } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

/**
 * The fade a truncated run is painted with. ONE `<mask>` in `<defs>` serves
 * every truncated run in the document — `maskContentUnits="objectBoundingBox"`
 * scales it to each element's own box — so the cost is a fixed preamble
 * rather than a definition per run. Emitted only when something is actually
 * truncated, which is what keeps every existing golden byte-identical.
 */
const run = (text: string, truncated?: true): TextRunNode => ({
  kind: 'textRun',
  bbox: { x: 0, y: 0, w: 40, h: 16 },
  baseline: 12,
  text,
  ...(truncated ? { truncated } : {}),
})

describe('truncation fade', () => {
  it('emits nothing when no run is truncated', () => {
    const svg = renderSceneToSvg({ nodes: [run('plain')] } as Scene)
    expect(svg).not.toContain('<defs>')
    expect(svg).not.toContain('mask=')
  })

  it('emits one shared mask and references it from every truncated run', () => {
    const svg = renderSceneToSvg({
      nodes: [run('cut', true), run('also cut', true), run('plain')],
    } as Scene)
    expect(svg.match(/<mask /g)).toHaveLength(1)
    expect(svg.match(/mask="url\(#/g)).toHaveLength(2)
    expect(svg).toContain('maskContentUnits="objectBoundingBox"')
  })

  it('puts the defs ahead of the scene body, inside the root', () => {
    const svg = renderSceneToSvg({ nodes: [run('cut', true)] } as Scene)
    expect(svg.indexOf('<defs>')).toBeLessThan(svg.indexOf('<text'))
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg">')).toBe(true)
  })
})
