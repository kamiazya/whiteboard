import {
  openChangeCount,
  openChangesOnceWritten,
  type Proposal,
  type ProposedChange,
} from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { PROPOSALS_KEY } from './containers.js'
import { openProposedChangeCount, readProposals, writeProposal } from './proposals.js'
import { fc, fcTest } from './test-utils/fast-check.js'

// Few ids on purpose, so a later write lands on a proposal and on change ids
// an earlier one already holds — the merge the count has to agree with.
const changeArbitrary: fc.Arbitrary<ProposedChange> = fc.record({
  id: fc.constantFrom('a', 'b', 'c', 'd'),
  status: fc.constantFrom('open', 'adopted', 'dismissed'),
  op: fc.constant('node.patch'),
  nodeId: fc.constant('n1'),
  patch: fc.constant({ x: 10 }),
  assumed: fc.constant({ x: 0 }),
})

const proposalArbitrary: fc.Arbitrary<Proposal> = fc.record({
  id: fc.constantFrom('p1', 'p2', 'p3'),
  changes: fc.uniqueArray(changeArbitrary, { minLength: 1, maxLength: 4, selector: (c) => c.id }),
})

describe('the open-change count', () => {
  fcTest.prop([fc.array(proposalArbitrary, { maxLength: 5 }), proposalArbitrary])(
    'predicted before a write is what the store holds open after it',
    (held, next) => {
      const doc = new LoroDoc()
      for (const proposal of held) writeProposal(doc, proposal)
      const predicted = openChangesOnceWritten(readProposals(doc), next)
      writeProposal(doc, next)
      expect(openProposedChangeCount(doc.getMap(PROPOSALS_KEY))).toBe(predicted)
      expect(openChangeCount(readProposals(doc))).toBe(predicted)
    },
  )
})
