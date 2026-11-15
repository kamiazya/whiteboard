import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { type ReferenceWire, referenceSeamsFromWire } from '../../references/wire.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import {
  boards,
  type CaseSpec,
  CHILD_ID,
  caseSpecs,
  REFERENCES,
  TAG_LIBRARY,
} from '../compose-canvas-oracle/corpus.js'
import { createFakeMeasure } from '../fake-measure.js'
import { ROUTING_CORPUS, syntheticLayouts } from '../routing-corpus.js'

/**
 * The layouts the whole-layout core is held to (ADR-0054 step 7), by the
 * differential (`layout-spatial-canvas.rust.test.ts`) and by the recording
 * the crate replays natively (`layout-recorded-oracle.test.ts`). The boards
 * are the composer recordings' (frames, locks, suppression, geometry
 * overrides, pinned sides, an embed path, a tag library, file nodes drawing
 * canvases three deep, a body embedding a canvas) under the clean style, the
 * routing corpus, bodies aimed at the typesetter, and two layouts only the
 * TypeScript can draw exactly; every reference crosses as a wire.
 */

/**
 * What a case is aimed at. Each topic is recorded in its own file
 * (`oracle/layout-spatial-canvas.<topic>.jsonl`), so a slice that teaches the
 * core something new adds a topic and a recording rather than re-recording
 * the others.
 */
export type LayoutTopic =
  | 'composer'
  | 'bodies'
  | 'declined'
  | 'expansion'
  | 'fragment'
  | 'routing'

export interface LayoutCase {
  readonly topic: LayoutTopic
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly options: SpatialLayoutOptions
}

const CHILD = REFERENCES['boards/child.canvas']

/** The composer recordings' references as a keeper's wire: each canvas by path, the child by id. */
const WIRE: ReferenceWire = {
  entries: [
    ...Object.entries(REFERENCES).map(
      ([ref, nested]) => [ref, { name: nested.title, canvas: nested.canvas }] as const,
    ),
    ['child', { documentId: CHILD_ID, name: 'Child', canvas: CHILD?.canvas }] as const,
    ['note', { documentId: 'D-NOTE', name: 'Note', body: '# Note\n\nsee [[child]]' }] as const,
    ['gone', null] as const,
  ],
  aliases: [['child', CHILD_ID]],
  titles: [['D-NOTE', 'Note']],
  extras: [
    ['boards/plain.canvas', { label: 'The plain one' }],
    [
      'gone',
      {
        missing: true,
        image: { href: 'data:image/png;base64,AAAA', alt: 'a pixel', width: 40, height: 20 },
      },
    ],
    [
      'card',
      { label: 'Card', facets: { title: 'Facts', rows: [{ label: 'owner', value: 'core' }] } },
    ],
  ],
}

const BODIES = [
  'A picture ![a pixel](gone) inline, and alone:\n\n![a pixel](gone)',
  '# Heading\n\nA paragraph with **strong**, *emphasis*, `code` and ~~deleted~~ words.',
  '- one\n- two\n  - nested\n- [x] done\n\n1. first\n2. second',
  '| a | b |\n|---|---|\n| 1 | 2 |\n| long cell text | x |',
  '> a quote\n> over lines\n\n---\n\n```\nplain fence\n```',
  'A link to [[child]], a wiki [[note|named]], an [external](https://example.com) one.',
  '![[child]]',
  '![[note]]',
  '![[gone]]',
  '$$\nx^2\n$$\n\n<b>raw</b>',
  '日本語の文章は句読点で折り返されるべきです。長い文がここに続きます。',
]

