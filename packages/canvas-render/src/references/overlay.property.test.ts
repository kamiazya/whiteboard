/**
 * A surface's labels and dangling marks ride the wire as extras, so the
 * bundle rebuilt from it — on the main thread, in a worker, in the core —
 * carries a file reference the way the surface means it without a function
 * crossing anything.
 *
 * The oracle is the rule the overlay states, applied to the UN-overlaid
 * wire's own extra for the reference (the last of a key): the surface's label
 * wins over whatever named the reference, a dangling mark is added, and a
 * reference nothing speaks for carries no extra. It is read off the wire the
 * core is handed (`wireOfSeams`), after a structured clone. The generator draws records, extras (duplicates
 * included, since the last of a key wins on both sides of the wire), labels
 * and marks from one small pool of keys, so they overlap on most draws.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fc } from '../test-utils/fast-check.js'
import type { LoadedReference } from './loaded-reference.js'
import {
  overlayReferences,
  type ReferenceExtra,
  referenceSeamsFromWire,
  referenceWire,
  wireOfSeams,
} from './wire.js'

const KEYS = ['a', 'b', 'c', 'd'] as const
const key = fc.constantFrom(...KEYS)

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'n', x: 0, y: 0, width: 100, height: 60, text: 'inside' })],
  edges: [],
}

const record: fc.Arbitrary<LoadedReference | null> = fc.option(
  fc.record(
    {
      name: fc.constantFrom('Named', 'Other'),
      body: fc.constant('a note'),
      canvas: fc.constant(board),
    },
    { requiredKeys: [] },
  ),
)

const extra: fc.Arbitrary<ReferenceExtra> = fc.record(
  {
    label: fc.constantFrom('Extra', ''),
    missing: fc.boolean(),
    image: fc.constant({ href: 'blob:pic' }),
    facets: fc.constant({ title: 'Card', rows: [] }),
  },
  { requiredKeys: [] },
)

const drawn = fc.record({
  graph: fc.dictionary(key, record),
  extras: fc.array(fc.tuple(key, extra), { maxLength: 6 }),
  labels: fc.dictionary(key, fc.constantFrom('Alpha', 'Beta')),
  missing: fc.uniqueArray(key),
})

/** The overlay's rule, stated over the base wire's extra for a reference. */
function expected(
  base: ReferenceExtra | undefined,
  label: string | undefined,
  missing: boolean,
): ReferenceExtra | undefined {
  if (base === undefined && label === undefined && !missing) return undefined
  return {
    ...base,
    ...(label !== undefined ? { label } : {}),
    ...(missing ? { missing: true } : {}),
  }
}

/** A key's extra as a reader of the wire takes it: the last of its rows. */
const extraOf = (
  extras: readonly (readonly [string, ReferenceExtra])[],
  ref: string,
): ReferenceExtra | undefined => new Map(extras).get(ref)

describe('overlayReferences', () => {
  it('carries every reference as the base wire did, under the label and the dangling mark', () => {
    fc.assert(
      fc.property(drawn, ({ graph, extras, labels, missing }) => {
        const wire = referenceWire(new Map(Object.entries(graph)), { extras: new Map(extras) })
        const raw = { ...wire, extras }
        const labelMap = new Map(Object.entries(labels))
        const missingSet = new Set<string>(missing)
        const overlaid = overlayReferences(raw, { labels: labelMap, missing: missingSet })
        const after = wireOfSeams(referenceSeamsFromWire(structuredClone(overlaid)))
        if (after === undefined) throw new Error('a bundle rebuilt from a wire names its wire')
        for (const ref of [...KEYS, 'unnamed']) {
          expect(extraOf(after.extras, ref), ref).toEqual(
            expected(extraOf(raw.extras, ref), labelMap.get(ref), missingSet.has(ref)),
          )
        }
        // Only what the surface said is added: the record tables are the base's.
        expect(overlaid.entries).toEqual(raw.entries)
        expect(overlaid.aliases).toEqual(raw.aliases)
        expect(overlaid.titles).toEqual(raw.titles)
      }),
      { numRuns: 200 },
    )
  })
})
