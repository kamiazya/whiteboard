import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentPageSkeleton } from './DocumentPageSkeleton.js'

afterEach(cleanup)

describe('DocumentPageSkeleton', () => {
  it('announces itself with the given label', () => {
    const { getByRole } = render(<DocumentPageSkeleton label="Loading canvas" />)
    expect(getByRole('status').getAttribute('aria-label')).toBe('Loading canvas')
  })

  // The skeleton must not flash: it stays invisible for a beat and only
  // fades in when the wait turns out to be real (skeleton-appear in
  // index.css). A skeleton that pops for one frame between a resolved
  // chunk and first paint reads as a glitch, not as progress.
  it('appears through the delayed skeleton-appear animation', () => {
    const { getByRole } = render(<DocumentPageSkeleton label="Loading canvas" />)
    expect(getByRole('status').className).toContain('skeleton-appear')
  })
})
