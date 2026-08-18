import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { generateDocumentId } from './generate-document-id.js'

describe('generateDocumentId', () => {
  it('produces a 26-character string matching documentIdSchema', () => {
    const id = generateDocumentId()
    expect(id).toHaveLength(26)
    expect(() => documentIdSchema.parse(id)).not.toThrow()
  })

  it('produces different ids on consecutive calls', () => {
    const first = generateDocumentId()
    const second = generateDocumentId()
    expect(first).not.toBe(second)
  })
})
