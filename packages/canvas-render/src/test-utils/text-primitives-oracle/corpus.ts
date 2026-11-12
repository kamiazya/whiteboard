/**
 * What the text-primitives oracle asks, as data: the strings (named by what
 * they stress), the code points the generated corpora draw from, and the
 * widths a text is fitted to. Every string here is well-formed UTF-16, since the
 * Rust port's text is a `&str`; the line breaker's own recording covers lone
 * surrogates.
 */

const rep = (text: string, times: number): string => text.repeat(times)

/** Strings that stress a cut: clusters, kinsoku, CR LF, scripts, and plain text. */
export const TEXTS: readonly (readonly [string, string])[] = [
  ['empty', ''],
  ['one', 'a'],
  ['word', 'hello'],
  ['sentence', 'The quick brown fox jumps over the lazy dog.'],
  ['ascii-100', rep('x', 100)],
  ['spaces', 'a  b   c'],
  ['latin1', 'café naïve über'],
  ['cjk', '日本語のテキストを折り返す'],
  ['cjk-60', rep('漢字', 30)],
  ['kinsoku-close', '「こんにちは」、世界。'],
  ['kinsoku-open', '（注）これは例です。'],
  ['kinsoku-marks', 'ー・…‥〜'],
  ['small-kana', 'きゃっちゅう'],
  ['fullwidth', 'ＡＢＣ１２'],
  ['astral-cjk', '𠀋𩸽𠮷'],
  ['astral-math', '𝔸𝔹ℂ'],
  ['emoji', '😀🚀👍'],
  ['emoji-zwj-family', '👨‍👩‍👧'],
  ['emoji-zwj-inline', 'a👨‍👩‍👧‍👦b'],
  ['emoji-zwj-heart', '❤️‍🔥x'],
  ['flags', '🇯🇵🇺🇸🇫🇷'],
  ['flag-after-letter', 'x🇯🇵🇺🇸'],
  ['skin-tone', '👍🏽👍🏿👍🏻'],
  ['keycap', '1️⃣2️⃣'],
  ['variation', '❤️✅☺️'],
  ['tag-sequence', '🏴󠁧󠁢󠁥󠁮󠁧󠁿ok'],
  ['combining-acute', 'é'],
  ['combining-stack', 'à́̂̃̄'],
  ['combining-run', rep('é', 30)],
  ['combining-leading', '́̂a'],
  ['combining-only', '́̂'],
  ['below-threshold', 'a˿b'],
  ['at-threshold', 'à'],
  ['crlf', 'a\r\nb'],
  ['crlf-pairs', '\r\n\r\n'],
  ['crlf-text', 'line\r\nbreak\r\nagain'],
  ['cr-alone', 'a\rb'],
  ['lf-alone', 'a\nb\nc'],
  ['lf-cr', 'a\n\rb'],
  ['hangul', '한국어'],
  ['hangul-jamo', '한글'],
  ['hangul-lvt', '각각'],
  ['thai', 'สวัสดีครับ'],
  ['thai-marks', 'กี้ก็'],
  ['devanagari-conjunct', 'क्षत्रिय'],
  ['devanagari-zwj', 'क्‍ष'],
  ['bengali-conjunct', 'ক্ষ'],
  ['malayalam-conjunct', 'ക്ക'],
  ['prepend', '؀١٢٣'],
  ['spacing-mark', 'ாக'],
  ['joiners', 'a‍b‌c'],
  ['rtl', 'שלום مرحبا'],
  ['mixed', 'a日😀é b'],
  ['controls', '\t\u0000a'],
  ['whitespace-variety', 'a b　c﻿d\u0085e'],
  ['zero-width', 'a​b⁠c'],
  ['long-mixed', rep('ab日😀é ', 12)],
  ['long-family', rep('👨‍👩‍👧', 8)],
]

/** Code points the generated mixed strings draw from, for what a cluster does. */
export const MIXED_ALPHABET: readonly number[] = [
  ...'aZ09 \r\n.-「」。、日本ひ한',
  ...'̀́‍‌️⃣ัำा्',
  ...'क्षสว้',
  ...'؀',
].map((ch) => ch.codePointAt(0) ?? 0)
export const MIXED_ASTRAL: readonly number[] = [
  0x1f468, 0x1f469, 0x1f466, 0x1f3fb, 0x1f600, 0x1f1ef, 0x1f1f5, 0x1f1fa, 0x20000, 0xe0020, 0xe007f,
]
export const MIXED_JAMO: readonly number[] = [0x1100, 0x1161, 0x11a8, 0xac00, 0xac01]

/**
 * One code point per grapheme-break behaviour a rule could turn on, so that
 * every ordered triple of them is a census of the segmenter.
 */
export const GRAPHEME_REPS: readonly number[] = [
  0x61, 0x20, 0x0d, 0x0a, 0x00, 0x0300, 0x0301, 0x200d, 0x200c, 0xfe0f, 0x20e3, 0x1f3fb, 0x1f468,
  0x1f469, 0x1f466, 0x1f1ef, 0x1f1f5, 0x1f600, 0x2764, 0x00a9, 0x2640, 0xe0020, 0xe007f, 0x1100,
  0x1161, 0x11a8, 0xac00, 0xac01, 0x0e01, 0x0e31, 0x0e33, 0x0600, 0x0d4e, 0x0903, 0x093e, 0x0915,
  0x094d, 0x0937, 0x0995, 0x09cd, 0x09b7, 0x0a95, 0x0acd, 0x0b95, 0x0bcd, 0x0c15, 0x0c4d, 0x0d15,
  0x0d4d, 0x0e40, 0x1b01, 0x1b44, 0x31, 0x4e00, 0x3042, 0x1f9d1, 0x1f3f4, 0x2028, 0x7f, 0x10ffff,
]

/** Texts aimed at a break rule, beside {@link TEXTS}. */
export const UAX_EXTRA: readonly string[] = [
  '日本。語',
  '日本、語',
  'x)。',
  '（日本）',
  '「a」b',
  ' a',
  'a  ',
  'a b c',
  'a\nb',
  'a-b/c',
  'a\u00adb',
  'foo.bar',
  '1,000.50',
  '\u{fffc}。',
  '\u{fffc}a',
  '👍。',
  '日\u200b本',
  rep('a', 200),
  rep('日', 200),
  rep('ก', 50),
]

/** UTF-16 unit texts holding a lone surrogate, which a `&str` cannot. */
export const UAX_LONE: readonly (readonly number[])[] = [
  [0xd800],
  [0xdc00],
  [0x61, 0xd800, 0x62],
  [0x61, 0xdc00, 0x62],
  [0xd83d, 0xd83d, 0xde00],
  [0xde00, 0xd83d],
  [0x65e5, 0xd800, 0x672c],
  [0x20, 0xdbff, 0x20],
]
