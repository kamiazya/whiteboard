// The prose half of "what adopting a proposed change means, and whether it
// still fits" (ADR-0029 decisions 4, 5 and 6). Its canvas twin is
// proposal-apply.test.ts; these two are deliberately one module, so a second
// reading of what adopting means cannot disagree with the first.
import { describe, expect, it } from 'vitest'
import type { BodyProposedChange } from './proposal.js'
import { applyBodyChange, bodyChangeConflicts } from './proposal-apply.js'

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

describe('applyBodyChange', () => {
  it('replaces exactly the resolved passage and nothing around it', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    expect(applyBodyChange(BODY, change, at('ship on Friday'))).toBe(
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
    expect(applyBodyChange(BODY, insertion, { start: 0, end: 0 })).toBe(`# Heading\n\n${BODY}`)

    const deletion = replace('The risk is the migration.', '')
    expect(applyBodyChange(BODY, deletion, at('The risk is the migration.'))).toBe(
      'The plan is to ship on Friday.\n\n',
    )
  })

  it('is idempotent: adopting the same change twice is adopting it once', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    const once = applyBodyChange(BODY, change, at('ship on Friday'))
    // Re-resolved against the NEW body, which is where the passage now is.
    const again = applyBodyChange(once, change, {
      start: once.indexOf('ship on Monday'),
      end: once.indexOf('ship on Monday') + 'ship on Monday'.length,
    })
    expect(again).toBe(once)
  })

  it('leaves the body alone when the passage could not be placed', () => {
    const change = replace('ship on Friday', 'ship on Monday')
    expect(applyBodyChange(BODY, change, undefined)).toBe(BODY)
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
