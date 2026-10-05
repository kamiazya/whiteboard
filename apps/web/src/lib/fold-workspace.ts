/**
 * Folds the browser's per-document Loro records into the workspace document.
 *
 * A resumable STARTUP step, not an `onupgradeneeded` carrier, and that is a
 * constraint rather than a preference: Loro is wasm and its imports are
 * async, while an IndexedDB versionchange transaction dies the moment an
 * `await` yields. So the schema migration (there is none — the workspace
 * document keys into the existing `syncDocuments` store) and the content
 * fold are two different steps, and this is the second.
 *
 * The work list is DERIVED, not marked: a row is pending exactly when the
 * workspace record answers for neither its id's node nor its id's trash
 * entry. A trashed id left the tree because somebody deleted it, not because
 * it was never folded, and adopting it again would bring back what they
 * deleted with the content it had before the fold.
 *
 * A row the record answers for is RETIRED — its per-document record, then
 * the row itself — only after the tree that holds its content is saved. A
 * crash in between leaves the row naming an id the tree already has, which
 * the next run retires without adopting again. Unreadable and pre-kind rows,
 * and a row whose path the tree holds under another document, are never
 * retired here: the old record is still their only home.
 */
import { adoptWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { type DocumentEntry, WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { type AppLogger, getAppLogger } from './app-logger.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { LoroStore } from './loro-store.js'
import { documentIdsInRecord } from './workspace-record-ids.js'

const log = getAppLogger('fold-workspace')

export interface FoldReport {
  /** Documents carried into the workspace document by THIS run. */
  folded: number
  /**
   * Rows left alone: no readable content, no recorded kind to adopt under, or
   * a path the tree already holds under another document.
   */
  skipped: number
}

/** The browser workspace's legacy rows, or null when it never had any. */
async function legacyRows(index: IdbDocumentIndex): Promise<DocumentEntry[] | null> {
  try {
    return await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
  } catch (error) {
    // A browser that never created the workspace has nothing to fold. Every
    // other failure is real and stays loud.
    if (error instanceof WorkspaceNotFoundError) return null
    throw error
  }
}

/** Adopts one row's record into the tree; false when the row cannot be folded. */
async function adoptRow(
  workspace: LoroDoc,
  entry: DocumentEntry,
  loroStore: LoroStore,
): Promise<boolean> {
  // A pre-kind row has content but no recorded format, and adopting it
  // would mean inventing one. It keeps being served by the old path, which
  // already knows how to refuse it with advice.
  const kind = documentKindSchema.safeParse(entry.kind)
  if (!kind.success) return false
  const loaded = await loroStore.load(entry.documentId)
  // Unreadable content folds NOTHING rather than an empty document: the old
  // record stays where it is, still reported by the old path as
  // damaged-but-present, which is a recoverable answer.
  if (loaded.kind !== 'ok') return false
  const source = new LoroDoc()
  source.import(loaded.snapshot)
  for (const delta of loaded.deltas ?? []) source.import(delta)
  const { path, documentId, name } = entry
  const adopted = adoptWorkspaceDocument(
    workspace,
    { path, documentId, kind: kind.data, ...(name === undefined ? {} : { name }) },
    source,
  )
  // Null when the tree already holds ANOTHER document at this path. The row
  // is then skipped like an unreadable one: retiring it would delete the only
  // copy of a document the tree never took, and the fold-skipped listing is
  // what keeps it reachable beside the one that holds the path.
  if (adopted === null) {
    log.warn('a legacy document met a taken path; it stays where it is', { documentId, path })
    return false
  }
  return true
}

/**
 * One run per database at a time, joined by whoever asks meanwhile. Two runs
 * that overlap each open their own copy of the record and each adopt the same
 * row, which is two nodes under one id once their saves merge — and the page,
 * the switcher and the backend all ask at once on a cold start.
 *
 * ponytail: per tab. Another tab's run can still overlap this one; a Web Lock
 * around `foldOnce` is the upgrade if that is ever seen.
 */
const running = new Map<string, Promise<FoldReport>>()

export function foldWorkspaceDocuments(dbName?: string): Promise<FoldReport> {
  const key = dbName ?? ''
  const joined = running.get(key)
  if (joined !== undefined) return joined
  const run = foldOnce(dbName).finally(() => running.delete(key))
  running.set(key, run)
  return run
}

/**
 * The fold as every surface runs it. It is migration, so a failure is logged
 * under the caller's name and the caller goes on with what the tree holds — a
 * briefly incomplete or undercounted view, never a surface that refuses to
 * open over a step that only tidies storage. Null on failure; the next caller
 * to ask runs it again, since the work list is derived.
 */
export async function foldOrServeTheTree(
  log: AppLogger,
  dbName?: string,
): Promise<FoldReport | null> {
  try {
    return await foldWorkspaceDocuments(dbName)
  } catch (err) {
    log.warn('startup fold failed; serving what the tree holds', err)
    return null
  }
}

async function foldOnce(dbName?: string): Promise<FoldReport> {
  // No write barrier on these reads (see pending-index-writes.ts): nothing
  // tracked there adds a legacy row — this build writes none — and a tracked
  // save loop can be the caller this run is answering.
  const index = new IdbDocumentIndex(dbName, { readsAwaitIssuedWrites: false })
  const entries = await legacyRows(index)
  if (entries === null) return { folded: 0, skipped: 0 }

  const workspaceId = getBrowserWorkspaceId()
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await docs.create(workspaceId)
  const held = documentIdsInRecord(workspace)
  const loroStore = new LoroStore(dbName)
  const retire = async (documentId: string): Promise<void> => {
    // The record before the row: a crash between the two leaves the row,
    // which the next run retires again, never a record nothing names.
    await loroStore.retire(documentId)
    await index.retireDocument({ workspaceId, documentId })
  }

  let folded = 0
  let skipped = 0
  for (const entry of entries) {
    if (!held.has(entry.documentId)) {
      if (!(await adoptRow(workspace, entry, loroStore))) {
        skipped += 1
        continue
      }
      // Saved PER DOCUMENT and before retiring, so a crash mid-fold loses at
      // most the one in flight and never a record the tree does not hold.
      await docs.save(workspaceId, workspace)
      held.add(entry.documentId)
      folded += 1
    }
    await retire(entry.documentId)
  }
  return { folded, skipped }
}
