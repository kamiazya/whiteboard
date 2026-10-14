import { documentFileApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'

/**
 * A stored picture's bytes off the daemon's file route — the one reader of
 * that GET, so every picture surface draws the same line between "absent"
 * and "failed".
 *
 * The route keeps one directory per workspace and reads it through ANY
 * document's path, so a caller may pass whichever path it holds: the open
 * board's own, or the row's, reaches a picture an embedded board holds too.
 *
 * Only a 404 answers `undefined`, "no such picture", which a caching seam
 * keeps as terminal. A busy database, a server error or a dropped request
 * REJECTS, so the caller can ask again; a best-effort caller folds that
 * itself.
 */
export async function readDaemonImage(
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  fileId: string,
): Promise<Blob | undefined> {
  const res = await daemonFetch(`${daemonBaseUrl}${documentFileApiUrl(workspaceId, path, fileId)}`)
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`image read answered ${res.status}`)
  return await res.blob()
}
