// The formatting bar is ONE Tab stop with arrows inside, and the editor's
// Escape releases the keyboard backwards as well as forwards: a bar of 16
// buttons followed by an editor that owns Tab and Shift+Tab was 28 Tabs from
// the title and no way back.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { setViewport } from '../../test-utils/viewport.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const bar = () => document.querySelector('[data-testid="markdown-verb-bar"]') as HTMLElement
const buttons = () => [...bar().querySelectorAll('button')]
const inBar = () => bar().contains(document.activeElement)
const label = () => document.activeElement?.getAttribute('aria-label')

async function mount() {
  await setViewport(1280, 800)
  render(
    <div style={{ height: 400 }}>
      <input aria-label="Title" />
      <MarkdownEditor theme="light" value="milk" onChange={vi.fn()} initialViewMode="write" />
    </div>,
  )
  await vi.waitFor(() => expect(buttons().length).toBeGreaterThan(10))
  ;(document.querySelector('input[aria-label="Title"]') as HTMLElement).focus()
}

it('is a single Tab stop that arrows move within and Tab leaves', async () => {
  await mount()
  await userEvent.tab()
  expect(inBar()).toBe(true)
  const first = label()
  await userEvent.keyboard('{ArrowRight}')
  expect(inBar()).toBe(true)
  expect(label()).not.toBe(first)
  await userEvent.keyboard('{End}')
  expect(document.activeElement).toBe(buttons().at(-1))
  await userEvent.keyboard('{Home}')
  expect(document.activeElement).toBe(buttons()[0])
  await userEvent.tab()
  expect(inBar()).toBe(false)
  // Shift+Tab returns to the stop the bar remembered, not to its first button.
  await userEvent.tab({ shift: true })
  expect(document.activeElement).toBe(buttons()[0])
  await userEvent.keyboard('{ArrowRight}{ArrowRight}')
  const remembered = document.activeElement
  await userEvent.tab()
  await userEvent.tab({ shift: true })
  expect(document.activeElement).toBe(remembered)
})

it('returns to the bar on Shift+Tab after Escape releases the editor', async () => {
  await mount()
  const editor = document.querySelector('.cm-content') as HTMLElement
  editor.focus()
  await userEvent.keyboard('{Escape}')
  await userEvent.tab({ shift: true })
  expect(document.activeElement?.closest('.cm-editor')).toBeNull()
  expect(
    document.activeElement?.closest('[role="toolbar"], fieldset, [data-testid]'),
  ).not.toBeNull()
})
