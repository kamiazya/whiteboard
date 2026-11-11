import type { Scene } from '@kamiazya/whiteboard-scene'
import type { SvgDocumentOptions } from '../../svg/backend.js'
import type { SvgInput } from './oracle.js'

/**
 * Small scenes aimed at the SVG backend's branches, one rule each, that the
 * recorded goldens and laid-out canvases reach only by accident or not at all:
 * what a document does with an unusable option, how a run's link is
 * addressed, which attribute a degenerate box drops. They are the second half
 * of the Rust backend's oracle (`svg-edge-cases.jsonl`), so every case here is
 * one a port can get wrong while still drawing every golden correctly.
 *
 * Scenes are plain data and pass through JSON before they are answered, so a
 * non-finite number cannot appear in one; the Rust tests build those directly.
 */
import {
  box,
  type Case,
  KEY_LEGEND,
  paint,
  run,
  SKETCH,
  shape,
  ULID,
} from './svg-edge-case-builders.js'
import { EDGE_CASES } from './svg-edge-cases-edges.js'

const CASES: readonly Case[] = [
  // ---- document envelope -------------------------------------------------
  { id: 'doc/empty', nodes: [], options: null },
  { id: 'doc/empty-enveloped', nodes: [], options: { padding: 3 } },
  { id: 'doc/width-only', nodes: [shape('a')], options: { width: 300 } },
  { id: 'doc/height-only', nodes: [shape('a')], options: { height: 120 } },
  { id: 'doc/negative-dimensions', nodes: [shape('a')], options: { width: -5, height: -1 } },
  { id: 'doc/zero-dimensions', nodes: [shape('a')], options: { width: 0, height: 0 } },
  { id: 'doc/negative-padding', nodes: [shape('a')], options: { padding: -4 } },
  { id: 'doc/zero-padding', nodes: [shape('a')], options: { padding: 0 } },
  { id: 'doc/padding', nodes: [shape('a')], options: { padding: 12.5 } },
  { id: 'doc/unusable-viewbox', nodes: [shape('a')], options: { viewBox: box(0, 0, -10, 30) } },
  { id: 'doc/unusable-viewbox-h', nodes: [shape('a')], options: { viewBox: box(0, 0, 10, -30) } },
  { id: 'doc/zero-viewbox', nodes: [shape('a')], options: { viewBox: box(5, 5, 0, 0) } },
  {
    id: 'doc/viewbox-padding-ignored',
    nodes: [shape('a')],
    options: { viewBox: box(1, 2, 300, 200), padding: 40 },
  },
  { id: 'doc/empty-text-fill', nodes: [run('t')], options: { textFill: '' } },
  { id: 'doc/text-fill', nodes: [run('t')], options: { textFill: '#101010' } },
  { id: 'doc/background-only', nodes: [shape('a')], options: { background: '#fafafa' } },
  { id: 'doc/background-empty', nodes: [shape('a')], options: { background: '' } },
  { id: 'doc/legend-omit-only', nodes: [shape('a')], options: { legend: 'omit' } },
  { id: 'doc/raster-only', nodes: [shape('a')], options: { rasterScale: 2 } },
  {
    id: 'doc/everything',
    nodes: [shape('a'), run('t', 5, 80)],
    options: {
      width: 200,
      height: 150,
      padding: 6,
      background: '#fff',
      textFill: '#222',
      viewBox: box(0, 0, 150, 100),
    },
  },
  // ---- legend --------------------------------------------------------------
  {
    id: 'legend/enveloped',
    nodes: [shape('a')],
    legend: KEY_LEGEND,
    options: { padding: 4, background: '#fff' },
  },
  {
    id: 'legend/omitted',
    nodes: [shape('a')],
    legend: KEY_LEGEND,
    options: { padding: 4, legend: 'omit' },
  },
  {
    id: 'legend/explicit-viewbox',
    nodes: [shape('a')],
    legend: KEY_LEGEND,
    options: { viewBox: box(-10, -10, 500, 300) },
  },
  { id: 'legend/no-options', nodes: [shape('a')], legend: KEY_LEGEND, options: null },
  {
    id: 'legend/wide-content',
    nodes: [shape('a', box(0, 0, 900, 40))],
    legend: KEY_LEGEND,
    options: { padding: 1 },
  },
  {
    id: 'legend/no-keys',
    nodes: [shape('a')],
    legend: { keys: [], uncarried: { boxes: true, edges: false } },
    options: { padding: 2 },
  },
  {
    id: 'legend/only-boxes-uncarried',
    nodes: [shape('a')],
    legend: {
      keys: [{ key: 'k', of: 'boxes', entries: [] }],
      uncarried: { boxes: true, edges: false },
    },
    options: { padding: 2 },
  },
  {
    id: 'legend/only-edges-uncarried',
    nodes: [shape('a')],
    legend: {
      keys: [
        {
          key: 'k',
          of: 'edges',
          entries: [{ value: 'v', count: 1, swatch: { stroke: '#123456' } }],
        },
      ],
      uncarried: { boxes: false, edges: true },
    },
    options: { padding: 2 },
  },
  // ---- text runs -----------------------------------------------------------
  {
    id: 'run/baseline',
    nodes: [run('a', 0, 0, { baseline: 12.5 }), run('b', 50, 0, { baseline: 0 })],
  },
  {
    id: 'run/emphasis-all',
    nodes: [
      run('e', 0, 0, { strong: true }),
      run('i', 0, 20, { emphasis: true }),
      run('d', 0, 40, { deleted: true }),
      run('all', 0, 60, { strong: true, emphasis: true, deleted: true }),
    ],
  },
  {
    id: 'run/links',
    nodes: [
      run('http', 0, 0, {
        link: { kind: 'link', href: 'https://example.com/a?b=1&c=2', title: 'T' },
      }),
      run('js', 0, 20, { link: { kind: 'link', href: 'javascript:alert(1)' } }),
      run('rel', 0, 40, { link: { kind: 'link', href: 'notes/page.md#x' } }),
      run('net', 0, 60, { link: { kind: 'link', href: '//evil.example/x' } }),
      run('ctl', 0, 80, { link: { kind: 'link', href: 'java\u0085script:alert(1)' } }),
      run('mail', 0, 100, { link: { kind: 'link', href: 'mailto:a@b.c' } }),
      run('wiki', 0, 120, { link: { kind: 'wikiLink', documentId: ULID } }),
      run('wikibad', 0, 140, { link: { kind: 'wikiLink', documentId: 'not an id' } }),
      run('embed', 0, 160, { link: { kind: 'embed', documentId: ULID, fragment: 'x' } }),
      run('deleted-link', 0, 180, { deleted: true, link: { kind: 'link', href: '/x' } }),
    ],
  },
  {
    id: 'run/code-and-truncated',
    nodes: [
      run('  indented', 0, 0, { code: true }),
      run('cut', 0, 20, { truncated: true }),
      run('cut2', 0, 40, { truncated: true, appearance: { fill: '#999' } }),
    ],
  },
  {
    id: 'run/halo',
    nodes: [
      run('on edge', 10, 10, { appearance: { halo: '#ffffff', fill: '#000' } }),
      run('nohalo', 10, 40, { appearance: { halo: '' } }),
    ],
  },
  {
    id: 'run/backdrop',
    nodes: [
      run('code', 10, 10, { code: true, backdrop: { fill: '#eeeeee' }, backdropPadXPx: 3 }),
      run('nopad', 10, 40, { backdrop: { fill: '#eeeeee', stroke: '#ccc' } }),
      run('negpad', 10, 70, { backdrop: { fill: '#eeeeee' }, backdropPadXPx: -2 }),
      run('both', 10, 100, { backdrop: { fill: '#eee' }, appearance: { halo: '#fff' } }),
    ],
  },
  {
    id: 'run/appearance',
    nodes: [
      run('a', 0, 0, {
        appearance: {
          fill: '#111',
          stroke: '#222',
          strokeWidth: 0,
          fontFamily: 'Roboto',
          fontSize: 14,
          fillOpacity: 0.5,
          strokeOpacity: 0.25,
          strokeDasharray: '2 2',
        },
      }),
      run('b', 0, 20, {
        appearance: {
          fontFamily: 'Georgia',
          fillOpacity: 1,
          strokeOpacity: 1,
          strokeWidth: -3,
          fontSize: -1,
        },
      }),
      run('c', 0, 40, {
        appearance: { fill: '', stroke: '', fontFamily: '', strokeDasharray: '' },
      }),
    ],
  },
  {
    id: 'run/paints',
    nodes: [
      run('alt text', 0, 0, { paints: { kind: 'image', src: 'data:image/png;base64,AAAA' } }),
      run('   ', 50, 0, { paints: { kind: 'image', src: 'https://example.com/i.png' } }),
      run(' \t', 100, 0, { paints: { kind: 'image', src: 'x.png' } }),
      run(':lock:', 0, 30, { paints: { kind: 'icon', name: 'lock' } }),
      run(':star:', 50, 30, {
        paints: { kind: 'icon', name: 'star' },
        appearance: { fill: '#aa0000' },
      }),
      run(':nope:', 100, 30, { paints: { kind: 'icon', name: 'nope' } }),
      run(':toString:', 150, 30, { paints: { kind: 'icon', name: 'toString' } }),
      run(':glow:', 0, 60, {
        paints: { kind: 'icon', name: 'link' },
        appearance: { stroke: '#00aa00', strokeOpacity: 0.5, glow: { radiusPx: 4 } },
      }),
    ],
  },
  {
    id: 'run/glow',
    nodes: [
      run('glow', 20, 20, { appearance: { fill: '#fff', glow: { radiusPx: 5 } } }),
      run('flat', 20, 60, { appearance: { glow: { radiusPx: 0 } } }),
      run('neg', 20, 90, { appearance: { glow: { radiusPx: -3 } } }),
    ],
  },
  // ---- blocks --------------------------------------------------------------
  {
    id: 'block/heading-paragraph',
    nodes: [
      { kind: 'heading', bbox: box(0, 0), level: 1, runs: [run('H')] },
      {
        kind: 'paragraph',
        bbox: box(0, 20),
        runs: [
          run('p', 0, 20, { appearance: { fill: '#111' } }),
          run('q', 50, 20, { appearance: { fill: '#111' } }),
        ],
      },
    ],
  },
  {
    id: 'block/lists',
    nodes: [
      {
        kind: 'list',
        bbox: box(0, 0, 100, 60),
        ordered: false,
        depth: 0,
        items: [
          {
            kind: 'listItem',
            bbox: box(0, 0, 100, 20),
            children: [{ kind: 'paragraph', bbox: box(0, 0), runs: [run('zero')] }],
          },
          {
            kind: 'listItem',
            bbox: box(14, 20, 86, 20),
            ordinal: 2,
            children: [{ kind: 'paragraph', bbox: box(14, 20), runs: [run('shifted', 14, 20)] }],
          },
        ],
      },
    ],
  },
  {
    id: 'block/tables',
    nodes: [
      {
        kind: 'table',
        bbox: box(0, 0, 100, 60),
        rows: [
          {
            kind: 'tableRow',
            bbox: box(0, 0, 100, 20),
            header: true,
            appearance: { stroke: '#ccc', fill: '#eee' },
            cells: [
              { kind: 'tableCell', bbox: box(0, 0, 50, 20), runs: [run('a')] },
              {
                kind: 'tableCell',
                bbox: box(50, 0, 50, 20),
                runs: [run('b', 50, 0)],
                appearance: { stroke: '#ccc' },
              },
            ],
          },
          {
            kind: 'tableRow',
            bbox: box(0, 20, 100, 20),
            cells: [{ kind: 'tableCell', bbox: box(0, 20, 50, 20), runs: [] }],
          },
        ],
      },
    ],
  },
  {
    id: 'block/code',
    nodes: [
      {
        kind: 'codeBlock',
        bbox: box(0, 0, 100, 40),
        value: 'a < b\n  c',
        lang: 'ts',
        appearance: { fill: '#f5f5f5', stroke: '#ddd' },
        radius: 4,
        runs: [run('a < b', 8, 4, { code: true }), run('  c', 8, 20, { code: true })],
      },
      { kind: 'codeBlock', bbox: box(0, 50, 100, 40), value: 'plain\ntext', radius: 0 },
      {
        kind: 'codeBlock',
        bbox: box(0, 100, 100, 40),
        value: 'x',
        appearance: { fill: '#f5f5f5' },
        radius: -2,
      },
      { kind: 'codeBlock', bbox: box(0, 150, 100, 40), value: 'x & y', runs: [] },
    ],
  },
  {
    id: 'block/quote-break-raw',
    nodes: [
      {
        kind: 'blockquote',
        bbox: box(0, 0, 100, 40),
        appearance: { fillOpacity: 0.6 },
        children: [
          shape(undefined, box(0, 0, 3, 40), { appearance: { fill: '#999' } }),
          { kind: 'paragraph', bbox: box(8, 0), runs: [run('quoted', 8, 0)] },
        ],
      },
      { kind: 'blockquote', bbox: box(0, 50, 100, 20), children: [] },
      { kind: 'thematicBreak', bbox: box(0, 80, 100, 1), appearance: { fill: '#ccc' } },
      { kind: 'thematicBreak', bbox: box(0, 90, 100, 1) },
      { kind: 'rawHtml', bbox: box(0, 100, 100, 16), value: '<div class="a">&nbsp;</div>' },
      { kind: 'unresolvedReference', bbox: box(0, 120), identifier: 'missing' },
    ],
  },
  {
    id: 'block/fragments',
    nodes: [
      { kind: 'svgFragment', bbox: box(10, 20, 30, 30), svg: '<circle cx="15" cy="15" r="10"/>' },
      {
        kind: 'svgFragment',
        bbox: box(60, 20, 30, 30),
        svg: '<path d="M0 0"/>',
        role: 'presentation',
      },
    ],
  },
  {
    id: 'block/embeds',
    nodes: [
      {
        kind: 'embedPlaceholder',
        bbox: box(0, 0, 100, 20),
        documentId: ULID,
        title: 'Other <doc>',
        reason: 'cycle',
      },
      {
        kind: 'embedPlaceholder',
        bbox: box(0, 30, 100, 20),
        documentId: 'x/y',
        title: 'bad',
        reason: 'budget',
      },
      {
        kind: 'embedResolved',
        bbox: box(0, 60, 100, 20),
        documentId: ULID,
        children: [{ kind: 'paragraph', bbox: box(0, 60), runs: [run('inner', 0, 60)] }],
      },
      { kind: 'group', bbox: box(0, 90, 100, 20), label: 'g', children: [run('in group', 0, 90)] },
    ],
  },
  {
    id: 'block/glyph-image-icon',
    nodes: [
      { kind: 'glyph', bbox: box(0, 0, 30, 20), glyph: '\u{1F512}' },
      { kind: 'glyph', bbox: box(40, 0, 20, 30), glyph: 'ab' },
      { kind: 'glyph', bbox: box(70, 0, 20, 30), glyph: '' },
      {
        kind: 'image',
        bbox: box(0, 40, 30, 30),
        href: 'data:image/png;base64,AAAA',
        alt: 'A <pic>',
      },
      { kind: 'image', bbox: box(40, 40, 30, 30), href: 'x.png', alt: '' },
      { kind: 'image', bbox: box(80, 40, 30, 30), href: 'x.png', fit: 'cover' },
      { kind: 'image', bbox: box(120, 40, 30, 30), href: 'x.png', fit: 'contain', alt: 'c' },
      { kind: 'icon', icon: 'database', bbox: box(0, 80, 24, 24) },
      {
        kind: 'icon',
        icon: 'server',
        bbox: box(30, 80, 24, 24),
        appearance: { stroke: '#cc0000', strokeOpacity: 0.5 },
      },
      {
        kind: 'icon',
        icon: 'network',
        bbox: box(60, 80, 24, 24),
        appearance: { stroke: '#00cc00', glow: { radiusPx: 3 } },
      },
      { kind: 'icon', icon: 'user', bbox: box(90, 80, 24, 24), appearance: { fill: '#111' } },
      { kind: 'icon', icon: 'unknown-icon', bbox: box(120, 80, 24, 24) },
      { kind: 'icon', icon: 'a b', bbox: box(150, 80, 24, 24) },
      { kind: 'icon', icon: 'layers', bbox: box(0, 110, 24, 24) },
      { kind: 'icon', icon: 'file', bbox: box(30, 110, 24, 24) },
      { kind: 'icon', icon: 'image', bbox: box(60, 110, 24, 24) },
    ],
  },
  // ---- shapes --------------------------------------------------------------
  {
    id: 'shape/rect',
    nodes: [
      shape('r0', box(0, 0, 60, 30), { radius: 0, appearance: paint }),
      shape('r1', box(70, 0, 60, 30), { radius: -4, appearance: paint }),
      shape('r2', box(140, 0, 60, 30), {
        radius: 6,
        appearance: { ...paint, strokeDasharray: '4 3', fillOpacity: 0.5, strokeOpacity: 0.7 },
      }),
      shape('shadow', box(0, 40, 60, 30), { appearance: { fill: '#fff', dropShadow: true } }),
      shape('shadow2', box(70, 40, 60, 30), {
        appearance: { fill: '#fff', dropShadow: true, glow: { radiusPx: 4 } },
      }),
      shape('task-on', box(140, 40, 14, 14), { taskBox: { checked: true } }),
      shape('task-off', box(160, 40, 14, 14), { taskBox: { checked: false } }),
      shape('glow', box(0, 80, 60, 30), { appearance: { ...paint, glow: { radiusPx: 6 } } }),
      shape('thickglow', box(70, 80, 60, 30), {
        appearance: { stroke: '#000', strokeWidth: 7, glow: { radiusPx: 2 } },
      }),
      shape('nogeom', box(140, 80, 60, 30), { appearance: { glow: { radiusPx: 0 } } }),
      shape(undefined, box(0, 120, 60, 30)),
      shape('chrome', box(70, 120, 60, 30), {
        commentChrome: true,
        appearance: { fill: '#fff', dropShadow: true },
      }),
      shape('prop', box(140, 120, 60, 30), {
        proposalChrome: { proposalId: 'p1' },
        truncated: true,
        overflows: true,
      }),
    ],
  },
  {
    id: 'shape/silhouettes',
    nodes: [
      'ellipse',
      'diamond',
      'hexagon',
      'parallelogram',
      'octagon',
      'cylinder',
      'blob',
      'other.ellipse',
      'visual',
      '',
    ].flatMap((kind, i) => [
      shape(`s-${i}`, box((i % 5) * 100, Math.floor(i / 5) * 90, 90, 70), {
        shape:
          kind === 'blob' || kind.includes('.') || kind === '' || kind === 'visual'
            ? kind
            : `visual.${kind}`,
        appearance: paint,
        radius: 8,
      }),
    ]),
  },
  {
    id: 'shape/silhouette-glow',
    nodes: ['ellipse', 'diamond', 'cylinder'].map((kind, i) =>
      shape(`g-${i}`, box(i * 100, 0, 90, 70), {
        shape: `visual.${kind}`,
        appearance: { ...paint, glow: { radiusPx: 4 }, strokeOpacity: 0.6 },
      }),
    ),
  },
  {
    id: 'shape/silhouette-bare',
    nodes: ['ellipse', 'diamond', 'cylinder', 'hexagon'].map((kind, i) =>
      shape(`b-${i}`, box(i * 100, 0, 90, 70), { shape: `visual.${kind}` }),
    ),
  },
  {
    id: 'shape/sketch',
    nodes: [
      shape('k-rect', box(0, 0, 90, 60), { ink: SKETCH, appearance: paint, radius: 6 }),
      shape('k-hatch', box(100, 0, 90, 60), {
        ink: { ...SKETCH, fill: 'hatch' },
        appearance: { ...paint, fillOpacity: 0.4 },
      }),
      shape('k-nofill', box(200, 0, 90, 60), {
        ink: { ...SKETCH, seed: 7 },
        appearance: { stroke: '#222', strokeDasharray: '3 2', strokeOpacity: 0.8 },
      }),
      shape('k-none', box(300, 0, 90, 60), {
        ink: SKETCH,
        appearance: { fill: 'none', stroke: '#222' },
      }),
      shape('k-ellipse', box(0, 80, 90, 60), {
        ink: { ...SKETCH, fill: 'hatch' },
        shape: 'visual.ellipse',
        appearance: paint,
      }),
      shape('k-diamond', box(100, 80, 90, 60), {
        ink: SKETCH,
        shape: 'visual.diamond',
        appearance: paint,
      }),
      shape('k-cylinder', box(200, 80, 90, 60), {
        ink: { ...SKETCH, fill: 'hatch' },
        shape: 'visual.cylinder',
        appearance: paint,
      }),
      shape('k-octagon', box(300, 80, 90, 60), {
        ink: SKETCH,
        shape: 'visual.octagon',
        appearance: paint,
      }),
      shape('k-unknown', box(0, 160, 90, 60), {
        ink: SKETCH,
        shape: 'visual.blob',
        appearance: paint,
      }),
      shape('k-glow', box(100, 160, 90, 60), {
        ink: SKETCH,
        appearance: { ...paint, glow: { radiusPx: 5 } },
      }),
      shape('k-flat', box(200, 160, 0, 60), { ink: SKETCH, appearance: paint }),
      shape('k-bare', box(300, 160, 90, 60), { ink: SKETCH }),
    ],
  },
  ...EDGE_CASES,
]

export function svgEdgeCaseInputs(): readonly SvgInput[] {
  return CASES.map((c) => ({
    id: c.id,
    scene: JSON.parse(
      JSON.stringify({ nodes: c.nodes, ...(c.legend === undefined ? {} : { legend: c.legend }) }),
    ) as Scene,
    options: JSON.parse(JSON.stringify(c.options ?? null)) as SvgDocumentOptions | null,
  }))
}
