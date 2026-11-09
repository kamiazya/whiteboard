import { type OkfCodec, okfCodec } from '@kamiazya/whiteboard-codec'
import { describe, expect, it } from 'vitest'
import { OkfParseError, parseWritableOkf } from './document-set.js'

/** The TypeScript reader with a writer that fails for a reason that is not the content. */
const DEFECTIVE_WRITER: OkfCodec = {
  parseOkf: okfCodec(undefined).parseOkf,
  serializeOkf: () => {
    throw new Error('serialiser defect')
  },
}

describe('parseWritableOkf', () => {
  // Only a value YAML cannot carry is the author's to fix. Naming any other
  // throw a frontmatter fault sends the author to repair content that is fine.
  it('lets a serialiser failure that is not about the content keep its own name', () => {
    const attempt = () => parseWritableOkf('---\ntype: note\n---\nbody', DEFECTIVE_WRITER)

    expect(attempt).toThrow('serialiser defect')
    expect(attempt).not.toThrow(OkfParseError)
  })
})
