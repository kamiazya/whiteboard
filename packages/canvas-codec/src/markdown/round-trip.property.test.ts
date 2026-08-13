import { mdastFlowContentArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, hasNoEmptyContainer, withDefaults } from '../test-utils/fast-check.js'
import { normalizeMdast } from './normalize.js'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

// Bounded to depth 2 and excludes a few node kinds with known markdown-syntax
// round-trip limitations that are out of scope for this property (each is a
// real markdown limitation, not a normalizeMdast bug):
// - 'list'/'table': mdast-util-to-markdown picks bullet/tight-vs-loose
//   formatting heuristically, and re-parsing does not always recover the
//   exact `ordered`/`spread` combination the source tree started with.
// - 'definition'/'linkReference'/'imageReference': CommonMark link labels
//   must contain a non-whitespace character and are matched by normalized
//   (case-folded/whitespace-collapsed) identifier; a standalone generated
//   tree has no guarantee its identifier is reference-able the same way
//   after a real parse, independent of any information loss.
const EXCLUDED_ROUND_TRIP_TYPES = new Set([
  'list',
  'table',
  'definition',
  'linkReference',
  'imageReference',
])

function hasNoExcludedDescendant(node: any): boolean {
  if (node === null || typeof node !== 'object') return true
  // An empty `$$` has no unambiguous parse as inline math (indistinguishable
  // from a bare `$$` delimiter pair / block-math opener) — a real markdown
  // syntax limitation for this degenerate value, not a normalization gap.
  if (node.type === 'inlineMath' && typeof node.value === 'string' && node.value.trim() === '') {
    return false
  }
  // wikiLink/embed intentionally stringify to plain bracket-literal text
  // here (see to-remark.ts) — resolving them back into typed nodes is
  // references.ts's job (a separate pass over already-parsed content, with
  // its own round-trip coverage), not this pipeline's.
  if (node.type === 'wikiLink' || node.type === 'embed') return false
  // A hard line `break` only round-trips when followed by more content on
  // the next line; one at the tail of an inline run (nothing after it
  // before the run closes) has no next line to break onto and collapses to
  // plain whitespace on re-parse — a real markdown-syntax boundary case
  // this property's arbitrary can't reliably avoid except by excluding it.
  if (node.type === 'break') return false
  // An empty text leaf inside an inline wrapper (emphasis/strong/delete)
  // produces an empty delimiter run (e.g. `**`) that re-parses as literal
  // text rather than an empty emphasis node — another real markdown
  // round-trip edge case at the "no actual content" boundary.
  // An empty inline span (empty text/inlineCode/html) has no visible content
  // between its delimiters and re-parses as literal delimiter text instead
  // of the intended node kind. Block-level `code`/`math` fences are exempt:
  // their triple-backtick/dollar fence renders regardless of body content,
  // so an empty value there genuinely round-trips (see normalize.ts's
  // dedicated meta-canonicalization tests for that case).
  if (
    (node.type === 'text' || node.type === 'inlineCode') &&
    typeof node.value === 'string' &&
    node.value.trim() === ''
  ) {
    return false
  }
  // A raw-HTML node only round-trips when its `value` is actual HTML syntax
  // (e.g. a real tag) — the model arbitrary generates arbitrary strings for
  // this field, most of which are not HTML and re-parse as plain text.
  // Excluded here as an arbitrary-generation limitation, not a codec bug.
  if (node.type === 'html') return false
  // GFM strikethrough's delimiter-run flanking rules (CommonMark emphasis
  // rules, reused by remark-gfm for `~~`) depend on the exact characters
  // adjacent to `~~` — e.g. an image node starting with `!` can shift
  // whether `~~` is left/right-flanking. Getting this right in a generator
  // needs the same flanking-rule logic remark implements internally, which
  // is out of scope for this property; excluded here.
  if (node.type === 'delete') return false
  // linkReference/imageReference match a `definition` elsewhere in the same
  // document by normalized identifier; a standalone generated node has no
  // such definition, so it re-parses as literal bracket text instead —
  // same class of limitation as excluding 'definition' itself above.
  if (node.type === 'linkReference' || node.type === 'imageReference') return false
  // 'list'/'table'/'definition' are excluded (see the module-level comment)
  // wherever they occur, not only at the arbitrary's top level — they can
  // equally be generated as a nested child (e.g. inside a blockquote).
  if (EXCLUDED_ROUND_TRIP_TYPES.has(node.type)) return false
  if (Array.isArray(node.children)) {
    // Two adjacent delimiter-fenced spans of the same kind (inlineCode's
    // backtick run, inlineMath's `$`) serialize with nothing disambiguating
    // them when their delimiter lengths coincide (the common case for short
    // generated values) and can re-parse as one merged span — a real
    // encoding ambiguity mdast-util-to-markdown does not always escape
    // around, not something normalizeMdast can canonicalize away without
    // knowing the exact delimiter length picked.
    const ADJACENCY_SENSITIVE_TYPES = new Set(['inlineCode', 'inlineMath'])
    for (let i = 1; i < node.children.length; i += 1) {
      const prevType = node.children[i - 1]?.type
      if (prevType === node.children[i]?.type && ADJACENCY_SENSITIVE_TYPES.has(prevType)) {
        return false
      }
    }
    // CommonMark's emphasis/strong delimiter-run "flanking" rules (which GFM
    // delete/strikethrough reuses) decide how adjacent `*`/`**`/`~~` runs
    // nest based on the exact characters on either side. Reproducing that
    // logic correctly in a generator would mean re-implementing remark's own
    // tokenizer; instead this property caps each phrasing run at one
    // non-text ("rich") inline node, sidestepping the whole adjacency class
    // rather than chasing individual flanking-rule counterexamples. `text`
    // runs are exempt (mergeAdjacentText already canonicizes those).
    const richChildCount = node.children.filter(
      (child: { type?: string }) => child?.type !== 'text',
    ).length
    if (richChildCount > 1) return false
    return node.children.every(hasNoExcludedDescendant)
  }
  return true
}

