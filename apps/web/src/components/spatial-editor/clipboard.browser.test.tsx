// In-app copy/cut/paste (editor-completeness slice 4): Cmd/Ctrl+C/X/V over
// the module-level clipboard store — cross-canvas within the tab, every
// mutation ONE batch command (one undo step), reminted ids on every paste.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearClipboardFragmentForTests } from '../../lib/clipboard-store.js'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)
beforeEach(clearClipboardFragmentForTests)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 160, height: 80, text: 'A' },
    { id: 'b', type: 'text', x: 320, y: 40, width: 160, height: 80, text: 'B' },
  ],
  edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'kept' }],
}

function makeHost(start: SpatialCanvas = initial) {
  const latest: {
    canvas: SpatialCanvas
    commands: EditorCommand[]
    reset: (canvas: SpatialCanvas) => void
  } = {
    canvas: start,
    commands: [],
    reset: () => {},
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    latest.reset = setCanvas
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

function selectAt(root: HTMLElement, x: number, y: number, shift = false) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    shiftKey: shift,
    clientX: r.left + x,
    clientY: r.top + y,
  })
  fireEvent.pointerUp(root, {
    pointerId: 1,
    shiftKey: shift,
    clientX: r.left + x,
    clientY: r.top + y,
  })
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

/**
 * Cmd+C/X/V reach the editor as NATIVE clipboard events (see
 * os-clipboard.browser.test.tsx) — with no clipboardData the handlers fall
 * back to the in-app slot, which is what these same-tab cases exercise.
 */
function clip(root: HTMLElement, type: 'copy' | 'cut' | 'paste'): void {
  fireEvent(root, new ClipboardEvent(type, { bubbles: true, cancelable: true }))
}

it('copy then paste clones the selection with reminted ids, offset, as ONE batch', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'copy')
  // Copy never mutates the canvas.
  expect(latest.commands).toHaveLength(0)

  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
  const copy = latest.canvas.nodes[2]
  expect(copy.id).not.toBe('a')
  expect(copy).toMatchObject({ text: 'A', x: 40 + 16, y: 40 + 16 })
  expect(latest.commands.at(-1)?.kind).toBe('batch')

  // Paste again: reminted afresh, cascading offset from the ORIGINAL copy.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(4)
  expect(new Set(latest.canvas.nodes.map((n) => n.id)).size).toBe(4)
})

it("the context menu's Cut is the same deferred cut as the keyboard's", () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  const cutItem = [...container.querySelectorAll('[role="menuitem"]')].find(
    (el) => (el.getAttribute('aria-label') ?? el.textContent) === 'Cut',
  ) as HTMLElement
  expect(cutItem).toBeDefined()
  fireEvent.click(cutItem)
  // Held, not deleted — and a plain-copy menu path would show no veil.
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  expect(container.querySelector('[data-testid="ghost-overlay"]')).not.toBeNull()

  clip(root, 'paste')
  // Resolved as a move: same ids, the edge never blinked.
  expect(latest.canvas.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  expect(latest.canvas.edges).toEqual(initial.edges)
})

it('undoing a paste restores the cut surface — the next paste reconnects again', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  // A deleted hold is the case where the cut surface matters: the originals
  // are gone, so paste has something to reconnect.
  clip(root, 'cut')
  fireEvent.keyDown(root, { key: 'Delete' })
  const afterDelete = latest.canvas
  expect(afterDelete.edges).toEqual([])

  clip(root, 'paste')
  expect(latest.canvas.edges).toHaveLength(1)

  // The paste landed in the wrong spot and the person undoes it. Undo lives
  // in the host (one batch = one undo step), so from this component's side
  // it arrives as the pre-paste snapshot coming back.
  act(() => latest.reset(afterDelete))
  expect(latest.canvas.edges).toEqual([])

  // The document holds no trace of the first paste, so the next paste is a
  // first paste again: the boundary edge must reconnect, not silently drop.
  clip(root, 'paste')
  const pasted = latest.canvas.nodes.find((n) => n.type === 'text' && n.text === 'A')
  expect(latest.canvas.edges).toHaveLength(1)
  const restored = latest.canvas.edges[0]
  expect([restored.fromNode, restored.toNode].sort()).toEqual([pasted?.id, 'b'].sort())
})

it('copy then paste never wires the duplicate to the original peer', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'copy')
  clip(root, 'paste')
  // The original edge a–b survives untouched; the duplicate arrives bare.
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(latest.canvas.edges).toHaveLength(1)
  expect(latest.canvas.edges[0]).toMatchObject({ fromNode: 'a', toNode: 'b' })
})

