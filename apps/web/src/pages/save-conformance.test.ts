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
 * its own: the blob comes from `exportScene('png')`, which needs a real
 * renderer, so a page-level test would have had to fake the very call it was
 * checking. What is actually this code's — what it hands the keeper, and
 * that it never throws over a bookmark that already landed — is asserted in
 * `lib/version-thumbnail.test.ts`.
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
      /exportScene|getThumbnailBlob/.test(getBlob),
      `${page} renders the picture inside getBlob, so it is taken after the save resolves — capture it before the save and hand the promise over`,
    ).toBe(false)
  })

  it.each(PAGES)('%s asks its own renderer for the bytes', async (page) => {
    // PNG explicitly: the daemon's route validates the signature on upload
    // and rejects anything else, and one keeper rejecting what the other
    // accepts is the difference this whole seam exists to remove.
    const source = await read(page)
    expect(source).toMatch(/exportScene\('png'\)/)
  })
})
