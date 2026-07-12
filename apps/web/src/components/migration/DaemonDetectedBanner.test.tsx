import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonProbeResult, ProbeDaemonOptions } from '../../lib/daemon-probe.js'
import { createUserSettingsStore, type UserSettingsStore } from '../../lib/user-settings-store.js'
import { DaemonDetectedBanner, HOW_TO_CONNECT_URL } from './DaemonDetectedBanner.js'

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

  it('renders the detected banner with copy and a link to the how-to doc', async () => {
    const probeFn = vi.fn().mockResolvedValue(DETECTED)
    render(
      <DaemonDetectedBanner
        settingsStore={makeStore()}
        fetch={vi.fn()}
        locationProtocol="http:"
        probeFn={probeFn}
      />,
    )

    await screen.findByText(
      'A local whiteboard daemon is running. Ask your AI agent for a pairing link (create_pairing_link) to unlock versions, variations, and combining changes.',
    )
    const link = screen.getByRole('link', { name: /connect/i })
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
      screen.queryByText(
        'A local whiteboard daemon is running. Ask your AI agent for a pairing link (create_pairing_link) to unlock versions, variations, and combining changes.',
      ),
    ).toBeNull()

    const saved = store.load()
    expect(saved.storage.dismissedDaemonCtaInstanceId).toBe('inst-1')
    expect(saved.storage.dismissedDaemonCtaAt).toEqual(expect.any(String))
  })

  it('shows the honest unsupported notice instead of the CTA when the probe proves the browser blocked it', async () => {
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

    await screen.findByText(
      'Your browser cannot connect to a local daemon; canvases stay in this browser.',
    )
    expect(screen.queryByRole('button', { name: /check for local daemon/i })).toBeNull()
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
    expect(
      screen.queryByText(
        'Your browser cannot connect to a local daemon; canvases stay in this browser.',
      ),
    ).toBeNull()
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
