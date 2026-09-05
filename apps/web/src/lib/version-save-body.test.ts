import { describe, expect, it, vi } from 'vitest'
import { buildVersionSaveBody } from './version-save-body.js'

function harness(overrides?: { putThumbnail?: () => Promise<void> }) {
  const calls: string[] = []
  const blob = new Blob(['png'])
  // Deferred created up front, NOT inside putThumbnail: release() must work
  // whether or not the keeper call has started yet.
  let releaseThumbnail = () => {}
  const gate = new Promise<void>((r) => {
    releaseThumbnail = r
  })
  const backend = {
    putThumbnail: vi.fn(async (...args: unknown[]) => {
      calls.push('putThumbnail')
      await gate
      if (overrides?.putThumbnail) await overrides.putThumbnail()
      return args as never
    }),
  }
  const deps = {
    capture: vi.fn(() => {
      calls.push('capture')
      return Promise.resolve<Blob | null>(blob)
    }),
    save: vi.fn(async (label: string) => {
      calls.push(`save:${label}`)
      return { workspaceId: 'ws1', path: 'doc/a', versionId: 'v9' }
    }),
    backend,
    announceRefresh: vi.fn(() => {
      calls.push('announceRefresh')
    }),
    announceOnce: vi.fn(() => {
      calls.push('announceOnce')
    }),
    onThumbnailFailed: vi.fn(() => {
      calls.push('onThumbnailFailed')
    }),
  }
  return { deps, calls, blob, release: () => releaseThumbnail() }
}

describe('buildVersionSaveBody', () => {
  it('starts the capture BEFORE the save, so the picture binds to the state the save marks', async () => {
    const { deps, calls } = harness()
    await buildVersionSaveBody(deps)('point')
    expect(calls.indexOf('capture')).toBeLessThan(calls.indexOf('save:point'))
  })

  it('the announce closure fires both beats synchronously and rides the thumbnail along unawaited', async () => {
    const { deps, calls } = harness()
    const announce = await buildVersionSaveBody(deps)('point')
    expect(calls).not.toContain('announceRefresh')
    announce()
    // Both beats landed although the keeper call has not even STARTED
    // (attachVersionThumbnail awaits the capture first) — the row must not
    // wait for its picture.
    expect(deps.announceRefresh).toHaveBeenCalledTimes(1)
    expect(deps.announceOnce).toHaveBeenCalledTimes(1)
    expect(deps.backend.putThumbnail).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(deps.backend.putThumbnail).toHaveBeenCalledTimes(1)
    })
  })

  it('hands the keeper the pre-save picture at the saved coordinates', async () => {
    const { deps, blob, release } = harness()
    const announce = await buildVersionSaveBody(deps)('point')
    announce()
    release()
    await vi.waitFor(() => {
      expect(deps.backend.putThumbnail).toHaveBeenCalledWith('ws1', 'doc/a', 'v9', blob)
    })
  })

  it('announces a second time once the picture lands, so the refreshed row stops claiming it has none', async () => {
    const { deps, release } = harness()
    const announce = await buildVersionSaveBody(deps)('point')
    announce()
    release()
    await vi.waitFor(() => {
      expect(deps.announceRefresh).toHaveBeenCalledTimes(2)
    })
    // The one-shot beat stays one-shot.
    expect(deps.announceOnce).toHaveBeenCalledTimes(1)
  })

  it('a failed thumbnail reports and does NOT re-announce', async () => {
    const { deps, release } = harness({
      putThumbnail: () => Promise.reject(new Error('keeper refused')),
    })
    const announce = await buildVersionSaveBody(deps)('point')
    announce()
    release()
    await vi.waitFor(() => {
      expect(deps.onThumbnailFailed).toHaveBeenCalledTimes(1)
    })
    expect(deps.announceRefresh).toHaveBeenCalledTimes(1)
  })

  it('a rejected save propagates and nothing announces', async () => {
    const { deps } = harness()
    deps.save.mockRejectedValueOnce(new Error('offline'))
    await expect(buildVersionSaveBody(deps)('point')).rejects.toThrow('offline')
    expect(deps.announceRefresh).not.toHaveBeenCalled()
    expect(deps.backend.putThumbnail).not.toHaveBeenCalled()
  })

  it('announceOnce is optional', async () => {
    const { deps } = harness()
    const { announceOnce: _omitted, ...rest } = deps
    const announce = await buildVersionSaveBody(rest)('point')
    announce()
    expect(deps.announceRefresh).toHaveBeenCalledTimes(1)
  })
})
