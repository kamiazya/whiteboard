/**
 * The one message a route change speaks, held outside React so a page deep in
 * the tree can set it and the single polite region in the shell can read it.
 */
let message = ''
const listeners = new Set<() => void>()

export function announceRoute(next: string): void {
  if (next === message) return
  message = next
  for (const listener of listeners) listener()
}

export function subscribeRouteAnnouncement(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function routeAnnouncementSnapshot(): string {
  return message
}
