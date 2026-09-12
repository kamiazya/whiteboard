/**
 * The ONE way this codebase draws "pick one of N".
 *
 * Before it there were six, four of them in a single settings panel: an
 * `aria-pressed` button row, a `menuitemradio` row, a radiogroup with its
 * radios hidden behind an accent fill, a radiogroup with the radios VISIBLE
 * beside a word, a bordered glyph pill, and a `<select>`. Every one of them
 * was somebody drawing the same control again in a file that could not see
 * the last one. Measured in the display panel alone: 9 `aria-pressed`
 * buttons, 3 visible radios, 12 hidden radios, and `role="radiogroup"` on
 * only two of the five rows.
 *
 * So the look lives in ONE component, and every surface composes it —
 * including a plugin's own, which is the half that makes this a contract
 * rather than a convention. A plugin still chooses what its options ARE and
 * what order they come in; it does not choose what a selected option looks
 * like, any more than `createFacetWriter` lets it choose what a valid
 * payload is. That is the same bargain, applied to drawing.
 *
 * Real radios, hidden but focusable: the roving focus and arrow-key
 * behaviour a segmented control needs comes free with the element, and the
 * `aria-pressed` button rows never had it. Styling is inline values and the
 * host's own custom properties — a class name inside a workspace package is
 * never generated (this package's rule, and it fails silently).
 *
 * One LOOK, two ARIA shells. Inside a MENU a radio input is the wrong
 * element and would break the menu's own keyboard model, so a menu vessel
 * gets `role="menuitemradio"` on a button instead — which is the correct
 * role there, not a second idiom. What must not differ between the two is
 * what a selected option looks like, and that is exactly what this module
 * holds. `shell` is the caller saying which container it is in; it is not
 * a style choice, and there is no third value.
 */
import type { CSSProperties, ReactNode } from 'react'
import { useId } from 'react'

const INK = 'var(--foreground, #171717)'
const MUTED = 'var(--muted-foreground, #737373)'
const ACCENT = 'var(--accent, #f2f2f2)'
const RING = 'var(--ring, #3b82f6)'
const LINE = 'var(--border, #e5e5e5)'
const PRIMARY = 'var(--primary, #171717)'

/**
 * Wraps for the reason every options row in the app wraps: a row that
 * cannot fit puts its last options past the edge, where they are not
 * merely ugly but untappable.
 */
const GROUP: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.125rem',
}

/** 28px, matching the app's own compact control height. */
const OPTION: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  height: '1.75rem',
  minWidth: '1.75rem',
  padding: '0 0.5rem',
  borderRadius: '0.25rem',
  fontSize: '0.75rem',
  lineHeight: 1,
  cursor: 'pointer',
  // No border. The SELECTED state is a fill, so a resting border would be
  // a second boundary competing with it — which is exactly how the two
  // radiogroup spellings came to look like different controls.
  border: '1px solid transparent',
  background: 'transparent',
  color: MUTED,
  whiteSpace: 'nowrap',
}

const OPTION_SELECTED: CSSProperties = {
  ...OPTION,
  background: ACCENT,
  color: INK,
  fontWeight: 500,
}

const GLYPH_BOX: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
}

const GLYPH: CSSProperties = { ...GLYPH_BOX, width: '1rem', height: '1rem' }

/**
 * The CARD grid: cells that size themselves, so two options give two columns
 * and three give three without any caller counting them. `auto-fit` with a
 * floor is what keeps a phone honest — past the floor the row wraps rather
 * than shrinking cells below a thumb.
 */
const CARD_GROUP: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(4.5rem, 1fr))',
  gap: '0.5rem',
  width: '100%',
}

const CARD: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.5rem 0.5rem 0.4375rem',
  borderRadius: '0.375rem',
  border: `1px solid ${LINE}`,
  background: 'transparent',
  color: MUTED,
  fontSize: '0.75rem',
  lineHeight: 1.1,
  textAlign: 'center',
  cursor: 'pointer',
}

const CARD_SELECTED: CSSProperties = {
  ...CARD,
  border: `1px solid ${PRIMARY}`,
  // The same faint wash Settings paints (`bg-primary/5`), reached without a
  // utility class. A fallback to the accent fill for a host whose primary
  // token is missing, so the selected cell is never merely a border.
  background: `color-mix(in srgb, ${PRIMARY} 6%, transparent)`,
  color: PRIMARY,
}

/** A card's picture has room to be a picture. */
const CARD_GLYPH: CSSProperties = { ...GLYPH_BOX, width: '1.25rem', height: '1.25rem' }

/**
 * The CATALOG grid: square glyph-only cells, packed as tightly as a thumb
 * allows, for a band holding hundreds rather than a handful.
 *
 * Not a `cards` grid with the words removed — a card is a cell whose NAME
 * carries meaning a picture cannot, and "grinning face" under a grinning
 * face is the opposite of that. Not a `chips` row either: a wrapping row
 * of 388 pills has no line a reader can scan down.
 *
 * `auto-fill` rather than `auto-fit`: a row of six symbols must stay a row
 * of six cells, and `auto-fit` collapses the empty tracks so four symbols
 * stretch into four fat ones.
 */
const GRID_GROUP: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(1.75rem, 1fr))',
  gap: '0.125rem',
  width: '100%',
}

const GRID_OPTION: CSSProperties = {
  ...OPTION,
  minWidth: 0,
  padding: 0,
  fontSize: '1rem',
}

