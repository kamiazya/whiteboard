/**
 * Shared fixture for seeding a LoroDoc in the CURRENT nodes/edges spatial
 * model — the shape every production doc is actually written in (see
 * package-canvas-workspace.md's "LoroDoc spatial layout"). Mirrors
 * apps/web/src/test-utils/browser-local-canvas.ts in spirit: build via the
 * real writeSpatialCanvas bridge rather than poking at LoroDoc internals, so
 * a fixture never drifts from what saveCanvas actually persists.
 *
 * The legacy 'elements' movable-list shape (see file-gc.test.ts's
 * makeDocWithImage) is retired but still guarded additively by file-gc's
 * collector — keep seeding it directly where a test's whole point is that
 * legacy shape.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { newImageRef } from '@kamiazya/whiteboard-canvas-model'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'

/** A doc holding the given nodes-model spatial canvas, saved through the real bridge. */
export function makeSpatialDoc(canvas: SpatialCanvas): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc
}

/** Builds the single-node spatial canvas shape `makeSpatialDocWithImage`/`setSpatialDocImage` share. */
function imageOnlyCanvas(fileId: string, nodeId: string): SpatialCanvas {
  return {
    nodes: [
      {
        id: nodeId,
        type: 'file',
        file: newImageRef(fileId),
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    ],
    edges: [],
  }
}

/** A doc holding a single 'file' node whose `file` value references the given upload id. */
export function makeSpatialDocWithImage(fileId: string, nodeId = `node-${fileId}`): LoroDoc {
  return makeSpatialDoc(imageOnlyCanvas(fileId, nodeId))
}

/**
 * Replaces an EXISTING doc's nodes/edges with a single 'file' node
 * referencing the given upload id — the nodes-model equivalent of clearing
 * the legacy 'elements' list and inserting a new image element in its
 * place. Used by tests that need to mutate a live doc mid-scenario (a
 * concurrent-save race, a branch history point) rather than build a fresh
 * one.
 */
export function setSpatialDocImage(doc: LoroDoc, fileId: string, nodeId = `node-${fileId}`): void {
  writeSpatialCanvas(doc, imageOnlyCanvas(fileId, nodeId))
}

/** Clears all nodes/edges from an existing doc — the nodes-model equivalent of emptying the legacy 'elements' list. */
export function clearSpatialDocNodes(doc: LoroDoc): void {
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
}
