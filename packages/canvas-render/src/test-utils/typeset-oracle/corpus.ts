import { readFileSync } from 'node:fs'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { TEXT_WRAPPING_CORPUS } from '../text-wrapping-corpus.js'
import { f64Hex, isBlockEmbed, type ThemeName, type TypesetInput } from './oracle.js'

/**
 * The inputs of `typeset.jsonl`. Only the blocks the Rust typesetter carries
 * so far (a paragraph, a heading) are drawn from the corpora; a later slice
 * widens the filter, and the recorded file grows with it.
 */

type Block = Extract<MdastFlowContent, { type: 'paragraph' | 'heading' }>
const t = (value: string): MdastPhrasingContent => ({ type: 'text', value })
const p = (...children: MdastPhrasingContent[]): Block => ({ type: 'paragraph', children })
const h = (depth: 1 | 2 | 3 | 4 | 5 | 6, ...children: MdastPhrasingContent[]): Block => ({
  type: 'heading',
  depth,
  children,
})
const em = (...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'emphasis',
  children,
})
const strong = (...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'strong',
  children,
})
const del = (...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'delete',
  children,
})
const code = (value: string): MdastPhrasingContent => ({ type: 'inlineCode', value })
const link = (url: string, ...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'link',
  url,
  children,
})

const ID = '01HZX3Q8K9V2M4N5P6R7S8T9WA'
const ID2 = '01HZX3Q8K9V2M4N5P6R7S8T9WB'
const ID3 = '01HZX3Q8K9V2M4N5P6R7S8T9WC'
const ID4 = '01HZX3Q8K9V2M4N5P6R7S8T9WD'

const JA =
  'これは日本語の長い文章です。ノードの幅を超えても折り返されるべきですが、実際にどうなるかを測ります。'
const LONG_EN =
  'This is a fairly long English sentence that should wrap across several lines when the box is narrow.'

