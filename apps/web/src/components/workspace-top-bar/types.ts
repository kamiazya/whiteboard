export interface DocumentInfo {
  path: string
  updatedAt: string
  // Local-mode display name, supplied by the caller instead of the daemon's
  // /names endpoint (browser-local has no daemon to ask).
  name?: string
}
