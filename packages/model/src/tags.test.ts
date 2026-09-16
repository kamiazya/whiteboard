import { describe, expect, it } from 'vitest'
import {
  parseScopedTag,
  SCOPED_TAG_RULE,
  TAG_IDENTIFIER_PATTERN,
  tagsWriteSchema,
  tagWriteSchema,
} from './tags.js'
import { fc, fcTest, withDefaults } from './test-utils/index.js'

describe('parseScopedTag', () => {
  it('reads key:value when both halves are lowercase identifiers', () => {
    expect(parseScopedTag('health:failing')).toEqual({ key: 'health', value: 'failing' })
    expect(parseScopedTag('priority:high-2')).toEqual({ key: 'priority', value: 'high-2' })
  })

  it.each([
    ['Machine Learning', 'no colon'],
    ['v1.2', 'no colon'],
    ['foo:Bar', 'an uppercase half'],
    ['a:b:c', 'two colons'],
    [':b', 'an empty key'],
    ['a:', 'an empty value'],
    ['1a:b', 'a key starting with a digit'],
  ])('answers a plain tag for %s (%s)', (tag) => {
    expect(parseScopedTag(tag)).toBeUndefined()
  })

  it('agrees with the identifier pattern on every half it accepts', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/),
        (key, value) => {
          expect(TAG_IDENTIFIER_PATTERN.test(key)).toBe(true)
          expect(parseScopedTag(`${key}:${value}`)).toEqual({ key, value })
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('tagWriteSchema — the grammar is checked on WRITE, for scoped tags only', () => {
  it('accepts a plain tag verbatim, whatever OKF allows', () => {
    for (const tag of ['Machine Learning', 'v1.2', 'e2e', '日本語']) {
      expect(tagWriteSchema.safeParse(tag)).toMatchObject({ success: true, data: tag })
    }
  })

  it('accepts a well-formed scoped tag', () => {
    expect(tagWriteSchema.safeParse('health:failing').success).toBe(true)
  })

  it.each([
    'Health:failing',
    'foo:Bar',
    'a:b:c',
    ':b',
    'a:',
    'a b:c',
  ])('refuses %s with the rule in the message', (tag) => {
    const result = tagWriteSchema.safeParse(tag)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain(SCOPED_TAG_RULE)
    expect(result.error.issues[0]?.message).toContain(tag)
  })

  it('refuses an empty tag', () => {
    expect(tagWriteSchema.safeParse('').success).toBe(false)
  })
})

describe('tagsWriteSchema — a tag set is a SET', () => {
  it('refuses a duplicate, naming it', () => {
    const result = tagsWriteSchema.safeParse(['a', 'health:ok', 'a'])
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain('"a"')
  })

  it('accepts several values under one key — hoge:foo and hoge:bar together', () => {
    expect(tagsWriteSchema.safeParse(['hoge:foo', 'hoge:bar']).success).toBe(true)
  })

  fcTest.prop(
    [fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,5}$/), { maxLength: 6 })],
    withDefaults(),
  )('accepts any set of plain identifiers, and refuses the same set with one repeated', (tags) => {
    expect(tagsWriteSchema.safeParse(tags).success).toBe(true)
    if (tags.length === 0) return
    expect(tagsWriteSchema.safeParse([...tags, tags[0] as string]).success).toBe(false)
  })
})
