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
vi.mock('../store/libsql/libsql-canvas-doc-store.js', () => ({
  LibsqlCanvasDocStore: vi.fn(),
}))
vi.mock('../store/libsql/libsql-workspace-index.js', () => ({
  LibsqlWorkspaceIndex: vi.fn(),
}))
vi.mock('../store/fs/fs-blob-store.js', () => ({
  FsBlobStore: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(function FakeMcpServer(this: Record<string, unknown>) {
    this.server = { registerCapabilities: vi.fn() }
    this.registerResource = vi.fn()
    this.registerPrompt = vi.fn()
    this.connect = vi.fn(async () => undefined)
    this.close = vi.fn(async () => undefined)
  }),
}))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(function FakeStdioServerTransport() {}),
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
})
