import { describe, expect, it } from 'vitest'
import { MARKDOWN_MAX_CHARS, markdownDocumentSchema, markdownInputSchema } from './markdown.js'

describe('markdownDocumentSchema', () => {
  it('accepts an arbitrary string body, including one with wiki-link-shaped text', () => {
    expect(
      markdownDocumentSchema.safeParse({ body: '# Title\n\n[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]' })
        .success,
    ).toBe(true)
  })

  it('accepts an empty body', () => {
    expect(markdownDocumentSchema.safeParse({ body: '' }).success).toBe(true)
  })

  it('rejects a non-string body', () => {
    expect(markdownDocumentSchema.safeParse({ body: 42 }).success).toBe(false)
  })
})

describe('markdownInputSchema', () => {
  it('accepts a write of exactly the limit and refuses one character more', () => {
    expect(markdownInputSchema.safeParse('x'.repeat(MARKDOWN_MAX_CHARS)).success).toBe(true)
    expect(markdownInputSchema.safeParse('x'.repeat(MARKDOWN_MAX_CHARS + 1)).success).toBe(false)
  })

  it('counts UTF-16 code units, so an astral character costs two', () => {
    // The limit exists because import time follows length, and `String#length`
    // is the length every runtime agrees on.
    const half = '😀'.repeat(MARKDOWN_MAX_CHARS / 2)
    expect(half).toHaveLength(MARKDOWN_MAX_CHARS)
    expect(markdownInputSchema.safeParse(half).success).toBe(true)
    expect(markdownInputSchema.safeParse(`${half}😀`).success).toBe(false)
  })

  it('refuses in words that name the limit and what to do', () => {
    const refusal = markdownInputSchema.safeParse('x'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(refusal.success ? '' : refusal.error.issues[0]?.message).toBe(
      `markdown is longer than the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`,
    )
  })
})
