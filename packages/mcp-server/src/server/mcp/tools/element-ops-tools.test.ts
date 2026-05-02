import { describe, expect, it } from 'vitest'
import {
  alignElementsTool,
  alignInputSchema,
  distributeElementsTool,
  distributeInputSchema,
} from './element-ops-tools.js'

// Locks in the single-source-of-truth contract for align_elements /
// distribute_elements: the factory's `inputSchema` is the same Zod object
// that the MCP server registers, and execute()'s arg type is inferred
// from it. Drifting any of these — adding a hand-written TS shape, an
// inline JSON inputSchema, or a separate Zod for index.ts — would make
// these assertions fail.

describe('align_elements / distribute_elements contract', () => {
  it('exposes a Zod input schema as the factory contract (no inline JSON)', () => {
    const align = alignElementsTool()
    const distribute = distributeElementsTool()
    // Same identity — registration and runtime parse must come off the
    // exact same schema instance, not a copy.
    expect(align.inputSchema).toBe(alignInputSchema)
    expect(distribute.inputSchema).toBe(distributeInputSchema)
  })

  it('alignInputSchema rejects fewer than 2 elementIds', () => {
    const result = alignInputSchema.safeParse({
      canvasId: 'ws/c',
      elementIds: ['only-one'],
      alignment: 'left',
    })
    expect(result.success).toBe(false)
  })

  it('alignInputSchema accepts a valid payload and surfaces the typed shape', () => {
    const parsed = alignInputSchema.parse({
      canvasId: 'ws_main/design',
      elementIds: ['a', 'b', 'c'],
      alignment: 'center',
    })
    expect(parsed.alignment).toBe('center')
    expect(parsed.elementIds).toEqual(['a', 'b', 'c'])
  })

  it('alignInputSchema rejects an alignment value outside the documented enum', () => {
    const result = alignInputSchema.safeParse({
      canvasId: 'ws/c',
      elementIds: ['a', 'b'],
      alignment: 'diagonal',
    })
    expect(result.success).toBe(false)
  })

  it('distributeInputSchema rejects fewer than 3 elementIds', () => {
    const result = distributeInputSchema.safeParse({
      canvasId: 'ws/c',
      elementIds: ['only-two-1', 'only-two-2'],
      direction: 'horizontal',
    })
    expect(result.success).toBe(false)
  })

  it('distributeInputSchema accepts a valid payload', () => {
    const parsed = distributeInputSchema.parse({
      canvasId: 'ws/c',
      elementIds: ['a', 'b', 'c'],
      direction: 'vertical',
    })
    expect(parsed.direction).toBe('vertical')
  })

  it('distributeInputSchema rejects an unknown direction', () => {
    const result = distributeInputSchema.safeParse({
      canvasId: 'ws/c',
      elementIds: ['a', 'b', 'c'],
      direction: 'diagonal',
    })
    expect(result.success).toBe(false)
  })
})
