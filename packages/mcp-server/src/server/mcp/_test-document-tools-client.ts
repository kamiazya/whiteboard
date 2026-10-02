import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { InMemoryVersionHistory } from '../../shared/test-utils/in-memory-version-history.js'
import type { ListedTool } from '../../shared/test-utils/tool-surface-metrics.js'
import { liveDocuments } from '../store/live-documents.js'
import { registerDocumentTools } from './document-tools.js'

/**
 * A real McpServer with the document tools registered, and a client over an
 * in-memory transport: `tools/list` is what a client receives, and a call goes
 * through the same validation and annotations a connected host sees.
 */
export async function connectDocumentTools(): Promise<{
  client: Client
  tools: readonly ListedTool[]
}> {
  const server = new McpServer({ name: 'whiteboard-surface', version: '0.0.0' })
  // Only `tools/list` is read by most callers, which touches no seam: the
  // version history is the one seam a registration reaches at construction,
  // and the rest are stated absent rather than faked with no behaviour.
  registerDocumentTools(server, {
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    versions: new InMemoryVersionHistory(),
    // The daemon's own seam: every mutating tool takes its write lock.
    liveDocuments: liveDocuments(),
    facetRegistry: bundledFacetRegistry,
  } as never)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'surface', version: '0.0.0' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  return { client, tools: tools as readonly ListedTool[] }
}
