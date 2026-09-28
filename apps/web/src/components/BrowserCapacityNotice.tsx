import { Link } from 'react-router-dom'
import { settingsPath } from '../lib/app-routes.js'
import { capacityState, type KeeperCapacity } from '../lib/browser-keeper-capacity.js'

/**
 * ADR-0044 decision 3's promotion band, made a state the person can see: from
 * the band's start the page offers the move, so the limit arrives with
 * warning rather than as a refused create. Silent while there is room.
 */
export function BrowserCapacityNotice({
  documentCount,
  capacity,
}: {
  documentCount: number
  capacity: KeeperCapacity
}) {
  const state = capacityState(documentCount, capacity)
  if (state === 'room') return null
  return (
    <div
      role="status"
      className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      {state === 'full'
        ? `This workspace holds ${documentCount} documents, as many as this browser can keep, so you cannot add more here. `
        : `This workspace holds ${documentCount} documents; this browser can keep up to ${capacity.limit}. `}
      <Link to={settingsPath('connections')} className="font-medium underline">
        Move this workspace to the daemon or another keeper
      </Link>
      {state === 'full' ? ' to keep adding.' : ' before then.'}
    </div>
  )
}
