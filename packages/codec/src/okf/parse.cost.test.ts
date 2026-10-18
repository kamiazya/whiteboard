// What a nested frontmatter costs on every read. `serializeOkf` writes a
// mapping in block style, two more spaces of indent per level, so a value
// nested D mappings deep is written out in about D² characters — and every
// read and export of the document re-serialises it.

import { describe, expect, it } from 'vitest'
import { parseOkf } from './parse.js'
import { serializeOkf } from './serialize.js'

/** A document whose `x` holds `depth` nested single-key mappings. */
const nested = (depth: number): string =>
  `---\ntype: note\nx: ${'{a: '.repeat(depth)}1${'}'.repeat(depth)}\n---\nbody\n`

describe('parseOkf cost', () => {
  it('accepts no frontmatter that serialises to many times its size', () => {
    // Measured: 2_529 chars in, 252_029 out at depth 500, a hundredfold;
    // yaml accepted up to 811 levels in the test worker, where serializeOkf
    // itself then overflowed the stack.
    const text = nested(500)
    const parsed = parseOkf(text)
    if (parsed.ok) {
      expect(serializeOkf(parsed.value).length).toBeLessThanOrEqual(20 * text.length)
      return
    }
    // Refused for its depth, not for anything else about it.
    expect(parsed.error.message).toMatch(/at most 32 levels/)
  })
})
