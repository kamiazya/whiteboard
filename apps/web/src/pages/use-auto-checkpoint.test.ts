import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { CHECKPOINT_QUIET_MS } from '@kamiazya/whiteboard-history'
import { renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from '../lib/browser-workspace-id.js'
import type { WorkspaceBroadcast } from '../lib/workspace-broadcast.js'
import { useAutoCheckpoint } from './use-auto-checkpoint.js'

const WORKSPACE = 'ws-checkpoint'

interface Harness {
  readonly save: ReturnType<
    typeof vi.fn<(workspaceId: string, path: string) => Promise<VersionEntry>>
  >
  readonly hear: (message: WorkspaceBroadcast) => void
  readonly result: { current: ReturnType<typeof useAutoCheckpoint> }
}

/**
 * The hook over a store that records where each checkpoint lands. The channel
 * is a seam: BroadcastChannel is a browser API, so what another tab or the
 * files panel announces is delivered by hand here and by the real channel in
 * the browser tests.
 */
function mount(documentPath: string): Harness & { readonly unmount: () => void } {
  const save = vi.fn<(workspaceId: string, path: string) => Promise<VersionEntry>>(
    async (_workspaceId, path) => ({ id: `v-${path}`, path }) as unknown as VersionEntry,
  )
  let hear: (message: WorkspaceBroadcast) => void = () => {}
  const doc = new LoroDoc()
  doc.getMap('m').set('k', 'v')
  doc.commit()
  const { result, unmount } = renderHook(() =>
    useAutoCheckpoint(
      { readRecord: (read) => read(doc, 'doc-1'), applyRestore: async () => {} },
      { save, isUnchangedSinceLastVersion: async () => false },
      documentPath,
      (_workspaceId, onMessage) => {
        hear = onMessage
        return { post() {}, close() {} }
      },
    ),
  )
  return { save, result, unmount, hear: (message) => hear(message) }
}

describe('useAutoCheckpoint when the document changes path inside the quiet window', () => {
  beforeEach(() => {
    setBrowserWorkspaceIdForTests(WORKSPACE)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetBrowserWorkspaceIdForTests()
  })

  it('takes the pending checkpoint under the path the document moved to', async () => {
    const { save, result, hear } = mount('a')
    result.current.signal()

    hear({ type: 'document-moved', from: 'a', to: 'b' })
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['b'])
  })

  it('arms the edits that follow a move under the new path', async () => {
    const { save, result, hear } = mount('a')
    hear({ type: 'document-moved', from: 'a', to: 'b' })
    result.current.signal()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['b'])
  })

  it('follows a move of the folder that holds the document', async () => {
    const { save, result, hear } = mount('notes/a')
    result.current.signal()

    hear({ type: 'document-moved', from: 'notes', to: 'archive' })
    result.current.signal()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['archive/a'])
  })

  it('leaves a document elsewhere in the workspace alone when another one moves', async () => {
    const { save, result, hear } = mount('a')
    result.current.signal()

    hear({ type: 'document-moved', from: 'ab', to: 'c' })
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['a'])
  })

  it('attempts no checkpoint for a document that was deleted', async () => {
    const { save, result, hear } = mount('a')
    result.current.signal()

    hear({ type: 'document-removed', path: 'a' })
    result.current.signal()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save).not.toHaveBeenCalled()
  })

  it('arms the edits that follow the document coming back from the trash', async () => {
    const { save, result, hear } = mount('a')
    hear({ type: 'document-removed', path: 'a' })
    hear({ type: 'document-restored', path: 'a' })
    result.current.signal()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['a'])
  })

  it('arms the edits that follow a moved document coming back from the trash', async () => {
    const { save, result, hear } = mount('a')
    hear({ type: 'document-moved', from: 'a', to: 'b' })
    hear({ type: 'document-removed', path: 'b' })
    hear({ type: 'document-restored', path: 'b' })
    result.current.signal()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['b'])
  })

  it('stays silent when some other document is restored', async () => {
    const { save, result, hear } = mount('a')
    hear({ type: 'document-removed', path: 'a' })
    hear({ type: 'document-restored', path: 'b' })
    result.current.signal()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save).not.toHaveBeenCalled()
  })

  it('keeps the pending checkpoint when a different document is deleted', async () => {
    const { save, result, hear } = mount('a')
    result.current.signal()

    hear({ type: 'document-removed', path: 'b' })
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1_000)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['a'])
  })
})

describe('useAutoCheckpoint when the page unmounts inside the quiet window', () => {
  beforeEach(() => {
    setBrowserWorkspaceIdForTests(WORKSPACE)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetBrowserWorkspaceIdForTests()
  })

  it('takes the pending checkpoint rather than dropping it', async () => {
    const { save, result, unmount } = mount('a')
    result.current.signal()

    unmount()
    await vi.advanceTimersByTimeAsync(0)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['a'])
  })

  it('takes it once, with no timer left to take it again', async () => {
    const { save, result, unmount } = mount('a')
    result.current.signal()

    unmount()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS * 2)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('takes it under the path the document moved to', async () => {
    const { save, result, hear, unmount } = mount('a')
    result.current.signal()
    hear({ type: 'document-moved', from: 'a', to: 'b' })

    unmount()
    await vi.advanceTimersByTimeAsync(0)

    expect(save.mock.calls.map(([, path]) => path)).toEqual(['b'])
  })

  it('takes none for a document that was deleted', async () => {
    const { save, result, hear, unmount } = mount('a')
    result.current.signal()
    hear({ type: 'document-removed', path: 'a' })

    unmount()
    await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS * 2)

    expect(save).not.toHaveBeenCalled()
  })
})
