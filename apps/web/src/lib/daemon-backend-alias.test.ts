import { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'
import { describe, expect, it, vi } from 'vitest'

// Regression lock for the daemon-backend source alias in vite.config.ts /
// vitest.config.ts / vitest.browser.config.ts. The apiTransport constructor
// seam used here exists only in packages/mcp-server's workspace `src` on
// this branch — a stale-dist resolution of '@kamiazya/whiteboard-mcp/daemon-backend'
// would make this test fail to observe the injected fetch, catching alias
// drift the type system alone cannot.
describe('daemon-backend alias resolution', () => {
  it('uses the injected apiTransport.fetch for getFile instead of the module apiFetch', async () => {
    const injectedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: injectedFetch,
    })

    await backend.getFile('file-1')

    expect(injectedFetch).toHaveBeenCalledTimes(1)
    const [url] = injectedFetch.mock.calls[0]
    expect(String(url)).toContain('/api/w/ws1/canvas/main/file/file-1')
  })
})
