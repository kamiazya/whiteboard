import { describe, expect, it, vi } from 'vitest'
import { uploadVersionThumbnail } from './version-thumbnail.js'

const WHERE = {
  daemonBaseUrl: 'http://127.0.0.1:3099',
  workspaceId: 'ws-1',
  path: 'canvas-a',
  versionId: 'v-7',
} as const

function okFetch() {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
}

/**
 * The picture a bookmark carries.
 *
 * It used to be covered through the daemon page, and that net was lost when
 * the save moved onto the page itself: the exporter it now calls answers null
 * under jsdom, so a page-level test had no injection point and would have had
 * to fake the very thing it was checking. Extracting the upload is what puts a
 * real one back — the three outcomes below are exactly what a reader cannot
 * see from the call site, because all three look like the same `void`.
 */
describe('uploading a bookmark thumbnail', () => {
  it('PUTs the PNG to that version, and says it uploaded', async () => {
    const fetchImpl = okFetch()
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    const outcome = await uploadVersionThumbnail({
      ...WHERE,
      getBlob: async () => blob,
      fetchImpl,
    })

    expect(outcome).toBe('uploaded')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    // The version's own thumbnail, not the document's latest.
    expect(url).toBe(
      'http://127.0.0.1:3099/api/workspaces/ws-1/documents/canvas-a/versions/v-7/thumbnail',
    )
    expect(init.method).toBe('PUT')
    // The daemon validates a PNG signature and rejects anything else, so the
    // content type is not decoration.
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    expect(init.body).toBe(blob)
  })

  it('sends nothing when there is no image to send', async () => {
    const fetchImpl = okFetch()

    const outcome = await uploadVersionThumbnail({
      ...WHERE,
      getBlob: async () => null,
      fetchImpl,
    })

    expect(outcome).toBe('no-image')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers failed rather than throwing, whichever half went wrong', async () => {
    // The bookmark is already saved by the time this runs. A thrown exporter
    // or a refused upload must not read as a failed bookmark.
    const threw = await uploadVersionThumbnail({
      ...WHERE,
      getBlob: async () => {
        throw new Error('no renderer')
      },
      fetchImpl: okFetch(),
    })
    expect(threw).toBe('failed')

    const refused = await uploadVersionThumbnail({
      ...WHERE,
      getBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
      fetchImpl: vi.fn(
        async (_url: string, _init: RequestInit) => new Response('nope', { status: 415 }),
      ),
    })
    expect(refused).toBe('failed')
  })
})
