/**
 * The silhouette vocabulary is written out in several places and nothing tied
 * them together.
 *
 * `visual.shape/v0`'s enum is what a document may SAY; `BUILT_IN_SHAPES` is
 * what this renderer can DRAW; and two more copies exist as hand-written
 * arrays in a test and a bench. plugin-visual's own comment says "canvas-render
 * asserts the alignment in its own tests, since this package cannot depend on
 * it" — and the test it meant carries its own hand-written list, so an enum
 * that grew while the list did not failed nothing at all.
 *
 * That is `.claude/rules/coverage-ledger.md`'s question exactly: when someone
 * adds member N+1, is anything forced to notice? Until this file, no. Found
 * while sizing what it would take to add a sixth silhouette, which is the
 * change the facet score says would free the colour channel.
 *
 * The direction is fixed by the architecture: plugin-visual may not import
 * the renderer (`renderer-independence.test.ts` pins that), so the guard
 * lives on the side that can see both.
 */
import { visualShapeFacetSchema } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_SHAPES } from './node-outline.js'

/** What a document may say. The enum is the single source; this reads it. */
const DECLARED_SHAPE_KINDS = visualShapeFacetSchema.shape.kind.options

/** The id an outline is looked up by, composed from a bare facet kind. */
const shapeIdOf = (kind: string) => `visual.${kind}`

describe('the silhouette vocabulary is one list', () => {
  it('finds a plausible number of kinds, so an empty pass is not a broken read', () => {
    // Without this the two directions below both pass vacuously the moment
    // the enum accessor stops resolving.
    expect(DECLARED_SHAPE_KINDS.length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(BUILT_IN_SHAPES).length).toBeGreaterThanOrEqual(5)
  })

  it('draws every kind a document may declare', () => {
    const undrawable = DECLARED_SHAPE_KINDS.filter((kind) => !(shapeIdOf(kind) in BUILT_IN_SHAPES))
    expect(undrawable).toEqual([])
  })

  it('declares every kind it can draw, so nothing is reachable only by hand', () => {
    const declared = new Set(DECLARED_SHAPE_KINDS.map(shapeIdOf))
    expect(Object.keys(BUILT_IN_SHAPES).filter((id) => !declared.has(id))).toEqual([])
  })
})
