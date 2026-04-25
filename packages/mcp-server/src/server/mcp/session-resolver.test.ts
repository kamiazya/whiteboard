import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveWorkspaceId,
  saveCurrentWorkspaceId,
  CURRENT_WORKSPACE_FILENAME,
  LATEST_SESSION_FILENAME,
} from './session-resolver.js'

describe('resolveWorkspaceId', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-resolver-test-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('returns a new nanoid when neither .current-workspace nor .latest-session exists', async () => {
    const id = await resolveWorkspaceId(dataDir)
    expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/) // nanoid default length
  })

  it('prefers .current-workspace when it exists', async () => {
    await writeFile(join(dataDir, CURRENT_WORKSPACE_FILENAME), 'current-workspace-id')
    await writeFile(join(dataDir, LATEST_SESSION_FILENAME), 'legacy-session-id')

    const id = await resolveWorkspaceId(dataDir)
    expect(id).toBe('current-workspace-id')
  })

  it('falls back to .latest-session when .current-workspace is missing', async () => {
    const candidate = 'prev-session-id'
    await writeFile(join(dataDir, LATEST_SESSION_FILENAME), candidate)

    const id = await resolveWorkspaceId(dataDir)
    expect(id).toBe(candidate)
  })

  it('returns a new nanoid when the marker file is empty', async () => {
    await writeFile(join(dataDir, CURRENT_WORKSPACE_FILENAME), '   \n')
    await writeFile(join(dataDir, LATEST_SESSION_FILENAME), '   \n')

    const id = await resolveWorkspaceId(dataDir)
    expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/)
  })

  it('returns a new nanoid without throwing when DATA_DIR itself does not exist', async () => {
    const id = await resolveWorkspaceId(join(tmpdir(), 'nonexistent-whiteboard-resolver-dir'))
    expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/)
  })

  it('updates both the current marker and the legacy marker in saveCurrentWorkspaceId', async () => {
    await saveCurrentWorkspaceId(dataDir, 'persisted-workspace')
    await expect(resolveWorkspaceId(dataDir)).resolves.toBe('persisted-workspace')
    await expect(readFile(join(dataDir, CURRENT_WORKSPACE_FILENAME), 'utf-8')).resolves.toBe(
      'persisted-workspace',
    )
    await expect(readFile(join(dataDir, LATEST_SESSION_FILENAME), 'utf-8')).resolves.toBe(
      'persisted-workspace',
    )
  })
})
