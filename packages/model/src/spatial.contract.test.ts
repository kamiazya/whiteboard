import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  canvasCommentSchema,
  canvasEdgeSchema,
  canvasLineSchema,
  edgeEndSchema,
  lineEndSchema,
  MAX_BENDS,
  sharedNodeFieldsSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
} from './spatial.js'

// What `contracts/model/spatial.schema.json` generates is held to the
// behaviour the hand-written schemas had: these cases pin the parts a schema
// alone does not show — the refinements, which keys are refused or stripped,
// and what a malformed optional value costs.

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const box = { x: 0, y: 0, width: 10, height: 10 }
const node = (id: string, extra: object = {}) => ({ id, ...box, ...extra })
const issuesOf = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value)
  return result.success
    ? []
    : result.error.issues.map(({ code, message, path }) => ({ code, message, path }))
}
const custom = (message: string, path: PropertyKey[] = []) => ({ code: 'custom', message, path })

describe('a node that shows a resource is not a frame', () => {
  const resource = { mimeType: 'text/markdown', content: 'hi' }
  const message = "a node that shows a resource is not a frame and has no frame's fields"

  it('refuses each of the frame fields beside a resource, reporting at the node itself', () => {
    for (const frame of [{ label: 'L' }, { background: 'b' }, { backgroundStyle: 'cover' }]) {
      expect(issuesOf(spatialNodeSchema, node('a', { resource, ...frame }))).toEqual([
        custom(message),
      ])
    }
  })

  it('takes a resource alone and a frame alone', () => {
    expect(spatialNodeSchema.safeParse(node('a', { resource })).success).toBe(true)
    expect(
      spatialNodeSchema.safeParse(node('a', { label: 'L', backgroundStyle: 'ratio' })).success,
    ).toBe(true)
  })

  it('keeps the refinement off the shared fields, which a writer derives drafts from', () => {
    expect(sharedNodeFieldsSchema.partial().safeParse({}).success).toBe(true)
    expect(() => spatialNodeSchema.partial()).toThrow()
  })

  it('refuses an unknown key by name and strips it from the shared fields', () => {
    expect(issuesOf(spatialNodeSchema, node('a', { nope: 1 }))).toEqual([
      { code: 'unrecognized_keys', message: 'Unrecognized key: "nope"', path: [] },
    ])
    expect(sharedNodeFieldsSchema.parse(node('a', { nope: 1 }))).toEqual(node('a'))
  })
})

describe('a comment names a node or an edge, never both', () => {
  const comment = { id: 'c', x: 1, y: 2, text: 'hi' }

  it('reports at the comment itself', () => {
    const both = { ...comment, targetNodeId: 'n', targetEdgeId: 'e' }
    expect(issuesOf(canvasCommentSchema, both)).toEqual([
      custom('a comment is about a node or an edge, not both'),
    ])
  })

  it('takes either target, and strips a key it does not name', () => {
    expect(canvasCommentSchema.safeParse({ ...comment, targetNodeId: 'n' }).success).toBe(true)
    expect(canvasCommentSchema.safeParse({ ...comment, targetEdgeId: 'e' }).success).toBe(true)
    expect(canvasCommentSchema.parse({ ...comment, nope: 1, resolved: false })).toEqual({
      ...comment,
      resolved: false,
    })
  })

  it('holds its anchor to integers and publishes them without safe-integer bounds', () => {
    expect(canvasCommentSchema.safeParse({ ...comment, x: 1.5 }).success).toBe(false)
    expect(canvasCommentSchema.safeParse({ ...comment, resolved: 'yes' }).success).toBe(false)
    const shape = z.toJSONSchema(canvasCommentSchema, { io: 'input' }).properties
    expect(shape?.x).toEqual({ type: 'integer' })
    expect(shape?.y).toEqual({ type: 'integer' })
  })
})

