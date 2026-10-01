import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentNotFoundError } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { requireDocumentAtPath } = await import('./document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('requireDocumentAtPath', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('throws the port error naming the workspace and the path when nothing lives there', async () => {
    const error = await requireDocumentAtPath('ws-none', 'notes/a').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DocumentNotFoundError)
    expect(error).toMatchObject({ workspaceId: 'ws-none', target: 'notes/a' })
  })
})
