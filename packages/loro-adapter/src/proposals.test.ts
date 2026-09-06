import type { Proposal } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readProposals, setProposedChangeStatus, writeProposal } from './proposals.js'

const PROPOSAL: Proposal = {
  id: 'p1',
  author: 'process:layout-agent',
  createdAt: '2026-09-06T00:00:00.000Z',
  changes: [
    {
      id: 'c1',
      status: 'open',
      op: 'node.patch',
      nodeId: 'n1',
      patch: { x: 400 },
      assumed: { x: 100 },
    },
    {
      id: 'c2',
      status: 'open',
      op: 'edge.remove',
      edgeId: 'e1',
      assumed: { id: 'e1', fromNode: 'n1', toNode: 'n2' },
    },
  ],
}

describe('proposal storage', () => {
  it('round-trips a proposal', () => {
    const doc = new LoroDoc()
    writeProposal(doc, PROPOSAL)
    expect(readProposals(doc)).toEqual([PROPOSAL])
  })

  // Decision 4 is a storage requirement before it is a UI one: "nine of these
  // are right and one is not" has to be expressible as a write that touches
  // one change and nothing else.
  it('decides one change without disturbing its siblings', () => {
    const doc = new LoroDoc()
    writeProposal(doc, PROPOSAL)
    setProposedChangeStatus(doc, 'p1', 'c1', 'adopted')
    expect(readProposals(doc)[0]?.changes.map((c) => [c.id, c.status])).toEqual([
      ['c1', 'adopted'],
      ['c2', 'open'],
    ])
  })

  it('reads changes in id order, so two replicas render one list', () => {
    const doc = new LoroDoc()
    writeProposal(doc, { ...PROPOSAL, changes: [...PROPOSAL.changes].reverse() })
    expect(readProposals(doc)[0]?.changes.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  // Two people looking at the same proposal decide different parts of it at
  // once. Each change is its own key, so this is a merge with nothing to
  // resolve — the shape is what makes that true, and this is what would
  // notice if the changes were ever collapsed into one stored value.
  it('keeps both verdicts when two replicas decide different changes at once', () => {
    const a = new LoroDoc()
    a.setPeerId(1)
    const b = new LoroDoc()
    b.setPeerId(2)
    writeProposal(a, PROPOSAL)
    b.import(a.export({ mode: 'snapshot' }))

    setProposedChangeStatus(a, 'p1', 'c1', 'adopted')
    setProposedChangeStatus(b, 'p1', 'c2', 'dismissed')
    a.import(b.export({ mode: 'update' }))
    b.import(a.export({ mode: 'update' }))

    const verdicts = (doc: LoroDoc) => readProposals(doc)[0]?.changes.map((c) => c.status)
    expect(verdicts(a)).toEqual(['adopted', 'dismissed'])
    expect(verdicts(b)).toEqual(verdicts(a))
  })

  // The same hazard `comment-threads.convergence.test.ts` measured for
  // threads: two keepers can reach the write with the same proposal id having
  // never seen each other's, and `getOrCreateContainer` loses one side
  // silently.
  it('keeps both sides when two replicas open one proposal container', () => {
    const a = new LoroDoc()
    a.setPeerId(1)
    const b = new LoroDoc()
    b.setPeerId(2)
    a.getMap('nodes').set('n1', { id: 'n1' })
    a.commit()
    b.import(a.export({ mode: 'snapshot' }))

    writeProposal(a, { id: 'p1', changes: [PROPOSAL.changes[0] as never] })
    writeProposal(b, { id: 'p1', changes: [PROPOSAL.changes[1] as never] })
    a.import(b.export({ mode: 'update' }))

    expect(readProposals(a)[0]?.changes.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('costs a rejected record that record and nothing beside it', () => {
    const doc = new LoroDoc()
    writeProposal(doc, PROPOSAL)
    const changes = doc.getMap('proposals').get('p1') as { get(k: string): unknown }
    const map = changes.get('changes') as { set(k: string, v: unknown): void }
    map.set('c3', { op: 'node.patch', nodeId: 'n1' })
    doc.commit()
    expect(readProposals(doc)[0]?.changes.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  // The same rule replying to an absent thread follows: a verdict on a
  // proposal this replica does not hold would materialise a headless record
  // around it, turning a lost import into a half-formed decision.
  it('does not open a proposal it was only asked to decide on', () => {
    const doc = new LoroDoc()
    setProposedChangeStatus(doc, 'p1', 'c1', 'adopted')
    expect(readProposals(doc)).toEqual([])
  })
})
