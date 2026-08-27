// registerDocumentTools flattened bodyPatchInputSchema's discriminated union
// into a raw shape via Object.assign, which is last-wins: `mode` collapsed to
// z.literal('range') and BOTH `body` and `range` became required, so the
// schema the SDK actually validated against was satisfiable by neither arm.
// These tests drive a real McpServer + Client over an in-memory transport,
// the same pattern serve-stdio-eras.test.ts uses, so the SDK's own argument
// validation is what judges the payload rather than a restatement of it.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

const CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'line0\nline1\nline2' },
  ],
  edges: [],
}

async function connectedClient() {
  const documentStore = new InMemoryDocumentStore()
  const documentIndex = new InMemoryDocumentIndex()
  documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'spatial',
  })

  const seedDoc = makeSpatialDoc(CANVAS)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })

  const server = new McpServer({ name: 'whiteboard-test', version: '0.0.0' })
  registerDocumentTools(server, { documentStore, blobStore: {} as never, documentIndex })

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'body-patch-registration-test', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, server }
}

describe('wb_body_patch registration', () => {
  let harness: Awaited<ReturnType<typeof connectedClient>>

  beforeEach(async () => {
    harness = await connectedClient()
  })

  afterEach(async () => {
    await harness.client.close().catch(() => {})
    await harness.server.close().catch(() => {})
  })

  /** Patches the seeded node; only the arm-specific arguments vary per test. */
  const patch = (args: Record<string, unknown>) =>
    harness.client.callTool({
      name: 'wb_body_patch',
      arguments: { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, nodeId: 'n1', ...args },
    })
  const patchedText = (res: { structuredContent?: unknown }) =>
    (res.structuredContent as { node?: { text?: string } } | undefined)?.node?.text

  it('accepts the full-arm payload the real schema accepts', async () => {
    const res = await patch({ mode: 'full', body: 'replaced whole body' })
    expect(res.isError, JSON.stringify(res)).not.toBe(true)
    expect(patchedText(res)).toBe('replaced whole body')
  })

  it('accepts the range-arm payload the real schema accepts', async () => {
    const res = await patch({
      mode: 'range',
      range: { startLine: 1, endLine: 1, replacement: 'patched' },
    })
    expect(res.isError, JSON.stringify(res)).not.toBe(true)
    expect(patchedText(res)).toBe('line0\npatched\nline2')
  })

  it('rejects a full-arm payload that also carries range (cross-arm exclusivity)', async () => {
    const res = await patch({
      mode: 'full',
      body: 'x',
      range: { startLine: 0, endLine: 0, replacement: 'y' },
    })
    expect(res.isError).toBe(true)
  })

  it('rejects a range-mode payload missing range', async () => {
    const res = await patch({ mode: 'range' })
    expect(res.isError).toBe(true)
  })
})