it('a multi-selection copy carries the internal edge with properties; paste remaps endpoints', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  selectAt(root, 400, 80, true)

  clip(root, 'copy')
  clip(root, 'paste')

  expect(latest.canvas.nodes).toHaveLength(4)
  expect(latest.canvas.edges).toHaveLength(2)
  const pastedIds = new Set(latest.canvas.nodes.slice(2).map((n) => n.id))
  const pastedEdge = latest.canvas.edges[1]
  expect(pastedEdge.label).toBe('kept')
  expect(pastedIds.has(pastedEdge.fromNode)).toBe(true)
  expect(pastedIds.has(pastedEdge.toNode)).toBe(true)
})

it('the clipboard is shared across editor mounts — cross-canvas paste within the tab', () => {
  const a = makeHost()
  const first = render(<a.Host />)
  selectAt(rootOf(first.container), 120, 80)
  clip(rootOf(first.container), 'copy')
  first.unmount()

  const empty: SpatialCanvas = { nodes: [], edges: [] }
  const b = makeHost(empty)
  const second = render(<b.Host />)
  clip(rootOf(second.container), 'paste')
  expect(b.latest.canvas.nodes).toHaveLength(1)
  expect(b.latest.canvas.nodes[0]).toMatchObject({ text: 'A' })
})

it("the empty-space context menu offers 'Paste here', centering the fragment at the click point", () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'copy')

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 600, clientY: r.top + 400 })
  const item = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Paste here',
  ) as HTMLElement
  expect(item).toBeDefined()
  fireEvent.click(item)

  const pasted = latest.canvas.nodes[2]
  // Centered on the click point (identity viewport): 600-80, 400-40.
  expect(pasted).toMatchObject({ x: 600 - 80, y: 400 - 40 })
})

it('Cmd+C or Cmd+V with nothing to act on stays inert (browser keeps its own copy/paste)', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  clip(root, 'copy')
  clip(root, 'paste')
  expect(latest.commands).toHaveLength(0)
  expect(latest.canvas.nodes).toHaveLength(2)
})

// --- Deferred cut (ghost): cut is the front half of a move ---------------

it('cut defers the delete: the document is untouched and the ghost veil appears', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'cut')
  // Nothing left the document — the cut is a pending move, not a delete.
  expect(latest.commands).toHaveLength(0)
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  expect(latest.canvas.edges).toHaveLength(1)
  expect(container.querySelector('[data-testid="ghost-overlay"]')).not.toBeNull()
})

it('pasting a pending cut MOVES the original — same ids, edges untouched, one undo step', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'cut')
  clip(root, 'paste')

  // Same node, new place: no remint, so every edge (internal or boundary)
  // survives without any reconnection machinery.
  expect(latest.canvas.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  const moved = latest.canvas.nodes.find((n) => n.id === 'a')
  expect(moved).toMatchObject({ x: 40 + 16, y: 40 + 16 })
  expect(latest.canvas.edges).toEqual(initial.edges)
  const last = latest.commands.at(-1)
  expect(last?.kind).toBe('batch')
  if (last?.kind === 'batch') {
    expect(last.commands.every((c) => c.kind === 'move-node')).toBe(true)
  }
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()

  // A second paste of the same envelope is a plain copy, and the original
  // edge still exists — so no second wire onto the peer either.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(latest.canvas.edges).toHaveLength(1)
})

it('Escape lifts the ghost; the envelope keeps working as a plain copy', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'cut')
  fireEvent.keyDown(rootOf(container), { key: 'Escape' })
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()
  expect(latest.canvas.nodes).toHaveLength(2)

  // Paste now duplicates — and must NOT wire the copy to the peer, because
  // the original edge was never severed.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(latest.canvas.edges).toHaveLength(1)
  expect(latest.canvas.edges[0]).toMatchObject({ id: 'ab', fromNode: 'a', toNode: 'b' })
})

it('deleting a ghosted selection is a real delete; the next paste reconnects like a cut', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'cut')
  fireEvent.keyDown(rootOf(container), { key: 'Delete' })
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['b'])
  expect(latest.canvas.edges).toEqual([])
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()

  // The originals are gone now, so the cut surface applies: paste restores
  // the node wired back to its surviving peer.
  clip(root, 'paste')
  const pasted = latest.canvas.nodes.find((n) => n.type === 'text' && n.text === 'A')
  expect(latest.canvas.edges).toHaveLength(1)
  const restored = latest.canvas.edges[0]
  expect([restored.fromNode, restored.toNode].sort()).toEqual([pasted?.id, 'b'].sort())
})

