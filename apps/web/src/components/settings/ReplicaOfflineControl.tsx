/**
 * The per-copy "readable offline" switch in Settings > Connections (ADR-0050
 * decision 11). Opt-in, and only from here: the app never asks for a passkey
 * on its own.
 *
 * Offered only while the copy's own daemon is connected, because the key has
 * to be held to be wrapped; otherwise the row says why, rather than hiding a
 * control whose condition a person could meet.
 */
import { useState } from 'react'
import { browserCredentials } from '../../lib/replica-offline-passkey.js'
import {
  isReplicaReadableOffline,
  makeReplicaReadableOffline,
  type OfflineOptInFailure,
  stopReplicaReadableOffline,
} from '../../lib/replica-unlock.js'
import { Button } from '../ui/button.js'

const UNSUPPORTED = 'This browser cannot make a copy readable offline.'

const FAILURE_COPY = {
  unsupported: UNSUPPORTED,
  unreachable: 'The daemon did not answer, so nothing changed. Try again once it is reachable.',
  cancelled: 'No passkey was confirmed, so nothing changed.',
  'no-offline': 'The daemon that keeps this workspace does not allow copies to be read offline.',
} satisfies Record<OfflineOptInFailure, string>

const WAITING_FOR_DAEMON =
  'Available while the daemon that keeps this workspace is connected: its key is needed to lock the copy.'

const OFFER =
  'Creates a passkey in this browser that opens this copy while the daemon is away. If you lose that passkey, pull the copy again from the daemon.'

interface CopyTarget {
  daemonBaseUrl: string
  workspaceId: string
  label: string
}

function useOfflineOptIn({ daemonBaseUrl, workspaceId, label }: CopyTarget) {
  const [readable, setReadable] = useState(() =>
    isReplicaReadableOffline(daemonBaseUrl, workspaceId),
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<OfflineOptInFailure | null>(null)

  const makeReadable = async (fetch: typeof globalThis.fetch) => {
    setBusy(true)
    try {
      const outcome = await makeReplicaReadableOffline({ daemonBaseUrl, workspaceId, label, fetch })
      setFailure(outcome.ok ? null : outcome.reason)
      setReadable(outcome.ok)
    } finally {
      setBusy(false)
    }
  }
  const turnOff = () => {
    stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
    setFailure(null)
    setReadable(false)
  }
  return { readable, busy, failure, makeReadable, turnOff }
}

export function ReplicaOfflineControl({
  daemonFetch,
  ...target
}: CopyTarget & {
  /** A fetch to THIS copy's daemon while it is connected, else null. */
  daemonFetch: typeof globalThis.fetch | null
}) {
  const { readable, busy, failure, makeReadable, turnOff } = useOfflineOptIn(target)
  const testId = `local-copy-offline-${target.workspaceId}`

  if (readable) {
    return (
      <div data-testid={testId} className="flex items-center gap-2">
        <span className="text-xs">Readable offline with your passkey.</span>
        <Button type="button" variant="outline" size="sm" onClick={turnOff}>
          Turn off
        </Button>
      </div>
    )
  }
  if (browserCredentials() === undefined) {
    return (
      <p data-testid={testId} className="text-muted-foreground text-xs">
        {UNSUPPORTED}
      </p>
    )
  }
  const hint =
    failure !== null ? FAILURE_COPY[failure] : daemonFetch === null ? WAITING_FOR_DAEMON : OFFER
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={daemonFetch === null || busy}
        onClick={() => daemonFetch !== null && void makeReadable(daemonFetch)}
      >
        {busy ? 'Waiting for your passkey…' : 'Make readable offline'}
      </Button>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </div>
  )
}
