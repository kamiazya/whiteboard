import { uint8ArrayAnyRealmSchema } from '@kamiazya/whiteboard-model'
import { whiteboardDbName } from './browser-idb.js'

/**
 * Updates a Browser-kept document has been handed and its save has not yet
 * landed, written to IndexedDB at the moment they are handed over.
 *
 * Why it exists: a tab closed or reloaded inside the save's asynchronous chain
 * (the write queue, the import, the incremental save's reads) is torn down
 * before that chain reaches the store, and the keystrokes in it are lost.
 * Measured in Chromium with the page closed 0, 50, 100 and 300 ms after
 * typing: none of ten survived at any of them. A `put` issued synchronously
 * inside the call survived every close that was tried.
 *
 * So the put is issued without awaiting, on a connection opened beforehand
 * (an `open` cannot be waited for at that moment), and deleted once the main
 * save lands. A connect finds what a closed tab left and replays it through
 * the same import; importing is idempotent, so an entry whose save did land
 * is a no-op.
 *
 * A database of its own rather than a store of the whiteboard one: that
 * schema is a single baseline that older versions are refused against, and a
 * log that every build can ignore should not cost anyone their data's version.
 *
 * Best effort, and says so: an update past `MAX_PENDING_BYTES`, or any time the
 * connection is not open or the put throws, takes today's path alone.
 */
const STORE = 'pending'

/** Past this an update is not logged: a delta this large is a paste or an import, and the put is synchronous. */
export const MAX_PENDING_BYTES = 1024 * 1024

/**
 * An entry's key: the workspace, the document, an order within this page, and
 * this page's own id — two tabs writing in the same millisecond with the same
 * count would otherwise overwrite each other's entry.
 */
export type PendingKey = readonly [
  workspaceId: string,
  documentId: string,
  at: number,
  n: number,
  page: string,
]

export interface PendingUpdate {
  readonly key: PendingKey
  readonly bytes: Uint8Array
}

let counter = 0
const PAGE = crypto.randomUUID()

export class PendingUpdates {
  private db: IDBDatabase | null = null
  private opening: Promise<void> | null = null

  constructor(private readonly dbName: string = `${whiteboardDbName()}-pending`) {}

  /** Opens the connection `put` needs; resolves either way, since a log that cannot open is a log that is off. */
  open(): Promise<void> {
    if (typeof indexedDB === 'undefined') return Promise.resolve()
    this.opening ??= new Promise<void>((resolve) => {
      const req = indexedDB.open(this.dbName, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => {
        this.db = req.result
        this.db.onversionchange = () => this.close()
        resolve()
      }
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    })
    return this.opening
  }

  /** Issues the put and returns without waiting for it; `null` when it was not logged. */
  put(workspaceId: string, documentId: string, bytes: Uint8Array): PendingKey | null {
    if (this.db === null || bytes.length === 0 || bytes.length > MAX_PENDING_BYTES) return null
    counter += 1
    const key: PendingKey = [workspaceId, documentId, Date.now(), counter, PAGE]
    try {
      const tx = this.db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(bytes, key as unknown as IDBValidKey)
      tx.onerror = () => {}
      return key
    } catch {
      return null
    }
  }

  /** Forgets one entry, once the save it was waiting on has landed. */
  remove(key: PendingKey): void {
    if (this.db === null) return
    try {
      this.db
        .transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .delete(key as unknown as IDBValidKey)
    } catch {
      // A leftover entry is replayed, and replaying one that landed is a no-op.
    }
  }

  /** What a closed tab left for one document, oldest first. */
  async list(workspaceId: string, documentId: string): Promise<PendingUpdate[]> {
    await this.open()
    const db = this.db
    if (db === null) return []
    const range = IDBKeyRange.bound([workspaceId, documentId], [
      workspaceId,
      documentId,
      [],
    ] as unknown as IDBValidKey)
    return new Promise<PendingUpdate[]>((resolve) => {
      const found: PendingUpdate[] = []
      const req = db.transaction(STORE).objectStore(STORE).openCursor(range)
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor === null) {
          resolve(found)
          return
        }
        const bytes = uint8ArrayAnyRealmSchema.safeParse(cursor.value)
        if (bytes.success)
          found.push({ key: cursor.key as unknown as PendingKey, bytes: bytes.data })
        cursor.continue()
      }
      req.onerror = () => resolve(found)
    })
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.opening = null
  }
}
