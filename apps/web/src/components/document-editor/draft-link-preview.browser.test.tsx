/**
 * The verified user flow, locked in: a link typed into the node editor
 * overlay resolves in its preview BEFORE the edit is committed — the
 * overlay reports its draft, the page loads what the draft names, and the
 * overlay's seams (built from the same wire the canvas gets) answer.
 *
 * Mounted the way DocumentPage mounts it: `useNodeInEditor` and
 * `useDocumentFileSeams` joined through `draftBodies`, over the real pane.
 * Before the draft crossed, the wire held only what the CANVAS named, so a
 * new link stayed literal until the commit put it on the canvas.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useMemo, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { useDocumentFileSeams } from '../../hooks/use-document-file-seams.js'
import type { DocumentFileAdapter } from '../../lib/document-file-contract.js'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { SpatialEditorPane } from './SpatialEditorPane.js'
import { useNodeInEditor } from './use-node-in-editor.js'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TARGET_PATH = 'reviews/weekly'
const PROSE = 'PROSE OF THE WEEKLY REVIEW'
const targets = [
  { id: TARGET_ID, path: TARGET_PATH, name: 'Weekly review', kind: 'markdown' as const },
]
const stampOf = new Map<string, string>()

const initial: SpatialCanvas = {
  nodes: [{ id: 't', type: 'text', x: 40, y: 40, width: 320, height: 200, text: 'Plan:' }],
  edges: [],
}

function Harness({ adapter }: { readonly adapter: DocumentFileAdapter }) {
  const [canvas, setCanvas] = useState(initial)
  const nodeInEditor = useNodeInEditor(canvas, (next) => setCanvas(next), 'doc')
  const resolveAlias = useMemo(
    () => (alias: string) => (alias === TARGET_PATH ? TARGET_ID : null),
    [],
  )
  const resolveTitle = useMemo(
    () => (id: string) => (id === TARGET_ID ? 'Weekly review' : undefined),
    [],
  )
  const fileSeams = useDocumentFileSeams({
    canvas,
    adapter,
    resolveAlias,
    resolveTitle,
    stampOf,
    bodies: nodeInEditor.draftBodies,
  })
  return (
    <>
      <button type="button" onClick={() => nodeInEditor.open('t', 'Plan:')}>
        raise open-in-editor
      </button>
      <SpatialEditorPane
        editorKey="doc"
        canvasLoaded
        fileSeams={fileSeams}
        nodeInEditor={nodeInEditor}
        onOpenDocument={() => {}}
        history={{ onUndo: () => {}, onRedo: () => {}, canUndo: false, canRedo: false }}
        overlayTitle="Board"
        linkTargets={targets}
        className="relative h-[600px] w-[900px]"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </>
  )
}

const previewText = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="node-text-overlay"] svg text')]
    .map((node) => node.textContent ?? '')
    .join(' ')

describe('a link typed into the node editor overlay', () => {
  it('resolves in the preview before the commit, once the page has loaded what the draft names', async () => {
    const loadDocument = vi.fn(async (ref: string) =>
      ref === TARGET_ID || ref === TARGET_PATH ? { body: PROSE, name: 'Weekly review' } : undefined,
    )
    const adapter: DocumentFileAdapter = {
      isImageRef: () => false,
      loadDocument,
      loadImageUrl: async () => undefined,
      storeImage: async () => undefined,
    }
    const { container, getByRole } = render(<Harness adapter={adapter} />)
    await userEvent.click(getByRole('button', { name: 'raise open-in-editor' }))
    const overlay = await waitFor(() => {
      const found = container.querySelector('[data-testid="node-text-overlay"]')
      if (found === null) throw new Error('overlay not open')
      return found as HTMLElement
    })
    await waitFor(() => expect(overlay.querySelector('.cm-content')).not.toBeNull())
    // Nothing on the canvas names the review yet.
    expect(loadDocument).not.toHaveBeenCalled()

    await focusEditable(() => overlay.querySelector('[contenteditable="true"]'))
    await userEvent.keyboard('{Control>}{End}{/Control}')
    // user-event treats [[ as an escaped literal [ — four brackets type two.
    await userEvent.keyboard(`{Enter}{Enter}![[[[${TARGET_PATH}]]`)

    // The draft crossed and the page loaded its target — with no commit.
    await waitFor(() => expect(loadDocument).toHaveBeenCalledWith(TARGET_PATH))
    await userEvent.click(getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(previewText(container)).toContain(PROSE))
    expect(container.querySelector('svg text')).not.toBeNull()
  })
})
