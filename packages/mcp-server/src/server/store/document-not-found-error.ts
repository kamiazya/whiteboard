/**
 * Thrown by metadata writers and resolvers handed a path no document lives
 * at. Routes map it to 404 — an error taxonomy, not a mechanic, which is why
 * it lives beside `corrupt-stored-data` outside the ADR-0018 scan: an
 * adapter reading it to choose a status code is doing translation, exactly
 * an adapter's job.
 */
export class DocumentNotFoundError extends Error {
  constructor(workspaceId: string, path: string) {
    super(`No document at "${workspaceId}/${path}".`)
    this.name = 'DocumentNotFoundError'
  }
}
