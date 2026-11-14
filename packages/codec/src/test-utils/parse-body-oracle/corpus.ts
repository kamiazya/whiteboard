import { DIALECT, stream } from '../mdast-oracle/corpus.js'

/**
 * The inputs of the parse-body oracle: what `resolveReferences` makes of a
 * parsed body, which the Rust port (`whiteboard-codec`'s `references`) is held
 * to. Hand-written cases for every arm of the reference grammar and of the
 * walk over the tree, the mdast oracle's dialect cases, and a seeded stream of
 * token strings dense in brackets. All pure, so the recording can be checked
 * against what these produce today.
 */

export const SEED = 0x85ebca6b
export const RANDOM_COUNT = 2000

const DOC = '01HZX3Q8K9V2M4N5P6R7S8T9WA'
const BOARD = '01HZX3Q8K9V2M4N5P6R7S8T9WB'

/**
 * What every case resolves an alias through. An alias that names no row stays
 * literal text; a row may answer an id that is not a ULID, which is used as
 * written. A key spelled like a ULID is never asked: the id reading wins.
 */
export const ALIASES: Readonly<Record<string, string>> = {
  doc: DOC,
  board: BOARD,
  Page: '01HZX3Q8K9V2M4N5P6R7S8T9WC',
  'img.png': '01HZX3Q8K9V2M4N5P6R7S8T9WD',
  'a/b/c': '01HZX3Q8K9V2M4N5P6R7S8T9WE',
  Doc: '01HZX3Q8K9V2M4N5P6R7S8T9WF',
  Canvas: '01HZX3Q8K9V2M4N5P6R7S8T9WG',
  a: '01HZX3Q8K9V2M4N5P6R7S8T9WH',
  b: '01HZX3Q8K9V2M4N5P6R7S8T9WJ',
  ' ': '01HZX3Q8K9V2M4N5P6R7S8T9WK',
  日本: '01HZX3Q8K9V2M4N5P6R7S8T9WM',
  weird: 'not-a-ulid',
  '01hzx3q8k9v2m4n5p6r7s8t9wa': '01HZX3Q8K9V2M4N5P6R7S8T9WN',
  '81HZX3Q8K9V2M4N5P6R7S8T9WA': '01HZX3Q8K9V2M4N5P6R7S8T9WP',
  [BOARD]: DOC,
}

/** The grammar's arms, and the walk's: where a reference is read and where it is not. */
const REFERENCES: readonly string[] = [
  `[[${DOC}]]`,
  `![[${DOC}]]`,
  `[[${DOC}#frag|label]]`,
  `![[${BOARD}#group label]]`,
  '[[01hzx3q8k9v2m4n5p6r7s8t9wa]]',
  '[[81HZX3Q8K9V2M4N5P6R7S8T9WA]]',
  `[[${DOC}X]]`,
  '[[doc]]',
  '![[board]]',
  '[[missing]]',
  '![[missing]]',
  '[[weird]]',
  '[[日本]]',
  '[[doc|]]',
  '[[doc#]]',
  '[[doc#|label]]',
  '[[#frag]]',
  '[[#]]',
  '[[doc#a#b]]',
  '[[doc|a|b]]',
  '[[doc|a]b]]',
  '[[doc|a]]]',
  '[[doc]b]] [[board]]',
  '!![[doc]]',
  '![![[doc]]',
  '[[[doc]]]',
  '[[[[doc]]',
  '[[doc]]]',
  '[[a[[b]]',
  '[[a[[b]c [[doc]]',
  '[[a|x[[y|z]w [[doc]]',
  'x![[doc]]y',
  '[[doc]][[board]]![[doc]]',
  'a [[missing]] b [[doc]] c',
  '[[doc]] *[[board]]* **[[missing]]** ~~[[doc]]~~ [x [[doc]]](u)',
  '[x](u "[[doc]]")',
  '![[[doc]]](u)',
  '[[[doc]]](u)',
  '[[doc]]: u\n\n[[doc]]',
  '[doc]: u\n\n[[doc]]',
  '[doc]: u\n\n[x][doc] [[doc]][]',
  '<https://e.x/[[doc]]>',
  '\\[[doc]]',
  '[[doc\\|x]]',
  '[[d&#111;c]]',
  '[[do\nc]]',
  '[[doc  \nx]]',
  '[[doc\\\nx]]',
  '日本[[doc]]語',
  '# [[doc]]\n\nSetext [[board]]\n---',
  '> [[doc]]\n> > ![[board]]',
  '- [[doc]]\n  - [ ] ![[board]]\n- [x] [[missing]]',
  '1. a\n\n   [[doc]]\n2. b',
  '| [[doc]] | b |\n|---|:-:|\n| ![[board]] | `[[doc]]` |',
  '`[[doc]]` ``x [[doc]]``',
  '```\n[[doc]]\n```',
  '    [[doc]]',
  '$[[doc]]$\n\n$$\n[[doc]]\n$$',
  '<div>[[doc]]</div>\n\n<span>[[doc]]</span> [[doc]]',
  'x[^1]\n\n[^1]: [[doc]] and ![[board]]',
  '[^n]:\n    [[doc]]\n\n    [[board]]',
  '[[doc]]\r\n[[board]]\r\n',
  '',
  ' ',
  '[[',
  ']]',
  '![[',
  '[[ ]]',
  '[[a]] and [[b]]',
  '[['.repeat(3000),
  '[[#'.repeat(2000),
  '[[a|'.repeat(2000),
  `${'[[x]'.repeat(1500)}[[doc]]`,
  `${'*'.repeat(70)}[[doc]]${'*'.repeat(70)}`,
  `${'> '.repeat(30)}[[doc]]`,
  '~~a**~~x**~~ [[doc]]',
]

