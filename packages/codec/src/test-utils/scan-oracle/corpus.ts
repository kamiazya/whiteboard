/**
 * The inputs of the reference-scanner oracle: what `scanReferences` and
 * `findNextReference` answer, which the Rust port (`whiteboard-codec`'s
 * `references::find_next_reference`) is held to. Hand-written cases reach each
 * arm of the grammar and each way an opener fails to close; a seeded stream
 * of bracket-dense token strings covers their interleavings; the long inputs
 * are the shapes the scan's linear bound is argued from. All pure, so the
 * recording can be checked against what these produce today.
 */

/** xorshift32: the stream a recording is regenerated from, so it never moves with the engine. */
function stream(seed: number): () => number {
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

export const SEED = 0x2c1b3c6d
export const RANDOM_COUNT = 1500

export type Input = { i: string; t: string }

/** Where a reference is found, and where the grammar refuses one. */
const EXAMPLES: readonly string[] = [
  '',
  'no brackets at all',
  '[[a]]',
  '![[a]]',
  '!![[a]]',
  '[[ a ]]',
  '[[a b/c.md]]',
  'before [[a]] between ![[b]] after',
  '[[a]][[b]]![[c]]',
  '[[a]]]',
  '[[[a]]]',
  '[[[a]]',
  '[[a|b]]',
  '![[a|b]]',
  '[[a|]]',
  '[[a||b]]',
  '[[a|b|c]]',
  '[[a|b]c]]',
  '[[a|b[c]]',
  '[[a|b',
  '[[a|b]',
  '[[a|b] x ]]',
  '[[a#h]]',
  '[[a#h#i]]',
  '[[a#]]',
  '[[a##]]',
  '[[a#|b]]',
  '[[a#h|b]]',
  '![[a#Group label|alias]]',
  '[[#h]]',
  '[[#]]',
  '[[#h]] [[a]]',
  '[[]]',
  '[[|a]]',
  '[[|]]',
  '![[]]',
  '[[',
  '[[[[',
  '![[',
  '[[a',
  '[[a]',
  '[[a] and [[b]]',
  '[[a]b]]',
  '[[a]b]] [[c]]',
  '[[a [[b]]',
  '[[a[[b]]',
  '[[a|b [[c]]',
  '[[a|b [[c]] d]]',
  '[ [a]]',
  '[[a] ]',
  '[[a]\n]',
  '[[a\nb]]',
  '[[a|b\nc]]',
  '[[a\r\n|b]]',
  '\\[[a]]',
  '\\[\\[a]]',
  '[[a\\]]]',
  '`[[a]]`',
  '```\n[[a]]\n```',
  '    [[a]]',
  '> [[a]]',
  '- ![[a|b]]',
  '[x]([[a]])',
  '[[a]](b)',
  '[[[[a]]]]',
  '![[![[a]]]]',
  '[[a|![[b]]]]',
  '[[日本語]]',
  '[[日本語#見出し|別名]]',
  '日本[[a]]語![[b]]本',
  '[[café|é]]',
  '\u{1f600}[[\u{1f600}]]\u{1f600}',
  '![[\u{1f600}#\u{1f600}|\u{1f600}]]',
  '\u{1f600}![[a]]',
  '[[a\u0000b]]',
  '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]',
  '![[01ARZ3NDEKTSV4RRFFQ69G5FAV#Launch|the launch]]',
  '[[a]] [[a]] [[a]]',
  '!',
  '!!',
  ']]',
  '|',
  '#',
  '[[#|]]',
  '[[a|]] [[|b]]',
  '[[a]|b]]',
  '[[a|b]|c]]',
]

const TOKENS: readonly string[] = [
  '[[',
  ']]',
  '[',
  ']',
  '!',
  '![[',
  '|',
  '#',
  'a',
  'b c',
  'h',
  'é',
  '日本',
  '\u{1f600}',
  ' ',
  '\n',
  '\\',
  '`',
  '[[a]]',
  '![[b#c|d]]',
]

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

/** The shapes the scan's linear bound is argued from: an opener that never closes, over and over. */
function longInputs(): Input[] {
  const n = 5000
  return [
    { i: 'l0', t: `${'[['.repeat(n)}[[x]]` },
    { i: 'l1', t: `${'[[a'.repeat(n)}]]` },
    { i: 'l2', t: `${'[[a]'.repeat(n)}[[b]]` },
    { i: 'l3', t: `${'[[#'.repeat(n)}[[c]]` },
    { i: 'l4', t: `${'a'.repeat(4 * n)}[[b|c]]` },
    { i: 'l5', t: `[[${'a'.repeat(4 * n)}` },
    { i: 'l6', t: `[[a|${'b'.repeat(4 * n)}` },
    { i: 'l7', t: `${'![[a|b]]'.repeat(500)}` },
    { i: 'l8', t: `${'[[a|b'.repeat(n)}]]` },
    { i: 'l9', t: `${'日本[['.repeat(n)}x]]` },
  ]
}

export const inputs = (): Input[] => [
  ...EXAMPLES.map((t, n) => ({ i: `e${n}`, t })),
  ...randomStrings(),
  ...longInputs(),
]
