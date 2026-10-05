// The prose half of "what adopting a proposed change means, and whether it
// still fits" (ADR-0029 decisions 4, 5 and 6). Its canvas twin is
// proposal-apply.test.ts; these two are deliberately one module, so a second
// reading of what adopting means cannot disagree with the first.
import { describe, expect, it } from 'vitest'
import type { BodyProposedChange } from './proposal.js'
import {
  applyPassages,
  bodyChangeConflicts,
  findPassageOverlap,
  type PlacedPassage,
} from './proposal-apply.js'

const BODY = 'The plan is to ship on Friday.\n\nThe risk is the migration.'

function replace(exact: string, text: string, assumed = exact): BodyProposedChange {
  const start = BODY.indexOf(exact)
  return {
    id: 'body:1',
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text,
    assumed,
  }
}

/** Where the caller resolved the passage — marks first, then the quote. */
function at(exact: string) {
  const start = BODY.indexOf(exact)
  return { start, end: start + exact.length }
}

/** One passage adopted on its own: a batch of one. */
function adoptOne(body: string, change: BodyProposedChange, place: PlacedPassage['at']): string {
  const outcome = applyPassages(body, [{ change, at: place }])
  if (outcome.kind !== 'applied') throw new Error('a single passage cannot overlap')
  return outcome.body
}

describe('applying one passage', () => {
  it('replaces exactly the resolved passage and nothing around it', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    expect(adoptOne(BODY, change, at('ship on Friday'))).toBe(
      'The plan is to ship on Monday.\n\nThe risk is the migration.',
    )
  })

  it('inserts when the passage is empty, and deletes when the text is', () => {
    const insertion: BodyProposedChange = {
      id: 'body:insert',
      op: 'body.replace',
      status: 'open',
      anchor: { kind: 'text', quote: { exact: '' }, start: 0, end: 0 },
      text: '# Heading\n\n',
      assumed: '',
    }
    expect(adoptOne(BODY, insertion, { start: 0, end: 0 })).toBe(`# Heading\n\n${BODY}`)

    const deletion = replace('The risk is the migration.', '')
    expect(adoptOne(BODY, deletion, at('The risk is the migration.'))).toBe(
      'The plan is to ship on Friday.\n\n',
    )
  })

  it('is idempotent: adopting the same change twice is adopting it once', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    const once = adoptOne(BODY, change, at('ship on Friday'))
    // Re-resolved against the NEW body, which is where the passage now is.
    const again = adoptOne(once, change, {
      start: once.indexOf('ship on Monday'),
      end: once.indexOf('ship on Monday') + 'ship on Monday'.length,
    })
    expect(again).toBe(once)
  })

  it('leaves the body alone when no passage was placed', () => {
    expect(applyPassages(BODY, [])).toEqual({ kind: 'applied', body: BODY })
  })
})

