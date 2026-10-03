import { FakeVersionHistory } from '@kamiazya/whiteboard-server-core/test-utils/fake-version-history'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { liveDocuments } from '../store/live-documents.js'
import { registerDocumentTools } from './document-tools.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

/**
 * A mistyped workspace or document is the commonest failure a model has, and
 * the refusal is the only place the right next step can reach it: an agent
 * installed without the skills has no other source. So every tool answers it
 * in the vocabulary of what the caller was doing, and none of them answers a
 * read with advice to ADD something or names a retired noun.
 */

const WORKSPACE_ID = '01M162AQMVCNXR7J9X636HBA5J'
const SEGMENT = 'proj'
const UNKNOWN_WORKSPACE = 'nope'
const UNKNOWN_DOCUMENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const textNode = { type: 'text', text: 'x', x: 0, y: 0, width: 100, height: 50 }

/** Arguments that are valid for each tool except for the two addresses under test. */
const CALLS: Record<
  (typeof ALL_REGISTERED_TOOLS)[number],
  (workspaceId: string, documentId: string) => Record<string, unknown>
> = {
  wb_facet_list: (workspaceId) => ({ workspaceId }),
  wb_facet_set: (workspaceId, documentId) => ({
    workspaceId,
    documentIds: [documentId],
    tags: { add: ['a'] },
  }),
  wb_document_search: (workspaceId) => ({ workspaceId, query: 'x' }),
  wb_document_list: (workspaceId) => ({ workspaceId }),
  wb_document_get: (workspaceId, documentId) => ({ workspaceId, documentIds: [documentId] }),
  wb_canvas_snapshot: (workspaceId, documentId) => ({ workspaceId, documentId }),
  wb_scene_render: (workspaceId, documentId) => ({ workspaceId, documentId }),
  canvas_view: (workspaceId, documentId) => ({ workspaceId, documentId }),
  wb_viewport_set: (workspaceId, documentId) => ({
    workspaceId,
    documentId,
    mode: 'fit',
    elementIds: ['n1'],
  }),
  wb_canvas_edit: (workspaceId, documentId) => ({
    workspaceId,
    documentId,
    mode: 'apply',
    ops: [{ op: 'node.add', node: textNode }],
  }),
  wb_thread_edit: (workspaceId, documentId) => ({
    workspaceId,
    documentId,
    ops: [{ op: 'thread.add', anchor: { kind: 'document' }, body: 'hi' }],
  }),
  wb_body_edit: (workspaceId, documentId) => ({
    workspaceId,
    documentId,
    mode: 'apply',
    ops: [
      {
        id: '1',
        op: 'body.replace',
        anchor: { kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 },
        text: 'y',
        assumed: 'x',
      },
    ],
  }),
  wb_version_save: (workspaceId, documentId) => ({
    workspaceId,
    documentIds: [documentId],
    label: 'l',
  }),
  wb_version_list: (workspaceId, documentId) => ({ workspaceId, documentId }),
  wb_version_restore: (workspaceId, documentId) => ({
    workspaceId,
    documentId,
    versionId: 'v',
  }),
  wb_workspace_edit: (workspaceId, documentId) => ({
    workspaceId,
    ops: [{ op: 'document.delete', documentId }],
  }),
}

// A read has no `createWorkspace` to pass; the tool that takes one may say so.
const TAKES_CREATE_WORKSPACE = new Set<string>(['wb_workspace_edit'])

async function connect() {
  const deps = {
    ...resolveServerDeps(createContainer(storeMemoryModule)),
    versions: new FakeVersionHistory(),
    liveDocuments: liveDocuments(),
    knownWorkspaceHandles: async () => [SEGMENT],
  }
  await deps.documentIndex.createWorkspace({ workspaceId: WORKSPACE_ID, segment: SEGMENT })
  const server = new McpServer({ name: 'refusals', version: '0.0.0' })
  registerDocumentTools(server, deps as never)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'refusals', version: '0.0.0' })
  await client.connect(clientSide)
  return client
}

/** The text a model reads: the refusal, or a `failed` entry of a call that went through. */
async function modelVisibleRefusal(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; refused: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const refused = result.isError === true
  return { text: JSON.stringify(refused ? result.content : result.structuredContent), refused }
}

describe('a tool refused for an address that names nothing', () => {
  it('covers every registered tool', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
  })

  it.each(
    ALL_REGISTERED_TOOLS,
  )('%s answers an unknown workspace with the workspace that is missing and the ones that exist', async (name) => {
    const client = await connect()
    const { text } = await modelVisibleRefusal(
      client,
      name,
      CALLS[name](UNKNOWN_WORKSPACE, UNKNOWN_DOCUMENT),
    )

    expect(text).toContain(`Workspace not found: \\"${UNKNOWN_WORKSPACE}\\"`)
    expect(text).toContain(`Workspaces here: \\"${SEGMENT}\\"`)
    if (!TAKES_CREATE_WORKSPACE.has(name)) expect(text).not.toContain('Create it before adding')
    expect(text).not.toMatch(/Canvas/)
  })

  it('offers createWorkspace to the one call that can carry it, and only to a batch that creates', async () => {
    const client = await connect()
    const creating = await modelVisibleRefusal(client, 'wb_workspace_edit', {
      workspaceId: UNKNOWN_WORKSPACE,
      ops: [{ op: 'document.create', path: 'a', kind: 'spatial' }],
    })
    const deleting = await modelVisibleRefusal(
      client,
      'wb_workspace_edit',
      CALLS.wb_workspace_edit(UNKNOWN_WORKSPACE, UNKNOWN_DOCUMENT),
    )

    expect(creating.refused).toBe(true)
    expect(creating.text).toContain('Pass createWorkspace: true on this wb_workspace_edit call')
    expect(deleting.refused).toBe(true)
    expect(deleting.text).not.toContain('Pass createWorkspace: true on this wb_workspace_edit call')
  })

  it.each(
    ALL_REGISTERED_TOOLS.filter(
      (name) => !['wb_facet_list', 'wb_document_search', 'wb_document_list'].includes(name),
    ),
  )('%s answers an unknown document with the id and workspace handle the caller gave', async (name) => {
    const client = await connect()
    const { text, refused } = await modelVisibleRefusal(
      client,
      name,
      CALLS[name](SEGMENT, UNKNOWN_DOCUMENT),
    )

    expect(text).toMatch(/not found/i)
    expect(text).toContain(UNKNOWN_DOCUMENT)
    // A refused call names the workspace the way the caller did. A `failed`
    // entry sits inside a call whose workspace the caller already named.
    if (refused) expect(text).toContain(`workspace ${SEGMENT}`)
    expect(text).not.toContain(WORKSPACE_ID)
    expect(text).not.toMatch(/Canvas/)
    expect(text).not.toContain('no saved snapshot')
    expect(text).not.toContain('records no kind')
  })
})
