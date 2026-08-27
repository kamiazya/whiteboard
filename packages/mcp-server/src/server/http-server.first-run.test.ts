/**
 * A daemon nobody has written to yet must still offer a workspace.
 *
 * `ensureWorkspaceId` gives the daemon a current workspace id, but nothing
 * ran it at startup and it wrote only the `runtime` marker — so a browser
 * connecting to a freshly installed daemon got `{"workspaces":[]}` (measured)
 * and had nothing to select. `DaemonIndexPage` then sat on its loading
 * skeleton indefinitely, because the documents fetch that ends that state is
 * keyed on a selected workspace.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    get DATA_DIR() {
      return tempDir
    },
    getDataDir: () => tempDir,
  }
})

const { findAvailablePort } = await import('../cli/daemon-run.js')
const { startHttpServer } = await import('./http-server.js')
const { clearWorkspaceIdCache } = await import('./current-workspace.js')

describe('startHttpServer on a data dir nothing has ever written to', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-http-first-run-'))
    clearWorkspaceIdCache()
  })

  afterEach(async () => {
    clearWorkspaceIdCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it("lists the daemon's own workspace rather than nothing at all", async () => {
    const port = await findAvailablePort(0)
    const running = await startHttpServer({ port, host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspaces`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { workspaces: { workspaceId: string }[] }
      expect(body.workspaces).toHaveLength(1)
      // And the one it lists is the one its MCP tools would write into — a
      // second, differently-named workspace would split the same daemon's
      // browser view from its agent view.
      const { ensureWorkspaceId } = await import('./current-workspace.js')
      expect(body.workspaces[0].workspaceId).toBe(await ensureWorkspaceId(tempDir))
    } finally {
      await running.close()
    }
  })
})
