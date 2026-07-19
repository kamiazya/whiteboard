import { describe, expect, it } from 'vitest'
import { excalidrawJsonDocSchema } from '@kamiazya/whiteboard-canvas-viewer/scene'
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

describe('createWhiteboardCommands.getSceneSummary', () => {
  it('returns counts and viewport without full scene content, excluding deleted elements', async () => {
    const api = {
      getSceneElements: () => [
        el({ id: 'a', type: 'rectangle' }),
        el({ id: 'b', type: 'rectangle' }),
        el({ id: 'c', type: 'ellipse' }),
        el({ id: 'd', type: 'rectangle', isDeleted: true }),
      ],
      getAppState: () => ({
        scrollX: 10,
        scrollY: -5,
        zoom: { value: 1.5 },
        selectedElementIds: { a: true },
      }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never }))
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getSceneSummary()

    expect(result).toEqual({
      elementCount: 3,
      selectedCount: 1,
      typeCounts: { rectangle: 2, ellipse: 1 },
      viewport: { scrollX: 10, scrollY: -5, zoom: 1.5 },
    })
  })

  it('throws no-api / no-canvas CommandErrors like every other command', async () => {
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => null }))
    const commands = createWhiteboardCommands(depsRef)
    await expect(commands.getSceneSummary()).rejects.toMatchObject({ code: 'no-api' })

    const api = {
      getSceneElements: () => [],
      getAppState: () => ({
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
        selectedElementIds: {},
      }),
      getFiles: () => ({}),
    }
    const depsRef2 = refOf(baseDeps({ getExcalidrawApi: () => api as never, canvas: null }))
    const commands2 = createWhiteboardCommands(depsRef2)
    await expect(commands2.getSceneSummary()).rejects.toMatchObject({ code: 'no-canvas' })
  })

  it('wraps a scene-read failure in a summary-failed CommandError rather than letting it escape raw', async () => {
    const api = {
      getSceneElements: () => {
        throw new Error('boom')
      },
      getAppState: () => ({
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
        selectedElementIds: {},
      }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never }))
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.getSceneSummary()).rejects.toMatchObject({ code: 'summary-failed' })
    await expect(commands.getSceneSummary()).rejects.toBeInstanceOf(CommandError)
  })

  it('wraps an output-schema validation failure (malformed app state) in a summary-failed CommandError', async () => {
    const api = {
      getSceneElements: () => [],
      // selectedElementIds missing entirely — Object.keys(undefined) throws.
      getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } }),
      getFiles: () => ({}),
    }
    const depsRef = refOf(baseDeps({ getExcalidrawApi: () => api as never }))
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.getSceneSummary()).rejects.toMatchObject({ code: 'summary-failed' })
    await expect(commands.getSceneSummary()).rejects.toBeInstanceOf(CommandError)
  })
})

describe('createWhiteboardCommands.getAppContext', () => {
  it('projects a browser-local provider and canvas without leaking capabilities', async () => {
    const depsRef = refOf(baseDeps())
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result).toEqual({
      provider: { mode: 'browser-local' },
      canvas: { kind: 'browser-local', canvasId: 'c1' },
    })
  })

  it('projects a daemon provider field-by-field, excluding daemonBaseUrl even though ProviderState carries one', async () => {
    const depsRef = refOf(
      baseDeps({
        provider: {
          kind: 'local-daemon',
          daemonBaseUrl: 'http://127.0.0.1:9999',
          capabilities: BROWSER_LOCAL_CAPABILITIES,
        },
        canvas: { workspaceId: 'ws1', canvasId: 'my-canvas', name: 'my-canvas' },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result).toEqual({
      provider: { mode: 'daemon' },
      canvas: { kind: 'daemon', workspaceId: 'ws1', slug: 'my-canvas' },
    })
    const serialized = JSON.stringify(result).toLowerCase()
    expect(serialized).not.toContain('daemonbaseurl')
    expect(serialized).not.toContain('9999')
  })

  it('returns canvas: null when no canvas is selected, without throwing', async () => {
    const depsRef = refOf(baseDeps({ canvas: null }))
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()

    expect(result.canvas).toBeNull()
  })

  it('throws an invalid-provider-state CommandError rather than misreporting mode for an invalid-config provider', async () => {
    const depsRef = refOf(
      baseDeps({
        provider: { kind: 'invalid-config', message: 'bad config' },
      }),
    )
    const commands = createWhiteboardCommands(depsRef)

    await expect(commands.getAppContext()).rejects.toMatchObject({
      code: 'invalid-provider-state',
    })
    await expect(commands.getAppContext()).rejects.toBeInstanceOf(CommandError)
  })

  it('excludes secret-bearing fields even given a poisoned ProviderState (simulated future drift)', async () => {
    // Real ProviderState carries no token field today; this cast simulates
    // a future field added to ProviderState leaking through if the
    // projection were ever changed to a spread instead of field-by-field.
    const poisoned = {
      kind: 'local-daemon',
      daemonBaseUrl: 'http://127.0.0.1:9999',
      capabilities: BROWSER_LOCAL_CAPABILITIES,
      token: 'shh',
      authorization: 'Bearer shh',
      secret: 'shh',
    } as unknown as import('../provider.js').ProviderState
    const depsRef = refOf(baseDeps({ provider: poisoned }))
    const commands = createWhiteboardCommands(depsRef)

    const result = await commands.getAppContext()
    const serialized = JSON.stringify(result).toLowerCase()

    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('9999')
  })
})
