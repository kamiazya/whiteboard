import { describe, expect, it } from 'vitest'
import { markdownCanvasSchema } from './markdown.js'

describe('markdownCanvasSchema', () => {
  it('accepts an arbitrary string body, including one with wiki-link-shaped text', () => {
    expect(
      markdownCanvasSchema.safeParse({ body: '# Title\n\n[[canvas:01ARZ3NDEKTSV4RRFFQ69G5FAV]]' })
        .success,
    ).toBe(true)
  })

  it('accepts an empty body', () => {
    expect(markdownCanvasSchema.safeParse({ body: '' }).success).toBe(true)
  })

  it('rejects a non-string body', () => {
    expect(markdownCanvasSchema.safeParse({ body: 42 }).success).toBe(false)
  })
})
