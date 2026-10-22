// On a phone the text column starts near the left edge, not behind a desktop-sized margin.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setViewport } from '../../test-utils/viewport.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const leftEdgeOfText = (container: HTMLElement) =>
  (container.querySelector('.cm-line') as HTMLElement).getBoundingClientRect().left +
  Number.parseFloat(
    getComputedStyle(container.querySelector('.cm-line') as HTMLElement).paddingLeft,
  )

it('starts the text within 40px of the left edge at 390px wide', async () => {
  await setViewport(390, 844)
  const { container } = render(
    <MarkdownEditor value="hello" onChange={vi.fn()} theme="light" onComposeThread={vi.fn()} />,
  )
  expect(leftEdgeOfText(container)).toBeLessThanOrEqual(40)
})

it('keeps the roomy margin on a wide window', async () => {
  await setViewport(1280, 800)
  const { container } = render(
    <MarkdownEditor value="hello" onChange={vi.fn()} theme="light" onComposeThread={vi.fn()} />,
  )
  expect(leftEdgeOfText(container)).toBeGreaterThan(60)
})
