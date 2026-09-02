import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import type { ServerDeps } from '../server-deps.js'
import { ignoredDocumentWrites } from './ignored-document-writes.js'
import { createInMemoryDocumentStore } from './in-memory-document-store.js'
import { unusedDocumentTeardown } from './unused-document-teardown.js'
import { unusedLiveDocuments } from './unused-live-documents.js'
import { unusedVersionHistory } from './unused-version-history.js'

/**
 * The `ServerDeps` a server-core test builds when its subject is something
 * else — one definition instead of twenty-six copies of the same literal.
 *
 * It exists because of what a REQUIRED seam costs without it. ADR-0018
 * requires seams to be required rather than optional, and lists
 * "`ServerDeps` is a merge-contended file" as an accepted consequence. That
 * contention is not inherent: measured on the next seam this burn-down
 * needs, adding one required field produced **310 compile errors across 26
 * test files**, none of which had any interest in the field. With this,
 * the same field is one line here.
 *
 * The defaults are deliberately the REFUSING doubles, not no-ops.
 * `unusedDocumentTeardown()` throws, so a test whose subject is the
 * teardown has to pass a real one and cannot pass by accident — the same
 * reason `unused-document-teardown.ts` gives for existing. A convenience
 * factory that quietly satisfied every seam would turn every one of these
 * tests into a test of nothing.
 *
 * `blobStore` is `{} as never` because no caller here touches it, and
 * saying so with a cast is more honest than a fake with no behaviour
 * behind it.
 *
 * Pass `overrides` for whatever the test is actually about. The coupled
 * shape — a `FakeDocumentStore` that carries its own index — spells both
 * out, since a factory that reached into the store for an index would be
 * guessing which of two unrelated fields the caller meant:
 *
 * ```ts
 * makeTestDeps({ documentStore, documentIndex: documentStore.documentIndex })
 * ```
 */
export function makeTestDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    documentTeardown: unusedDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
    versions: unusedVersionHistory(),
    liveDocuments: unusedLiveDocuments(),
    ...overrides,
  }
}
