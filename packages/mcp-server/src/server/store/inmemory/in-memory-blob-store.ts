import type {
  BlobDeleteInput,
  BlobGetInput,
  BlobGetResult,
  BlobHasInput,
  BlobHasResult,
  BlobPutInput,
  BlobPutResult,
  BlobRef,
  BlobStore,
} from '@kamiazya/whiteboard-ports'
import { blobRefKey } from '@kamiazya/whiteboard-ports'
import { sha256Hex } from '../../../shared/sha256.js'
import { cloneBytes } from './clone-bytes.js'

interface BlobRecord {
  readonly bytes: Uint8Array
  readonly contentType?: string
}

/**
 * In-memory `BlobStore` test double, content-addressed by a real sha-256
 * digest (not a stub/counter id) so `put` is deterministic across calls
 * with identical bytes, matching the real store's contract.
 */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, BlobRecord>()

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: sha256Hex(input.bytes) }
    if (!this.blobs.has(blobRefKey(ref))) {
      this.blobs.set(blobRefKey(ref), {
        bytes: cloneBytes(input.bytes),
        contentType: input.contentType,
      })
    }
    return { ref }
  }

  async get(input: BlobGetInput): Promise<BlobGetResult> {
    const record = this.blobs.get(blobRefKey(input.ref))
    if (!record) {
      return null
    }
    return { bytes: cloneBytes(record.bytes), contentType: record.contentType }
  }

  async has(input: BlobHasInput): Promise<BlobHasResult> {
    return { exists: this.blobs.has(blobRefKey(input.ref)) }
  }

  async delete(input: BlobDeleteInput): Promise<void> {
    this.blobs.delete(blobRefKey(input.ref))
  }
}
