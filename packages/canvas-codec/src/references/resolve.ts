import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-canvas-model/internal'

const CANVAS_ID_PREFIX = 'canvas:'

export type AliasResolver = (alias: string) => string | null

interface ReferenceMatch {
  /** Index of the match start (the `!` when present, otherwise the first `[`). */
  index: number
  /** Full matched text, e.g. `[[canvas:ID]]` or `![[target|alias]]`. */
  full: string
  isEmbed: boolean
  target: string
  alias: string | undefined
}

/**
 * Finds the next `[[...]]`/`![[...]]` occurrence at or after `cursor`, scanning
 * with `indexOf` instead of a regex. A quantified-class regex equivalent to
 * this grammar (`[^\]|]+` for the target, `[^\]]*` for the alias) is
 * super-linear on adversarial input: every `[[` that never finds a closing
 * `]]` forces a fresh forward scan to the end of the string, so a string of
 * N repeated `[[` costs O(N^2). This scan instead advances `cursor`
 * monotonically past everything it has already inspected, so each character
 * is visited a bounded number of times and the whole pass is O(n).
 */
function findNextReference(value: string, cursor: number): ReferenceMatch | undefined {
  let pos = cursor
  while (pos < value.length) {
    const openIndex = value.indexOf('[[', pos)
    if (openIndex === -1) return undefined

    const hasBang = openIndex > 0 && value[openIndex - 1] === '!'
    const matchStart = hasBang ? openIndex - 1 : openIndex
    const contentStart = openIndex + 2

    let i = contentStart
    while (i < value.length && value[i] !== ']' && value[i] !== '|') i++
    if (i >= value.length) return undefined // no `]`/`|` left anywhere -> no possible match remains

    const target = value.slice(contentStart, i)
    if (target.length === 0) {
      pos = contentStart
      continue
    }

    if (value[i] === ']') {
      if (value[i + 1] === ']') {
        return {
          index: matchStart,
          full: value.slice(matchStart, i + 2),
          isEmbed: hasBang,
          target,
          alias: undefined,
        }
      }
      pos = i + 1
      continue
    }

    let j = i + 1
    while (j < value.length && value[j] !== ']') j++
    if (j < value.length && value[j + 1] === ']') {
      const alias = value.slice(i + 1, j)
      return {
        index: matchStart,
        full: value.slice(matchStart, j + 2),
        isEmbed: hasBang,
        target,
        alias,
      }
    }
    pos = j + 1
  }
  return undefined
}

/**
 * Splits a plain-text node's value on `[[...]]`/`![[...]]` occurrences,
 * resolving each one independently. A leading `!` marks an embed
 * (transclusion) rather than a wikiLink — mirrors to-remark.ts's inverse
 * serialization (`wikiLink` -> `[[canvas:ID]]`, `embed` -> `![[canvas:ID]]`).
 * `[[canvas:ULID]]` always resolves directly (no resolver needed);
 * `[[alias]]` only resolves through the injected resolver — malformed refs
 * (an unresolved alias, or a `canvas:` target that isn't a valid ULID) stay
 * as literal text rather than being dropped.
 */
function splitTextReferences(
  value: string,
  resolver: AliasResolver | undefined,
): MdastPhrasingContent[] {
  const result: MdastPhrasingContent[] = []
  let lastIndex = 0
  let cursor = 0

  for (;;) {
    const match = findNextReference(value, cursor)
    if (match === undefined) break

    if (match.index > lastIndex) {
      result.push({ type: 'text', value: value.slice(lastIndex, match.index) })
    }

    const resolved = resolveTarget(match.target, match.alias, resolver, match.isEmbed)
    result.push(resolved ?? { type: 'text', value: match.full })

    lastIndex = match.index + match.full.length
    cursor = lastIndex
  }

  if (lastIndex < value.length) result.push({ type: 'text', value: value.slice(lastIndex) })
  return result.length > 0 ? result : [{ type: 'text', value }]
}

function resolveTarget(
  target: string,
  alias: string | undefined,
  resolver: AliasResolver | undefined,
  isEmbed: boolean,
): MdastPhrasingContent | undefined {
  if (target.startsWith(CANVAS_ID_PREFIX)) {
    const canvasId = target.slice(CANVAS_ID_PREFIX.length)
    if (!canvasIdSchema.safeParse(canvasId).success) return undefined
    return isEmbed ? { type: 'embed', canvasId } : { type: 'wikiLink', canvasId, alias }
  }

  if (resolver === undefined) return undefined
  const canvasId = resolver(target)
  if (canvasId === null) return undefined
  return isEmbed
    ? { type: 'embed', canvasId }
    : { type: 'wikiLink', canvasId, alias: alias ?? target }
}

function resolvePhrasing(
  node: MdastPhrasingContent,
  resolver: AliasResolver | undefined,
): MdastPhrasingContent[] {
  if (node.type === 'text') return splitTextReferences(node.value, resolver)
  if ('children' in node) {
    return [
      { ...node, children: node.children.flatMap((child) => resolvePhrasing(child, resolver)) },
    ]
  }
  return [node]
}

function resolveCellPhrasing(
  node: MdastCellPhrasingContent,
  resolver: AliasResolver | undefined,
): MdastCellPhrasingContent[] {
  return resolvePhrasing(node as MdastPhrasingContent, resolver) as MdastCellPhrasingContent[]
}

function resolveFlow(
  node: MdastFlowContent,
  resolver: AliasResolver | undefined,
): MdastFlowContent {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return {
        ...node,
        children: node.children.flatMap((child) => resolvePhrasing(child, resolver)),
      }
    case 'blockquote':
      return { ...node, children: node.children.map((child) => resolveFlow(child, resolver)) }
    case 'list':
      return { ...node, children: node.children.map((child) => resolveListItem(child, resolver)) }
    case 'table':
      return { ...node, children: node.children.map((child) => resolveTableRow(child, resolver)) }
    default:
      return node
  }
}

function resolveListItem(node: MdastListItem, resolver: AliasResolver | undefined): MdastListItem {
  return { ...node, children: node.children.map((child) => resolveFlow(child, resolver)) }
}

function resolveTableRow(node: MdastTableRow, resolver: AliasResolver | undefined): MdastTableRow {
  return { ...node, children: node.children.map((child) => resolveTableCell(child, resolver)) }
}

function resolveTableCell(
  node: MdastTableCell,
  resolver: AliasResolver | undefined,
): MdastTableCell {
  return {
    ...node,
    children: node.children.flatMap((child) => resolveCellPhrasing(child, resolver)),
  }
}

/**
 * Resolves `[[...]]` references across an already-parsed document. Pure and
 * single-document: the resolver is injected so this package never needs to
 * know how aliases map to canvas ids. With no resolver, only direct
 * `[[canvas:ULID]]` references parse — everything else stays literal text.
 */
export function resolveReferences(root: MdastRoot, resolver?: AliasResolver): MdastRoot {
  return { ...root, children: root.children.map((child) => resolveFlow(child, resolver)) }
}
