// A bookmark's picture, drawn by the pipeline that matches the document.
//
// A real browser, not jsdom: the subject is the whole chain a saved point's
// picture goes through — the worker's markdown layout, the viewer face
// embedded into the SVG, and the <img> + <canvas> rasterisation that turns it
// into the PNG the keeper stores. jsdom has no 2D context, so every one of
// those answers null there and the test would assert nothing.
import { expect, it } from 'vitest'
import { captureBookmarkPicture } from './bookmark-picture.js'

const BODY = '# Heading\n\nA paragraph with enough words in it to occupy a line.\n'

async function sizeOf(blob: Blob | null): Promise<{ w: number; h: number; bytes: number }> {
  expect(blob, 'no picture was produced').not.toBeNull()
  const bitmap = await createImageBitmap(blob as Blob)
  return { w: bitmap.width, h: bitmap.height, bytes: (blob as Blob).size }
}

// The measurement this was written from: `exportScene('png')` on a document
// that publishes no canvas answered a valid 1x1 PNG of 138 bytes, against
// 220x120 / 2295 bytes for a canvas holding one text node. Both are real
// pictures as far as the upload is concerned, which is why the row showed an
// empty box rather than no box.
it('draws a markdown body at its own size, where the spatial exporter answered a 1x1', async () => {
  const picture = await sizeOf(
    await captureBookmarkPicture('markdown', {
      exportScene: () => {
        throw new Error('the spatial exporter must not be asked for a markdown document')
      },
      body: BODY,
    }),
  )

  expect(picture.w).toBeGreaterThan(1)
  expect(picture.h).toBeGreaterThan(1)
  // Not merely "bigger than one pixel": a heading and a paragraph occupy
  // real height, so a picture a few pixels tall would still be the old
  // failure with a different number in it.
  expect(picture.h).toBeGreaterThan(20)
  expect(picture.bytes).toBeGreaterThan(138)
})

// The document's own shape, not a fixed frame: two bodies of different
// lengths must not produce the same picture, or the history list is showing
// a placeholder that happens to be the right size.
it('gives a longer body a taller picture', async () => {
  const short = await sizeOf(
    await captureBookmarkPicture('markdown', { exportScene: NEVER, body: '# One' }),
  )
  const long = await sizeOf(
    await captureBookmarkPicture('markdown', {
      exportScene: NEVER,
      body: `# One\n\n${'A paragraph of text.\n\n'.repeat(12)}`,
    }),
  )

  expect(long.h).toBeGreaterThan(short.h)
})

function NEVER(): never {
  throw new Error('the spatial exporter must not be asked for a markdown document')
}
