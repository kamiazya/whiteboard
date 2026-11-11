import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { FontDescriptor } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import type * as opentype from 'opentype.js'
import { describe, expect, it } from 'vitest'
import { opentypeApi } from '../../shared/opentype.js'
import { resolveExportFontFaces } from './export-font.js'
import { createExportTextMeasurer } from './measure-text.js'
import { NO_INSTALLED_FONTS } from './test-utils/no-installed-fonts.js'

/**
 * The recorded answers of the Node measurer (opentype.js over the vendored
 * Roboto) and of `constantRatioMeasureText`, which the Rust
 * `FontTableMeasurer` and `ConstantRatioMeasure` replay to the last bit
 * (`crates/core/canvas-render/tests/font_measure_oracle.rs`). The recorder lives
 * here because the Node measurer is a composition root's: canvas-render may not
 * import it. Every double is the hex of its IEEE bits, so a size JSON cannot
 * hold (NaN, infinity, -0) is an input like any other.
 *
 * A font record carries a `class`, judged by a plain per-glyph sum written
 * below that shares nothing with the measurer under test:
 *
 * - `exact`: the measurer answers that sum within a part in 1e9, so the Rust
 *   port owes its bits exactly (the measurer's 64-code-point segment sums
 *   included, which move the last bits and are ported);
 * - `substituted`: opentype.js replaced glyphs through the face's GSUB `ccmp`
 *   before summing (an `i` under a combining dot), which the port does not
 *   run. The replay holds these to a tenth of an em and fails one it
 *   reproduces exactly, so the class cannot outlive the gap.
 *
 * `segment-joins.json` records which code points keep a segment from being cut
 * before them (`\p{M}` and `\p{Cf}` under this Node's Unicode), the table
 * the port carries.
 *
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node measure-text.oracle`.
 */
const FILE = new URL('./oracle/font-measure.jsonl', import.meta.url)
const JOINS_FILE = new URL('./oracle/segment-joins.json', import.meta.url)

interface FontWire {
  readonly family: string
  readonly fallbackChain: readonly string[]
  readonly weight: number
  readonly style: 'normal' | 'italic'
  readonly sizePx: string
}

type Measurer = 'font' | 'constant-ratio'
type Class = 'exact' | 'substituted'

interface Input {
  readonly id: string
  readonly measurer: Measurer
  readonly text: string
  readonly font: FontWire
}

interface Recorded extends Input {
  readonly advanceWidth: string
  readonly ascent: string
  readonly descent: string
  readonly lineGap: string
  readonly class: Class
}

const view = new DataView(new ArrayBuffer(8))
function f64Hex(value: number): string {
  view.setFloat64(0, value)
  const word = (offset: number) => view.getUint32(offset).toString(16).padStart(8, '0')
  return word(0) + word(4)
}
function fromHex(hex: string): number {
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16))
  view.setUint32(4, Number.parseInt(hex.slice(8), 16))
  return view.getFloat64(0)
}

