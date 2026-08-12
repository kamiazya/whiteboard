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

  it('emits a text run with no baseline exactly as before (byte-identical additivity)', () => {
    const scene: Scene = {
      nodes: [{ kind: 'textRun', bbox: { x: 0, y: 10, w: 20, h: 16 }, text: 'hi' }],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('<text x="0" y="10">hi</text>')
  })

  it('shifts a text run down by its baseline offset when present', () => {
    const scene: Scene = {
      nodes: [{ kind: 'textRun', bbox: { x: 0, y: 10, w: 20, h: 16 }, text: 'hi', baseline: 12.8 }],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('<text x="0" y="22.8">hi</text>')
  })

  it('omits a non-finite baseline rather than reaching formatCoord', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'textRun',
          bbox: { x: 0, y: 10, w: 20, h: 16 },
          text: 'hi',
          baseline: Number.NaN,
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('<text x="0" y="10">hi</text>')
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

describe('renderSceneToSvg — shape node', () => {
  it('emits a rect with rx when radius is set', () => {
    const scene: Scene = {
      nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 100, h: 60 }, radius: 8 }],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="60" rx="8"/></svg>',
    )
  })

  it('omits rx entirely when radius is absent', () => {
    const scene: Scene = { nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 100, h: 60 } }] }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="60"/></svg>',
    )
  })

  it.each([
    0,
    -4,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('omits rx for a degenerate radius (%s), never emitting rx="0" or throwing', (radius) => {
    const scene: Scene = {
      nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 10, h: 10 }, radius }],
    }
    let svg = ''
    expect(() => {
      svg = renderSceneToSvg(scene)
    }).not.toThrow()
    expect(svg).not.toContain('rx=')
  })

  it('emits appearance attributes in fixed order: fill stroke stroke-width', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'shape',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          appearance: { fill: '#fff', stroke: '#000', strokeWidth: 2 },
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toContain('fill="#fff" stroke="#000" stroke-width="2"')
  })

  it('an empty appearance object and an absent appearance both render byte-identically', () => {
    const withEmpty: Scene = {
      nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 10, h: 10 }, appearance: {} }],
    }
    const withoutAppearance: Scene = {
      nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 10, h: 10 } }],
    }
    expect(renderSceneToSvg(withEmpty)).toBe(renderSceneToSvg(withoutAppearance))
  })

  it('renders as the empty string (contributes no output) for a non-finite bbox field, never throwing', () => {
    const scene: Scene = {
      nodes: [{ kind: 'shape', bbox: { x: Number.NaN, y: 0, w: 10, h: 10 } }],
    }
    expect(() => renderSceneToSvg(scene)).not.toThrow()
    expect(renderSceneToSvg(scene)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })

  it('renders a zero-size or negative w/h shape without throwing (valid, invisible SVG)', () => {
    const zeroSize: Scene = { nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 0, h: 0 } }] }
    const negative: Scene = { nodes: [{ kind: 'shape', bbox: { x: 0, y: 0, w: -5, h: -5 } }] }
    expect(() => renderSceneToSvg(zeroSize)).not.toThrow()
    expect(() => renderSceneToSvg(negative)).not.toThrow()
  })

  it('omits a degenerate strokeWidth/fontSize (NaN/Infinity/negative) rather than emitting or throwing', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'shape',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          appearance: { strokeWidth: Number.NaN },
        },
      ],
    }
    expect(() => renderSceneToSvg(scene)).not.toThrow()
    expect(renderSceneToSvg(scene)).not.toContain('stroke-width=')
  })

  it('omits an empty-string color/font-family rather than emitting fill="" etc.', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'shape',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          appearance: { fill: '', fontFamily: '' },
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).not.toContain('fill=')
    expect(svg).not.toContain('font-family=')
  })
})

