// What a REFUSED `wb_canvas_edit` op tells the model, measured where the
// model reads it: through a real McpServer + Client over an in-memory
// transport, so the SDK's own argument validation is what answers rather
// than a restatement of the schema in a unit test.
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { InMemoryVersionHistory } from '../../shared/test-utils/in-memory-version-history.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'whiteboard-refusal', version: '0.0.0' })
  registerDocumentTools(server, {
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    versions: new InMemoryVersionHistory(),
  } as never)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'refusal', version: '0.0.0' })
  await client.connect(clientSide)
  return client
}

const firstText = (result: { content?: unknown }): string => {
  const content = result.content as { type?: string; text?: string }[] | undefined
  return content?.find((block) => block.type === 'text')?.text ?? ''
}

describe('wb_canvas_edit — a misplaced draft key', () => {
  it('reaches the model as a sentence naming where the key belongs', async () => {
    // One op failing validation refuses the whole CALL, so a model that
    // writes `id` beside `op` — where the other node ops take it — loses
    // every other op in the batch to `Unrecognized key: "id"`. The key it
    // named was never the missing fact.
    const client = await connect()
    const refused = await client.callTool({
      name: 'wb_canvas_edit',
      arguments: {
        workspaceId: 'ws-1',
        documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
        ops: [
          {
            op: 'node.add',
            id: 'hub',
            node: { type: 'text', text: 'Hub', x: 0, y: 0, width: 200, height: 80 },
          },
        ],
      },
    })
    const text = firstText(refused)
    expect(text).toContain('"id"')
    expect(text).toContain('inside `node`')
    await client.close()
  })
})
