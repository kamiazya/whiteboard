/**
 * Printing a note hands out its READ view: the title and the drawn body,
 * over as many pages as it takes, with none of the app around it. The page
 * is a fixed-height app shell that scrolls inside, so a print that keeps
 * that box prints one page cut off mid-body — which is what it did.
 *
 * Real Chromium with print media emulated over CDP: what is hidden and how
 * tall the body lays out are the browser's print cascade, which jsdom does
 * not have.
 */
import '../../index.css'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdp } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'
import { requestNotePrint } from './note-print.js'

const BODY = Array.from(
  { length: 24 },
  (_, i) => `## Section ${i + 1}\n\nWater evaporates, condenses and falls again (${i + 1}).`,
).join('\n\n')

async function emulatePrint(on: boolean) {
  await cdp().send('Emulation.setEmulatedMedia', { media: on ? 'print' : '' })
}

afterEach(async () => {
  await emulatePrint(false)
  cleanup()
  vi.restoreAllMocks()
})

function Page({ mode = 'read', value = BODY }: { mode?: 'read' | 'split'; value?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 400, overflow: 'hidden' }}>
      <header data-testid="app-chrome">ALPHA · Saved</header>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <MarkdownEditor
          theme="light"
          value={value}
          onChange={() => {}}
          initialViewMode={mode}
          previewDebounceMs={0}
          title="Week 1 - Evaporation"
          meta={{ type: 'note' }}
        />
      </div>
    </div>
  )
}

const drawn = () => document.querySelector('[data-testid="markdown-preview-pane"] svg')

describe('a note printed from the browser', () => {
  it('prints the title and the whole body in page-sized strips, without the app', async () => {
    render(<Page />)
    await expect.poll(drawn).not.toBeNull()
    await emulatePrint(true)

    await expect
      .poll(() => document.querySelectorAll('[data-testid="note-print-band"]').length)
      .toBeGreaterThan(10)
    const view = screen.getByTestId('note-print-view')
    expect(view.querySelector('h1')?.textContent).toBe('Week 1 - Evaporation')
    // The whole body is laid out, not the 400px the shell gives it on screen.
    expect(view.getBoundingClientRect().height).toBeGreaterThan(1200)
    // ...and nothing it sits in clips it to the screen's box, so it runs on
    // over pages rather than stopping where the shell's scroll box ends.
    const clipping: string[] = []
    for (let box = view.parentElement; box !== null; box = box.parentElement) {
      const style = getComputedStyle(box)
      if (style.overflowY !== 'visible' || box.getBoundingClientRect().height < 1200) {
        clipping.push(`${box.tagName}.${box.className}: ${style.overflowY}`)
      }
    }
    expect(clipping).toEqual([])
    expect(getComputedStyle(screen.getByTestId('app-chrome')).display).toBe('none')
    // The on-screen body steps aside for the strips: the pane's own box is
    // what a display: none ancestor hides, so its nearest one is asked.
    const onScreen = screen.getByTestId('markdown-preview-pane').closest('.note-print-screen')
    expect(onScreen === null ? 'missing' : getComputedStyle(onScreen).display).toBe('none')
    for (const band of view.querySelectorAll('[data-testid="note-print-band"]')) {
      expect(getComputedStyle(band).breakInside).toBe('avoid')
    }
  })

  it('prints the title once when the body already opens with it', async () => {
    render(<Page mode="split" value={`# Week 1 - Evaporation\n\n${BODY}`} />)
    await expect.poll(drawn).not.toBeNull()
    await emulatePrint(true)
    await expect
      .poll(() => document.querySelectorAll('[data-testid="note-print-band"]').length)
      .toBeGreaterThan(10)
    const view = screen.getByTestId('note-print-view')
    // The body's own heading is the one that prints; each strip is a clip of
    // the whole drawn body, so its text is asked of the drawing itself.
    expect(view.querySelector('h1')).toBeNull()
    expect(drawn()?.textContent).toContain('Week 1 - Evaporation')
  })

  it('keeps each heading on the strip of the paragraph it introduces', async () => {
    render(<Page />)
    await expect.poll(drawn).not.toBeNull()
    await emulatePrint(true)
    // Twenty-four sections of a heading and a paragraph: one strip each, so
    // no page can end on a heading whose paragraph starts the next.
    await expect
      .poll(() => document.querySelectorAll('[data-testid="note-print-band"]').length)
      .toBe(24)
  })

  it('draws nothing extra on screen, and drops the strips once printing ends', async () => {
    render(<Page />)
    await expect.poll(drawn).not.toBeNull()
    expect(screen.queryByTestId('note-print-view')).toBeNull()
    await emulatePrint(true)
    await expect.poll(() => screen.queryByTestId('note-print-view')).not.toBeNull()
    await emulatePrint(false)
    await expect.poll(() => screen.queryByTestId('note-print-view')).toBeNull()
    expect(getComputedStyle(screen.getByTestId('app-chrome')).display).not.toBe('none')
  })
})

describe('Print / Save as PDF from the document menu', () => {
  it('prints the read view from Split, then gives the reader Split back', async () => {
    const sourceShown = () =>
      getComputedStyle(screen.getByTestId('markdown-source-wrap')).display !== 'none'
    let readWhenPrinted: boolean | null = null
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      readWhenPrinted = !sourceShown()
    })
    render(<Page mode="split" />)
    await expect.poll(drawn).not.toBeNull()
    expect(sourceShown()).toBe(true)

    requestNotePrint()

    await expect.poll(() => print.mock.calls.length).toBe(1)
    expect(readWhenPrinted).toBe(true)
    await expect.poll(sourceShown).toBe(true)
  })
})
