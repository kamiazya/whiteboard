// @vitest-environment node
/**
 * A saved point carries a picture, whoever keeps it.
 *
 * The picture was the last part of a saved point only one keeper could have:
 * the attach used to PUT to the daemon's route, so a browser-kept bookmark
 * had nowhere to send one and silently carried none. The save flow lives in
 * the shared `DocumentPage` now, so there is one site to hold — but a source
 * scan still earns its place, for the reason `file-seam-conformance.test.ts`
 * gives and one more of its own: the blob comes from a real renderer — a 2D
 * context jsdom does not have — so a page-level test would have had to fake
 * the very call it was checking. What is actually this code's is asserted
 * where it lives: `lib/version-thumbnail.test.ts` for what reaches the
 * keeper and that it never throws over a bookmark that already landed,
 * `lib/bookmark-picture`'s two tests for which pipeline draws which kind and
 * that the picture has the document's own size.
 */
import { describe, expect, it } from 'vitest'

const PAGE = './DocumentPage.tsx'

const sources = import.meta.glob('./DocumentPage.tsx', {
  query: '?raw',
  import: 'default',
})

async function read(page: string): Promise<string> {
  const loader = sources[page]
  expect(loader, `no source loader for ${page}`).toBeDefined()
  return (await loader?.()) as string
}

describe('a saved point carries a picture, whoever keeps it', () => {
  it('the shared page routes its save through the shared body', async () => {
    // buildVersionSaveBody is where the beats live — attach through the
    // seam, capture started BEFORE the save (mutation-checked in
    // lib/version-save-body.test.ts), the unawaited thumbnail ride-along,
    // the re-announce once the picture lands. A page that hand-rolls its
    // save again loses every one of those silently.
    const source = await read(PAGE)
    expect(
      source.includes('buildVersionSaveBody('),
      `${PAGE} saves a version without the shared body — every keeper's rows would silently lose the pinned save beats`,
    ).toBe(true)
  })

  it('the shared page picks the picture by the document kind, not by assuming a canvas', async () => {
    // The defect this replaces an older check for: both pages captured
    // `exportScene('png')` whatever they were editing, and that draws the
    // SPATIAL canvas. A markdown document publishes none, so the export was
    // a valid 1x1 PNG — uploaded like any other, and drawn as an empty box
    // on every markdown version row. Passing the kind is what makes the
    // choice exist at all; which pipeline each kind gets, and that both
    // answer PNG, is `lib/bookmark-picture.test.ts`.
    const source = await read(PAGE)
    expect(
      source,
      `${PAGE} captures its bookmark picture without saying what kind of document it is — a markdown document would be drawn as an empty canvas`,
    ).toMatch(/captureBookmarkPicture\(\s*documentKind/)
  })
})
