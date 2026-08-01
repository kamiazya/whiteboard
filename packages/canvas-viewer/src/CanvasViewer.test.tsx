import { render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ViewerScene } from './scene.js'

const excalidrawProps: Array<Record<string, unknown>> = []

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    excalidrawProps.push(props)
    return <div data-testid="excalidraw-stub" />
  },
}))

const { CanvasViewer } = await import('./CanvasViewer.js')

const scene: ViewerScene = {
  elements: [{ id: 'a', type: 'rectangle' }] as never,
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
}

describe('CanvasViewer', () => {
  it('renders inside a container tagged with the given testId', () => {
    const { getByTestId } = render(<CanvasViewer scene={scene} testId="my-viewer" />)

    expect(getByTestId('my-viewer')).toBeTruthy()
  })

  it('locks the canvas to read-only mode', () => {
    excalidrawProps.length = 0
    render(<CanvasViewer scene={scene} />)

    const props = excalidrawProps.at(-1)
    expect(props?.viewModeEnabled).toBe(true)
  })

  it('disables editing canvas actions via UIOptions', () => {
    excalidrawProps.length = 0
    render(<CanvasViewer scene={scene} />)

    const props = excalidrawProps.at(-1)
    const uiOptions = props?.UIOptions as { canvasActions?: Record<string, boolean> }
    expect(uiOptions.canvasActions?.export).toBe(false)
    expect(uiOptions.canvasActions?.saveToActiveFile).toBe(false)
  })

  it('forwards the scene elements, appState and files as initialData', () => {
    excalidrawProps.length = 0
    render(<CanvasViewer scene={scene} />)

    const props = excalidrawProps.at(-1)
    const initialData = props?.initialData as {
      elements: unknown
      appState: Record<string, unknown>
      files: unknown
    }
    expect(initialData.elements).toEqual(scene.elements)
    expect(initialData.appState.viewBackgroundColor).toBe('#ffffff')
    expect(initialData.files).toEqual(scene.files)
  })

  it('hides Excalidraw chrome when hideChrome is set', () => {
    const { container } = render(<CanvasViewer scene={scene} testId="hidden-chrome" hideChrome />)

    expect(container.querySelector('style')?.textContent).toContain('hidden-chrome')
  })

  it('falls back to the default testId when given a value outside the safe identifier charset', () => {
    const maliciousTestId = '"}</style><script>alert(1)</script>'
    const { container } = render(<CanvasViewer scene={scene} testId={maliciousTestId} hideChrome />)

    expect(within(container).getByTestId('canvas-viewer')).toBeTruthy()
    const styleText = container.querySelector('style')?.textContent ?? ''
    expect(styleText).not.toContain(maliciousTestId)
    expect(styleText).toContain('canvas-viewer')
  })
})
