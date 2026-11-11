import {
  alphabet,
  CENSUS_BLOCK,
  Digest,
  type DigestRecord,
  feedAnswer,
  LAST_CODE_POINT,
  type MetaRecord,
  MIXED,
  mixedChunk,
  type OracleRecord,
  RAW_BLOCK,
  rawClass,
  representatives,
  textRecord,
} from './oracle.js'

const KANJI = 0x4e00
const LATIN = [0x61, 0x62] as const

/** Text a user might write, one script or one trap per entry. */
const REAL_TEXT = [
  'The quick brown fox jumps over the lazy dog. It cost $1,234.56 (approx.), i.e. 10% more than 3.14159 or U.S.A. fans expected.',
  'See [1]; e.g., http://example.com/a-b/c?d=e&f=g#h — and "quoted text" or (a parenthetical) plus {braces}.',
  'Call (555) 123-4567 before 9:30, then pay ¥1,200 or €5.50, a -5°C morning, 50% off.',
  '吾輩は猫である。名前はまだ無い。どこで生まれたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。',
  '「こんにちは」と彼は言った。（注：これは例です。）「ッ」「ー」や小さな「ゃ」「ょ」は行頭に来ない。',
  '日本語とEnglishの混在、123円（税込）です。Wi-Fi、USB-C、3.5mmジャック、100％対応。',
  '我们今天去公园玩，天气很好！你觉得怎么样？“好的，”他说，“我们走吧。”',
  '대한민국은 민주공화국이다. 대한민국의 주권은 국민에게 있고, 모든 권력은 국민으로부터 나온다.',
  'สวัสดีครับ ผมชื่อสมชาย ยินดีที่ได้รู้จักครับ 100 บาท ๑๒๓',
  'שלום עולם, זה טקסט בעברית - עם מקף. مرحبا بالعالم، هذا نص عربي.',
  'Hello 👋🏽 world 👨‍👩‍👧‍👦 flags 🇯🇵🇺🇸🇫🇷🇩🇪 and ❤️ plus 😀😀😀 end.',
  'line one\nline two\r\nline three\rline four\n\n\nafter blanks  and  double  spaces ',
  'zero​width​ space​ ​ after, no⁠break and non breaking spaces, soft­hyphen.',
  '**強調**。`code`、[リンク](https://example.com/日本語)。![画像](a.png)「引用」',
  'x'.repeat(120),
  'a-b-c d–e—f g‐h i‑j k…l m‥n',
  'é à́ ア́ $́ 1́ ́start ‍zwj-first',
  '１２３，４５６．７８ ＡＢＣ ａｂｃ　全角スペース　です',
  '𝐀𝐁𝐂 𠀀𠀁𠀂 \u{1F600}\u{1F3FB} \u{E0001}\u{E0100}',
  'a\uD800b \uDC00 c\uD83D \uDE00😀 end\uD800',
  '1.5 2,000 3/4 5-6 (7) [8] $9 10% 11° 12‰ 1:30 a.b c,d e;f g!h i?j',
  'word1 (word2) [word3] {word4} <word5> "word6" \'word7\' «word8» “word9”',
]

/** Hand-picked traps and the degenerate inputs. */
const EDGES: readonly string[] = [
  '',
  'a',
  ' ',
  '\n',
  '\r\n',
  '\r\r\n',
  '‍',
  '́',
  '‍a',
  '́́a',
  '  ́',
  'a ́',
  '\ńb',
  '​́',
  '​ ​a',
  '\uD800',
  '\uDC00\uD800',
  '😀',
  '🇯🇵🇺🇸🇫🇷',
  '🇯🇵́🇺🇸',
  '🇯‍🇵🇺',
  'a(b ー（c 〜（d 〈e a〈b a（b 1（b',
  '1) a) 1)2 )1 (1 -1 $-1 $(1 (1$ 1,0 1.0 1/0 1,000.00%',
  'ー。ぁ、っ ゠〜 ゝゞ',
]

const codePointsOf = (text: string) => Array.from(text, (ch) => ch.codePointAt(0) ?? 0)

/** One digest per leading representative, over every ordered pair that follows it. */
function tripleDigests(reps: readonly number[]): DigestRecord[] {
  return reps.map((a, k) => {
    const digest = new Digest()
    for (const b of reps) for (const c of reps) feedAnswer(digest, [a, b, c])
    return { kind: 'digest', c: 'triples', k, n: reps.length * reps.length, h: digest.value }
  })
}

function mixedDigests(alpha: readonly number[]): DigestRecord[] {
  const records: DigestRecord[] = []
  for (let k = 0; k < MIXED.count / MIXED.chunk; k += 1) {
    const digest = new Digest()
    const strings = mixedChunk(alpha, k)
    for (const text of strings) feedAnswer(digest, text)
    records.push({ kind: 'digest', c: 'mixed', k, n: strings.length, h: digest.value })
  }
  return records
}

function censusDigests(): DigestRecord[] {
  const records: DigestRecord[] = []
  for (const [name, around] of [
    ['census-kanji', [KANJI, KANJI]],
    ['census-latin', LATIN],
  ] as const) {
    for (let k = 0; k <= LAST_CODE_POINT >> 12; k += 1) {
      const range = censusRange(k)
      if (range === null) continue
      const digest = new Digest()
      for (let cp = range[0]; cp <= range[1]; cp += 1)
        feedAnswer(digest, [around[0], cp, around[1]])
      records.push({ kind: 'digest', c: name, k, n: range[1] - range[0] + 1, h: digest.value })
    }
  }
  return records
}

function rawClassDigests(): DigestRecord[] {
  const records: DigestRecord[] = []
  for (let k = 0; k <= LAST_CODE_POINT / RAW_BLOCK; k += 1) {
    const digest = new Digest()
    const end = Math.min((k + 1) * RAW_BLOCK - 1, LAST_CODE_POINT)
    for (let cp = k * RAW_BLOCK; cp <= end; cp += 1) digest.feed(rawClass(cp))
    records.push({ kind: 'digest', c: 'raw', k, n: end - k * RAW_BLOCK + 1, h: digest.value })
  }
  return records
}

export function recording(): OracleRecord[] {
  const reps = representatives()
  const alpha = alphabet(reps)
  const meta: MetaRecord = {
    kind: 'meta',
    version: '2.1.0',
    reps,
    alphabet: alpha,
    mixed: MIXED,
    kanji: KANJI,
    latin: [...LATIN],
  }
  return [
    meta,
    ...EDGES.map((text) => textRecord('edge', codePointsOf(text))),
    ...REAL_TEXT.map((text) => textRecord('real', codePointsOf(text))),
    ...reps.flatMap((a) => reps.map((b) => textRecord('pairs', [a, b]))),
    ...tripleDigests(reps),
    ...mixedDigests(alpha),
    ...censusDigests(),
    ...rawClassDigests(),
  ]
}

/**
 * The code points of census block `k` (`cp >> 12`): everything from U+0020 to
 * U+1FFFF and the tag block, the planes whose classes are not one default.
 */
function censusRange(k: number): [number, number] | null {
  const first = k * CENSUS_BLOCK
  const last = first + CENSUS_BLOCK - 1
  if (k <= 0x1f) return [Math.max(first, 0x20), last]
  if (k === 0xe0) return [0xe0000, 0xe01ff]
  return null
}
