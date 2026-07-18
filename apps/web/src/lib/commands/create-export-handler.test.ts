import { describe, expect, it, vi } from 'vitest'
import { createSceneExportHandler } from './create-export-handler.js'
import type { WhiteboardCommands } from './types.js'

function fakeCommands(overrides: Partial<WhiteboardCommands> = {}): WhiteboardCommands {
  return {
    exportJson: vi.fn(async () => {
      throw new Error('should not be called in this test')
    }),
    ...overrides,
  }
}

describe('createSceneExportHandler', () => {
  it('delegates non-json formats straight through to exportScene, untouched', async () => {
    const exportScene = vi.fn(async (format: 'svg' | 'png') => new Blob([format]))
    const handler = createSceneExportHandler(fakeCommands(), exportScene)

    const result = await handler('svg')

    expect(exportScene).toHaveBeenCalledWith('svg')
    expect(result).toBeInstanceOf(Blob)
    await expect(result?.text()).resolves.toBe('svg')
  })

  it('resolves to null when commands.exportJson rejects, matching exportScene failure semantics', async () => {
    const commands = fakeCommands({
      exportJson: vi.fn(async () => {
        throw new Error('no canvas mounted')
      }),
    })
    const exportScene = vi.fn(async () => null)
    const handler = createSceneExportHandler(commands, exportScene)

    const result = await handler('json')

    expect(result).toBeNull()
    expect(exportScene).not.toHaveBeenCalled()
  })

  it('serializes a successful exportJson result as a JSON blob', async () => {
    const doc = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }
    const commands = fakeCommands({ exportJson: vi.fn(async () => doc as never) })
    const exportScene = vi.fn(async () => null)
    const handler = createSceneExportHandler(commands, exportScene)

    const result = await handler('json')

    expect(result).toBeInstanceOf(Blob)
    expect(result?.type).toBe('application/json')
    await expect(result?.text()).resolves.toBe(JSON.stringify(doc))
  })
})
