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
 * The work list is DERIVED, not marked: a document is pending exactly when
 * the index has a row for it and the workspace tree does not. That is what
 * makes a crash safe — a document folded before the crash is simply not work
 * anymore — and it also picks up documents created after this build shipped
 * but before their write path moved to the tree, at the next startup.
 */
import {
  adoptWorkspaceDocument,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { Loro } from 'loro-crdt'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { BROWSER_WORKSPACE_ID } from './local-document-summary.js'
import { LoroStore } from './loro-store.js'

export interface FoldReport {
  /** Documents carried into the workspace document by THIS run. */
  folded: number
  /** Rows left alone: no readable content, or no recorded kind to adopt under. */
  skipped: number
}

export async function foldWorkspaceDocuments(dbName?: string): Promise<FoldReport> {
  const index = new IdbDocumentIndex(dbName)
  let entries: Awaited<ReturnType<IdbDocumentIndex['listDocuments']>>
  try {
    entries = await index.listDocuments({ workspaceId: BROWSER_WORKSPACE_ID })
  } catch (error) {
    // A browser that never created the workspace has nothing to fold. Every
    // other failure is real and stays loud.
    if (error instanceof WorkspaceNotFoundError) return { folded: 0, skipped: 0 }
    throw error
  }

  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await docs.create(BROWSER_WORKSPACE_ID)
  const loroStore = new LoroStore(dbName)

  let folded = 0
  let skipped = 0
  for (const entry of entries) {
    if (resolveWorkspaceDocumentById(workspace, entry.documentId) !== null) continue
    // A pre-kind row has content but no recorded format, and adopting it
    // would mean inventing one. It keeps being served by the old path, which
    // already knows how to refuse it with advice.
    const kind = documentKindSchema.safeParse(entry.kind)
    if (!kind.success) {
      skipped += 1
      continue
    }
    const loaded = await loroStore.load(entry.documentId)
    if (loaded.kind !== 'ok') {
      // Unreadable content folds NOTHING rather than an empty document: the
      // old record stays where it is, still reported by the old path as
      // damaged-but-present, which is a recoverable answer.
      skipped += 1
      continue
    }
    const source = new Loro()
    source.import(loaded.snapshot)
    for (const delta of loaded.deltas ?? []) source.import(delta)
    adoptWorkspaceDocument(
      workspace,
      {
        path: entry.path,
        documentId: entry.documentId,
        kind: kind.data,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      },
      source,
    )
    // Saved PER DOCUMENT, so a crash mid-fold loses at most the one in
    // flight — the next startup derives it as still-pending and retries.
    await docs.save(BROWSER_WORKSPACE_ID, workspace)
    folded += 1
  }
  return { folded, skipped }
}
