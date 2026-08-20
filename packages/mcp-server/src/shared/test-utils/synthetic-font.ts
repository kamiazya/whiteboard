import { opentypeApi } from '../opentype.js'

/**
 * A minimal real font covering exactly `covered`, as bytes.
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
export function syntheticFont(covered: string, familyName = 'WhiteboardTestFont'): Buffer {
  const square = new opentypeApi.Path()
  square.moveTo(100, 0)
  square.lineTo(100, 700)
  square.lineTo(800, 700)
  square.lineTo(800, 0)
  square.close()

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
      new opentypeApi.Glyph({
        name: 'covered',
        unicode: covered.codePointAt(0),
        advanceWidth: 1000,
        path: square,
      }),
    ],
  })

  return Buffer.from(font.toArrayBuffer())
}