/** Text nodes holding the bodies, a file node per kind of reference, and an edge between two. */
function bodiesBoard(): SpatialCanvas {
  const text = BODIES.map((body, i) =>
    textNode({
      id: `t${i}`,
      x: (i % 4) * 260,
      y: Math.floor(i / 4) * 220,
      width: 240,
      height: 200,
      text: body,
    }),
  )
  const file = (id: string, location: string, x: number): SpatialNode => ({
    id,
    x,
    y: 700,
    width: 240,
    height: 160,
    resource: { mimeType: 'application/octet-stream', location },
  })
  return {
    nodes: [
      ...text,
      file('fn', 'note', 0),
      file('fp', 'boards/plain.canvas', 260),
      file('fg', 'gone', 520),
      file('fc', 'card', 1040),
      { id: 'u', x: 780, y: 700, width: 80, height: 80, resource: { mimeType: 'x/unknown' } },
    ],
    edges: [{ id: 'e', from: { node: 't0' }, to: { node: 't1' }, label: 'reads' }],
  }
}

/**
 * A board a fragment narrows: two groups labelled alike but for case, one
 * nested in the other, a card outside both, edges inside, across and out of
 * a group, and a line.
 */
function fragmentTarget(): SpatialCanvas {
  const card = (id: string, x: number, y: number) =>
    textNode({ id, x, y, width: 80, height: 40, text: `card ${id}` })
  return {
    nodes: [
      groupNode({ id: 'g-plan', x: 0, y: 0, width: 400, height: 300, label: 'plan' }),
      card('a', 20, 40),
      groupNode({ id: 'g-inner', x: 160, y: 100, width: 220, height: 180, label: 'Inner' }),
      card('b', 200, 160),
      groupNode({ id: 'g-Plan', x: 500, y: 0, width: 300, height: 200, label: 'Plan' }),
      card('c', 540, 60),
      card('out', 900, 60),
    ],
    edges: [
      { id: 'ab', from: { node: 'a' }, to: { node: 'b' }, label: 'in' },
      { id: 'ac', from: { node: 'a' }, to: { node: 'c' } },
      { id: 'c-out', from: { node: 'c' }, to: { node: 'out' } },
    ],
    lines: [
      {
        id: 'ink',
        from: { kind: 'node', node: 'b' },
        to: { kind: 'point', point: { x: 0, y: 320 } },
      },
    ],
  }
}

const FRAGMENT_WIRE: ReferenceWire = {
  entries: [
    ['board', { documentId: 'D-BOARD', name: 'Board', canvas: fragmentTarget() }],
    ['note', { documentId: 'D-NOTE', name: 'Note', body: '# Note\n\nbody\n\n## Part\n\npart' }],
  ],
  aliases: [],
  titles: [],
  extras: [],
}

/** What a body's `![[board#…]]` can name: a label exactly or by case, a nested group, `^id`, a card, nothing. */
const FRAGMENTS = ['Plan', 'plan', 'PLAN', 'Inner', '^g-inner', '^a', '^out', 'Nope', '^missing']

/** One text node per fragment, each embedding the board narrowed to it, and the whole board once. */
function fragmentBoard(): SpatialCanvas {
  const bodies = [...FRAGMENTS.map((f) => `![[board#${f}]]`), '![[board]]', '![[note#Part]]']
  return {
    nodes: bodies.map((text, i) =>
      textNode({
        id: `f${i}`,
        x: (i % 4) * 260,
        y: Math.floor(i / 4) * 260,
        width: 240,
        height: 240,
        text,
      }),
    ),
    edges: [],
  }
}

const measure = createFakeMeasure()

function optionsOf(spec: CaseSpec): SpatialLayoutOptions | undefined {
  if (spec.appearance === 'unmoded-dark') return undefined
  const [paddingPx, labelFontSizePx, minContentWidthPx] = spec.geometry ?? []
  return {
    measure,
    appearance: createSpatialTheme({ mode: spec.appearance }),
    ...(spec.geometry === undefined
      ? {}
      : {
          geometry: {
            paddingPx: paddingPx as number,
            labelFontSizePx: labelFontSizePx as number,
            minContentWidthPx: minContentWidthPx as number,
          },
        }),
    ...(spec.locked === undefined ? {} : { lockedNodeIds: spec.locked }),
    ...(spec.suppressed === undefined ? {} : { suppressedBodyNodeIds: spec.suppressed }),
    ...(spec.library === true ? { tagLibrary: TAG_LIBRARY } : {}),
    ...(spec.overrides === undefined ? {} : { edgeSideOverrides: new Map(spec.overrides) }),
    ...(spec.embedPath === undefined ? {} : { embedPath: spec.embedPath }),
  }
}

