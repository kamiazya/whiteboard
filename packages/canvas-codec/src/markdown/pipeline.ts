import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { mdastRootSchema } from '@kamiazya/whiteboard-canvas-model/mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import type { Plugin } from 'unified'
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
 * `$]`). This plugin adds an unconditional `$`-in-phrasing pattern so a
 * bare `$` is always escaped regardless of adjacency. Safe to remove once
 * mdast-util-math drops the stray `after` key upstream.
 */
const remarkEscapeDollarInPhrasing: Plugin<[]> = function remarkEscapeDollarInPhrasing() {
  const data = this.data() as Record<string, unknown>
  const extensions = (data.toMarkdownExtensions as unknown[] | undefined) ?? []
  data.toMarkdownExtensions = extensions
  extensions.push({ unsafe: [{ character: '$', inConstruct: 'phrasing' }] })
}

const stringifier = unified()
  .use(remarkStringify)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkEscapeDollarInPhrasing)

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

export function stringifyMarkdownBody(root: MdastRoot): string {
  const remarkTree = toRemarkRoot(root)
  // `toRemarkRoot`'s return type is this package's own narrow `RemarkNode`
  // shape (see to-remark.ts), not remark's own `Root` type — the same
  // untyped-boundary crossing `fromRemarkRoot(tree as never)` above makes
  // in the opposite direction.
  return String(stringifier.stringify(remarkTree as never)).trimEnd()
}
