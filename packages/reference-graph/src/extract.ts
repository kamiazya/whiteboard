import { scanReferences } from '@kamiazya/whiteboard-codec'
import {
  type DocumentContent,
  readCoreFacets,
  readDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  CanvasEdge,
  SpatialCanvas,
  SpatialNode,
  TagBearerKind,
} from '@kamiazya/whiteboard-model'
import { frameLabel, nodeFile, nodeText } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { searchableTexts, snippetAround } from '@kamiazya/whiteboard-search'
import type { LoroDoc } from 'loro-crdt'
import type { DocumentReferenceFacts, RawReference } from './reference-aggregate.js'

function textReferences(value: string): RawReference[] {
  return scanReferences(value).map((match) => ({
    target: match.target,
    via: 'wikilink' as const,
    context: snippetAround(value, match.index, match.full.length),
  }))
}

function spatialReferences(canvas: SpatialCanvas): RawReference[] {
  const refs: RawReference[] = []
  for (const node of canvas.nodes) {
    const embedId = node.embed?.documentId
    if (embedId !== undefined) {
      refs.push({ target: embedId, via: 'embed-node', context: 'embedded on this canvas' })
      continue
    }
    const file = nodeFile(node)
    if (file !== undefined) {
      refs.push({ target: file, via: 'file-node', context: 'referenced by a file node' })
      continue
    }
    const text = nodeText(node)
    if (text !== undefined) refs.push(...textReferences(text))
  }
  return refs
}

/**
 * The CONTENT half alone — what a stamp-validated cache may keep between
 * requests. Index-authority meta (path/name/kind) deliberately stays out:
 * a rename or set-name must be correct with zero invalidation, so it is
 * read fresh from the listing on every request.
 */
export interface ContentFacts {
  readonly refs: readonly DocumentReferenceFacts['refs'][number][]
  readonly texts: readonly string[]
  /**
   * Everything in the document that carries tags
   * ([ADR-0040](../../../docs/contributing/adr/0040-scoped-tags.md)
   * decision 2): the markdown document itself (OKF core tags), a board, a
   * node or an edge. A filter matches when ONE bearer carries every listed
   * tag, and the bearer's `text` is what an answer names as the excerpt.
   */
  readonly bearers: readonly TagBearer[]
}

interface TagBearer {
  readonly what: TagBearerKind
  /** The node's or edge's id; absent on the document and the board. */
  readonly id?: string
  /** What a reader would call it: a node's text, an edge's label or its two ends. */
  readonly text: string
  readonly tags: readonly string[]
}

/** The name a reader knows a node by: its text, a group's label, or its id. */
function nodeName(node: SpatialNode): string {
  const own = nodeText(node) ?? frameLabel(node)
  return own === undefined || own.length === 0 ? node.id : own
}

function edgeName(edge: CanvasEdge, canvas: SpatialCanvas): string {
  if (edge.label !== undefined && edge.label.length > 0) return edge.label
  const name = (id: string) => {
    const node = canvas.nodes.find((n) => n.id === id)
    return node === undefined ? id : nodeName(node)
  }
  return `${name(edge.from.node)} → ${name(edge.to.node)}`
}

function spatialBearers(canvas: SpatialCanvas): TagBearer[] {
  const bearers: TagBearer[] = []
  if (canvas.tags !== undefined && canvas.tags.length > 0) {
    bearers.push({ what: 'board', text: '', tags: canvas.tags })
  }
  for (const node of canvas.nodes) {
    if (node.tags === undefined || node.tags.length === 0) continue
    bearers.push({ what: 'node', id: node.id, text: nodeName(node), tags: node.tags })
  }
  for (const edge of canvas.edges) {
    if (edge.tags === undefined || edge.tags.length === 0) continue
    bearers.push({ what: 'edge', id: edge.id, text: edgeName(edge, canvas), tags: edge.tags })
  }
  return bearers
}

export function extractContentFacts(
  entry: Pick<DocumentEntry, 'kind'>,
  doc: LoroDoc,
): ContentFacts {
  const content = readDocumentContent(doc, entry.kind)
  if (content.kind === 'markdown') {
    return {
      refs: textReferences(content.body),
      // The prose itself, for mention detection against other documents'
      // names — and the same strings search ranks, by construction.
      texts: searchableTexts(content),
      bearers: tagBearersOf(doc, content),
    }
  }
  return {
    refs: spatialReferences(content.canvas),
    texts: searchableTexts(content),
    bearers: tagBearersOf(doc, content),
  }
}

/**
 * Everything a document contains that carries tags, from content already
 * read — the one definition of "what bears a tag", so the daemon's projection
 * and the browser keeper's cannot count different things.
 */
export function tagBearersOf(doc: LoroDoc, content: DocumentContent): TagBearer[] {
  if (content.kind === 'spatial') return spatialBearers(content.canvas)
  const tags = readCoreFacets(doc)?.tags
  return tags === undefined || tags.length === 0 ? [] : [{ what: 'document', text: '', tags }]
}

/**
 * A document's OWN tags and the ones its contents carry, which are two
 * different answers about the same document.
 *
 * Own is the document's frontmatter or its board's envelope — one bearer,
 * because a document has one of those. Carried is the union over its nodes and
 * edges, deduplicated, because a tag on three boxes is one tag the document
 * contains. Any other bearer kind belongs to neither.
 */
export function splitBearerTags(bearers: readonly { what: string; tags: readonly string[] }[]): {
  own: string[]
  carried: string[]
} {
  const own = bearers.find((bearer) => bearer.what === 'document' || bearer.what === 'board')?.tags
  const carried = new Set<string>()
  for (const bearer of bearers) {
    if (bearer.what !== 'node' && bearer.what !== 'edge') continue
    for (const tag of bearer.tags) carried.add(tag)
  }
  return { own: own === undefined ? [] : [...own], carried: [...carried] }
}
