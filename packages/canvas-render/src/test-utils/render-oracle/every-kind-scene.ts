import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'

const box = (x: number, y: number, w = 40, h = 16) => ({ x, y, w, h })

const run = (x: number, y: number, text: string) => ({
  kind: 'textRun' as const,
  bbox: box(x, y),
  text,
})

/**
 * One node of every scene kind, in a table keyed by kind so a kind added to
 * the vocabulary fails to compile until a node of it is placed here. Laid-out
 * canvases never reach several of them (a group, an embed, a glyph, an image),
 * and the SVG backend answers all of them.
 */
const OF_KIND = {
  textRun: {
    kind: 'textRun',
    bbox: box(0, 0),
    text: 'a <b> & "c"',
    emphasis: true,
    strong: true,
    code: true,
    deleted: true,
    truncated: true,
    link: { kind: 'wikiLink', documentId: 'doc-1', alias: 'one', fragment: 'part' },
    appearance: { fill: '#112233' },
  },
  heading: { kind: 'heading', bbox: box(0, 20), level: 3, runs: [run(0, 20, 'Heading')] },
  paragraph: {
    kind: 'paragraph',
    bbox: box(0, 40),
    runs: [
      run(0, 40, 'plain'),
      { ...run(50, 40, 'overflowing'), overflows: true },
      {
        ...run(110, 40, 'alt'),
        link: { kind: 'embed', documentId: 'doc-2' },
      },
    ],
  },
  list: {
    kind: 'list',
    bbox: box(0, 60, 120, 40),
    ordered: true,
    depth: 1,
    items: [
      {
        kind: 'listItem',
        bbox: box(0, 60, 120, 16),
        ordinal: 3,
        checked: true,
        children: [{ kind: 'paragraph', bbox: box(20, 60), runs: [run(20, 60, 'one')] }],
      },
      { kind: 'listItem', bbox: box(0, 80, 120, 16), children: [] },
    ],
  },
  codeBlock: {
    kind: 'codeBlock',
    bbox: box(0, 100, 200, 48),
    value: 'let x = 1\nlet y = "<2>"',
    lang: 'ts',
    runs: [run(8, 104, 'let x = 1'), run(8, 120, 'let y = "<2>"')],
    appearance: { fill: '#f5f5f5', stroke: '#cccccc' },
    radius: 6,
  },
  blockquote: {
    kind: 'blockquote',
    bbox: box(0, 150, 200, 24),
    children: [{ kind: 'paragraph', bbox: box(12, 152), runs: [run(12, 152, 'quoted')] }],
    appearance: { stroke: '#999999' },
  },
  thematicBreak: {
    kind: 'thematicBreak',
    bbox: box(0, 176, 200, 1),
    appearance: { stroke: '#bbbbbb' },
  },
  table: {
    kind: 'table',
    bbox: box(0, 180, 200, 40),
    rows: [
      {
        kind: 'tableRow',
        bbox: box(0, 180, 200, 20),
        header: true,
        appearance: { fill: '#eeeeee' },
        cells: [
          { kind: 'tableCell', bbox: box(0, 180, 100, 20), runs: [run(4, 182, 'H1')] },
          {
            kind: 'tableCell',
            bbox: box(100, 180, 100, 20),
            runs: [run(104, 182, 'H2')],
            appearance: { fill: '#dddddd' },
          },
        ],
      },
      { kind: 'tableRow', bbox: box(0, 200, 200, 20), cells: [] },
    ],
  },
  rawHtml: { kind: 'rawHtml', bbox: box(0, 224, 100, 16), value: '<b>raw</b>' },
  unresolvedReference: {
    kind: 'unresolvedReference',
    bbox: box(0, 244, 100, 16),
    identifier: 'missing',
  },
  svgFragment: {
    kind: 'svgFragment',
    bbox: box(0, 264, 40, 40),
    svg: '<circle cx="20" cy="20" r="19.5"/>',
    role: 'presentation',
  },
  embedPlaceholder: {
    kind: 'embedPlaceholder',
    bbox: box(0, 308, 120, 40),
    documentId: 'doc-3',
    title: 'Three',
    reason: 'cycle',
  },
  embedResolved: {
    kind: 'embedResolved',
    bbox: box(0, 352, 120, 40),
    documentId: 'doc-4',
    children: [{ kind: 'paragraph', bbox: box(4, 356), runs: [run(4, 356, 'embedded')] }],
  },
  group: {
    kind: 'group',
    bbox: box(0, 396, 200, 80),
    label: 'Frame',
    children: [{ kind: 'glyph', bbox: box(8, 404, 16, 16), glyph: '🔒' }],
  },
  edge: {
    kind: 'edge',
    id: 'e1',
    path: [
      { x: 0, y: 480 },
      { x: 60, y: 480 },
      { x: 60, y: 540 },
      { x: 120, y: 540 },
    ],
    jumps: [{ segment: 0, x: 30, y: 480 }],
    fromSide: 'right',
    toSide: 'left',
    fromEnd: 'arrow',
    toEnd: 'arrow',
    rounded: true,
    appearance: { stroke: '#335577', strokeWidth: 2 },
  },
  shape: {
    kind: 'shape',
    bbox: box(130, 480, 80, 60),
    id: 'n1',
    appearance: { fill: '#ffeecc', stroke: '#aa8844', strokeWidth: 2 },
  },
  image: {
    kind: 'image',
    bbox: box(0, 560, 60, 40),
    href: 'https://example.com/a.png?x=1&y=2',
    alt: 'an "image"',
    fit: 'cover',
  },
  icon: {
    kind: 'icon',
    bbox: box(80, 560, 32, 32),
    icon: 'database',
    appearance: { stroke: '#1f2933' },
  },
  glyph: { kind: 'glyph', bbox: box(120, 560, 16, 16), glyph: 'x' },
} as const satisfies { readonly [K in SceneNode['kind']]: Extract<SceneNode, { kind: K }> }

export function buildEveryKindScene(): Scene {
  return { nodes: Object.values(OF_KIND) as readonly SceneNode[] }
}