describe('bodyChangeConflicts', () => {
  it('does not flag a passage that still reads what the proposal assumed', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    expect(bodyChangeConflicts(change, BODY, at('ship on Friday'))).toBe(false)
  })

  it('flags a passage somebody else has since rewritten', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    const edited = BODY.replace('ship on Friday', 'ship on Thursday')
    expect(
      bodyChangeConflicts(change, edited, {
        start: edited.indexOf('ship on Thursday'),
        end: edited.indexOf('ship on Thursday') + 'ship on Thursday'.length,
      }),
    ).toBe(true)
  })

  it('flags an orphaned passage: there is no longer an anchor to follow', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    expect(bodyChangeConflicts(change, 'a body about something else', undefined)).toBe(true)
  })

  it('reads THIS passage, not the body — the assumed words surviving elsewhere is not agreement', () => {
    // The case that separates a passage comparison from a search. Somebody
    // rewrote the passage the proposal points at and left those exact words
    // standing in another paragraph; a check that asked "is this text still
    // in the document?" would answer no-conflict and let a person adopt onto
    // words they were never shown. Found by mutation, not by review.
    const change = replace('ship on Friday', 'ship on Monday')
    const edited = 'The plan is to ship on Thursday.\n\nWe used to ship on Friday.'
    expect(
      bodyChangeConflicts(change, edited, {
        start: edited.indexOf('ship on Thursday'),
        end: edited.indexOf('ship on Thursday') + 'ship on Thursday'.length,
      }),
    ).toBe(true)
  })

  it('flags a passage that runs past the end of the body', () => {
    // The same clamping trap `resolveTextAnchor` carried: `String.slice`
    // CLAMPS, so a range the body no longer has returns its TAIL rather than
    // nothing, and a tail that happens to read what was assumed answers
    // "no conflict". Measured: `'hello world'.slice(6, 20)` is `'world'`.
    //
    // Every caller today derives `at` from `resolveTextAnchor`, which no
    // longer answers out of range — so this is the boundary holding on its own
    // rather than a live defect. It is worth holding: the direction of the
    // mistake is adopting an edit onto text the proposer was never shown,
    // which is the one outcome ADR-0029 decision 5 exists to prevent.
    const change = replace('world', 'everyone')
    expect(bodyChangeConflicts(change, 'hello world', { start: 6, end: 20 })).toBe(true)
  })

  it('does not flag an edit ELSEWHERE in the body, which is somebody working', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    const edited = BODY.replace('The risk is the migration.', 'The risk is the rollout.')
    expect(
      bodyChangeConflicts(change, edited, {
        start: edited.indexOf('ship on Friday'),
        end: edited.indexOf('ship on Friday') + 'ship on Friday'.length,
      }),
    ).toBe(false)
  })
})

/** A passage placed where `exact` first occurs in `body`, proposing `text` instead. */
function placedIn(body: string, id: string, exact: string, text: string) {
  const start = body.indexOf(exact)
  const change: BodyProposedChange = {
    id,
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text,
    assumed: exact,
  }
  return { change, at: { start, end: start + exact.length } }
}

describe('applyPassages', () => {
  it('applies every passage from one read, whatever order they arrive in', () => {
    const body = 'Ship on Thursday. Review on Thursday too.'
    const first = placedIn(body, 'c1', 'Ship on Thursday', 'Ship on Monday')
    const second = placedIn(body, 'c2', 'Review on Thursday', 'Review on Wednesday')
    const expected = { kind: 'applied', body: 'Ship on Monday. Review on Wednesday too.' }
    expect(applyPassages(body, [first, second])).toEqual(expected)
    expect(applyPassages(body, [second, first])).toEqual(expected)
  })

  it('applies passages that only touch, since they share no character', () => {
    const body = 'abcdef'
    const left = placedIn(body, 'L', 'abc', 'X')
    const right = placedIn(body, 'R', 'def', 'Y')
    expect(applyPassages(body, [left, right])).toEqual({ kind: 'applied', body: 'XY' })
  })

  it('refuses passages proposed apart that an edit has since made overlap', () => {
    // Proposed against `xx abc yy cde`, where the two are disjoint. Somebody
    // then deleted ` yy c`, so `cde` now starts inside `abc`. Applied
    // back-to-front anyway, the pair writes `xx 11122` — text neither change
    // proposed, and nothing downstream could tell it from an edit somebody meant.
    const body = 'xx abcde'
    const a = placedIn(body, 'A', 'abc', '111')
    const b = placedIn(body, 'B', 'cde', '222')
    const outcome = applyPassages(body, [a, b])
    expect(outcome).toEqual({ kind: 'overlap', passage: b, overlaps: a })
    expect(findPassageOverlap([b, a])).toEqual({ passage: b, overlaps: a })
  })

  it('finds a passage nested inside another, not only one that straddles its end', () => {
    const body = 'one two three'
    const outer = placedIn(body, 'outer', 'one two three', 'all of it')
    const inner = placedIn(body, 'inner', 'two', '2')
    expect(findPassageOverlap([inner, outer])).toEqual({ passage: inner, overlaps: outer })
  })
})