/** The composer recordings' boards under the clean style, each with file nodes drawn open and closed. */
function composerCases(): LayoutCase[] {
  const cases: LayoutCase[] = []
  const byName = new Map(boards().map((b) => [b.name, b.canvas]))
  for (const [at, spec] of caseSpecs().entries()) {
    const options = optionsOf(spec)
    const canvas = byName.get(spec.board)
    if (options === undefined || canvas === undefined) continue
    for (const expand of [true, false]) {
      cases.push({
        topic: 'composer',
        name: `${spec.board}#${at} expand=${expand}`,
        canvas,
        options: {
          ...options,
          references: referenceSeamsFromWire(WIRE),
          expandFileNode: () => expand,
        },
      })
    }
  }
  return cases
}

/**
 * The nesting board under policies that open some file nodes and not others,
 * at the root and down the nested canvases: each one only, and all but each.
 */
const EXPANSIONS: readonly (readonly [string, (node: SpatialNode) => boolean])[] = [
  ...['f-child', 'f-deep', 'loop', 'deeper', 'down2'].map(
    (id) => [`only ${id}`, (node: SpatialNode) => node.id === id] as const,
  ),
  ...['f-child', 'loop', 'down1', 'down3'].map(
    (id) => [`all but ${id}`, (node: SpatialNode) => node.id !== id] as const,
  ),
  ['the root only', (node) => node.id.startsWith('f-')],
]

function expansionCases(): LayoutCase[] {
  const canvas = boards().find((b) => b.name === 'nesting')?.canvas
  if (canvas === undefined) return []
  const references = referenceSeamsFromWire(WIRE)
  const light = { measure, appearance: createSpatialTheme({ mode: 'light' }) }
  return EXPANSIONS.map(([name, expandFileNode]) => ({
    topic: 'expansion',
    name: `nesting, ${name}`,
    canvas,
    options: { ...light, references, expandFileNode },
  }))
}

/** Every layout case; `synthetic` draws that many generated routing boards too. */
export function layoutCases(synthetic: number): LayoutCase[] {
  const cases = [...composerCases(), ...expansionCases()]
  const light = { measure, appearance: createSpatialTheme({ mode: 'light' }) }
  cases.push(
    {
      topic: 'bodies',
      name: 'bodies',
      canvas: bodiesBoard(),
      options: { ...light, references: referenceSeamsFromWire(WIRE), expandFileNode: () => true },
    },
    {
      topic: 'bodies',
      name: 'bodies, nothing resolved',
      canvas: bodiesBoard(),
      options: light,
    },
  )
  cases.push({
    topic: 'fragment',
    name: 'fragments',
    canvas: fragmentBoard(),
    options: { ...light, references: referenceSeamsFromWire(FRAGMENT_WIRE) },
  })
  // What only the TypeScript can draw exactly: a fence its highlighter colours, a shortcode.
  for (const text of ['```js\nlet x = 1\n```', 'ship it :rocket:']) {
    const canvas = {
      nodes: [textNode({ id: 'd', x: 0, y: 0, width: 200, height: 100, text })],
      edges: [],
    }
    cases.push({ topic: 'declined', name: `declined: ${text}`, canvas, options: light })
  }
  for (const board of [...ROUTING_CORPUS, ...syntheticLayouts(synthetic)]) {
    for (const routing of ['straight', 'orthogonal'] as const) {
      const canvas = {
        nodes: [...board.nodes],
        edges: [...board.edges],
        facets: { 'visual.edges/v0': { routing } },
      } as SpatialCanvas
      cases.push({ topic: 'routing', name: `${board.name} ${routing}`, canvas, options: light })
    }
  }

  return cases
}