const TEXTS: readonly [string, string][] = [
  ['empty', ''],
  ['space', ' '],
  ['spaces', '   '],
  ['tab', '\t'],
  ['ascii-word', 'hello'],
  ['ascii-sentence', 'The quick brown fox jumps over the lazy dog.'],
  ['sample', 'Hamburgefonstiv'],
  ['kerning-pairs', 'AVATAR To Yo'],
  ['ligature-candidates', 'fi fl ffi ffl'],
  ['digits', '0123456789'],
  ['punctuation', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
  ['latin1', 'café naïve über ÀÉÎÕÜ ß ÿ'],
  ['latin-extended', 'Łódź Ångström ışğ'],
  ['greek', 'Ελληνικά αβγδ'],
  ['cyrillic', 'Привет мир'],
  ['symbols', '€£¥©®™°±×÷'],
  ['cjk', '日本語のテキスト'],
  ['hangul', '한국어'],
  ['fullwidth', 'ＡＢＣ１２'],
  ['emoji-bmp', '❤️✅'],
  ['emoji-astral', '😀🚀'],
  ['emoji-zwj', '👨‍👩‍👧'],
  ['emoji-flag', '🇯🇵'],
  ['emoji-skin', '👍🏽'],
  ['astral-cjk', '𠀋𩸽'],
  ['astral-math', '𝔸𝔹'],
  ['combining-acute', 'é'],
  ['combining-stack', 'à́̂̃̄'],
  ['combining-only', '́̂'],
  ['combining-dot-on-i', 'i̇'],
  ['combining-diaeresis-on-j', 'j̈'],
  ['combining-on-dotless', 'ı̇ ɉ́'],
  ['precomposed-with-mark', 'í'],
  ['hangul-jamo', '한'],
  ['zero-width', 'a​b‌c‍d﻿'],
  ['variation-selector', 'ab️'],
  ['rtl', 'שלום مرحبا'],
  ['thai', 'สวัสดี'],
  ['nul-and-controls', '\u0000\u0001\u007f\u0085'],
  ['line-separators', '   '],
  ['missing-between-present', 'abc日def'],
  ['missing-at-edges', '日abc日'],
  ['mixed', 'a日😀é b'],
  ['ascii-63', 'x'.repeat(63)],
  ['ascii-64', 'x'.repeat(64)],
  ['ascii-65', 'x'.repeat(65)],
  ['ascii-long', 'The quick brown fox. '.repeat(48)],
  ['mixed-long', 'abc日'.repeat(80)],
  ['pangram-long', 'Pack my box with five dozen liquor jugs. '.repeat(40)],
  ['mark-at-cut', `${'x'.repeat(63)}\u0301${'y'.repeat(70)}`],
  ['marks-past-cut', `${'x'.repeat(64)}${'\u0301'.repeat(30)}${'y'.repeat(70)}`],
  ['marks-forced-cut', `x${'\u0301'.repeat(400)}z`],
  ['advancing-joins-forced-cut', `Wiq${'\u00ad'.repeat(400)}z`],
  ['advancing-marks-forced-cut', `Wiq${'\u0358'.repeat(400)}z`],
  ['advancing-joins-in-words', `${'Wiq\u00ad'.repeat(120)}`],
  ['advancing-joins-alternating', `Wiq${'\u00ad\u0358'.repeat(500)}z`],
  ['marks-long-run', `${'e\u0301'.repeat(150)}`],
  ['astral-in-long', `${'a'.repeat(62)}😀${'b'.repeat(70)}`],
  ['joiners-long', `${'a'.repeat(63)}\u200d${'b'.repeat(66)}\u200b${'c'.repeat(70)}`],
]

const CORE_SIZES: readonly [string, number][] = [
  ['12', 12],
  ['13.5', 13.5],
  ['16', 16],
  ['tenth', 0.1],
  ['48', 48],
]

const EDGE_SIZES: readonly [string, number][] = [
  ['0', 0],
  ['neg-zero', -0],
  ['negative', -16],
  ['third', 1 / 3],
  ['seven-tenths', 0.7],
  ['odd', 7.3],
  ['irrational', Math.PI],
  ['large', 1e21],
  ['tiny', 5e-324],
  ['max', Number.MAX_VALUE],
  ['nan', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
]

const EDGE_TEXTS = [
  'empty',
  'ascii-sentence',
  'cjk',
  'missing-between-present',
  'emoji-astral',
  'advancing-joins-alternating',
  'pangram-long',
]

const font = (sizePx: number, over: Partial<Omit<FontWire, 'sizePx'>> = {}): FontWire => ({
  family: 'Roboto',
  fallbackChain: ['sans-serif'],
  weight: 400,
  style: 'normal',
  ...over,
  sizePx: f64Hex(sizePx),
})

/** Descriptor variants: every face, the weight boundary, and a family nothing holds. */
const VARIANTS: readonly [string, Partial<Omit<FontWire, 'sizePx'>>][] = [
  ['bold', { weight: 700 }],
  ['italic', { style: 'italic' }],
  ['bold-italic', { weight: 700, style: 'italic' }],
  ['thin', { weight: 100 }],
  ['black', { weight: 900 }],
  ['just-below-bold', { weight: 599.9 }],
  ['bold-boundary', { weight: 600 }],
  ['fractional', { weight: 450.5 }],
  ['unknown-family', { family: 'Inter', fallbackChain: ['Noto Sans', 'sans-serif'] }],
  ['unknown-family-bold-italic', { family: 'Inter', weight: 800, style: 'italic' }],
  ['empty-family', { family: '', fallbackChain: [] }],
  ['css-chain', { family: 'ui-monospace, monospace', fallbackChain: [] }],
]

const VARIANT_TEXTS = ['ascii-sentence', 'sample', 'latin1', 'cjk', 'missing-between-present']

function textOf(name: string): string {
  const found = TEXTS.find(([n]) => n === name)
  if (found === undefined) throw new Error(`no corpus text ${name}`)
  return found[1]
}

function inputs(): readonly Input[] {
  const out: Input[] = []
  for (const [name, text] of TEXTS) {
    for (const [sizeName, size] of CORE_SIZES) {
      out.push({ id: `font/${name}/${sizeName}`, measurer: 'font', text, font: font(size) })
    }
  }
  for (const name of EDGE_TEXTS) {
    for (const [sizeName, size] of EDGE_SIZES) {
      out.push({
        id: `font/${name}/${sizeName}`,
        measurer: 'font',
        text: textOf(name),
        font: font(size),
      })
    }
  }
  for (const [variant, over] of VARIANTS) {
    for (const name of VARIANT_TEXTS) {
      for (const [sizeName, size] of CORE_SIZES.slice(0, 3)) {
        out.push({
          id: `variant/${variant}/${name}/${sizeName}`,
          measurer: 'font',
          text: textOf(name),
          font: font(size, over),
        })
      }
    }
  }
  for (const [name, text] of TEXTS) {
    for (const [sizeName, size] of [...CORE_SIZES, ...EDGE_SIZES]) {
      out.push({
        id: `constant-ratio/${name}/${sizeName}`,
        measurer: 'constant-ratio',
        text,
        font: font(size),
      })
    }
  }
  return out
}

const FACE_FILES = ['regular', 'bold', 'italic', 'boldItalic'] as const

/** The plain per-glyph model: hmtx advances left to right, `.notdef` estimated. */
async function modelAdvance(input: Input): Promise<number> {
  const paths = await resolveExportFontFaces()
  const bold = input.font.weight >= 600
  const italic = input.font.style === 'italic'
  const key = FACE_FILES[(bold ? 1 : 0) + (italic ? 2 : 0)] ?? 'regular'
  const path = paths[key]
  if (path === null) throw new Error(`the vendored ${key} face is missing`)
  const face = await loadFace(path)
  const size = Number.isFinite(fromHex(input.font.sizePx)) ? fromHex(input.font.sizePx) : 0
  const descriptor: FontDescriptor = { ...input.font, sizePx: fromHex(input.font.sizePx) }
  const scale = (1 / face.unitsPerEm) * Math.max(size, 0)
  let advance = 0
  let run = 0
  const flush = () => {
    advance += run
    run = 0
  }
  for (const char of input.text) {
    const index = face.charToGlyphIndex(char)
    if (index === 0) {
      flush()
      advance += constantRatioMeasureText(char, descriptor).advanceWidth
      continue
    }
    const units = face.glyphs.get(index).advanceWidth ?? 0
    if (units !== 0) run += units * scale
  }
  flush()
  return advance
}

const faceCache = new Map<string, opentype.Font>()
async function loadFace(path: string): Promise<opentype.Font> {
  const cached = faceCache.get(path)
  if (cached !== undefined) return cached
  const buffer = await readFile(path)
  const parsed = opentypeApi.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  )
  faceCache.set(path, parsed)
  return parsed
}

function classify(input: Input, advance: number, model: number): Class {
  if (Object.is(advance, model) || (Number.isNaN(advance) && Number.isNaN(model))) return 'exact'
  const clamped = Number.isFinite(model) && model >= 0 ? model : 0
  if (Math.abs(advance - clamped) <= 1e-9 * Math.max(1, Math.abs(clamped))) return 'exact'
  return input.text.length > 0 ? 'substituted' : 'exact'
}

/** The code points the measurer never cuts a segment before, as inclusive ranges. */
function joinRanges(): readonly (readonly [number, number])[] {
  const joins = /[\p{M}\p{Cf}]/u
  const ranges: [number, number][] = []
  let low = -1
  for (let code = 0; code <= 0x10ffff + 1; code++) {
    const on =
      code <= 0x10ffff &&
      !(code >= 0xd800 && code <= 0xdfff) &&
      joins.test(String.fromCodePoint(code))
    if (on && low < 0) low = code
    if (!on && low >= 0) {
      ranges.push([low, code - 1])
      low = -1
    }
  }
  return ranges
}

async function answer(input: Input): Promise<Recorded> {
  const descriptor: FontDescriptor = { ...input.font, sizePx: fromHex(input.font.sizePx) }
  if (input.measurer === 'constant-ratio') {
    const m = constantRatioMeasureText(input.text, descriptor)
    return {
      ...input,
      advanceWidth: f64Hex(m.advanceWidth),
      ascent: f64Hex(m.ascent),
      descent: f64Hex(m.descent),
      lineGap: f64Hex(m.lineGap),
      class: 'exact',
    }
  }
  const { measure } = await createExportTextMeasurer({ fontsDir: NO_INSTALLED_FONTS })
  const m = measure(input.text, descriptor)
  const model = await modelAdvance(input)
  const clampedModel = Number.isFinite(model) && model >= 0 ? model : 0
  const size = fromHex(input.font.sizePx)
  const shortCircuit = !(size > 0) || input.text.length === 0
  return {
    ...input,
    advanceWidth: f64Hex(m.advanceWidth),
    ascent: f64Hex(m.ascent),
    descent: f64Hex(m.descent),
    lineGap: f64Hex(m.lineGap),
    class: shortCircuit ? 'exact' : classify(input, m.advanceWidth, clampedModel),
  }
}

async function answers(wanted: readonly Input[]): Promise<readonly Recorded[]> {
  const out: Recorded[] = []
  for (const input of wanted) out.push(await answer(input))
  return out
}

const encode = (records: readonly unknown[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encode(await answers(inputs())))
  writeFileSync(
    JOINS_FILE,
    `[\n${joinRanges()
      .map(([low, high]) => `  [${low}, ${high}]`)
      .join(',\n')}\n]\n`,
  )
}

describe('the recorded font measurer', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Recorded)

  it('reaches every script, face, size edge and both measurers', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    expect(under('font/')).toBe(
      TEXTS.length * CORE_SIZES.length + EDGE_TEXTS.length * EDGE_SIZES.length,
    )
    expect(under('variant/')).toBe(VARIANTS.length * VARIANT_TEXTS.length * 3)
    expect(under('constant-ratio/')).toBe(TEXTS.length * (CORE_SIZES.length + EDGE_SIZES.length))
    expect(recorded.length).toBeGreaterThan(1100)
  })

  it('is exact for nearly all of it, so the gaps stay named', () => {
    const count = (c: Class) => recorded.filter((r) => r.class === c).length
    expect(count('substituted')).toBeGreaterThan(0)
    expect(count('substituted')).toBeLessThan(recorded.length / 40)
    expect(count('exact')).toBeGreaterThan(recorded.length * 0.9)
  })

  it('records the joining table the measurer is held to', () => {
    const ranges = JSON.parse(readFileSync(JOINS_FILE, 'utf8')) as number[][]
    expect(ranges).toEqual(joinRanges())
    expect(ranges.length).toBeGreaterThan(300)
  })

  it('measures a missing glyph by estimate and a carried one by the face', () => {
    const advance = (id: string) => {
      const record = recorded.find((r) => r.id === id)
      return record === undefined ? Number.NaN : fromHex(record.advanceWidth)
    }
    expect(advance('font/cjk/16')).toBe(8 * 16)
    expect(advance('font/sample/16')).toBe(123.5)
  })

  it('equals what the Node measurer answers today', async () => {
    const lines = text.trimEnd().split('\n')
    const fresh = await answers(
      recorded.map(({ id, measurer, text: t, font: f }) => ({ id, measurer, text: t, font: f })),
    )
    const parted = fresh.findIndex((r, i) => JSON.stringify(r) !== lines[i])
    expect(
      recorded[parted]?.id,
      'the first recorded input the Node measurer no longer answers as recorded',
    ).toBeUndefined()
  })
})
