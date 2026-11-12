import type { MdastFlowContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { selectMarkdownSection } from '../../layout/nodes/mdast-section.js'

/**
 * Inputs and answers of `selectMarkdownSection`, the part of a document a
 * `#fragment` names. An answer is the half-open range of the root's blocks it
 * keeps, or null, so the replay compares which blocks and not a copy of them.
 */
export interface SectionRecord {
  readonly id: string
  readonly root: MdastRoot
  readonly fragment: string
  readonly range: readonly [number, number] | null
}

const text = (value: string) => ({ type: 'text' as const, value })
const heading = (depth: 1 | 2 | 3 | 4 | 5 | 6, ...title: string[]): MdastFlowContent => ({
  type: 'heading',
  depth,
  children: title.map(text),
})
const para = (value: string): MdastFlowContent => ({ type: 'paragraph', children: [text(value)] })
const root = (...children: MdastFlowContent[]): MdastRoot => ({ type: 'root', children })

const TITLES = [
  'Intro',
  'intro',
  'INTRO',
  'Setup',
  'Usage',
  'İstanbul',
  'ΟΔΟΣ',
  'Straße',
  'a b',
  ' padded ',
]

const DOCS: readonly (readonly [string, MdastRoot])[] = [
  ['flat', root(heading(1, 'Intro'), para('a'), heading(1, 'Setup'), para('b'))],
  [
    'nested',
    root(
      heading(1, 'Top'),
      para('t'),
      heading(2, 'Sub'),
      para('s'),
      heading(3, 'Deep'),
      para('d'),
      heading(2, 'Sub2'),
      para('s2'),
      heading(1, 'Next'),
      para('n'),
    ),
  ],
  ['duplicate', root(heading(2, 'Same'), para('1'), heading(2, 'Same'), para('2'))],
  ['case', root(para('lead'), heading(2, 'Mixed Case'), para('x'))],
  ['shallower-stops', root(heading(3, 'Low'), para('x'), heading(2, 'High'), para('y'))],
  ['deeper-kept', root(heading(2, 'Low'), heading(3, 'Deeper'), heading(4, 'Deepest'), para('z'))],
  [
    'inline-title',
    root(
      {
        type: 'heading',
        depth: 2,
        children: [
          text('A '),
          { type: 'strong', children: [text('bold')] },
          { type: 'inlineCode', value: ' code' },
          { type: 'link', url: 'u', children: [text(' link')] },
        ],
      },
      para('x'),
    ),
  ],
  ['no-heading', root(para('a'), para('b'))],
  ['empty', root()],
  ['title-spaces', root(heading(1, '  Padded  '), para('x'))],
  [
    'unicode',
    root(
      heading(1, 'İstanbul'),
      para('x'),
      heading(1, 'ΟΔΟΣ'),
      para('y'),
      heading(1, 'Straße'),
      para('z'),
    ),
  ],
  ['last', root(para('lead'), heading(1, 'End'))],
]

const FRAGMENTS = [
  'Intro',
  'intro',
  'INTRO',
  'Setup',
  'Sub',
  'Deep',
  'Same',
  'mixed case',
  'MIXED CASE',
  'Low',
  'A bold code link',
  'a bold code link',
  'Padded',
  '  Padded',
  '',
  '   ',
  'missing',
  'istanbul',
  'İSTANBUL',
  'ισοδοσ',
  'οδος',
  'ΟΔΟΣ',
  'straße',
  'STRASSE',
  'End',
  'a b',
]

function rangeOf(
  source: MdastRoot,
  picked: MdastRoot | undefined,
): readonly [number, number] | null {
  const first = picked?.children[0]
  if (picked === undefined || first === undefined) return null
  const start = source.children.indexOf(first)
  return [start, start + picked.children.length]
}

/** mulberry32: a recorded fixture's generator; the seed rides the file's first line. */
export const SECTION_SEED = 0x5ec7_10c5
export const SECTION_GENERATED = 300

function* rng(seed: number): Generator<number> {
  let a = seed
  for (;;) {
    a = (a + 0x6d2b_79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    yield ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function sectionInputs(): readonly Omit<SectionRecord, 'range'>[] {
  const out: Omit<SectionRecord, 'range'>[] = []
  for (const [name, doc] of DOCS) {
    for (const [n, fragment] of FRAGMENTS.entries())
      out.push({ id: `hand/${name}/${n}`, root: doc, fragment })
  }
  const stream = rng(SECTION_SEED)
  const next = () => stream.next().value as number
  for (let n = 0; n < SECTION_GENERATED; n += 1) {
    const blocks: MdastFlowContent[] = []
    for (let i = 0, count = 1 + Math.floor(next() * 9); i < count; i += 1) {
      const title = TITLES[Math.floor(next() * TITLES.length)] as string
      blocks.push(next() < 0.6 ? heading((1 + Math.floor(next() * 4)) as 1, title) : para(title))
    }
    const fragment = TITLES[Math.floor(next() * TITLES.length)] as string
    out.push({
      id: `gen/${n}`,
      root: root(...blocks),
      fragment: next() < 0.5 ? fragment : fragment.toUpperCase(),
    })
  }
  return out
}

export function sectionAnswer(input: Omit<SectionRecord, 'range'>): SectionRecord {
  return { ...input, range: rangeOf(input.root, selectMarkdownSection(input.root, input.fragment)) }
}
