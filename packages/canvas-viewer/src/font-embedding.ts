// Vite's `?url` asset suffix, resolved at build/dev-server time.
import robotoFontUrl from '../assets/fonts/Roboto/Roboto-Regular.ttf?url'
import { VIEWER_FONT_FAMILY } from './font.js'

/**
 * The vendored face as a `data:` URI, or null if it cannot be read.
 *
 * Exists because of a gap between two things that both look like "the browser
 * has the font": `ensureViewerFontLoaded` registers a `FontFace` on the
 * document, which governs the LIVE canvas — and does not reach an SVG rendered
 * inside an `<img>`, which is how a PNG export is rasterised. Measured
 * directly: a face with `status: 'loaded'` on the page renders there
 * byte-identically to a family name nobody has registered at all.
 *
 * A `data:` URI is not a resource load, so it survives that boundary. Same
 * measurement, embedding the same bytes: the drawn text went from 714x46 to
 * 722x41 — a different face, which is the point.
 *
 * Memoised at module scope: the bytes are ~349 KB and base64 of them ~466 KB,
 * and an export must not pay for that twice.
 */
let dataUriPromise: Promise<string | null> | undefined

export function viewerFontDataUri(): Promise<string | null> {
  dataUriPromise ??= readFontAsDataUri()
  return dataUriPromise
}

async function readFontAsDataUri(): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await (await fetch(robotoFontUrl)).arrayBuffer())
    // Chunked because `String.fromCharCode(...bytes)` on a 349 KB array blows
    // the argument limit rather than being slow.
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return `data:font/ttf;base64,${btoa(binary)}`
  } catch {
    return null
  }
}

/** Test seam: the memo would otherwise carry one test's stubbed fetch into the next. */
export function _resetViewerFontEmbeddingForTests(): void {
  dataUriPromise = undefined
}

/**
 * The same SVG, with the viewer's face embedded so a rasteriser that cannot
 * see the document's fonts still draws the text the editor showed.
 *
 * Returns the input unchanged when the face cannot be read: an export that
 * falls back to a system font is worse than one that matches, and better than
 * no export at all.
 *
 * Meant for the PNG path only. A saved `.svg` keeps naming the family without
 * carrying it — the file would grow by ~466 KB to embed a face that any viewer
 * with Roboto already has, and one without it is exactly the reader who wants
 * a small file.
 */
export async function withViewerFontEmbedded(svg: string): Promise<string> {
  const dataUri = await viewerFontDataUri()
  if (dataUri === null) return svg

  // After the opening tag, so the rule is in scope for every element below it.
  //
  // The naive scan for the first `>` is sound because canvas-render is the
  // sole producer and its root element carries only `xmlns`, numeric
  // `width`/`height`, a formatted `viewBox` and a theme colour — none of which
  // can contain one. XML does permit a raw `>` inside a quoted attribute
  // value, so a root attribute that ever carries document content would need a
  // real scan rather than this.
  const openTagEnd = svg.indexOf('>')
  if (openTagEnd === -1) return svg
  const style = `<defs><style>@font-face{font-family:'${VIEWER_FONT_FAMILY}';src:url('${dataUri}') format('truetype');}</style></defs>`
  return svg.slice(0, openTagEnd + 1) + style + svg.slice(openTagEnd + 1)
}
