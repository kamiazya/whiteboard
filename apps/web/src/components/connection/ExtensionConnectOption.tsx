import { useEffect, useState } from 'react'
import { extensionPresent } from '../../lib/bridge-loader.js'
import {
  connectThroughExtension,
  type ExtensionConnection,
} from '../../lib/extension-connection.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { Button } from '../ui/button.js'

type OptionState = 'checking' | 'absent' | 'ready' | 'connecting' | 'no-daemon'

interface ExtensionConnectOptionProps {
  settingsStore: UserSettingsStore
  /**
   * A line saying what connecting is, for a page that does not already say
   * so. It shows only with the button: without the extension there is
   * nothing to lead into.
   */
  lead?: string
  present?: (signal: AbortSignal) => Promise<boolean>
  connect?: () => Promise<ExtensionConnection>
  reopen?: () => void
}

/**
 * ADR-0050: the local daemon is reached through the whiteboard extension and
 * nothing else — with it installed, one action away; without it, the page says
 * how to get it.
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
}: ExtensionConnectOptionProps) {
  const [state, setState] = useExtensionPresence(present)

  // Silent while asking: a present extension answers at once, and saying
  // "install it" first would flash at every person who has.
  if (state === 'checking') return null
  if (state === 'absent') return <GetTheExtension />

  const onConnect = async () => {
    setState('connecting')
    const result = await connect()
    if (result.status !== 'connected') {
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

// Docs are not served from apps/web, so this links to the source of truth.
const HOW_TO_CONNECT_URL =
  'https://github.com/kamiazya/whiteboard/blob/main/docs/how-to/connect-to-local-daemon.md'

function GetTheExtension() {
  return (
    <p className="text-xs text-muted-foreground">
      To connect the daemon on this computer, install the whiteboard extension.{' '}
      <a
        href={HOW_TO_CONNECT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        How to connect a daemon
      </a>
    </p>
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
