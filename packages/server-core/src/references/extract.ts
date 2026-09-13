import { scanReferences } from '@kamiazya/whiteboard-codec'
import {
  readCoreFacets,
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { nodeFile, nodeText } from '@kamiazya/whiteboard-model'
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
    // The prose itself, for mention detection against other documents'
    // names — and the same strings search ranks, by construction.
    texts: markdown
      ? searchableTexts({ kind: 'markdown', body: readMarkdownBody(doc) })
      : searchableTexts({ kind: 'spatial', canvas: canvas as SpatialCanvas }),
    tags: markdown ? readCoreFacets(doc)?.tags : undefined,
  }
}
