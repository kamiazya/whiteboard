import { useEffect, useState } from 'react'
import { extensionPresent } from '../../lib/bridge-loader.js'
import { connectThroughExtension } from '../../lib/extension-connection.js'
import type { GrantConsumeResult } from '../../lib/pairing-grant.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { Button } from '../ui/button.js'

type OptionState = 'checking' | 'absent' | 'ready' | 'connecting' | 'no-daemon'

/**
 * ADR-0050: with the whiteboard extension installed, the local daemon is one
 * action away — no pairing page and no port. Offered only where the extension
 * answers, so a browser without it sees the connection it always had.
 *
 * A connection is remembered and the app reopened: the cold load reconnects
 * the same way every later visit does, and changing who keeps the workspace
 * is a reload the person asked for rather than a swap under them. It reopens
 * at the start rather than at this address, which names a workspace of the
 * browser's own that the daemon does not have.
 */
export function ExtensionConnectOption({
  settingsStore,
  present = extensionPresent,
  connect = connectThroughExtension,
  reopen = () => window.location.assign('/'),
  lead,
}: {
  settingsStore: UserSettingsStore
  /**
   * A line saying what connecting is, for a page that does not already say
   * so. It shows only with the button: without the extension there is
   * nothing to lead into.
   */
  lead?: string
  present?: (signal: AbortSignal) => Promise<boolean>
  connect?: () => Promise<GrantConsumeResult>
  reopen?: () => void
}) {
  const [state, setState] = useExtensionPresence(present)

  if (state === 'checking' || state === 'absent') return null

  const onConnect = async () => {
    setState('connecting')
    const result = await connect()
    if (result.status !== 'paired') {
      setState('no-daemon')
      return
    }
    settingsStore.update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: result.daemonBaseUrl },
    }))
    reopen()
  }

  return (
    <ConnectButton
      lead={lead}
      connecting={state === 'connecting'}
      noDaemon={state === 'no-daemon'}
      onConnect={() => void onConnect()}
    />
  )
}

function ConnectButton({
  lead,
  connecting,
  noDaemon,
  onConnect,
}: {
  lead: string | undefined
  connecting: boolean
  noDaemon: boolean
  onConnect: () => void
}) {
  return (
    <div
      className={lead === undefined ? 'flex flex-col gap-1' : 'flex flex-col items-center gap-1'}
    >
      {lead !== undefined && <p className="text-xs text-muted-foreground">{lead}</p>}
      <Button
        size="sm"
        variant={lead === undefined ? 'default' : 'outline'}
        disabled={connecting}
        onClick={onConnect}
      >
        Connect through the extension
      </Button>
      {/* Mounted before it speaks, so the message is announced when it arrives. */}
      <span role="status" className="text-xs text-muted-foreground">
        {noDaemon && (
          <>
            The whiteboard extension is installed, but no daemon answered. Start one with{' '}
            <code>whiteboard daemon run</code>, then try again.
          </>
        )}
      </span>
    </div>
  )
}

/** Starts at 'checking', then answers whether the extension is there. */
function useExtensionPresence(present: (signal: AbortSignal) => Promise<boolean>) {
  const [state, setState] = useState<OptionState>('checking')
  useEffect(() => {
    // Aborted on unmount, so the probe lets go of the window's listener and
    // its timer now rather than outliving the page that asked.
    const asked = new AbortController()
    void present(asked.signal).then((installed) => {
      if (!asked.signal.aborted) setState(installed ? 'ready' : 'absent')
    })
    return () => asked.abort()
  }, [present])
  return [state, setState] as const
}
