import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DaemonProcess, startDaemon } from './daemon-process.smoke-impl.js'
import { openStdioSession, type StdioSession } from './stdio-session.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const stdioEntry = resolve(root, 'src/server/mcp/stdio.ts')
const cliEntry = resolve(root, 'src/cli/index.ts')
const TOKEN = 'workspace-coherence-smoke'
const DRAWN = 'agent drew this'

/**
 * `npx @kamiazya/whiteboard-mcp` (the agent) and `whiteboard daemon run` (the
 * browser's keeper) are two processes over ONE data dir, each holding its own
 * in-memory copy of the workspace record. The README's headline flow — ask the
 * agent to draw, watch it appear in the browser, draw in the browser, have the
 * agent see it — is only true if a write by either reaches the other, which no
 * test inside one process can show.
 *
 * Nothing here sets the tail's interval: arming it is the daemon's own default,
 * and the wait is bounded by that default rather than by a knob the test turned.
 */
const dirs: string[] = []
let daemon: DaemonProcess | undefined
let agent: StdioSession | undefined

afterEach(() => {
  agent?.kill()
  daemon?.stop()
  agent = daemon = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function readsAs(bytes: Buffer): string {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(bytes))
  return JSON.stringify(doc.toJSON())
}

async function listedPaths(daemon: DaemonProcess, workspaceId: string): Promise<string[]> {
  const listed = await daemon.fetch(`/api/v1/workspaces/${workspaceId}/documents`)
  const body = listed.json() as { documents: { path: string }[] }
  return body.documents.map((document) => document.path)
}

describe('agent and daemon over one data dir', () => {
  it("carries each side's writes to the other", async () => {
    const dataDir = scratch('whiteboard-coherence-data-')
    const runtimeDir = scratch('whiteboard-coherence-run-')
    mkdirSync(runtimeDir, { recursive: true })
    const env = { WHITEBOARD_DATA_DIR: dataDir, XDG_RUNTIME_DIR: runtimeDir }
    daemon = await startDaemon({ root, cliEntry, dataDir, runtimeDir, token: TOKEN })
    agent = await openStdioSession({ root, entry: stdioEntry, env, clientName: 'coherence-smoke' })

    const created = await agent.call('wb_workspace_edit', {
      workspaceId: 'coherence',
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'sketch', kind: 'spatial' }],
    })
    const workspaceId = created.workspaceId as string
    const documentId = (created.results as { documentId: string }[])[0]?.documentId as string

    // The browser opens the workspace, which is what makes the daemon cache it.
    expect(await listedPaths(daemon, workspaceId)).toEqual(['sketch'])
    const stream = await daemon.openStream()
    await stream.subscribe([`${workspaceId}/sketch`, `workspace:${workspaceId}`])

    await agent.call('wb_canvas_edit', {
      workspaceId,
      documentId,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'n1', type: 'text', text: DRAWN } }],
    })

    // The agent -> browser half. Every observation is taken on every try, so a
    // failure names which of them the browser is still missing.
    const live = daemon
    const browserSees = async () => {
      const pushed = stream.frames().filter((frame) => frame.event === 'update')
      const record = await live.fetch(`/api/w/${workspaceId}/workspace-document/snapshot`)
      const projection = await live.fetch(`/api/w/${workspaceId}/document/sketch/snapshot`)
      return {
        updateFrameForWorkspaceRecord: pushed.some(
          (frame) => (frame.data as { doc: string }).doc === `workspace:${workspaceId}`,
        ),
        workspaceRecordHasTheDrawing: readsAs(record.bytes).includes(DRAWN),
        documentSnapshotHasTheDrawing: readsAs(projection.bytes).includes(DRAWN),
      }
    }
    await vi.waitFor(
      async () =>
        expect(await browserSees()).toEqual({
          updateFrameForWorkspaceRecord: true,
          workspaceRecordHasTheDrawing: true,
          documentSnapshotHasTheDrawing: true,
        }),
      { timeout: 20_000, interval: 200 },
    )

    // The browser -> agent half, on a stdio process that has been running all along.
    const made = await daemon.fetch(`/api/v1/workspaces/${workspaceId}/documents`, {
      method: 'POST',
      body: { path: 'from-browser', kind: 'markdown' },
    })
    expect(made.status).toBeLessThan(300)
    const seen = await agent.call('wb_document_list', { workspaceId })
    expect((seen.documents as { path: string }[]).map((document) => document.path).sort()).toEqual([
      'from-browser',
      'sketch',
    ])
  }, 90_000)
})
