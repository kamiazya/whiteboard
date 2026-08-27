/**
 * Shared helpers for the BrowserDocumentPage browser-mode suites: reading
 * the app's real IndexedDB rows back out, and building the minimal
 * SpatialCanvas edit those suites drive through a mocked SpatialEditor.
 *
 * These decode the persisted layout directly rather than going through the
 * production store, so an assertion stays independent of the page's render
 * timing — which is the whole point of the suites that use them.
 */

import { projectWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { SYNC_DOCUMENTS_STORE, whiteboardDbName } from '../lib/browser-idb.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { BROWSER_WORKSPACE_ID } from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'

const DOCUMENT_STORE = SYNC_DOCUMENTS_STORE

/** Deletes the app's IndexedDB database. */
export async function clearWhiteboardDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(whiteboardDbName())
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    // If a prior connection isn't fully closed, deleteDatabase fires onblocked
    // (not onsuccess/onerror); settle anyway so the suite fails clearly instead
    // of hanging until timeout.
    req.onblocked = () => resolve()
  })
}

/** Runs `read` against the canvas object store of the real IndexedDB database. */
async function withDocumentStore<T>(read: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(whiteboardDbName())
    openReq.onerror = () => reject(openReq.error)
    openReq.onsuccess = () => {
      const db = openReq.result
      const tx = db.transaction(DOCUMENT_STORE, 'readonly')
      const readReq = read(tx.objectStore(DOCUMENT_STORE))
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

/**
 * The ids of documents that have stored content, real IndexedDB.
 *
 * Reads the `DocumentStore` port's store rather than the retired
 * `loroDocuments`, and strips the `docRefKey` prefix so callers keep speaking
 * document ids. Kept under its old name because what it ANSWERS has not
 * changed — only where the answer lives.
 */
export async function loroDocumentsKeys(): Promise<string[]> {
  const keys = await withDocumentStore<string[]>((store) => store.getAllKeys())
  return keys.map((key) => key.replace(/^document:/, ''))
}

/** Node ids persisted for a given canvas id, decoded through the real store. */
export async function persistedNodeIds(documentId: string): Promise<string[]> {
  // The workspace document is where the editor persists now: a document the
  // tree holds answers from its node's containers. The per-document record
  // below stays as the fallback for suites that seed the OLD stores and
  // assert before any backend has folded them.
  const workspace = await new BrowserWorkspaceDocs(whiteboardDbName())
    .open(BROWSER_WORKSPACE_ID)
    .catch(() => null)
  if (workspace !== null) {
    const projected = projectWorkspaceDocument(workspace, documentId)
    if (projected !== null) {
      return Object.keys(projected.getMap('nodes').toJSON() as Record<string, unknown>)
    }
  }
  // Through `LoroStore` rather than a hand-decoded envelope: content is behind
  // the `DocumentStore` port now, so its chunking and its delta log are the
  // store's business and a test that re-implemented either would be asserting
  // against its own copy of them.
  const loaded = await new LoroStore(whiteboardDbName()).load(documentId)
  if (loaded.kind !== 'ok') return []

  const doc = new Loro()
  doc.import(loaded.snapshot)
  // Replay deltas recorded after the snapshot — a canvas that received more
  // than one write is stored as snapshot + deltas, not a single snapshot.
  for (const delta of loaded.deltas ?? []) doc.import(delta)
  // crdt's LoroDoc spatial layout: doc.getMap('nodes') keyed by nodeId.
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
