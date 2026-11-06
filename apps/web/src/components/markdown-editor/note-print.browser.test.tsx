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
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdp } from 'vitest/browser'
import { useReferenceSeams } from '../../hooks/use-reference-seams.js'
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

const BOARD: SpatialCanvas = {
  nodes: [textNode({ id: 'cloud', x: 0, y: 0, width: 160, height: 60, text: 'Cloud' })],
  edges: [],
}

function ThemedNote({ theme }: { theme: 'light' | 'dark' }) {
  return <EmbedNote theme={theme} value={'## The cycle\n\n![[board]]\n\nRain falls.'} />
}

function EmbedNote({
  theme = 'light',
  value,
  canvas = BOARD,
}: {
  theme?: 'light' | 'dark'
  value: string
  canvas?: SpatialCanvas
}) {
  const references = useReferenceSeams({
    body: value,
    load: async () => ({ documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', name: 'board', canvas }),
  })
  return (
    <MarkdownEditor
      theme={theme}
      value={value}
      onChange={() => {}}
      initialViewMode="read"
      previewDebounceMs={0}
      references={references}
    />
  )
}

/** Every paint an SVG subtree names, as a sorted set: what a palette changes. */
const paints = (root: Element | null): string[] =>
  [
    ...new Set(
      [...(root?.querySelectorAll('[fill], [stroke]') ?? [])].flatMap((node) => [
        node.getAttribute('fill') ?? '',
        node.getAttribute('stroke') ?? '',
      ]),
    ),
  ]
    .filter((paint) => paint !== '')
    .sort()

async function printedPaints(): Promise<string[]> {
  await emulatePrint(true)
  await expect
    .poll(() => document.querySelectorAll('[data-testid="note-print-band"] text').length)
    .toBeGreaterThan(0)
  const view = screen.getByTestId('note-print-view')
  return paints(view)
}

const drawnEmbed = () => drawn()?.textContent?.includes('Cloud') === true

describe('a note printed while the app is dark', () => {
  it('prints its embedded board in the light palette', async () => {
    const light = render(<ThemedNote theme="light" />)
    await expect.poll(drawnEmbed).toBe(true)
    const lightPrint = await printedPaints()
    await emulatePrint(false)
    light.unmount()

    render(<ThemedNote theme="dark" />)
    await expect.poll(drawnEmbed).toBe(true)
    const darkScreen = paints(drawn())
    // The palettes differ on screen, or the comparison below proves nothing.
    expect(darkScreen).not.toEqual(lightPrint)

    expect(await printedPaints()).toEqual(lightPrint)
    await emulatePrint(false)
    await expect.poll(() => screen.queryByTestId('note-print-view')).toBeNull()
    await expect.poll(() => paints(drawn())).toEqual(darkScreen)
  })
})

describe('a heading before an embed, and a block taller than a page', () => {
  it('keeps a heading on the strip of the embed it introduces', async () => {
    render(<EmbedNote value={'## The cycle\n\n![[board]]\n\n## After\n\nRain falls.'} />)
    await expect.poll(drawnEmbed).toBe(true)
    await emulatePrint(true)
    await expect
      .poll(() => document.querySelectorAll('[data-testid="note-print-band"]').length)
      .toBe(2)
  })

  // Paging itself is not observable here (emulated print media lays out one
  // long page). What Chromium does with a strip taller than a page was
  // measured with the headless shell's --print-to-pdf: it slices it across
  // pages, every line kept, starting on a fresh page. So the strip only has
  // to arrive whole and uncapped for that to hold.
  it('draws a code block taller than a page whole, on one uncapped strip', async () => {
    const code = Array.from({ length: 160 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<EmbedNote value={`## Long\n\n\`\`\`\n${code}\n\`\`\`\n\nEnd.`} />)
    await expect.poll(() => drawn()?.textContent?.includes('line 160') === true).toBe(true)
    await emulatePrint(true)
    await expect
      .poll(() => document.querySelectorAll('[data-testid="note-print-band"]').length)
      .toBe(2)
    const [tall] = document.querySelectorAll<SVGSVGElement>('[data-testid="note-print-band"]')
    const box = tall?.viewBox.baseVal
    const rendered = tall?.getBoundingClientRect()
    // Over 160 lines of code: three pages' worth on any paper.
    expect(box?.height ?? 0).toBeGreaterThan(2400)
    // Drawn at its own aspect, so nothing caps it to a page and clips the rest.
    expect((rendered?.height ?? 0) / (rendered?.width ?? 1)).toBeCloseTo(
      (box?.height ?? 0) / (box?.width ?? 1),
      1,
    )
  })
})

const ARROW_BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'cloud', x: 0, y: 0, width: 160, height: 60, text: 'Cloud' }),
    textNode({ id: 'rain', x: 0, y: 200, width: 160, height: 60, text: 'Rain' }),
  ],
  edges: [{ id: 'falls', from: { node: 'cloud' }, to: { node: 'rain' } }],
}

describe('an embedded board with arrows, printed', () => {
  it('draws each strip with arrowheads defined inside that strip', async () => {
    render(
      <EmbedNote canvas={ARROW_BOARD} value={'## The cycle\n\n![[board]]\n\n## After\n\nOk.'} />,
    )
    await expect.poll(drawnEmbed).toBe(true)
    await emulatePrint(true)
    await expect
      .poll(() => document.querySelectorAll('[data-testid="note-print-band"]').length)
      .toBe(2)
    const refs: { band: Element; id: string }[] = []
    for (const band of document.querySelectorAll('[data-testid="note-print-band"]')) {
      for (const path of band.querySelectorAll('[marker-end]')) {
        const id = /^url\(#(.+)\)$/.exec(path.getAttribute('marker-end') ?? '')?.[1]
        if (id !== undefined) refs.push({ band, id })
      }
    }
    // The arrow is present, or the check below asserts nothing.
    expect(refs.length).toBeGreaterThan(0)
    for (const { band, id } of refs) {
      // `url(#id)` resolves to the FIRST element with that id in the page;
      // the on-screen preview is hidden while printing, so a marker there
      // draws no arrowhead on paper.
      const marker = document.getElementById(id)
      expect(marker !== null && band.contains(marker)).toBe(true)
      expect(getComputedStyle(band).display).not.toBe('none')
    }
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
