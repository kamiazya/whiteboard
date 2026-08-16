import { describe, expect, it, vi } from 'vitest'

// initTracing() installs its own SIGTERM/SIGINT listeners the moment
// tracing is enabled. Once ANY listener is registered for a signal, Node
// stops applying its default terminate-the-process behavior for it, so a
// signal arriving after tracing installs its listeners but before this
// module's own lifecycle handler is installed would otherwise be silently
// swallowed. This test locks in the fix: installStdioLifecycle() must run
// before initTracing() so a startup-window signal is always handled.
vi.mock('./logging.js', () => ({
  wireMcpLogging: vi.fn(() => ({ restore: vi.fn() })),
}))
vi.mock('./session-resolver.js', () => ({
  ensureWorkspaceId: vi.fn(async () => 'ws_test'),
}))
vi.mock('./standalone-help.js', () => ({
  buildDrawDiagramPrompt: vi.fn(() => ''),
  getStandaloneHelpText: vi.fn(() => ''),
  WHITEBOARD_DRAW_PROMPT: 'draw-diagram',
  WHITEBOARD_HELP_URI: 'whiteboard://help',
}))
vi.mock('../config.js', () => ({
  getDataDir: vi.fn(() => '/tmp/whiteboard-index-test'),
  WHITEBOARD_ROOT: '/tmp/whiteboard-index-test-root',
}))
vi.mock('../observability/tracing.js', () => ({
  initTracing: vi.fn(async () => null),
  shutdownTracing: vi.fn(async () => undefined),
}))
vi.mock('../store/db/prepare.js', () => ({
  prepareDataDir: vi.fn(async () => undefined),
}))
vi.mock('./stdio-lifecycle.js', () => ({
  installStdioLifecycle: vi.fn(() => () => undefined),
}))
vi.mock('./opencanvas-tools.js', () => ({
  registerOpenCanvasTools: vi.fn(),
}))
vi.mock('../store/db/index.js', () => ({
  getDb: vi.fn(async () => ({})),
}))
vi.mock('../../di/store-local.module.js', () => ({
  createStoreLocalModule: vi.fn(() => 'fake-store-local-module'),
}))
vi.mock('../../di/container.js', () => ({
  createContainer: vi.fn(() => 'fake-container'),
  resolveServerDeps: vi.fn(() => ({
    documentStore: {},
    blobStore: {},
  })),
}))
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: vi.fn(function FakeMcpServer(this: Record<string, unknown>) {
    this.server = { registerCapabilities: vi.fn() }
    this.registerResource = vi.fn()
    this.registerPrompt = vi.fn()
    this.connect = vi.fn(async () => undefined)
    this.close = vi.fn(async () => undefined)
  }),
}))
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
}))

describe('main()', () => {
  it('installs the stdio lifecycle handler before initTracing so a startup-window signal is never swallowed', async () => {
    const { main } = await import('./index.js')
    const { installStdioLifecycle } = await import('./stdio-lifecycle.js')
    const { initTracing } = await import('../observability/tracing.js')

    await main()

    const installCallOrder = vi.mocked(installStdioLifecycle).mock.invocationCallOrder[0]
    const tracingCallOrder = vi.mocked(initTracing).mock.invocationCallOrder[0]
    expect(installCallOrder).toBeDefined()
    expect(tracingCallOrder).toBeDefined()
    expect(installCallOrder).toBeLessThan(tracingCallOrder as number)
  })

  it('serves stdio through serveStdio with a per-connection factory', async () => {
    const { main } = await import('./index.js')
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio')

    await main()

    // serveStdio owns the connection's era decision; main() must hand it a
    // FACTORY (not a pre-built server), so each opening exchange can pin a
    // fresh instance for its era.
    expect(serveStdio).toHaveBeenCalled()
    const [factory] = vi.mocked(serveStdio).mock.calls.at(-1) ?? []
    expect(typeof factory).toBe('function')
  })
})
