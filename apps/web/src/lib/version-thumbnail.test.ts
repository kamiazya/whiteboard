import { describe, expect, it, vi } from 'vitest'
import { attachVersionThumbnail } from './version-thumbnail.js'

const WHERE = {
  workspaceId: 'ws-1',
  path: 'canvas-a',
  versionId: 'v-7',
} as const

const keeper = (putThumbnail = vi.fn(async () => {})) => ({
  backend: { putThumbnail },
  putThumbnail,
})

/**
 * The picture a bookmark carries.
 *
 * It used to be covered through the daemon page, and that net was lost when
 * the save moved onto the page itself: the exporter it now calls answers null
 * under jsdom, so a page-level test had no injection point and would have had
 * to fake the very thing it was checking. Extracting the attach is what puts a
 * real one back — the three outcomes below are exactly what a reader cannot
 * see from the call site, because all three look like the same `void`.
 */
describe('attaching a bookmark thumbnail', () => {
  it('hands the picture to the keeper, for that point of that document', async () => {
    const { backend, putThumbnail } = keeper()
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    const outcome = await attachVersionThumbnail({ ...WHERE, backend, getBlob: async () => blob })

    expect(outcome).toBe('uploaded')
    // The version's own picture, not the document's latest — and addressed by
    // path, because a picture belongs to one point of one document.
    expect(putThumbnail).toHaveBeenCalledWith('ws-1', 'canvas-a', 'v-7', blob)
  })

  it('asks the keeper for nothing when there is no image to give it', async () => {
    const { backend, putThumbnail } = keeper()

    const outcome = await attachVersionThumbnail({ ...WHERE, backend, getBlob: async () => null })

    expect(outcome).toBe('no-image')
    expect(putThumbnail).not.toHaveBeenCalled()
  })

  it('answers failed rather than throwing, whichever half went wrong', async () => {
    // The bookmark is already saved by the time this runs. A thrown exporter
    // or a keeper that refuses must not read as a failed bookmark.
    const threw = await attachVersionThumbnail({
      ...WHERE,
      backend: keeper().backend,
      getBlob: async () => {
        throw new Error('no renderer')
      },
    })
    expect(threw).toBe('failed')

    const refused = await attachVersionThumbnail({
      ...WHERE,
      backend: {
        putThumbnail: async () => {
          throw new Error('keeper refused')
        },
      },
      getBlob: async () => new Blob(['png']),
    })
    expect(refused).toBe('failed')
  })
})
