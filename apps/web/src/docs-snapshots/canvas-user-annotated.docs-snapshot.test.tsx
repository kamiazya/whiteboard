import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import architectureRaw from '@docs-assets/architecture.excalidraw?raw'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import '../index.css'
import { jsonResponse, makeFetchMock, pinRandomFields, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-user-annotated.png — same architecture
// scene as canvas-agent-drew, but with a few red review annotations the
// user added (an arrow + a text label). Demonstrates the
// "human-in-the-loop" review pass over an agent's drawing.

interface Scene {
  elements: unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

const baseScene: Scene = JSON.parse(architectureRaw)

const annotationSkeleton = [
  // A red callout arrow pointing at the right-edge plugin box, plus a
  // text label nearby — the kind of mark a reviewer leaves when they
  // want a follow-up on a specific component.
  {
    type: 'arrow' as const,
    x: 250,
    y: 80,
    width: 240,
    height: 80,
    strokeColor: '#e03131',
    strokeWidth: 2,
    label: { text: 'tighten boundary?', strokeColor: '#e03131' },
  },
  {
    type: 'rectangle' as const,
    x: 90,
    y: 60,
    width: 160,
    height: 60,
    backgroundColor: '#ffe3e3',
    strokeColor: '#e03131',
    strokeStyle: 'dashed' as const,
    label: { text: 'review me', strokeColor: '#e03131' },
  },
]
const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  const fetchMock = vi.fn(
    makeFetchMock((url) => {
      if (url.endsWith('/names')) {
        return jsonResponse({
          workspace: 'Main workspace',
          canvases: { 'design/architecture': 'System architecture' },
          pinned: [],
        })
      }
      if (url.endsWith('/dirty')) return jsonResponse({ dirty: true })
      if (url.endsWith('/branches'))
        return jsonResponse({ head: 'main', branches: [{ name: 'main' }] })
      return jsonResponse({})
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('docs snapshot — user added review notes', () => {
  it('writes docs/assets/canvas-user-annotated.png', async () => {
    // Materialise annotations after _setup.ts has seeded Math.random; the
    // top-of-file path would otherwise burn an id sequence before the
    // seed is active, leaking randomness into the PNG bytes.
    const annotations = pinRandomFields(
      convertToExcalidrawElements(annotationSkeleton as never) as Array<Record<string, unknown>>,
    )
    const elements = [...(baseScene.elements as object[]), ...(annotations as object[])]

    const { container } = render(
      <div
        data-testid="canvas-user-annotated-frame"
        style={{ width: '1100px', height: '640px', background: '#ffffff' }}
      >
        <WorkspaceTopBar
          workspaceId="ws_main"
          slug="design/architecture"
          canvases={[{ slug: 'design/architecture', updatedAt: '2026-05-01T12:00:00.000Z' }]}
          onNavigateToCanvas={() => undefined}
          onEnterFullscreen={() => undefined}
          theme="light"
          onToggleTheme={() => undefined}
        />
        <div style={{ height: 'calc(100% - 48px)' }}>
          <Excalidraw
            initialData={{
              elements: elements as never,
              appState: {
                viewBackgroundColor: '#ffffff',
                ...((baseScene.appState as object | undefined) ?? {}),
              } as never,
              files: ((baseScene.files as object | undefined) ?? {}) as never,
              scrollToContent: true,
            }}
          />
        </div>
      </div>,
    )

    // These are independent async chains — waiting on the display name
    // alone lets the branch chip's later-settling text or icon shift the
    // top bar layout after the screenshot is taken, producing a
    // byte-unstable capture across regenerations.
    await waitFor(() => {
      const titleText = container.textContent ?? ''
      if (!titleText.includes('System architecture')) {
        throw new Error('TopBar canvas display name not yet rendered')
      }
      if (!container.querySelector('[aria-label^="Switch variation"]')) {
        throw new Error('HeaderBranchChip not yet rendered')
      }
      const canvas = container.querySelector('canvas')
      if (!canvas) throw new Error('Excalidraw canvas not yet mounted')
      if (canvas.width === 0) throw new Error('Excalidraw canvas not yet sized')
    })
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    }

    const target = container.querySelector('[data-testid="canvas-user-annotated-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-user-annotated.png'),
      element: page.elementLocator(target),
    })
  })
})
