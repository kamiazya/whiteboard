import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { FontDescriptor, MeasureText, TextMetrics } from '../measure.js'

/**
 * The text-wrapping scoreboard's corpus and its measurer.
 *
 * Deliberately hand-built mdast rather than parsed markdown: the instrument
 * measures LAYOUT, and routing a parser through it would let a codec change
 * move these numbers for reasons that have nothing to do with wrapping.
 */

/**
 * A deterministic measurer that charges CJK and other fullwidth glyphs a
 * FULL em, and Latin ~0.6 em.
 *
 * `fake-measure.ts`'s uniform 0.6 em/char is right for the layout tests that
 * only need proportionality, and wrong here: it understates Japanese by ~40%,
 * which is the single number this scoreboard exists to report. Still pure
 * arithmetic — no font, no platform text API — so results are identical on
 * every machine.
 *
 * Ranges are the fullwidth/CJK blocks of Unicode: CJK ideographs and their
 * extension A, hiragana, katakana, Hangul syllables, CJK symbols and
 * punctuation, and the fullwidth forms.
 */
function isFullWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK symbols and punctuation
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // hiragana + katakana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) // emoji
  )
}

const LATIN_RATIO = 0.6

/** Advance width in em units — the width-model half of the measurer. */
function advanceEm(text: string): number {
  let em = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    em += codePoint !== undefined && isFullWidth(codePoint) ? 1 : LATIN_RATIO
  }
  return em
}

/**
 * Wraps a measurer so the scoreboard can report HOW MANY times layout asked
 * for a measurement. That count is the price metric that would catch a
 * wrapping strategy buying its quality with a per-character measure loop.
 */
export interface CountingMeasure {
  readonly measure: MeasureText
  calls(): number
}

export function createCorpusMeasure(): CountingMeasure {
  let calls = 0
  const measure = (text: string, font: FontDescriptor): TextMetrics => {
    calls += 1
    return {
      advanceWidth: advanceEm(text) * font.sizePx,
      ascent: font.sizePx * 0.8,
      descent: font.sizePx * 0.2,
      lineGap: 0,
    }
  }
  return { measure, calls: () => calls }
}

const paragraph = (value: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
})

const JA_PROSE =
  'これは日本語の長い文章です。ノードの幅を超えても折り返されるべきですが、実際にどうなるかを測ります。'

export interface CorpusCase {
  readonly name: string
  readonly root: MdastRoot
}

/**
 * Every case is chosen because it either overflows today or is at risk of
 * regressing when wrapping changes. Generated width variation lives in
 * `CORPUS_WIDTHS_PX`, kept DENSE (narrow) on purpose: overflow only shows up
 * when content is crowded, and a corpus of roomy boxes scores clean while
 * drawing the same broken pictures.
 */
export const TEXT_WRAPPING_CORPUS: readonly CorpusCase[] = [
  { name: 'en-prose', root: paragraph('This is a fairly long English sentence that should wrap.') },
  { name: 'ja-prose', root: paragraph(JA_PROSE) },
  {
    name: 'ja-en-mixed',
    root: paragraph('この API は canvas-render の layoutMdastBlocks を呼び出します。'),
  },
  {
    name: 'ja-kinsoku',
    root: paragraph('これは日本語です。（括弧）と「かぎ括弧」があります、ね。終わり。'),
  },
  { name: 'zh-prose', root: paragraph('这是一段很长的中文文本，应该在节点的宽度处换行。') },
  {
    name: 'long-url',
    root: paragraph('https://example.com/very/long/path/that/never/breaks/anywhere/at/all'),
  },
  {
    name: 'long-token',
    root: paragraph('SupercalifragilisticexpialidociousAndThenSomeMoreCharacters'),
  },
  {
    name: 'inline-code',
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '呼び出しは ' },
            { type: 'inlineCode', value: 'layoutMdastBlocks(root, options)' },
            { type: 'text', value: ' です。' },
          ],
        },
      ],
    },
  },
  {
    name: 'ja-heading',
    root: {
      type: 'root',
      children: [
        { type: 'heading', depth: 2, children: [{ type: 'text', value: '日本語の見出しはここ' }] },
        { type: 'paragraph', children: [{ type: 'text', value: JA_PROSE }] },
      ],
    },
  },
  {
    name: 'ja-list',
    root: {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [
                { type: 'paragraph', children: [{ type: 'text', value: '一つ目の項目です。' }] },
              ],
            },
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: JA_PROSE }] }],
            },
          ],
        },
      ],
    },
  },
  { name: 'emoji', root: paragraph('進捗は 🎉🎉🎉 です。あとで 🚀 します。') },
]

/** Narrow on purpose — see the corpus comment above. */
export const CORPUS_WIDTHS_PX: readonly number[] = [120, 200, 320]
