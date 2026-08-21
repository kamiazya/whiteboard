import { describe, expect, it } from 'vitest'
import type { Scene } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

const icon = (name: string, x = 0): Scene['nodes'][number] => ({
  kind: 'icon',
  icon: name,
  bbox: { x, y: 0, w: 16, h: 16 },
  appearance: { stroke: '#333' },
})

describe('icon nodes render as shared <symbol> defs referenced by <use>', () => {
  it('one icon: symbol def with the vendored geometry, stroke-styled use', () => {
    const svg = renderSceneToSvg({ nodes: [icon('lock')] })
    expect(svg).toContain(
      '<symbol id="wb-icon-lock" viewBox="0 0 24 24"><g fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    )
    expect(svg).toContain('<rect x="3" y="11" width="18" height="11" rx="2"/>')
    expect(svg).toContain(
      '<use href="#wb-icon-lock" x="0" y="0" width="16" height="16" stroke="#333"/>',
    )
  })

  it('two same-name icons share ONE symbol definition with two uses', () => {
    const svg = renderSceneToSvg({ nodes: [icon('star'), icon('star', 40)] })
    expect(svg.match(/<symbol /g)).toHaveLength(1)
    expect(svg.match(/<use /g)).toHaveLength(2)
  })

  it('an unknown icon name renders nothing and declares nothing (degrades, never throws)', () => {
    const svg = renderSceneToSvg({ nodes: [icon('no-such-icon')] })
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })

  it("the use element carries the appearance's stroke-opacity", () => {
    const faded: Scene = {
      nodes: [
        {
          kind: 'icon',
          icon: 'star',
          bbox: { x: 0, y: 0, w: 16, h: 16 },
          appearance: { stroke: '#333', strokeOpacity: 0.5 },
        },
      ],
    }
    expect(renderSceneToSvg(faded)).toContain('stroke="#333" stroke-opacity="0.5"/>')
  })

  it('a non-finite bbox renders nothing', () => {
    const bad: Scene = {
      nodes: [{ kind: 'icon', icon: 'star', bbox: { x: Number.NaN, y: 0, w: 16, h: 16 } }],
    }
    expect(renderSceneToSvg(bad)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })
})
