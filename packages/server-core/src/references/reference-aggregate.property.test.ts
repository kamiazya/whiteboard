/**
 * Convergence properties for the event-fed half of the aggregate: the
 * guarantees an incremental feed will lean on before it exists. Events are
 * per-document replacements tagged with seq, so:
 *
 *   - applying a stream SHUFFLED and WITH DUPLICATES must converge to the
 *     same state as applying it in order (per-document last-seq-wins);
 *   - a remove is a tombstone: a late (stale-seq) upsert cannot resurrect.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { DocumentReferenceFacts } from './reference-aggregate.js'
import { ReferenceAggregate } from './reference-aggregate.js'

const IDS = [
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  '01CX5ZZKBKACTAV9WEVGEMMVRA',
] as const
const PATHS = ['alpha', 'beta', 'gamma'] as const

type Event =
  | { t: 'upsert'; id: string; facts: DocumentReferenceFacts }
  | { t: 'remove'; id: string }

const factsArb: fc.Arbitrary<DocumentReferenceFacts> = fc.record(
  {
    path: fc.constantFrom<string>(...PATHS),
    name: fc.option(fc.constantFrom('Plan', 'Note'), { nil: undefined }),
    refs: fc.array(
      fc.record({
        target: fc.constantFrom<string>(...IDS, ...PATHS, 'Plan'),
        via: fc.constantFrom('wikilink' as const, 'embed-node' as const, 'file-node' as const),
        context: fc.constant('ctx'),
      }),
      { maxLength: 3 },
    ),
  },
  { noNullPrototype: true },
) as fc.Arbitrary<DocumentReferenceFacts>

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('upsert' as const),
      id: fc.constantFrom<string>(...IDS),
      facts: factsArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('remove' as const),
      id: fc.constantFrom<string>(...IDS),
    }),
  },
)

function apply(aggregate: ReferenceAggregate, event: Event, seq: number): void {
  if (event.t === 'upsert') aggregate.upsert(event.id, seq, event.facts)
  else aggregate.remove(event.id, seq)
}

function stateOf(aggregate: ReferenceAggregate): unknown {
  return IDS.map((id) => ({ id, backlinks: aggregate.backlinksOf(id) }))
}

describe('ReferenceAggregate convergence', () => {
  fcTest.prop(
    [
      fc.array(eventArb, { minLength: 1, maxLength: 12 }).chain((events) =>
        fc.record({
          events: fc.constant(events),
          // A delivery order over the seq-tagged stream: every event
          // delivered (a dropped event is a DIFFERENT stream, out of
          // scope), each duplicated exactly once, the whole thing shuffled.
          order: fc.shuffledSubarray(
            events.flatMap((_, i) => [i, i]),
            { minLength: events.length * 2, maxLength: events.length * 2 },
          ),
        }),
      ),
    ],
    withDefaults({ numRuns: 300 }),
  )('shuffled + duplicated delivery converges to in-order state', ({ events, order }) => {
    const ordered = new ReferenceAggregate()
    events.forEach((event, seq) => {
      apply(ordered, event, seq)
    })

    const scrambled = new ReferenceAggregate()
    for (const index of order) {
      const event = events[index]
      if (event !== undefined) apply(scrambled, event, index)
    }
    expect(stateOf(scrambled)).toEqual(stateOf(ordered))
  })

  fcTest.prop([factsArb], withDefaults())(
    'a stale upsert cannot resurrect a tombstone',
    (facts) => {
      const aggregate = new ReferenceAggregate()
      aggregate.upsert(IDS[0], 1, facts)
      aggregate.remove(IDS[0], 5)
      aggregate.upsert(IDS[0], 3, facts) // late delivery of an old write
      expect(aggregate.has(IDS[0])).toBe(false)
      expect(aggregate.backlinksOf(IDS[0])).toEqual([])
    },
  )
})
