import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WhiteboardCommands } from '../commands/index.js'
import type { ModelContext, WebMcpToolDescriptor } from './use-browser-tool-registry.js'
import { useBrowserToolRegistry } from './use-browser-tool-registry.js'

function fakeCommands(): WhiteboardCommands {
  return {
    exportJson: async () => {
      throw new Error('not used in this test')
    },
    getSceneSummary: async () => ({
      elementCount: 1,
      selectedCount: 0,
      typeCounts: { rectangle: 1 },
      viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
    }),
    getAppContext: async () => ({
      provider: { mode: 'browser-local' },
      canvas: { kind: 'browser-local', canvasId: 'c1' },
    }),
  }
}

/** A minimal async fake of document.modelContext for lifecycle assertions. */
function createFakeModelContext(): ModelContext & {
  liveNames(): string[]
  rejectNextRegistration: boolean
} {
  const live = new Map<string, AbortSignal>()
  const fake = {
    rejectNextRegistration: false,
    liveNames: () => [...live.keys()],
    registerTool: async (descriptor: WebMcpToolDescriptor, options: { signal: AbortSignal }) => {
      if (fake.rejectNextRegistration) {
        fake.rejectNextRegistration = false
        throw new Error('registration refused')
      }
      // Simulate an async registration hop.
      await Promise.resolve()
      if (options.signal.aborted) return
      live.set(descriptor.name, options.signal)
      options.signal.addEventListener('abort', () => live.delete(descriptor.name))
    },
  }
  return fake
}

function TestHarness({
  commands,
  canvasKey,
}: {
  commands: WhiteboardCommands
  canvasKey: string | null
}) {
  useBrowserToolRegistry(commands, canvasKey)
  return null
}

describe('useBrowserToolRegistry', () => {
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup of a global test double
    delete (document as { modelContext?: unknown }).modelContext
  })

  it('is a complete no-op when document.modelContext is absent', () => {
    expect(document.modelContext).toBeUndefined()
    const { unmount } = render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
    // No throw, nothing to assert on a registry that never existed — the
    // absence of a crash/registration attempt IS the behavior under test.
    unmount()
  })

  it('registers both read-only tools on mount, re-registers on canvas key change, and cancels on unmount', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    const { rerender, unmount } = render(
      <TestHarness commands={fakeCommands()} canvasKey="canvas-a" />,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.liveNames().sort()).toEqual([
      'whiteboard_get_app_context',
      'whiteboard_get_scene_summary',
    ])

    rerender(<TestHarness commands={fakeCommands()} canvasKey="canvas-b" />)
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.liveNames().sort()).toEqual([
      'whiteboard_get_app_context',
      'whiteboard_get_scene_summary',
    ])

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

  it('an abort fired before registerTool resolves leaves no live tool registered', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    const { unmount } = render(<TestHarness commands={fakeCommands()} canvasKey="c1" />)
    // Unmount (which aborts) before the microtask queue lets the fake's
    // `await Promise.resolve()` inside registerTool settle.
    unmount()
    await Promise.resolve()
    await Promise.resolve()

    expect(fake.liveNames()).toEqual([])
  })

  it('a rejected registration is caught and never becomes an unhandled rejection', async () => {
    const fake = createFakeModelContext()
    fake.rejectNextRegistration = true
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
})
