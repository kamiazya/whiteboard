import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'

let tempDir: string

async function importWithRelaxedValidators<T>(modulePath: string): Promise<T> {
  vi.doMock('../config.js', () => ({
    get DATA_DIR() {
      return tempDir
    },
    WHITEBOARD_ROOT: '/tmp',
    REPO_ROOT: '/tmp',
    DIST_APP_DIR: '/tmp/dist/app',
  }))
  vi.doMock('../validators.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../validators.js')>()
    return {
      ...actual,
      validateSessionId: (value: string) => value,
      validateSlug: (value: string) => value,
      validateVersionId: (value: string) => value,
      validateCheckpointId: (value: string) => value,
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

  it('returns ValidationError for names-store session escape attempts', async () => {
    const { setWorkspaceName } = await importWithRelaxedValidators<typeof import('./names-store.js')>(
      './names-store.js',
    )
    const { validationErrorBody } = await import('../validators.js')

    const error = await captureError(setWorkspaceName('..', 'Escape'))

    expect(error).toMatchObject({ name: 'ValidationError', error: 'invalid_path' })
    expect(validationErrorBody(error)).toEqual({
      error: 'invalid_path',
      message: expect.stringMatching(/outside/i),
    })
  })

  it('returns ValidationError for version-store file escape attempts', async () => {
    const { FileVersionStore } =
      await importWithRelaxedValidators<typeof import('./version-store.js')>('./version-store.js')
    const { validationErrorBody } = await import('../validators.js')
    const store = new FileVersionStore()

    const error = await captureError(store.load('sess-1', '../escape', new LoroDoc()))

    expect(error).toMatchObject({ name: 'ValidationError', error: 'invalid_path' })
    expect(validationErrorBody(error)).toEqual({
      error: 'invalid_path',
      message: expect.stringMatching(/outside/i),
    })
  })

  it('returns ValidationError for checkpoint-store file escape attempts', async () => {
    const { FileCheckpointStore } = await importWithRelaxedValidators<
      typeof import('./checkpoint-store.js')
    >('./checkpoint-store.js')
    const { validationErrorBody } = await import('../validators.js')
    const store = new FileCheckpointStore()

    const error = await captureError(store.load('../escape'))

    expect(error).toMatchObject({ name: 'ValidationError', error: 'invalid_path' })
    expect(validationErrorBody(error)).toEqual({
      error: 'invalid_path',
      message: expect.stringMatching(/outside/i),
    })
  })
})
