import { describe, expect, it } from 'vitest'
import { excalidrawJsonDocSchema } from '../excalidraw-json.js'
import { BROWSER_LOCAL_CAPABILITIES } from '../provider.js'
import { createWhiteboardCommands } from './create-commands.js'
import { CommandError, exportJsonResultSchema, type WhiteboardCommandDeps } from './types.js'

// exportJsonResultSchema must be the same schema instance the serializer
// module owns — never a parallel re-declaration.
if (exportJsonResultSchema !== excalidrawJsonDocSchema) {
  throw new Error('exportJsonResultSchema must be excalidrawJsonDocSchema, not a copy')
}

const el = (over: Record<string, unknown>) =>
  ({ id: 'e', type: 'rectangle', x: 0, y: 0, ...over }) as never

function baseDeps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    getExcalidrawApi: () => null,
    provider: { kind: 'browser-local', capabilities: BROWSER_LOCAL_CAPABILITIES },
    canvas: { canvasId: 'c1', name: 'Canvas 1' },
    ...overrides,
  }
}

function refOf(deps: WhiteboardCommandDeps): { current: WhiteboardCommandDeps } {
  return { current: deps }
}

describe('createWhiteboardCommands.exportJson', () => {
  it('exports the live scene as a standard .excalidraw envelope', async () => {
    const api = {
      getSceneElements: () => [el({ id: 'a' }), el({ id: 'b', isDeleted: true })],
      getAppState: () => ({ gridSize: 20, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never }))
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.exportJson()

    expect(result.type).toBe('excalidraw')
    expect(result.version).toBe(2)
    // isDeleted elements are dropped by the serializer.
    expect(result.elements.map((e) => (e as { id: string }).id)).toEqual(['a'])
  })

  it('throws a no-api CommandError when no Excalidraw API is mounted', async () => {
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => null }))
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.exportJson()).rejects.toMatchObject({
      code: 'no-api',
    })
    await expect(commands.exportJson()).rejects.toBeInstanceOf(CommandError)
  })

  it('throws a no-canvas CommandError when no canvas is selected, even with a mounted API', async () => {
    const api = {
      getSceneElements: () => [el({ id: 'a' })],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never, canvas: null }))
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.exportJson()).rejects.toMatchObject({ code: 'no-canvas' })
    await expect(commands.exportJson()).rejects.toBeInstanceOf(CommandError)
  })

  it('wraps a scene-read failure in an export-failed CommandError rather than letting it escape raw', async () => {
    const api = {
      getSceneElements: () => {
        throw new Error('boom')
      },
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never }))
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.exportJson()).rejects.toMatchObject({ code: 'export-failed' })
    await expect(commands.exportJson()).rejects.toBeInstanceOf(CommandError)
  })

  it('throws an invalid-input CommandError for a non-object input', async () => {
    const depsRef = refOf(baseDeps())
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.exportJson('nope' as never)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('reads deps fresh on each call — a ref swap between calls is picked up', async () => {
    const apiA = {
      getSceneElements: () => [el({ id: 'a' })],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const apiB = {
      getSceneElements: () => [el({ id: 'b' })],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#000' }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => apiA as never }))
    const commands = createWhiteboardCommands(depsRef)

    const first = await commands.exportJson()
    expect(first.elements.map((e) => (e as { id: string }).id)).toEqual(['a'])

    depsRef.current = baseDeps({ getExcalidrawApi: () => apiB as never })
    const second = await commands.exportJson()
    expect(second.elements.map((e) => (e as { id: string }).id)).toEqual(['b'])
  })

  it('a mid-flight deps swap does not affect an already in-flight call', async () => {
    let resolveElements: (els: unknown[]) => void = () => {}
    const pendingElements = new Promise<unknown[]>((resolve) => {
      resolveElements = resolve
    })
    const api = {
      // Simulates a slow read: the command has already captured `api` by
      // the time this resolves, so a concurrent deps swap must not change
      // which api instance this call reads from.
      getSceneElements: () => pendingElements,
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never }))
    const commands = createWhiteboardCommands(depsRef)

    const inFlight = commands.exportJson()

    // Swap deps to a null-API state (simulating unmount / canvas switch)
    // before the in-flight call's scene read resolves.
    depsRef.current = baseDeps({ getExcalidrawApi: () => null })
    resolveElements([el({ id: 'still-a' })])

    const result = await inFlight
    expect(result.elements.map((e) => (e as { id: string }).id)).toEqual(['still-a'])
  })

  it('never includes secret-bearing fields even with a full daemon ProviderState in deps', async () => {
    const api = {
      getSceneElements: () => [el({ id: 'a' })],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(
      baseDeps({
        getExcalidrawApi: () => api as never,
        provider: {
          kind: 'local-daemon',
          daemonBaseUrl: 'http://127.0.0.1:9999',
          capabilities: BROWSER_LOCAL_CAPABILITIES,
        },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.exportJson()
    const serialized = JSON.stringify(result).toLowerCase()

    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('daemonbaseurl')
    expect(serialized).not.toContain('handle')
  })
})