describe('a canvas refuses what its parts cannot', () => {
  const dup = (message: string, path: PropertyKey[]) => custom(message, path)
  const edge = (id: string, from: string, to: string) => ({
    id,
    from: { node: from },
    to: { node: to },
  })
  const line = (id: string, from: unknown, to: unknown) => ({ id, from, to })
  const onNode = (node: string) => ({ kind: 'node', node })
  const point = { kind: 'point', point: { x: 1, y: 2 } }

  it('reports the first repeated node id at nodes', () => {
    const canvas = { nodes: [node('a'), node('b'), node('b'), node('a')] }
    expect(issuesOf(spatialCanvasSchema, canvas)).toEqual([dup('duplicate node id "b"', ['nodes'])])
  })

  it('shares one id space between edges and lines, and keeps nodes apart from both', () => {
    const shared = {
      nodes: [node('a')],
      edges: [edge('x', 'a', 'a')],
      lines: [line('x', onNode('a'), point)],
    }
    expect(issuesOf(spatialCanvasSchema, shared)).toEqual([
      dup('duplicate edge or line id "x"', ['edges']),
    ])
    const named = { nodes: [node('x')], edges: [edge('x', 'x', 'x')] }
    expect(spatialCanvasSchema.safeParse(named).success).toBe(true)
  })

  it('names a missing node with its collection, index and side, and lets a free end be', () => {
    const canvas = {
      nodes: [node('a')],
      edges: [edge('e0', 'a', 'a'), edge('e1', 'ghost', 'a')],
      lines: [line('l0', point, point), line('l1', onNode('a'), onNode('gone'))],
    }
    expect(issuesOf(spatialCanvasSchema, canvas)).toEqual([
      dup('edge "e1" references nonexistent from node "ghost"', ['edges', 1, 'from', 'node']),
      dup('line "l1" references nonexistent to node "gone"', ['lines', 1, 'to', 'node']),
    ])
  })

  it('reports every kind of issue in one order', () => {
    const canvas = {
      nodes: [node('a'), node('a')],
      edges: [edge('x', 'a', 'b')],
      lines: [line('x', point, onNode('c'))],
    }
    expect(issuesOf(spatialCanvasSchema, canvas).map((issue) => issue.message)).toEqual([
      'duplicate node id "a"',
      'duplicate edge or line id "x"',
      'edge "x" references nonexistent to node "b"',
      'line "x" references nonexistent to node "c"',
    ])
  })

  it('reads an empty board for absent arrays and leaves absent lines absent', () => {
    expect(spatialCanvasSchema.parse({})).toEqual({ nodes: [], edges: [] })
    expect('lines' in spatialCanvasSchema.parse({})).toBe(false)
    expect(spatialCanvasSchema.parse({ lines: [] }).lines).toEqual([])
  })

  it('refuses a key it does not name, and does not check the integrity of a malformed canvas', () => {
    expect(issuesOf(spatialCanvasSchema, { comments: [] })).toEqual([
      { code: 'unrecognized_keys', message: 'Unrecognized key: "comments"', path: [] },
    ])
    const bad = { nodes: [node('a'), node('a')], edges: [{ id: 'e' }] }
    expect(issuesOf(spatialCanvasSchema, bad).every((issue) => issue.code === 'invalid_type')).toBe(
      true,
    )
  })
})

describe('a malformed optional value costs the value and not its element', () => {
  const junk = { 'visual.shape/v0': {}, notAKey: 1 }

  it('reads facets and tags as absent on a node, an edge, a line and the canvas', () => {
    const bad = { facets: junk, tags: 'not a list' }
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'a' } }
    expect(spatialNodeSchema.parse({ ...node('a'), ...bad })).toEqual(node('a'))
    expect(canvasEdgeSchema.parse({ ...edge, ...bad })).toEqual(edge)
    const ink = {
      id: 'l',
      from: { kind: 'point', point: { x: 0, y: 0 } },
      to: { kind: 'node', node: 'a' },
    }
    expect(canvasLineSchema.parse({ ...ink, facets: junk })).toEqual(ink)
    expect(spatialCanvasSchema.parse(bad)).toEqual({ nodes: [], edges: [] })
  })

  it('keeps well-formed ones verbatim, and refuses tags on a line', () => {
    const good = {
      facets: { 'visual.shape/v0': { a: 1 } },
      tags: ['health:failing', 'Machine Learning'],
    }
    expect(spatialNodeSchema.parse({ ...node('a'), ...good })).toEqual({ ...node('a'), ...good })
    const ink = { id: 'l', from: { kind: 'node', node: 'a' }, to: { kind: 'node', node: 'a' } }
    expect(issuesOf(canvasLineSchema, { ...ink, tags: ['x'] })).toEqual([
      { code: 'unrecognized_keys', message: 'Unrecognized key: "tags"', path: [] },
    ])
  })
})

