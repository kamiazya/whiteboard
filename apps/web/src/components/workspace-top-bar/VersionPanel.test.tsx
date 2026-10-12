// @vitest-environment jsdom

/**
 * The history panel tells the timeline which kind of document it lists, so
 * a note's rows carry no element count: a note has no elements, and "0 els"
 * on every row reads as an empty document.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const timelineProps = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('../../components/VersionTimeline.js', () => ({
  default: (props: Record<string, unknown>) => {
    timelineProps.push(props)
    return null
  },
}))

const { VersionPanel } = await import('./VersionPanel.js')

afterEach(() => {
  cleanup()
  timelineProps.length = 0
})

describe('VersionPanel', () => {
  it.each(['markdown', 'spatial'] as const)('hands the %s kind to the timeline', (kind) => {
    render(<VersionPanel workspaceId="ws" path="notes/a" documentKind={kind} onClose={() => {}} />)
    expect(timelineProps.at(-1)?.documentKind).toBe(kind)
  })
})
