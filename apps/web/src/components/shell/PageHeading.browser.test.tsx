import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import '../../index.css'
import { PageHeading } from './PageHeading.js'

beforeAll(async () => {
  await vi.waitFor(() => {
    const probe = document.createElement('div')
    probe.className = 'w-full'
    document.body.append(probe)
    const applied = getComputedStyle(probe).width !== 'auto'
    probe.remove()
    if (!applied) throw new Error('index.css not applied yet')
  })
})

afterEach(cleanup)

it('draws no focus ring on the heading a route change focuses', () => {
  render(<PageHeading>default</PageHeading>)
  const heading = screen.getByRole('heading', { level: 1 })
  heading.focus()
  expect(document.activeElement).toBe(heading)
  expect(getComputedStyle(heading).outlineStyle).toBe('none')
})
