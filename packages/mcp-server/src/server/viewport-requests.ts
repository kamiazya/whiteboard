/**
 * The latest viewport request per document, kept so a page that opens after
 * the request was issued still inherits the same fit/scroll/zoom intent.
 * The MCP viewport tool fires its `viewport_request` once, to whoever is
 * open at that moment; without this a page opening the same document a
 * second later would land at the default zoom and quietly mask that the
 * request worked at all. Replayed on `client_ready`, not earlier, so it does
 * not race the editor's mount.
 *
 * Recorded whether or not a page was ready to take the request when it was
 * issued: the tool answers `delivered: false` to nobody watching, and the
 * first page to open afterwards is exactly the one this exists for.
 *
 * A replay is bounded by `VIEWPORT_REPLAY_TTL_MS`. The intent is "look here
 * for whoever opens the document next", and the same replay fires on every
 * SSE reconnect, so an unbounded one would drag a viewport the person has
 * since panned back to where an agent pointed some hours ago.
 *
 * A leaf with no imports, because both sides of the sync transport read it:
 * `sync-audience.ts` writes it when a request goes out and `routes/sync-sse.ts`
 * replays it when a stream declares readiness, and sync-audience already
 * imports sync-streams for the fan-out. Being a leaf, neither needs a mutable
 * function slot patched at module load to dodge that cycle — a slot a
 * composition that imported the transport without the audience module would
 * leave silently replaying nothing.
 */
/**
 * How long a recorded request stays replayable. Long enough for a person to
 * open the document the agent just pointed them at (the agent has been told
 * `delivered: false` and is likely waiting on them), short enough that a
 * stream reconnecting after a network blip does not undo their own panning.
 */
export const VIEWPORT_REPLAY_TTL_MS = 30_000

interface RecordedRequest {
  readonly raw: string
  readonly recordedAt: number
}

const lastViewportRequestByDocument = new Map<string, RecordedRequest>()

/** Records the raw `viewport_request` frame last sent for a document key. */
export function cacheViewportRequest(docKey: string, raw: string, now = Date.now()): void {
  // Swept on write, so a document nobody ever reopens does not keep its
  // entry for the life of the process.
  for (const [key, recorded] of lastViewportRequestByDocument) {
    if (now - recorded.recordedAt > VIEWPORT_REPLAY_TTL_MS) {
      lastViewportRequestByDocument.delete(key)
    }
  }
  lastViewportRequestByDocument.set(docKey, { raw, recordedAt: now })
}

/** The raw frame to replay for a document key, if a request was sent within the replay window. */
export function cachedViewportRequest(docKey: string, now = Date.now()): string | undefined {
  const recorded = lastViewportRequestByDocument.get(docKey)
  if (recorded === undefined) return undefined
  if (now - recorded.recordedAt > VIEWPORT_REPLAY_TTL_MS) {
    lastViewportRequestByDocument.delete(docKey)
    return undefined
  }
  return recorded.raw
}
