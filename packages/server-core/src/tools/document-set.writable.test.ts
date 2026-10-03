import { describe, expect, it, vi } from 'vitest'
import { OkfParseError, parseWritableOkf } from './document-set.js'

vi.mock('@kamiazya/whiteboard-codec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kamiazya/whiteboard-codec')>()),
  serializeOkf: () => {
    throw new Error('serialiser defect')
  },
}))

describe('parseWritableOkf', () => {
  // Only a value YAML cannot carry is the author's to fix. Naming any other
  // throw a frontmatter fault sends the author to repair content that is fine.
  it('lets a serialiser failure that is not about the content keep its own name', () => {
    const attempt = () => parseWritableOkf('---\ntype: note\n---\nbody')

    expect(attempt).toThrow('serialiser defect')
    expect(attempt).not.toThrow(OkfParseError)
  })
})
