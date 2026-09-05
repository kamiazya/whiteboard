import { describe, expect, it } from 'vitest'
import { contentDigestOf } from './content-digest.js'

describe('contentDigestOf', () => {
  // A Loro map's JSON comes out in op-arrival order, which differs between
  // replicas that hold the same content. The digest has to see through that
  // or two converged replicas name one state twice.
  it('ignores key order at every level', () => {
    const a = { nodes: { n1: { x: 1, text: 'a' }, n0: { text: 'b', x: 0 } }, body: 'hi' }
    const b = { body: 'hi', nodes: { n0: { x: 0, text: 'b' }, n1: { text: 'a', x: 1 } } }
    expect(contentDigestOf(a)).toBe(contentDigestOf(b))
  })

  it('changes when any value changes', () => {
    const base = { nodes: { n0: { x: 0, text: 'b' } }, body: 'hi' }
    expect(contentDigestOf({ ...base, body: 'hi!' })).not.toBe(contentDigestOf(base))
    expect(contentDigestOf({ ...base, nodes: { n0: { x: 1, text: 'b' } } })).not.toBe(
      contentDigestOf(base),
    )
  })

  // Array ORDER is content — a list of edges in a different order is a
  // different document — so only object keys are sorted, never arrays.
  it('keeps array order as content', () => {
    expect(contentDigestOf({ items: [1, 2] })).not.toBe(contentDigestOf({ items: [2, 1] }))
  })

  it('is sixteen hex characters, so it is a safe path segment and a stable width', () => {
    expect(contentDigestOf({ a: 1 })).toMatch(/^[0-9a-f]{16}$/)
  })
})
