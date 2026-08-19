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
 */

const SVG_OPEN = /^(\s*)<svg\b([^>]*)>/

/** Only the root tag's own attributes — a nested `<svg>` fragment keeps its size. */
export function fitSvgToBox(svg: string): string {
  return svg.replace(SVG_OPEN, (whole, lead: string, attrs: string) => {
    if (!/\bviewBox=/.test(attrs)) return whole
    const stripped = attrs
      .replace(/\s+width="[^"]*"/g, '')
      .replace(/\s+height="[^"]*"/g, '')
      .replace(/\s+preserveAspectRatio="[^"]*"/g, '')
    return `${lead}<svg${stripped} preserveAspectRatio="xMidYMid meet">`
  })
}
