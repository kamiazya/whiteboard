import { useEffect, useState } from 'react'
import { extensionPresent } from '../../lib/extension-bridge-fetch.js'
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
}: {
  settingsStore: UserSettingsStore
  present?: () => Promise<boolean>
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
    <div className="flex flex-col gap-1">
      <Button size="sm" disabled={state === 'connecting'} onClick={() => void onConnect()}>
        Connect through the extension
      </Button>
      {/* Mounted before it speaks, so the message is announced when it arrives. */}
      <span role="status" className="text-xs text-muted-foreground">
        {state === 'no-daemon' && (
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
function useExtensionPresence(present: () => Promise<boolean>) {
  const [state, setState] = useState<OptionState>('checking')
  useEffect(() => {
    let current = true
    void present().then((installed) => {
      if (current) setState(installed ? 'ready' : 'absent')
    })
    return () => {
      current = false
    }
  }, [present])
  return [state, setState] as const
}
