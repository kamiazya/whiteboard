import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The code points `String.prototype.trim` strips in this engine, recorded for
 * the Rust port. Its `is_js_space` (`crates/core/codec/src/okf/js.rs`) is a
 * hand-written copy of ECMAScript's `WhiteSpace` and `LineTerminator`, and
 * `WhiteSpace` reaches into Unicode's `Zs`, so it is a Unicode table: the
 * Rust side asserts every scalar value against this file, natively and on
 * wasm, and this test asserts the file against the engine. An engine whose
 * Unicode moves `Zs` fails here before the two codecs read a title
 * differently. Re-record with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project codec-node js-whitespace`.
 */
const FILE = new URL('./js-whitespace.json', import.meta.url)

function strippedByTrim(): number[] {
  const stripped: number[] = []
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (String.fromCodePoint(cp).trim() === '') stripped.push(cp)
  }
  return stripped
}

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, `${JSON.stringify(strippedByTrim())}\n`)
}

describe('the recorded JavaScript whitespace table', () => {
  it('is what trim strips in this engine', () => {
    const recorded: unknown = JSON.parse(readFileSync(FILE, 'utf8'))
    expect(recorded).toEqual(strippedByTrim())
  })

  it('holds the space, the line terminators, the byte order mark and the Zs block', () => {
    const recorded = JSON.parse(readFileSync(FILE, 'utf8')) as number[]
    for (const cp of [0x20, 0x0a, 0x2028, 0xfeff, 0x3000, 0x2000]) expect(recorded).toContain(cp)
    expect(recorded).not.toContain(0x85)
  })
})
