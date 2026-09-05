// @vitest-environment node
import { DaemonBackend } from '@kamiazya/whiteboard-daemon-client/daemon-backend'
import { describe, expect, it, vi } from 'vitest'

// Regression lock for source-level resolution of the daemon-client package.
// Its explicit `exports` map points every subpath at `src/*.ts`, so there is no
// dist to go stale — and this test keeps it that way: if the package ever
// switches its exports to a built dist, a stale build's DaemonBackend would
// stop observing the injected fetch here before anything subtler breaks.
describe('daemon-backend alias resolution', () => {
  it('uses the injected apiTransport.fetch for getFile instead of the module apiFetch', async () => {
    const injectedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: injectedFetch,
    })

    await backend.getFile('file-1')

    expect(injectedFetch).toHaveBeenCalledTimes(1)
    const [url] = injectedFetch.mock.calls[0]
    expect(String(url)).toContain('/api/w/ws1/document/main/file/file-1')
  })
})
