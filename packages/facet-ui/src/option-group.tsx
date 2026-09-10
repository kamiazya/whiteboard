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
 */
import type { CSSProperties, ReactNode } from 'react'
import { useId } from 'react'

const INK = 'var(--foreground, #171717)'
const MUTED = 'var(--muted-foreground, #737373)'
const ACCENT = 'var(--accent, #f2f2f2)'
const RING = 'var(--ring, #3b82f6)'

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

const GLYPH: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1rem',
  height: '1rem',
  flex: 'none',
}

export interface FacetOptionProps {
  /** Groups the radios; every option in one group shares it. */
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
}

export function FacetOption({ name, label, selected, onSelect, glyph }: FacetOptionProps) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      // The label carries the focus ring because the input it labels is
      // clipped to a pixel — without this a keyboard user arrowing through
      // the group sees nothing move.
      style={selected ? OPTION_SELECTED : OPTION}
      title={glyph === undefined ? undefined : label}
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
      {glyph === undefined ? (
        label
      ) : (
        <span aria-hidden="true" style={GLYPH}>
          {glyph}
        </span>
      )}
    </label>
  )
}

export interface FacetOptionGroupProps {
  /** What the whole group is called, for a reader with no label in view. */
  readonly label: string
  readonly children: ReactNode
}

export function FacetOptionGroup({ label, children }: FacetOptionGroupProps) {
  return (
    <span role="radiogroup" aria-label={label} style={GROUP}>
      {children}
    </span>
  )
}
