// The proposal layer's shape (ADR-0029): a proposal is an ANCHORED CHANGE,
// not a point in time. These tests pin the three things a later reader would
// otherwise have to infer — that the decision unit is the CHANGE rather than
// the batch, that `assumed` covers exactly what the change touches and never
// more, and that the op union is closed so a new verb cannot be added without
// deciding what its prior value is.
import { describe, expect, it } from 'vitest'
import {
  PROPOSED_CHANGE_OPS,
  type ProposedChange,
  proposalSchema,
  proposedChangeSchema,
} from './proposal.js'

const NODE = { id: 'n1', type: 'text', text: 'hello', x: 0, y: 0, width: 100, height: 40 } as const

function change(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    status: 'open',
    op: 'node.patch',
    nodeId: 'n1',
    patch: { x: 40 },
    assumed: { x: 10 },
    ...overrides,
  }
}

describe('proposedChangeSchema', () => {
  it('accepts a patch that declares the prior value of what it changes', () => {
    expect(proposedChangeSchema.safeParse(change()).success).toBe(true)
  })

  it('accepts a patch whose assumed omits a field, meaning the anchor held nothing there', () => {
    const parsed = proposedChangeSchema.safeParse(
      change({ patch: { x: 40, color: '3' }, assumed: { x: 10 } }),
    )
    expect(parsed.success).toBe(true)
  })

  // The invariant that makes one field serve both jobs. A prior declared for
  // a field the change does not touch would fire decision 5's conflict check
  // on someone else's edit — the "only a REAL collision" rule, made
  // mechanical rather than left to whoever writes the producer.
  it('rejects a prior declared for a field the change does not touch', () => {
    const parsed = proposedChangeSchema.safeParse(
      change({ patch: { x: 40 }, assumed: { x: 10, y: 99 } }),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown verb', () => {
    expect(proposedChangeSchema.safeParse(change({ op: 'node.tidy' })).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(proposedChangeSchema.safeParse(change({ because: 'it looked nicer' })).success).toBe(
      false,
    )
  })

  // A proposed node is stored RESOLVED — real id, real geometry — because the
  // renderer has to draw it dashed in place before anyone adopts it. A draft
  // with the geometry left out has no box to draw.
  it('requires a proposed node to carry the geometry it will be drawn at', () => {
    expect(
      proposedChangeSchema.safeParse({ id: 'c1', status: 'open', op: 'node.add', node: NODE })
        .success,
    ).toBe(true)
    const { width: _width, ...noBox } = NODE
    expect(
      proposedChangeSchema.safeParse({ id: 'c1', status: 'open', op: 'node.add', node: noBox })
        .success,
    ).toBe(false)
  })

  // Decision 6: prose gets the same granularity a canvas has. `assumed` is
  // the text being replaced — what to strike through, and what to compare.
  it('carries a markdown passage as its text and the text it replaces', () => {
    const parsed = proposedChangeSchema.safeParse({
      id: 'c1',
      status: 'open',
      op: 'body.replace',
      anchor: { kind: 'text', quote: { exact: 'old wording' }, start: 12, end: 23 },
      text: 'new wording',
      assumed: 'old wording',
    })
    expect(parsed.success).toBe(true)
  })

  it('names every verb it carries, read off the schema', () => {
    expect([...PROPOSED_CHANGE_OPS].sort()).toEqual([
      'body.replace',
      'edge.add',
      'edge.patch',
      'edge.remove',
      'node.add',
      'node.patch',
      'node.remove',
    ])
  })

  // Every verb decides about `assumed` — a change with no prior says so by
  // having no field, and one with a prior carries it. The table is the
  // decision; the guard is that the union cannot grow past it unnoticed.
  it('decides for every verb whether it has a prior value', () => {
    const withPrior: Record<ProposedChange['op'], boolean> = {
      'node.add': false,
      'node.patch': true,
      'node.remove': true,
      'edge.add': false,
      'edge.patch': true,
      'edge.remove': true,
      'body.replace': true,
    }
    expect(Object.keys(withPrior).sort()).toEqual([...PROPOSED_CHANGE_OPS].sort())
  })
})

describe('proposalSchema', () => {
  it('accepts a batch of one change with no provenance', () => {
    expect(proposalSchema.safeParse({ id: 'p1', changes: [change()] }).success).toBe(true)
  })

  it('accepts provenance when the keeper has it', () => {
    const parsed = proposalSchema.safeParse({
      id: 'p1',
      author: 'process:layout-agent',
      createdAt: '2026-09-06T10:00:00Z',
      changes: [change()],
    })
    expect(parsed.success).toBe(true)
  })

  // A batch with nothing in it is a decision nobody can take — the same
  // reason a thread has at least one message.
  it('rejects a batch with no changes', () => {
    expect(proposalSchema.safeParse({ id: 'p1', changes: [] }).success).toBe(false)
  })

  // Decision 4: the DECISION is per change, so the status lives on the change
  // and the batch has none. A status on both would make "which one counts?"
  // unanswerable, the way `resolved` on a message beside its thread would.
  it('carries no status of its own', () => {
    expect(
      proposalSchema.safeParse({ id: 'p1', status: 'open', changes: [change()] }).success,
    ).toBe(false)
  })
})
