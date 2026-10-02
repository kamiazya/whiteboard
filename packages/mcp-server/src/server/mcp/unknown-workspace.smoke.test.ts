import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openStdioSession, type StdioSession } from './stdio-session.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const stdioEntry = resolve(root, 'src/server/mcp/stdio.ts')

/**
 * An agent installed without the skills has no tool that lists workspaces, so
 * the refusal for a handle it guessed is the only place the right one can
 * reach it. Over a real process because the names come from the composition
 * root's wiring, which a unit test over the tool cannot see.
 */
const dirs: string[] = []
let agent: StdioSession | undefined

afterEach(() => {
  agent?.kill()
  agent = undefined
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
  }, 60_000)
})
