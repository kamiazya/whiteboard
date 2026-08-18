import { describe, expect, it } from 'vitest'
import { markdownDocumentSchema } from './markdown.js'

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
