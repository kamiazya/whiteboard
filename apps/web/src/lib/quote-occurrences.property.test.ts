// @vitest-environment node
/**
 * Remembering where quotes occur must never change an answer: after any run
 * of edits, every anchor resolved through the memory lands exactly where a
 * fresh `resolveTextAnchor` of the edited body puts it, orphan included.
 *
 * The oracle shares nothing with what it judges — it searches the whole new
 * body, where the memory moves old occurrences and searches only near each
 * change. Bodies and quotes are drawn from a two-letter alphabet so quotes
 * occur, stop occurring and start occurring again as the edits land, and the
 * edits are multi-range change sets, the shape a remote update arrives in.
 */
import { ChangeSet, Text } from '@codemirror/state'
import { resolveTextAnchor, type TextAnchor } from '@kamiazya/whiteboard-model'
import { afterAll, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  advanceKnownQuotes,
  editBetween,
  type KnownQuotes,
  NO_KNOWN_QUOTES,
  quoteMemoryFor,
  resolveRemembering,
  textEditsOf,
} from './quote-occurrences.js'

const text = (max: number) => fc.stringMatching(new RegExp(`^[ab]{0,${max}}$`))

const anchorArb: fc.Arbitrary<TextAnchor> = fc
  .tuple(fc.stringMatching(/^[ab]{1,4}$/), fc.nat({ max: 50 }), text(3), text(3))
  .map(([exact, start, prefix, suffix]) => ({
    kind: 'text',
    quote: { exact, prefix, suffix },
    start,
    end: start + exact.length,
  }))

/** Up to three non-overlapping replacements, as positions in [0, 1] of the doc they apply to. */
const changeArb = fc.array(
  fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.nat({ max: 4 }), text(5)),
  { minLength: 1, maxLength: 3 },
)

type Change = typeof changeArb extends fc.Arbitrary<infer T> ? T : never

function changeSetOver(doc: string, change: Change) {
  const specs: { from: number; to: number; insert: string }[] = []
  let floor = 0
  for (const [where, width, insert] of [...change].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(floor, Math.floor(where * doc.length))
    if (from > doc.length) break
    const to = Math.min(doc.length, from + width)
    specs.push({ from, to, insert })
    floor = to + 1
  }
  return ChangeSet.of(specs, doc.length)
}

const reached = { placed: 0, orphaned: 0, remembered: 0 }

afterAll(() => {
  // The arrangements the memory exists for were drawn: quotes it held
  // across an edit, and both verdicts after one.
  expect(reached.remembered).toBeGreaterThan(50)
  expect(reached.orphaned).toBeGreaterThan(20)
  expect(reached.placed).toBeGreaterThan(20)
})

function check(body: string, anchors: readonly TextAnchor[], known: KnownQuotes) {
  const learnt = new Map<string, readonly number[] | null>()
  for (const anchor of anchors) {
    if (known.get(anchor.quote.exact) !== undefined) reached.remembered += 1
    const expected = resolveTextAnchor(body, anchor)
    reached[expected.kind] += 1
    expect(resolveRemembering(body, anchor, undefined, known, learnt)).toEqual(expected)
  }
  return learnt
}

fcTest.prop(
  [
    text(40),
    fc.array(anchorArb, { minLength: 1, maxLength: 6 }),
    fc.array(changeArb, { maxLength: 6 }),
  ],
  withDefaults(),
)(
  'an anchor resolved through the memory lands where a fresh search puts it',
  (start, anchors, changes) => {
    let doc = start
    let known: KnownQuotes = check(doc, anchors, NO_KNOWN_QUOTES)
    for (const change of changes) {
      const set = changeSetOver(doc, change)
      doc = set.apply(Text.of(doc.split('\n'))).toString()
      known = check(doc, anchors, advanceKnownQuotes(known, doc, textEditsOf(set)))
    }
  },
)

fcTest.prop(
  [
    text(40),
    fc.array(anchorArb, { minLength: 1, maxLength: 6 }),
    fc.array(text(40), { maxLength: 5 }),
  ],
  withDefaults(),
)('a memory carried between whole bodies answers as a fresh search', (start, anchors, bodies) => {
  let memory = quoteMemoryFor(null, start)
  for (const body of [start, ...bodies]) {
    memory = quoteMemoryFor(memory, body)
    for (const anchor of anchors) {
      expect(resolveRemembering(body, anchor, undefined, memory.known, memory.learnt)).toEqual(
        resolveTextAnchor(body, anchor),
      )
    }
  }
})

fcTest.prop([text(30), text(30)], withDefaults())(
  'the edit between two bodies turns the first into the second',
  (before, after) => {
    const [edit] = editBetween(before, after)
    if (edit === undefined) {
      expect(before).toBe(after)
      return
    }
    expect(
      before.slice(0, edit.fromA) + after.slice(edit.fromB, edit.toB) + before.slice(edit.toA),
    ).toBe(after)
  },
)
