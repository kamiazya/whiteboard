import type { BlobStore } from '@kamiazya/whiteboard-ports'

/**
 * A `BlobStore` that REFUSES rather than answers, for a test whose subject
 * is something else — the idiom of `unusedLiveDocuments`: a no-op double
 * would let a test that reaches blob storage by accident (a sync update
 * that removes a document stores its bytes for the trash) pass while
 * asserting nothing about it.
 *
 * A test that means to store blobs passes `FakeBlobStore`.
 */
export function unusedBlobStore(): BlobStore {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `BlobStore.${method} was called by a test that passed unusedBlobStore().` +
        ' Pass a FakeBlobStore if the test is about stored blobs.',
    )
  }
  return { put: refuse('put'), get: refuse('get'), has: refuse('has'), delete: refuse('delete') }
}
