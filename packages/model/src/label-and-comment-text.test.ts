import { describe, expect, it } from 'vitest'
import {
  COMMENT_MESSAGE_MAX_CHARS,
  commentMessageInputSchema,
  LABEL_MAX_CHARS,
  labelInputSchema,
} from './label-and-comment-text.js'

const messageOf = (parsed: { success: boolean; error?: { issues: { message: string }[] } }) =>
  parsed.success ? '' : (parsed.error?.issues[0]?.message ?? '')

describe('labelInputSchema', () => {
  it('holds one label to 1,024 characters, the size its render cost was measured at', () => {
    // A literal, not the constant: every other case reads the limit back from
    // itself, so a changed limit would pass them all.
    expect(LABEL_MAX_CHARS).toBe(1024)
    expect(labelInputSchema.safeParse('x'.repeat(1024)).success).toBe(true)
    expect(labelInputSchema.safeParse('x'.repeat(1025)).success).toBe(false)
  })

  it('accepts the empty string, which clears a label', () => {
    expect(labelInputSchema.safeParse('').success).toBe(true)
  })

  it('refuses in words that name the limit and what to do', () => {
    expect(messageOf(labelInputSchema.safeParse('x'.repeat(LABEL_MAX_CHARS + 1)))).toBe(
      `a label is longer than the ${LABEL_MAX_CHARS}-character limit; a longer text belongs in a text node`,
    )
  })
})

describe('commentMessageInputSchema', () => {
  it('holds one message to 4,096 characters, the size its render cost was measured at', () => {
    expect(COMMENT_MESSAGE_MAX_CHARS).toBe(4096)
    expect(commentMessageInputSchema.safeParse('x'.repeat(4096)).success).toBe(true)
    expect(commentMessageInputSchema.safeParse('x'.repeat(4097)).success).toBe(false)
  })

  it('refuses an empty message, which a thread cannot show', () => {
    expect(messageOf(commentMessageInputSchema.safeParse(''))).toBe(
      'a comment message must not be empty',
    )
  })

  it('refuses in words that name the limit and what to do', () => {
    expect(
      messageOf(commentMessageInputSchema.safeParse('x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1))),
    ).toBe(
      `a comment message is longer than the ${COMMENT_MESSAGE_MAX_CHARS}-character limit; split it across replies`,
    )
  })
})
