/**
 * The browser keeper's file collection: drop the stored images no document,
 * trash entry or saved version still names.
 *
 * "Names" is `scanFileReferences`, the definition the daemon's file GC judges
 * by, so the two keepers cannot disagree about what a live image is. This
 * side supplies the reads — every workspace record this browser keeps, its
 * trash bytes in the blob store, its version rows — and the deletion, which
 * is `DocumentFileStore.sweep`.
 *
 * The file store is keyed globally, not per workspace, so a sweep judges
 * every workspace at once: an image is kept while ANY of them names it.
 *
 * It stands down rather than guess, in four cases:
 *
 * - a per-document record the startup fold has not taken into a workspace
 *   (or could not read) — its images are named by nothing the scan walks;
 * - a record that will not open, or something inside one the scan could not
 *   judge — the shared definition's fail-closed answer;
 * - a record that MOVED while the scan ran: what it judged no longer exists.
 *   That is the daemon's fence; what remains after it is covered by the grace
 *   window, which keeps a fresh upload whose node has not been saved yet.
 *
 * ponytail: a per-document record that stays unreadable keeps every sweep
 * standing down; clearing it (Start fresh, or deleting it) lets them run.
 */
import {
  type FileReferenceReads,
  projectWorkspaceDocument,
  scanFileReferences,
} from '@kamiazya/whiteboard-loro-adapter'
import { imageRefId, isImageRef } from '@kamiazya/whiteboard-model'
import { workspaceIdOfStoredDocKey } from '@kamiazya/whiteboard-ports'
import { decodeFrontiers, type LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { SYNC_DOCUMENTS_STORE } from './browser-idb.js'
import { savedVersionFrontiers } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { DocumentFileStore } from './document-file-store.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { inTransaction, request } from './idb-tx.js'
import { createUserSettingsStore } from './user-settings-store.js'

const log = getAppLogger('browser-file-sweep')

/** The daemon's default, for the same upload -> save window. */
const DEFAULT_GRACE_MS = 60 * 60 * 1000

export type BrowserFileSweepResult =
  | { kind: 'swept'; deleted: readonly string[] }
  | {
      kind: 'stood-down'
      reason: 'unfolded-documents' | 'unreadable-record' | 'unjudged' | 'record-moved'
    }

export interface BrowserFileSweepOptions {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  readonly dbName?: string
  /** How old a stored image must be before nothing naming it means unused. */
  readonly graceMs?: number
  readonly now?: () => number
}

async function storedRecordKeys(dbName: string | undefined): Promise<string[]> {
  const keys = await inTransaction(dbName, [SYNC_DOCUMENTS_STORE], 'readonly', (tx) =>
    request(tx.objectStore(SYNC_DOCUMENTS_STORE).getAllKeys()),
  )
  return keys.filter((key): key is string => typeof key === 'string').sort()
}

/**
 * The workspaces whose images live in this browser's file store. A replica
 * of a daemon-kept workspace is not one: its page reads images through the
 * daemon's file route, never this store, and its record is sealed under a
 * key this tab may not hold.
 */
function browserKeptWorkspaceIds(keys: readonly string[]): string[] {
  const replicas = createUserSettingsStore().load().storage.replicas ?? {}
  return keys.flatMap((key) => {
    const workspaceId = workspaceIdOfStoredDocKey(key)
    return workspaceId === null || workspaceId in replicas ? [] : [workspaceId]
  })
}

function signatureOf(record: LoroDoc): string {
  return JSON.stringify(record.oplogFrontiers())
}

/**
 * Between two units of the scan, so a sweep over a long history leaves the
 * page its input and paints: each unit is one synchronous WASM read.
 */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The version rows as the scan reads them: each one's frontier checked out of
 * ONE fork of the record, rather than a fork per version — a fork copies the
 * whole workspace, and a checkout moves the one it has.
 */
function versionReads(
  record: LoroDoc,
  rows: Awaited<ReturnType<typeof savedVersionFrontiers>>,
): NonNullable<FileReferenceReads['versions']> {
  let past: LoroDoc | null = null
  return {
    list: (holder) =>
      Promise.resolve(
        rows.filter((row) => row.documentId === holder.documentId).map((row) => row.id),
      ),
    // Through `then`, so a checkout that throws rejects the way an async read would.
    load: (holder, versionId) =>
      Promise.resolve().then(() => {
        const row = rows.find((candidate) => candidate.id === versionId)
        if (row === undefined) return null
        past ??= record.fork()
        past.checkout(decodeFrontiers(row.frontiers))
        return projectWorkspaceDocument(past, holder.documentId)
      }),
  }
}

/** What every workspace this browser keeps names, or why it cannot say. */
async function scanBrowserWorkspaces(
  workspaceIds: readonly string[],
  dbName: string | undefined,
): Promise<
  | { kind: 'scanned'; referenced: Set<string>; signatures: Map<string, string> }
  | { kind: 'stood-down'; reason: 'unreadable-record' | 'unjudged' }
> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const blobs = new IdbBlobStore(dbName)
  const referenced = new Set<string>()
  const signatures = new Map<string, string>()
  for (const workspaceId of workspaceIds) {
    const record = await docs.open(workspaceId).catch((err: unknown) => {
      log.warn('workspace record unreadable; file sweep stood down', { workspaceId, err })
      return undefined
    })
    if (record === undefined) return { kind: 'stood-down', reason: 'unreadable-record' }
    if (record === null) continue
    signatures.set(workspaceId, signatureOf(record))
    const rows = await savedVersionFrontiers(workspaceId, dbName)
    const scan = await scanFileReferences(record, {
      trashBytes: async (entry) => (await blobs.get({ ref: entry.blob }))?.bytes ?? null,
      versions: versionReads(record, rows),
      between: yieldToPage,
    })
    if (scan.unjudged.length > 0) {
      log.warn('file sweep stood down: part of a workspace could not be read', {
        workspaceId,
        unjudged: scan.unjudged.map((target) => target.kind),
      })
      return { kind: 'stood-down', reason: 'unjudged' }
    }
    for (const id of scan.referenced) referenced.add(id)
  }
  return { kind: 'scanned', referenced, signatures }
}

