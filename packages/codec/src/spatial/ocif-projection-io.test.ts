// The OCIF projection's own shapes, by example.
//
// The round trip itself is `codecs.property.test.ts`'s, stated as idempotence
// and asked of every registered format. What is here is what only OCIF has:
// the edge/arrow branch, a text body as a resource, and explicit group members.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { parseOcif, toOcif } from './ocif-projection-io.js'

describe('a document becomes OCIF and comes back', () => {
  it('writes the version URI the projection targets', () => {
    expect(toOcif({ nodes: [], edges: [] }).ocif).toContain('v0.7.0')
  })

  it('makes an edge an @ocif/edge and a line an @ocif/arrow', () => {
    // The decision ADR-0038 took, and what it bought this file: the branch
    // that used to ask whether both ends named a node is gone, because the
    // collection an element is in already answers it.
    const nodes = [
      textNode({ id: 'a', text: 'a', x: 0, y: 0, width: 10, height: 10 }),
      textNode({ id: 'b', text: 'b', x: 90, y: 0, width: 10, height: 10 }),
    ]
    const projected = toOcif({
      nodes,
      edges: [{ id: 'rel', from: { node: 'a' }, to: { node: 'b' } }],
      lines: [
        {
          id: 'ink',
          from: { kind: 'node', node: 'a' },
          to: { kind: 'point', point: { x: 5, y: 80 } },
        },
      ],
    })
    const typesOf = (id: string) =>
      projected.nodes?.find((n) => n.id === id)?.data?.map((d) => d.type) ?? []
    expect(typesOf('rel')).toContain('@ocif/edge')
    expect(typesOf('rel')).not.toContain('@ocif/arrow')
    expect(typesOf('ink')).toContain('@ocif/arrow')
    expect(typesOf('ink')).not.toContain('@ocif/edge')
  })

  it('gives an arrow BOTH ends as coordinates, resolving the node end to its centre', () => {
    // What the degrade costs, asserted rather than described: a foreign reader
    // gets a line between two points and no relation at all.
    const projected = toOcif({
      nodes: [{ id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 40 }],
      edges: [],
      lines: [
        {
          id: 'ink',
          from: { kind: 'node', node: 'a' },
          to: { kind: 'point', point: { x: 5, y: 80 } },
        },
      ],
    })
    const arrow = projected.nodes
      ?.find((n) => n.id === 'ink')
      ?.data?.find((d) => d.type === '@ocif/arrow')
    expect(arrow?.start).toEqual([5, 20])
    expect(arrow?.end).toEqual([5, 80])
  })

  it('makes a text body a markdown RESOURCE rather than a field on the node', () => {
    const projected = toOcif({
      nodes: [{ id: 'n', type: 'text', text: '# hi', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    expect(projected.resources?.[0]?.representations[0]).toEqual({
      mimeType: 'text/markdown',
      content: '# hi',
    })
    expect(projected.nodes?.[0]?.resource).toBe('n/content')
  })

  it('resolves a group to explicit members, which OCIF states and containment does not', () => {
    const projected = toOcif({
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100 },
        { id: 'inside', type: 'text', text: 'x', x: 10, y: 10, width: 10, height: 10 },
        { id: 'outside', type: 'text', text: 'y', x: 500, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    const group = projected.nodes
      ?.find((n) => n.id === 'g')
      ?.data?.find((d) => d.type === '@ocif/group')
    expect(group?.members).toEqual(['inside'])
  })
})

describe('parseOcif reads foreign OCIF text', () => {
  it('carries a projected canvas through text and back', () => {
    // The property above compares two in-memory projections, so nothing in it
    // would notice `toOcif` emitting something its own wire schema refuses.
    // This is the same trip through JSON and the schema — the check the fuzz
    // lanes make of every tool answer, made of this projection's output.
    const canvas = {
      nodes: [textNode({ id: 'n', text: 'hi', x: 0.5, y: -2, width: 10, height: 10 })],
      edges: [],
      lines: [
        {
          id: 'l',
          from: { kind: 'node' as const, node: 'n' },
          to: { kind: 'point' as const, point: { x: 9, y: 9 } },
        },
      ],
    }
    const parsed = parseOcif(JSON.stringify(toOcif(canvas)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(canvas)
  })

  it('refuses malformed text at the syntax stage, and a bad document at the schema stage', () => {
    // Total, like every parser here: a `CodecParseResult`, never a thrown
    // ZodError, and a stage a caller can switch on.
    expect(parseOcif('{')).toMatchObject({ ok: false, error: { stage: 'json-syntax' } })
    expect(parseOcif('{"nodes":[]}')).toMatchObject({ ok: false, error: { stage: 'ocif-schema' } })
  })

  it('reads a document whose extensions it has never heard of', () => {
    // OCIF conformance requires a reader to preserve what it does not
    // understand, so the wire schema is deliberately loose where the internal
    // model is `.strict()`. A parse that refused this would make this package
    // non-conforming by construction.
    const foreign = JSON.stringify({
      ocif: 'https://spec.canvasprotocol.org/v0.7.0/core.json',
      nodes: [
        {
          id: 'n',
          position: [1, 2],
          size: [3, 4],
          rotation: 45,
          data: [{ type: '@someone-else/sparkle', intensity: 11 }],
        },
      ],
    })
    const parsed = parseOcif(foreign)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.nodes[0]).toMatchObject({ id: 'n', x: 1, y: 2, width: 3, height: 4 })
    }
  })
})
