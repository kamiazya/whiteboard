import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openStdioSession, type StdioSession } from './stdio-session.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = resolve(root, 'src/server/mcp/stdio.ts')

/**
 * Two real stdio processes over one data dir. The first writes as an agent
 * and goes away before the five-minute quiet window ends; the second reads
 * the history it left. The process-level wiring (`main()` arming the
 * checkpoint, and its shutdown taking the pending one) is exactly what a unit
 * test over the declaration cannot see.
 */
const sessions: StdioSession[] = []
let dataDir = ''

async function openSession(dir: string): Promise<StdioSession> {
  const session = await openStdioSession({
    root,
    entry,
    env: { WHITEBOARD_DATA_DIR: dir },
    clientName: 'shutdown-checkpoint-smoke',
  })
  sessions.push(session)
  return session
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.kill()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('stdio shutdown checkpoint smoke', () => {
  it('leaves an automatic version behind when an agent-only session ends', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-stdio-shutdown-'))

    const first = await openSession(dataDir)
    const batch = await first.call('wb_workspace_edit', {
      workspaceId: 'agent-only',
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'notes', kind: 'markdown' }],
    })
    const workspaceId = batch.workspaceId as string
    const documentId = (batch.results as { documentId: string }[])[0]?.documentId as string
    await first.call('wb_facet_set', {
      workspaceId,
      documentIds: [documentId],
      facets: { 'smoke.check/v1': { note: 'written by an agent' } },
    })
    expect(await first.end()).toBe(0)

    const second = await openSession(dataDir)
    const listed = await second.call('wb_version_list', { workspaceId, documentId })
    expect(listed.versions).toEqual([expect.objectContaining({ auto: true })])
  }, 60_000)
})
