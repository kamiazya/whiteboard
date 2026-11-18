import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'

/**
 * A hand-written keyed render, in the shape the core answers for `form:
 * 'keyed'`: one `<g data-wb-key>` group per entry, the root's open tag and
 * attributes beside them, and `#defs` / `#background` pseudo-groups ahead of
 * the entries when the document has them. For the tests whose subject is the
 * patcher that CONSUMES a keyed render (what it keeps, replaces, animates),
 * where the bytes inside a group are only something to compare.
 */
export interface FixtureEntry {
  readonly key: string
  readonly x: number
  readonly y?: number
  readonly fill?: string
  /** The group draws the annotation layer, as the core marks a comment's pin. */
  readonly annotation?: true
  /** Text drawn inside the group, after its rectangle. */
  readonly text?: string
}

export interface FixtureRoot {
  readonly padding?: number
  readonly background?: string
  /** The document carries a `<defs>` group. */
  readonly defs?: boolean
  /** The root's view box; by default the entries' extent grown by the padding. */
  readonly viewBox?: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

const BOX_W = 100
const BOX_H = 60

const groupOf = ({ key, x, y = 0, fill = '#fff', text }: FixtureEntry): string =>
  `<g data-wb-key="${key}"><rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" fill="${fill}" stroke="#333"/>${
    text === undefined ? '' : `<text x="${x}" y="${y + 8}">${text}</text>`
  }</g>`

export function keyedFixture(
  entries: readonly FixtureEntry[],
  root: FixtureRoot = {},
): KeyedSvgRender {
  const padding = root.padding ?? 0
  const right = Math.max(0, ...entries.map((entry) => entry.x + BOX_W))
  const bottom = Math.max(0, ...entries.map((entry) => (entry.y ?? 0) + BOX_H))
  const box = root.viewBox ?? { x: 0, y: 0, w: right, h: bottom }
  const w = box.w + 2 * padding
  const h = box.h + 2 * padding
  const rootAttrs = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: String(w),
    height: String(h),
    viewBox: `${box.x - padding} ${box.y - padding} ${w} ${h}`,
  }
  const rootOpen = `<svg ${Object.entries(rootAttrs)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ')}>`
  const groups = [
    ...(root.defs === true
      ? [
          {
            key: '#defs',
            svg: '<defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs>',
          },
        ]
      : []),
    ...(root.background === undefined
      ? []
      : [
          {
            key: '#background',
            svg: `<rect width="100%" height="100%" fill="${root.background}"/>`,
          },
        ]),
    ...entries.map((entry) => ({
      key: entry.key,
      svg: groupOf(entry),
      ...(entry.annotation === true ? { annotation: true as const } : {}),
    })),
  ]
  return {
    svg: `${rootOpen}${groups.map((group) => group.svg).join('')}</svg>`,
    rootOpen,
    rootAttrs,
    groups,
  }
}
