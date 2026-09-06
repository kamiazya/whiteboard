// @vitest-environment node
/**
 * The source pane's half of the proposal layer: which passages of the body
 * an open proposed change is drawn over.
 *
 * Placement is tested apart from CodeMirror for the reason its annotation
 * twin is — a range is a pair of offsets into text, and an off-by-one puts
 * the highlight over the wrong words. Whether the decoration reaches the DOM
 * is UI wiring, and the browser test beside this one covers that.
 */
import type { Proposal, ProposedChange, ProposedChangeStatus } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { placePassages } from './proposal-decorations.js'

function passage(
  id: string,
  body: string,
  exact: string,
  text: string,
  status: ProposedChangeStatus = 'open',
): ProposedChange {
  const start = body.indexOf(exact)
  return {
    id,
    op: 'body.replace',
    status,
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text,
    assumed: exact,
  }
}

function proposal(id: string, changes: readonly ProposedChange[]): Proposal {
  return { id, changes: [...changes] }
}

const BODY = 'Ship on Thursday. Review on Friday.'

describe('placePassages', () => {
  it('places an open passage over the words it quotes', () => {
    const change = passage('c1', BODY, 'Thursday', 'Monday')
    expect(placePassages(BODY, [proposal('p1', [change])])).toEqual([
      { proposalId: 'p1', changeId: 'c1', from: 8, to: 16, text: 'Monday', conflicted: false },
    ])
  })

  it('finds the passage by its quote after an edit moved it', () => {
    const change = passage('c1', BODY, 'Thursday', 'Monday')
    const edited = `> Added since.\n\n${BODY}`
    expect(placePassages(edited, [proposal('p1', [change])])).toEqual([
      { proposalId: 'p1', changeId: 'c1', from: 24, to: 32, text: 'Monday', conflicted: false },
    ])
  })

  it('draws nothing for a change the person has already decided', () => {
    const adopted = passage('c1', BODY, 'Thursday', 'Monday', 'adopted')
    const dismissed = passage('c2', BODY, 'Friday', 'Tuesday', 'dismissed')
    expect(placePassages(BODY, [proposal('p1', [adopted, dismissed])])).toEqual([])
  })

  it('draws nothing for a passage that is gone', () => {
    const change = passage('c1', BODY, 'Thursday', 'Monday')
    expect(placePassages('The plan changed entirely.', [proposal('p1', [change])])).toEqual([])
  })

  it('ignores a canvas change, whose subject is another surface', () => {
    const canvasChange: ProposedChange = {
      id: 'node:n1',
      op: 'node.patch',
      status: 'open',
      nodeId: 'n1',
      patch: { x: 240 },
      assumed: { x: 0 },
    }
    expect(placePassages(BODY, [proposal('p1', [canvasChange])])).toEqual([])
  })

  it('marks a passage the body no longer agrees with as conflicted', () => {
    // Decision 5: the proposal followed the document, and what it assumed is
    // no longer what the passage says. It is still drawn — the person is the
    // one who decides — but the disagreement has to reach them.
    const change: ProposedChange = {
      id: 'c1',
      op: 'body.replace',
      status: 'open',
      anchor: { kind: 'text', quote: { exact: 'Thursday' }, start: 8, end: 16 },
      text: 'Monday',
      assumed: 'Wednesday',
    }
    expect(placePassages(BODY, [proposal('p1', [change])])).toEqual([
      { proposalId: 'p1', changeId: 'c1', from: 8, to: 16, text: 'Monday', conflicted: true },
    ])
  })

  it('returns passages in document order, across proposals', () => {
    const later = passage('c2', BODY, 'Friday', 'Tuesday')
    const earlier = passage('c1', BODY, 'Thursday', 'Monday')
    const placed = placePassages(BODY, [proposal('p2', [later]), proposal('p1', [earlier])])
    expect(placed.map((one) => one.changeId)).toEqual(['c1', 'c2'])
  })
})
