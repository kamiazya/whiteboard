import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { createServer, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { FakeVersionHistory } from '@kamiazya/whiteboard-server-core/test-utils/fake-version-history'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))
const tmp = withTempDataDir('whiteboard-name-from-heading-')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')
const { registerDocumentTools } = await import('./document-tools.js')

const WS = '01M162AQMVCNXR7J9X636HBA5J'

async function daemon(): Promise<{ deps: ServerDeps; client: Client }> {
  const deps = { ...(await resolveTestServerDeps(tmp.dir)), versions: new FakeVersionHistory() }
  await deps.documentIndex.createWorkspace({ workspaceId: WS, segment: 'proj' })
  const server = new McpServer({ name: 'name-from-heading', version: '0.0.0' })
  registerDocumentTools(server, deps)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'name-from-heading', version: '0.0.0' })
  await client.connect(clientSide)
  return { deps, client }
}

async function createNote(
  client: Client,
  op: { path: string; markdown?: string; name?: string },
): Promise<string> {
  const result = await client.callTool({
    name: 'wb_workspace_edit',
    arguments: { workspaceId: WS, ops: [{ op: 'document.create', kind: 'markdown', ...op }] },
  })
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
  const created = result.structuredContent as { results: { documentId: string }[] }
  const documentId = created.results[0]?.documentId
  if (documentId === undefined) throw new Error('document.create answered no document')
  return documentId
}

async function nameOf(deps: ServerDeps, documentId: string): Promise<string | undefined> {
  const entry = await deps.documentIndex.resolveDocumentById({ workspaceId: WS, documentId })
  expect(entry).not.toBeNull()
  return entry?.name
}

// A note at a generated path takes its name from its heading in the daemon's
// own write, whichever surface wrote the body — not only on the page's sync
// route. Otherwise an agent's note stays `untitled` until a person's later,
// unrelated keystroke names it, which reads as a rename nobody made.
describe('a daemon note at a generated path is named after its heading', () => {
  it('when wb_workspace_edit creates it with a heading', async () => {
    const { deps, client } = await daemon()
    const id = await createNote(client, {
      path: 'untitled',
      markdown: '# Weekly review\n\nbody',
    })

    expect(await nameOf(deps, id)).toBe('Weekly review')
  })

  it('when /api/v1 creates it with a heading', async () => {
    const { deps } = await daemon()
    const { app } = createServer(deps)

    const res = await app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'untitled-2',
        kind: 'markdown',
        markdown: '# Weekly review\n\nbody',
      }),
    })
    expect(res.status).toBe(201)
    const { documentId } = (await res.json()) as { documentId: string }

    expect(await nameOf(deps, documentId)).toBe('Weekly review')
  })

  it('when wb_body_edit later writes a heading into an unnamed note', async () => {
    const { deps, client } = await daemon()
    const id = await createNote(client, { path: 'untitled', markdown: 'draft' })
    expect(await nameOf(deps, id)).toBeUndefined()

    const edit = await client.callTool({
      name: 'wb_body_edit',
      arguments: {
        workspaceId: WS,
        documentId: id,
        mode: 'apply',
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact: 'draft' }, start: 0, end: 5 },
            text: '# Weekly review\n\nbody',
            assumed: 'draft',
          },
        ],
      },
    })
    expect(edit.isError, JSON.stringify(edit.content)).not.toBe(true)

    expect(await nameOf(deps, id)).toBe('Weekly review')
  })

  it('when document.set later rewrites the whole note under a heading', async () => {
    const { deps, client } = await daemon()
    const id = await createNote(client, { path: 'untitled', markdown: 'draft' })

    const set = await client.callTool({
      name: 'wb_workspace_edit',
      arguments: {
        workspaceId: WS,
        ops: [
          {
            op: 'document.set',
            documentId: id,
            markdown: '---\ntype: note\n---\n# Weekly review\n\nbody',
          },
        ],
      },
    })
    expect(set.isError, JSON.stringify(set.content)).not.toBe(true)

    expect(await nameOf(deps, id)).toBe('Weekly review')
  })

  it('when a per-document save writes its content, as a restore does', async () => {
    const { deps } = await daemon()
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, '# Weekly review\n\nbody')
    doc.commit()

    await deps.liveDocuments.save(WS, 'untitled-3', doc, { kind: 'markdown' })

    const [entry] = await deps.documentIndex.listDocuments({ workspaceId: WS })
    expect(entry?.path).toBe('untitled-3')
    expect(entry?.name).toBe('Weekly review')
  })

  it('but not when its path is one somebody chose', async () => {
    const { deps, client } = await daemon()
    const id = await createNote(client, {
      path: 'weekly',
      markdown: '# Weekly review\n\nbody',
    })

    expect(await nameOf(deps, id)).toBeUndefined()
  })

  it('nor over a name the writer gave it', async () => {
    const { deps, client } = await daemon()
    const id = await createNote(client, {
      path: 'untitled',
      name: 'Retro notes',
      markdown: '# Weekly review\n\nbody',
    })

    expect(await nameOf(deps, id)).toBe('Retro notes')
  })
})
