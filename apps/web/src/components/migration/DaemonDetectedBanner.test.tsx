import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonProbeResult, ProbeDaemonOptions } from '../../lib/daemon-probe.js'
import {
  load as loadReconnectSecret,
  save as saveReconnectSecret,
} from '../../lib/reconnect-secret-store.js'
import { createUserSettingsStore, type UserSettingsStore } from '../../lib/user-settings-store.js'
import {
  DaemonDetectedBanner,
  HOW_TO_CONNECT_URL,
  UNSUPPORTED_BROWSER_NOTICE,
} from './DaemonDetectedBanner.js'

function makeStore(): UserSettingsStore {
  localStorage.clear()
  return createUserSettingsStore()
}

const DETECTED: DaemonProbeResult = { detected: true, instanceId: 'inst-1' }
const NOT_DETECTED: DaemonProbeResult = { detected: false, reason: 'timeout' }

describe('DaemonDetectedBanner', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('auto-probes on mount when locationProtocol is http:', async () => {
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    expect(probeFn.mock.calls[0]?.[1]).toMatchObject({
      forceRecheck: undefined,
      pageOriginScheme: 'http',
    })
  })

  it('does not auto-probe on https: and renders a manual affordance instead', async () => {
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    await screen.findByRole('button', { name: /check for local daemon/i })
    expect(probeFn).not.toHaveBeenCalled()
  })

  it('clicking the manual affordance on https: probes with forceRecheck: true', async () => {
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    expect(probeFn.mock.calls[0]?.[1]).toMatchObject({
      forceRecheck: true,
      pageOriginScheme: 'https',
    })
  })

  it('renders the manual affordance on http: too when the result is not-detected', async () => {
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(2))
    expect(probeFn.mock.calls[1]?.[1]).toMatchObject({ forceRecheck: true })
  })

  it('renders the detected banner with an "Open the local app" primary CTA linking to the daemon origin', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await screen.findByText(/A local whiteboard daemon is running at/)
    const openLink = screen.getByRole('link', { name: /open the local app/i })
    expect(openLink.getAttribute('href')).toBe('http://127.0.0.1:3099')
    // The pairing-link ask is gone: since R3, navigating to the daemon
    // origin needs no pairing at all.
    expect(screen.queryByText(/ask your ai agent/i)).toBeNull()
  })

  it('deep-links "Open the local app" to the last-connected workspace/slug when known', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        lastConnectedWorkspaceId: 'w1',
        lastConnectedSlug: 'main',
      },
    }))
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    const openLink = await screen.findByRole('link', { name: /open the local app/i })
    expect(openLink.getAttribute('href')).toBe('http://127.0.0.1:3099/canvas/w1/main')
  })

  it('does not emit a double slash when the stored base URL has a trailing slash', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        localDaemonBaseUrl: 'http://127.0.0.1:3099/',
        lastConnectedWorkspaceId: 'w1',
        lastConnectedSlug: 'main',
      },
    }))
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    const openLink = await screen.findByRole('link', { name: /open the local app/i })
    expect(openLink.getAttribute('href')).toBe('http://127.0.0.1:3099/canvas/w1/main')
  })

  it('still links to the how-to doc alongside the primary CTA', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    const link = await screen.findByRole('link', { name: /learn more/i })
    expect(link.getAttribute('href')).toBe(HOW_TO_CONNECT_URL)
  })

  it('dismiss writes dismissedDaemonCtaAt + dismissedDaemonCtaInstanceId and hides the banner', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText(/A local whiteboard daemon is running at/)).toBeNull()

    const saved = store.load()
    expect(saved.storage.dismissedDaemonCtaInstanceId).toBe('inst-1')
    expect(saved.storage.dismissedDaemonCtaAt).toEqual(expect.any(String))
  })

  it('"Forget this daemon" clears the persisted reconnect target and hides the banner', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        localDaemonBaseUrl: 'http://127.0.0.1:3099',
        lastConnectedWorkspaceId: 'w1',
        lastConnectedSlug: 'main',
      },
    }))
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /forget this daemon/i }))

    expect(screen.queryByText(/A local whiteboard daemon is running at/)).toBeNull()
    const saved = store.load()
    expect(saved.storage.localDaemonBaseUrl).toBeUndefined()
    expect(saved.storage.lastConnectedWorkspaceId).toBeUndefined()
    expect(saved.storage.lastConnectedSlug).toBeUndefined()
  })

  it('"Forget this daemon" also clears the stored silent-reconnect secret', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, localDaemonBaseUrl: 'http://127.0.0.1:3099' },
    }))
    saveReconnectSecret('http://127.0.0.1:3099', 'stored-secret')

    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /forget this daemon/i }))

    expect(loadReconnectSecret('http://127.0.0.1:3099')).toBeNull()
  })

  it('does not render "Forget this daemon" when no target has ever been persisted', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await screen.findByText(/A local whiteboard daemon is running at/)
    expect(screen.queryByRole('button', { name: /forget this daemon/i })).toBeNull()
  })

  it('shows the honest unsupported notice with an escape-hatch link when the probe proves the browser blocked it', async () => {
    const probeFn = vi.fn().mockResolvedValue({ detected: false, reason: 'blocked' })
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(UNSUPPORTED_BROWSER_NOTICE)
    expect(screen.queryByRole('button', { name: /check for local daemon/i })).toBeNull()

    // The way out: a normal top-level navigation to the daemon's own origin
    // is not subject to the fetch-level block that produced this notice.
    const openLink = screen.getByRole('link', { name: /open the local app/i })
    expect(openLink.getAttribute('href')).toBe('http://127.0.0.1:3099')
  })

  it('deep-links the unsupported-notice escape hatch to the last-connected workspace when known', async () => {
    const probeFn = vi.fn().mockResolvedValue({ detected: false, reason: 'blocked' })
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        lastConnectedWorkspaceId: 'w1',
        lastConnectedSlug: 'main',
      },
    }))
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    const openLink = await screen.findByRole('link', { name: /open the local app/i })
    expect(openLink.getAttribute('href')).toBe('http://127.0.0.1:3099/canvas/w1/main')
  })

  it('keeps the CTA affordance when the probe fails inconclusively (not proven blocked)', async () => {
    const probeFn = vi.fn().mockResolvedValue({ detected: false, reason: 'network' })
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /check for local daemon/i })).not.toBeNull()
    expect(screen.queryByText(UNSUPPORTED_BROWSER_NOTICE)).toBeNull()
    expect(screen.queryByRole('link', { name: /open the local app/i })).toBeNull()
  })

  it('aborts the in-flight probe on unmount and never sets state after unmount', async () => {
    let capturedSignal: AbortSignal | undefined
    const probeFn = vi.fn().mockImplementation(
      (_baseUrl: string, options: ProbeDaemonOptions) =>
        new Promise<DaemonProbeResult>(() => {
          capturedSignal = options.signal
        }),
    )

    const { unmount } = render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    unmount()

    expect(capturedSignal?.aborted).toBe(true)
  })
})
