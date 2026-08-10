import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonProbeResult, ProbeDaemonOptions } from '../../lib/daemon-probe.js'
import { createUserSettingsStore, type UserSettingsStore } from '../../lib/user-settings-store.js'
import {
  DaemonDetectedBanner,
  HOW_TO_CONNECT_URL,
  LNA_HINT_TEXT,
  UNSUPPORTED_BROWSER_NOTICE,
} from './DaemonDetectedBanner.js'

/** A promise plus its resolver, for tests that need to control exactly
 *  when a probe sweep settles relative to fake-timer advances. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

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

  it('offers the port field even while a daemon is already connected', async () => {
    // Entering a port is the primary way in, so it cannot be gated on a failed
    // check: gating it there leaves a user connected to the wrong daemon with
    // no way to name the right one, and a user whose dismissals hid every
    // candidate with no way to name anything at all.
    const probeFn = vi.fn().mockResolvedValue({ detected: true, instanceId: 'i-1' })
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )
    // Waits for the DETECTED render, not merely for the probe call: the call
    // resolves later, so asserting on it would check the pre-detection state
    // and pass even if the field disappeared once a daemon was found.
    await screen.findByTestId('daemon-detected-banner')

    expect(screen.getByTestId('daemon-port-input')).toBeTruthy()
  })

  it('probes a port the user typed, including one outside the scanned range', async () => {
    // Discovery scans ten ports from 3099 and re-checks remembered URLs, so a
    // daemon anywhere else — a dev worktree's derived port, or a packaged
    // daemon whose first ten candidates were taken — is otherwise unreachable.
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )
    await waitFor(() => expect(probeFn).toHaveBeenCalled())
    probeFn.mockClear()

    fireEvent.change(screen.getByTestId('daemon-port-input'), { target: { value: '3419' } })
    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await waitFor(() =>
      expect(probeFn.mock.calls.some((call) => call[0] === 'http://127.0.0.1:3419')).toBe(true),
    )
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

    fireEvent.change(await screen.findByTestId('daemon-port-input'), { target: { value: '3099' } })
    fireEvent.click(screen.getByTestId('daemon-port-connect'))
    // A manual check bypasses the memo: the point of asking again is to get a
    // fresh answer, not the one cached from a moment when the daemon was down.
    await waitFor(() => expect(probeFn).toHaveBeenCalled())
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

  it('renders the detected banner with pairing as the only action (no daemon-origin link)', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await screen.findByText(/(A local whiteboard daemon is running at|A server responded at)/)
    // The daemon origin serves only /pair now — a bare-origin link would
    // just bounce off its redirect, so the banner must not offer one.
    expect(screen.queryByRole('link', { name: /open the local app|^open /i })).toBeNull()
    expect(screen.getByRole('button', { name: /use .*here|use here/i })).not.toBeNull()
    expect(screen.queryByText(/ask your ai agent/i)).toBeNull()
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

    expect(
      screen.queryByText(/(A local whiteboard daemon is running at|A server responded at)/),
    ).toBeNull()

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

    expect(
      screen.queryByText(/(A local whiteboard daemon is running at|A server responded at)/),
    ).toBeNull()
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

    await screen.findByText(/(A local whiteboard daemon is running at|A server responded at)/)
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

    // No daemon-origin escape hatch anymore (the daemon serves only /pair);
    // the honest affordance is the docs link.
    expect(screen.queryByRole('link', { name: /open the local app/i })).toBeNull()
    const learnMore = screen.getByRole('link', { name: /how to connect a local daemon/i })
    expect(learnMore.getAttribute('href')).toContain('connect-to-local-daemon')
  })

  it('a manual check finds a daemon on a non-default port (server-side ports are dynamic)', async () => {
    // ensure-daemon binds findAvailablePort(3099): when 3099 is taken the
    // daemon lives on 3100+. There is no scan to stumble on it, so naming the
    // port is how it is reached — the guarantee this case exists for.
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

    fireEvent.change(await screen.findByTestId('daemon-port-input'), {
      target: { value: '3101' },
    })
    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await screen.findByText(/A server responded at http:\/\/127\.0\.0\.1:3101/)
    expect(screen.getByRole('button', { name: /use here/i })).not.toBeNull()
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
    fireEvent.change(await screen.findByTestId('daemon-port-input'), { target: { value: '3104' } })
    fireEvent.click(screen.getByTestId('daemon-port-connect'))
    await screen.findByText(/responded at http:\/\/127\.0\.0\.1:3104/)
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
    await screen.findByText(/responded at http:\/\/127\.0\.0\.1:3104/)
    expect(probeFn.mock.calls.map((c) => c[0])).toContain('http://127.0.0.1:3104')
  })

  it('shows a picker listing every daemon when several respond', async () => {
    const beginGrantFn = vi.fn(async (_input: { daemonBaseUrl: string }) => {})
    const probeFn = vi.fn(async (baseUrl: string) => {
      if (baseUrl === 'http://127.0.0.1:3099')
        return { detected: true, instanceId: 'main' } as const
      if (baseUrl === 'http://127.0.0.1:3102')
        return { detected: true, instanceId: 'worktree' } as const
      return { detected: false, reason: 'refused' } as const
    })
    // Two daemons the user has reached before: with no port scan, that is
    // where a multi-candidate check comes from.
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        knownDaemonBaseUrls: ['http://127.0.0.1:3099', 'http://127.0.0.1:3102'],
      },
    }))
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        beginGrantFn={beginGrantFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(/2 servers responded on local ports/i)
    // Each responder offers pairing IN PLACE (the hosted-app-first model).
    // Unique accessible names per daemon: a control list must identify
    // WHICH daemon each action targets. No daemon-origin links: the daemon
    // serves only /pair now, so a bare-origin link would just redirect back.
    const useHere = screen.getAllByRole('button', { name: /use http:\/\/127\.0\.0\.1:\d+ here/i })
    expect(useHere.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Use http://127.0.0.1:3099 here',
      'Use http://127.0.0.1:3102 here',
    ])
    expect(screen.queryAllByRole('link', { name: /open http/i })).toHaveLength(0)

    fireEvent.click(useHere[1] as HTMLElement)
    await waitFor(() => expect(beginGrantFn).toHaveBeenCalledTimes(1))
    expect(beginGrantFn.mock.calls[0]?.[0]).toMatchObject({
      daemonBaseUrl: 'http://127.0.0.1:3102',
    })
  })

  it('a pinned, challenge-verified daemon earns the "identity verified" label', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, localDaemonBaseUrl: 'http://127.0.0.1:3099' },
    }))
    const challengeFn = vi.fn(async () => 'verified' as const)
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
        challengeFn={challengeFn}
      />,
    )

    await screen.findByText(/identity verified/)
    expect(challengeFn).toHaveBeenCalledWith('http://127.0.0.1:3099')
  })

  it('a pinned daemon FAILING its challenge is downgraded to the cautious copy', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, localDaemonBaseUrl: 'http://127.0.0.1:3099' },
    }))
    const challengeFn = vi.fn(async () => 'failed' as const)
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
        challengeFn={challengeFn}
      />,
    )

    // The paired-target trust copy must NOT survive a failed challenge.
    await screen.findByText(/A server responded at/)
    expect(screen.queryByText(/identity verified/)).toBeNull()
  })

  it('an unpaired swept responder is labelled UNVERIFIED, not "a whiteboard daemon is running"', async () => {
    // Any local process can bind a loopback port and answer /api/runtime/
    // ping with a self-asserted instanceId, so a swept hit is an unproven
    // claim. The app must not lend it its own trust label until the user
    // has actually granted this origin on that daemon's own consent page.
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(/responded at/i)
    expect(screen.getByText(/unverified/i)).not.toBeNull()
    expect(screen.queryByText(/a local whiteboard daemon is running/i)).toBeNull()
  })

  it('a previously paired daemon keeps the plain trusted label', async () => {
    const store = makeStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, localDaemonBaseUrl: 'http://127.0.0.1:3099' },
    }))
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={store}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))

    await screen.findByText(/a local whiteboard daemon is running/i)
    expect(screen.queryByText(/unverified/i)).toBeNull()
  })

  it('a detected daemon offers connect-in-place, which starts the pairing-grant redirect', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    const beginGrantFn = vi.fn(async (_input: { daemonBaseUrl: string }) => {})
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        beginGrantFn={beginGrantFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    fireEvent.click(await screen.findByRole('button', { name: /use here/i }))

    await waitFor(() => expect(beginGrantFn).toHaveBeenCalledTimes(1))
    expect(beginGrantFn.mock.calls[0]?.[0]).toMatchObject({
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
  })

  it('the hosted failure notice also offers starting the pairing consent blindly', async () => {
    // A daemon whose allowlist does not include this origin is CORS-invisible
    // to the probe, but a TOP-LEVEL NAVIGATION to its /pair page is not
    // subject to CORS — so the failure notice offers the consent flow.
    const probeFn = vi.fn().mockResolvedValue({ detected: false, reason: 'network' })
    const beginGrantFn = vi.fn(async () => {})
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        beginGrantFn={beginGrantFn}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /check for local daemon/i }))
    await screen.findByText(/no daemon reachable from this origin/i)
    fireEvent.click(screen.getByRole('button', { name: /connect anyway/i }))

    await waitFor(() => expect(beginGrantFn).toHaveBeenCalledTimes(1))
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
    await screen.findByText(/(A local whiteboard daemon is running at|A server responded at)/)
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

  describe('in-flight state and the Local Network Access hint', () => {
    // These cases drive the ~1s hint timer with fake timers. Real-timer
    // testing-library helpers (waitFor/findBy*) poll on a real setTimeout
    // and would hang once fake timers are installed, so every assertion in
    // this block uses the synchronous get*/query* queries instead, and
    // `act`/`vi.advanceTimersByTimeAsync` drive time forward explicitly.
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('disables the button and renders a "Checking…" status while a sweep is outstanding on https:', () => {
      const probeFn = vi.fn().mockImplementation(() => new Promise<DaemonProbeResult>(() => {}))
      render(
        <DaemonDetectedBanner
          settingsStore={makeStore()}
          fetch={vi.fn()}
          locationProtocol="https:"
          probeFn={probeFn}
        />,
      )

      const button = screen.getByRole('button', { name: /check for local daemon/i })
      act(() => {
        fireEvent.click(button)
      })

      expect(button.hasAttribute('disabled')).toBe(true)
      expect(button.getAttribute('aria-busy')).toBe('true')
      expect(screen.getByRole('status').textContent).toMatch(/checking/i)
    })

    it('shows the LNA hint on https: after the sweep has been outstanding for ~1s', async () => {
      const { promise } = deferred<DaemonProbeResult>()
      const probeFn = vi.fn().mockReturnValue(promise)
      render(
        <DaemonDetectedBanner
          settingsStore={makeStore()}
          fetch={vi.fn()}
          locationProtocol="https:"
          probeFn={probeFn}
        />,
      )

      const button = screen.getByRole('button', { name: /check for local daemon/i })
      expect(screen.queryByText(LNA_HINT_TEXT)).toBeNull()
      act(() => {
        fireEvent.click(button)
      })

      expect(screen.queryByText(LNA_HINT_TEXT)).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(screen.getByText(LNA_HINT_TEXT)).not.toBeNull()
    })

    it('never shows the LNA hint on http:, even during the auto-probe well past the delay', async () => {
      const { promise } = deferred<DaemonProbeResult>()
      const probeFn = vi.fn().mockReturnValue(promise)
      render(
        <DaemonDetectedBanner
          settingsStore={makeStore()}
          fetch={vi.fn()}
          locationProtocol="http:"
          probeFn={probeFn}
        />,
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.queryByText(LNA_HINT_TEXT)).toBeNull()
      // The in-flight state is still visible though — the sweep never
      // settles because `promise` is never resolved.
      expect(screen.getByRole('status').textContent).toMatch(/checking/i)
    })

    it('resets checking, the hint, and re-enables the button once the sweep settles', async () => {
      const { promise, resolve } = deferred<void>()
      // Every candidate in the sweep awaits the same deferred, so resolving
      // it once settles the whole sweep at a controlled moment.
      const resolvingProbeFn = vi
        .fn()
        .mockReturnValue(promise.then(() => ({ detected: false, reason: 'refused' }) as const))
      render(
        <DaemonDetectedBanner
          settingsStore={makeStore()}
          fetch={vi.fn()}
          locationProtocol="https:"
          probeFn={resolvingProbeFn}
        />,
      )

      const button = screen.getByRole('button', { name: /check for local daemon/i })
      act(() => {
        fireEvent.click(button)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(screen.getByText(LNA_HINT_TEXT)).not.toBeNull()

      await act(async () => {
        resolve()
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.queryByText(LNA_HINT_TEXT)).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
      const rechecked = screen.getByRole('button', { name: /check for local daemon/i })
      expect(rechecked.hasAttribute('disabled')).toBe(false)
    })

    it('never flashes the hint when the sweep settles before the ~1s delay', async () => {
      const { promise, resolve } = deferred<DaemonProbeResult>()
      const probeFn = vi.fn().mockReturnValue(promise)
      render(
        <DaemonDetectedBanner
          settingsStore={makeStore()}
          fetch={vi.fn()}
          locationProtocol="https:"
          probeFn={probeFn}
        />,
      )

      const button = screen.getByRole('button', { name: /check for local daemon/i })
      act(() => {
        fireEvent.click(button)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
        resolve({ detected: false, reason: 'refused' })
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(screen.queryByText(LNA_HINT_TEXT)).toBeNull()
    })

    it('clears the stale failure notice once a retry sweep starts', async () => {
      const { promise: firstProbe, resolve: resolveFirst } = deferred<DaemonProbeResult>()
      const probeFn = vi.fn().mockReturnValueOnce(firstProbe)
      render(
        <DaemonDetectedBanner
          settingsStore={makeStore()}
          fetch={vi.fn()}
          locationProtocol="https:"
          probeFn={probeFn}
        />,
      )

      const button = screen.getByRole('button', { name: /check for local daemon/i })
      act(() => {
        fireEvent.click(button)
      })
      await act(async () => {
        resolveFirst({ detected: false, reason: 'network' })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByTestId('daemon-check-failed-notice')).not.toBeNull()

      // Retry: leave the second sweep in flight so we can see whether the
      // stale failure notice from the first sweep is still rendered.
      probeFn.mockReturnValueOnce(new Promise<DaemonProbeResult>(() => {}))
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: /check for local daemon/i }))
      })

      expect(screen.getByRole('status').textContent).toMatch(/checking/i)
      expect(screen.queryByTestId('daemon-check-failed-notice')).toBeNull()
    })
  })
})

