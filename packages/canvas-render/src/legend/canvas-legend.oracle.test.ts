// The legend reads each element's scoped tags once; the reading it replaced
// re-parsed them per carried key. The two must name the same keys, values,
// counts and swatches on every board, so the earlier reading is kept below
// verbatim as the oracle. Both sides ask `scoreFacets` which keys carry the
// colour — that is shared on purpose, since only the tag reading changed, and
// it means this property says nothing about the score itself.
//
// The generator drives each board's colour from one key's values, so keys
// really are carried; it also draws frames and `frame:`/`kind:` tags, because
// a built-in partition carrying the colour while a box writes the same key as
// a tag is the one place an element can carry two values under a listed key.
// Boards reach that last case too rarely to rely on, so an example pins it.

import type {
  CanvasColor,
  CanvasEdge,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { compareCodeUnit, isFrame, parseScopedTag } from '@kamiazya/whiteboard-model'
import { afterAllFloor, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { LegendEntry, LegendKey, LegendSwatch, SceneLegend } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { scoreFacets } from '../quality/facet-score.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'
import { canvasLegend } from './canvas-legend.js'

// --- The per-key reading, verbatim ---------------------------------------

interface Tagged {
  readonly id: string
  readonly tags?: readonly string[]
}

function valueUnder(element: Tagged, key: string): string {
  for (const tag of element.tags ?? []) {
    const scoped = parseScopedTag(tag)
    if (scoped?.key === key) return scoped.value
  }
  return ''
}

function isTagKey(elements: readonly Tagged[], key: string): boolean {
  return elements.some((element) =>
    (element.tags ?? []).some((tag) => parseScopedTag(tag)?.key === key),
  )
}

function entriesFor<T extends Tagged>(
  elements: readonly T[],
  key: string,
  swatchOf: (element: T) => LegendSwatch,
): LegendEntry[] {
  const classes = new Map<string, { count: number; swatch: LegendSwatch }>()
  for (const element of elements) {
    const value = valueUnder(element, key)
    const seen = classes.get(value)
    classes.set(value, { count: (seen?.count ?? 0) + 1, swatch: seen?.swatch ?? swatchOf(element) })
  }
  return [...classes]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : compareCodeUnit(a, b)))
    .map(([value, { count, swatch }]) => ({ value, count, swatch }))
}

function boxSwatch(appearance: SpatialAppearanceResolver, node: SpatialNode): LegendSwatch {
  const resolved = appearance.resolveNode(node).appearance
  return {
    ...(resolved?.fill === undefined ? {} : { fill: resolved.fill }),
    ...(resolved?.stroke === undefined ? {} : { stroke: resolved.stroke }),
  }
}

function edgeSwatch(appearance: SpatialAppearanceResolver, edge: CanvasEdge): LegendSwatch {
  const stroke = appearance.resolveEdge(edge)?.stroke
  return stroke === undefined ? {} : { stroke }
}

function oracleLegend(
  canvas: SpatialCanvas,
  appearance: SpatialAppearanceResolver,
): SceneLegend | undefined {
  const score = scoreFacets(canvas)
  const boxes = canvas.nodes.filter((node) => !isFrame(node))
  const keys: LegendKey[] = [
    ...score.channels.colour.carriedBy
      .filter((key) => isTagKey(boxes, key))
      .map((key) => ({
        key,
        of: 'boxes' as const,
        entries: entriesFor(boxes, key, (node) => boxSwatch(appearance, node)),
      })),
    ...score.edges.colour.carriedBy
      .filter((key) => isTagKey(canvas.edges, key))
      .map((key) => ({
        key,
        of: 'edges' as const,
        entries: entriesFor(canvas.edges, key, (edge) => edgeSwatch(appearance, edge)),
      })),
  ]
  const uncarried = {
    boxes: score.channels.colour.use === 'contested',
    edges: score.edges.colour.use === 'contested',
  }
  if (keys.length === 0 && !uncarried.boxes && !uncarried.edges) return undefined
  return { keys, uncarried }
}

// --- The boards ----------------------------------------------------------

const appearance: SpatialAppearanceResolver = {
  resolveNode: (node) => ({
    appearance:
      node.color === undefined
        ? { fill: 'fill-default' }
        : { fill: `fill-${node.color}`, stroke: `stroke-${node.color}` },
  }),
  resolveEdge: (edge) =>
    'color' in edge && edge.color !== undefined ? { stroke: `edge-${edge.color}` } : {},
  resolveLabel: () => ({}),
}

const KEYS = ['health', 'tier', 'frame', 'kind'] as const
const VALUES = ['a', 'b', 'c'] as const
const colour = fc.constantFrom<CanvasColor>('1', '2', '3', '#ff0000')
/** `undefined` most of the time, else a draw from `arb`. */
const rarely = <T>(arb: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 6, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: arb })
const scopedTag = fc.tuple(fc.constantFrom(...KEYS), fc.constantFrom(...VALUES))
// Mostly one value per key, so a key can partition; now and then a second
// value under a key already written, or a tag that is not scoped at all.
const tags = fc
  .uniqueArray(scopedTag, { selector: ([key]) => key, minLength: 1, maxLength: 3 })
  .chain((unique) =>
    rarely(
      fc.oneof(
        // A second value under a key this element already wrote.
        fc
          .tuple(fc.constantFrom(...unique), fc.constantFrom(...VALUES))
          .map(([[key], value]) => `${key}:${value}`),
        fc.constantFrom('plain', 'Not:Scoped'),
      ),
    ).map((extra) => [
      ...unique.map(([k, v]) => `${k}:${v}`),
      ...(extra === undefined ? [] : [extra]),
    ]),
  )
