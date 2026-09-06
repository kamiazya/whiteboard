/**
 * The annotation gutter paints nothing of its own.
 *
 * CodeMirror's base theme gives `.cm-gutters` a light-grey fill and a light
 * right border. Nothing in this app overrode them, so on the dark theme the
 * strip was a near-white band down the left edge of the body — and because
 * the gutter's width is reserved whether or not the document has any
 * conversations, the band was there on a document with no comments at all.
 *
 * Both readings are the same defect and this is its guard: the gutter is
 * transparent and borderless, so the reserved width is indistinguishable
 * from the body's own margin until a marker appears in it. Real browser,
 * because the claim is about computed style from a stylesheet the app ships
 * and a base theme CodeMirror injects at runtime.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = 'Ship the report on Friday.'

function guttersOf(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.cm-gutters')
  if (found === null) throw new Error('no gutter rendered')
  return found
}

/** A colour that paints nothing: fully transparent, whatever the channels say. */
function paintsNothing(color: string): boolean {
  return /^rgba?\([^)]*,\s*0\s*\)$/.test(color) || color === 'transparent'
}

it('leaves the gutter unpainted on the dark theme, so an empty one is not a band', async () => {
  const { container } = render(
    <MarkdownEditor value={BODY} onChange={vi.fn()} theme="dark" onComposeThread={vi.fn()} />,
  )
  const gutters = guttersOf(container)
  const style = getComputedStyle(gutters)
  expect(paintsNothing(style.backgroundColor)).toBe(true)
  expect(style.borderRightWidth).toBe('0px')
  // The reserve itself stays: a thread arriving from a peer must not reflow
  // the body sideways under whoever is typing in it.
  expect(gutters.getBoundingClientRect().width).toBeGreaterThan(0)
  expect(container.querySelectorAll('.cm-annotation-gutter-marker')).toHaveLength(0)
})

it('leaves it unpainted on the light theme too, where the same band was merely quieter', async () => {
  const { container } = render(
    <MarkdownEditor value={BODY} onChange={vi.fn()} theme="light" onComposeThread={vi.fn()} />,
  )
  const style = getComputedStyle(guttersOf(container))
  expect(paintsNothing(style.backgroundColor)).toBe(true)
  expect(style.borderRightWidth).toBe('0px')
})
