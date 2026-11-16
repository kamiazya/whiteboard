// A board the Rust core refuses (owner decision q81, D7) is drawn as a notice,
// and `wb_scene_render` says so in words beside the SVG: the structured output
// is the same shape either way, so the second text item is the only place an
// agent that does not read the picture learns why.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { refusalCopy } from '@kamiazya/whiteboard-canvas-render'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-mcp-scene-refusal-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

// lazy-import: the server and its deps are imported after `vi.mock` replaces
// `../config.js`, so they read this file's temporary data directory.
const { createMcpServer } = await import('./server.js')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')

async function call(deps: ServerDeps, name: string, args: Record<string, unknown>) {
  const server = await createMcpServer(deps)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'scene-refusal', version: '0.0.0' })
  await client.connect(clientSide)
  try {
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close()
  }
}

const refused = { code: 'input-too-large', reason: 'too-many-elements' } as const

const refusing: LayoutCore = {
  routing: {
    routeLayout: () => {
      throw new Error('no edge is routed here')
    },
  },
  layout: { layoutSpatialCanvas: () => ({ refused }) },
  impl: { routeLayout: 'ts', layoutSpatialCanvas: 'rust' },
}

type Content = readonly { readonly type: string; readonly text?: string }[]

describe('wb_scene_render of a board the core refuses', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
  })

  it('answers the notice as its SVG, and the reason as a second text item', async () => {
    const base = await resolveTestServerDeps(join(tmp.dir, 'data'))
    const created = await call(base, 'wb_workspace_edit', {
      workspaceId: 'scene-refusal',
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'board', kind: 'spatial' }],
    })
    expect(created.isError, JSON.stringify(created.content)).not.toBe(true)
    const { results } = created.structuredContent as {
      results: readonly { documentId?: string }[]
    }
    const documentId = results.find((result) => result.documentId !== undefined)?.documentId
    // By its handle, as an agent addresses it: the call goes through the same
    // handle resolution and membership gate as every other tool call.
    const args = { workspaceId: 'scene-refusal', documentId }

    const drawn = await call(base, 'wb_scene_render', args)
    expect(drawn.isError).not.toBe(true)
    expect(drawn.content as Content).toHaveLength(1)

    const deps: ServerDeps = { ...base, layoutCore: async () => refusing }
    const notice = await call(deps, 'wb_scene_render', args)
    expect(notice.isError, JSON.stringify(notice.content)).not.toBe(true)
    const content = notice.content as Content
    expect(content).toHaveLength(2)
    const { svg } = notice.structuredContent as { svg: string }
    expect(svg).toContain(refusalCopy(refused).title)
    expect(content[0]?.text).toBe(JSON.stringify(notice.structuredContent))
    expect(content[1]).toEqual({
      type: 'text',
      text: expect.stringContaining('(reason: too-many-elements)'),
    })
    expect(content[1]?.text).toContain(refusalCopy(refused).detail)
  })
})