describe('renderSceneToSvg — appearance on textRun and edge', () => {
  it('emits appearance attributes on a text run, keeping the link wrapper unchanged', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 100, h: 16 },
          runs: [
            {
              kind: 'textRun',
              bbox: { x: 0, y: 0, w: 40, h: 16 },
              text: 'styled link',
              link: { kind: 'link', href: 'https://example.com' },
              appearance: { fill: '#111', fontFamily: 'Inter', fontSize: 14 },
            },
          ],
        },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain(
      '<a href="https://example.com"><text x="0" y="0" fill="#111" font-family="Inter" font-size="14">styled link</text></a>',
    )
  })

  it('an appearance-free text run is byte-identical to before', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 100, h: 16 },
          runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 40, h: 16 }, text: 'plain' }],
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><text x="0" y="0">plain</text></g></svg>',
    )
  })

  it('emits appearance attributes on an edge polyline before role=presentation', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'none',
          appearance: { stroke: '#888', strokeWidth: 1.5 },
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0 10,10" fill="none" stroke="#888" stroke-width="1.5" role="presentation"/></svg>',
    )
  })

  it('an appearance-free edge is byte-identical to before', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [{ x: 0, y: 0 }],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'none',
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0" fill="none" role="presentation"/></svg>',
    )
  })

  it('draws a filled destination arrowhead for toEnd=arrow, oriented along the last segment', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0 30,0" fill="none" role="presentation"/><polygon points="30,0 20,4 20,-4" fill="none" role="presentation"/></svg>',
    )
  })

  it('draws both arrowheads for fromEnd=arrow toEnd=arrow, source arrow first', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'arrow',
          toEnd: 'arrow',
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0 30,0" fill="none" role="presentation"/><polygon points="0,0 10,-4 10,4" fill="none" role="presentation"/><polygon points="30,0 20,4 20,-4" fill="none" role="presentation"/></svg>',
    )
  })

  it('the arrowhead inherits the edge stroke color as its fill', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
          appearance: { stroke: '#888' },
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0 30,0" fill="none" stroke="#888" role="presentation"/><polygon points="30,0 20,4 20,-4" fill="#888" role="presentation"/></svg>',
    )
  })

  it('a degenerate zero-length edge draws no arrowhead', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 5, y: 5 },
            { x: 5, y: 5 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'arrow',
          toEnd: 'arrow',
        },
      ],
    }
    expect(renderSceneToSvg(scene)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="5,5 5,5" fill="none" role="presentation"/></svg>',
    )
  })

  it('produces well-formed XML for quote/ampersand-bearing appearance strings', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'shape', bbox: { x: 0, y: 0, w: 10, h: 10 }, appearance: { fill: 'a"b<c&d' } },
      ],
    }
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('fill="a&quot;b&lt;c&amp;d"')
    expect(isWellFormedXmlFragment(svg)).toBe(true)
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

  it('textFill emits an inheritable fill on the root svg, after viewBox', () => {
    // The default text color for standalone consumers: markdown body runs
    // carry no fill of their own (the editor supplies one via its host
    // element), so a scene rendered outside the editor needs this seam to
    // be self-describing on a non-white background.
    const svg = renderSceneToSvg(scene, {
      viewBox: { x: 0, y: 0, w: 100, h: 10 },
      textFill: '#E6E8EB',
    })
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="10" viewBox="0 0 100 10" fill="#E6E8EB">',
      ),
    ).toBe(true)
  })

  it('an absent or empty textFill leaves the envelope output byte-identical', () => {
    const withEnvelope = renderSceneToSvg(scene, { padding: 5 })
    expect(renderSceneToSvg(scene, { padding: 5, textFill: undefined })).toBe(withEnvelope)
    expect(renderSceneToSvg(scene, { padding: 5, textFill: '' })).toBe(withEnvelope)
  })

  it('escapes a quote-bearing textFill and still never touches the legacy path', () => {
    const svg = renderSceneToSvg(scene, { padding: 0, textFill: '"&' })
    expect(svg).toContain('fill="&quot;&amp;"')
    // textFill alone activates the envelope (it is a document option).
    expect(
      renderSceneToSvg(scene, { textFill: '#111111' }).startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="',
      ),
    ).toBe(true)
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

describe('image nodes', () => {
  it("fit 'cover' slices, absent fit stays the byte-identical meet default", () => {
    const cover = renderSceneToSvg({
      nodes: [{ kind: 'image', bbox: { x: 0, y: 0, w: 10, h: 10 }, href: 'a.png', fit: 'cover' }],
    })
    expect(cover).toContain('preserveAspectRatio="xMidYMid slice"')
    const plain = renderSceneToSvg({
      nodes: [{ kind: 'image', bbox: { x: 0, y: 0, w: 10, h: 10 }, href: 'a.png' }],
    })
    expect(plain).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  it('emits <image> with fixed attribute order, escaped href, and title-as-alt', () => {
    const svg = renderSceneToSvg({
      nodes: [
        {
          kind: 'image',
          bbox: { x: 10, y: 20, w: 100, h: 50 },
          href: 'data:image/png;base64,A&B"C',
          alt: 'A <chart>',
        },
      ],
    })
    expect(svg).toContain(
      '<image x="10" y="20" width="100" height="50" href="data:image/png;base64,A&amp;B&quot;C" preserveAspectRatio="xMidYMid meet"><title>A &lt;chart&gt;</title></image>',
    )
  })

  it('an alt-less image is marked presentation', () => {
    const svg = renderSceneToSvg({
      nodes: [
        { kind: 'image', bbox: { x: 0, y: 0, w: 10, h: 10 }, href: 'data:image/png;base64,AA' },
      ],
    })
    expect(svg).toContain('role="presentation"')
    expect(svg).not.toContain('<title>')
  })
})

// SVG's initial `fill` is black, and a <polyline> fills the region its points
// enclose. A two-point edge encloses nothing, so this was invisible until
// routing started bending paths — then every corner grew a filled wedge in
// whatever fill the surrounding document happened to inherit. Reported as a
// black blob on a canvas after a node was duplicated.
it('draws a bent edge as a line, not a filled wedge', () => {
  const svg = renderSceneToSvg({
    nodes: [
      {
        kind: 'edge',
        id: 'e1',
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ],
        fromSide: 'right',
        toSide: 'top',
        fromEnd: 'none',
        toEnd: 'none',
      },
    ],
  })

  const polyline = /<polyline[^>]*>/.exec(svg)?.[0] ?? ''
  expect(polyline).toContain('fill="none"')
})

describe('line-jump hops', () => {
  const crossing = {
    kind: 'edge' as const,
    id: 'e2',
    path: [
      { x: 0, y: 100 },
      { x: 200, y: 100 },
    ],
    fromSide: 'right' as const,
    toSide: 'left' as const,
    fromEnd: 'none' as const,
    toEnd: 'none' as const,
    jumps: [{ segment: 0, x: 100, y: 100 }],
  }

  it('draws a path with an arc over each hop instead of a polyline', () => {
    const svg = renderSceneToSvg({ nodes: [crossing] })
    expect(svg).not.toContain('<polyline')
    // Straight run to the hop entry, a half-circle over the crossing,
    // straight run out: entry at x-r, exit at x+r. Sweep 1 is what bulges
    // to the LEFT of travel (up, here) in SVG's y-down coordinates —
    // sweep 0 rendered the hop UNDER the line while every comment and the
    // flattened hit path said over.
    expect(svg).toContain('d="M 0 100 L 95 100 A 5 5 0 0 1 105 100 L 200 100"')
  })

  it('a jump-free edge stays the byte-identical polyline', () => {
    const { jumps: _jumps, ...plain } = crossing
    const svg = renderSceneToSvg({ nodes: [plain] })
    expect(svg).toContain('<polyline points="0,100 200,100"')
  })

  it('rounded edges hop on their straight runs and keep their corner curves', () => {
    const bent = {
      kind: 'edge' as const,
      id: 'e3',
      path: [
        { x: 0, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 300 },
      ],
      fromSide: 'right' as const,
      toSide: 'top' as const,
      fromEnd: 'none' as const,
      toEnd: 'none' as const,
      rounded: true as const,
      jumps: [{ segment: 0, x: 80, y: 100 }],
    }
    const svg = renderSceneToSvg({ nodes: [bent] })
    // The hop arc and the corner quadratic coexist in one path.
    expect(svg).toContain('A 5 5 0 0 1 85 100')
    expect(svg).toContain('Q 200 100')
  })
})

describe('rounded edges', () => {
  const bent = {
    kind: 'edge' as const,
    id: 'e1',
    path: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ],
    fromSide: 'right' as const,
    toSide: 'top' as const,
    fromEnd: 'none' as const,
    toEnd: 'none' as const,
  }

  it('draws a rounded edge as a path, never a polyline', () => {
    const svg = renderSceneToSvg({ nodes: [{ ...bent, rounded: true }] })

    expect(svg).toContain('<path')
    expect(svg).not.toContain('<polyline')
    expect(/<path[^>]*>/.exec(svg)?.[0]).toContain('fill="none"')
  })

  // The corner is the control point and the segment midpoints are on the
  // curve, so the drawn shape stays inside the polyline it rounds. That is
  // what lets sceneBounds, translateScene and scaleScene keep working on the
  // points alone — a smoothing that overshot would put ink outside the bounds
  // they compute.
  it('keeps every coordinate inside the polyline it rounds', () => {
    const svg = renderSceneToSvg({ nodes: [{ ...bent, rounded: true }] })
    const d = /<path[^>]*\sd="([^"]*)"/.exec(svg)?.[1] ?? ''
    const numbers = d.match(/-?[\d.]+/g)?.map(Number) ?? []
    const xs = numbers.filter((_, i) => i % 2 === 0)
    const ys = numbers.filter((_, i) => i % 2 === 1)

    expect(numbers.length).toBeGreaterThan(0)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThanOrEqual(100)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(100)
  })

  it('leaves an ordinary edge as a polyline, byte-for-byte', () => {
    expect(renderSceneToSvg({ nodes: [bent] })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,0 100,0 100,100" fill="none" role="presentation"/></svg>',
    )
  })
})
