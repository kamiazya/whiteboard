import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FontDescriptor } from '../measure.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { decodeLines, encodeLines } from '../test-utils/render-oracle/oracle.js'
import { f64Hex } from '../test-utils/render-oracle/scene-dump.js'

/**
 * The recorded answers of `createFakeMeasure`, which the Rust `FakeMeasure`
 * replays to the last bit (`tests/fake_measure_oracle.rs`). Every double is the
 * hex of its IEEE bits, so a size or a factor that JSON cannot hold (NaN,
 * infinity, -0) is an input like any other. Re-record after a deliberate change
 * with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node fake-measure`.
 */
const FILE = new URL('./fake-measure.jsonl', import.meta.url)

interface FontWire {
  readonly family: string
  readonly fallbackChain: readonly string[]
  readonly weight: number
  readonly style: 'normal' | 'italic'
  readonly sizePx: string
}

interface MeasureRecord {
  readonly id: string
  readonly factor: string
  readonly text: string
  readonly font: FontWire
  readonly advanceWidth: string
  readonly ascent: string
  readonly descent: string
  readonly lineGap: string
}

type MeasureInput = Pick<MeasureRecord, 'id' | 'factor' | 'text' | 'font'>

const view = new DataView(new ArrayBuffer(8))
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
  ['ascii-long', 'x'.repeat(997)],
  ['digits', '0123456789'],
  ['punctuation', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
  ['latin1', 'café naïve über'],
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
  ['combining-acute', 'é'],
  ['combining-stack', 'à́̂̃̄'],
  ['combining-only', '́̂'],
  ['hangul-jamo', '한'],
  ['zero-width', 'a​b‌c‍d﻿'],
  ['rtl', 'שלום مرحبا'],
  ['thai', 'สวัสดี'],
  ['nul-and-controls', '\u0000\u0001\u007f\u0085'],
  ['line-separators', '   '],
  ['mixed', 'a日😀é b'],
]

const SIZES: readonly [string, number][] = [
  ['12', 12],
  ['13.5', 13.5],
  ['0', 0],
  ['neg-zero', -0],
  ['negative', -16],
  ['tenth', 0.1],
  ['third', 1 / 3],
  ['large', 1e21],
  ['tiny', 5e-324],
  ['max', Number.MAX_VALUE],
  ['nan', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
]

const BASE_FONT: Omit<FontWire, 'sizePx'> = {
  family: 'Inter',
  fallbackChain: ['Noto Sans', 'sans-serif'],
  weight: 400,
  style: 'normal',
}

const font = (sizePx: number, over: Partial<Omit<FontWire, 'sizePx'>> = {}): FontWire => ({
  ...BASE_FONT,
  ...over,
  sizePx: f64Hex(sizePx),
})

/** The descriptor variants the fake could distinguish and does not. */
const VARIANTS: readonly [string, Partial<Omit<FontWire, 'sizePx'>>][] = [
  ['family', { family: 'Roboto Mono' }],
  ['empty-family', { family: '', fallbackChain: [] }],
  ['no-chain', { fallbackChain: [] }],
  ['long-chain', { fallbackChain: ['a', 'b', 'c', 'd', 'sans-serif'] }],
  ['bold', { weight: 700 }],
  ['thin', { weight: 100 }],
  ['black', { weight: 900 }],
  ['fractional-weight', { weight: 450.5 }],
  ['italic', { style: 'italic' }],
  ['bold-italic', { weight: 700, style: 'italic' }],
]

const FACTORS: readonly number[] = [
  0.6,
  0.55,
  0.5,
  1,
  2,
  0.1,
  1 / 3,
  0,
  -0,
  1e-9,
  1e300,
  Number.NaN,
]

function measureInputs(): readonly MeasureInput[] {
  const inputs: MeasureInput[] = []
  const factor = f64Hex(0.6)
  for (const [name, text] of TEXTS) {
    for (const [sizeName, size] of SIZES) {
      inputs.push({ id: `text/${name}/size/${sizeName}`, factor, text, font: font(size) })
    }
  }
  for (const [name, over] of VARIANTS) {
    for (const text of ['hello', '日本😀']) {
      inputs.push({ id: `variant/${name}/${text.length}`, factor, text, font: font(12, over) })
    }
  }
  for (const [i, f] of FACTORS.entries()) {
    for (const [name, text] of [TEXTS[5], TEXTS[14], TEXTS[0]] as const) {
      for (const size of [12, 13.5, 0.1]) {
        inputs.push({
          id: `factor/${i}/${name}/${size}`,
          factor: f64Hex(f),
          text,
          font: font(size),
        })
      }
    }
  }
  return inputs
}

function measureAnswer(input: MeasureInput): MeasureRecord {
  const descriptor: FontDescriptor = { ...input.font, sizePx: fromHex(input.font.sizePx) }
  const m = createFakeMeasure(fromHex(input.factor))(input.text, descriptor)
  return {
    ...input,
    advanceWidth: f64Hex(m.advanceWidth),
    ascent: f64Hex(m.ascent),
    descent: f64Hex(m.descent),
    lineGap: f64Hex(m.lineGap),
  }
}

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(measureInputs().map(measureAnswer)))
}

describe('the recorded fake measurer', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<MeasureRecord>(text)

  it('reaches every script, every size and every descriptor variant', () => {
    const under = (prefix: string) => recorded.filter((r) => r.id.startsWith(prefix)).length
    expect(under('text/')).toBe(TEXTS.length * SIZES.length)
    expect(under('variant/')).toBe(VARIANTS.length * 2)
    expect(under('factor/')).toBe(FACTORS.length * 9)
    expect(recorded.some((r) => r.advanceWidth === f64Hex(Number.NaN))).toBe(true)
  })

  it('answers a length in UTF-16 units, so an astral code point costs two', () => {
    const advance = (id: string) => {
      const record = recorded.find((r) => r.id === id)
      return record === undefined ? Number.NaN : fromHex(record.advanceWidth)
    }
    expect(advance('text/emoji-astral/size/12')).toBe(4 * 0.6 * 12)
    expect(advance('text/combining-acute/size/12')).toBe(2 * 0.6 * 12)
  })

  it('equals what the TypeScript answers today', () => {
    const lines = text.trimEnd().split('\n')
    const parted = recorded.findIndex(
      (r, i) =>
        JSON.stringify(
          measureAnswer({ id: r.id, factor: r.factor, text: r.text, font: r.font }),
        ) !== lines[i],
    )
    expect(
      recorded[parted]?.id,
      'the first recorded input the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})
