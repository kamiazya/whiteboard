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
  it.each(PAGES)('%s attaches one after its save', async (page) => {
    const source = await read(page)
    expect(
      source.includes('attachVersionThumbnail('),
      `${page} saves a version and never attaches a picture to it — its keeper's rows would be the ones that silently have none`,
    ).toBe(true)
  })

  it.each(PAGES)('%s captures the picture before the save, not inside the attach', async (page) => {
    // The bytes handed to the attach must be something captured EARLIER.
    // `exportScene` reads the live scene at call time, so a `getBlob` that
    // calls it runs after the save has resolved — and draws an edit made
    // during the save onto the older point, a picture of content that
    // version does not contain.
    const source = await read(page)
    const getBlob = /getBlob:\s*([^,\n]*)/.exec(source)?.[1] ?? ''
    expect(getBlob, `${page} has no getBlob argument to check`).not.toBe('')
    expect(
      /exportScene|getThumbnailBlob|captureBookmarkPicture/.test(getBlob),
      `${page} renders the picture inside getBlob, so it is taken after the save resolves — capture it before the save and hand the promise over`,
    ).toBe(false)
  })

  it.each(PAGES)('%s starts the capture before it asks for the save', async (page) => {
    // The check above is satisfied by a page that renders AFTER its save
    // resolves and only then assigns the variable — the very ordering the
    // change was about. So compare where each happens: the capture has to
    // come first in the source, which for two straight-line functions is
    // the order they run in.
    const source = await read(page)
    const at = (label: string, pattern: RegExp): number => {
      const found = [...source.matchAll(pattern)]
      // Exactly one, or "the first occurrence" would be a different
      // statement from the one that matters and the order would say nothing.
      expect(found.length, `${page}: expected one ${label}, found ${found.length}`).toBe(1)
      return found[0]?.index ?? -1
    }
    const capture = at(
      'picture capture',
      /const picture = (?:captureBookmarkPicture\(|getThumbnailBlob\(\))/g,
    )
    const save = at('version save', /versionsBackend\.save\(|documentsApiUrl\([^)]*'versions'\)/g)
    expect(
      capture,
      `${page} asks for the picture at ${capture} and saves at ${save} — capture it first, or the picture can hold an edit made during the save`,
    ).toBeLessThan(save)
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