describe('DaemonDetectedBanner — local network permission', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
  })

  function renderWithPermission(
    permission: 'granted' | 'prompt' | 'denied' | 'unknown',
    probeFn = vi.fn().mockResolvedValue(NOT_DETECTED),
  ) {
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        queryPermissionFn={vi.fn().mockResolvedValue(permission)}
      />,
    )
    return probeFn
  }

  it('explains the permission before the check that would trigger the prompt', async () => {
    // The prompt fires on the request, so probing first and explaining after
    // would put the explanation behind the dialog it is meant to introduce.
    const probeFn = renderWithPermission('prompt')

    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await screen.findByTestId('lna-explainer')
    expect(probeFn).not.toHaveBeenCalled()
  })

  it('runs the held-back check once the explanation is acknowledged', async () => {
    const probeFn = renderWithPermission('prompt')
    fireEvent.click(screen.getByTestId('daemon-port-connect'))
    await screen.findByTestId('lna-explainer')

    fireEvent.click(screen.getByTestId('lna-explainer-continue'))

    await waitFor(() => expect(probeFn).toHaveBeenCalled())
  })

  it('does not probe at all once the permission is denied', async () => {
    // Probing would fail in a way indistinguishable from an absent daemon,
    // and cannot re-prompt, so it can only mislead.
    const probeFn = renderWithPermission('denied')

    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await screen.findByTestId('lna-blocked')
    expect(probeFn).not.toHaveBeenCalled()
  })

  it('checks without an explanation once the permission is granted', async () => {
    const probeFn = renderWithPermission('granted')

    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await waitFor(() => expect(probeFn).toHaveBeenCalled())
    expect(screen.queryByTestId('lna-explainer')).toBeNull()
  })

  it('still checks when reading the permission throws', async () => {
    // The read is awaited after 'checking' is claimed, so an unhandled
    // rejection would leave the button disabled for good -- and the button is
    // the only affordance that could recover from it.
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        queryPermissionFn={vi.fn().mockRejectedValue(new Error('permissions unavailable'))}
      />,
    )

    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await waitFor(() => expect(probeFn).toHaveBeenCalled())
    await screen.findByTestId('daemon-check-failed-notice')
  })

  it('stops at the gate when a later check finds the permission denied', async () => {
    // The path this replaced a mis-named test for. A denied read returns at
    // the gate, so no probe runs and no failure copy renders -- which is why
    // asserting the failure notice here could never have worked.
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    const queryPermissionFn = vi.fn().mockResolvedValueOnce('granted').mockResolvedValue('denied')
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        queryPermissionFn={queryPermissionFn}
      />,
    )
    fireEvent.click(screen.getByTestId('daemon-port-connect'))
    await waitFor(() => expect(probeFn).toHaveBeenCalled())
    const callsBefore = probeFn.mock.calls.length

    fireEvent.click(screen.getByTestId('daemon-port-connect'))

    await screen.findByTestId('lna-blocked')
    expect(probeFn.mock.calls.length).toBe(callsBefore)
  })

  it('tells the user the prompt went unanswered when it did', async () => {
    // Dismissing the prompt leaves the permission at 'prompt' after the sweep,
    // which is neither an absent daemon nor a standing denial.
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        queryPermissionFn={vi.fn().mockResolvedValue('prompt')}
      />,
    )
    fireEvent.click(screen.getByTestId('daemon-port-connect'))
    await screen.findByTestId('lna-explainer')
    fireEvent.click(screen.getByTestId('lna-explainer-continue'))

    await screen.findByTestId('daemon-check-unanswered-notice')
  })

  it('drops the unanswered copy once the prompt has been allowed', async () => {
    // The bug this pins: the permission is read BEFORE the probe, but the
    // prompt is answered DURING it, so reusing the pre-probe snapshot told a
    // user who had just clicked Allow to go and allow it.
    const probeFn = vi.fn().mockResolvedValue(NOT_DETECTED)
    const queryPermissionFn = vi.fn().mockResolvedValueOnce('prompt').mockResolvedValue('granted')
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="https:"
        probeFn={probeFn}
        queryPermissionFn={queryPermissionFn}
      />,
    )
    fireEvent.click(screen.getByTestId('daemon-port-connect'))
    await screen.findByTestId('lna-explainer')
    fireEvent.click(screen.getByTestId('lna-explainer-continue'))

    await screen.findByTestId('daemon-check-failed-notice')
    expect(screen.queryByTestId('daemon-check-unanswered-notice')).toBeNull()
  })
})
