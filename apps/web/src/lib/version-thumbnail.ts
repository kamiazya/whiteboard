import type { VersionsBackend } from './versions-backend.js'

/**
 * What happened to a bookmark's picture.
 *
 * Named rather than void, because all three of these look identical at the
 * call site — the bookmark is already saved by the time this runs, so nothing
 * here may throw, and "no image" and "the keeper refused it" are otherwise
 * indistinguishable from success.
 */
export type ThumbnailOutcome = 'uploaded' | 'no-image' | 'failed'

/**
 * Put the picture a bookmark carries onto that version, through whichever
 * keeper holds the history.
 *
 * Through the seam rather than the daemon's route, because the picture was
 * the last part of a saved point that only one keeper could have: this used
 * to PUT to a URL, so a browser-kept bookmark had nowhere to send one and
 * silently carried none.
 *
 * Separate from the page for a second reason: the page's exporter needs a
 * real renderer, so under jsdom it answers null and a page-level test of
 * this would have had to fake the very call it was checking. Here the image
 * source is a parameter, and what is asserted is the part that is actually
 * this code's — what it hands the keeper, and that it never throws over a
 * bookmark that already landed.
 */
export async function attachVersionThumbnail({
  backend,
  workspaceId,
  path,
  versionId,
  getBlob,
}: {
  backend: Pick<VersionsBackend, 'putThumbnail'>
  workspaceId: string
  path: string
  versionId: string
  getBlob: () => Promise<Blob | null>
}): Promise<ThumbnailOutcome> {
  try {
    const blob = await getBlob()
    if (blob === null) return 'no-image'
    await backend.putThumbnail(workspaceId, path, versionId, blob)
    return 'uploaded'
  } catch {
    return 'failed'
  }
}
