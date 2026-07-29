import { describe, expect, it, vi } from 'vitest'
import * as logModule from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import { createInMemoryWorkspaceIndex } from '../test-utils/in-memory-workspace-index.js'
import { withReindex } from './with-reindex.js'

const WORKSPACE_ID = 'ws-1'

function makeDeps(): ServerDeps {
  return {
    canvasDocStore: createInMemoryCanvasDocStore(),
    workspaceIndex: createInMemoryWorkspaceIndex(),
    blobStore: {} as never,
  }
}

describe('withReindex', () => {
  it('reindexes the workspace after the inner execute resolves', async () => {
    const deps = makeDeps()
    const applyRowsSpy = vi.spyOn(deps.workspaceIndex, 'applyRows')
    const innerExecute = vi.fn(async (input: { workspaceId: string }) => ({
      workspaceId: input.workspaceId,
      ok: true,
    }))
    const wrapped = withReindex(deps, innerExecute)

    const result = await wrapped({ workspaceId: WORKSPACE_ID })

    expect(result).toEqual({ workspaceId: WORKSPACE_ID, ok: true })
    expect(applyRowsSpy).toHaveBeenCalledTimes(1)
    expect(applyRowsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID }),
    )
  })

  it('does not reindex when the inner execute throws', async () => {
    const deps = makeDeps()
    const applyRowsSpy = vi.spyOn(deps.workspaceIndex, 'applyRows')
    const failure = new Error('mutation failed')
    const innerExecute = vi.fn(async () => {
      throw failure
    })
    const wrapped = withReindex(deps, innerExecute)

    await expect(wrapped({ workspaceId: WORKSPACE_ID })).rejects.toThrow(failure)
    expect(applyRowsSpy).not.toHaveBeenCalled()
  })

  it('propagates the inner execute error unchanged, without swallowing it', async () => {
    const deps = makeDeps()
    class CustomError extends Error {}
    const innerExecute = vi.fn(async () => {
      throw new CustomError('specific failure')
    })
    const wrapped = withReindex(deps, innerExecute)

    await expect(wrapped({ workspaceId: WORKSPACE_ID })).rejects.toBeInstanceOf(CustomError)
  })

  it('still resolves with the mutation result when reindexWorkspace itself fails (fail-open)', async () => {
    const deps = makeDeps()
    deps.workspaceIndex.applyRows = vi.fn().mockRejectedValue(new Error('index write failed'))
    const innerExecute = vi.fn(async () => ({ done: true }))
    const wrapped = withReindex(deps, innerExecute)

    await expect(wrapped({ workspaceId: WORKSPACE_ID })).resolves.toEqual({ done: true })
  })

  it('logs at error level when reindexWorkspace fails, without changing the resolved value', async () => {
    const deps = makeDeps()
    deps.workspaceIndex.applyRows = vi.fn().mockRejectedValue(new Error('index write failed'))
    const errorSpy = vi.fn()
    logModule.setLogSink((record) => {
      if (record.level === 'error') errorSpy(record)
    })
    const innerExecute = vi.fn(async () => ({ done: true }))
    const wrapped = withReindex(deps, innerExecute)

    try {
      await expect(wrapped({ workspaceId: WORKSPACE_ID })).resolves.toEqual({ done: true })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      logModule.setLogSink(() => {})
    }
  })
})
