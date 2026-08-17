/**
 * Shared helpers for the BrowserLocalDocumentPage browser-mode suites: reading
 * the app's real IndexedDB rows back out, and building the minimal
 * SpatialCanvas edit those suites drive through a mocked SpatialEditor.
 *
 * These decode the persisted layout directly rather than going through the
 * production store, so an assertion stays independent of the page's render
 * timing — which is the whole point of the suites that use them.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import type { EditorCommand } from '../components/spatial-editor/commands.js'

const DB_NAME = 'whiteboard'
const CANVAS_STORE = 'loroCanvases'

type CanvasEnvelope = { snapshot: Uint8Array; deltas?: Uint8Array[] }

/** Deletes the app's IndexedDB database. */
export async function clearWhiteboardDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    // If a prior connection isn't fully closed, deleteDatabase fires onblocked
    // (not onsuccess/onerror); settle anyway so the suite fails clearly instead
    // of hanging until timeout.
    req.onblocked = () => resolve()
  })
}

/** Runs `read` against the canvas object store of the real IndexedDB database. */
async function withCanvasStore<T>(read: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(DB_NAME)
    openReq.onerror = () => reject(openReq.error)
    openReq.onsuccess = () => {
      const db = openReq.result
      const tx = db.transaction(CANVAS_STORE, 'readonly')
      const readReq = read(tx.objectStore(CANVAS_STORE))
      readReq.onsuccess = () => {
        db.close()
        resolve(readReq.result as T)
      }
      readReq.onerror = () => {
        db.close()
        reject(readReq.error)
      }
    }
  })
}

/** Raw keys of the canvas object store, real IndexedDB. */
export async function loroCanvasesKeys(): Promise<string[]> {
  return withCanvasStore<string[]>((store) => store.getAllKeys())
}

/** Node ids persisted for a given canvas id, decoded straight from IndexedDB. */
export async function persistedNodeIds(documentId: string): Promise<string[]> {
  const envelope = await withCanvasStore<CanvasEnvelope | undefined>((store) =>
    store.get(documentId),
  )
  if (!envelope) {
    return []
  }

  const doc = new Loro()
  doc.import(envelope.snapshot)
  // Replay deltas recorded after the initial snapshot — a canvas that received
  // more than one write (e.g. a flushed edit on top of a warmup write) is
  // stored as snapshot + deltas, not a single snapshot.
  for (const delta of envelope.deltas ?? []) {
    doc.import(delta)
  }
  // crdt's LoroDoc spatial layout: doc.getMap('nodes') keyed by
  // nodeId (see package-crdt.md).
  return Object.keys(doc.getMap('nodes').toJSON() as Record<string, unknown>)
}

/** A canvas holding one text node — the minimal edit these suites drive. */
export function textNodeCanvas(id: string, x: number, y: number): SpatialCanvas {
  return {
    nodes: [{ id, type: 'text', x, y, width: 80, height: 40, text: id }],
    edges: [],
  }
}

/** The command a real SpatialEditor would report alongside `textNodeCanvas`. */
export function setTextCommand(id: string): EditorCommand {
  return { kind: 'set-text', id, text: 'x' }
}

/** The command a real SpatialEditor would report when creating `textNodeCanvas(id, x, y)`'s node. */
export function createNodeCommand(id: string, x: number, y: number): EditorCommand {
  return { kind: 'create-node', node: textNodeCanvas(id, x, y).nodes[0]! }
}

/** The command a real SpatialEditor would report when deleting the node with `id`. */
export function deleteNodeCommand(id: string): EditorCommand {
  return { kind: 'delete-node', id }
}
