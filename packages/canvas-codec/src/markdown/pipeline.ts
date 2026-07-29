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
const stringifier = unified().use(remarkStringify).use(remarkGfm).use(remarkMath)

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
  return String(stringifier.stringify(remarkTree)).trimEnd()
}
