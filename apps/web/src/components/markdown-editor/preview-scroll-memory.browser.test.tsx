// Following a link out of the Read view and pressing Back remounts the
// editor; the reader must land where they were, not at the top.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import '../../index.css'
import { MarkdownEditor } from './MarkdownEditor.js'

beforeAll(async () => {
  await vi.waitFor(() => {
    const probe = document.createElement('div')
    probe.className = 'w-full'
    document.body.append(probe)
    const applied = getComputedStyle(probe).width !== 'auto'
    probe.remove()
    if (!applied) throw new Error('index.css not applied yet')
  })
})

afterEach(() => {
  cleanup()
  for (const host of document.querySelectorAll('body > div[style*="height"]')) host.remove()
})

const LONG_BODY = Array.from({ length: 80 }, (_, i) => `paragraph ${i}`).join('\n\n')

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
}

function mount() {
  const host = document.createElement('div')
  host.style.cssText = 'width:600px;height:400px'
  document.body.append(host)
  return render(
    <MarkdownEditor theme="light" initialViewMode="read" value={LONG_BODY} onChange={() => {}} />,
    { container: host },
  )
}

function previewScroller(): HTMLElement {
  return screen.getByTestId('markdown-preview-scroll')
}

it('restores the Read view scroll position when the same history entry is mounted again', async () => {
  history.replaceState({ key: 'entry-a' }, '')
  const first = mount()
  await vi.waitFor(() => expect(previewScroller().scrollHeight).toBeGreaterThan(1000))
  const scroller = previewScroller()
  scroller.scrollTop = 600
  await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(500))
  const saved = scroller.scrollTop
  // A programmatic scroll reports on the next frame, as a reader's does.
  await frames(2)
  first.unmount()

  mount()
  await vi.waitFor(() => expect(Math.abs(previewScroller().scrollTop - saved)).toBeLessThan(2))
})

it('starts at the top for a history entry never scrolled', async () => {
  history.replaceState({ key: 'entry-b' }, '')
  mount()
  await vi.waitFor(() => expect(previewScroller().scrollHeight).toBeGreaterThan(1000))
  await frames(10)
  expect(previewScroller().scrollTop).toBe(0)
})
