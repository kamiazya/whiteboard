import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { describe, expect, it, vi } from 'vitest'

// web-browser mirror of daemon-backend-alias.test.ts: locks the same
// alias in vitest.browser.config.ts so the apiTransport seam resolves from
// workspace src (not a possibly-stale dist) in the real-browser project too.
describe('daemon-backend alias resolution (browser)', () => {
  it('uses the injected apiTransport.fetch for getFile instead of the module apiFetch', async () => {
    const injectedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: injectedFetch,
    })

    await backend.getFile('file-1')

    expect(injectedFetch).toHaveBeenCalledTimes(1)
    const [url] = injectedFetch.mock.calls[0]
    expect(String(url)).toContain('/api/canvas/ws1/main/file/file-1')
  })
})
