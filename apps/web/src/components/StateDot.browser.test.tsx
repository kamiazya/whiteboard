/**
 * The dot's colour CROSSES rather than cuts, in the real stylesheet.
 *
 * A save cycle flips this dot every 500ms while someone types (the write
 * debounce), and at an instant swap that reads as flicker beside a title
 * the user is looking at — reported as the header being restless. The
 * transition is the fix, and it also softens the case an instant swap makes
 * worst: a write that completes in under the transition's own duration
 * never reaches full amber at all, so a fast save shimmers instead of
 * flashing.
 *
 * Asserted against COMPUTED style rather than a class string: the class is
 * what was written, the computed duration is what the browser will actually
 * do, and only the second one is what the reporter saw.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { StateDot, type StateDotShape } from './StateDot'

afterEach(cleanup)

function dotStyle(shape?: StateDotShape) {
  render(<StateDot tone="safe" shape={shape} />)
  return getComputedStyle(screen.getByTestId('state-dot'))
}

/**
 * The effective transition duration for one property, in milliseconds.
 *
 * Reads `transition-property` rather than trusting a class name, because
 * the base stylesheet already computes to `all` with a duration of `0s` —
 * a property list that LOOKS like it covers everything and transitions
 * nothing. Duration is what decides the behaviour, so duration is what this
 * returns.
 */
function crossFadeMs(style: CSSStyleDeclaration, property: string): number {
  const props = style.transitionProperty.split(',').map((p) => p.trim())
  const durations = style.transitionDuration.split(',').map((d) => d.trim())
  const index = props.includes('all') ? 0 : props.indexOf(property)
  if (index === -1) return 0
  const raw = durations[Math.min(index, durations.length - 1)] ?? '0s'
  return raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000
}

it('crosses between tones instead of cutting, on the filled dot', () => {
  expect(crossFadeMs(dotStyle(), 'background-color')).toBeGreaterThan(0)
})

it('crosses on the ring too, where the tone lives in the border', () => {
  // The ring and the spinner say the same thing in stroke rather than fill,
  // so a transition covering only `background-color` would leave two of the
  // three shapes cutting — the per-carrier drift this component exists to
  // prevent, one level down.
  expect(crossFadeMs(dotStyle('ring'), 'border-color')).toBeGreaterThan(0)
})
