import { describe, expect, it } from 'vitest'
import { NODE_TEXT_MAX_CHARS, nodeTextInputSchema } from './node-text.js'

describe('nodeTextInputSchema', () => {
  it('holds one node to 8,192 characters, the size its write cost was measured at', () => {
    // A literal, not the constant: every other case reads the limit back from
    // itself, so a changed limit would pass them all.
    expect(NODE_TEXT_MAX_CHARS).toBe(8192)
    expect(nodeTextInputSchema.safeParse('x'.repeat(8192)).success).toBe(true)
    expect(nodeTextInputSchema.safeParse('x'.repeat(8193)).success).toBe(false)
  })

  it('accepts text of exactly the limit and refuses one character more', () => {
    expect(nodeTextInputSchema.safeParse('x'.repeat(NODE_TEXT_MAX_CHARS)).success).toBe(true)
    expect(nodeTextInputSchema.safeParse('x'.repeat(NODE_TEXT_MAX_CHARS + 1)).success).toBe(false)
  })

  it('accepts the empty string, which a text node may hold', () => {
    expect(nodeTextInputSchema.safeParse('').success).toBe(true)
  })

  it('refuses in words that name the limit and what to do', () => {
    const refusal = nodeTextInputSchema.safeParse('x'.repeat(NODE_TEXT_MAX_CHARS + 1))
    expect(refusal.success ? '' : refusal.error.issues[0]?.message).toBe(
      `node text is longer than the ${NODE_TEXT_MAX_CHARS}-character limit for one node; split it across nodes, or put it in a markdown document and embed that`,
    )
  })
})