const GRID_OPTION_SELECTED: CSSProperties = {
  ...GRID_OPTION,
  background: ACCENT,
  color: INK,
}

/** Bigger than a chip's, because in a grid the picture is all there is. */
const GRID_GLYPH: CSSProperties = { ...GLYPH_BOX, width: '1.125rem', height: '1.125rem' }

/** Visually hidden, still focusable — the focus ring is drawn by the label. */
const INPUT: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: 0,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

export interface FacetOptionProps {
  /** Groups the radios; every option in one group shares it. Unused in a menu. */
  readonly name: string
  /** The accessible name. Carried even where only a glyph is drawn. */
  readonly label: string
  readonly selected: boolean
  readonly onSelect: () => void
  /**
   * Drawn INSTEAD of the label when present — a glyph is both narrower and
   * faster to read than "Parallelogram", and the word stays the accessible
   * name, so nothing is lost for a screen reader.
   */
  readonly glyph?: ReactNode
  /**
   * Which container this option stands in — a panel (real radios) or a
   * menu (`menuitemradio`, so the menu's roving focus keeps working).
   * Defaults to `group`. Inline rather than a named export: it is the
   * caller saying where it is, not a type anyone builds against.
   */
  readonly shell?: 'group' | 'menu'
  /**
   * How the option is DRAWN, which the plugin declares per row.
   *
   * `chips` is a picture alone in an inline pill — for a palette where the
   * count makes labels impossible and the glyph is the whole affordance (a
   * silhouette, an emoji, a colour). `cards` is the picture over its word in
   * a bordered cell, the shape Settings already uses for theme and tab icon
   * — for a short vocabulary whose NAMES carry meaning a picture cannot
   * fully take on ("Orthogonal", "Neon").
   *
   * A count cannot decide this. `visual.shape`'s six silhouettes would fit
   * as cards and are still better as chips, because "Hexagon" tells a reader
   * nothing the hexagon has not already said.
   *
   * `grid` is neither, and only a searchable CATALOG asks for it: square
   * glyph-only cells, hundreds of them, scanned down rather than read
   * across. A plugin cannot declare it — `FacetOptionLayout` has two
   * values — because it is not a question about this row's vocabulary, it
   * is what a catalog IS.
   *
   * Ignored in a menu: a menu row is a row, and a grid of cells inside one
   * is not a menu any more.
   */
  readonly layout?: 'chips' | 'cards' | 'grid'
}

export function FacetOption({
  name,
  label,
  selected,
  onSelect,
  glyph,
  shell = 'group',
  layout = 'chips',
}: FacetOptionProps) {
  const id = useId()
  const card = layout === 'cards' && shell !== 'menu'
  const grid = layout === 'grid' && shell !== 'menu'
  const body =
    glyph === undefined ? (
      label
    ) : (
      <span aria-hidden="true" style={card ? CARD_GLYPH : grid ? GRID_GLYPH : GLYPH}>
        {glyph}
      </span>
    )
  const cellStyle = grid
    ? selected
      ? GRID_OPTION_SELECTED
      : GRID_OPTION
    : card
      ? selected
        ? CARD_SELECTED
        : CARD
      : selected
        ? OPTION_SELECTED
        : OPTION
  if (shell === 'menu') {
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        aria-label={label}
        title={glyph === undefined ? undefined : label}
        onClick={onSelect}
        style={selected ? OPTION_SELECTED : OPTION}
      >
        {body}
      </button>
    )
  }
  return (
    <label
      htmlFor={id}
      // The label carries the focus ring because the input it labels is
      // clipped to a pixel — without this a keyboard user arrowing through
      // the group sees nothing move.
      style={cellStyle}
      // A card prints its word, so a tooltip repeating it is noise.
      title={glyph === undefined || card ? undefined : label}
      onFocus={(event) => {
        event.currentTarget.style.outline = `2px solid ${RING}`
        event.currentTarget.style.outlineOffset = '1px'
      }}
      onBlur={(event) => {
        event.currentTarget.style.outline = 'none'
      }}
    >
      <input
        id={id}
        type="radio"
        name={name}
        aria-label={label}
        checked={selected}
        onChange={onSelect}
        style={INPUT}
      />
      {body}
      {card && <span>{label}</span>}
    </label>
  )
}

export interface FacetOptionGroupProps {
  /** What the whole group is called, for a reader with no label in view. */
  readonly label: string
  readonly children: ReactNode
  /**
   * A menu supplies its OWN grouping (a `fieldset`, or the menu itself), so
   * `menu` draws the row without a second role around it — nesting a
   * radiogroup inside a menu would announce a group the menu does not have.
   */
  readonly shell?: 'group' | 'menu'
  /** Must match what its options are given; see `FacetOptionProps.layout`. */
  readonly layout?: 'chips' | 'cards' | 'grid'
}

const GROUP_STYLE: Readonly<Record<'chips' | 'cards' | 'grid', CSSProperties>> = {
  chips: GROUP,
  cards: CARD_GROUP,
  grid: GRID_GROUP,
}

export function FacetOptionGroup({
  label,
  children,
  shell = 'group',
  layout = 'chips',
}: FacetOptionGroupProps) {
  if (shell === 'menu') {
    return <span style={GROUP}>{children}</span>
  }
  return (
    <span role="radiogroup" aria-label={label} style={GROUP_STYLE[layout]}>
      {children}
    </span>
  )
}