/**
 * A literal backslash in text is excluded, and this one is an upstream
 * DEFECT rather than an encoding ambiguity like the exclusions above.
 *
 * `mdast-util-to-markdown`'s `safe()` makes a character safe one of two
 * ways: ASCII punctuation gets a backslash escape, anything else gets a
 * character reference. On the reference branch it flushes the text before
 * the position with `escapeBackslashes(value.slice(start, position), '\\')`
 * — a HARDCODED `after`, which is not what actually follows. What follows
 * is the reference it is about to push, whose first character is `&`. A
 * backslash before `&` is an escape, so a trailing backslash that needed no
 * escaping of its own silently becomes one:
 *
 *     text '\\A' next to emphasis-wrapped math
 *       -> serialized  \&#x41;
 *       -> re-parsed   text '&#x41;'
 *
 * `markdown-backslash-round-trip.test.ts` pins that exact behaviour, so
 * this exclusion disappears the moment upstream stops doing it. Excluded
 * here rather than in canvas-model's shared arbitrary because the totality
 * property has no problem with the same input.
 */
function hasNoBackslashText(node: { type?: string; value?: unknown; children?: unknown }): boolean {
  if (node?.type === 'text' && typeof node.value === 'string' && node.value.includes('\\')) {
    return false
  }
  return Array.isArray(node?.children)
    ? node.children.every((child) => hasNoBackslashText(child as { type?: string }))
    : true
}

function nonListFlowArbitrary(maxDepth: number) {
  return mdastFlowContentArbitrary(maxDepth)
    .filter((node) => !EXCLUDED_ROUND_TRIP_TYPES.has(node.type))
    .filter(hasNoEmptyContainer)
    .filter(hasNoExcludedDescendant)
    .filter(hasNoBackslashText)
}

const rootArbitrary = fc
  .array(nonListFlowArbitrary(2), { minLength: 1, maxLength: 4 })
  .map((children) => ({ type: 'root' as const, children }))

describe('markdown body round-trip property (modulo normalizeMdast)', () => {
  fcTest.prop([rootArbitrary], withDefaults({ numRuns: 100 }))(
    'normalizeMdast(parse(stringify(x))) === normalizeMdast(x)',
    (root) => {
      const text = stringifyMarkdownBody(root)
      const reparsed = parseMarkdownBody(text)
      expect(normalizeMdast(reparsed)).toEqual(normalizeMdast(root))
    },
  )
})
