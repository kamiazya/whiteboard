import type { BlobGetResult, BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'

/**
 * A content-addressed store in memory, hashing the way the daemon's does, so
 * a test can tell bytes stored under the digest a trash entry names from bytes
 * stored under any other.
 */
export class FakeBlobStore implements BlobStore {
  readonly held = new Map<string, Uint8Array<ArrayBuffer>>()

  async put(input: { bytes: Uint8Array }): Promise<{ ref: BlobRef }> {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(input.bytes)),
    )
    const digestHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    this.held.set(digestHex, new Uint8Array(input.bytes))
    return { ref: { algorithm: 'sha-256', digestHex } }
  }
  async get(input: { ref: BlobRef }): Promise<BlobGetResult> {
    const bytes = this.held.get(input.ref.digestHex)
    return bytes === undefined ? null : { bytes }
  }
  async has(input: { ref: BlobRef }) {
    return { exists: this.held.has(input.ref.digestHex) }
  }
  async delete(input: { ref: BlobRef }) {
    this.held.delete(input.ref.digestHex)
  }
}
