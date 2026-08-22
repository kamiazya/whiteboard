import { scanReferences } from '@kamiazya/whiteboard-codec'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import type { DocumentReferenceFacts, RawReference } from './reference-aggregate.js'

const CONTEXT_RADIUS = 60

function snippetAround(value: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS)
  const end = Math.min(value.length, index + length + CONTEXT_RADIUS)
  const text = value.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${end < value.length ? '…' : ''}`
}

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
 * One document's reference facts, extracted from its persisted state. Pure
 * over (index entry, loaded doc) — the extraction half of the aggregate's
 * extract/resolve split: everything here depends on THIS document alone, so
 * an incremental feed re-runs it only for the document that changed.
 */
export function extractReferenceFacts(entry: DocumentEntry, doc: LoroDoc): DocumentReferenceFacts {
  const kind = entry.kind ?? readDocumentKind(doc)
  const refs =
    kind === 'markdown'
      ? textReferences(readMarkdownBody(doc))
      : spatialReferences(readSpatialCanvas(doc))
  return {
    path: entry.path,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    refs,
  }
}
