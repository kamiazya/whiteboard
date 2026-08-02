import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WhiteboardCommands } from '../commands/index.js'
import { webMcpTools } from './tool-definitions.js'
import type { ModelContext, WebMcpToolDescriptor } from './use-browser-tool-registry.js'
import { useBrowserToolRegistry } from './use-browser-tool-registry.js'

function fakeCommands(): WhiteboardCommands {
  return {
    getAppContext: async () => ({
      provider: { mode: 'browser-local' },
      canvas: { kind: 'browser-local', canvasId: 'c1' },
    }),
  }
}

/**
 * Fake of `document.modelContext` shaped to Chrome's ACTUAL behaviour, verified
 * against the shipping implementation:
 *
 * - `registerTool` is **synchronous and returns `undefined`** — not a promise.
 *   An earlier fake returned one, which let the production code call `.catch()`
 *   on the result and crash the whole page in any browser that really has
 *   WebMCP, while every test stayed green.
 * - The optional `{ signal }` bag IS honoured: aborting unregisters the tool.
 *   (`registerTool.length` is 1 because WebIDL counts only required arguments.)
 * - Registering a name that is already live throws `InvalidStateError`
 *   synchronously.
 */
function createFakeModelContext(): ModelContext & {
  liveNames(): string[]
  throwNextRegistration: boolean
} {
  const live = new Set<string>()
  const fake = {
    throwNextRegistration: false,
    liveNames: () => [...live],
    registerTool: (descriptor: WebMcpToolDescriptor, options?: { signal: AbortSignal }): void => {
      if (fake.throwNextRegistration) {
        fake.throwNextRegistration = false
        throw new Error('registration refused')
      }
      if (live.has(descriptor.name)) {
        throw new DOMException('Duplicate tool name', 'InvalidStateError')
      }
      if (options?.signal.aborted) return
      live.add(descriptor.name)
      options?.signal.addEventListener('abort', () => live.delete(descriptor.name))
    },
  }
  return fake
}

function TestHarness({
  commands,
  canvasKey,
  enabled,
}: {
  commands: WhiteboardCommands
  canvasKey: string | null
  enabled?: boolean
}) {
  useBrowserToolRegistry(commands, canvasKey, enabled)
  return null
}

