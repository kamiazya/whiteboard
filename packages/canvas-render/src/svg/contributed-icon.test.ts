// An icon set has a COORDINATE SPACE and a PAINT CONVENTION, and geometry is
// meaningless without both. `SvgDocumentOptions.icons` accepted geometry
// alone and drew every entry into lucide's 24x24 box under lucide's
// stroke-only styling — so a contributed icon drawn in any other space came
// out the wrong size and clipped, and a contributed icon that wants a FILL
// came out invisible.
//
// Measured before this, with a 100x100 square in a 48px box:
//   <symbol viewBox="0 0 24 24"><g fill="none" stroke-width="2">
//     <rect x="0" y="0" width="100" height="100"/>
import { describe, expect, it } from 'vitest'
import type { Scene } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

const sceneWith = (icon: string): Scene => ({
  nodes: [{ kind: 'icon', bbox: { x: 0, y: 0, w: 48, h: 48 }, icon }],
})

const SQUARE = [{ tag: 'rect', x: 0, y: 0, width: 100, height: 100 }] as const

describe('a contributed icon', () => {
  it('is drawn in the coordinate space its own set declares', () => {
    const svg = renderSceneToSvg(sceneWith('demo.box'), {
      icons: { 'demo.box': { geometry: SQUARE, viewBox: '0 0 100 100' } },
    })
    expect(svg).toContain('viewBox="0 0 100 100"')
    expect(svg).not.toContain('viewBox="0 0 24 24"')
  })

  it('is painted the way its own set declares, so a filled icon is visible', () => {
    const svg = renderSceneToSvg(sceneWith('demo.box'), {
      icons: {
        'demo.box': { geometry: SQUARE, viewBox: '0 0 100 100', paint: { fill: 'currentColor' } },
      },
    })
    // Not lucide's stroke-only convention, which renders a filled shape as
    // nothing at all.
    expect(svg).toContain('fill="currentColor"')
    expect(svg).not.toContain('fill="none"')
  })

  it('falls back to the renderer’s own space when a set declares none', () => {
    // A table that says nothing still has to draw something, and 24x24
    // stroke-only is what every icon in this repo is authored for.
    const svg = renderSceneToSvg(sceneWith('demo.box'), {
      icons: { 'demo.box': { geometry: SQUARE } },
    })
    expect(svg).toContain('viewBox="0 0 24 24"')
  })

  it('leaves the bundled set drawing exactly as it did', () => {
    // `visual`'s own icons declare their space and paint rather than relying
    // on the fallback above — the renderer holding one plugin's conventions
    // as its default is the coupling this seam exists to remove.
    const svg = renderSceneToSvg(sceneWith('star'))
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke-width="2"')
  })
})
