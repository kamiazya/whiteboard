// OS-clipboard interop (editor-completeness slice 5). The clipboard family
// rides the NATIVE copy/cut/paste events rather than keydown, because a
// keydown preventDefault would suppress the very event that carries
// `clipboardData` — and that data is what lets a fragment cross tabs and
// what lets foreign text degrade into a note.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearClipboardFragmentForTests } from '../../lib/clipboard-store.js'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)
beforeEach(clearClipboardFragmentForTests)

const initial: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 40, y: 40, width: 160, height: 80, text: 'A' }],
  edges: [],
}

function makeHost(start: SpatialCanvas = initial) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function selectFirst(root: HTMLElement) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 120,
    clientY: r.top + 80,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 120, clientY: r.top + 80 })
}

/**
 * Real Chromium refuses a plain object for `clipboardData`, so these use a
 * genuine DataTransfer + ClipboardEvent — the same objects the browser
 * hands the handler for an OS copy/paste.
 */
function clipboardWith(text = ''): DataTransfer {
  const data = new DataTransfer()
  if (text !== '') data.setData('text/plain', text)
  return data
}

function dispatchClipboard(
  root: HTMLElement,
  type: 'copy' | 'cut' | 'paste',
  clipboardData: DataTransfer | null,
): void {
  // fireEvent (not raw dispatchEvent) so React flushes the resulting state
  // updates inside act before the assertions run.
  fireEvent(root, new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData }))
}

it('a native copy writes the fragment as JSON into text/plain', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectFirst(root)

  const clipboardData = clipboardWith()
  dispatchClipboard(root, 'copy', clipboardData)

  const written = clipboardData.getData('text/plain')
  const parsed = JSON.parse(written)
  expect(parsed.type).toBe('whiteboard/clipboard')
  expect(parsed.nodes).toHaveLength(1)
  expect(parsed.nodes[0].text).toBe('A')
})

it('pasting our JSON from another tab recreates the nodes with reminted ids', () => {
  const fragment = {
    type: 'whiteboard/clipboard',
    version: 1,
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'from-other-tab' }],
    edges: [],
  }
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)
  const root = rootOf(container)

  dispatchClipboard(root, 'paste', clipboardWith(JSON.stringify(fragment)))

  expect(latest.canvas.nodes).toHaveLength(1)
  expect(latest.canvas.nodes[0]).toMatchObject({ text: 'from-other-tab' })
  expect(latest.canvas.nodes[0].id).not.toBe('a')
  expect(latest.commands.at(-1)?.kind).toBe('batch')
})

it('pasting arbitrary text degrades to a text node instead of doing nothing', () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)
  const root = rootOf(container)

  dispatchClipboard(root, 'paste', clipboardWith('hello from a web page'))

  expect(latest.canvas.nodes).toHaveLength(1)
  expect(latest.canvas.nodes[0]).toMatchObject({ type: 'text', text: 'hello from a web page' })
})

it('foreign JSON is treated as plain text, never as a fragment', () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const foreign = JSON.stringify({ type: 'excalidraw/clipboard', elements: [] })

  dispatchClipboard(root, 'paste', clipboardWith(foreign))

  expect(latest.canvas.nodes).toHaveLength(1)
  expect(latest.canvas.nodes[0]).toMatchObject({ type: 'text', text: foreign })
})

it('an empty clipboard paste is a no-op', () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  const { container } = render(<Host />)
  dispatchClipboard(rootOf(container), 'paste', clipboardWith('   '))
  expect(latest.commands).toHaveLength(0)
})

it('a native cut copies to the OS clipboard AND removes the selection in one batch', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectFirst(root)

  const clipboardData = clipboardWith()
  dispatchClipboard(root, 'cut', clipboardData)

  expect(JSON.parse(clipboardData.getData('text/plain') || '{}').nodes).toHaveLength(1)
  expect(latest.canvas.nodes).toEqual([])
  expect(latest.commands.at(-1)?.kind).toBe('batch')
})

it('the in-app store still round-trips when the event carries no clipboardData', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectFirst(root)

  dispatchClipboard(root, 'copy', null)
  dispatchClipboard(root, 'paste', null)

  expect(latest.canvas.nodes).toHaveLength(2)
  expect(latest.canvas.nodes[1]).toMatchObject({ text: 'A' })
})