const element = fc.record({
  tags: fc.option(tags, { nil: undefined }),
  // Now and then an own colour (or none) that ignores the driving key.
  noise: rarely(fc.option(colour, { nil: null })),
})
// Distinct colours per value, so the driving key usually carries the colour.
const palette = fc
  .tuple(
    fc.shuffledSubarray(['1', '2', '3', '#ff0000'] as CanvasColor[], {
      minLength: 4,
      maxLength: 4,
    }),
    fc.boolean(),
  )
  .map(([[a, b, c, rest], untaggedColoured]) => ({
    a: a as CanvasColor,
    b: b as CanvasColor,
    c: c as CanvasColor,
    '': untaggedColoured ? (rest as CanvasColor) : null,
  }))

/** The colour the driving key's value picks, unless the element brought its own. */
function colourOf(
  row: { tags: readonly string[] | undefined; noise: CanvasColor | null | undefined },
  value: string,
  colours: Record<string, CanvasColor | null>,
): CanvasColor | undefined {
  if (row.noise !== undefined) return row.noise ?? undefined
  return colours[value] ?? undefined
}

const tagValue = (row: { tags: readonly string[] | undefined }, key: string) =>
  valueUnder({ id: '', tags: row.tags ?? [] }, key)

const board: fc.Arbitrary<SpatialCanvas> = fc
  .record({
    // `frame` drives the boxes by frame membership, so a built-in partition
    // carries the colour while boxes may still write `frame:` as a tag.
    driver: fc.constantFrom('health', 'frame'),
    edgeDriver: fc.constantFrom('health', 'tier'),
    boxColours: palette,
    edgeColours: palette,
    boxes: fc.array(element, { minLength: 1, maxLength: 8 }),
    edges: fc.array(element, { maxLength: 6 }),
    frames: fc.boolean(),
  })
  .map(({ driver, edgeDriver, boxColours, edgeColours, boxes, edges, frames }) => {
    const nodes: SpatialNode[] = boxes.map((row, i) => {
      const value =
        driver === 'frame' && frames
          ? VALUES[Math.floor(i / 2) % VALUES.length]
          : tagValue(row, driver)
      const color = colourOf(row, value ?? '', boxColours)
      return textNode({
        id: `n${i}`,
        text: `n${i}`,
        x: i * 200,
        y: 0,
        width: 100,
        height: 50,
        ...(row.tags === undefined ? {} : { tags: row.tags }),
        ...(color === undefined ? {} : { color }),
      })
    })
    // Each frame holds two neighbouring boxes, so membership can partition.
    const groups = frames
      ? Array.from({ length: Math.ceil(boxes.length / 2) }, (_, j) =>
          groupNode({ id: `g${j}`, x: j * 400 - 20, y: -20, width: 340, height: 90, label: '' }),
        )
      : []
    const links: CanvasEdge[] =
      boxes.length < 2
        ? []
        : edges.map((row, i) => {
            const color = colourOf(row, tagValue(row, edgeDriver), edgeColours)
            return {
              id: `e${i}`,
              from: { node: `n${i % boxes.length}` },
              to: { node: `n${(i + 1) % boxes.length}` },
              ...(row.tags === undefined ? {} : { tags: row.tags }),
              ...(color === undefined ? {} : { color }),
            }
          })
    return { nodes: [...groups, ...nodes], edges: links }
  })

const reach = { boards: 0, boxKeys: 0, edgeKeys: 0, builtInKeys: 0 }

describe('canvasLegend against the per-key reading', () => {
  fcTest.prop([board], withDefaults({ numRuns: 300 }))(
    'names the keys, values, counts and swatches the per-key reading does',
    (canvas) => {
      const expected = oracleLegend(canvas, appearance)
      reach.boards += 1
      if (expected?.keys.some((k) => k.of === 'boxes')) reach.boxKeys += 1
      if (expected?.keys.some((k) => k.of === 'edges')) reach.edgeKeys += 1
      if (expected?.keys.some((k) => k.key === 'frame' || k.key === 'kind')) reach.builtInKeys += 1
      expect(canvasLegend(canvas, appearance)).toEqual(expected)
    },
  )

  it('lists the first value a box writes under a built-in key that carries the colour', () => {
    // Frame membership carries the colour; one box also writes `frame:` twice.
    const canvas: SpatialCanvas = {
      nodes: [
        groupNode({ id: 'g0', x: -20, y: -20, width: 340, height: 90, label: '' }),
        groupNode({ id: 'g1', x: 380, y: -20, width: 340, height: 90, label: '' }),
        textNode({
          id: 'n0',
          text: '',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          color: '1',
          tags: ['frame:b', 'frame:a'],
        }),
        textNode({ id: 'n1', text: '', x: 200, y: 0, width: 100, height: 50, color: '1' }),
        textNode({ id: 'n2', text: '', x: 400, y: 0, width: 100, height: 50, color: '2' }),
      ],
      edges: [],
    }
    const legend = canvasLegend(canvas, appearance)
    expect(legend?.keys.map((k) => [k.key, k.entries.map((e) => e.value)])).toEqual([
      ['frame', ['b', '']],
    ])
    expect(legend).toEqual(oracleLegend(canvas, appearance))
  })

  afterAllFloor(['names the keys, values, counts and swatches the per-key reading does'], () => {
    // Equality is not vacuous: boards list keys of both populations, and
    // some list a built-in key a box also writes as a tag. Measured at about
    // 0.39, 0.35 and 0.10 of 300 boards.
    expect(reach.boxKeys / reach.boards).toBeGreaterThan(0.25)
    expect(reach.edgeKeys / reach.boards).toBeGreaterThan(0.2)
    expect(reach.builtInKeys / reach.boards).toBeGreaterThan(0.03)
  })
})
