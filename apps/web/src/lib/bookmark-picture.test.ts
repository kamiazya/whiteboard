import { describe, expect, it, vi } from 'vitest'
import { captureBookmarkPicture } from './bookmark-picture.js'

const NEVER_ASKED = () => {
  throw new Error('the spatial exporter must not be asked for a markdown document')
}

describe('captureBookmarkPicture', () => {
  // The defect this exists for, measured in a real browser before it was
  // written: a markdown document publishes no canvas, so `exportScene('png')`
  // drew an empty one and produced a valid 1x1 138-byte PNG. It uploaded
  // fine, the row's `hasThumbnail` went true, and every markdown version row
  // in daemon mode drew an empty bordered box.
  it('draws a markdown document from its body, never from the spatial exporter', async () => {
    const picture = new Blob([new Uint8Array([1])], { type: 'image/png' })
    const renderMarkdown = vi.fn(async (_body: string, _maxWidth: number) => picture)

    const blob = await captureBookmarkPicture('markdown', {
      exportScene: NEVER_ASKED,
      body: '# Heading\n\nA paragraph.\n',
      renderMarkdown,
    })

    expect(blob).toBe(picture)
    expect(renderMarkdown).toHaveBeenCalledTimes(1)
    // The body it was handed, not some other string: the picture has to be
    // of the document the bookmark is about.
    expect(renderMarkdown).toHaveBeenCalledWith('# Heading\n\nA paragraph.\n', 640)
  })

  it('leaves a spatial document to the exporter the page already owns', async () => {
    const picture = new Blob([new Uint8Array([1])], { type: 'image/png' })
    const exportScene = vi.fn(async () => picture)
    const renderMarkdown = vi.fn(async () => null)

    const blob = await captureBookmarkPicture('spatial', {
      exportScene,
      body: null,
      renderMarkdown,
    })

    expect(blob).toBe(picture)
    // PNG explicitly: the daemon's route validates the signature on upload,
    // and one keeper rejecting what the other accepts is the difference the
    // versions seam exists to remove.
    expect(exportScene).toHaveBeenCalledWith('png')
    expect(renderMarkdown).not.toHaveBeenCalled()
  })

  // Null rather than a picture of nothing. `attachVersionThumbnail` reads
  // null as 'no-image' and uploads nothing, so the row keeps `hasThumbnail`
  // false and draws no box at all — which is what an empty document should
  // look like in a history list.
  it('answers nothing for a markdown document with nothing in it', async () => {
    const renderMarkdown = vi.fn(async () => new Blob([]))

    for (const body of [null, '', '   \n  ']) {
      expect(
        await captureBookmarkPicture('markdown', {
          exportScene: NEVER_ASKED,
          body,
          renderMarkdown,
        }),
      ).toBeNull()
    }
    expect(renderMarkdown).not.toHaveBeenCalled()
  })

  // Total by contract, for the reason the attach is: the bookmark has already
  // landed by the time this runs, so a renderer that throws must cost the
  // picture and not the saved point.
  it('answers nothing when the renderer refuses rather than letting it reach the save', async () => {
    expect(
      await captureBookmarkPicture('markdown', {
        exportScene: NEVER_ASKED,
        body: '# Heading',
        renderMarkdown: async () => {
          throw new Error('worker gone')
        },
      }),
    ).toBeNull()

    expect(
      await captureBookmarkPicture('spatial', {
        exportScene: async () => {
          throw new Error('no 2D context')
        },
        body: null,
      }),
    ).toBeNull()
  })
})
