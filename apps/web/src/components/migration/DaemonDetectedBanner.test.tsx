import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonProbeResult, ProbeDaemonOptions } from '../../lib/daemon-probe.js'
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
    // A manual check sweeps the default port range in parallel (dynamic
    // server-side ports); every probe in the sweep is a forced recheck.
    await waitFor(() => expect(probeFn.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(probeFn.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3099')
    for (const call of probeFn.mock.calls) {
      expect(call[1]).toMatchObject({ forceRecheck: true, pageOriginScheme: 'https' })
    }
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

    // The silent auto-probe stays narrow: exactly the one stored/default
    // baseUrl, no port sweep.
    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    await waitFor(() => expect(probeFn.mock.calls.length).toBeGreaterThanOrEqual(2))
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

  it('a manual check finds a daemon on a non-default port (server-side ports are dynamic)', async () => {
    // ensure-daemon binds findAvailablePort(3099): when 3099 is taken by
    // something else, the daemon lives on 3100+ — the check must scan, not
    // assume.
    const probeFn = vi.fn(async (baseUrl: string) =>
      baseUrl === 'http://127.0.0.1:3101'
        ? ({ detected: true, instanceId: 'moved' } as const)
        : ({ detected: false, reason: 'refused' } as const),
    )
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(/A local whiteboard daemon is running at http:\/\/127\.0\.0\.1:3101/)
    const openLink = screen.getByRole('link', { name: /open the local app/i })
    expect(openLink.getAttribute('href')).toBe('http://127.0.0.1:3101')
  })

  it('remembers a found daemon and re-probes it first on the next mount', async () => {
    const store = makeStore()
    const probeFn = vi.fn(async (baseUrl: string) =>
      baseUrl === 'http://127.0.0.1:3104'
        ? ({ detected: true, instanceId: 'wt' } as const)
        : ({ detected: false, reason: 'refused' } as const),
    )
    const first = render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    await screen.findByText(/running at http:\/\/127\.0\.0\.1:3104/)
    expect(store.load().storage.knownDaemonBaseUrls).toEqual(['http://127.0.0.1:3104'])
    first.unmount()

    // Next visit on a loopback origin: the auto-probe includes the
    // remembered baseUrl, so the moved daemon is found without a click.
    probeFn.mockClear()
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )
    await screen.findByText(/running at http:\/\/127\.0\.0\.1:3104/)
    expect(probeFn.mock.calls.map((c) => c[0])).toContain('http://127.0.0.1:3104')
  })

  it('shows a picker listing every daemon when several respond', async () => {
    const probeFn = vi.fn(async (baseUrl: string) => {
      if (baseUrl === 'http://127.0.0.1:3099')
        return { detected: true, instanceId: 'main' } as const
      if (baseUrl === 'http://127.0.0.1:3102')
        return { detected: true, instanceId: 'worktree' } as const
      return { detected: false, reason: 'refused' } as const
    })
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(/2 local daemons are running/i)
    const links = screen.getAllByRole('link', { name: /open/i })
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      'http://127.0.0.1:3099',
      'http://127.0.0.1:3102',
    ])
  })

  it('a failed manual check on a hosted origin explains the allowlist requirement instead of silence', async () => {
    // The real shape of the 2026-08-07 report: daemon running, hosted origin
    // not in WHITEBOARD_ALLOWED_WEB_ORIGINS -> CORS rejection surfaces as an
    // opaque 'network' failure, indistinguishable from daemon-absent. The
    // banner must say SOMETHING actionable either way.
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

    await screen.findByText(/no daemon reachable from this origin/i)
    const docsLink = screen.getByRole('link', { name: /how to connect/i })
    expect(docsLink.getAttribute('href')).toBe(HOW_TO_CONNECT_URL)
    // Retry stays available.
    expect(screen.getByRole('button', { name: /check for local daemon/i })).not.toBeNull()
  })

  it('a failed manual check on a loopback origin reports plainly that nothing was found', async () => {
    const probeFn = vi.fn().mockResolvedValue({ detected: false, reason: 'refused' })
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(/no local daemon found/i)
    // No hosted-origin allowlist lecture on loopback — it does not apply.
    expect(screen.queryByText(/no daemon reachable from this origin/i)).toBeNull()
  })

  it('the failure message clears once a re-check succeeds', async () => {
    // Sweep-aware fake: a mutable flag instead of call-count sequencing,
    // because one manual check now issues several probes.
    let daemonUp = false
    const probeFn = vi.fn(async () => (daemonUp ? DETECTED : NOT_DETECTED))
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    await screen.findByText(/no local daemon found/i)

    daemonUp = true
    fireEvent.click(screen.getByRole('button', { name: /check for local daemon/i }))
    await screen.findByText(/A local whiteboard daemon is running at/)
    expect(screen.queryByText(/no local daemon found/i)).toBeNull()
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

    await waitFor(() => expect(probeFn.mock.calls.length).toBeGreaterThanOrEqual(1))
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
