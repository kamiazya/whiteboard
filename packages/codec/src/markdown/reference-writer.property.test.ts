import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import {
  canonicalUlidArbitrary,
  referenceFragmentArbitrary,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { resolveReferences } from '../references/resolve.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { normalizeMdast } from './normalize.js'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

// `]` and `|` are the reference grammar's own delimiters, so an alias holding
// one is an encoding ambiguity of the grammar rather than something the
// writer can preserve. A blank line ends the paragraph the reference sits in.
// `@`, `:` and `www` are what GFM's literal autolinks key on: text that reads
// as an address becomes a link on the next parse wherever it is written, a
// limit of the writer for every text value that this property does not chase.
const AUTOLINK_TRIGGER = /[@:]|www/i
const MARKDOWN_ATOMS = [
  '*',
  '_',
  '`',
  '[',
  '(',
  '!',
  '&',
  '\\',
  '~',
  '$',
  '<',
  '#',
  '>',
  'a',
  ' ',
  '\n',
]
const aliasTextArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 10, unit: 'grapheme' }),
  fc
    .array(fc.constantFrom(...MARKDOWN_ATOMS), { minLength: 1, maxLength: 8 })
    .map((a) => a.join('')),
)
const aliasArbitrary = fc.option(
  aliasTextArbitrary.filter(
    (s) =>
      !/[\]|]/.test(s) && !/\n[ \t]*\n/.test(s) && !/^\s|\s$/.test(s) && !AUTOLINK_TRIGGER.test(s),
  ),
  { nil: undefined },
)
const fragmentArbitrary = referenceFragmentArbitrary.filter(
  (fragment) => fragment === undefined || !AUTOLINK_TRIGGER.test(fragment),
)

const referenceNodeArbitrary = fc.oneof(
  fc
    .tuple(canonicalUlidArbitrary, aliasArbitrary, fragmentArbitrary)
    .map(([documentId, alias, fragment]) => ({
      type: 'wikiLink' as const,
      documentId,
      alias,
      ...(fragment === undefined ? {} : { fragment }),
    })),
  fc.tuple(canonicalUlidArbitrary, fragmentArbitrary).map(([documentId, fragment]) => ({
    type: 'embed' as const,
    documentId,
    ...(fragment === undefined ? {} : { fragment }),
  })),
)

// Letters only: a `!` left at the end of a text run would fuse with a
// following `[[` into an embed marker, which is the text/embed ambiguity of
// the syntax itself rather than a writer fault.
const wordArbitrary = fc
  .stringMatching(/^[a-z]+( [a-z]+)?$/)
  .map((value) => ({ type: 'text' as const, value }))

const phrasingRunArbitrary = fc
  .array(fc.oneof(wordArbitrary, referenceNodeArbitrary), { minLength: 1, maxLength: 6 })
  .filter((run) => run.some((node) => node.type !== 'text'))

function blockArbitrary(): fc.Arbitrary<MdastRoot['children'][number]> {
  return fc.oneof(
    phrasingRunArbitrary.map((children) => ({ type: 'paragraph' as const, children })),
    phrasingRunArbitrary.map((children) => ({
      type: 'blockquote' as const,
      children: [{ type: 'paragraph' as const, children }],
    })),
    phrasingRunArbitrary.map((children) => ({
      type: 'list' as const,
      ordered: false,
      spread: false,
      children: [
        {
          type: 'listItem' as const,
          spread: false,
          children: [{ type: 'paragraph' as const, children }],
        },
      ],
    })),
  ) as fc.Arbitrary<MdastRoot['children'][number]>
}

const rootArbitrary = fc
  .array(blockArbitrary(), { minLength: 1, maxLength: 3 })
  .map((children): MdastRoot => ({ type: 'root', children }))

// Text as a parse produces it: the reference syntax is plain text there, and
// writing it back must leave it exactly as it was. Tokens mix the syntax with
// the characters that decide how markdown reads what is around it.
const sourceTokenArbitrary = fc.constantFrom(
  '[[x]]',
  '![[img.png]]',
  '[[a#b|c d]]',
  '[[a b]]',
  '[[',
  ']]',
  '[',
  ']',
  '(u)',
  '*',
  '_',
  '`',
  '|',
  '#',
  '!',
  'word',
  ' ',
)

// Two rich inline nodes side by side (`*a*_b_` reads back as one emphasis
// holding `a**b`: CommonMark's rule of three) and one nested directly in
// another (`*_a_*` is written `**a**`, which reads back as strong) are
// ambiguities of the markdown writer for any text, the same class
// round-trip.property.test.ts caps at one rich node per run — so a body whose
// parse holds either shape is not this property's.
const INLINE_CONTAINERS = new Set(['emphasis', 'strong', 'delete', 'link'])
function holdsAShapeTheWriterCannotKeep(node: { type?: string; children?: unknown[] }): boolean {
  if (!Array.isArray(node.children)) return false
  const children = node.children as { type?: string; children?: unknown[] }[]
  const rich = children.filter((child) => child.type !== 'text')
  if (node.type !== 'root' && rich.length > 1) return true
  if (INLINE_CONTAINERS.has(node.type ?? '') && rich.length > 0) return true
  return children.some(holdsAShapeTheWriterCannotKeep)
}

const sourceBodyArbitrary = fc
  .array(sourceTokenArbitrary, { minLength: 1, maxLength: 10 })
  .map((tokens) => tokens.join(''))
  .filter((body) => body.trim() === body && /\[\[[^\]|]+(\|[^\]]*)?\]\]/.test(body))
  .filter((body) => !holdsAShapeTheWriterCannotKeep(parseMarkdownBody(body)))

describe('the writer keeps reference syntax readable', () => {
  fcTest(
    'the generator leaves the rule-of-three and nested-emphasis shapes to the markdown writer',
    () => {
      expect(holdsAShapeTheWriterCannotKeep(parseMarkdownBody('*[[x]]*_[[x]]_'))).toBe(true)
      expect(holdsAShapeTheWriterCannotKeep(parseMarkdownBody('*_[[x]]_*[[x]]'))).toBe(true)
      expect(holdsAShapeTheWriterCannotKeep(parseMarkdownBody('[[x]] *a* [[y]]'))).toBe(false)
    },
  )

  fcTest.prop([rootArbitrary], withDefaults({ numRuns: 60 }))(
    'resolveReferences(parse(stringify(x))) equals x for typed wikiLink and embed nodes',
    (root) => {
      const written = stringifyMarkdownBody(root)
      const back = resolveReferences(parseMarkdownBody(written))
      expect(normalizeMdast(back)).toEqual(normalizeMdast(root))
    },
  )

  fcTest.prop([sourceBodyArbitrary], withDefaults({ numRuns: 80 }))(
    'a body holding reference syntax as text reads back as the same text after a write',
    (body) => {
      const parsed = parseMarkdownBody(body)
      const reparsed = parseMarkdownBody(stringifyMarkdownBody(parsed))
      expect(normalizeMdast(reparsed)).toEqual(normalizeMdast(parsed))
    },
  )
})
