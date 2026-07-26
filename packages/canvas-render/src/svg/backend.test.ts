import { describe, expect, it } from 'vitest'
import type { Scene } from '../scene-graph.js'
import { isWellFormedXmlFragment } from '../test-utils/xml-well-formed.js'
import { renderSceneToSvg } from './backend.js'

describe('renderSceneToSvg', () => {
  it('emits a single root svg element with one xmlns', () => {
    const scene: Scene = { nodes: [] }
    const svg = renderSceneToSvg(scene)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.match(/xmlns=/g)).toHaveLength(1)
  })

  it('escapes text content and marks decorative nodes as role=presentation', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'thematicBreak',
          bbox: { x: 0, y: 0, w: 10, h: 1 },
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('role="presentation"')
  })

  it('escapes & < > in a text run', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 100, h: 16 },
          runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 10, h: 16 }, text: 'a & b < c > d' }],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('a &amp; b &lt; c &gt; d')
  })

  it('emits an already-validated SVG fragment verbatim, wrapped in a group', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'svgFragment',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          svg: '<circle r="5"/>',
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('<g><circle r="5"/></g>')
  })

  it('produces well-formed XML (balanced, single-root, no unescaped raw &/</>)', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 100, h: 16 },
          runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 10, h: 16 }, text: 'hello & <world>' }],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(isWellFormedXmlFragment(svg)).toBe(true)
  })

  it('is deterministic: same scene renders byte-identical output on repeated calls', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 10, h: 1 } },
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 2, w: 100, h: 16 },
          runs: [{ kind: 'textRun', bbox: { x: 0, y: 2, w: 10, h: 16 }, text: 'hello' }],
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(scene))
  })
})
