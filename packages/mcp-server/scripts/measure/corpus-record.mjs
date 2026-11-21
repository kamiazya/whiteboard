/**
 * Snapshot bytes of a workspace record holding N markdown documents of real
 * prose, built through the real write path from the repo's own `docs/` and
 * replicated to reach the count. Shared by the lease measurements so each
 * measures the same record.
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

export async function corpusSnapshot(count) {
  const { LoroDoc } = require('loro-crdt')
  const adapter = await import('@kamiazya/whiteboard-loro-adapter')
  const { loadDocsCorpus } = await import('../../src/server/search/docs-corpus.ts')
  const corpus = loadDocsCorpus(REPO_ROOT)
  const record = new LoroDoc()
  record.setPeerId(1n)
  for (let i = 0; i < count; i += 1) {
    const doc = corpus[i % corpus.length]
    const documentId = `01ARZ3NDEKTSV4RRFF${String(i).padStart(8, '0')}`
    adapter.createWorkspaceDocumentAtPath(record, {
      path: `copy${Math.floor(i / corpus.length)}/${doc.path}`,
      documentId,
      kind: 'markdown',
    })
    adapter.writeMarkdownBody(adapter.documentContainers(record, documentId), doc.body)
  }
  record.commit()
  return {
    bytes: new Uint8Array(record.export({ mode: 'snapshot' })),
    documentIds: [...Array(count).keys()].map(
      (i) => `01ARZ3NDEKTSV4RRFF${String(i).padStart(8, '0')}`,
    ),
  }
}
