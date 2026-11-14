/**
 * The generated half of the mdast oracle's inputs: hand-written dialect cases,
 * hostile families, a seeded stream of random token strings, and inputs past
 * the Rust parser's bounds. All pure, so the recorded copy can be checked
 * against what these produce today. The other half (repository documents, the
 * CommonMark and GFM spec examples) is frozen data in the recording itself.
 */

/** Ids starting with this are past a bound of the Rust parser, which refuses them. */
export const PAST_BOUND_PREFIX = 'b'

export const SEED = 0x9e3779b9
export const RANDOM_COUNT = 3000

const TOKENS: readonly string[] = [
  '*',
  '**',
  '***',
  '_',
  '__',
  '~',
  '~~',
  '`',
  '``',
  '$',
  '$$',
  '[',
  ']',
  '(',
  ')',
  '![',
  '](',
  ')',
  '<',
  '>',
  '&amp;',
  '&#x41;',
  '&#0;',
  '&bogus;',
  '&nbsp;',
  '\\',
  '\\*',
  '\n',
  '\n\n',
  '    ',
  '\t',
  '- ',
  '* ',
  '+ ',
  '1. ',
  '2) ',
  '> ',
  '# ',
  '## ',
  '|',
  ' | ',
  '|---|',
  '---',
  '===',
  ' ',
  '  \n',
  'a',
  'foo',
  'b c',
  '日本語',
  '漢字',
  '。',
  '「',
  '」',
  '、',
  '한국어',
  '😀',
  '[[Page]]',
  '![[img.png]]',
  '[[a|b]]',
  '[[Doc#h]]',
  ':smile:',
  ':+1:',
  '<div>',
  '</div>',
  '<!-- c -->',
  '<span>',
  '</span>',
  '<br>',
  'http://x.y/z',
  'https://a.b',
  'www.example.com',
  'a@b.co',
  '[^1]',
  '[^1]: note',
  '- [ ] ',
  '- [x] ',
  '[x]: /u "t"',
  '$$\n',
  '\n$$',
  '```\n',
  '\n```',
  '~~~js\n',
  '\\(',
  '\\[',
  '\\$',
  ' ',
  '​',
  '\r\n',
]

/** xorshift32: the stream a recording is regenerated from, so it never moves with the engine. */
export function stream(seed: number): () => number {
  let s = seed
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 2 ** 32
  }
}

export type Input = { i: string; t: string }

function randomStrings(): Input[] {
  const next = stream(SEED)
  const out: Input[] = []
  for (let n = 0; n < RANDOM_COUNT; n++) {
    const length = 1 + Math.floor(next() * 40)
    let text = ''
    for (let j = 0; j < length; j++) text += TOKENS[Math.floor(next() * TOKENS.length)]
    out.push({ i: `r${n}`, t: text })
  }
  return out
}

function inlineFamilies(): string[] {
  const fam: string[] = []
  const words = ['日本語', '「引用」', '漢字。', '（括弧）', '한국어', 'テスト', '中文：']
  for (const w of words) {
    for (const m of ['*', '**', '_', '__', '~~', '~']) {
      fam.push(`${m}${w}${m}です`, `これは${m}${w}${m}です`, `a${m}${w}${m}b`, `${m}${w}${m}`)
    }
  }
  for (const m of ['$', '$$']) {
    fam.push(`${m}a${m}`, `x ${m}a+b${m} y`, `${m} a ${m}`, `${m}a`, `a${m}b${m}c`, `\\${m}a${m}`)
    fam.push(`${m}\n${m}`, `${m}${m}${m}`, '$1 and $2', 'costs $5 or $10')
  }
  fam.push('$$\na\n$$', '$$ meta\nx\n$$', '  $$\n  x\n  $$', '> $$\n> x\n> $$', '- $$\n  x\n  $$')
  fam.push('$$\nunclosed', '$$x$$', '$$$\nx\n$$$')
  for (const r of [
    '[[Page]]',
    '![[img.png]]',
    '[[a|b]]',
    '[[Doc#h|alias]]',
    '[[a]][[b]]',
    '[[ [x] ]]',
    '[[*x*]]',
    '![[a|100]]',
    '[[a]](url)',
    '[[a]]: /def',
  ]) {
    fam.push(r, `text ${r} more`, `- ${r}`, `| ${r} |\n|---|\n| x |`)
  }
  return fam
}

function entityAndHtmlFamilies(): string[] {
  const fam: string[] = []
  for (const e of [
    '&amp;',
    '&copy;',
    '&#35;',
    '&#X22;',
    '&#xD800;',
    '&#1234567;',
    '&ThisIsNotDefined;',
    '&hellip;',
    '&nbsp;&nbsp;',
  ]) {
    fam.push(e, `[${e}](/u)`, `\`${e}\``, `[l](/u "${e}")`)
  }
  fam.push(
    '<div>\n*a*\n</div>',
    '<div>\n\n*a*\n\n</div>',
    '<pre>\n**x**\n</pre>',
    '<!--\nx\n-->',
    '<?php x ?>',
  )
  fam.push(
    '<![CDATA[x]]>',
    '<x-y a="b">',
    'a <b>c</b> d',
    '<a href="x">*y*</a>',
    '</p>',
    '<script>\nalert(1)\n</script>',
  )
  return fam
}

