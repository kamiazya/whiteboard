import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { VersionThumbnail } from './VersionThumbnail.js'

// Deliberately include characters that need percent-encoding so the URL
// construction is proven to encode EVERY dynamic segment, not just the slug.
const WORKSPACE_ID = 'w 1#a'
const SLUG = 'main/x'
const VERSION_ID = 'v?1'
// The slug is a document path: each segment is encoded, the separators are
// structure (the canvasesApiUrl contract).
const THUMBNAIL_PATH = `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/canvases/${SLUG.split('/').map(encodeURIComponent).join('/')}/versions/${encodeURIComponent(VERSION_ID)}/thumbnail`

function renderInDaemonMode(fetchFn: typeof fetch, props: Partial<{ versionId: string }> = {}) {
  return render(
    <DaemonApiContext.Provider value={fetchFn}>
      <VersionThumbnail
        workspaceId={WORKSPACE_ID}
        slug={SLUG}
        versionId={props.versionId ?? VERSION_ID}
        hasThumbnail={true}
      />
    </DaemonApiContext.Provider>,
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

  it('daemon mode: fetches the thumbnail through the injected daemon fetch and sets an objectURL src', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(blob, { status: 200 }))

    await act(async () => {
      renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })

    expect(fetchMock).toHaveBeenCalledWith(THUMBNAIL_PATH)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const img = (await screen.findByRole('img')) as HTMLImageElement
    expect(img.src).toBe('blob:mock-1')
  })

  it('revokes the old objectURL and creates a new one when versionId changes', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(blob, { status: 200 }))

    const { rerender } = await act(async () => {
      return renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })
    await screen.findByRole('img')
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    await act(async () => {
      rerender(
        <DaemonApiContext.Provider value={fetchMock as unknown as typeof fetch}>
          <VersionThumbnail
            workspaceId={WORKSPACE_ID}
            slug={SLUG}
            versionId="v-2"
            hasThumbnail={true}
          />
        </DaemonApiContext.Provider>,
      )
    })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('revokes the objectURL on unmount', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(blob, { status: 200 }))

    const { unmount } = await act(async () => {
      return renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })
    await screen.findByRole('img')

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('anti-churn: identical-prop re-renders (simulating a 15s poll) trigger exactly one fetch and one createObjectURL', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(blob, { status: 200 }))

    const { rerender } = await act(async () => {
      return renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })
    await screen.findByRole('img')

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        rerender(
          <DaemonApiContext.Provider value={fetchMock as unknown as typeof fetch}>
            <VersionThumbnail
              workspaceId={WORKSPACE_ID}
              slug={SLUG}
              versionId={VERSION_ID}
              hasThumbnail={true}
            />
          </DaemonApiContext.Provider>,
        )
      })
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('404 response falls back to the placeholder without creating an objectURL', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))

    await act(async () => {
      renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })

    expect(screen.queryByRole('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
  })

  // 204 is a success status, so `res.ok` is true and the empty body would
  // become a zero-byte object URL that renders as a broken image rather than
  // reaching the placeholder.
  it('204 response falls back to the placeholder without creating an objectURL', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))

    await act(async () => {
      renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })
    // The placeholder is also what renders while the fetch is in flight, so
    // wait for the response and flush the blob -> setState chain before
    // asserting — otherwise every assertion below passes on the loading state
    // and the test would stay green with the zero-byte guard removed.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByRole('img')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
  })

  it('a rejected fetch falls back to the placeholder without an unhandled rejection', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })

    await act(async () => {
      renderInDaemonMode(fetchMock as unknown as typeof fetch)
    })

    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('same-origin mode (no DaemonApiContext provider): renders a plain <img src> without fetching', async () => {
    await act(async () => {
      render(
        <VersionThumbnail
          workspaceId={WORKSPACE_ID}
          slug={SLUG}
          versionId={VERSION_ID}
          hasThumbnail={true}
        />,
      )
    })

    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(THUMBNAIL_PATH)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('hasThumbnail=false renders the placeholder without fetching, in either mode', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))

    await act(async () => {
      render(
        <DaemonApiContext.Provider value={fetchMock as unknown as typeof fetch}>
          <VersionThumbnail
            workspaceId={WORKSPACE_ID}
            slug={SLUG}
            versionId={VERSION_ID}
            hasThumbnail={false}
          />
        </DaemonApiContext.Provider>,
      )
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId('version-thumbnail-placeholder')).toBeTruthy()
  })
})
