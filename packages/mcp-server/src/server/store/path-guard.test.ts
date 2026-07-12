import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

async function importWithRelaxedValidators<T>(modulePath: string): Promise<T> {
  vi.doMock('../config.js', () => ({
    get DATA_DIR() {
      return tempDir
    },
    WHITEBOARD_ROOT: '/tmp',
    REPO_ROOT: '/tmp',
  }))
  vi.doMock('../validators.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../validators.js')>()
    return {
      ...actual,
      validateWorkspaceId: (value: string) => value,
      validateSlug: (value: string) => value,
      validateVersionId: (value: string) => value,
    }
  })
  return (await import(modulePath)) as T
}

async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

describe('store path guards', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'store-path-guard-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.doUnmock('../config.js')
    vi.doUnmock('../validators.js')
    vi.resetModules()
    await rm(tempDir, { recursive: true, force: true })
  })

  // names-store no longer constructs filesystem paths from workspaceId; the
  // path-traversal vector is fully covered by validateWorkspaceId, exercised
  // independently in validators.test.ts.

  it('returns ValidationError for version-store thumbnail escape attempts', async () => {
    const { FileVersionStore } =
      await importWithRelaxedValidators<typeof import('./version-store.js')>('./version-store.js')
    const { validationErrorBody } = await import('../validators.js')
    const store = new FileVersionStore()

    // Version metadata now lives in the DB, but thumbnail blobs still hit the
    // filesystem, so the path guard remains the second-line defense behind
    // validateVersionId. Relaxing the validators forces the assertPathWithinDir
    // guard to fire when the id would otherwise build a path outside blobs/.
    const error = await captureError(store.loadThumbnail('sess-1', '../escape'))

    expect(error).toMatchObject({ name: 'ValidationError', error: 'invalid_path' })
    expect(validationErrorBody(error)).toEqual({
      error: 'invalid_path',
      message: expect.stringMatching(/outside/i),
    })
  })
})
