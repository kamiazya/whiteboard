import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
} from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { getLogger } from '../../log.js'
import { corruptStoredData, isMissingFileError } from '../corrupt-stored-data.js'
import { assertPathWithinDir } from '../path-guard.js'

const log = getLogger('fs-blob-store')

// Blob content and content-type share the same address, so both are
// written as one JSON envelope rather than two files — avoids a dangling
// content-type file if a process crashes between two separate writes.
const blobEnvelopeSchema = z.object({
  bytesBase64: z.string(),
  contentType: z.string().optional(),
})

type BlobEnvelope = z.infer<typeof blobEnvelopeSchema>

function digestHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

/**
 * Filesystem-backed, content-addressed `BlobStore`. Bytes are stored under
 * `<baseDir>/blobs/<first2Hex>/<remaining62Hex>` — sharding by hash prefix
 * keeps any single directory from accumulating one entry per distinct blob
 * ever stored. Identical bytes always resolve to the same path, so `put`
 * is naturally idempotent/deduplicating.
 */
/**
 * Where a blob's bytes sit between being written and being renamed into
 * place. Top-level rather than inside a shard, so excluding it from a backup
 * is one path rather than a filename pattern two modules have to agree on —
 * and it is the same filesystem either way, which is all `rename` requires.
 *
 * Nothing here is content: these are mid-flight bytes under a name no digest
 * matches, and a copy of one resolves to nothing.
 */
export const BLOB_TEMP_DIRNAME = '.blob-tmp'

export class FsBlobStore implements BlobStore {
  private readonly blobsDir: string
  private readonly tempDir: string

  constructor(baseDir: string) {
    this.blobsDir = join(baseDir, 'blobs')
    this.tempDir = join(baseDir, BLOB_TEMP_DIRNAME)
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
    const shardDir = this.shardDirForRef(ref)
    await mkdir(shardDir, { recursive: true })

    // Write beside the target, then rename onto it. `rename` within one
    // directory is atomic, so a reader sees either the previous complete blob
    // or the new one, never a partial.
    //
    // A plain `writeFile` opens with O_TRUNC and leaves the blob short for
    // the whole duration of the write. That matters here more than it looks:
    // the store is content-addressed, so `put` is idempotent by design and
    // REWRITING an existing blob is ordinary — re-uploading an image, or two
    // people uploading the same file, does it. Measured on a 6 MiB blob, 8
    // reads issued during 8 such rewrites: every one threw on a truncated
    // envelope. The bytes are identical either side; only the window is the
    // problem.
    //
    // It is also what stands between us and a backup taken without stopping
    // the server (ADR-0021 decision 3): 12 of 12 directory copies overlapping
    // a rewrite captured a truncated file.
    await mkdir(this.tempDir, { recursive: true })
    const tempPath = join(this.tempDir, `${ref.digestHex}.${randomUUID()}`)
    try {
      await writeFile(tempPath, JSON.stringify(envelope), 'utf8')
      await rename(tempPath, filePath)
    } catch (err) {
      // Never leave a temp file behind: file-GC walks this directory by
      // digest name and an orphan matches nothing it can reason about.
      await rm(tempPath, { force: true }).catch(() => {})
      throw err
    }
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
    let envelope: BlobEnvelope
    try {
      envelope = blobEnvelopeSchema.parse(JSON.parse(raw))
    } catch (err) {
      throw corruptStoredData(filePath, `invalid blob envelope (${errorMessage(err)})`)
    }
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
