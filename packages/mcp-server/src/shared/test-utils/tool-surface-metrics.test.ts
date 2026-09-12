// Calibrates the oracle against schemas whose counts are known by
// construction. An instrument trusted before it is calibrated is the failure
// `loop-availability.test.ts` records; this one is cheaper to check.
import { describe, expect, it } from 'vitest'
import {
  crossReferences,
  descriptionWords,
  modelVisibleBytes,
  parameterCoverage,
  wireBytes,
} from './tool-surface-metrics.js'

const tool = {
  name: 'wb_thing_do',
  title: 'Do a thing',
  description: 'Does the thing. Prefer wb_thing_read first; wb_thing_do is not wb_other_do.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      ops: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                op: { type: 'string', const: 'add', description: 'Add.' },
                node: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
            { type: 'object', properties: { op: { type: 'string', const: 'remove' } } },
          ],
        },
      },
      labels: { type: 'object', additionalProperties: { type: 'string', description: 'A label.' } },
    },
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
} as const

describe('tool-surface metrics oracle', () => {
  it('counts every property at every depth, and names the undescribed ones by path', () => {
    expect(parameterCoverage(tool.inputSchema)).toEqual({
      // Seven by hand: workspaceId, ops, the first arm's op and node, that
      // node's id, the second arm's op, and labels. `labels.*` declares no
      // properties of its own, so it adds nothing.
      parameters: 7,
      described: 1,
      undescribed: [
        'workspaceId',
        'ops',
        'ops[]|0.node',
        'ops[]|0.node.id',
        'ops[]|1.op',
        'labels',
      ],
    })
  })

  it('resolves a $ref, so a subschema named in the registry still counts where it is used', () => {
    // Registering a schema in zod's global registry emits it into `$defs`
    // once and a `$ref` at each site. That is a byte-level change to how the
    // same surface is transmitted, so it must not move a count that means
    // "how many parameters are there". Unresolved, the walk stopped at the
    // `$ref` — every property behind one was invisible, in BOTH directions:
    // registering an undescribed subschema read as debt paid, a described one
    // as debt added.
    const withRef = {
      type: 'object',
      $defs: {
        End: {
          type: 'object',
          properties: {
            node: { type: 'string', description: 'The node.' },
            side: { type: 'string' },
          },
        },
      },
      properties: {
        from: { $ref: '#/$defs/End' },
        to: { $ref: '#/$defs/End' },
      },
    } as const
    const coverage = parameterCoverage(withRef)
    // `from`, `to`, and each end's two fields at each of the two sites.
    expect(coverage.parameters).toBe(6)
    expect(coverage.described).toBe(2)
    expect(coverage.undescribed).toEqual(['from', 'from.side', 'to', 'to.side'])
  })

  it("takes a $ref target's description, and lets the referencing site override it", () => {
    const schema = {
      type: 'object',
      $defs: { Size: { type: 'number', description: 'From the target.' } },
      properties: {
        width: { $ref: '#/$defs/Size' },
        height: { $ref: '#/$defs/Size', description: 'From the site.' },
      },
    } as const
    expect(parameterCoverage(schema).described).toBe(2)
    expect(parameterCoverage(schema).undescribed).toEqual([])
  })

  it('stops at a $ref that points at itself, rather than recurring forever', () => {
    const cyclic = {
      type: 'object',
      $defs: {
        Tree: { type: 'object', properties: { child: { $ref: '#/$defs/Tree' } } },
      },
      properties: { root: { $ref: '#/$defs/Tree' } },
    } as const
    // `root`, and its `child` once; the second hop is refused.
    expect(parameterCoverage(cyclic).parameters).toBe(2)
  })

  it('leaves a $ref it cannot follow alone, rather than reading it as an empty schema', () => {
    const dangling = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Missing' }, b: { $ref: 'https://example.test/x' } },
    } as const
    expect(parameterCoverage(dangling).parameters).toBe(2)
    expect(parameterCoverage(dangling).undescribed).toEqual(['a', 'b'])
  })

  it('counts a union arm as its own parameter, since it is its own line to the model', () => {
    // Both arms declare `op`; one is described and one is not, and the
    // oracle must not let the described arm cover for the other.
    const { undescribed } = parameterCoverage(tool.inputSchema)
    expect(undescribed).toContain('ops[]|1.op')
    expect(undescribed).not.toContain('ops[]|0.op')
  })

  it('model-visible bytes exclude what the client keeps for itself', () => {
    const visible = modelVisibleBytes(tool)
    const wire = wireBytes(tool)
    expect(visible).toBeLessThan(wire)
    expect(visible).toBe(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }).length,
    )
    // Dropping the output schema moves the wire size and not the visible one.
    const { outputSchema: _dropped, ...withoutOutput } = tool
    expect(modelVisibleBytes(withoutOutput)).toBe(visible)
    expect(wireBytes(withoutOutput)).toBeLessThan(wire)
  })

  it('counts description words, and 0 for a tool with none', () => {
    expect(descriptionWords(tool)).toBe(10)
    expect(descriptionWords({ ...tool, description: undefined })).toBe(0)
    expect(descriptionWords({ ...tool, description: '   ' })).toBe(0)
  })

  it('lists the other tools a description names, once each and never itself', () => {
    expect(crossReferences(tool)).toEqual(['wb_other_do', 'wb_thing_read'])
  })
})
