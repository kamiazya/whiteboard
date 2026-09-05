// @vitest-environment node
/**
 * Both document pages must attach the picture a bookmark carries.
 *
 * The picture was the last part of a saved point only one keeper could have:
 * the attach used to PUT to the daemon's route, so a browser-kept bookmark
 * had nowhere to send one and silently carried none. It goes through the
 * seam now — but "through the seam" is not enough on its own, because a page
 * that never calls it is exactly as pictureless as before and no per-page
 * test would notice: each page's own tests only ever exercise its own mode,
 * which is the class `file-seam-conformance.test.ts` was written for.
 *
 * A source scan rather than a render, for that file's reason and one more of
 * its own: the blob comes from a real renderer — a 2D context jsdom does not
 * have — so a page-level test would have had to fake the very call it was
 * checking. What is actually this code's is asserted where it lives:
 * `lib/version-thumbnail.test.ts` for what reaches the keeper and that it
 * never throws over a bookmark that already landed, `lib/bookmark-picture`'s
 * two tests for which pipeline draws which kind and that the picture has the
 * document's own size.
 */
import { describe, expect, it } from 'vitest'

const PAGES = ['./BrowserDocumentPage.tsx', './DaemonDocumentPage.tsx'] as const

const sources = import.meta.glob('./{BrowserDocumentPage,DaemonDocumentPage}.tsx', {
  query: '?raw',
  import: 'default',
})

async function read(page: string): Promise<string> {
  const loader = sources[page]
  expect(loader, `no source loader for ${page}`).toBeDefined()
  return (await loader?.()) as string
}

describe('a saved point carries a picture, whoever keeps it', () => {
  it.each(PAGES)('%s routes its save through the shared body', async (page) => {
    // buildVersionSaveBody is where the beats live now — attach through the
    // seam, capture started BEFORE the save (mutation-checked in
    // lib/version-save-body.test.ts), the unawaited thumbnail ride-along,
    // the re-announce once the picture lands. A page that hand-rolls its
    // save again loses every one of those silently, which is exactly the
    // per-page blindness this file exists for.
    const source = await read(page)
    expect(
      source.includes('buildVersionSaveBody('),
      `${page} saves a version without the shared body — its keeper's rows would be the ones that silently lose the pinned save beats`,
    ).toBe(true)
  })

  it.each(
    PAGES,
  )('%s picks the picture by the document kind, not by assuming a canvas', async (page) => {
    // The defect this replaces an older check for: both pages captured
    // `exportScene('png')` whatever they were editing, and that draws the
    // SPATIAL canvas. A markdown document publishes none, so the export was
    // a valid 1x1 PNG — uploaded like any other, and drawn as an empty box
    // on every markdown version row. Passing the kind is what makes the
    // choice exist at all; which pipeline each kind gets, and that both
    // answer PNG, is `lib/bookmark-picture.test.ts`.
    const source = await read(page)
    expect(
      source,
      `${page} captures its bookmark picture without saying what kind of document it is — a markdown document would be drawn as an empty canvas`,
    ).toMatch(/captureBookmarkPicture\(\s*documentKind/)
  })
})
