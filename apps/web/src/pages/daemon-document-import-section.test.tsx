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

const mockLoadProjection = vi.fn()
vi.mock('../lib/workspace-content.js', () => ({
  loadWorkspaceDocumentProjection: mockLoadProjection,
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

  // The loroStore prop is deliberately NOT the raw LoroStore: the panel must
  // read a document's CURRENT bytes from the workspace document's tree node
  // first, and only fall back to the legacy per-document record for anything
  // unfolded — a raw LoroStore would ship the pre-fold copy of every document
  // edited since the workspace-document cutover.
  it('injects a workspace-first reader that falls back to the legacy store', async () => {
    mockLoadProjection.mockResolvedValue(null)
    mockLoroStoreInstance.load.mockResolvedValue({ kind: 'missing' })
    render(
      <DaemonDocumentImportSection
        workspaceId="ws1"
        daemonFetch={fakeDaemonFetch}
        browserStore={fakeBrowserStore}
      />,
    )

    expect(capturedProps!.settingsStore).toBe(mockSettingsStoreInstance)
    const loroStore = capturedProps!.loroStore as { load(id: string): Promise<unknown> }
    await loroStore.load('doc-1')
    expect(mockLoadProjection).toHaveBeenCalledWith('doc-1')
    expect(mockLoroStoreInstance.load).toHaveBeenCalledWith('doc-1')
  })

  it('serves the workspace projection without consulting the legacy record when one exists', async () => {
    mockLoadProjection.mockResolvedValue({ export: () => new Uint8Array([1, 2, 3]) })
    render(
      <DaemonDocumentImportSection
        workspaceId="ws1"
        daemonFetch={fakeDaemonFetch}
        browserStore={fakeBrowserStore}
      />,
    )

    const loroStore = capturedProps!.loroStore as {
      load(id: string): Promise<{ kind: string; snapshot?: Uint8Array }>
    }
    const result = await loroStore.load('doc-1')
    expect(result.kind).toBe('ok')
    expect(result.snapshot).toEqual(new Uint8Array([1, 2, 3]))
    expect(mockLoroStoreInstance.load).not.toHaveBeenCalled()
  })
})
