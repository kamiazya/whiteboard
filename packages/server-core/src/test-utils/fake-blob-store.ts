import type { BlobGetResult, BlobPutInput, BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'

/**
 * A content-addressed store in memory, hashing the way the daemon's does, so
 * a test can tell bytes stored under the digest a trash entry names from bytes
 * stored under any other.
 */
export class FakeBlobStore implements BlobStore {
  readonly held = new Map<string, Uint8Array<ArrayBuffer>>()
  private readonly types = new Map<string, string>()

  async put(input: BlobPutInput): Promise<{ ref: BlobRef }> {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(input.bytes)),
    )
    const digestHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    this.held.set(digestHex, new Uint8Array(input.bytes))
    if (input.contentType === undefined) this.types.delete(digestHex)
    else this.types.set(digestHex, input.contentType)
    return { ref: { algorithm: 'sha-256', digestHex } }
  }
  async get(input: { ref: BlobRef }): Promise<BlobGetResult> {
    const bytes = this.held.get(input.ref.digestHex)
    if (bytes === undefined) return null
    const contentType = this.types.get(input.ref.digestHex)
    return contentType === undefined ? { bytes } : { bytes, contentType }
  }
  async has(input: { ref: BlobRef }) {
    return { exists: this.held.has(input.ref.digestHex) }
  }
  async delete(input: { ref: BlobRef }) {
    this.held.delete(input.ref.digestHex)
    this.types.delete(input.ref.digestHex)
  }
}