function blockFamilies(): string[] {
  const fam: string[] = []
  for (let d = 1; d <= 70; d += 7) {
    // Past 32 nested containers is the Rust parser's refusal; those are `pastBound`'s.
    if (d <= 32) fam.push(`${'>'.repeat(d)} x`, `${'- '.repeat(d)}x`)
    fam.push(
      `${'*'.repeat(d)}x${'*'.repeat(d)}`,
      `${'['.repeat(d)}x${']'.repeat(d)}`,
      `${'  '.repeat(d)}- x`,
    )
  }
  fam.push(
    '- a\n- b\n\n- c',
    '1. a\n1. b',
    '3) x',
    '- a\n\n  b',
    '- [ ] a\n- [x] b\n- [X] c',
    '* [ ]',
  )
  fam.push('- [ ]  ', '- [x]\tb', '1. [x] a', '> - [ ] a')
  fam.push('| a | b |\n|:-|-:|\n| 1 | 2 |', '| a |\n|---|\n| `|` |', '| a | b |\n|---|---|\n| 1 |')
  fam.push('a|b\n-|-\nc|d', '| a |\n| - |\n| b \\| c |', '|a|\n|:-:|\n|*x*|')
  fam.push(
    'www.a.com.',
    'http://a.b/(c)',
    'https://x.y/z?a=b&c=d.',
    'mail a@b.c.',
    'x@y',
    '<http://a.b>',
  )
  fam.push('<a@b.c>', 'www.a_b.com', 'http://a.b/~c', 'foo@bar.baz_')
  return fam
}

function referenceFamilies(): string[] {
  const fam: string[] = []
  fam.push(
    '[^a]\n\n[^a]: b',
    '[^a]: b\n    c',
    'x[^1]y\n\n[^1]: *z*\n\n    para2',
    '[^ a]',
    '^[inline]',
  )
  fam.push('***a**b*', '*a **b***', '**a*b*c**', '_a_b_', '*a*b*', 'a**"b"**', '**a**b', '~~a~~~')
  fam.push('~a~~', '~~~a~~~', 'a~b~c', '*`a*`', '**[a**](u)')
  fam.push('[a](<b c>)', '[a](b "t")', "[a](b 't')", '[a](b (t))', '![a *b*](c)', '[a]\n\n[a]: /x')
  fam.push('[A]\n\n[a]: /x', '[a][]', '[a][b]\n\n[b]: /c', '[ẞ]\n\n[SS]: /x')
  fam.push('# h #', '#\th', 'h\n===', 'h\n---', '   ### x', '#5', '####### x')
  fam.push(
    '```js meta=1\nx\n```',
    '``` \nx\n```',
    '````\n```\n````',
    '~~~\nx',
    '    code\n\n    more',
    '\tcode',
  )
  fam.push('a  \nb', 'a\\\nb', 'a\nb', 'a\r\nb', 'a\rb', '\u0000x', 'a b')
  return fam
}

const families = (): string[] => [
  ...inlineFamilies(),
  ...entityAndHtmlFamilies(),
  ...blockFamilies(),
  ...referenceFamilies(),
]

/**
 * What the layout does with text the parser leaves alone: the wiki-link and
 * embed syntax and the emoji shortcodes are read from TEXT nodes after the
 * parse, so the parser's whole contract is that it leaves them as text.
 */
export const DIALECT: readonly string[] = [
  '[[Page]]',
  '![[img.png]]',
  '[[a/b/c]]',
  '[[Doc#Heading]]',
  '[[Doc#Heading|alias]]',
  '[[Canvas#Group label]]',
  '![[Doc#h]]',
  '![[a|100]]',
  '[[a]] and [[b]]',
  '[[a]]\n\n[[b]]',
  '# Title [[Page]]',
  '> quote [[Page]]',
  '- item [[Page]]\n- ![[img.png]]',
  '1. [[a]]\n2. [[b]]',
  '| h |\n|---|\n| [[Page]] |',
  '| h |\n|---|\n| ![[img.png]] |',
  '**[[Page]]**',
  '*![[img.png]]*',
  '[[Page]](https://example.com)',
  '[label]([[Page]])',
  '`[[Page]]`',
  '```\n[[Page]]\n```',
  '$[[Page]]$',
  '[[Page',
  'Page]]',
  '[[]]',
  '[[ ]]',
  '[[a\nb]]',
  '[[a]]b',
  'a[[b]]',
  ':smile: and :+1: and :not_a_code',
  '**:smile:**',
  '[:smile:](u)',
  '`:smile:`',
  'x[^1]\n\n[^1]: note [[Page]]',
  '- [ ] todo [[Page]]\n- [x] done ![[img.png]]',
  '[ref]: https://example.com\n\n[[Page]] [ref]',
  '<a>[[Page]]</a>',
  '\\[[Page]]',
  '[[Page\\]]',
]

/** Past a bound of the Rust parser: the TypeScript reads each, flattening or not as it does. */
function pastBound(): string[] {
  const nested = [36, 43, 50, 57, 64].flatMap((d) => [`${'>'.repeat(d)} x`, `${'- '.repeat(d)}x`])
  return [
    ...nested,
    `${'> '.repeat(40)}x`,
    `${'*a '.repeat(600)}x${'b* '.repeat(600)}`,
    `${'*a '.repeat(1100)}`,
    `${'_a '.repeat(1100)}`,
  ]
}

export function generated(): Input[] {
  const label = (prefix: string, texts: readonly string[]): Input[] =>
    texts.map((t, n) => ({ i: `${prefix}${n}`, t }))
  return [
    ...randomStrings(),
    ...label('f', families()),
    ...label('d', DIALECT),
    ...label(PAST_BOUND_PREFIX, pastBound()),
  ]
}
