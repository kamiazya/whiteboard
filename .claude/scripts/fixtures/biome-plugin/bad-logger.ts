// Fixture: the pino printf-overload mistake. The object is read as an
// interpolation argument for a message with no placeholder, so it is
// dropped and the record ships with no fields at all.
declare const log: Record<string, (...args: unknown[]) => void>
declare const workspaceId: string
declare const err: unknown

export function wrong(): void {
  log.warning('skipped corrupt row', { workspaceId, err })
  log.error('request failed', { workspaceId })
}