describe('useBrowserToolRegistry', () => {
  afterEach(() => {
    delete (document as { modelContext?: unknown }).modelContext
  })

  it('is a complete no-op when document.modelContext is absent', () => {
    expect(document.modelContext).toBeUndefined()
    const { unmount } = render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
    // No throw, nothing to assert on a registry that never existed — the
    // absence of a crash/registration attempt IS the behavior under test.
    unmount()
  })

  it('registers every read-only tool on mount, re-registers on canvas key change, and cancels on unmount', async () => {
    const expectedNames = webMcpTools.map((tool) => tool.name).sort()
    const fake = createFakeModelContext()
    document.modelContext = fake

    const { rerender, unmount } = render(
      <TestHarness commands={fakeCommands()} canvasKey="canvas-a" />,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.liveNames().sort()).toEqual(expectedNames)

    rerender(<TestHarness commands={fakeCommands()} canvasKey="canvas-b" />)
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.liveNames().sort()).toEqual(expectedNames)

    unmount()
    expect(fake.liveNames()).toEqual([])
  })

  it('executor result is schema-shaped and contains no secret-bearing fields', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake
    let captured: WebMcpToolDescriptor | undefined
    document.modelContext.registerTool = async (descriptor) => {
      if (descriptor.name === 'whiteboard_get_app_context') captured = descriptor
    }

    render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
    await Promise.resolve()

    expect(captured).toBeDefined()
    const result = await captured!.execute({})
    const serialized = JSON.stringify(result).toLowerCase()
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('daemonbaseurl')
    expect(result).toEqual({
      provider: { mode: 'browser-local' },
      canvas: { kind: 'browser-local', canvasId: 'c1' },
    })
  })

  it('unmounting aborts the signal, which unregisters every tool', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    const { unmount } = render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
    expect(fake.liveNames().length).toBeGreaterThan(0)

    unmount()
    await Promise.resolve()

    expect(fake.liveNames()).toEqual([])
  })

  it('registration returning undefined does not crash the effect', () => {
    // The regression that took down the whole canvas page in every browser
    // with a real WebMCP implementation: the effect treated registerTool's
    // return value as a promise. Nothing here may throw.
    const live: string[] = []
    document.modelContext = {
      registerTool: (descriptor) => {
        live.push(descriptor.name)
        // Deliberately no return — this is what Chrome does.
      },
    }

    expect(() => render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)).not.toThrow()
    expect(live).toEqual(webMcpTools.map((tool) => tool.name))
  })

  it('a duplicate-name refusal is caught instead of taking down the page', () => {
    // Chrome throws InvalidStateError synchronously for an already-live name.
    const fake = createFakeModelContext()
    document.modelContext = fake
    fake.registerTool({
      name: webMcpTools[0]!.name,
      description: 'squatter',
      inputSchema: {},
      execute: async () => ({}),
    })

    expect(() => render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)).not.toThrow()
  })

  it('a synchronous registration failure is caught and never escapes the effect', async () => {
    const fake = createFakeModelContext()
    fake.throwNextRegistration = true
    document.modelContext = fake

    const onUnhandledRejection = () => {
      throw new Error('unhandled rejection leaked from useBrowserToolRegistry')
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('does not attempt registration when canvasKey is null (no canvas open)', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    render(<TestHarness commands={fakeCommands()} canvasKey={null} />)
    await Promise.resolve()
    await Promise.resolve()

    expect(fake.liveNames()).toEqual([])
  })

  it('does not attempt registration when enabled is explicitly false', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    render(<TestHarness commands={fakeCommands()} canvasKey="c1" enabled={false} />)
    await Promise.resolve()
    await Promise.resolve()

    expect(fake.liveNames()).toEqual([])
  })

  it('advertises readOnlyHint: true for every registered tool', async () => {
    const fake = createFakeModelContext()
    const captured: WebMcpToolDescriptor[] = []
    document.modelContext = fake
    document.modelContext.registerTool = async (descriptor) => {
      captured.push(descriptor)
    }

    render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
    await Promise.resolve()

    expect(captured.length).toBeGreaterThan(0)
    for (const descriptor of captured) {
      expect(descriptor.annotations?.readOnlyHint).toBe(true)
    }
  })

  it('forwards the caller-supplied args into the underlying command instead of always calling it with {}', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake
    let captured: WebMcpToolDescriptor | undefined
    document.modelContext.registerTool = async (descriptor) => {
      if (descriptor.name === 'whiteboard_get_app_context') captured = descriptor
    }
    let receivedInput: unknown
    const commands: WhiteboardCommands = {
      ...fakeCommands(),
      getAppContext: async (input) => {
        receivedInput = input
        return { provider: { mode: 'browser-local' }, canvas: null }
      },
    }

    render(<TestHarness commands={commands} canvasKey="c1" />)
    await Promise.resolve()

    await captured!.execute({ unexpected: true })
    expect(receivedInput).toEqual({ unexpected: true })
  })

  it('rejects an args payload that violates the advertised empty-object input schema', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake
    let captured: WebMcpToolDescriptor | undefined
    document.modelContext.registerTool = async (descriptor) => {
      if (descriptor.name === 'whiteboard_get_app_context') captured = descriptor
    }

    // Real commands.getAppContext validates via its Zod input schema
    // (assertValidInput) and rejects extra keys — exercised here with the
    // real command layer via fakeCommands()'s sibling, createWhiteboardCommands.
    const { createWhiteboardCommands } = await import('../commands/create-commands.js')
    const { BROWSER_LOCAL_CAPABILITIES } = await import('../provider.js')
    const realCommands = createWhiteboardCommands({
      current: {
        provider: { kind: 'browser-local', capabilities: BROWSER_LOCAL_CAPABILITIES },
        canvas: { canvasId: 'c1', name: 'c1' },
      },
    })

    render(<TestHarness commands={realCommands} canvasKey="c1" />)
    await Promise.resolve()

    await expect(captured!.execute({ unexpected: true })).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })
})
