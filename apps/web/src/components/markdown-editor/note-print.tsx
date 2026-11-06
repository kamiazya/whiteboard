import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { type PrintBlock, printBands } from '../../lib/print-bands.js'
import { editorTextFill } from '../../lib/spatial/editor-appearance.js'
import type { MarkdownViewMode } from './EditorToolbar.js'
import { opensWithTitle } from './read-title.js'

/**
 * Printing a note — the browser's own Print, or the document menu's
 * "Print / Save as PDF…" — hands out its read view: the title and the drawn
 * body, over as many pages as it takes. Everything else on the page is the
 * app and does not print (`[data-print-content]` in index.css).
 *
 * The body is ONE SVG, and a page break through it slices whatever lies on
 * the line, so for the length of a print it is drawn again as one strip per
 * block (`printBands`), each kept whole on its page. The strips exist only
 * while print media applies: on screen they would double the body's DOM.
 */

const PRINT_REQUEST_EVENT = 'whiteboard:print-note'

/** Asks the open note's editor to print its read view. */
export function requestNotePrint(): void {
  window.dispatchEvent(new Event(PRINT_REQUEST_EVENT))
}

/**
 * Answers a print request: switches the editor to Read, lets that render,
 * prints, and puts the view the reader had back. `window.print()` returns
 * once the dialog closes, so the restore waits for the reader.
 */
export function useNotePrintRequest(
  mode: MarkdownViewMode,
  setMode: (next: MarkdownViewMode) => void,
): void {
  const modeRef = useRef(mode)
  modeRef.current = mode
  useEffect(() => {
    const onRequest = () => {
      const before = modeRef.current
      flushSync(() => setMode('read'))
      // Two frames: one for the read layout to commit, one for it to paint.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.print()
          if (before !== 'read') setMode(before)
        }),
      )
    }
    window.addEventListener(PRINT_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(PRINT_REQUEST_EVENT, onRequest)
  }, [setMode])
}

/**
 * Whether print media applies now, following both the dialog and an emulated
 * medium. The preview column asks too: a handout is drawn in the light
 * palette whatever the screen's theme, so the body is re-rendered light for
 * the length of the print and the strips are cut from that.
 */
export function usePrinting(): boolean {
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    // A realm with no media queries (jsdom) still has the print events.
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null
    // `beforeprint` comes before the print layout is taken, so the strips are
    // committed synchronously there; the media query covers a medium that
    // changes with no dialog (an emulated one, a PDF renderer).
    const on = () => flushSync(() => setPrinting(true))
    const off = () => setPrinting(false)
    const follow = () => (media?.matches ? on() : off())
    window.addEventListener('beforeprint', on)
    window.addEventListener('afterprint', off)
    media?.addEventListener('change', follow)
    return () => {
      window.removeEventListener('beforeprint', on)
      window.removeEventListener('afterprint', off)
      media?.removeEventListener('change', follow)
    }
  }, [])
  return printing
}

/**
 * Gives every id inside `copy` a per-copy suffix and points the copy's own
 * `url(#…)` and `href="#…"` references at the renamed ids. A reference
 * resolves to the FIRST element in the page with that id, which for an
 * unrenamed copy is the on-screen preview's — hidden while printing, so a
 * marker, mask or filter defined there draws nothing on paper. An `href` to
 * an id the copy does not define (a document link) is left alone.
 */
function renameIds(copy: SVGSVGElement, suffix: string): void {
  const renamed = new Map<string, string>()
  for (const el of copy.querySelectorAll('[id]')) {
    const next = `${el.id}-${suffix}`
    renamed.set(el.id, next)
    el.id = next
  }
  if (renamed.size === 0) return
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (attr.name === 'id') continue
      const value = renamedReference(attr, renamed)
      if (value !== attr.value) el.setAttributeNS(attr.namespaceURI, attr.name, value)
    }
  }
}

const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g

/** `attr`'s value with its references to ids in `renamed` pointed at the new ids. */
function renamedReference(attr: Attr, renamed: ReadonlyMap<string, string>): string {
  if (attr.localName === 'href' && attr.value.startsWith('#')) {
    const local = renamed.get(attr.value.slice(1))
    return local === undefined ? attr.value : `#${local}`
  }
  return attr.value.replace(URL_REFERENCE, (whole, quote: string, id: string) => {
    const next = renamed.get(id)
    return next === undefined ? whole : `url(${quote}#${next}${quote})`
  })
}

/** Copies of the drawn body, one per band, each showing only its band. */
function bandCopies(svg: SVGSVGElement, blocks: readonly PrintBlock[]): SVGSVGElement[] {
  const box = svg.viewBox.baseVal
  const width = box.width > 0 ? box.width : svg.getBoundingClientRect().width
  const height = box.height > 0 ? box.height : svg.getBoundingClientRect().height
  return printBands(blocks, height).map((band, index) => {
    const copy = svg.cloneNode(true) as SVGSVGElement
    renameIds(copy, `print-${index}`)
    copy.setAttribute('viewBox', `${box.x} ${box.y + band.top} ${width} ${band.bottom - band.top}`)
    copy.setAttribute('width', String(width))
    copy.setAttribute('height', String(band.bottom - band.top))
    copy.removeAttribute('style')
    copy.setAttribute('data-testid', 'note-print-band')
    copy.setAttribute('aria-hidden', 'true')
    return copy
  })
}

/**
 * The note as it prints. Rendered AFTER the preview, inside the same
 * `[data-print-content]` column, and empty until print media applies;
 * `blocksRef` holds the drawn body's top-level blocks in the SVG's pixel
 * space. After, because layout effects run in tree order: the preview's
 * re-render in the light palette has to be patched in before the strips are
 * copied from it. The title is left out when `body` already opens with it.
 */
export function NotePrintView({
  printing,
  title,
  body,
  blocksRef,
}: {
  printing: boolean
  title: string | undefined
  body: string
  blocksRef: RefObject<readonly PrintBlock[]> | undefined
}) {
  const bandsRef = useRef<HTMLDivElement | null>(null)
  // A layout effect, so the strips are in place inside the same synchronous
  // commit `beforeprint` forces — before the browser takes the print layout.
  useLayoutEffect(() => {
    const target = bandsRef.current
    if (!printing || target === null) return
    const svg = target
      .closest('[data-print-content]')
      ?.querySelector<SVGSVGElement>('[data-testid="markdown-preview-pane"] svg')
    if (svg === null || svg === undefined) return
    target.replaceChildren(...bandCopies(svg, blocksRef?.current ?? []))
    return () => target.replaceChildren()
  }, [printing, blocksRef])
  if (!printing) return null
  const printTitle = opensWithTitle(body, title) ? undefined : title
  return (
    <div
      data-testid="note-print-view"
      className="note-print-view"
      style={{ fill: editorTextFill('light') }}
    >
      {printTitle !== undefined && printTitle !== '' && <h1>{printTitle}</h1>}
      <div ref={bandsRef} />
    </div>
  )
}
