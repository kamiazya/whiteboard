import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DaemonProcess, startDaemon } from './daemon-process.smoke-impl.js'
import { openStdioSession, type StdioSession } from './stdio-session.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const stdioEntry = resolve(root, 'src/server/mcp/stdio.ts')
const cliEntry = resolve(root, 'src/cli/index.ts')
const TOKEN = 'workspace-follow-smoke'

/**
 * The document INDEX shows no document, so it follows a workspace the only way
 * it can: a stream subscribed to `workspace:<handle>` with nothing else. An
 * agent writing through its own stdio process must reach that stream, under the
 * handle the index subscribed with — otherwise the list a person is watching
 * after "ask the agent to draw" stays as it was until a reload.
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

describe('a stream that follows only the workspace', () => {
  it('is told when an agent over stdio writes a document, under the handle it subscribed with', async () => {
    const dataDir = scratch('whiteboard-follow-data-')
    const runtimeDir = scratch('whiteboard-follow-run-')
    mkdirSync(runtimeDir, { recursive: true })
    const env = { WHITEBOARD_DATA_DIR: dataDir, XDG_RUNTIME_DIR: runtimeDir }
    daemon = await startDaemon({ root, cliEntry, dataDir, runtimeDir, token: TOKEN })
    agent = await openStdioSession({ root, entry: stdioEntry, env, clientName: 'follow-smoke' })

    // The index lists the workspace before it follows it, which is what makes
    // the daemon hold the record and watch it for writes made elsewhere.
    const listed = await daemon.fetch('/api/workspaces')
    const [first] = (listed.json() as { workspaces: { segment?: string }[] }).workspaces
    expect(first?.segment).toBe('default')
    await daemon.fetch('/api/v1/workspaces/default/documents')
    const stream = await daemon.openStream()
    await stream.subscribe(['workspace:default'])

    await agent.call('wb_workspace_edit', {
      workspaceId: 'default',
      ops: [{ op: 'document.create', path: 'drawn-by-agent', kind: 'spatial' }],
    })

    // Nothing is requested of the daemon while waiting: a frame that arrives
    // is the daemon noticing the write itself, which is what the index relies on.
    await vi.waitFor(
      () =>
        expect(
          stream
            .frames()
            .filter((frame) => frame.event === 'update')
            .map((frame) => (frame.data as { doc: string }).doc),
        ).toContain('workspace:default'),
      { timeout: 20_000, interval: 100 },
    )
  }, 90_000)
})
