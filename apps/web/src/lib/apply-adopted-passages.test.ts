// @vitest-environment node

import { MARKDOWN_MAX_CHARS, type ProposedChange } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { applyAdoptedPassages } from './apply-adopted-passages.js'

const BODY = '# Plan\n\nThe plan is to ship on Thursday.\n'

function passageChange(
  id: string,
  exact: string,
  text: string,
  body = BODY,
  assumed = exact,
): ProposedChange {
  const start = body.indexOf(exact)
  return {
    id,
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text,
    assumed,
  }
}

describe('applyAdoptedPassages', () => {
  it('writes the body with the passage replaced', () => {
    const current = BODY
    const write = vi.fn()

    applyAdoptedPassages(current, [passageChange('c1', 'Thursday', 'Friday')], write)

    expect(write).toHaveBeenCalledExactlyOnceWith('# Plan\n\nThe plan is to ship on Friday.\n')
  })

  it('finds the passage by its quote when an edit has moved it', () => {
    // The change was written against BODY; the document now carries a note
    // above it, so every offset is stale by that prefix. The quote is what
    // still finds the passage.
    const current = `> Added since.\n\n${BODY}`
    const write = vi.fn()

    applyAdoptedPassages(current, [passageChange('c1', 'Thursday', 'Friday')], write)

    expect(write).toHaveBeenCalledExactlyOnceWith(
      '> Added since.\n\n# Plan\n\nThe plan is to ship on Friday.\n',
    )
  })

  it('applies several passages without the earlier one shifting the later', () => {
    const body = 'Ship on Thursday. Review on Thursday too.\n'
    const current = body
    const write = vi.fn()

    applyAdoptedPassages(
      current,
      [
        passageChange('c1', 'Ship on Thursday', 'Ship on Monday', body),
        passageChange('c2', 'Review on Thursday', 'Review on Wednesday', body),
      ],
      write,
    )

    expect(write).toHaveBeenCalledExactlyOnceWith('Ship on Monday. Review on Wednesday too.\n')
  })

  it('applies passages given in any order, one write for all of them', () => {
    const body = 'Ship on Thursday. Review on Thursday too.\n'
    const current = body
    const write = vi.fn()

    applyAdoptedPassages(
      current,
      [
        passageChange('c2', 'Review on Thursday', 'Review on Wednesday', body),
        passageChange('c1', 'Ship on Thursday', 'Ship on Monday', body),
      ],
      write,
    )

    expect(write).toHaveBeenCalledExactlyOnceWith('Ship on Monday. Review on Wednesday too.\n')
  })

  it('skips a passage that is gone rather than writing it somewhere', () => {
    const current = 'The plan changed entirely.\n'
    const write = vi.fn()

    applyAdoptedPassages(current, [passageChange('c1', 'Thursday', 'Friday', BODY)], write)

    expect(write).not.toHaveBeenCalled()
  })

  it('still applies the passages that resolve when a sibling is gone', () => {
    const current = BODY
    const write = vi.fn()

    applyAdoptedPassages(
      current,
      [passageChange('c1', 'Thursday', 'Friday'), absentPassage('c2', 'Monday')],
      write,
    )

    expect(write).toHaveBeenCalledExactlyOnceWith('# Plan\n\nThe plan is to ship on Friday.\n')
  })

  it('skips two passages an edit has made overlap rather than writing text neither proposed', () => {
    // Proposed against `xx abc yy cde`, where the two are disjoint. Somebody
    // then deleted ` yy c`, so `cde` now starts inside `abc`; applying both
    // back-to-front would write `xx 11122`.
    const proposedOver = 'xx abc yy cde'
    const current = 'xx abcde'
    const write = vi.fn()

    applyAdoptedPassages(
      current,
      [
        passageChange('A', 'abc', '111', proposedOver),
        passageChange('B', 'cde', '222', proposedOver),
      ],
      write,
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('still applies a disjoint sibling when two other passages overlap', () => {
    const proposedOver = 'xx abc yy cde zz end'
    const current = 'xx abcde zz end'
    const write = vi.fn()

    applyAdoptedPassages(
      current,
      [
        passageChange('A', 'abc', '111', proposedOver),
        passageChange('B', 'cde', '222', proposedOver),
        passageChange('C', 'end', 'fin', proposedOver),
      ],
      write,
    )

    expect(write).toHaveBeenCalledExactlyOnceWith('xx abcde zz fin')
  })

  it('writes nothing for changes that name no passage', () => {
    const current = BODY
    const write = vi.fn()
    const moveNode: ProposedChange = {
      id: 'node:n1',
      op: 'node.patch',
      status: 'open',
      nodeId: 'n1',
      patch: { x: 240 },
      assumed: { x: 0 },
    }

    applyAdoptedPassages(current, [moveNode], write)
    applyAdoptedPassages(current, [], write)

    expect(write).not.toHaveBeenCalled()
  })

  it('refuses an adoption that grows the body past the limit, writing nothing', () => {
    // Both keepers refuse a body past the limit, and a refused write is one
    // the sync worker retries without end — so it must never be made.
    const body = `tail-${'x'.repeat(MARKDOWN_MAX_CHARS - 'tail-'.length)}`
    const current = body
    const write = vi.fn()

    const refusal = applyAdoptedPassages(
      current,
      [passageChange('c1', 'tail', 'tails', body)],
      write,
    )

    expect(refusal).toEqual({ length: MARKDOWN_MAX_CHARS + 1 })
    expect(write).not.toHaveBeenCalled()
  })

  it('lets an adoption land exactly on the limit', () => {
    const body = `tail-${'x'.repeat(MARKDOWN_MAX_CHARS - 1 - 'tail-'.length)}`
    const current = body
    const write = vi.fn()

    const refusal = applyAdoptedPassages(
      current,
      [passageChange('c1', 'tail', 'tails', body)],
      write,
    )

    expect(refusal).toBeUndefined()
    expect(write.mock.calls[0]?.[0]).toHaveLength(MARKDOWN_MAX_CHARS)
  })

  it('lets an adoption shrink a body already past the limit', () => {
    // A body written before the limit existed stays editable toward it, as
    // both keepers and the editor let it.
    const body = `tail-${'x'.repeat(MARKDOWN_MAX_CHARS + 100)}`
    const current = body
    const write = vi.fn()

    const refusal = applyAdoptedPassages(current, [passageChange('c1', 'tail', 't', body)], write)

    expect(refusal).toBeUndefined()
    expect(write.mock.calls[0]?.[0]).toHaveLength(body.length - 3)
  })

  it('writes nothing when the replacement is the text already there', () => {
    const current = BODY
    const write = vi.fn()

    applyAdoptedPassages(current, [passageChange('c1', 'Thursday', 'Thursday')], write)

    expect(write).not.toHaveBeenCalled()
  })
})

function absentPassage(id: string, text: string): ProposedChange {
  return {
    id,
    op: 'body.replace',
    status: 'open',
    anchor: {
      kind: 'text',
      quote: { exact: 'a sentence this note never held' },
      start: 0,
      end: 30,
    },
    text,
    assumed: 'a sentence this note never held',
  }
}
