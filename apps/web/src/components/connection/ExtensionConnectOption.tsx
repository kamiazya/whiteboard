import {
  bridgeSkew,
  type ExtensionHelloReply,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { useEffect, useState } from 'react'
import { extensionHello } from '../../lib/bridge-loader.js'
import {
  connectThroughExtension,
  type ExtensionConnection,
} from '../../lib/extension-connection.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { Button } from '../ui/button.js'

type OptionState =
  | { status: 'checking' | 'absent' | 'ready' | 'connecting' | 'no-daemon' }
  /** `why` is `bridgeSkew`'s diagnosis, which names the side to update. */
  | { status: 'skewed'; why: string }

interface ExtensionConnectOptionProps {
  settingsStore: UserSettingsStore
  /**
   * A line saying what connecting is, for a page that does not already say
   * so. It shows only with the button: without the extension there is
   * nothing to lead into.
   */
  lead?: string
  /** What the extension says of itself, or `null` when it is not there. */
  hello?: (signal: AbortSignal) => Promise<ExtensionHelloReply | null>
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
  hello = extensionHello,
  connect = connectThroughExtension,
  reopen = () => window.location.assign('/'),
  lead,
}: ExtensionConnectOptionProps) {
  const [state, setState] = useExtensionPresence(hello)

  // Silent while asking: a present extension answers at once, and saying
  // "install it" first would flash at every person who has.
  if (state.status === 'checking') return null
  if (state.status === 'absent') return <GetTheExtension />
  if (state.status === 'skewed') return <ExtensionSkew why={state.why} />

  const onConnect = async () => {
    setState({ status: 'connecting' })
    const result = await connect()
    if (result.status !== 'connected') {
      setState({ status: 'no-daemon' })
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
      connecting={state.status === 'connecting'}
      noDaemon={state.status === 'no-daemon'}
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

/**
 * An extension that speaks another bridge protocol cannot carry this page's
 * requests, so the person is told which side to update rather than offered a
 * button whose every use fails.
 */
function ExtensionSkew({ why }: { why: string }) {
  return (
    <p role="alert" className="text-xs text-muted-foreground">
      {why}
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

/** Starts at 'checking', then answers whether the extension is there and fit to use. */
function useExtensionPresence(hello: (signal: AbortSignal) => Promise<ExtensionHelloReply | null>) {
  const [state, setState] = useState<OptionState>({ status: 'checking' })
  useEffect(() => {
    // Aborted on unmount, so the probe lets go of the window's listener and
    // its timer now rather than outliving the page that asked.
    const asked = new AbortController()
    void hello(asked.signal).then((reply) => {
      if (asked.signal.aborted) return
      if (reply === null) return setState({ status: 'absent' })
      const why = bridgeSkew(reply)
      setState(why === null ? { status: 'ready' } : { status: 'skewed', why })
    })
    return () => asked.abort()
  }, [hello])
  return [state, setState] as const
}
