import { documentIdSchema } from '@kamiazya/whiteboard-model'
import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-model/mdast'

import { findNextReference, type ReferenceMatch } from './scan.js'

export type AliasResolver = (alias: string) => string | null

/**
 * Splits a plain-text node's value on `[[...]]`/`![[...]]` occurrences,
 * resolving each one independently. A leading `!` marks an embed
 * (transclusion) rather than a wikiLink — mirrors to-remark.ts's inverse
 * serialization (`wikiLink` -> `[[ID]]`, `embed` -> `![[ID]]`).
 *
 * There is no scheme: `[[<ULID>]]` resolves directly (no resolver needed)
 * and everything else goes to the injected resolver as an ALIAS — a
 * workspace path, since display names are retired from resolution (path +
 * id are the only written forms; names appear at render time instead). An
 * unresolved target stays
 * as literal text rather than being dropped, so a link this version cannot
 * honour is visible rather than silently missing.
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

    const resolved = resolveTarget(match, resolver)
    result.push(resolved ?? { type: 'text', value: match.full })

    lastIndex = match.index + match.full.length
    cursor = lastIndex
  }

  if (lastIndex < value.length) result.push({ type: 'text', value: value.slice(lastIndex) })
  return result.length > 0 ? result : [{ type: 'text', value }]
}

function resolveTarget(
  { target, alias, isEmbed, fragment }: ReferenceMatch,
  resolver: AliasResolver | undefined,
): MdastPhrasingContent | undefined {
  const documentId = resolveDocumentId(target, resolver)
  if (documentId === null) return undefined
  // The fragment rides along unresolved: it names something INSIDE the
  // document, which only a renderer holding that document can look up.
  const withFragment = fragment === undefined ? {} : { fragment }
  // Only an explicit |label becomes the alias. The written target is an
  // address, and freezing it into the label slot would stop the renderer
  // from showing the target's CURRENT display name for a bare [[path]].
  return isEmbed
    ? { type: 'embed', documentId, ...withFragment }
    : { type: 'wikiLink', documentId, alias, ...withFragment }
}

function resolveDocumentId(target: string, resolver: AliasResolver | undefined): string | null {
  // A document id is a canonical ULID — 26 characters of Crockford base32
  // starting 0-7 — so it identifies itself without a scheme to announce it.
  // The id reading wins over the resolver: a document NAMED like a ULID would
  // be shadowed, which is the right trade for a shape no one types by hand.
  if (documentIdSchema.safeParse(target).success) return target
  if (resolver === undefined) return null
  return resolver(target)
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
 * bare `[[ULID]]` references parse — everything else stays literal text.
 */
export function resolveReferences(root: MdastRoot, resolver?: AliasResolver): MdastRoot {
  return { ...root, children: root.children.map((child) => resolveFlow(child, resolver)) }
}
