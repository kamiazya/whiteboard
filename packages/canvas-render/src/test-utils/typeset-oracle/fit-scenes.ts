import type { Scene, SceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'

/**
 * Scenes written by hand for the cuts a laid-out body does not reach: an edge at
 * the top level (the one node with no box), a table the cut keeps but cannot mark,
 * runs whose lines share a height only by the same arithmetic, and runs with no
 * line at all.
 */
const run = (
  text: string,
  x: number,
  y: number,
  extra: Partial<TextRunNode> = {},
): TextRunNode => ({
  kind: 'textRun',
  bbox: { x, y, w: 40, h: 20 },
  text,
  ...extra,
})

const paragraph = (y: number, runs: TextRunNode[]): SceneNode => ({
  kind: 'paragraph',
  bbox: {
    x: 0,
    y,
    w: 200,
    h: runs.length === 0 ? 20 : 20 * new Set(runs.map((r) => r.bbox.y)).size,
  },
  runs,
})

const edge: SceneNode = {
  kind: 'edge',
  id: 'e',
  path: [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ],
  fromSide: 'left',
  toSide: 'right',
  fromEnd: 'none',
  toEnd: 'none',
}

const table: SceneNode = {
  kind: 'table',
  bbox: { x: 0, y: 0, w: 100, h: 40 },
  rows: [
    {
      kind: 'tableRow',
      bbox: { x: 0, y: 0, w: 100, h: 40 },
      cells: [
        { kind: 'tableCell', bbox: { x: 0, y: 0, w: 100, h: 40 }, runs: [run('cell', 13, 6)] },
      ],
    },
  ],
}

const item = (y: number, text: string) => ({
  kind: 'listItem' as const,
  bbox: { x: 22, y, w: 100, h: 20 },
  children: [paragraph(y, [run(text, 0, y)])],
})

const list = (items: ReturnType<typeof item>[]): SceneNode => ({
  kind: 'list',
  bbox: { x: 0, y: items[0]?.bbox.y ?? 0, w: 200, h: 20 * items.length },
  ordered: false,
  depth: 0,
  items,
})

export const HAND_SCENES: [string, Scene][] = [
  ['hand-scene/empty', { nodes: [] }],
  ['hand-scene/edge-first', { nodes: [edge, paragraph(0, [run('after edge', 0, 0)])] }],
  [
    'hand-scene/edge-between',
    { nodes: [paragraph(0, [run('a', 0, 0)]), edge, paragraph(30, [run('b', 0, 30)])] },
  ],
  ['hand-scene/table-then-text', { nodes: [table, paragraph(52, [run('below', 0, 52)])] }],
  [
    'hand-scene/text-then-table',
    {
      nodes: [
        paragraph(0, [run('above', 0, 0)]),
        { ...table, bbox: { x: 0, y: 32, w: 100, h: 40 } },
      ],
    },
  ],
  ['hand-scene/table-only', { nodes: [table] }],
  [
    'hand-scene/two-lines',
    {
      nodes: [
        paragraph(0, [
          run('one', 0, 0),
          run('two', 0, 20, { overflows: true }),
          run('three', 0, 40),
        ]),
      ],
    },
  ],
  [
    'hand-scene/styled-line',
    { nodes: [paragraph(0, [run('a', 0, 0), run('b', 40, 0, { strong: true }), run('c', 0, 20)])] },
  ],
  ['hand-scene/no-runs', { nodes: [paragraph(0, [])] }],
  [
    'hand-scene/cut-run',
    {
      nodes: [
        paragraph(0, [run('wide', 0, 0, { truncated: true })]),
        paragraph(32, [run('next', 0, 32)]),
      ],
    },
  ],
  [
    'hand-scene/overflowing-run',
    { nodes: [paragraph(0, [run('wide', 0, 0, { overflows: true })])] },
  ],
  ['hand-scene/list', { nodes: [list([item(0, 'a'), item(20, 'b'), item(40, 'c')])] }],
  [
    'hand-scene/list-then-text',
    { nodes: [list([item(0, 'a'), item(20, 'b')]), paragraph(52, [run('t', 0, 52)])] },
  ],
  ['hand-scene/list-one-item', { nodes: [list([item(0, 'only')])] }],
  ['hand-scene/list-no-items', { nodes: [list([])] }],
  [
    'hand-scene/quote',
    {
      nodes: [
        {
          kind: 'blockquote',
          bbox: { x: 0, y: 0, w: 200, h: 60 },
          children: [paragraph(0, [run('q1', 20, 0)]), paragraph(30, [run('q2', 20, 30)])],
        },
        paragraph(72, [run('after', 0, 72)]),
      ],
    },
  ],
  [
    'hand-scene/code',
    {
      nodes: [
        {
          kind: 'codeBlock',
          bbox: { x: 0, y: 0, w: 200, h: 70 },
          value: 'a\nb',
          runs: [run('a', 16, 16, { code: true }), run('b', 16, 36, { code: true })],
        },
        paragraph(82, [run('after', 0, 82)]),
      ],
    },
  ],
  [
    'hand-scene/code-no-runs',
    {
      nodes: [
        { kind: 'codeBlock', bbox: { x: 0, y: 0, w: 200, h: 70 }, value: '' },
        paragraph(82, [run('after', 0, 82)]),
      ],
    },
  ],
  [
    'hand-scene/embed',
    {
      nodes: [
        {
          kind: 'embedResolved',
          bbox: { x: 0, y: 0, w: 200, h: 60 },
          documentId: 'd',
          children: [paragraph(0, [run('in', 0, 0)])],
        },
        paragraph(72, [run('after', 0, 72)]),
      ],
    },
  ],
  [
    'hand-scene/heading',
    {
      nodes: [
        {
          kind: 'heading',
          bbox: { x: 0, y: 0, w: 200, h: 50 },
          level: 1,
          runs: [run('h1', 0, 0), run('h2', 0, 25)],
        },
      ],
    },
  ],
  [
    'hand-scene/group',
    {
      nodes: [
        {
          kind: 'group',
          bbox: { x: 0, y: 0, w: 200, h: 60 },
          label: 'g',
          children: [paragraph(0, [run('in group', 0, 0)]), paragraph(30, [run('later', 0, 30)])],
        },
        paragraph(72, [run('after', 0, 72)]),
      ],
    },
  ],
  [
    'hand-scene/offset-paragraph',
    {
      nodes: [paragraph(30, [run('a', 0, 30), run('b', 0, 50)]), paragraph(82, [run('c', 0, 82)])],
    },
  ],
  [
    'hand-scene/offset-list',
    {
      nodes: [
        list([item(30, 'a'), item(50, 'b'), item(70, 'c')]),
        paragraph(102, [run('after', 0, 102)]),
      ],
    },
  ],
  [
    'hand-scene/offset-heading',
    {
      nodes: [
        {
          kind: 'heading',
          bbox: { x: 0, y: 30, w: 200, h: 50 },
          level: 2,
          runs: [run('h1', 0, 30), run('h2', 0, 55)],
        },
      ],
    },
  ],
  ['hand-scene/top-run', { nodes: [run('loose', 0, 0)] }],
  [
    'hand-scene/rule',
    {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 200, h: 1 } },
        paragraph(13, [run('p', 0, 13)]),
      ],
    },
  ],
]
