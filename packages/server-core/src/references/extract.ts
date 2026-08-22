import { scanReferences } from '@kamiazya/whiteboard-codec'
import {
  readCoreFacets,
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import { snippetAround } from '../search/snippet.js'
import type { DocumentReferenceFacts, RawReference } from './reference-aggregate.js'

function textReferences(value: string): RawReference[] {
  return scanReferences(value).map((match) => ({
    target: match.target,
    via: 'wikilink' as const,
    context: snippetAround(value, match.index, match.full.length),
  }))
}

function spatialTexts(canvas: SpatialCanvas): string[] {
  const texts: string[] = []
  for (const node of canvas.nodes) {
    if (node.type === 'text') texts.push(node.text)
    if (node.type === 'group' && node.label !== undefined) texts.push(node.label)
  }
  for (const edge of canvas.edges) if (edge.label !== undefined) texts.push(edge.label)
  return texts
}

function spatialReferences(canvas: SpatialCanvas): RawReference[] {
  const refs: RawReference[] = []
  for (const node of canvas.nodes) {
    // The extension is a union (embed | facets-only); only the embed
    // variant references another document.
    const extension = node['x-whiteboard']
    const embedId =
      extension !== undefined && 'kind' in extension ? extension.documentId : undefined
    if (embedId !== undefined) {
      refs.push({ target: embedId, via: 'embed-node', context: 'embedded on this canvas' })
      continue
    }
    if (node.type === 'file') {
      refs.push({ target: node.file, via: 'file-node', context: 'referenced by a file node' })
      continue
    }
    if (node.type === 'text') refs.push(...textReferences(node.text))
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
  /** OKF core-facet tags; undefined for spatial documents (they hold none). */
  readonly tags: readonly string[] | undefined
}

export function extractContentFacts(
  entry: Pick<DocumentEntry, 'kind'>,
  doc: LoroDoc,
): ContentFacts {
  const kind = entry.kind ?? readDocumentKind(doc)
  const markdown = kind === 'markdown'
  const canvas = markdown ? undefined : readSpatialCanvas(doc)
  return {
    refs: markdown
      ? textReferences(readMarkdownBody(doc))
      : spatialReferences(canvas as SpatialCanvas),
    // The prose itself, for mention detection against other documents' names.
    texts: markdown ? [readMarkdownBody(doc)] : spatialTexts(canvas as SpatialCanvas),
    tags: markdown ? readCoreFacets(doc)?.tags : undefined,
  }
}
