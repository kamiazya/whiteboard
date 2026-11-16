import { readdirSync, readFileSync, statSync } from 'node:fs'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'

/**
 * The markdown bodies the document recordings lay out: hand-written ones
 * reaching every block kind and every reference shape, the repository's own
 * user docs and product skills, and the boundary bodies of ADR-0054 S18's D7
 * (nesting and delimiter runs either side of the core parser's bounds, and a
 * body either side of the stored-body cap). Read at record time only; a
 * record holds its body.
 */

const fence = (lang: string, value: string) => `\`\`\`${lang}\n${value}\n\`\`\``

export const HAND_BODIES: readonly (readonly [string, string])[] = [
  ['empty', ''],
  ['blank lines', '\n\n   \n'],
  [
    'every block',
    '# Title\n\nA paragraph with **bold**, _emphasis_, ~~struck~~ and `code`.\n\n> quoted *text*\n\n---\n\n- one\n- two\n  1. nested\n  2. second\n\n- [x] done\n- [ ] todo\n\n| a | b | c |\n|:--|:-:|--:|\n| 1 | **2** | 3 |\n| ~~4~~ | [x](https://example.com) | `5` |\n\n<div>raw html</div>\n\nHello\\\nhard break',
  ],
  [
    'headings',
    '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nSetext\n===\n\nAnd two\n---',
  ],
  [
    'code fences',
    `${fence('ts', 'const a: number = 1 // c\nfunction f(x) { return "s" + x }')}\n\n${fence('json', '{"a": [1, 2.5, null], "b": true}')}\n\n${fence('', 'no language')}\n\n${fence('nonesuch', 'an unknown language')}\n\n    indented code`,
  ],
  [
    'math and diagrams',
    `$$\nx^2 + y^2\n$$\n\nand inline $a+b$ too\n\n${fence('mermaid', 'graph TD\n  A --> B')}\n\n${fence('math', 'x^2 + y^2')}\n\n$$\n\\frac{1}{2}\n$$\n\n$$\n\\sum\n$$\n\n${fence('mermaid', 'sequenceDiagram\n  A->>B: hi')}`,
  ],
  [
    'cjk',
    '# 見出し\n\n日本語の文章です。句読点、括弧（かっこ）や「かぎ括弧」を含む長い段落が、幅に合わせて折り返されることを確かめます。\n\n中文段落，用于测试换行与标点符号的处理。\n\n한국어 문단도 줄바꿈을 확인합니다.\n\nMixed 日本語 and English in one 行 with `code` and **太字**.',
  ],
  [
    'long tokens',
    'an-unbreakable-token-ThatKeepsGoingAndGoingAndGoingPastTheWidthOfAnyColumn and https://example.com/a/very/long/url/that/does/not/break/anywhere/at/all?query=string&more=yes',
  ],
  ['shortcodes', 'Launch :rocket: and :tada:, an icon :star: and an unknown :nonesuch: code.'],
  [
    'links',
    'See [[Some Page]], [[Some Page|an alias]], [[D-BOARD]], [[missing]], [[Unknown Target]], [[note#Part two]] and [text](https://example.com "title").\n\n[ref]: https://example.com',
  ],
  ['embeds', '![[note]]\n\n![[board]]\n\n![[Board Alias]]'],
  ['themed embeds', '![[sketch]]\n\n![[legend]]'],
  [
    'embed parts',
    '![[note#Part two]]\n\n![[board#Group A]]\n\n![[named]]\n\n![[empty-board]]\n\n![[missing]]',
  ],
  ['self embed', 'Top\n\n![[self]]'],
  ['deep embeds', '![[deep-1]]'],
  [
    'images',
    '![a picture](pic.png)\n\n![wide](wide.png)\n\n![gone](gone)\n\n![remote](https://example.com/i.png)',
  ],
  [
    'nesting',
    '> quote\n>\n> > nested quote\n> >\n> > - list in a quote\n> >   - deeper\n\n1. one\n   > quote in a list\n2. two\n   ```ts\n   const inList = true\n   ```',
  ],
  [
    'wide table',
    `| ${Array.from({ length: 9 }, (_, i) => `column ${i}`).join(' | ')} |\n|${'---|'.repeat(9)}\n| ${Array.from({ length: 9 }, (_, i) => 'cell '.repeat(i + 1).trim()).join(' | ')} |`,
  ],
  [
    'html and entities',
    '<details><summary>More</summary>\n\nInside\n\n</details>\n\n&copy; &amp; &#x1F600; &nbsp;',
  ],
  ['footnote', 'A claim.[^1]\n\n[^1]: The source.'],
]

/** A paragraph of `runs` emphasised words: the core parser's bound on delimiter runs sits at 1,024. */
const emphasised = (runs: number) => Array.from({ length: runs }, (_, i) => `*w${i}*`).join(' ')

/** The boundary bodies, each just inside and just past a bound. */
export const BOUNDARY_BODIES: readonly (readonly [string, string])[] = [
  ['quote 32 deep', `${'> '.repeat(32)}deep`],
  ['quote 33 deep', `${'> '.repeat(33)}deep`],
  ['list 39 deep', Array.from({ length: 39 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n')],
  ['list 40 deep', Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n')],
  ['1024 delimiter runs', emphasised(1024)],
  ['1100 delimiter runs', emphasised(1100)],
]

const LINE = 'The quick brown fox jumps over the lazy dog, 日本語も少し。\n\n'

/** A body of exactly `chars` UTF-16 units of prose. */
const prose = (chars: number) => LINE.repeat(Math.ceil(chars / LINE.length)).slice(0, chars)

/** Bodies at and past the stored body cap, held as a digest: their scenes run to megabytes. */
export const CAP_BODIES: readonly (readonly [string, string])[] = [
  ['at the body cap', prose(MARKDOWN_MAX_CHARS)],
  ['past the body cap', prose(MARKDOWN_MAX_CHARS + 1)],
]

const REPO = new URL('../../../../../', import.meta.url)

function markdownUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, REPO)).sort()) {
      const path = `${rel}/${name}`
      if (statSync(new URL(path, REPO)).isDirectory()) walk(path)
      else if (name.endsWith('.md')) out.push(path)
    }
  }
  walk(dir)
  return out
}

/** The user docs and product skills, by repository path. */
export function repositoryBodies(): (readonly [string, string])[] {
  return [...markdownUnder('docs'), ...markdownUnder('skills')].map(
    (path) => [path, readFileSync(new URL(path, REPO), 'utf8')] as const,
  )
}
