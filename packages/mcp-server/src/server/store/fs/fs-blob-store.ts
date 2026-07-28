import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
} from '@kamiazya/whiteboard-canvas-ports'
import { getLogger } from '../../log.js'
import { isMissingFileError } from '../corrupt-stored-data.js'
import { assertPathWithinDir } from '../path-guard.js'

const log = getLogger('fs-blob-store')

// Blob content and content-type share the same address, so both are
// written as one JSON envelope rather than two files — avoids a dangling
// content-type file if a process crashes between two separate writes.
interface BlobEnvelope {
  readonly bytesBase64: string
  readonly contentType?: string
}

function digestHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Filesystem-backed, content-addressed `BlobStore`. Bytes are stored under
 * `<baseDir>/blobs/<first2Hex>/<remaining62Hex>` — sharding by hash prefix
 * keeps any single directory from accumulating one entry per distinct blob
 * ever stored. Identical bytes always resolve to the same path, so `put`
 * is naturally idempotent/deduplicating.
 */
export class FsBlobStore implements BlobStore {
  private readonly blobsDir: string

  constructor(baseDir: string) {
    this.blobsDir = join(baseDir, 'blobs')
  }

  private shardDirForRef(ref: BlobRef): string {
    const shard = ref.digestHex.slice(0, 2)
    return assertPathWithinDir(join(this.blobsDir, shard), this.blobsDir, 'blob shard dir')
  }

  private pathForRef(ref: BlobRef): string {
    const rest = ref.digestHex.slice(2)
    return assertPathWithinDir(join(this.shardDirForRef(ref), rest), this.blobsDir, 'blob path')
  }

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: digestHex(input.bytes) }
    const filePath = this.pathForRef(ref)
    const envelope: BlobEnvelope = {
      bytesBase64: Buffer.from(input.bytes).toString('base64'),
      contentType: input.contentType,
    }
    await mkdir(this.shardDirForRef(ref), { recursive: true })
    await writeFile(filePath, JSON.stringify(envelope), 'utf8')
    return { ref }
  }

  async get(input: BlobGetInput): Promise<BlobGetResult> {
    const filePath = this.pathForRef(input.ref)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (isMissingFileError(err)) {
        return null
      }
      throw err
    }
    const envelope = JSON.parse(raw) as BlobEnvelope
    return {
      bytes: new Uint8Array(Buffer.from(envelope.bytesBase64, 'base64')),
      contentType: envelope.contentType,
    }
  }

  async has(input: BlobHasInput): Promise<BlobHasResult> {
    const result = await this.get(input)
    return { exists: result !== null }
  }

  async delete(input: BlobDeleteInput): Promise<void> {
    const filePath = this.pathForRef(input.ref)
    try {
      await rm(filePath)
    } catch (err) {
      if (isMissingFileError(err)) {
        return
      }
      log.warning({ digestHex: input.ref.digestHex, err }, 'failed to delete blob')
      throw err
    }
  }
}
