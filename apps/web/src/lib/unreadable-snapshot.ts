import type { SessionDocument } from './session-document.js'

type Judged = Pick<
  SessionDocument,
  'hasEntry' | 'holdsRetiredCommentPlane' | 'holdsRetiredStoredShape'
>

/**
 * Why a snapshot arriving in a sync session cannot be served, or null when it
 * can. Reported as a read failure rather than thrown into the session's
 * accessors, which would take React down with a doc it cannot serve anyway.
 *
 * A scoped session's contract with its backend is that the workspace bytes
 * hold its document's tree node; bytes that do not are unreadable FOR THIS
 * DOCUMENT. A record still in a shape no reader serves is refused by name,
 * since read as usual it would open without what the shape carried.
 */
export function unreadableSnapshot(
  arriving: Judged,
): 'corrupt-snapshot' | 'retired-comment-plane' | 'retired-stored-shape' | null {
  if (!arriving.hasEntry()) return 'corrupt-snapshot'
  return unreadableContent(arriving)
}

/**
 * The content half of the judgement, for the document a session already
 * serves: a LIVE update from an older peer can bring a retired shape in after
 * load, and the readers it would reach run inside the import subscription,
 * where a throw escapes as an unhandled rejection with the stale canvas still
 * up.
 */
export function unreadableContent(
  content: Pick<Judged, 'holdsRetiredCommentPlane' | 'holdsRetiredStoredShape'>,
): 'retired-comment-plane' | 'retired-stored-shape' | null {
  if (content.holdsRetiredCommentPlane()) return 'retired-comment-plane'
  if (content.holdsRetiredStoredShape()) return 'retired-stored-shape'
  return null
}