describe('the ends of an edge and of a line', () => {
  it('takes an edge end that names a node, with a side and an arrowhead, and nothing else', () => {
    expect(edgeEndSchema.safeParse({ node: 'a', side: 'top', end: 'arrow' }).success).toBe(true)
    expect(edgeEndSchema.safeParse({ node: '' }).success).toBe(false)
    expect(issuesOf(edgeEndSchema, { kind: 'node', node: 'a' })).toEqual([
      { code: 'unrecognized_keys', message: 'Unrecognized key: "kind"', path: [] },
    ])
  })

  it('names the empty node id with the message the id carries', () => {
    expect(issuesOf(edgeEndSchema, { node: '' })).toEqual([
      { code: 'too_small', message: 'node id must not be empty', path: ['node'] },
    ])
  })

  it('picks a line end by its kind and reports an unknown kind at the discriminator', () => {
    expect(lineEndSchema.safeParse({ kind: 'node', node: 'a' }).success).toBe(true)
    expect(lineEndSchema.safeParse({ kind: 'point', point: { x: 1.5, y: -2 } }).success).toBe(true)
    expect(lineEndSchema.safeParse({ kind: 'point', node: 'a' }).success).toBe(false)
    expect(issuesOf(lineEndSchema, { kind: 'edge' })).toEqual([
      {
        code: 'invalid_union',
        message: "Invalid discriminator value. Expected 'node' | 'point'",
        path: ['kind'],
      },
    ])
    expect(issuesOf(lineEndSchema, {})).toEqual([
      {
        code: 'invalid_union',
        message: "Invalid discriminator value. Expected 'node' | 'point'",
        path: ['kind'],
      },
    ])
  })

  it('keeps an end of one kind from carrying the other kinds fields', () => {
    expect(
      lineEndSchema.safeParse({ kind: 'node', node: 'a', point: { x: 0, y: 0 } }).success,
    ).toBe(false)
    expect(
      lineEndSchema.safeParse({ kind: 'point', point: { x: 0, y: 0 }, side: 'top' }).success,
    ).toBe(false)
  })
})

describe('what the published schema carries', () => {
  const published = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' })

  it('holds bends to the cap every writer shares', () => {
    const bends = (count: number) => Array.from({ length: count }, (_, x) => ({ x, y: 0 }))
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'a' } }
    expect(canvasEdgeSchema.safeParse({ ...edge, bends: bends(MAX_BENDS) }).success).toBe(true)
    expect(canvasEdgeSchema.safeParse({ ...edge, bends: bends(MAX_BENDS + 1) }).success).toBe(false)
    expect(canvasEdgeSchema.safeParse({ ...edge, bends: [] }).success).toBe(false)
  })

  it('describes the box size, the sides and the ends a model reads', () => {
    const properties = published(sharedNodeFieldsSchema).properties
    expect(properties?.width).toMatchObject({
      description: 'Box width; text wraps at it. Omit it for the default.',
    })
    expect(properties?.height).toMatchObject({
      description: expect.stringMatching(/^Box height\. Omit it and a text box is made tall/),
    })
    const edgeEnd = published(edgeEndSchema).$defs?.EdgeEnd as {
      properties: Record<string, { description?: string }>
    }
    const end = edgeEnd.properties
    expect(end.node?.description).toBe('The node this end attaches to.')
    expect(end.side?.description).toMatch(
      /^The side of the node to attach to\. Omit it: the router/,
    )
    expect(end.end?.description).toBe('The arrowhead drawn at this end.')
  })

  it('names the repeated parts once and references them', () => {
    const defs = Object.keys(published(canvasLineSchema).$defs ?? {})
    expect(defs).toEqual(expect.arrayContaining(['LineEnd', 'Bends', 'CanvasColor', 'CanvasPoint']))
    const edgeDefs = Object.keys(published(canvasEdgeSchema).$defs ?? {})
    expect(edgeDefs).toEqual(expect.arrayContaining(['EdgeEnd', 'Bends', 'CanvasColor']))
    const embed = Object.keys(published(sharedNodeFieldsSchema).$defs ?? {})
    expect(embed).toEqual(expect.arrayContaining(['NodeEmbed', 'ExtensionFacets']))
  })

  it('refuses a node embed without a canonical document id and takes a version reference', () => {
    const embed = (value: unknown) => spatialNodeSchema.safeParse(node('a', { embed: value }))
    expect(embed({ documentId: ULID }).success).toBe(true)
    expect(embed({ documentId: ULID, versionRef: 'v1' }).success).toBe(true)
    expect(embed({ documentId: ULID, versionRef: '' }).success).toBe(false)
    expect(embed({ documentId: 'not-a-ulid' }).success).toBe(false)
    expect(embed({ documentId: ULID, extra: 1 }).success).toBe(false)
  })
})
