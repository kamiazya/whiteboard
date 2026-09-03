import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionsBackendContext } from '../contexts/VersionsBackendContext.js'
import type { VersionsBackend } from '../lib/versions-backend.js'
import { VersionThumbnail } from './VersionThumbnail.js'

const WORKSPACE_ID = 'w-1'
const path = 'main/x'
const VERSION_ID = 'v-1'

/**
 * A keeper that answers only the one method this component uses. The rest
 * throw rather than returning a benign value: a component reaching for
 * `list` or `restore` from a thumbnail would be a defect, and a stub that
 * answered quietly would hide it.
 */
function keeperAnswering(loadThumbnail: VersionsBackend['loadThumbnail']): {
  backend: VersionsBackend
  calls: () => number
} {
  let calls = 0
  const refuse = () => {
    throw new Error('VersionThumbnail must ask the keeper for nothing but a picture')
  }
  return {
    backend: {
      list: refuse,
      loadPast: refuse,
      save: refuse,
      restore: refuse,
      putThumbnail: refuse,
      loadThumbnail: (workspaceId: string, path: string, versionId: string) => {
        calls += 1
        return loadThumbnail(workspaceId, path, versionId)
      },
    } as unknown as VersionsBackend,
    calls: () => calls,
  }
}

function renderWith(backend: VersionsBackend, versionId = VERSION_ID) {
  return render(
    <VersionsBackendContext.Provider value={backend}>
      <VersionThumbnail
        workspaceId={WORKSPACE_ID}
        path={path}
        versionId={versionId}
        hasThumbnail={true}
      />
    </VersionsBackendContext.Provider>,
  )
}

describe('VersionThumbnail', () => {
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>
  let urlCounter: number

  beforeEach(() => {
    urlCounter = 0
    createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
    revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('draws whatever bytes the keeper answers with, whoever the keeper is', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const { backend, calls } = keeperAnswering(async (workspaceId, p, versionId) => {
      // The seam is path-addressed, and a picture belongs to one point of one
      // document — a component that dropped any of the three would ask a
      // question with more than one answer.
      expect([workspaceId, p, versionId]).toEqual([WORKSPACE_ID, path, VERSION_ID])
      return blob
    })

    await act(async () => {
      renderWith(backend)
    })

    expect(calls()).toBe(1)
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:mock-1')
  })

  it('shows the placeholder when the keeper has no picture for this point', async () => {
    const { backend } = keeperAnswering(async () => null)

    await act(async () => {
      renderWith(backend)
    })

    expect(screen.queryByRole('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
  })

  it('keeps the row when the keeper refuses, rather than failing the render', async () => {
    const { backend } = keeperAnswering(async () => {
      throw new Error('keeper unreachable')
    })

    await act(async () => {
      renderWith(backend)
    })

    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes the old object URL and takes a new one when the point changes', async () => {
    const { backend } = keeperAnswering(async () => new Blob(['png'], { type: 'image/png' }))

    const { rerender } = await act(async () => renderWith(backend))
    await screen.findByRole('img')
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    await act(async () => {
      rerender(
        <VersionsBackendContext.Provider value={backend}>
          <VersionThumbnail
            workspaceId={WORKSPACE_ID}
            path={path}
            versionId="v-2"
            hasThumbnail={true}
          />
        </VersionsBackendContext.Provider>,
      )
    })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('revokes the object URL on unmount', async () => {
    const { backend } = keeperAnswering(async () => new Blob(['png'], { type: 'image/png' }))

    const { unmount } = await act(async () => renderWith(backend))
    await screen.findByRole('img')

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('re-renders with identical props (a poll) ask the keeper once', async () => {
    const { backend, calls } = keeperAnswering(async () => new Blob(['png'], { type: 'image/png' }))

    const { rerender } = await act(async () => renderWith(backend))
    await screen.findByRole('img')

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        rerender(
          <VersionsBackendContext.Provider value={backend}>
            <VersionThumbnail
              workspaceId={WORKSPACE_ID}
              path={path}
              versionId={VERSION_ID}
              hasThumbnail={true}
            />
          </VersionsBackendContext.Provider>,
        )
      })
    }

    expect(calls()).toBe(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('asks nothing at all for a row that says it has no picture', async () => {
    const { backend, calls } = keeperAnswering(async () => new Blob(['png']))

    await act(async () => {
      render(
        <VersionsBackendContext.Provider value={backend}>
          <VersionThumbnail
            workspaceId={WORKSPACE_ID}
            path={path}
            versionId={VERSION_ID}
            hasThumbnail={false}
          />
        </VersionsBackendContext.Provider>,
      )
    })

    expect(calls()).toBe(0)
    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
  })
})
