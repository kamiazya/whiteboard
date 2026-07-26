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

const REFERENCE_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g
const CANVAS_ID_PREFIX = 'canvas:'

export type AliasResolver = (alias: string) => string | null

/**
 * Splits a plain-text node's value on `[[...]]` occurrences, resolving each
 * one independently. `[[canvas:ULID]]` always resolves directly (no
 * resolver needed); `[[alias]]` only resolves through the injected
 * resolver — malformed refs (an unresolved alias, or a `canvas:` target that
 * isn't a valid ULID) stay as literal text rather than being dropped.
 */
function splitTextReferences(
  value: string,
  resolver: AliasResolver | undefined,
): MdastPhrasingContent[] {
  const result: MdastPhrasingContent[] = []
  let lastIndex = 0

  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const [full, target, alias] = match
    const index = match.index ?? 0
    if (index > lastIndex) result.push({ type: 'text', value: value.slice(lastIndex, index) })

    const resolved = resolveTarget(target, alias, resolver)
    result.push(resolved ?? { type: 'text', value: full })

    lastIndex = index + full.length
  }

  if (lastIndex < value.length) result.push({ type: 'text', value: value.slice(lastIndex) })
  return result.length > 0 ? result : [{ type: 'text', value }]
}

function resolveTarget(
  target: string,
  alias: string | undefined,
  resolver: AliasResolver | undefined,
): MdastPhrasingContent | undefined {
  if (target.startsWith(CANVAS_ID_PREFIX)) {
    const canvasId = target.slice(CANVAS_ID_PREFIX.length)
    if (!canvasIdSchema.safeParse(canvasId).success) return undefined
    return { type: 'wikiLink', canvasId, alias }
  }

  if (resolver === undefined) return undefined
  const canvasId = resolver(target)
  if (canvasId === null) return undefined
  return { type: 'wikiLink', canvasId, alias: alias ?? target }
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
