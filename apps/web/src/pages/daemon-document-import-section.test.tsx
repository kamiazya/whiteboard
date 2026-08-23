import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

let capturedProps: Record<string, unknown> | null = null

vi.mock('../components/migration/ImportFromBrowserPanel.js', () => ({
  ImportFromBrowserPanel(props: Record<string, unknown>) {
    capturedProps = props
    return <div data-testid="import-panel" />
  },
}))

const mockLoroStoreInstance = { load: vi.fn() }
const LoroStoreSpy = vi.fn(function MockLoroStore() {
  return mockLoroStoreInstance
})
vi.mock('../lib/loro-store.js', () => ({
  LoroStore: LoroStoreSpy,
}))

const mockSettingsStoreInstance = { get: vi.fn(), set: vi.fn() }
const createSettingsSpy = vi.fn(() => mockSettingsStoreInstance)
vi.mock('../lib/user-settings-store.js', () => ({
  createUserSettingsStore: createSettingsSpy,
}))

const { DaemonDocumentImportSection } = await import('./daemon-document-import-section.js')

afterEach(() => {
  cleanup()
  capturedProps = null
  vi.clearAllMocks()
})

const fakeBrowserStore = { list: vi.fn(), load: vi.fn() } as never
const fakeDaemonFetch = vi.fn() as unknown as typeof fetch

describe('DaemonDocumentImportSection', () => {
  it('passes props through to ImportFromBrowserPanel', () => {
    render(
      <DaemonDocumentImportSection
        workspaceId="ws1"
        daemonFetch={fakeDaemonFetch}
        daemonBaseUrl="http://localhost:3099"
        browserStore={fakeBrowserStore}
      />,
    )

    expect(capturedProps).not.toBeNull()
    expect(capturedProps!.workspaceId).toBe('ws1')
    expect(capturedProps!.daemonFetch).toBe(fakeDaemonFetch)
    expect(capturedProps!.daemonBaseUrl).toBe('http://localhost:3099')
    expect(capturedProps!.browserStore).toBe(fakeBrowserStore)
  })

  it('creates LoroStore and settingsStore exactly once per mount', () => {
    const { rerender } = render(
      <DaemonDocumentImportSection
        workspaceId="ws1"
        daemonFetch={fakeDaemonFetch}
        browserStore={fakeBrowserStore}
      />,
    )

    expect(LoroStoreSpy).toHaveBeenCalledTimes(1)
    expect(createSettingsSpy).toHaveBeenCalledTimes(1)

    rerender(
      <DaemonDocumentImportSection
        workspaceId="ws2"
        daemonFetch={fakeDaemonFetch}
        browserStore={fakeBrowserStore}
      />,
    )

    expect(LoroStoreSpy).toHaveBeenCalledTimes(1)
    expect(createSettingsSpy).toHaveBeenCalledTimes(1)
  })

  it('injects the created stores into ImportFromBrowserPanel', () => {
    render(
      <DaemonDocumentImportSection
        workspaceId="ws1"
        daemonFetch={fakeDaemonFetch}
        browserStore={fakeBrowserStore}
      />,
    )

    expect(capturedProps!.loroStore).toBe(mockLoroStoreInstance)
    expect(capturedProps!.settingsStore).toBe(mockSettingsStoreInstance)
  })
})