/** One block per case, aimed at one rule each. */
const HAND: readonly (readonly [string, readonly Block[]])[] = [
  ['empty-paragraph', [p()]],
  ['blank-text', [p(t('   '))]],
  ['en', [p(t(LONG_EN))]],
  ['ja', [p(t(JA))]],
  ['zh', [p(t('这是一段很长的中文文本，应该在节点的宽度处换行。'))]],
  ['ko', [p(t('한국어로 쓰인 아주 긴 문장은 어디에서 줄바꿈이 되어야 합니다.'))]],
  ['mixed', [p(t('この API は canvas-render の layoutMdastBlocks を呼び出します。'))]],
  ['url', [p(t('https://example.com/very/long/path/that/never/breaks/anywhere/at/all'))]],
  ['token', [p(t('SupercalifragilisticexpialidociousAndThenSomeMoreCharacters'))]],
  ['emoji-cluster', [p(t('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦 and 🇯🇵🇯🇵🇯🇵 and é́́́'))]],
  ['padded', [p(t('  leading and trailing spaces   '), strong(t(' bold ')), t(' tail  '))]],
  ['tabs-newlines', [p(t('a\tb\n\nc   d e　f'))]],
  ['styles', [p(t('plain '), em(t('em '), strong(t('both '), del(t('all')))), t(' end'))]],
  ['strong-long', [p(strong(t(LONG_EN)), em(t(LONG_EN)))]],
  ['code-atomic', [p(t('Run '), code('fn(a, b, c, d, e, f, g, h, i, j, k, l, m, n)'), t(' now'))]],
  ['code-ja-kinsoku', [p(t('これは日本語です'), code('layout'), t('。つづきの文があります。'))]],
  [
    'strong-ja-kinsoku',
    [p(t('これは日本語です'), strong(t('強調')), t('。つづきの文があります。'))],
  ],
  ['code-en-stop', [p(t('Run the '), code('fit'), t('. Then it continues.'))]],
  ['code-then-paren', [p(t('a'), code('b'), t(')'), t('c'), code('d'), t('、e'))]],
  ['html-inline', [p(t('a '), { type: 'html', value: '<span class="x" data-y="z">' }, t('b'))]],
  [
    'math-inline',
    [p(t('where '), { type: 'inlineMath', value: 'a + b + c + d + e + f + g + h' }, t(' holds'))],
  ],
  [
    'break',
    [
      p(
        t('one'),
        { type: 'break' },
        t('two two two'),
        { type: 'break' },
        { type: 'break' },
        t('end'),
      ),
    ],
  ],
  ['link', [p(t('see '), link('https://example.com/x', t('the docs for it')), t(' now'))]],
  [
    'link-title',
    [
      p(
        { type: 'link', url: 'u', title: 'T', children: [t('a')] },
        { type: 'link', url: 'v', title: '', children: [t('b')] },
      ),
    ],
  ],
  ['link-nested', [p(link('u', strong(t('bold')), t(' and '), code('c')))]],
  [
    'linkref',
    [
      p(
        { type: 'linkReference', identifier: 'ref', referenceType: 'full', children: [t('text')] },
        { type: 'linkReference', identifier: 'bare', referenceType: 'shortcut', children: [] },
      ),
    ],
  ],
  [
    'imageref',
    [
      p(
        { type: 'imageReference', identifier: 'i1', referenceType: 'full', alt: 'an alt' },
        { type: 'imageReference', identifier: 'i2', referenceType: 'full' },
      ),
    ],
  ],
  [
    'wiki',
    [
      p(
        t('go to '),
        { type: 'wikiLink', documentId: ID },
        t(' and '),
        { type: 'wikiLink', documentId: ID2, alias: 'the alias' },
        t(' and '),
        { type: 'wikiLink', documentId: ID3, fragment: 'Part' },
        { type: 'wikiLink', documentId: ID4, alias: '', fragment: '' },
      ),
    ],
  ],
  [
    'embed-inline',
    [
      p(t('before '), { type: 'embed', documentId: ID }, t(' after '), {
        type: 'embed',
        documentId: ID2,
        fragment: 'Sec',
      }),
    ],
  ],
  ['embed-with-text', [p({ type: 'embed', documentId: ID3 }, t(' tail'))]],
  [
    'image-alt',
    [
      p(
        t('a '),
        { type: 'image', url: 'https://example.com/a.png', alt: 'alt text here' },
        t(' b'),
      ),
    ],
  ],
  [
    'image-noalt',
    [
      p(
        t('a '),
        { type: 'image', url: 'https://example.com/a.png' },
        { type: 'image', url: 'data:image/png;base64,AAAA', alt: '' },
        t(' b'),
      ),
    ],
  ],
  [
    'image-relative',
    [p({ type: 'image', url: 'pics/a.png', alt: 'rel' }, { type: 'image', url: 'pics/b.png' })],
  ],
  ['figure-a', [p({ type: 'image', url: 'fig-a-1', alt: 'one' })]],
  [
    'figure-b',
    [
      p({ type: 'image', url: 'fig-b-22', alt: 'two' }),
      p(t(' '), { type: 'image', url: 'fig-c-3' }, t('  ')),
    ],
  ],
  [
    'figure-d',
    [
      p({ type: 'image', url: 'fig-d-4' }),
      p({ type: 'image', url: 'fig-e-5' }),
      p({ type: 'image', url: 'fig-f-6' }),
      p({ type: 'image', url: 'fig-g-7' }),
    ],
  ],
  ['emoji', [p(t('ship it :rocket: and :smile: :not_a_thing: :+1:'))]],
  ['icon', [p(t('star :icon-star: here :icon-check:'), t(':icon-star:'), t(' tail'))]],
  ['icon-emoji', [p(t(':rocket: :icon-star: :smile:'))]],
  ['icon-ja', [p(t('日本語:icon-star:。'), t('終わり'))]],
  ['h1', [h(1, t('A heading that is rather long for a narrow box'))]],
  ['h2-then-p', [p(t('first')), h(2, t('Second '), em(t('part'))), p(t('after'))]],
  ['h3-h6', [h(3, t('three')), h(4, t('four')), h(5, t('five')), h(6, t('six'))]],
  ['h-first', [h(1, t('leading'))]],
  ['h-ja', [h(2, t('日本語の見出しはここ')), p(t(JA))]],
  ['heading-code', [h(2, code('some_identifier_name'), t(' reference'))]],
  ['atomic-wide', [p(code('x'.repeat(200)))]],
  ['atomic-grapheme', [p(code('👨‍👩‍👧‍👦'.repeat(30)))]],
  ['atomic-html-wide', [p({ type: 'html', value: `<a href="${'z'.repeat(150)}">` })]],
  ['math-wide', [p({ type: 'inlineMath', value: 'x'.repeat(200) })]],
  ['code-padded', [p(code('abcdefghijklmnopqrstuvwxyz'), code('abcdefghijklmnopqrstuvwxyz'))]],
  ['ja-budoux', [p(t('今日は天気がいいので、散歩に行きましょう。明日は雨が降るでしょう。'))]],
  ['ja-emoji', [p(t('これは😀日本語の文章です😀。😀😀😀そして👍続きます'))]],
  ['kana-latin', [p(t('Hello こんにちは World です。'))]],
  ['quote-marks', [p(t('「かぎ括弧」（丸括弧）『二重』と【隅付き】を使った文章です。'))]],
  ['wide-char', [p(t('a'.repeat(100)))]],
  ['spaces-only-line', [p(t('a'), { type: 'break' }, t('  '), { type: 'break' }, t('b'))]],
  ['leading-break', [p({ type: 'break' }, t('x'))]],
]

