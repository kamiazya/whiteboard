/**
 * Every workspace-scoped MCP tool must be addressable by a workspace's
 * SEGMENT, not only by its canonical id.
 *
 * `withResolvedWorkspaceHandles` wraps `createServer`'s tool RECORD, for the
 * reason its own doc comment gives — a per-tool resolution step is a step the
 * next tool will not have. What that wrapper cannot see is a registration
 * built from something OTHER than the record: five here called a bare
 * operation or a tool factory instead, so they never resolved. The gap was
 * invisible while a workspace's id and its handle were the same string, and
 * ADR-0019's mint turned it into "workspace not found" on every call after a
 * create.
 *
 * Two guards, because neither is sufficient alone. The first is structural
 * and cheap, and covers tools this file has no valid arguments for. The
 * second drives the one the published smoke actually caught, end to end.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-segment-tools-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDb } = await import('../store/db/index.js')
const { prepareDataDir } = await import('../store/db/prepare.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')
const { createStoreLocalModule } = await import('../../di/store-local.module.js')
const { registerDocumentTools } = await import('./document-tools.js')

const SEGMENT = 'by-segment'
const WORKSPACE_ID = '01M162AQMVCNXR7J9X636HBA5J'

describe('every registration takes its tool from the resolving record', () => {
  it('calls tools.<name>.execute and never a bare operation', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./document-tools.ts', import.meta.url)),
      'utf8',
    )
    // Registrations are the unit here, not tools: a registration is what can
    // reach past the record, and reading them from the source is what lets
    // this cover the tools whose arguments this file could not construct.
    const blocks = source.split('registerToolWithAnnotations(').slice(1)
    // A scan that finds nothing passes. The real surface is well into double
    // digits; a count far below that means the split stopped matching.
    expect(blocks.length).toBeGreaterThan(14)

    const bypassing = blocks
      .filter((block) => !/tools\.\w+\.execute\(/.test(block))
      .map((block) => block.slice(0, 80).replace(/\s+/g, ' ').trim())
    expect(bypassing, 'these registrations bypass the resolving record').toEqual([])
  })
})

describe('a batch addressed by segment reaches the workspace behind it', () => {
  it('applies wb_workspace_edit ops when the handle is a segment, not an id', async () => {
    await prepareDataDir(tmp.dir)
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })),
    )
    await deps.documentIndex.createWorkspace({ workspaceId: WORKSPACE_ID, segment: SEGMENT })
    // The fixture is only useful if the two spellings differ — otherwise
    // "resolved by segment" is satisfied by resolving nothing at all.
    expect(WORKSPACE_ID).not.toBe(SEGMENT)

    const registerTool = vi.fn()
    registerDocumentTools({ registerTool } as unknown as McpServer, deps)
    const call = registerTool.mock.calls.find((c) => c[0] === 'wb_workspace_edit')
    if (call === undefined) throw new Error('wb_workspace_edit is not registered')

    const result = (await (call[2] as (a: unknown, e: unknown) => Promise<unknown>)(
      {
        workspaceId: SEGMENT,
        ops: [{ op: 'document.create', path: 'filed', kind: 'markdown', name: 'Filed' }],
      },
      {},
    )) as { isError?: boolean; structuredContent?: { workspaceId?: string; applied?: number } }

    expect(result.isError, JSON.stringify(result)).toBeUndefined()
    expect(result.structuredContent?.applied).toBe(1)
    // Reported as the canonical id, and the document really landed in that
    // workspace rather than in one the segment accidentally minted.
    expect(result.structuredContent?.workspaceId).toBe(WORKSPACE_ID)
    const listed = await deps.documentIndex.listDocuments({ workspaceId: WORKSPACE_ID })
    expect(listed.map((d) => d.path)).toEqual(['filed'])
  })
})
