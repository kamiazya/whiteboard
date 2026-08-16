import { createHash } from 'node:crypto'
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
import { cloneBytes } from './clone-bytes.js'

interface BlobRecord {
  readonly bytes: Uint8Array
  readonly contentType?: string
}

function digestHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function refKey(ref: BlobRef): string {
  return `${ref.algorithm}:${ref.digestHex}`
}

/**
 * In-memory `BlobStore` test double, content-addressed by a real sha-256
 * digest (not a stub/counter id) so `put` is deterministic across calls
 * with identical bytes, matching the real store's contract.
 */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, BlobRecord>()

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: digestHex(input.bytes) }
    if (!this.blobs.has(refKey(ref))) {
      this.blobs.set(refKey(ref), {
        bytes: cloneBytes(input.bytes),
        contentType: input.contentType,
      })
    }
    return { ref }
  }

  async get(input: BlobGetInput): Promise<BlobGetResult> {
    const record = this.blobs.get(refKey(input.ref))
    if (!record) {
      return null
    }
    return { bytes: cloneBytes(record.bytes), contentType: record.contentType }
  }

  async has(input: BlobHasInput): Promise<BlobHasResult> {
    return { exists: this.blobs.has(refKey(input.ref)) }
  }

  async delete(input: BlobDeleteInput): Promise<void> {
    this.blobs.delete(refKey(input.ref))
  }
}