/** Emphasis `levels` deep around a reference: the converter flattens a container at depth 64. */
const nested = (levels: number): string => `${'*a '.repeat(levels)}[[doc]]${' b*'.repeat(levels)}`

/** Every kind of node with a string of its own, which a flattened subtree keeps. */
const VALUED = '`code` $math$ <b>html</b> [[doc]]'

/** Each side of the flattening depth, in each place a body nests phrasing. */
const DEEP: readonly string[] = [
  ...[61, 62, 63, 64].flatMap((levels) => [
    nested(levels),
    `- ${nested(levels - 1)}`,
    `| h |\n|---|\n| ${nested(levels - 2)} |`,
    `x[^1]\n\n[^1]: ${nested(levels - 1)}`,
  ]),
  `${'*a '.repeat(63)}${VALUED}${' b*'.repeat(63)}`,
  // A list item's blocks sit two levels under the list: 32 lists, the most the parser opens, put them past 64.
  ...[31, 32].flatMap((lists) => [
    `${'- '.repeat(lists)}*x* ${VALUED}`,
    `${'1. '.repeat(lists)}x\n\n${'   '.repeat(lists)}${VALUED}`,
  ]),
  // A footnote of several blocks reads as their text joined, each kind's own string kept.
  `x[^1]\n\n[^1]: ${VALUED}\n\n    \`\`\`js\n    fenced\n    \`\`\`\n\n    $$\n    display\n    $$\n\n    <div>block</div>`,
]

/** Tokens dense in the grammar's characters, without the autolink and emoji shapes the two parsers read apart. */
const TOKENS: readonly string[] = [
  '[[doc',
  '[[board]]',
  '![[doc]]',
  '|x]]',
  '#f',
  '[[',
  ']]',
  '![[',
  '[',
  ']',
  '!',
  '|',
  '#',
  'doc',
  'board',
  'a',
  'x',
  DOC,
  '日',
  ' ',
  '\n',
  '\n\n',
  '*',
  '**',
  '`',
  '\\',
  '- ',
  '> ',
  '# ',
  '(u)',
  '~~',
  '$',
]

export type Input = { i: string; t: string }

function randomStrings(): Input[] {
  const next = stream(SEED)
  const out: Input[] = []
  for (let n = 0; n < RANDOM_COUNT; n++) {
    const length = 1 + Math.floor(next() * 30)
    let text = ''
    for (let j = 0; j < length; j++) text += TOKENS[Math.floor(next() * TOKENS.length)]
    out.push({ i: `r${n}`, t: text })
  }
  return out
}

export function inputs(): Input[] {
  const label = (prefix: string, texts: readonly string[]): Input[] =>
    texts.map((t, n) => ({ i: `${prefix}${n}`, t }))
  return [
    ...label('g', REFERENCES),
    ...label('n', DEEP),
    ...label('d', DIALECT),
    ...randomStrings(),
  ]
}