const WIDTHS = [40, 96, 160, 280, 600]
const EXTREME: readonly (readonly [string, number])[] = [
  ['huge', 1e9],
  ['zero', 0],
  ['negative', -1],
  ['infinity', Number.POSITIVE_INFINITY],
  ['nan', Number.NaN],
  ['tiny', 1],
  ['fraction', 33.3],
]
const THEME_CYCLE: readonly ThemeName[] = ['node', 'document', 'compact']

let counter = 0
function input(id: string, blocks: readonly Block[], width: number, digest: boolean): TypesetInput {
  counter += 1
  return {
    id,
    root: { type: 'root', children: [...blocks] },
    width: f64Hex(width),
    theme: THEME_CYCLE[counter % 3] as ThemeName,
    fill: counter % 2 === 0 ? '#1f2328' : null,
    digest,
  }
}

/** mulberry32: a recorded fixture's generator, its seed written to the `meta` record. */
export const GENERATED_SEED = 0x7e57_5e7a
export const GENERATED_COUNT = 600

function* rng(seed: number): Generator<number> {
  let a = seed
  for (;;) {
    a = (a + 0x6d2b_79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    yield ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'x',
  'canvas-render',
  'a/b/c',
  'wrap',
  'q',
  'ünï',
  '👍',
  'é',
  'https://example.com/path/to',
  '(paren)',
  '"quoted"',
  '-dash-',
]
const CJK = [
  '日本語',
  'これは',
  '文章です',
  '。',
  '、',
  '「',
  '」',
  'テスト',
  '中文',
  '한국어',
  '（',
  '）',
  'ー',
  'っ',
]
const SPECIAL = [' ', '  ', ':rocket:', ':icon-star:', ':smile:', ' ', '\t', ' - ', '...']

function generatedInline(next: () => number, depth: number): MdastPhrasingContent[] {
  const pick = <T>(pool: readonly T[]): T => pool[Math.floor(next() * pool.length)] as T
  const count = 1 + Math.floor(next() * 5)
  const out: MdastPhrasingContent[] = []
  for (let i = 0; i < count; i += 1) {
    const kind = next()
    if (kind < 0.45 || depth > 2) {
      const parts = 1 + Math.floor(next() * 7)
      let text = ''
      for (let j = 0; j < parts; j += 1) {
        const pool = next() < 0.5 ? WORDS : next() < 0.7 ? CJK : SPECIAL
        text += `${pick(pool)}${next() < 0.55 ? ' ' : ''}`
      }
      out.push(t(text))
    } else if (kind < 0.55) out.push(code(pick(WORDS) + pick(CJK)))
    else if (kind < 0.62) out.push(em(...generatedInline(next, depth + 1)))
    else if (kind < 0.69) out.push(strong(...generatedInline(next, depth + 1)))
    else if (kind < 0.73) out.push(del(...generatedInline(next, depth + 1)))
    else if (kind < 0.8)
      out.push(link(`u${Math.floor(next() * 5)}`, ...generatedInline(next, depth + 1)))
    else if (kind < 0.84) out.push({ type: 'break' })
    else if (kind < 0.88)
      out.push({
        type: 'wikiLink',
        documentId: pick([ID, ID2, ID3, ID4]),
        ...(next() < 0.4 ? { alias: pick(WORDS) } : {}),
        ...(next() < 0.3 ? { fragment: pick(WORDS) } : {}),
      })
    else if (kind < 0.91) out.push({ type: 'embed', documentId: pick([ID, ID2, ID3, ID4]) })
    else if (kind < 0.95)
      out.push({
        type: 'image',
        url: pick(['i1', 'i2', 'https://e.com/x.png', 'rel/p.png']),
        ...(next() < 0.5 ? { alt: pick(WORDS) } : {}),
      })
    else if (kind < 0.97) out.push({ type: 'html', value: `<${pick(WORDS)}>` })
    else out.push({ type: 'inlineMath', value: `${pick(WORDS)}+${pick(WORDS)}` })
  }
  return out
}

function generated(): TypesetInput[] {
  const stream = rng(GENERATED_SEED)
  const next = () => stream.next().value as number
  return Array.from({ length: GENERATED_COUNT }, (_, n) => {
    const children = generatedInline(next, 0)
    // A paragraph that is only an embed is a block embed, which a later slice carries.
    if (children.length === 1 && children[0]?.type === 'embed') children.push(t('.'))
    const block: Block =
      next() < 0.25 ? h((1 + Math.floor(next() * 6)) as 1, ...children) : p(...children)
    const width = [30, 64, 120, 200, 330, 800][Math.floor(next() * 6)] as number
    return input(`gen/${n}`, [block], width, true)
  })
}

const blocksOf = (root: MdastRoot): Block[] =>
  root.children.filter(
    (block): block is Block =>
      (block.type === 'paragraph' || block.type === 'heading') && !isBlockEmbed(block),
  )

function walkBlocks(nodes: readonly MdastFlowContent[], out: Block[]): void {
  for (const node of nodes) {
    if (node.type === 'paragraph' || node.type === 'heading') {
      if (!isBlockEmbed(node)) out.push(node)
    } else if (node.type === 'blockquote') walkBlocks(node.children, out)
    else if (node.type === 'list') for (const item of node.children) walkBlocks(item.children, out)
  }
}

/**
 * Paragraphs and headings of the markdown parser's oracle corpus: the
 * CommonMark and GFM examples, the dialect cases and the repository's own
 * documents, parsed by today's `parseMarkdownBody`. Read at record time only;
 * the recording holds the trees.
 */
function harvested(): TypesetInput[] {
  const file = new URL('../../../../codec/src/markdown/oracle/mdast.jsonl', import.meta.url)
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  const out: TypesetInput[] = []
  let docs = 0
  for (const line of lines) {
    const record = JSON.parse(line) as { i?: string; t?: string }
    if (record.i === undefined || record.t === undefined) continue
    const wanted =
      /^(cm#|gfm#|d\d|cv)/.test(record.i) || (/^md:/.test(record.i) && docs++ % 3 === 0)
    if (!wanted) continue
    const blocks: Block[] = []
    walkBlocks(parseMarkdownBody(record.t).children, blocks)
    blocks.slice(0, 3).forEach((block, n) => {
      const width = WIDTHS[(out.length + n) % WIDTHS.length] as number
      out.push(input(`md/${record.i}/${n}`, [block], width, true))
    })
  }
  return out
}

export function typesetInputs(withHarvest: boolean): readonly TypesetInput[] {
  counter = 0
  const named: TypesetInput[] = []
  for (const [name, blocks] of HAND) {
    for (const width of WIDTHS) named.push(input(`hand/${name}@${width}`, blocks, width, false))
  }
  for (const [name, blocks] of HAND.slice(0, 20)) {
    for (const [label, width] of EXTREME)
      named.push(input(`hand/${name}@${label}`, blocks, width, false))
  }
  for (const c of TEXT_WRAPPING_CORPUS) {
    const blocks = blocksOf(c.root)
    if (blocks.length === 0) continue
    for (const width of [40, 64, 96, 160, 280])
      named.push(input(`wrap/${c.name}@${width}`, blocks, width, false))
  }
  return [...named, ...generated(), ...(withHarvest ? harvested() : [])]
}
