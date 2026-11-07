// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createDaemonFileAdapter } from './daemon-file-adapter.js'
import { replicaClipboardImages } from './replica-clipboard-images.js'

const BASE = 'http://127.0.0.1:3099'

describe('replicaClipboardImages', () => {
  it('scopes pictures exactly as a daemon adapter with no open document does', () => {
    const adapter = createDaemonFileAdapter({
      daemonFetch: vi.fn(),
      daemonBaseUrl: BASE,
      workspaceId: 'ws-1',
      documentId: undefined,
    })
    expect(replicaClipboardImages(BASE, 'ws-1').fileScope).toBe(adapter.fileScope)
  })

  it('refuses to store a picture, and never reaches the daemon to do it', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const stored = await replicaClipboardImages(BASE, 'ws-1').storeImage(
        new File(['x'], 'x.png', { type: 'image/png' }),
      )
      expect(stored.ok).toBe(false)
      expect(stored.ok ? '' : stored.reason).toContain('stored by the daemon, which is unreachable')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
