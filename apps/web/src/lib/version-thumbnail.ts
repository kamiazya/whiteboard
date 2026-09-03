import { documentsApiUrl } from '@kamiazya/whiteboard-mcp/api-contracts'

/**
 * What happened to a bookmark's picture.
 *
 * Named rather than void, because all three of these look identical at the
 * call site — the bookmark is already saved by the time this runs, so nothing
 * here may throw, and "no image" and "the daemon refused it" are otherwise
 * indistinguishable from success.
 */
export type ThumbnailOutcome = 'uploaded' | 'no-image' | 'failed'

/**
 * Put the picture a bookmark carries onto that version.
 *
 * Separate from the page for one reason: the page's exporter needs a real
 * renderer, so under jsdom it answers null and a page-level test of this would
 * have had to fake the very call it was checking. Here the image source is a
 * parameter, and what is asserted is the part that is actually this code's —
 * where it PUTs, what it declares, and that it never throws over a bookmark
 * that already landed.
 */
export async function uploadVersionThumbnail({
  daemonBaseUrl,
  workspaceId,
  path,
  versionId,
  getBlob,
  fetchImpl,
}: {
  daemonBaseUrl: string
  workspaceId: string
  path: string
  versionId: string
  getBlob: () => Promise<Blob | null>
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
}): Promise<ThumbnailOutcome> {
  try {
    const blob = await getBlob()
    if (blob === null) return 'no-image'
    const res = await fetchImpl(
      `${daemonBaseUrl}${documentsApiUrl(workspaceId, path, `versions/${versionId}/thumbnail`)}`,
      {
        method: 'PUT',
        // PNG explicitly: the daemon's thumbnail endpoint validates the
        // signature on upload and rejects anything else.
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      },
    )
    return res.ok ? 'uploaded' : 'failed'
  } catch {
    return 'failed'
  }
}
