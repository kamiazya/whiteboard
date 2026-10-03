/**
 * What one tab tells the others about a browser-kept workspace record.
 *
 * Every tab of this origin opens the same IndexedDB record and edits its own
 * copy of it, so without this a tab never saw another's edit until a reload
 * (the CRDT merged them then, so nothing was lost — it was only invisible).
 * The daemon keeper answers the same need with its sync fan-out; this is the
 * browser's twin: a saved update goes to every other tab holding the record,
 * which merges it as a remote update, and a saved version is announced so
 * their history columns re-read.
 *
 * A channel per RECORD — the database name and the workspace id — because
 * that is what the bytes are an update to. The database name also keeps a
 * test file's channel apart from a neighbour's: vitest runs browser files in
 * same-origin iframes, and a channel scoped by workspace alone would carry one
 * file's updates into another's.
 *
 * Messages cross a realm boundary, so both directions go through the schema
 * (`app-web.md`'s SharedWorker rule, applied here for the same reason): a
 * field renamed on one side is a type error, not a message nobody handles.
 */
import {
  type VersionEntry,
  versionEntrySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { z } from 'zod'
import { whiteboardDbName } from './browser-idb.js'

const workspaceBroadcastSchema = z.discriminatedUnion('type', [
  // Bytes a tab has already persisted: a receiver merges them and must not
  // save them again, since the record already holds them.
  z.object({
    type: z.literal('update'),
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  }),
  z.object({
    type: z.literal('version-created'),
    documentId: z.string().min(1),
    version: versionEntrySchema,
  }),
  // A document, and everything below it, now lives at `to`.
  z.object({
    type: z.literal('document-moved'),
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  z.object({
    type: z.literal('document-removed'),
    path: z.string().min(1),
  }),
  // A deleted document is back at `path`, under the documentId it had.
  z.object({
    type: z.literal('document-restored'),
    path: z.string().min(1),
  }),
])

export type WorkspaceBroadcast = z.infer<typeof workspaceBroadcastSchema>

function channelName(workspaceId: string): string {
  return `whiteboard:${whiteboardDbName()}:workspace:${workspaceId}`
}

/**
 * A connection's end of the channel, closed with the connection. Posting
 * through it reaches every OTHER end: a sending object never receives its
 * own message, which is what keeps a tab from merging its own edit twice.
 */
export interface WorkspaceBroadcastEnd {
  post(message: WorkspaceBroadcast): void
  close(): void
}

export function listenToWorkspace(
  workspaceId: string,
  onMessage: (message: WorkspaceBroadcast) => void,
): WorkspaceBroadcastEnd {
  if (typeof BroadcastChannel === 'undefined') return { post() {}, close() {} }
  const channel = new BroadcastChannel(channelName(workspaceId))
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const parsed = workspaceBroadcastSchema.safeParse(event.data)
    if (parsed.success) onMessage(parsed.data)
  }
  return {
    post: (message) => channel.postMessage(workspaceBroadcastSchema.parse(message)),
    close: () => channel.close(),
  }
}

/**
 * Posts one message to every end on the record, THIS tab's included. A fresh
 * channel rather than a connection's, since a sending object never hears
 * itself — and so the page that caused the change is told as well as the
 * other tabs.
 */
function announce(workspaceId: string, message: WorkspaceBroadcast): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(channelName(workspaceId))
  channel.postMessage(workspaceBroadcastSchema.parse(message))
  channel.close()
}

/** A saved version, so the page that saved it re-reads its own history column. */
export function announceVersion(
  workspaceId: string,
  documentId: string,
  version: VersionEntry,
): void {
  announce(workspaceId, { type: 'version-created', documentId, version })
}

/**
 * A document changed path. Pending work keyed by the old path — an automatic
 * checkpoint inside its quiet window — would otherwise fail against a path
 * that no longer resolves.
 */
export function announceDocumentMoved(workspaceId: string, from: string, to: string): void {
  announce(workspaceId, { type: 'document-moved', from, to })
}

export function announceDocumentRemoved(workspaceId: string, path: string): void {
  announce(workspaceId, { type: 'document-removed', path })
}

/**
 * A document is back from the trash. A page held open on it nulled its path
 * when it was deleted and would otherwise arm nothing for the rest of its life.
 */
export function announceDocumentRestored(workspaceId: string, path: string): void {
  announce(workspaceId, { type: 'document-restored', path })
}
