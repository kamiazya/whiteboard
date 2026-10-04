// @vitest-environment node

import { readMarkdownBody, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import type { ProposedChange } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
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

function noteWithBody(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  return doc
}

describe('applyAdoptedPassages', () => {
  it('writes the body with the passage replaced', () => {
    const doc = noteWithBody(BODY)
    const write = vi.fn()

    applyAdoptedPassages(doc, [passageChange('c1', 'Thursday', 'Friday')], write)

    expect(write).toHaveBeenCalledExactlyOnceWith('# Plan\n\nThe plan is to ship on Friday.\n')
  })

  it('reads the body but never writes it itself: the caller owns the commit', () => {
    const doc = noteWithBody(BODY)

    applyAdoptedPassages(doc, [passageChange('c1', 'Thursday', 'Friday')], () => {})

    expect(readMarkdownBody(doc)).toBe(BODY)
  })

  it('finds the passage by its quote when an edit has moved it', () => {
    // The change was written against BODY; the document now carries a note
    // above it, so every offset is stale by that prefix. The quote is what
    // still finds the passage.
    const doc = noteWithBody(`> Added since.\n\n${BODY}`)
    const write = vi.fn()

    applyAdoptedPassages(doc, [passageChange('c1', 'Thursday', 'Friday')], write)

    expect(write).toHaveBeenCalledExactlyOnceWith(
      '> Added since.\n\n# Plan\n\nThe plan is to ship on Friday.\n',
    )
  })

  it('applies several passages without the earlier one shifting the later', () => {
    const body = 'Ship on Thursday. Review on Thursday too.\n'
    const doc = noteWithBody(body)
    const write = vi.fn()

    applyAdoptedPassages(
      doc,
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
    const doc = noteWithBody(body)
    const write = vi.fn()

    applyAdoptedPassages(
      doc,
      [
        passageChange('c2', 'Review on Thursday', 'Review on Wednesday', body),
        passageChange('c1', 'Ship on Thursday', 'Ship on Monday', body),
      ],
      write,
    )

    expect(write).toHaveBeenCalledExactlyOnceWith('Ship on Monday. Review on Wednesday too.\n')
  })

  it('skips a passage that is gone rather than writing it somewhere', () => {
    const doc = noteWithBody('The plan changed entirely.\n')
    const write = vi.fn()

    applyAdoptedPassages(doc, [passageChange('c1', 'Thursday', 'Friday', BODY)], write)

    expect(write).not.toHaveBeenCalled()
  })

  it('still applies the passages that resolve when a sibling is gone', () => {
    const doc = noteWithBody(BODY)
    const write = vi.fn()

    applyAdoptedPassages(
      doc,
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
    const doc = noteWithBody('xx abcde')
    const write = vi.fn()

    applyAdoptedPassages(
      doc,
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
    const doc = noteWithBody('xx abcde zz end')
    const write = vi.fn()

    applyAdoptedPassages(
      doc,
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
    const doc = noteWithBody(BODY)
    const write = vi.fn()
    const moveNode: ProposedChange = {
      id: 'node:n1',
      op: 'node.patch',
      status: 'open',
      nodeId: 'n1',
      patch: { x: 240 },
      assumed: { x: 0 },
    }

    applyAdoptedPassages(doc, [moveNode], write)
    applyAdoptedPassages(doc, [], write)

    expect(write).not.toHaveBeenCalled()
  })

  it('writes nothing when the replacement is the text already there', () => {
    const doc = noteWithBody(BODY)
    const write = vi.fn()

    applyAdoptedPassages(doc, [passageChange('c1', 'Thursday', 'Thursday')], write)

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