/** Whether every record the scan judged is still the record it judged. */
async function recordsUnmoved(
  before: readonly string[],
  signatures: ReadonlyMap<string, string>,
  dbName: string | undefined,
): Promise<boolean> {
  const keys = await storedRecordKeys(dbName)
  if (keys.join('\n') !== before.join('\n')) return false
  const docs = new BrowserWorkspaceDocs(dbName)
  for (const [workspaceId, signature] of signatures) {
    const record = await docs.open(workspaceId).catch(() => null)
    if (record === null || signatureOf(record) !== signature) return false
  }
  return true
}

export async function sweepUnreferencedFiles(
  options: BrowserFileSweepOptions = {},
): Promise<BrowserFileSweepResult> {
  const { dbName } = options
  const keys = await storedRecordKeys(dbName)
  if (keys.some((key) => workspaceIdOfStoredDocKey(key) === null)) {
    return { kind: 'stood-down', reason: 'unfolded-documents' }
  }
  const scan = await scanBrowserWorkspaces(browserKeptWorkspaceIds(keys), dbName)
  if (scan.kind === 'stood-down') return scan
  if (!(await recordsUnmoved(keys, scan.signatures, dbName))) {
    return { kind: 'stood-down', reason: 'record-moved' }
  }
  const createdBefore = (options.now ?? Date.now)() - (options.graceMs ?? DEFAULT_GRACE_MS)
  // A document names an image by its reference (`asset:<id>`), which is also
  // the key the editor stores it under; the scan answers the bare id.
  const keep = (fileId: string) =>
    scan.referenced.has(isImageRef(fileId) ? imageRefId(fileId) : fileId)
  const deleted = await new DocumentFileStore(new IdbBlobStore(dbName), dbName).sweep(
    keep,
    createdBefore,
  )
  return { kind: 'swept', deleted }
}