it('grabbing a ghosted node cancels the hold and the drag proceeds normally', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'cut')

  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 120,
    clientY: r.top + 80,
  })
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + 160, clientY: r.top + 120 })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 160, clientY: r.top + 120 })

  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()
  const movedNode = latest.canvas.nodes.find((n) => n.id === 'a')
  expect(movedNode?.x).not.toBe(40)
  expect(latest.canvas.nodes).toHaveLength(2)
})

it('a plain copy clears a pending cut — the newest clipboard intent wins', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'cut')
  expect(container.querySelector('[data-testid="ghost-overlay"]')).not.toBeNull()

  clip(root, 'copy')
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()
  expect(latest.canvas.nodes).toHaveLength(2)
})

it('a content-only change to a held node lifts the hold — ANY touch counts, not just geometry', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'cut')
  expect(container.querySelector('[data-testid="ghost-overlay"]')).not.toBeNull()

  // A remote collaborator edits the held node's TEXT — same geometry.
  act(() =>
    latest.reset({
      ...latest.canvas,
      nodes: latest.canvas.nodes.map((n) =>
        n.id === 'a' && n.type === 'text' ? { ...n, text: 'rewritten' } : n,
      ),
    }),
  )
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()

  // With the hold lifted, paste is a plain copy — never a silent move of
  // the node someone just rewrote.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(
    latest.canvas.nodes.filter((n) => n.type === 'text' && n.text === 'rewritten'),
  ).toHaveLength(1)
})

it("an anchored 'Paste here' moves the held selection so its center lands on the click", async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'cut')

  // Right-click empty space, far from both nodes, and choose Paste here.
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 600, clientY: r.top + 400 })
  const pasteItem = [...container.querySelectorAll('[role="menuitem"]')].find(
    (el) => (el.getAttribute('aria-label') ?? el.textContent) === 'Paste here',
  ) as HTMLElement
  expect(pasteItem).toBeDefined()
  fireEvent.click(pasteItem)

  // Same node, no remint; the held box's center lands on the click point
  // (the default viewport is identity, so screen = canvas coordinates).
  expect(latest.canvas.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  const moved = latest.canvas.nodes.find((n) => n.id === 'a')
  expect(moved).toBeDefined()
  if (moved === undefined) throw new Error('unreachable')
  expect(Math.round(moved.x + moved.width / 2)).toBe(600)
  expect(Math.round(moved.y + moved.height / 2)).toBe(400)
  expect(latest.canvas.edges).toEqual(initial.edges)
})

// --- Tap-to-place + the pending chip --------------------------------------

function tapEmpty(root: HTMLElement, x: number, y: number, pointerType = 'touch') {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 9,
    pointerType,
    isPrimary: true,
    clientX: r.left + x,
    clientY: r.top + y,
  })
  fireEvent.pointerUp(root, {
    pointerId: 9,
    pointerType,
    isPrimary: true,
    clientX: r.left + x,
    clientY: r.top + y,
  })
}

it('a touch tap on empty canvas places the held selection there — no menu needed', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'cut')

  tapEmpty(root, 600, 400)

  // Same node, moved so its center lands on the tap (identity viewport).
  expect(latest.canvas.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  const moved = latest.canvas.nodes.find((n) => n.id === 'a')
  if (moved === undefined) throw new Error('unreachable')
  expect(Math.round(moved.x + moved.width / 2)).toBe(600)
  expect(Math.round(moved.y + moved.height / 2)).toBe(400)
  expect(latest.canvas.edges).toEqual(initial.edges)
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()
})

it('a mouse click on empty canvas does NOT place — desktop keeps the explicit paste', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'cut')

  tapEmpty(root, 600, 400, 'mouse')

  // Deselect happened, the hold stays, nothing moved.
  const a = latest.canvas.nodes.find((n) => n.id === 'a')
  expect(a).toMatchObject({ x: 40, y: 40 })
  expect(container.querySelector('[data-testid="ghost-overlay"]')).not.toBeNull()
})

it('the pending chip announces the hold and its ✕ cancels it — touch finally has an exit', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  expect(container.querySelector('[data-testid="pending-cut-chip"]')).toBeNull()

  selectAt(root, 120, 80)
  clip(root, 'cut')
  const chip = container.querySelector('[data-testid="pending-cut-chip"]') as HTMLElement
  expect(chip).not.toBeNull()

  const cancel = chip.querySelector('[aria-label="Cancel cut"]') as HTMLElement
  expect(cancel).not.toBeNull()
  fireEvent.click(cancel)
  expect(container.querySelector('[data-testid="pending-cut-chip"]')).toBeNull()
  expect(container.querySelector('[data-testid="ghost-overlay"]')).toBeNull()
  expect(latest.canvas.nodes).toHaveLength(2)

  // The envelope still works as a plain copy afterwards.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
})
