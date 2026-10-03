import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { type DaemonProcess, startDaemon } from './daemon-process.smoke-impl.js'
import { openStdioSession, type StdioSession } from './stdio-session.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const stdioEntry = resolve(root, 'src/server/mcp/stdio.ts')
const cliEntry = resolve(root, 'src/cli/index.ts')

/**
 * An agent installed without the skills has no tool that lists workspaces, so
 * the refusal for a handle it guessed is the only place the right one can
 * reach it. Over a real process because the names come from the composition
 * root's wiring, which a unit test over the tool cannot see.
 */
const dirs: string[] = []
let agent: StdioSession | undefined
let daemon: DaemonProcess | undefined

afterEach(() => {
  agent?.kill()
  daemon?.stop()
  agent = daemon = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('an unknown workspaceId over stdio on an empty data directory', () => {
  it('is refused with the name of the workspace that exists', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-unknown-ws-'))
    dirs.push(dataDir)
    agent = await openStdioSession({
      root,
      entry: stdioEntry,
      env: { WHITEBOARD_DATA_DIR: dataDir },
      clientName: 'unknown-workspace-smoke',
    })

    await expect(agent.call('wb_document_list', { workspaceId: 'main' })).rejects.toThrow(
      /Workspaces here: "default"/,
    )
    await expect(
      agent.call('wb_workspace_edit', {
        workspaceId: 'main',
        ops: [{ op: 'document.create', path: 'a', kind: 'spatial' }],
      }),
    ).rejects.toThrow(/Workspaces here: "default"/)
    // A render never asks about the workspace itself, and a read is not told
    // to add anything: every tool refuses a handle that names nothing alike.
    for (const [name, args] of [
      ['wb_scene_render', { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['wb_document_get', { documentIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }],
    ] as const) {
      const refusal = await agent.call(name, { workspaceId: 'main', ...args }).then(
        () => '',
        (error: Error) => error.message,
      )
      expect(refusal).toMatch(/Workspaces here: "default"/)
      expect(refusal).not.toContain('Create it before adding')
    }
  }, 60_000)

  // The daemon is the other root that composes the tools' deps, and the one a
  // browser and its `/mcp` clients reach: wired separately, so checked apart.
  it('is refused by the local daemon with the same names', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-unknown-ws-daemon-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'whiteboard-unknown-ws-run-'))
    dirs.push(dataDir, runtimeDir)
    mkdirSync(runtimeDir, { recursive: true })
    daemon = await startDaemon({ root, cliEntry, dataDir, runtimeDir, token: 'unknown-ws-smoke' })

    const refused = await daemon.fetch('/api/v1/workspaces/main/documents')

    expect(refused.status).toBe(404)
    expect(refused.bytes.toString()).toContain('Workspaces here: \\"default\\"')
  }, 90_000)
})
