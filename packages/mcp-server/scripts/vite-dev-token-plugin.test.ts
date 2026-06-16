import { describe, it, expect, afterEach } from 'vitest'

// Nearest-layer test for the Vite dev-server plugin that injects
// window.__WHITEBOARD_RUNTIME_CONFIG__ into the HTML served by `pnpm dev`.
// We import the plugin factory directly and exercise its transformIndexHtml
// hook so no running Vite server is needed.

describe('runtimeConfigDevPlugin', () => {
  const origEnv = process.env.WHITEBOARD_TOKEN

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.WHITEBOARD_TOKEN
    } else {
      process.env.WHITEBOARD_TOKEN = origEnv
    }
  })

  it('injects a <script> that sets window.__WHITEBOARD_RUNTIME_CONFIG__ with the default token', async () => {
    delete process.env.WHITEBOARD_TOKEN
    const { runtimeConfigDevPlugin } = await import('./vite-dev-token-plugin.js')
    const plugin = runtimeConfigDevPlugin()
    const result = (plugin as { transformIndexHtml: (html: string) => string }).transformIndexHtml(
      '<html><head></head><body></body></html>',
    )
    expect(result).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(result).toContain('"daemonToken"')
    expect(result).toContain('"whiteboard-dev"')
    expect(result).toContain('<script>')
  })

  it('reads WHITEBOARD_TOKEN env var when set', async () => {
    process.env.WHITEBOARD_TOKEN = 'custom-token-xyz'
    // Re-import to pick up env at call time (the function reads process.env at call time)
    const { runtimeConfigDevPlugin } = await import('./vite-dev-token-plugin.js')
    const plugin = runtimeConfigDevPlugin()
    const result = (plugin as { transformIndexHtml: (html: string) => string }).transformIndexHtml(
      '<html><head></head><body></body></html>',
    )
    expect(result).toContain('"custom-token-xyz"')
    expect(result).not.toContain('"whiteboard-dev"')
  })

  it('plugin has apply: "serve" so it does not run during production builds', async () => {
    const { runtimeConfigDevPlugin } = await import('./vite-dev-token-plugin.js')
    const plugin = runtimeConfigDevPlugin()
    expect((plugin as { apply?: string }).apply).toBe('serve')
  })
})
