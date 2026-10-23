import { useSyncExternalStore } from 'react'
import { routeAnnouncementSnapshot, subscribeRouteAnnouncement } from '../../lib/route-announcer.js'

/**
 * The shell's single route announcer. Mounted once and never conditional, so
 * its text changes inside a region assistive technology already knows —
 * see polite-live-region.test.ts.
 */
export function RouteAnnouncer() {
  const message = useSyncExternalStore(subscribeRouteAnnouncement, routeAnnouncementSnapshot)
  return (
    <p role="status" aria-label="Page" className="sr-only">
      {message}
    </p>
  )
}
