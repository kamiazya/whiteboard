// Characterization test for the docs-snapshot ScenePreview wrapper. Locks
// in the externally observable contract (testId, sizing, chrome-hiding,
// read-only lockdown, scene forwarding) so reimplementing it on top of
// @kamiazya/whiteboard-canvas-viewer's <CanvasViewer> cannot silently
// change what the *.docs-snapshot.test.tsx screenshot tests capture.
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const excalidrawProps: Array<Record<string, unknown>> = []

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    excalidrawProps.push(props)
    return <div data-testid="excalidraw-stub" />
  },
}))

const { ScenePreview } = await import('./_scene-preview.js')

describe('ScenePreview', () => {
  it('renders a fixed-size container tagged with the given testId', () => {
    excalidrawProps.length = 0
    const { getByTestId } = render(
      <ScenePreview width={400} height={300} elements={[]} testId="my-preview" />,
    )

    const el = getByTestId('my-preview') as HTMLElement
    expect(el.style.width).toBe('400px')
    expect(el.style.height).toBe('300px')
  })

  it('locks the canvas to read-only mode by default', () => {
    excalidrawProps.length = 0
    render(<ScenePreview width={100} height={100} elements={[]} />)

    expect(excalidrawProps[excalidrawProps.length - 1]?.viewModeEnabled).toBe(true)
  })

  it('hides Excalidraw chrome when hideChrome is set', () => {
    excalidrawProps.length = 0
    const { container } = render(
      <ScenePreview width={100} height={100} elements={[]} hideChrome testId="chrome-off" />,
    )

    expect(container.querySelector('style')?.textContent).toContain('.App-menu')
  })

  it('forwards elements, appState and files into the underlying scene', () => {
    excalidrawProps.length = 0
    const elements = [{ id: 'a', type: 'rectangle' }]
    const files = { f1: { id: 'f1' } }
    render(
      <ScenePreview
        width={100}
        height={100}
        elements={elements}
        appState={{ viewBackgroundColor: '#000000' }}
        files={files}
      />,
    )

    const initialData = excalidrawProps[excalidrawProps.length - 1]?.initialData as {
      elements: unknown
      appState: Record<string, unknown>
      files: unknown
    }
    expect(initialData.elements).toEqual(elements)
    expect(initialData.appState.viewBackgroundColor).toBe('#000000')
    expect(initialData.files).toEqual(files)
  })
})
