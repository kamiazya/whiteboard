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
import { SYNC_DOCUMENTS_STORE, whiteboardDbName } from '../lib/browser-idb.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { LoroStore } from '../lib/loro-store.js'
import type { EditorCommand } from '../lib/spatial/commands.js'

const DOCUMENT_STORE = SYNC_DOCUMENTS_STORE

/**
 * Deletes the app's IndexedDB database, and resolves only once it is gone
 * and STAYING gone.
 *
 * The single definition on purpose: it is awaited in a `beforeEach` to mean
 * "this file starts from nothing", and every caller depends on that sentence
 * being true when the promise settles. Two different things break it, and
 * both were found the same way — as a page two files away reporting that it
 * could not read its own data. `blocked` is not a settlement (below), and a
 * deletion that succeeded is not the end either: see `deleteAndKeepDeleted`.
 *
 * **`blocked` is not a settlement.** `deleteDatabase` fires it — and neither
 * `success` nor `error` — while another connection is still open, which in
 * this suite is routine: a store closes its connection in `tx.oncomplete`,
 * which can land after the operation's own promise has resolved. The
 * deletion is briefly blocked and then proceeds, so waiting is what makes
 * the common case correct.
 *
 * Resolving on `blocked` instead hands the next test a database it was told
 * had been cleared. That is not a theoretical hazard: it is the shape behind
 * a flake that hit `BrowserDocumentPage.rename` and then
 * `BrowserDocumentPage.delete-confirm` with an identical symptom — the
 * editor replaced by "This canvas's data could not be read." — a failure
 * whose message names neither IndexedDB nor the file that broke the
 * invariant. It only appears under the full parallel run, because that is
 * when a neighbour's connection is still open often enough to matter.
 *
 * A connection that never closes therefore becomes a test TIMEOUT, which is
 * loud and names the file holding it. That is the trade, and it is the right
 * way round: a hang is a bug report, a silent wrong answer is not.
 *
 * Takes NO ARGUMENT, deliberately. Fourteen call sites pass it point-free to
 * `beforeEach`, and a hook hands its callback the test context — so an
 * optional first parameter silently binds that context as the database name
 * and the deletion goes to a database nobody has. Measured while writing
 * this: adding one optional parameter turned 18 tests across 7 files red,
 * none of which said anything about a name. `clearNamedDb` below is the door
 * for the few suites that need one, and it cannot be passed point-free by
 * accident because it would delete `undefined`.
 */
export async function clearWhiteboardDb(): Promise<void> {
  return deleteAndKeepDeleted(whiteboardDbName())
}

/**
 * The same deletion, for a suite that names its own database — a migration
 * fixture, boot's real-name case, a conformance suite deliberately off the
 * claimed name.
 *
 * Separate from `clearWhiteboardDb` rather than an optional parameter on it,
 * for the reason stated above; here the name is always written out at the
 * call site, so there is nothing for a hook to fill in.
 */
export async function clearNamedDb(dbName: string): Promise<void> {
  return deleteAndKeepDeleted(dbName)
}

/**
 * How long the database has to stay gone before the deletion is believed.
 *
 * Sized on the measurement below — the tail re-created the database inside
 * 100ms — plus a margin, and paid only where there is a tail to wait for.
 * Every call used to pay it: the whole browser project went from 171-177s to
 * 222s, which is 46 seconds spent watching databases that were never coming
 * back.
 */
const SETTLE_QUIET_MS = 150
const SETTLE_POLL_MS = 50
/** A tail that never stops writing becomes a named failure, not a hang. */
const SETTLE_DEADLINE_MS = 5_000

async function databaseExists(dbName: string): Promise<boolean> {
  // `databases()` is Chromium and fake-indexeddb; anywhere it is missing the
  // deletion is believed as before, which is what this helper did until now.
  if (typeof indexedDB.databases !== 'function') return false
  return (await indexedDB.databases()).some((one) => one.name === dbName)
}

/**
 * Delete, then keep deleting until the database stays gone.
 *
 * A deleted database COMES BACK, and that is the second half of the flake
 * whose first half `deleteDatabaseAndWait` closed. Unmounting a page does not
 * end its writes: the workspace record's save and the startup fold are async
 * tails that outlive React's cleanup, and each one opens the database BY NAME
 * — re-creating it, after the deletion has already succeeded.
 *
 * Measured, mounting `BrowserDocumentPage` and then deleting: gone the
 * instant the deletion resolved, back 100ms later holding
 * `workspace-tree:<workspaceId>` and its snapshot chunk — and NOTHING in the
 * document index, because only the record's own save was still in flight.
 *
 * That asymmetry is the whole defect. The next test finds an empty index,
 * creates its own document at `untitled`, and then cannot place it in a
 * workspace tree where the PREVIOUS test's document already owns that path —
 * so the page reports the document as unopenable and shows "This canvas could
 * not be opened just now." over an editor that never loaded. The test that
 * fails is whichever one ran next; nothing in its message names IndexedDB,
 * the page that leaked, or the path collision.
 */
async function deleteAndKeepDeleted(dbName: string): Promise<void> {
  // Nothing has been written, so nothing can be mid-write: the wait below
  // would be watching a database that does not exist and never will. This is
  // most `beforeEach` calls in the suite, and skipping it is what keeps the
  // guarantee from costing every file that never opens a page.
  if (!(await databaseExists(dbName))) return
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  for (;;) {
    await deleteDatabaseAndWait(dbName)
    let cameBack = false
    const quietUntil = Date.now() + SETTLE_QUIET_MS
    while (Date.now() < quietUntil) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
      if (await databaseExists(dbName)) {
        cameBack = true
        break
      }
    }
    if (!cameBack) return
    if (Date.now() >= deadline) {
      throw new Error(
        `${dbName} kept coming back after deletion: something is still writing to it. ` +
          'Unmount the page (or await the work) before clearing.',
      )
    }
  }
}

function deleteDatabaseAndWait(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('whiteboard database deletion failed'))
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
    .open(getBrowserWorkspaceId())
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
