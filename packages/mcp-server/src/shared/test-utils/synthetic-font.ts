import { opentypeApi } from '../opentype.js'

/**
 * A minimal real font covering exactly the code points of `covered`, as bytes.
 *
 * Font tests need a glyph the vendored Latin face does not have. Reading one
 * off the machine is not an option: no CI job installs a CJK font, so a test
 * guarded by `skipIf(<font missing>)` is green everywhere and has run nowhere.
 * `opentype.js` builds fonts as well as parsing them, so the fixture can make
 * its own — no system dependency, no committed binary, no license question.
 *
 * The glyph is a filled square rather than an empty path so that a rendered
 * result differs in PIXELS, which is the only place "did resvg actually use
 * this face" can be observed.
 */
export function syntheticFont(
  covered: string,
  familyName = 'WhiteboardTestFont',
): Buffer<ArrayBuffer> {
  const square = new opentypeApi.Path()
  square.moveTo(100, 0)
  square.lineTo(100, 700)
  square.lineTo(800, 700)
  square.lineTo(800, 0)
  square.close()

  // A full em per glyph, which no real Latin face gives every character —
  // so a measurement taken with this face is distinguishable from one taken
  // with the vendored Roboto, which is how "which face measured this?" is
  // observable at all.
  const glyphs = [...covered].map(
    (char, index) =>
      new opentypeApi.Glyph({
        name: `covered${index}`,
        unicode: char.codePointAt(0),
        advanceWidth: 1000,
        path: square,
      }),
  )

  const font = new opentypeApi.Font({
    familyName,
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      // Index 0 must be `.notdef` — a font without it is not loadable.
      new opentypeApi.Glyph({
        name: '.notdef',
        unicode: 0,
        advanceWidth: 1000,
        path: new opentypeApi.Path(),
      }),
      ...glyphs,
    ],
  })

  return Buffer.from(font.toArrayBuffer())
}

/** A table of an sfnt's directory: its tag, checksum and bytes. */
function sfntTables(sfnt: Buffer): { tag: Buffer; checksum: number; data: Buffer }[] {
  return Array.from({ length: sfnt.readUInt16BE(4) }, (_, i) => {
    const at = 12 + i * 16
    const offset = sfnt.readUInt32BE(at + 8)
    return {
      tag: sfnt.subarray(at, at + 4),
      checksum: sfnt.readUInt32BE(at + 4),
      data: sfnt.subarray(offset, offset + sfnt.readUInt32BE(at + 12)),
    }
  })
}

/**
 * `sfnt` repackaged as a WOFF 1.0 with every table stored uncompressed, which
 * the format allows. opentype.js reads it, and a reader of bare sfnt tables
 * does not: the case where the two measurers' formats part.
 */
export function woffOf(sfnt: Buffer): Buffer<ArrayBuffer> {
  const tables = sfntTables(sfnt)
  const directory = Buffer.alloc(20 * tables.length)
  const blocks: Buffer[] = []
  let offset = 44 + directory.length
  tables.forEach(({ tag, checksum, data }, i) => {
    const block = Buffer.alloc((data.length + 3) & ~3)
    data.copy(block)
    tag.copy(directory, i * 20)
    directory.writeUInt32BE(offset, i * 20 + 4)
    directory.writeUInt32BE(data.length, i * 20 + 8)
    directory.writeUInt32BE(data.length, i * 20 + 12)
    directory.writeUInt32BE(checksum, i * 20 + 16)
    blocks.push(block)
    offset += block.length
  })
  const header = Buffer.alloc(44)
  header.write('wOFF', 0, 'latin1')
  sfnt.copy(header, 4, 0, 4)
  header.writeUInt32BE(offset, 8)
  header.writeUInt16BE(tables.length, 12)
  header.writeUInt32BE(sfnt.length, 16)
  return Buffer.concat([header, directory, ...blocks])
}
