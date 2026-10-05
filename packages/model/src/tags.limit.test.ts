import { describe, expect, it } from 'vitest'
import { LABEL_MAX_CHARS } from './label-and-comment-text.js'
import {
  storedTagsSchema,
  TAG_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
  tagListWriteSchema,
  tagWriteSchema,
} from './tags.js'

const messageOf = (parsed: { success: boolean; error?: { issues: { message: string }[] } }) =>
  parsed.success ? '' : (parsed.error?.issues[0]?.message ?? '')

const tagsOf = (count: number) => Array.from({ length: count }, (_, i) => `t${i}`)

describe('a tag as a write accepts it', () => {
  it('holds one tag to 1,024 characters and one element to 1,024 tags', () => {
    // Literals, not the constants: every other case reads the limit back from
    // itself, so a changed limit would pass them all.
    expect(TAG_MAX_CHARS).toBe(1024)
    expect(TAGS_PER_ELEMENT_MAX).toBe(1024)
    expect(tagWriteSchema.safeParse('a'.repeat(1024)).success).toBe(true)
    expect(tagWriteSchema.safeParse('a'.repeat(1025)).success).toBe(false)
    expect(tagListWriteSchema.safeParse(tagsOf(1024)).success).toBe(true)
    expect(tagListWriteSchema.safeParse(tagsOf(1025)).success).toBe(false)
  })

  it('holds a scoped tag to the same length as a plain one', () => {
    const scoped = `k:${'v'.repeat(TAG_MAX_CHARS - 2)}`
    expect(tagWriteSchema.safeParse(scoped).success).toBe(true)
    expect(tagWriteSchema.safeParse(`${scoped}v`).success).toBe(false)
  })

  it('refuses in words that name what is too long and the limit', () => {
    expect(messageOf(tagWriteSchema.safeParse('a'.repeat(TAG_MAX_CHARS + 1)))).toBe(
      `a tag is longer than the ${TAG_MAX_CHARS}-character limit for one tag`,
    )
    expect(messageOf(tagListWriteSchema.safeParse(tagsOf(TAGS_PER_ELEMENT_MAX + 1)))).toBe(
      `more tags than the ${TAGS_PER_ELEMENT_MAX}-tag limit for one document, board, node or edge`,
    )
  })

  it('leaves the STORED tags unbounded, so a set written before the limit still reads', () => {
    const long = [...tagsOf(TAGS_PER_ELEMENT_MAX * 2), 'a'.repeat(TAG_MAX_CHARS * 4)]
    expect(storedTagsSchema.parse(long)).toEqual(long)
  })

  it('sits no lower than a label, the smallest bound the sync judge answers without applying', () => {
    // The keepers' sync judge answers an update no longer than its smallest
    // bound without applying it, so a bound below a label's would send every
    // routine node move through the full judgement.
    expect(TAG_MAX_CHARS).toBeGreaterThanOrEqual(LABEL_MAX_CHARS)
    expect(TAGS_PER_ELEMENT_MAX).toBeGreaterThanOrEqual(LABEL_MAX_CHARS)
  })
})
