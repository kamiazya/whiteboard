/**
 * The one definition of "which uploaded files does this document state
 * reference", shared with every reader that decides a picture's fate. The
 * walk is model's `storedImageRefs` (file nodes, frame backgrounds, inline
 * images in text nodes and a markdown body); this adapts a stored document to
 * it. The browser's promote transfer and the daemon's file GC both decide a
 * blob's fate from it — two hand-rolled copies is how a new place a picture
 * can sit gets added to one side and a live image gets dropped by the other.
 */
import {
  imageRefId,
  isImageRef,
  type ProposedChange,
  storedImageRefs,
} from '@kamiazya/whiteboard-model'
import { type DocumentContainers, MARKDOWN_BODY_KEY } from './containers.js'
import { readSpatialCanvas } from './loro-bridge.js'
import { readProposals } from './proposals.js'

/**
 * Ids of every uploaded file the doc state's current model references, and
 * every one an UNDECIDED proposed change would put there.
 *
 * A proposal is stored inside the document it is about, and adopting it
 * draws what it names — so while it is open its pictures are as needed as
 * the canvas's. A decided change names nothing more: an adopted one's result
 * is already in the content read above, and a dismissed one will never draw.
 */
export function collectImageRefIds(doc: DocumentContainers): Set<string> {
  // The body container only: a legacy body stored as a text node is already
  // part of the canvas read.
  const body = doc.getText(MARKDOWN_BODY_KEY).toString()
  const refs = storedImageRefs({ canvas: readSpatialCanvas(doc), body })
  return new Set([...refs, ...proposedImageRefs(doc)].map(imageRefId))
}

function proposedImageRefs(doc: DocumentContainers): string[] {
  const refs: string[] = []
  for (const proposal of readProposals(doc)) {
    for (const change of proposal.changes) {
      if (change.status === 'open') refs.push(...changeImageRefs(change))
    }
  }
  return refs
}

/**
 * What one change would draw. A patch carries no node type, so its fields
 * are read whichever type they would land on — a `file` on a text node is
 * refused when adopted, and keeping its picture meanwhile costs one blob.
 */
function changeImageRefs(change: ProposedChange): readonly string[] {
  switch (change.op) {
    case 'node.add':
      return storedImageRefs({ canvas: { nodes: [change.node], edges: [] } })
    case 'node.patch': {
      const { file, background, text } = change.patch
      return [
        ...[file, background].filter((ref) => ref !== undefined && isImageRef(ref)),
        ...(text === undefined ? [] : storedImageRefs({ body: text })),
      ] as string[]
    }
    case 'body.replace':
      return storedImageRefs({ body: change.text })
    // A removal's prior is the node already in the content; edges and lines
    // carry no picture. Listed rather than defaulted, so a new verb has to
    // be answered here.
    case 'node.remove':
    case 'edge.add':
    case 'edge.patch':
    case 'edge.remove':
    case 'line.add':
    case 'line.patch':
    case 'line.remove':
      return []
  }
}
