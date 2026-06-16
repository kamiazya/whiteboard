import { describe, it, expect, afterEach, vi } from 'vitest'

// Nearest-layer test for the Vite dev-server plugin that injects
// window.__WHITEBOARD_RUNTIME_CONFIG__ into the HTML served by `pnpm dev`.
// We import the plugin factory directly and exercise its transformIndexHtml
// hook so no running Vite server is needed.

describe('runtimeConfigDevPlugin', () => {
  const origEnv = process.env.WHITEBOARD_TOKEN

  afterEach(() => {
    vi.resetModules()
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

  it('reads WHITEBOARD_TOKEN env var when set (env is read inside transformIndexHtml at call time)', async () => {
    // vi.resetModules() in afterEach ensures this import loads a fresh module
    // execution, not a cached copy from the previous test. The env override
    // is also read inside transformIndexHtml at invocation time (not at module
    // load time), so the test would pass even without module reset — but the
    // reset makes that guarantee explicit and future-proof against a refactor
    // that moves the env read to module scope.
    process.env.WHITEBOARD_TOKEN = 'custom-token-xyz'
    const { runtimeConfigDevPlugin } = await import('./vite-dev-token-plugin.js')
    const plugin = runtimeConfigDevPlugin()
    const result = (plugin as { transformIndexHtml: (html: string) => string }).transformIndexHtml(
      '<html><head></head><body></body></html>',
    )
    expect(result).toContain('"custom-token-xyz"')
    expect(result).not.toContain('"whiteboard-dev"')
  })

  it('escapes `<` in the token so a </script>-containing value cannot break out of the script tag', async () => {
    // A token value of `x</script><script>alert(1)` would terminate the
    // injected script element prematurely without this guard. The production
    // server path applies the same escape before inlining runtime config.
    process.env.WHITEBOARD_TOKEN = 'x</script><script>alert(1)'
    const { runtimeConfigDevPlugin } = await import('./vite-dev-token-plugin.js')
    const plugin = runtimeConfigDevPlugin()
    const result = (plugin as { transformIndexHtml: (html: string) => string }).transformIndexHtml(
      '<html><head></head><body></body></html>',
    )
    expect(result).not.toContain('</script><script>')
    expect(result).toContain('\\u003c/script>')
  })

  it('plugin has apply: "serve" so it does not run during production builds', async () => {
    const { runtimeConfigDevPlugin } = await import('./vite-dev-token-plugin.js')
    const plugin = runtimeConfigDevPlugin()
    expect((plugin as { apply?: string }).apply).toBe('serve')
  })
})
