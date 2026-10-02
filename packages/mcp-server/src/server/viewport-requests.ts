/**
 * The latest viewport request per document, kept so a page that opens after
 * the request was issued still inherits the same fit/scroll/zoom intent.
 * The MCP viewport tool fires its `viewport_request` once, to whoever is
 * open at that moment; without this a page opening the same document a
 * second later would land at the default zoom and quietly mask that the
 * request worked at all. Replayed on `client_ready`, not earlier, so it does
 * not race the editor's mount.
 *
 * A leaf with no imports, because both sides of the sync transport read it:
 * `sync-audience.ts` writes it when a request goes out and `routes/sync-sse.ts`
 * replays it when a stream declares readiness, and sync-audience already
 * imports sync-streams for the fan-out. It used to reach sync-sse through a
 * mutable function slot patched at module load to dodge that cycle — a
 * composition that imported the transport without the audience module
 * silently replayed nothing.
 */
const lastViewportRequestByDocument = new Map<string, string>()

/** Records the raw `viewport_request` frame last sent for a document key. */
export function cacheViewportRequest(docKey: string, raw: string): void {
  lastViewportRequestByDocument.set(docKey, raw)
}

/** The raw frame to replay for a document key, if a request was ever sent. */
export function cachedViewportRequest(docKey: string): string | undefined {
  return lastViewportRequestByDocument.get(docKey)
}
