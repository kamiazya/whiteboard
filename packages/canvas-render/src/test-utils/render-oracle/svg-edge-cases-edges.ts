import {
  box,
  type Case,
  CORNER,
  edge,
  JUMPS,
  paint,
  run,
  SKETCH,
  shape,
} from './svg-edge-case-builders.js'

/** The edge and filter-budget half of the SVG edge cases, in recording order after `svg-edge-cases.ts`'s. */
export const EDGE_CASES: readonly Case[] = [
  // ---- edges ---------------------------------------------------------------
  {
    id: 'edge/plain',
    nodes: [
      edge('e1', CORNER, { appearance: { stroke: '#333', strokeWidth: 1 } }),
      edge(
        'e2',
        [
          [0, 100],
          [200, 100],
        ],
        { appearance: { stroke: '#333', strokeDasharray: '4 3', strokeOpacity: 0.5 } },
      ),
      edge(
        'e3',
        [
          [0, 140],
          [200, 140],
        ],
        { fromEnd: 'arrow', toEnd: 'none', appearance: { stroke: '#a00' } },
      ),
      edge(
        'e4',
        [
          [0, 180],
          [200, 180],
        ],
        { fromEnd: 'arrow', toEnd: 'arrow' },
      ),
      edge('e5', [[0, 200]], { appearance: { stroke: '#333' } }),
      edge('e6', [], { appearance: { stroke: '#333' } }),
      edge(
        'e7',
        [
          [0, 220],
          [0, 220],
        ],
        { appearance: { stroke: '#333' } },
      ),
      edge(
        'e8',
        [
          [0, 240],
          [200, 240],
        ],
        { appearance: { stroke: '', strokeWidth: 0 } },
      ),
    ],
  },
  {
    id: 'edge/heavy-heads',
    nodes: [
      edge('h1', CORNER, { fromEnd: 'arrow', appearance: { stroke: '#222', strokeWidth: 6 } }),
      edge(
        'h2',
        [
          [0, 100],
          [200, 100],
        ],
        { appearance: { stroke: '#222', strokeWidth: 3 } },
      ),
      edge(
        'h3',
        [
          [0, 130],
          [4, 130],
        ],
        { appearance: { stroke: '#222', strokeWidth: 10 }, fromEnd: 'arrow' },
      ),
      edge(
        'h4',
        [
          [0, 160],
          [200, 160],
        ],
        { appearance: { strokeWidth: 8 }, fromEnd: 'arrow' },
      ),
      edge(
        'h5',
        [
          [0, 190],
          [200, 190],
        ],
        { appearance: { stroke: 'rgb(1, 2, 3)', strokeWidth: 5 } },
      ),
      edge(
        'h6',
        [
          [0, 220],
          [200, 220],
        ],
        { appearance: { stroke: '#222', strokeWidth: 6 }, rounded: true },
      ),
      edge(
        'h7',
        [
          [0, 250],
          [200, 250],
        ],
        { fromEnd: 'arrow', toEnd: 'none', appearance: { stroke: '#222', strokeWidth: 6 } },
      ),
      edge(
        'h8',
        [
          [0, 300],
          [0, 400],
        ],
        { fromEnd: 'arrow', appearance: { stroke: '#222', strokeWidth: 6 } },
      ),
      edge(
        'h9',
        [
          [0, 420],
          [120, 500],
          [120, 560],
        ],
        { fromEnd: 'arrow', appearance: { stroke: '#222', strokeWidth: 6 } },
      ),
      edge(
        'h10',
        [
          [50, 600],
          [56, 600],
          [56, 680],
        ],
        { fromEnd: 'arrow', appearance: { stroke: '#222', strokeWidth: 5 } },
      ),
      edge(
        'h11',
        [
          [200, 700],
          [100, 620],
          [10, 640],
        ],
        {
          fromEnd: 'arrow',
          toEnd: 'arrow',
          appearance: { stroke: '#222', strokeWidth: 4 },
          jumps: [{ segment: 0, x: 150, y: 660 }],
        },
      ),
    ],
  },
  {
    id: 'edge/jumps',
    nodes: [
      edge('j1', CORNER, { jumps: JUMPS, appearance: { stroke: '#333' } }),
      edge('j2', CORNER, { jumps: JUMPS, rounded: true, appearance: { stroke: '#333' } }),
      edge(
        'j3',
        [
          [0, 100],
          [200, 100],
        ],
        {
          jumps: [
            { segment: 0, x: 100, y: 100 },
            { segment: 0, x: 102, y: 100 },
            { segment: 3, x: 5, y: 5 },
          ],
          rounded: true,
          appearance: { stroke: '#333' },
        },
      ),
      edge(
        'j4',
        [
          [0, 150],
          [200, 150],
        ],
        {
          jumps: [
            { segment: 0, x: 3, y: 150 },
            { segment: 0, x: 197, y: 150 },
            { segment: 0, x: 100, y: 150 },
          ],
          appearance: { stroke: '#333' },
        },
      ),
      edge(
        'j5',
        [
          [0, 200],
          [0, 200],
          [100, 200],
        ],
        { jumps: [{ segment: 1, x: 50, y: 200 }], appearance: { stroke: '#333' } },
      ),
      edge('j6', [], { jumps: [{ segment: 0, x: 0, y: 0 }], rounded: true }),
    ],
  },
  {
    id: 'edge/rounded',
    nodes: [
      edge('r1', CORNER, { rounded: true, appearance: { stroke: '#333' } }),
      edge(
        'r2',
        [
          [0, 100],
          [100, 100],
        ],
        { rounded: true, appearance: { stroke: '#333' } },
      ),
      edge(
        'r3',
        [
          [0, 150],
          [100, 150],
          [100, 200],
        ],
        { rounded: true, appearance: { stroke: '#333' }, fromEnd: 'arrow' },
      ),
      edge('r4', [[0, 250]], { rounded: true }),
    ],
  },
  {
    id: 'edge/glow',
    nodes: [
      edge('g1', CORNER, { appearance: { stroke: '#0aa', strokeWidth: 2, glow: { radiusPx: 5 } } }),
      edge(
        'g2',
        [
          [0, 100],
          [200, 100],
        ],
        {
          jumps: [{ segment: 0, x: 100, y: 100 }],
          appearance: { stroke: '#0aa', glow: { radiusPx: 3 } },
        },
      ),
      edge(
        'g3',
        [
          [0, 150],
          [200, 150],
        ],
        { fromEnd: 'arrow', appearance: { stroke: '#0aa', strokeWidth: 6, glow: { radiusPx: 2 } } },
      ),
      edge(
        'g4',
        [
          [0, 200],
          [200, 200],
        ],
        { appearance: { stroke: '#0aa', glow: { radiusPx: 0 } } },
      ),
      edge(
        'g5',
        [
          [10, 250],
          [100, 250],
        ],
        {
          jumps: [
            { segment: 0, x: 12, y: 250 },
            { segment: 0, x: 97, y: 250 },
          ],
          appearance: { stroke: '#0aa', glow: { radiusPx: 3 } },
        },
      ),
    ],
  },
  {
    id: 'edge/sketch',
    nodes: [
      edge('k1', CORNER, { ink: SKETCH, appearance: { stroke: '#333', strokeWidth: 2 } }),
      edge('k2', CORNER, {
        ink: { style: 'sketch', seed: 9 },
        rounded: true,
        jumps: JUMPS,
        fromEnd: 'arrow',
        appearance: { stroke: '#333', strokeDasharray: '4 3', strokeOpacity: 0.7 },
      }),
      edge(
        'k3',
        [
          [0, 100],
          [300, 100],
        ],
        { ink: SKETCH, appearance: { stroke: '#333', glow: { radiusPx: 4 } } },
      ),
      edge(
        'k4',
        [
          [0, 140],
          [4, 140],
        ],
        { ink: SKETCH, fromEnd: 'arrow' },
      ),
      edge('k5', [[0, 160]], { ink: SKETCH }),
      edge(
        'k6',
        [
          [0, 180],
          [200, 180],
        ],
        { ink: SKETCH, appearance: { strokeWidth: 6 }, fromEnd: 'arrow' },
      ),
    ],
  },
  {
    id: 'edge/chrome-keyed',
    nodes: [
      shape('n1', box(0, 0, 80, 40), { appearance: paint }),
      run('n1 text', 4, 4),
      shape('c1/pin', box(60, -8, 20, 20), {
        commentChrome: true,
        appearance: { fill: '#ffd', dropShadow: true },
      }),
      run('2', 66, -4),
      edge(
        'c1/leader',
        [
          [70, 2],
          [120, 30],
        ],
        { commentChrome: true, toEnd: 'none', appearance: { stroke: '#a80' } },
      ),
      shape('c1/bubble', box(120, 20, 100, 40), {
        commentChrome: true,
        appearance: { fill: '#ffd', dropShadow: true },
      }),
      run('body', 124, 24),
      shape('n2', box(0, 80, 80, 40), { appearance: paint }),
    ],
  },
  {
    id: 'edge/preamble-keyed',
    nodes: [
      run('first'),
      run('second', 0, 20),
      shape('s1'),
      run('after', 10, 80),
      edge(
        'e',
        [
          [0, 0],
          [10, 10],
        ],
        { appearance: { stroke: '#000' } },
      ),
      run('tail', 0, 100),
    ],
  },
  // ---- filter budget -------------------------------------------------------
  {
    id: 'budget/neon-board',
    nodes: Array.from({ length: 80 }, (_, i) =>
      shape(`n${i}`, box((i % 10) * 420, Math.floor(i / 10) * 280, 400, 260), {
        appearance: { stroke: '#0ff', glow: { radiusPx: 8 } },
      }),
    ),
    options: { padding: 5 },
  },
  {
    id: 'budget/neon-board-2x',
    nodes: Array.from({ length: 25 }, (_, i) =>
      shape(`n${i}`, box((i % 5) * 420, Math.floor(i / 5) * 280, 400, 260), {
        appearance: { stroke: '#0ff', glow: { radiusPx: 8 } },
      }),
    ),
    options: { padding: 5, rasterScale: 2 },
  },
  {
    id: 'budget/neon-board-1x',
    nodes: Array.from({ length: 25 }, (_, i) =>
      shape(`n${i}`, box((i % 5) * 420, Math.floor(i / 5) * 280, 400, 260), {
        appearance: { stroke: '#0ff', glow: { radiusPx: 8 } },
      }),
    ),
    options: { padding: 5 },
  },
  {
    id: 'budget/shadows',
    nodes: Array.from({ length: 80 }, (_, i) =>
      shape(`s${i}`, box((i % 10) * 120, Math.floor(i / 10) * 90, 110, 80), {
        appearance: { fill: '#fff', dropShadow: true },
      }),
    ),
    options: { padding: 5, rasterScale: 3 },
  },
  {
    id: 'budget/long-glow-edges',
    nodes: Array.from({ length: 40 }, (_, i) =>
      edge(
        `l${i}`,
        [
          [0, i * 10],
          [3000, 2500 + i * 10],
        ],
        { appearance: { stroke: '#0ff', glow: { radiusPx: 6 } } },
      ),
    ),
    options: { viewBox: box(0, 0, 1500, 1200) },
  },
  {
    id: 'budget/mixed',
    nodes: [
      ...Array.from({ length: 40 }, (_, i) =>
        shape(`m${i}`, box((i % 8) * 520, Math.floor(i / 8) * 340, 500, 320), {
          appearance: { stroke: '#0ff', glow: { radiusPx: 10 } },
        }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        shape(`d${i}`, box((i % 6) * 500, 1800 + Math.floor(i / 6) * 300, 480, 280), {
          appearance: { fill: '#fff', dropShadow: true },
        }),
      ),
    ],
    options: { padding: 5, rasterScale: 1.5 },
  },
  {
    id: 'budget/legend-room',
    legend: {
      keys: [
        {
          key: 'k',
          of: 'boxes',
          entries: Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, count: 1, swatch: {} })),
        },
      ],
      uncarried: { boxes: false, edges: false },
    },
    nodes: Array.from({ length: 26 }, (_, i) =>
      shape(`s${i}`, box((i % 10) * 170, Math.floor(i / 10) * 170, 150, 150), {
        appearance: { fill: '#fff', dropShadow: true },
      }),
    ),
    options: { rasterScale: 2 },
  },
  {
    id: 'budget/odd-scales',
    nodes: Array.from({ length: 70 }, (_, i) =>
      shape(`o${i}`, box((i % 10) * 420, Math.floor(i / 10) * 280, 400, 260), {
        appearance: { stroke: '#0ff', glow: { radiusPx: 12 } },
      }),
    ),
    options: { rasterScale: 0 },
  },
  {
    id: 'budget/negative-scale',
    nodes: Array.from({ length: 70 }, (_, i) =>
      shape(`o${i}`, box((i % 10) * 420, Math.floor(i / 10) * 280, 400, 260), {
        appearance: { stroke: '#0ff', glow: { radiusPx: 12 } },
      }),
    ),
    options: { rasterScale: -2 },
  },
]
