/**
 * Makes a rendered document's SVG size itself from the box it is put in.
 *
 * `renderSceneToSvg` writes the document's OWN extent into `width`/`height`,
 * which is right for an export and wrong for a thumbnail: a 2000px-wide
 * canvas dropped into a 24px row would draw 2000px wide and push the row off
 * the screen. Stripping the two attributes leaves the `viewBox`, so the
 * element takes the size CSS gives it and scales its contents to match.
 *
 * `preserveAspectRatio` is written explicitly even though `xMidYMid meet` is
 * the SVG default: it is the whole contract of a thumbnail (fit inside,
 * never crop, never stretch) and a default is not a statement.
 *
 * `cover-start` is the one exception: a picture far wider than it is tall
 * (a one-line note) fitted inside a box shrinks to an unreadable strip, so it
 * fills the box from its top-left corner instead, and the cut-off end is the
 * cost of the first words being legible.
 *
 * `ink` crops the picture to what is drawn, measured from the viewBox's own
 * origin. A note is laid out at a column's width, so its viewBox spans the
 * column whatever the text holds, and fitted whole a short note is a few
 * words in the corner of a mostly empty picture. It only ever narrows.
 */

const SVG_OPEN = /^(\s*)<svg\b([^>]*)>/
const VIEW_BOX = /\bviewBox="([^"]*)"/

function cropTo(
  attribute: string,
  value: string,
  ink: { readonly w: number; readonly h: number },
): string {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const [x, y, w, h] = parts
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return attribute
  if (!(ink.w > 0 && ink.h > 0)) return attribute
  return `viewBox="${x} ${y} ${Math.min(w as number, ink.w)} ${Math.min(h as number, ink.h)}"`
}

/** Only the root tag's own attributes — a nested `<svg>` fragment keeps its size. */
export function fitSvgToBox(
  svg: string,
  fit: 'contain' | 'cover-start' = 'contain',
  ink?: { readonly w: number; readonly h: number },
): string {
  const aspect = fit === 'cover-start' ? 'xMinYMin slice' : 'xMidYMid meet'
  return svg.replace(SVG_OPEN, (whole, lead: string, attrs: string) => {
    if (!/\bviewBox=/.test(attrs)) return whole
    const cropped =
      ink === undefined
        ? attrs
        : attrs.replace(VIEW_BOX, (box, value: string) => cropTo(box, value, ink))
    const stripped = cropped
      .replace(/\s+width="[^"]*"/g, '')
      .replace(/\s+height="[^"]*"/g, '')
      .replace(/\s+preserveAspectRatio="[^"]*"/g, '')
    return `${lead}<svg${stripped} preserveAspectRatio="${aspect}">`
  })
}
