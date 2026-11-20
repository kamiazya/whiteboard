import type { documentEngine, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { readCoreFacets } from './document-envelope.js'
import { applyWriter } from './engine/writers.js'
import { readMarkdownBody } from './markdown-body.js'
import { documentContainers } from './workspace-tree.js'

/**
 * What a command planner needs of a document: two reads before it decides what
 * to write, and the application of the wire writes it decided on. `directTarget`
 * is a plain `LoroDoc` as one, applying through the same `applyWriter` the
 * engine dispatches, so a write has one meaning on either side of the wire.
 *
 * The containers are resolved per call and never cached: a restore re-mints a
 * hosted document's tree node under a new id for the same document id.
 */
export interface WriteTarget {
  readonly documentId: string | undefined
  body(): string
  coreFacets(): StoredCoreFacets | undefined
  apply(writes: readonly documentEngine.Write[]): void
}

export function directTarget(doc: LoroDoc, documentId?: string): WriteTarget {
  const content = () => (documentId === undefined ? doc : documentContainers(doc, documentId))
  return {
    documentId,
    body: () => readMarkdownBody(content()),
    coreFacets: () => readCoreFacets(content()),
    apply(writes) {
      for (const write of writes) applyWriter(doc, write.op, write.args)
    },
  }
}
