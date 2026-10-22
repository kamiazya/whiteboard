/**
 * Properties of the aggregate over the feed production gives it: one upsert
 * per listed document, built fresh for each query (`backlinksIn`). So the
 * questions are about a SET of documents, not a stream of events:
 *
 *   - the answer does not depend on the order the documents were fed in, and
 *     feeding one twice changes nothing;
 *   - the backlinks of a document are exactly the inverse of the forward
 *     references the other documents carry, resolved by the reader's rule.
 *
 * The inverse is judged by an oracle written from the rule itself (an id
 * names a document, a path names a document only if exactly one owns it, a
 * name names nothing) and shares no code with the aggregate.
 */

import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { fc, fcTest, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { snippetAround } from '@kamiazya/whiteboard-search'
import { describe, expect } from 'vitest'
import type { DocumentReferenceFacts } from './reference-aggregate.js'
import { ReferenceAggregate } from './reference-aggregate.js'

const IDS = [
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  '01CX5ZZKBKACTAV9WEVGEMMVRA',
] as const
// Up to three documents over two paths, so a shared path is common and the
// ambiguity arm is not a corner the generator reaches by luck.
const PATHS = ['alpha', 'dir/beta'] as const
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/

type Via = 'wikilink' | 'embed-node' | 'file-node'

const factsArb: fc.Arbitrary<DocumentReferenceFacts> = fc.record(
  {
    path: fc.constantFrom<string>(...PATHS),
    name: fc.option(fc.constantFrom('Plan', 'Note'), { nil: undefined }),
    kind: fc.option(fc.constantFrom(...documentKindSchema.options), { nil: undefined }),
    texts: fc.array(fc.constantFrom('Plan の話', 'plain prose'), { maxLength: 2 }),
    refs: fc.array(
      fc.oneof(
        fc
          .record({
            target: fc.constantFrom<string>(...IDS, ...PATHS, 'Plan'),
            via: fc.constant<'wikilink'>('wikilink'),
            text: fc.string({ minLength: 1, maxLength: 3 }),
            index: fc.constant(0),
            length: fc.constant(1),
          })
          .map((ref) => ({ ...ref, byId: ULID_SHAPE.test(ref.target) })),
        fc.record({
          target: fc.constantFrom<string>(...IDS, ...PATHS, 'Plan'),
          via: fc.constantFrom<Exclude<Via, 'wikilink'>>('embed-node', 'file-node'),
          context: fc.string({ minLength: 1, maxLength: 3 }),
        }),
      ),
      { maxLength: 4 },
    ),
  },
  { noNullPrototype: true },
) as fc.Arbitrary<DocumentReferenceFacts>

/** The documents of one query: each id at most once, as a listing gives them. */
const feedArb: fc.Arbitrary<readonly (readonly [string, DocumentReferenceFacts])[]> = fc
  .uniqueArray(fc.constantFrom<string>(...IDS), { minLength: 2, maxLength: IDS.length })
  .chain((ids) => fc.tuple(...ids.map((id) => factsArb.map((facts) => [id, facts] as const))))

function feed(documents: readonly (readonly [string, DocumentReferenceFacts])[]) {
  const aggregate = new ReferenceAggregate()
  for (const [id, facts] of documents) aggregate.upsert(id, facts)
  return aggregate
}

function stateOf(aggregate: ReferenceAggregate): unknown {
  return IDS.map((id) => ({ id, backlinks: aggregate.backlinksOf(id) }))
}

/** Whether a reference names `targetId`, by the reader's rule. */
function pointsTo(
  documents: readonly (readonly [string, DocumentReferenceFacts])[],
  targetId: string,
): (ref: DocumentReferenceFacts['refs'][number]) => boolean {
  const targetPath = documents.find(([id]) => id === targetId)?.[1].path
  const ownersOf = (path: string) => documents.filter(([, facts]) => facts.path === path)
  return (ref) => {
    if (ref.via === 'embed-node') return ref.target === targetId
    if (ref.via === 'file-node') return ref.target === targetPath
    if (ULID_SHAPE.test(ref.target)) return ref.target === targetId
    const owners = ownersOf(ref.target)
    return owners.length === 1 && owners[0]?.[0] === targetId
  }
}

function expectedBacklinks(
  documents: readonly (readonly [string, DocumentReferenceFacts])[],
  targetId: string,
) {
  if (!documents.some(([id]) => id === targetId)) return []
  const points = pointsTo(documents, targetId)
  return (
    documents
      .filter(([id]) => id !== targetId)
      .map(([id, facts]) => ({
        id,
        facts,
        contexts: facts.refs
          .filter(points)
          // At most three excerpts per source, the first in document order.
          .slice(0, 3)
          .map((r) =>
            r.via === 'wikilink' ? snippetAround(r.text, r.index, r.length) : r.context,
          ),
      }))
      .filter((hit) => hit.contexts.length > 0)
      // Single-segment or one-level paths, so plain string order is the
      // segment-wise order the index contract fixes.
      .sort((a, b) => {
        if (a.facts.path !== b.facts.path) return a.facts.path < b.facts.path ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
      .map(({ id, facts, contexts }) => ({
        documentId: id,
        path: facts.path,
        ...(facts.name === undefined ? {} : { name: facts.name }),
        ...(facts.kind === undefined ? {} : { kind: facts.kind }),
        contexts,
      }))
  )
}

describe('ReferenceAggregate over a listing', () => {
  fcTest.prop(
    [
      feedArb.chain((documents) =>
        fc.record({
          documents: fc.constant(documents),
          order: fc.shuffledSubarray(
            documents.flatMap((_, i) => [i, i]),
            { minLength: documents.length * 2, maxLength: documents.length * 2 },
          ),
        }),
      ),
    ],
    withDefaults({ numRuns: 300 }),
  )(
    'feeding the documents in any order, each twice, gives the in-order answer',
    ({ documents, order }) => {
      const scrambled = new ReferenceAggregate()
      for (const index of order) {
        const document = documents[index]
        if (document !== undefined) scrambled.upsert(document[0], document[1])
      }
      expect(stateOf(scrambled)).toEqual(stateOf(feed(documents)))
    },
  )

  fcTest.prop([feedArb], withDefaults({ numRuns: 300 }))(
    'a document is a backlink exactly when its references resolve to the target',
    (documents) => {
      const aggregate = feed(documents)
      for (const id of IDS) {
        expect(aggregate.backlinksOf(id)).toEqual(expectedBacklinks(documents, id))
      }
    },
  )

  // A property that never reaches a backlink, or never reaches an ambiguous
  // path, passes by asserting on empty lists.
  fcTest('the feed generator reaches resolving, ambiguous and absent references', () => {
    const sample = fc.sample(feedArb, { numRuns: 400 })
    const withBacklink = sample.filter((documents) =>
      IDS.some((id) => expectedBacklinks(documents, id).length > 0),
    ).length
    const ambiguous = sample.filter((documents) => {
      const paths = documents.map(([, facts]) => facts.path)
      return documents.some(([, facts]) =>
        facts.refs.some(
          (ref) => ref.via === 'wikilink' && paths.filter((p) => p === ref.target).length > 1,
        ),
      )
    }).length
    // Each floor sits under the lowest count over two samples of 4,000 draws
    // of this 400 (withBacklink min 213, median 250; ambiguous min 36, median
    // 61), so the left tail does not reach it, while a generator that stops
    // producing the arrangement still falls far below.
    expect(withBacklink, 'feeds with a backlink').toBeGreaterThan(150)
    expect(ambiguous, 'feeds with a wikilink to a shared path').toBeGreaterThan(25)
  })
})

/**
 * One source written densely, so a source with more resolving references
 * than an answer carries excerpts for is the common case: the feed above
 * reaches it in ~1% of draws.
 */
const denseFeedArb = fc
  .array(
    fc.record({
      target: fc.constantFrom<string>(IDS[1], 'dir/beta', 'alpha'),
      text: fc.string({ minLength: 1, maxLength: 3 }),
    }),
    { maxLength: 9 },
  )
  .map((written): (readonly [string, DocumentReferenceFacts])[] => [
    [
      IDS[0],
      {
        path: 'alpha',
        texts: [],
        refs: written.map(({ target, text }) => ({
          target,
          via: 'wikilink' as const,
          byId: ULID_SHAPE.test(target),
          text,
          index: 0,
          length: 1,
        })),
      },
    ],
    [IDS[1], { path: 'dir/beta', texts: [], refs: [] }],
  ])

describe('the excerpts one source carries', () => {
  fcTest.prop([denseFeedArb], withDefaults({ numRuns: 300 }))(
    'are the first three of its resolving references, in document order',
    (documents) => {
      expect(feed(documents).backlinksOf(IDS[1])).toEqual(expectedBacklinks(documents, IDS[1]))
    },
  )

  fcTest('the dense generator reaches a source with more references than excerpts', () => {
    const sample = fc.sample(denseFeedArb, { numRuns: 400 })
    const clipped = sample.filter(
      (documents) => (documents[0]?.[1].refs.filter(pointsTo(documents, IDS[1])).length ?? 0) > 3,
    ).length
    // Measured 135-160 of 400 over six samples; a generator that stops
    // writing past three falls to zero.
    expect(clipped, 'sources clipped to three excerpts').toBeGreaterThan(100)
  })
})
