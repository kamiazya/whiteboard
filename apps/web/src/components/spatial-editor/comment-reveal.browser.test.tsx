// Pressing a conversation in the rail has to take the reader to what it is
// about: the canvas pans so the anchor is on screen and the pin briefly
// pulses. The page hands the thread id to the editor through its handle.

import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    textNode({ id: 'near', x: 0, y: 0, width: 120, height: 60, text: 'here' }),
    textNode({ id: 'far', x: 4000, y: 3000, width: 120, height: 60, text: 'over there' }),
  ],
  edges: [],
  // The scene draws a pin for each of these (the thread plane only decorates).
  comments: [
    { id: 't-far', x: 4060, y: 3030, text: 'check this one' },
    { id: 't-done', x: 60, y: 30, text: 'already settled', resolved: true },
  ],
}

const ON_FAR_NODE: CommentThread = {
  id: 't-far',
  anchor: { kind: 'spatial', nodeId: 'far', x: 4060, y: 3030 },
  status: 'open',
  messages: [{ id: 'm1', body: 'check this one', createdAt: '2026-09-02T00:00:00.000Z' }],
}
const ON_FAR_SPOT: CommentThread = {
  id: 't-spot',
  anchor: { kind: 'spatial', x: -3000, y: 2500 },
  status: 'open',
  messages: [{ id: 'm2', body: 'a spot', createdAt: '2026-09-02T00:00:00.000Z' }],
}
const WHOLE: CommentThread = {
  id: 't-doc',
  anchor: { kind: 'document' },
  status: 'open',
  messages: [{ id: 'm3', body: 'about all of it', createdAt: '2026-09-02T00:00:00.000Z' }],
}

const RESOLVED: CommentThread = {
  id: 't-done',
  anchor: { kind: 'spatial', nodeId: 'near', x: 60, y: 30 },
  status: 'resolved',
  messages: [{ id: 'm4', body: 'already settled', createdAt: '2026-09-02T00:00:00.000Z' }],
}

const SIZE = { width: 900, height: 700 }

function mount() {
  const host = makeEditorHost({
    initial: start,
    size: SIZE,
    editorProps: { threads: [ON_FAR_NODE, ON_FAR_SPOT, WHOLE, RESOLVED] },
  })
  const { container } = render(<host.Host />)
  return { ...host, container }
}

function nodeRect(root: HTMLElement, id: string): DOMRect {
  const el = root.querySelector(`[data-testid="canvas-content"] [data-wb-key="${id}"]`)
  return (el as SVGGElement).getBoundingClientRect()
}

async function surfaceRect(): Promise<DOMRect> {
  return (await page.getByTestId('spatial-editor').element()).getBoundingClientRect()
}

it('pans the canvas so the node a conversation is anchored to is on screen', async () => {
  const { latest, container } = mount()
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  const surface = await surfaceRect()
  const before = nodeRect(container, 'far')
  expect(before.left).toBeGreaterThan(surface.right)

  expect(latest.handle?.revealThread('t-far')).toBe(true)

  await vi.waitFor(() => {
    const after = nodeRect(container, 'far')
    expect(after.left).toBeGreaterThanOrEqual(surface.left)
    expect(after.right).toBeLessThanOrEqual(surface.right)
    expect(after.top).toBeGreaterThanOrEqual(surface.top)
    expect(after.bottom).toBeLessThanOrEqual(surface.bottom)
  })
})

it('pulses the anchor it brought into view, and stops', async () => {
  const { latest } = mount()
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  expect(page.getByTestId('comment-reveal-pulse').query()).toBeNull()

  latest.handle?.revealThread('t-far')

  await expect.element(page.getByTestId('comment-reveal-pulse')).toBeInTheDocument()
  await vi.waitFor(() => expect(page.getByTestId('comment-reveal-pulse').query()).toBeNull(), {
    timeout: 5000,
  })
})

it('moves to a spot comment that has no node under it', async () => {
  const { latest } = mount()
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  expect(latest.handle?.revealThread('t-spot')).toBe(true)
  await expect.element(page.getByTestId('comment-reveal-pulse')).toBeInTheDocument()
  const pulse = (await page.getByTestId('comment-reveal-pulse').element()).getBoundingClientRect()
  const surface = await surfaceRect()
  expect(pulse.left).toBeGreaterThanOrEqual(surface.left)
  expect(pulse.right).toBeLessThanOrEqual(surface.right)
})

it('pans nowhere for a whole-document or unknown conversation, and says so', async () => {
  const { latest, container } = mount()
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  const before = nodeRect(container, 'far').left
  expect(latest.handle?.revealThread('t-doc')).toBe(false)
  expect(latest.handle?.revealThread('t-nowhere')).toBe(false)
  expect(nodeRect(container, 'far').left).toBe(before)
  expect(page.getByTestId('comment-reveal-pulse').query()).toBeNull()
})

const pinOf = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-testid="canvas-content"] [data-wb-key="${id}/pin"]`)

it('draws a resolved conversation when it is revealed, though resolved ones are hidden by default', async () => {
  const { latest, container } = mount()
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  await vi.waitFor(() => expect(pinOf(container, 't-far')).not.toBeNull())
  expect(pinOf(container, 't-done')).toBeNull()

  expect(latest.handle?.revealThread('t-done')).toBe(true)

  await vi.waitFor(() => expect(pinOf(container, 't-done')).not.toBeNull())
})

it('shows and hides resolved conversations on the canvas through the handle', async () => {
  const { latest, container } = mount()
  await expect.element(page.getByTestId('canvas-content')).toBeInTheDocument()
  await vi.waitFor(() => expect(pinOf(container, 't-far')).not.toBeNull())
  const source = latest.handle?.showResolved
  expect(source?.get()).toBe(false)

  latest.handle?.setShowResolved(true)
  await vi.waitFor(() => expect(pinOf(container, 't-done')).not.toBeNull())
  expect(source?.get()).toBe(true)

  latest.handle?.setShowResolved(false)
  await vi.waitFor(() => expect(pinOf(container, 't-done')).toBeNull())
  expect(source?.get()).toBe(false)
})
