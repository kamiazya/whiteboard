import { formatRelative } from '../lib/format-relative.js'

export const refusalLine = (refusal: string) => `The daemon could not be reached: ${refusal}`

/** A daemon the record refused is not coming back by itself, so nothing promises it. */
const offlineDelivery = (refusal: string | undefined) =>
  refusal === undefined
    ? '. Edits save here and ship to the daemon when it returns.'
    : `. Edits save here and ship once the daemon can be reached. ${refusalLine(refusal)}`

export interface ReplicaOfflineBannerProps {
  name: string
  syncedAt: string | undefined
  refusal: string | undefined
}

/** Where the person is: the daemon is away and this is the copy cached here. */
export function ReplicaOfflineBanner({ name, syncedAt, refusal }: ReplicaOfflineBannerProps) {
  return (
    <div
      data-testid="replica-offline-banner"
      className="border-b bg-amber-500/10 px-4 py-2 text-sm"
    >
      <span className="font-medium">{name}</span>
      {' — the daemon that keeps this workspace is unreachable. '}
      This is the copy cached in this browser
      {syncedAt !== undefined && <> (synced {formatRelative(syncedAt, { pastDay: 'absolute' })})</>}
      {offlineDelivery(refusal)}
    </div>
  )
}
