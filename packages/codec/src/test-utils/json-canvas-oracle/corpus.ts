import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Dice, mulberry32 } from '../frontmatter-oracle/corpus.js'
import { EDGE_TEXTS, largeTexts } from './edges.js'
import { modelCanvas } from './model.js'
import { type ReaderCase, readerCase, type WriterCase, writerCase } from './oracle.js'
import { pick, render, URLS } from './pools.js'
import { damage, FAULT, wireDocument } from './wire.js'

/**
 * The inputs the recorded oracle asks the TypeScript about: JSON Canvas texts
 * for the reader (hand-written edges, one link per URL, then seeded documents,
 * damaged and mutated), model canvases for the writer in both modes. Generated
 * from a seed, so a re-recording is reproducible; the recording holds the
 * inputs themselves, so a test needs no generator.
 */
const READER_SEED = 0x5ba7a1
const WRITER_SEED = 0x71ce5
const MAX_TEXT = 6000

type Mutation = (text: string, d: Dice) => string

const INSERTS = [
  '"',
  ',',
  '}',
  '{',
  ']',
  '[',
  ':',
  '\\',
  '\n',
  ' ',
  '\u0000',
  '\u0001',
  '-',
  '0',
  'e',
]

const MUTATIONS: Mutation[] = [
  (t, d) => t.slice(0, d.int(t.length + 1)),
  (t, d) => {
    const at = d.int(t.length)
    return t.slice(0, at) + t.slice(at + 1)
  },
  (t, d) => {
    const at = d.int(t.length + 1)
    return t.slice(0, at) + pick(d, INSERTS) + t.slice(at)
  },
  (t) => t.replace(/"nodes"/, '"Nodes"'),
  (t) => t.replace(/"type":"/, '"type":" '),
  (t) => t.replace(/\d+/, '1.5'),
  (t) => t.replace(/\d+/, '-1'),
  (t) => t.replace(/"x-whiteboard"/, '"x-whiteboard2"'),
  (t) => t.replace(/\\u([0-9a-f]{4})/, '\\ud800'),
  (t) => `${t} `,
  (t) => `﻿${t}`,
]

export function generatedText(d: Dice): string {
  FAULT.on = d.chance(0.45)
  const doc = wireDocument(d)
  let text = render(FAULT.on && d.chance(0.5) ? damage(d, doc) : doc, d)
  for (let i = 0, n = d.chance(0.2) ? 1 + d.int(2) : 0; i < n; i++) {
    text = (pick(d, MUTATIONS) as Mutation)(text, d)
  }
  return text
}

/** `count` reader inputs. */
export function readerCases(count: number): ReaderCase[] {
  const d = new Dice(mulberry32(READER_SEED))
  const seen = new Set<string>()
  const texts: string[] = []
  const add = (text: string): void => {
    if (!seen.has(text) && text.length <= MAX_TEXT * 80) {
      seen.add(text)
      texts.push(text)
    }
  }
  for (const text of [...EDGE_TEXTS, ...largeTexts()]) add(text)
  for (let guard = 0; texts.length < count && guard < count * 20; guard++) {
    const text = generatedText(d)
    if (text.length <= MAX_TEXT) add(text)
  }
  return texts.map(readerCase)
}

const NUMBER_FACET = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.5,
  1e21,
  1e-7,
  1e-6,
  1.5e300,
  5e-324,
  1.7976931348623157e308,
  0.1 + 0.2,
  123456789012345680000,
  100,
  1e20,
  4294967296,
  -123.456,
  2 ** 53,
  2 ** 53 + 2,
]

const empty = (): SpatialCanvas => ({ nodes: [], edges: [] })

const withNode = (node: object, extra: object = {}): SpatialCanvas =>
  ({
    nodes: [{ id: 'a', x: 0, y: 0, width: 1, height: 1, ...node }],
    edges: [],
    ...extra,
  }) as unknown as SpatialCanvas

/** Hand-written canvases the generator is unlikely to build. */
function handCanvases(): SpatialCanvas[] {
  const link = (location: string): SpatialCanvas =>
    withNode({ resource: { mimeType: 'text/uri-list', location } })
  return [
    empty(),
    { nodes: [], edges: [], lines: [] },
    { nodes: [], edges: [], facets: {}, tags: [] },
    { nodes: [], edges: [], facets: { 'a.b/v0': NUMBER_FACET } },
    {
      nodes: [],
      edges: [],
      facets: Object.fromEntries([['a.b/v0', { b: 1, 2: 'two', 1: 'one', a: null }]]),
    },
    {
      nodes: [],
      edges: [],
      facets: Object.fromEntries([
        ['__proto__', { x: 1 }],
        ['a.b/v0', Object.fromEntries([['__proto__', 1]])],
      ]),
    },
    withNode({ x: -0.5, y: 2.5, width: 0.5, height: 1.5 }),
    withNode({ x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 1, height: 1 }),
    withNode({ embed: { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, facets: {}, tags: [] }),
    withNode({ tags: ['a'] }),
    withNode({ facets: { 'a.b/v0': 1 } }),
    withNode({
      label: 'L',
      background: 'b',
      backgroundStyle: 'cover',
      resource: { mimeType: 'x/y' },
    }),
    withNode({ resource: { mimeType: 'text/uri-list', content: 'c' } }),
    link('https://example.com'),
    link('nonsense'),
    link(''),
    ...URLS.map(link),
    {
      nodes: [{ id: 'a', x: 0, y: 0, width: 1, height: 1 }],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'a' }, bends: [{ x: 0.5, y: -0.5 }] }],
      lines: [
        {
          id: 'e',
          from: { kind: 'node', node: 'a' },
          to: { kind: 'point', point: { x: -0, y: 0.25 } },
        },
      ],
    } as unknown as SpatialCanvas,
  ]
}

/** `count` writer inputs, each asked in both modes. */
export function writerCases(count: number): WriterCase[] {
  const d = new Dice(mulberry32(WRITER_SEED))
  // `modelCanvas` reads the flag while it draws, so it is set before the
  // draws, never left to whatever the previous caller set it to: a writer
  // input is a model canvas, so its draws are the fault-free ones.
  FAULT.on = false
  const canvases = [...handCanvases()]
  while (canvases.length * 2 < count) canvases.push(modelCanvas(d))
  return canvases.flatMap((canvas) => [
    writerCase(canvas, 'extended'),
    writerCase(canvas, 'strict'),
  ])
}
