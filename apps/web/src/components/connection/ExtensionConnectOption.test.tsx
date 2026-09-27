/**
 * ADR-0050: with the whiteboard extension installed, connecting to the local
 * daemon is one action — no pairing page, no port to find.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from '../../lib/bridge-address.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { ExtensionConnectOption } from './ExtensionConnectOption.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ExtensionConnectOption', () => {
  it('offers nothing where the extension is not installed', async () => {
    const present = vi.fn(async () => false)
    const { container } = render(
      <ExtensionConnectOption settingsStore={createUserSettingsStore()} present={present} />,
    )
    await vi.waitFor(() => expect(present).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  // A probe outliving its page holds a listener and a timer on a window that
  // may already be gone; unmounting has to call it off.
  // ADR-0050: until loopback closes, the loopback probe runs beside the
  // extension — but only where the extension does not answer. Offered both,
  // a person cannot tell which daemon each button reaches.
  it('shows what it is handed for a browser without the extension, and only there', async () => {
    const absent = <p>loopback probe</p>
    const { unmount } = render(
      <ExtensionConnectOption
        settingsStore={createUserSettingsStore()}
        present={async () => false}
        absent={absent}
      />,
    )
    expect(await screen.findByText('loopback probe')).toBeTruthy()
    unmount()

    // Not held back while the extension is still being asked.
    const asking = render(
      <ExtensionConnectOption
        settingsStore={createUserSettingsStore()}
        present={() => new Promise<boolean>(() => {})}
        absent={absent}
      />,
    )
    expect(screen.getByText('loopback probe')).toBeTruthy()
    asking.unmount()

    render(
      <ExtensionConnectOption
        settingsStore={createUserSettingsStore()}
        present={async () => true}
        absent={absent}
      />,
    )
    expect(
      await screen.findByRole('button', { name: /connect through the extension/i }),
    ).toBeTruthy()
    expect(screen.queryByText('loopback probe')).toBeNull()
  })

  it('calls off the presence probe when it unmounts', async () => {
    let asked: AbortSignal | undefined
    const present = vi.fn((signal: AbortSignal) => {
      asked = signal
      return new Promise<boolean>(() => {})
    })
    const { unmount } = render(
      <ExtensionConnectOption settingsStore={createUserSettingsStore()} present={present} />,
    )
    await vi.waitFor(() => expect(present).toHaveBeenCalled())
    expect(asked?.aborted).toBe(false)
    unmount()
    expect(asked?.aborted).toBe(true)
  })

  // Remembered, then reopened: the cold load reconnects through the same
  // path every later visit takes, and switching keeper is a reopen the
  // person asked for rather than a swap under them.
  it('connects through the extension, remembers it, and reopens', async () => {
    const settingsStore = createUserSettingsStore()
    const reopen = vi.fn()
    render(
      <ExtensionConnectOption
        settingsStore={settingsStore}
        present={async () => true}
        connect={async () => ({
          status: 'paired',
          daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
          token: '',
        })}
        reopen={reopen}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /connect through the extension/i }))

    await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce())
    expect(settingsStore.load().storage.daemonBaseUrl).toBe(BRIDGE_DAEMON_BASE_URL)
  })

  it('says how to start the daemon when none answers', async () => {
    const settingsStore = createUserSettingsStore()
    const reopen = vi.fn()
    render(
      <ExtensionConnectOption
        settingsStore={settingsStore}
        present={async () => true}
        connect={async () => ({ status: 'none' })}
        reopen={reopen}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /connect through the extension/i }))

    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('whiteboard daemon run'),
    )
    expect(reopen).not.toHaveBeenCalled()
    expect(settingsStore.load().storage.daemonBaseUrl).toBeUndefined()
  })
})
