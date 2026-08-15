import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { mdastRootSchema } from '@kamiazya/whiteboard-canvas-model/mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { fromRemarkRoot } from './from-remark.js'
import { toRemarkRoot } from './to-remark.js'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

/**
 * mdast-util-math registers a toMarkdown `unsafe` pattern for `$` with an
 * `after: undefined` key. mdast-util-to-markdown's `safe()` matches patterns
 * by `'after' in pattern` rather than checking the value is defined, so it
 * treats that as a real "look at what follows" constraint, evaluates it
 * against `undefined`, and the match silently fails — dropping the escape
 * for a `$` that sits next to another escaped character (e.g. link text
 * `$]`). Seeding an unconditional `$`-in-phrasing pattern here keeps a bare
 * `$` always escaped regardless of adjacency (the remark plugins push into
 * this same array at freeze). Safe to remove once mdast-util-math drops the
 * stray `after` key upstream.
 */
const stringifier = unified()
  .use(remarkStringify)
  .use(remarkGfm)
  .use(remarkMath)
  .data('toMarkdownExtensions', [{ unsafe: [{ character: '$', inConstruct: 'phrasing' }] }])

/**
 * Closed syntax set: CommonMark + GFM (tables/strikethrough/task lists) +
 * math ($..$ / $$..$$). `[[wikiLink]]`/`![[embed]]` are NOT parsed here —
 * they have no remark syntax extension in this package; resolving them from
 * plain text is `references.ts`'s job, applied as a separate pass over the
 * already-parsed MdastRoot.
 */
export function parseMarkdownBody(body: string): MdastRoot {
  const tree = parser.parse(body)
  const converted = fromRemarkRoot(tree as never)
  return mdastRootSchema.parse(converted)
}

/**
 * Start line (1-based) of each TOP-LEVEL block in `body`, in document
 * order — index-aligned with `parseMarkdownBody(body).children`, because
 * `fromRemarkRoot` maps root children 1:1 with no filtering. Source
 * positions deliberately never enter the model (they would break the
 * round-trip properties: serialized text has different positions); this
 * sidecar is the one place they surface, for consumers that correlate
 * source lines with laid-out blocks (the preview's scroll sync). Total: a
 * body remark cannot position defaults each block to its index order.
 */
export function parseMarkdownBlockLines(body: string): number[] {
  const tree = parser.parse(body) as {
    children?: { position?: { start?: { line?: number } } }[]
  }
  return (tree.children ?? []).map((child, index) => child.position?.start?.line ?? index + 1)
}

export function stringifyMarkdownBody(root: MdastRoot): string {
  const remarkTree = toRemarkRoot(root)
  // `toRemarkRoot`'s return type is this package's own narrow `RemarkNode`
  // shape (see to-remark.ts), not remark's own `Root` type — the same
  // untyped-boundary crossing `fromRemarkRoot(tree as never)` above makes
  // in the opposite direction.
  return String(stringifier.stringify(remarkTree as never)).trimEnd()
}
