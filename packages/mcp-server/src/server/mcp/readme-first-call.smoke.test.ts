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
const TOKEN = 'readme-first-call-smoke'

interface ListedWorkspace {
  workspaceId: string
  segment?: string
  documentCount: number
}

/**
 * The README's Verify step is the first thing a new user's agent runs, against
 * a data directory nothing has touched. It addresses the workspace as
 * `default`, and the browser then opens whichever workspace the daemon lists
 * first — so the call only means what the README says if both land in the same
 * place. Guards that parse the README's calls cannot see that; only running
 * them over a real stdio process and a real daemon can.
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

describe("the README's Verify call on a fresh data directory", () => {
  it('succeeds as written and lands in the workspace the browser opens first', async () => {
    const dataDir = scratch('whiteboard-readme-data-')
    const runtimeDir = scratch('whiteboard-readme-run-')
    mkdirSync(runtimeDir, { recursive: true })
    agent = await openStdioSession({
      root,
      entry: stdioEntry,
      env: { WHITEBOARD_DATA_DIR: dataDir, XDG_RUNTIME_DIR: runtimeDir },
      clientName: 'readme-first-call-smoke',
    })

    const created = await agent.call('wb_workspace_edit', {
      workspaceId: 'default',
      ops: [{ op: 'document.create', path: 'smoke', kind: 'spatial' }],
    })
    expect((created.results as { path: string }[]).map((result) => result.path)).toEqual(['smoke'])

    daemon = await startDaemon({ root, cliEntry, dataDir, runtimeDir, token: TOKEN })
    const listed = (await daemon.fetch('/api/workspaces')).json() as {
      workspaces: ListedWorkspace[]
    }
    const [first, ...rest] = listed.workspaces
    expect(rest).toEqual([])
    expect(first).toMatchObject({
      workspaceId: created.workspaceId,
      segment: 'default',
      documentCount: 1,
    })
  }, 90_000)
})
