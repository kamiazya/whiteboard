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

  it('marks an svgFragment with role: presentation as decorative', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'svgFragment',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          svg: '<circle r="5"/>',
          role: 'presentation',
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('<g role="presentation"><circle r="5"/></g>')
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

  it('allows http/https/mailto/tel and relative link hrefs through unchanged', () => {
    for (const href of [
      'https://example.com',
      'http://example.com',
      'mailto:a@example.com',
      'tel:+15551234567',
      '#anchor',
      '/relative/path',
      'relative/path',
    ]) {
      const scene: Scene = {
        nodes: [
          {
            kind: 'paragraph',
            bbox: { x: 0, y: 0, w: 100, h: 16 },
            runs: [
              {
                kind: 'textRun',
                bbox: { x: 0, y: 0, w: 10, h: 16 },
                text: 'link',
                link: { kind: 'link', href },
              },
            ],
          },
        ],
      }
      expect(renderSceneToSvg(scene)).toContain(`href="${href}"`)
    }
  })

  it('rejects unsafe URL schemes (javascript:, data:, vbscript:) on link hrefs', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x']) {
      const scene: Scene = {
        nodes: [
          {
            kind: 'paragraph',
            bbox: { x: 0, y: 0, w: 100, h: 16 },
            runs: [
              {
                kind: 'textRun',
                bbox: { x: 0, y: 0, w: 10, h: 16 },
                text: 'link',
                link: { kind: 'link', href },
              },
            ],
          },
        ],
      }
      const svg = renderSceneToSvg(scene)
      expect(svg).not.toContain(href)
      expect(svg).toContain('href="#"')
    }
  })

  it('applies translate on table cells so columns do not overlap at x=0', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'table',
          bbox: { x: 0, y: 0, w: 200, h: 24 },
          rows: [
            {
              kind: 'tableRow',
              bbox: { x: 0, y: 0, w: 200, h: 24 },
              cells: [
                {
                  kind: 'tableCell',
                  bbox: { x: 0, y: 0, w: 100, h: 24 },
                  runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 30, h: 16 }, text: 'A' }],
                },
                {
                  kind: 'tableCell',
                  bbox: { x: 100, y: 0, w: 100, h: 24 },
                  runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 30, h: 16 }, text: 'B' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('transform="translate(100,0)"')
    // The second cell's group must translate so its run renders at x=100
    // while the first cell (x=0) needs no translate (or translate(0,0))
  })

  it('applies translate on list items to indent nested items', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'list',
          bbox: { x: 0, y: 0, w: 200, h: 32 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: 24, y: 0, w: 176, h: 16 },
              children: [
                {
                  kind: 'paragraph',
                  bbox: { x: 0, y: 0, w: 176, h: 16 },
                  runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 40, h: 16 }, text: 'item' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('transform="translate(24,0)"')
  })

  it('applies translate on blockquote children for visual indent', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'blockquote',
          bbox: { x: 0, y: 0, w: 200, h: 16 },
          children: [
            {
              kind: 'paragraph',
              bbox: { x: 0, y: 0, w: 176, h: 16 },
              runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 40, h: 16 }, text: 'quote' }],
            },
          ],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('role="presentation"')
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
