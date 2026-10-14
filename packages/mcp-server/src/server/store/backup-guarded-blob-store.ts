import type {
  BlobDeleteInput,
  BlobGetInput,
  BlobGetResult,
  BlobHasInput,
  BlobHasResult,
  BlobPutInput,
  BlobPutResult,
  BlobStore,
} from '@kamiazya/whiteboard-ports'
import { blobRefKey } from '@kamiazya/whiteboard-ports'
import { blobsRoot } from '../tenant/data-layout.js'
import { backupIsInProgress } from './backup-in-progress.js'
import { FsBlobStore } from './fs/fs-blob-store.js'

/**
 * Deletes this process has accepted but not yet applied, per blobs directory.
 * Module-level because the daemon builds a fresh store per tree-index call:
 * a queue on the instance would be stranded with it.
 */
const deferredByDir = new Map<string, Map<string, BlobDeleteInput>>()

/**
 * The daemon's blob store: a delete while a backup assembles the data
 * directory is deferred until the backup is done, rather than refused.
 *
 * A backup takes the rows as a snapshot and mirrors the blobs afterwards, so
 * a trash restore or purge between the two leaves a backup whose rows name
 * bytes its mirror lacks. Enforcing that here rather than in each deleter is
 * what lets the shared tree index stay ignorant of the marker. Deferring,
 * not refusing, because a refusal would fail a restore after its row had
 * already been saved.
 *
 * A deferred blob reads as deleted at once, so the store still honours the
 * port. A put of the same bytes cancels the deferral (the store is
 * content-addressed, so those bytes are wanted again). The queue drains on
 * the next call of any method once the marker is gone; there is no timer, as
 * the marker's writer is another process with no hook to call.
 *
 * ponytail: in-memory queue, so a restart drops it and the bytes stay on disk
 * with no row naming them. Nothing collects orphan blobs today; that is the
 * same cost a crash between a restore's save and its delete already has.
 *
 * ponytail: a delete reads the blob before unlinking it so it can put the
 * bytes back if a backup began during the unlink — one extra read per delete,
 * paid only by trash purge and restore. What stays open is a mirror that
 * copies the blobs directory between the unlink and the put-back; a lock the
 * backup process could take is what would close it.
 */
export class BackupGuardedBlobStore implements BlobStore {
  readonly #deferred: Map<string, BlobDeleteInput>

  constructor(
    private readonly inner: BlobStore,
    private readonly dataDir: string,
    blobsDir: string,
  ) {
    let deferred = deferredByDir.get(blobsDir)
    if (deferred === undefined) {
      deferred = new Map()
      deferredByDir.set(blobsDir, deferred)
    }
    this.#deferred = deferred
  }

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    await this.#drain()
    const result = await this.inner.put(input)
    this.#deferred.delete(blobRefKey(result.ref))
    return result
  }

  async get(input: BlobGetInput): Promise<BlobGetResult> {
    await this.#drain()
    if (this.#deferred.has(blobRefKey(input.ref))) return null
    return this.inner.get(input)
  }

  async has(input: BlobHasInput): Promise<BlobHasResult> {
    await this.#drain()
    if (this.#deferred.has(blobRefKey(input.ref))) return { exists: false }
    return this.inner.has(input)
  }

  async delete(input: BlobDeleteInput): Promise<void> {
    if (await backupIsInProgress(this.dataDir)) {
      this.#deferred.set(blobRefKey(input.ref), input)
      return
    }
    await this.#drain()
    // A backup can write its marker between the check above and the unlink,
    // so the bytes are held across it and the marker asked again: if one
    // started meanwhile, the blob goes back and the delete joins the queue.
    const held = await this.inner.get(input)
    await this.inner.delete(input)
    if (held !== null && (await backupIsInProgress(this.dataDir))) {
      await this.inner.put(held)
      this.#deferred.set(blobRefKey(input.ref), input)
    }
  }

  async #drain(): Promise<void> {
    if (this.#deferred.size === 0 || (await backupIsInProgress(this.dataDir))) return
    // Taken off the queue before the delete, so a concurrent drain cannot
    // apply one twice; a delete that throws goes back for the next drain.
    // Iterated over a snapshot: a delete queued mid-drain was accepted under
    // a backup that may have started since the marker check, so it waits for
    // the next drain instead of being unlinked here. Sequential so each
    // failure is put back and the first one rethrown.
    for (const [key, input] of [...this.#deferred]) {
      if (!this.#deferred.delete(key)) continue
      try {
        await this.inner.delete(input)
      } catch (err) {
        this.#deferred.set(key, input)
        throw err
      }
    }
  }
}

/** One tenant's blob store as the daemon serves it. */
export function daemonBlobStore(dataDir: string, tenantId: string): BlobStore {
  const blobsDir = blobsRoot(dataDir, tenantId)
  return new BackupGuardedBlobStore(new FsBlobStore(blobsDir, dataDir), dataDir, blobsDir)
}
