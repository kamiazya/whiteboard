import type { SpatialCanvas, SpatialNode, documentEngine as wire } from '@kamiazya/whiteboard-model'
import type { DocumentContainers } from './containers.js'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { reconcileSpatialCanvas, writeSpatialNode } from './loro-bridge.js'
import { writeMarkdownBody } from './markdown-body.js'

/** One splice of a markdown body, in UTF-16 units of the body it was planned on. */
export interface TextSplice {
  readonly index: number
  readonly remove: number
  readonly insert: string
}

/**
 * A change to ONE document, as plain data: what a pure planner (reference
 * rewrites, link-mentions) decides, and what a keeper applies with
 * `applyDocumentEdit` to whatever holds the document. Planning never touches
 * an engine handle, so the plan can come from code that has none.
 *
 * Every arm is the narrowest write its change can be, because the write is an
 * op that merges with concurrent edits: a splice leaves the rest of the body
 * to other peers, a node write leaves the other nodes.
 */
export type DocumentEdit =
  /** Runs in DESCENDING index order, so each applies against the offsets it was planned on. */
  | { readonly kind: 'markdown-splices'; readonly runs: readonly TextSplice[] }
  /** A whole new body, written as the minimal change from the stored one. */
  | { readonly kind: 'markdown-body'; readonly body: string }
  /** Exactly these nodes, never a whole-canvas resync that would delete a record the reader skipped. */
  | { readonly kind: 'spatial-nodes'; readonly nodes: readonly SpatialNode[] }
  /** A visible diff of `after` against `before`, the canvas the plan was read from. */
  | {
      readonly kind: 'spatial-canvas'
      readonly before: SpatialCanvas
      readonly after: SpatialCanvas
    }

/** Applies `edit` to `doc` and commits it once. */
export function applyDocumentEdit(doc: DocumentContainers, edit: DocumentEdit): void {
  switch (edit.kind) {
    case 'markdown-splices': {
      const text = doc.getText(MARKDOWN_BODY_KEY)
      for (const run of edit.runs) {
        text.delete(run.index, run.remove)
        text.insert(run.index, run.insert)
      }
      doc.commit()
      return
    }
    case 'markdown-body':
      writeMarkdownBody(doc, edit.body)
      return
    case 'spatial-nodes':
      for (const node of edit.nodes) writeSpatialNode(doc, node)
      return
    case 'spatial-canvas':
      reconcileSpatialCanvas(doc, edit.before, edit.after)
      return
  }
}

/**
 * `edit` as the engine's writes: the same narrowest change `applyDocumentEdit`
 * makes to a Loro document, so a keeper that holds a document as an engine
 * lease applies a planner's plan without a Loro document of its own.
 * `documentId` names the document in a workspace record; omit it for a document
 * that is the root of its own record.
 */
export function documentEditWrites(edit: DocumentEdit, documentId?: string): wire.Write[] {
  const at = documentId === undefined ? {} : { documentId }
  switch (edit.kind) {
    case 'markdown-splices':
      return [{ op: 'spliceText', args: { ...at, text: MARKDOWN_BODY_KEY, runs: [...edit.runs] } }]
    case 'markdown-body':
      return [{ op: 'writeMarkdownBody', args: { ...at, body: edit.body } }]
    case 'spatial-nodes':
      return [
        {
          op: 'withSpatialBatch',
          args: { ...at, steps: edit.nodes.map((node) => ({ op: 'writeNode', node })) },
        },
      ]
    case 'spatial-canvas':
      return [
        {
          op: 'reconcileSpatialCanvas',
          args: { ...at, prev: edit.before, next: edit.after },
        },
      ]
  }
}
