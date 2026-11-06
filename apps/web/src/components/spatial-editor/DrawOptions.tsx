/**
 * The Draw tool's options: the colour and the weight the next stroke is laid
 * down with. Shown only while the tool is armed, just above the dock, the way
 * a pen's settings sit beside the pen.
 *
 * The colour row is the line menu's own (`colorRow`), so the swatches are the
 * same presets, in the same order and under the same names, drawn in the
 * palette the BOARD is painted in — a themed board previews the ink a pick
 * produces. The options are real radios (`facet-ui`'s option group), so a
 * keyboard reaches each group with Tab and moves within it with the arrows.
 */
import {
  createSpatialTheme,
  type SpatialPalette,
  type SpatialThemeMode,
} from '@kamiazya/whiteboard-canvas-render'
import { FacetOption, FacetOptionGroup } from '@kamiazya/whiteboard-facet-ui'
import { STROKE_WIDTHS, type StrokeWidth } from '@kamiazya/whiteboard-plugin-visual'
import { useId } from 'react'
import type { PenStyle } from '../../lib/spatial/pen-style.js'
import { colorRow } from './context-menu-items/color-row.js'
import { useBottomChromeClearance } from './use-bottom-chrome-clearance.js'
import { useStackWhenCramped } from './use-stack-when-cramped.js'

/** What each weight is called, to a reader and in the picker's tooltip. */
export const STROKE_WIDTH_NAMES: Readonly<Record<StrokeWidth, string>> = {
  thin: 'Thin',
  medium: 'Medium',
  thick: 'Thick',
}

/**
 * The bar each weight's option draws: its relative weight, not its pixels.
 * Each at least twice, and 2px, heavier than the last — 1.5px against 3px
 * doubled and still read on a phone as the same grey dash.
 */
const BAR_HEIGHT_PX: Readonly<Record<StrokeWidth, number>> = { thin: 2, medium: 4, thick: 8 }

/** A weight drawn as a short bar of that weight, for a picker that has no room for words. */
export function StrokeWidthGlyph({ width }: { readonly width: StrokeWidth }) {
  return (
    <span
      style={{
        display: 'block',
        width: 16,
        height: BAR_HEIGHT_PX[width],
        borderRadius: BAR_HEIGHT_PX[width],
        backgroundColor: 'currentColor',
      }}
    />
  )
}

function WidthOptions({
  group,
  pen,
  onChange,
}: {
  readonly group: string
  readonly pen: PenStyle
  readonly onChange: (pen: PenStyle) => void
}) {
  return (
    <FacetOptionGroup label="Width">
      {STROKE_WIDTHS.map((width) => (
        <FacetOption
          key={width}
          name={`${group}-width`}
          label={STROKE_WIDTH_NAMES[width]}
          selected={pen.width === width}
          onSelect={() => onChange({ ...pen, width })}
          glyph={<StrokeWidthGlyph width={width} />}
        />
      ))}
    </FacetOptionGroup>
  )
}

function ColorOptions({
  group,
  pen,
  palette,
  onChange,
}: {
  readonly group: string
  readonly pen: PenStyle
  readonly palette: SpatialPalette
  readonly onChange: (pen: PenStyle) => void
}) {
  const color = colorRow(palette, pen.color, (next) => {
    const { color: _previous, ...rest } = pen
    onChange(next === undefined ? rest : { ...rest, color: next })
  })
  return (
    <FacetOptionGroup label={color.label}>
      {color.options.map((option) => (
        <FacetOption
          key={option.label}
          name={`${group}-color`}
          label={option.ariaLabel ?? option.label}
          selected={option.selected}
          onSelect={option.onSelect}
          {...(option.label === 'default'
            ? { glyph: <DefaultInkDot palette={palette} /> }
            : option.icon === undefined
              ? {}
              : { glyph: option.icon })}
        />
      ))}
    </FacetOptionGroup>
  )
}

/** Whether the strip would have to scroll to hold both groups on one row. */
function stripCramped(strip: HTMLElement): boolean {
  return strip.scrollWidth > strip.clientWidth + 0.5
}

/**
 * The Default swatch, as the ink it gives: a dot of the board's own edge
 * stroke. A dashed "no colour" square read as no ink at all.
 */
function DefaultInkDot({ palette }: { readonly palette: SpatialPalette }) {
  return (
    <span
      style={{
        display: 'block',
        width: 14,
        height: 14,
        borderRadius: '50%',
        backgroundColor: palette.edgeStroke,
      }}
    />
  )
}

export function DrawOptions({
  pen,
  palette,
  onChange,
}: {
  readonly pen: PenStyle
  /** The palette the board is drawn in, so a swatch shows the ink a pick produces. */
  readonly palette: SpatialPalette
  readonly onChange: (pen: PenStyle) => void
}) {
  // Radio names are page-wide, and two editors can share a page.
  const group = useId()
  // Stands above the dock as measured: a phone's dock folds onto two rows.
  const [strip, lift] = useBottomChromeClearance<HTMLFieldSetElement>(
    true,
    '[data-testid="tool-palette"]',
  )
  const stacked = useStackWhenCramped(strip, stripCramped)
  return (
    <fieldset
      ref={strip}
      style={{ bottom: lift }}
      data-editor-overlay
      data-testid="draw-options"
      aria-label="Draw options"
      data-stacked={stacked ? '' : undefined}
      // Above the dock, as measured. `w-max`, because a box centred from
      // `left: 50%` otherwise shrinks to the half of the editor right of that
      // line and wraps with the other half empty. One row while it fits;
      // otherwise each group takes a whole row of its own, colours above
      // widths — never a free wrap, which split the colours 5+2 and the
      // widths 2+1 and stranded the divider. The groups' own wrap is held
      // off for that reason. Scrolling stays only as the last resort for an
      // editor too narrow even for the colours' row. Every option is the
      // touch floor on a coarse pointer, the same 44px the dock's own
      // buttons step up to.
      className="m-0 min-w-0 absolute bottom-[calc(3.75rem+env(safe-area-inset-bottom))] left-1/2 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-nowrap items-center overflow-x-auto gap-x-3 gap-y-1 rounded-lg border bg-background px-2 py-1 shadow-md data-stacked:flex-col data-stacked:items-start data-stacked:px-1 pointer-coarse:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] [&_[role=radiogroup]]:flex-nowrap! [&_[role=radiogroup]]:justify-start! pointer-coarse:[&_label]:min-h-11! pointer-coarse:[&_label]:min-w-11!"
    >
      <ColorOptions group={group} pen={pen} palette={palette} onChange={onChange} />
      <div aria-hidden="true" className="h-5 w-px bg-border in-data-stacked:hidden" />
      <WidthOptions group={group} pen={pen} onChange={onChange} />
    </fieldset>
  )
}

/**
 * The ink the pen's draft is drawn in: the colour the stroke will be painted
 * once it lands, resolved through the board's own palette — a draft in any
 * other colour would flicker at the release on a themed board.
 */
export function penInk(pen: PenStyle, palette: SpatialPalette, mode: SpatialThemeMode): string {
  const edge = { id: 'pen', from: { node: 'pen' }, to: { node: 'pen' } }
  const resolved = createSpatialTheme({ mode, palette }).resolveEdge(
    pen.color === undefined ? edge : { ...edge, color: pen.color },
  )
  return resolved?.stroke ?? palette.edgeStroke
}
