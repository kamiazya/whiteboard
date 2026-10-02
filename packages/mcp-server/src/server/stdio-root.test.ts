import { describe, expect, it, vi } from 'vitest'

// initTracing() installs its own SIGTERM/SIGINT listeners the moment
// tracing is enabled. Once ANY listener is registered for a signal, Node
// stops applying its default terminate-the-process behavior for it, so a
// signal arriving after tracing installs its listeners but before this
// module's own lifecycle handler is installed would otherwise be silently
// swallowed. This test locks in the fix: installStdioLifecycle() must run
// before initTracing() so a startup-window signal is always handled.
vi.mock('./config.js', () => ({
  getDataDir: vi.fn(() => '/tmp/whiteboard-index-test'),
  WHITEBOARD_ROOT: '/tmp/whiteboard-index-test-root',
}))
vi.mock('./observability/tracing.js', () => ({
  initTracing: vi.fn(async () => null),
  shutdownTracing: vi.fn(async () => undefined),
}))
const booted = { serverDeps: { marker: 'deps' }, scope: { marker: 'scope' } }
vi.mock('../di/boot-self-host-deps.js', () => ({
  bootSelfHostDeps: vi.fn(async () => booted),
}))
vi.mock('./shared-background-work.js', () => ({
  stdioBackgroundWork: vi.fn(() => ['declared-work']),
}))
vi.mock('./background-work.js', () => ({
  startBackgroundWork: vi.fn(() => ({ stopAll: vi.fn(async () => undefined) })),
}))
vi.mock('./mcp/stdio-lifecycle.js', () => ({
  installStdioLifecycle: vi.fn(() => () => undefined),
}))
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
}))

const { main } = await import('./stdio-root.js')
const { installStdioLifecycle } = await import('./mcp/stdio-lifecycle.js')
const { initTracing } = await import('./observability/tracing.js')
const { serveStdio } = await import('@modelcontextprotocol/server/stdio')
const { stdioBackgroundWork } = await import('./shared-background-work.js')
const { startBackgroundWork } = await import('./background-work.js')

describe('main()', () => {
  it('installs the stdio lifecycle handler before initTracing so a startup-window signal is never swallowed', async () => {
    await main()

    const installCallOrder = vi.mocked(installStdioLifecycle).mock.invocationCallOrder[0]
    const tracingCallOrder = vi.mocked(initTracing).mock.invocationCallOrder[0]
    expect(installCallOrder).toBeDefined()
    expect(tracingCallOrder).toBeDefined()
    expect(installCallOrder).toBeLessThan(tracingCallOrder as number)
  })

  it('serves stdio through serveStdio with a per-connection factory', async () => {
    await main()

    // serveStdio owns the connection's era decision; main() must hand it a
    // FACTORY (not a pre-built server), so each opening exchange can pin a
    // fresh instance for its era.
    expect(serveStdio).toHaveBeenCalled()
    const [factory] = vi.mocked(serveStdio).mock.calls.at(-1) ?? []
    expect(typeof factory).toBe('function')
  })
})

describe('the stdio root serves the directory it booted', () => {
  it('runs its background work over the scope its deps were booted over', async () => {
    await main()

    expect(stdioBackgroundWork).toHaveBeenLastCalledWith(booted.scope)
    expect(startBackgroundWork).toHaveBeenLastCalledWith(['declared-work'])
  })
})
