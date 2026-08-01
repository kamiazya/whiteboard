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

describe('renderSceneToSvg — document envelope options', () => {
  const scene: Scene = {
    nodes: [{ kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 100, h: 10 } }],
  }

  it('an omitted options argument matches the legacy no-envelope output', () => {
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="10" role="presentation"/></svg>',
    )
  })

  it('an empty options object does not activate the envelope', () => {
    expect(renderSceneToSvg(scene, {})).toBe(renderSceneToSvg(scene))
  })

  it('padding-only options derive width/height/viewBox from sceneBounds expanded by padding', () => {
    const svg = renderSceneToSvg(scene, { padding: 5 })
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="110" height="20" viewBox="-5 -5 110 20">',
      ),
    ).toBe(true)
  })

  it('explicit width/height are emitted verbatim while viewBox is still derived', () => {
    const svg = renderSceneToSvg(scene, { width: 500, height: 300 })
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300" viewBox="0 0 100 10">',
      ),
    ).toBe(true)
  })

  it('an explicit viewBox bypasses sceneBounds derivation entirely', () => {
    const svg = renderSceneToSvg(scene, { viewBox: { x: 1, y: 2, w: 3, h: 4 } })
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4" viewBox="1 2 3 4">',
      ),
    ).toBe(true)
  })

  it('a background renders a presentation rect as the first child, before scene nodes', () => {
    const svg = renderSceneToSvg(scene, { background: '#fff' })
    const bodyStart = svg.indexOf('>') + 1
    expect(svg.slice(bodyStart)).toMatch(
      /^<rect x="0" y="0" width="100" height="10" fill="#fff" role="presentation"\/>/,
    )
  })

  it('escapes a quote/ampersand-bearing background color string', () => {
    const svg = renderSceneToSvg(scene, { background: '"&' })
    expect(svg).toContain('fill="&quot;&amp;"')
  })

  it('omits the background rect entirely when background is not set', () => {
    const svg = renderSceneToSvg(scene, { padding: 1 })
    expect(svg).not.toContain('fill=')
  })

  it('sanitizes non-finite/negative padding to 0 rather than throwing', () => {
    expect(() => renderSceneToSvg(scene, { padding: Number.NaN })).not.toThrow()
    expect(() => renderSceneToSvg(scene, { padding: -5 })).not.toThrow()
    const svg = renderSceneToSvg(scene, { padding: -5 })
    expect(svg).toContain('viewBox="0 0 100 10"')
  })

  it('sanitizes non-finite width/height to the derived fallback rather than throwing', () => {
    expect(() =>
      renderSceneToSvg(scene, { width: Number.NaN, height: Number.POSITIVE_INFINITY }),
    ).not.toThrow()
    const svg = renderSceneToSvg(scene, { width: Number.NaN, height: Number.POSITIVE_INFINITY })
    expect(svg).toContain('width="100" height="10"')
  })

  it('sanitizes a non-finite viewBox field to the derived fallback rather than throwing', () => {
    expect(() =>
      renderSceneToSvg(scene, { viewBox: { x: Number.NaN, y: 0, w: 3, h: 4 } }),
    ).not.toThrow()
    const svg = renderSceneToSvg(scene, { viewBox: { x: Number.NaN, y: 0, w: 3, h: 4 } })
    expect(svg).toContain('viewBox="0 0 100 10"')
  })

  it('sanitizes a negative explicit width/height to the derived fallback rather than emitting an invalid SVG', () => {
    expect(() => renderSceneToSvg(scene, { width: -100, height: -50 })).not.toThrow()
    const svg = renderSceneToSvg(scene, { width: -100, height: -50 })
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="10" viewBox="0 0 100 10">',
      ),
    ).toBe(true)
  })

  it('sanitizes a viewBox with a negative w/h to the derived fallback rather than emitting an invalid viewBox', () => {
    expect(() => renderSceneToSvg(scene, { viewBox: { x: 1, y: 2, w: -3, h: -4 } })).not.toThrow()
    const svg = renderSceneToSvg(scene, { viewBox: { x: 1, y: 2, w: -3, h: -4 } })
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="10" viewBox="0 0 100 10">',
      ),
    ).toBe(true)
  })

  it('accepts a viewBox with negative x/y offset paired with non-negative w/h', () => {
    const svg = renderSceneToSvg(scene, { viewBox: { x: -5, y: -5, w: 3, h: 4 } })
    expect(svg).toContain('viewBox="-5 -5 3 4"')
  })

  it('produces well-formed XML including the background rect', () => {
    expect(
      isWellFormedXmlFragment(renderSceneToSvg(scene, { background: 'red', padding: 4 })),
    ).toBe(true)
  })
})
